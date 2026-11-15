/**
 * PHASE 12 — le thread qui parle réellement à PostgreSQL pour le plan d'identité.
 *
 * ## Pourquoi ce fichier existe
 *
 * Le plan d'identité d'Oathrion (users, organizations, memberships, sessions, api_keys,
 * identity_tokens) est consommé par une centaine d'appels **synchrones**, dont
 * plusieurs à l'intérieur de rappels synchrones. `pg` est asynchrone. Les deux
 * réponses possibles étaient :
 *
 *   1. rendre asynchrone toute la surface d'authentification (routes, middleware,
 *      bootstrap, tests) — une refonte, pas un portage ;
 *   2. rendre PostgreSQL appelable de façon synchrone depuis le thread principal.
 *
 * Ce fichier est la seconde. Il tourne dans un `worker_thread`, garde **une** connexion
 * PostgreSQL, et rend chaque résultat au thread principal par un `SharedArrayBuffer` :
 * le thread principal bloque sur `Atomics.wait` jusqu'à ce que ce worker écrive la
 * réponse. C'est le même mécanisme que les bibliothèques « sync-rpc » du monde Node,
 * appliqué à une seule chose : les requêtes d'identité.
 *
 * Ce que cela coûte, dit franchement : chaque requête d'identité bloque la boucle
 * d'événements du thread principal pendant l'aller-retour réseau. C'est mesuré et
 * documenté dans PHASE-12-REPORT.md, section performance. Ce que cela achète : les
 * sessions, les clés d'API et les credentials vivent dans PostgreSQL, donc **plusieurs
 * instances partagent la même vérité de sécurité**, ce qui était la condition ouverte
 * de la phase 11.
 *
 * CommonJS et pas TypeScript, volontairement : ce fichier est chargé comme worker
 * aussi bien sous `tsx` que depuis le bundle CJS de production, et un worker en TS
 * exigerait le chargeur de tsx dans les deux cas.
 *
 * `pg` est résolu depuis la racine de l'application (`requireBase`) et non depuis
 * l'emplacement de ce fichier : le bundle de production embarque `pg`, mais un worker
 * est un fichier séparé qui doit le résoudre lui-même.
 */

"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");

// STATE_PENDING (0) est posé par le thread principal avant chaque requête ; ce côté-ci
// n'écrit que STATE_DONE, donc la constante n'est pas redéclarée ici.
const STATE_DONE = 1;
const STATE_TOO_LARGE = 2;
const HEADER_BYTES = 16;

const control = new Int32Array(workerData.shared, 0, 4);
const data = new Uint8Array(workerData.shared, HEADER_BYTES);

/*
 * L'en-tête : [0] génération, [1] longueur, [2] identifiant de la requête, [3] état.
 * Tout est écrit AVANT que la génération change : c'est son changement qui publie la
 * réponse, et le thread principal ne lit rien tant qu'il ne l'a pas vu (sync-postgres.ts
 * explique les deux défauts que l'ancien protocole, à une seule case, laissait passer).
 */
function reply(id, payload) {
  const buffer = Buffer.from(JSON.stringify(payload), "utf8");
  if (buffer.byteLength > data.byteLength) {
    control[1] = buffer.byteLength;
    Atomics.store(control, 3, STATE_TOO_LARGE);
  } else {
    data.set(buffer);
    control[1] = buffer.byteLength;
    Atomics.store(control, 3, STATE_DONE);
  }
  Atomics.store(control, 2, id);
  Atomics.add(control, 0, 1);
  Atomics.notify(control, 0);
}

let pg;
let loadError = null;
try {
  /*
   * Résolu d'abord depuis l'emplacement du worker lui-même (donc l'installation
   * d'Oathrion), puis depuis le répertoire courant. Avant, seul le répertoire courant était
   * essayé : un service lancé depuis un autre répertoire refusait de démarrer.
   */
  const bases = [workerData.requireBase, ...(workerData.fallbackRequireBases || [])];
  let lastError = null;
  for (const base of bases) {
    try {
      pg = createRequire(base)("pg");
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!pg) throw lastError || new Error("pg not found");
  /*
   * Trois conversions, et une raison de sécurité pour chacune.
   *
   * int8 → Number : `SELECT COUNT(*)` renvoie une chaîne en PostgreSQL. Un compteur
   * d'administrateurs comparé comme chaîne ("0" est truthy) transformerait « il ne
   * reste plus d'admin » en « il en reste ».
   *
   * bool → 1/0 : le code d'identité lit `row.active !== 0`. Avec un booléen,
   * `false !== 0` vaut `true`, donc une organisation suspendue redeviendrait active.
   * C'est exactement la classe de bug que la parité SQLite/PostgreSQL doit exclure.
   *
   * timestamptz → ISO avec millisecondes : les enregistrements d'identité portent des
   * chaînes ISO d'un bout à l'autre (elles sont comparées par `Date.parse`, écrites
   * dans les empreintes de credential, renvoyées par l'API). Rendre un objet `Date`
   * changerait la forme des enregistrements sans qu'aucun type ne s'en plaigne.
   */
  pg.types.setTypeParser(20, (value) => Number(value));
  pg.types.setTypeParser(1700, (value) => Number(value));
  pg.types.setTypeParser(16, (value) => (value === "t" ? 1 : 0));
  for (const oid of [1114, 1184]) {
    const previous = pg.types.getTypeParser(oid);
    pg.types.setTypeParser(oid, (value) => {
      const parsed = previous(value);
      return parsed instanceof Date ? parsed.toISOString() : parsed;
    });
  }
} catch (error) {
  loadError = error;
}

let client = null;

/**
 * Une seule connexion, jamais un pool.
 *
 * `BEGIN` et `COMMIT` n'ont de sens que sur la connexion qui les a émis : un pool
 * rendrait une transaction d'identité non déterministe. Une connexion unique donne
 * aussi l'ordre strict dont dépend l'API synchrone.
 */
async function connection() {
  if (client) return client;
  const created = new pg.Client({
    connectionString: workerData.connectionString,
    application_name: "placet-identity",
    statement_timeout: workerData.statementTimeoutMs,
    connectionTimeoutMillis: workerData.connectTimeoutMs,
  });
  /*
   * Un `error` sur une connexion inactive (serveur redémarré, connexion coupée) est
   * émis hors de toute requête. Sans ce gestionnaire, Node ferait tomber le processus ;
   * avec lui, la connexion est simplement oubliée et la requête suivante en ouvre une
   * neuve. C'est la reconnexion : elle ne rejoue rien et n'autorise rien — la requête
   * qui subit la coupure échoue, et un échec d'identité est un refus.
   */
  created.on("error", () => {
    if (client === created) client = null;
  });
  await created.connect();
  client = created;
  return created;
}

function isConnectionLost(error) {
  const code = error && error.code;
  if (code === "57P01" || code === "57P02" || code === "57P03" || code === "08006" || code === "08003") {
    return true;
  }
  const message = String((error && error.message) || "");
  return (
    message.includes("Connection terminated") ||
    message.includes("connection terminated") ||
    message.includes("Client has encountered a connection error") ||
    message.includes("server closed the connection") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("Client was closed")
  );
}

/*
 * Une requête à la fois, dans l'ordre d'arrivée. Traitées en parallèle, deux requêtes
 * pouvaient, après une coupure, ouvrir chacune leur connexion et se répondre dans le
 * désordre.
 */
let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue.then(() => handle(message)).catch(() => {});
});

async function handle(message) {
  if (loadError) {
    reply(message.id, {
      ok: false,
      error:
        `the identity plane cannot reach PostgreSQL: the "pg" driver could not be loaded in the ` +
        `identity worker (${String(loadError.message || loadError)}). Oathrion does not fall back to SQLite.`,
      fatal: true,
    });
    return;
  }

  if (message.kind === "close") {
    const current = client;
    client = null;
    try {
      if (current) await current.end();
    } catch {
      // A shutdown must not be blocked by a socket that refuses to close.
    }
    reply(message.id, { ok: true, rows: [], rowCount: 0 });
    return;
  }

  try {
    const active = await connection();
    const result = await active.query({ text: message.sql, values: message.params });
    reply(message.id, { ok: true, rows: result.rows ?? [], rowCount: result.rowCount ?? 0 });
  } catch (error) {
    if (isConnectionLost(error)) {
      const lost = client;
      client = null;
      try {
        if (lost) lost.end().catch(() => {});
      } catch {
        // ignored: the connection is already gone
      }
    }
    /*
     * Le message d'erreur de `pg` ne contient jamais la chaîne de connexion, mais il
     * peut contenir les valeurs d'une contrainte violée. Il est renvoyé tel quel au
     * thread principal, qui décide de ce qui est journalisé — et jamais un secret :
     * les seules valeurs liées ici sont des identifiants et des empreintes.
     */
    reply(message.id, {
      ok: false,
      error: String((error && error.message) || error),
      code: (error && error.code) || null,
      connectionLost: isConnectionLost(error),
    });
  }
}
