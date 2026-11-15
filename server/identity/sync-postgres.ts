/**
 * PHASE 12 — PostgreSQL appelé de façon synchrone, pour le plan d'identité seulement.
 *
 * ## Le problème, exactement
 *
 * La phase 11 a laissé une condition ouverte, et c'était la bonne à laisser ouverte :
 * le plan d'identité restait sur SQLite parce que ses ~100 sites d'appel sont
 * synchrones. Conséquence opérationnelle : deux instances Oathrion partageaient leurs
 * décisions et leurs reçus, mais pas leurs sessions ni leurs clés d'API. Révoquer une
 * clé sur l'instance A la laissait vivante sur l'instance B. C'est un défaut de
 * sécurité distribué, pas une gêne.
 *
 * ## Ce que fait ce module
 *
 * Il présente la **forme** de `better-sqlite3` (`prepare().get()/all()/run()`, `exec()`,
 * `transaction()`) au-dessus d'une vraie connexion PostgreSQL portée par un
 * `worker_thread` (`sync-postgres-worker.cjs`). Le thread principal écrit la requête,
 * bloque sur `Atomics.wait`, et lit la réponse dans un `SharedArrayBuffer`.
 *
 * Les magasins d'identité existants n'ont donc **pas** été réécrits : ils exécutent le
 * même texte SQL, contre PostgreSQL. La parité SQLite/PostgreSQL devient structurelle —
 * il n'y a pas deux implémentations de « révoquer une session » qui pourraient diverger.
 * C'est la propriété qui compte le plus ici : une différence de sécurité entre les deux
 * moteurs serait interdite, et la meilleure façon de l'interdire est de n'avoir qu'un
 * seul code.
 *
 * ## Le prix, sans le cacher
 *
 * - Chaque requête d'identité bloque la boucle d'événements du thread principal le temps
 *   d'un aller-retour PostgreSQL (mesuré dans PHASE-12-REPORT.md).
 * - Une connexion par instance pour le plan d'identité, pas un pool : une transaction
 *   n'a de sens que sur la connexion qui l'a ouverte.
 * - Le worker est un fichier séparé qui doit pouvoir résoudre `pg` à l'exécution.
 *
 * ## Ce qu'il ne fait jamais
 *
 * Il ne se replie pas sur SQLite. Une requête qui échoue lève. Une identité inconnue,
 * une base injoignable, une réponse trop grande : tout cela produit une erreur, jamais
 * un enregistrement fabriqué et jamais une autorisation.
 */

import { Worker } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";

/*
 * LE PROTOCOLE, quatre cases de l'en-tête partagé (voir sync-postgres-worker.cjs) :
 *
 *   [0] GÉNÉRATION — incrémentée par le worker à CHAQUE réponse publiée ; c'est la seule
 *       case sur laquelle le thread principal attend ;
 *   [1] longueur de la réponse ;
 *   [2] identifiant de la requête à laquelle la réponse appartient ;
 *   [3] état de la réponse : terminée, ou trop grande pour le tampon.
 *
 * Avant, une seule case servait à la fois d'état et de point d'attente, remise à
 * « en attente » par le thread principal avant chaque requête. Deux défauts en sortaient :
 *
 *   - un réveil RETARDÉ : le worker publie l'état PUIS notifie, en deux instructions. Si
 *     le thread principal voyait l'état avant la notification, il passait à la requête
 *     suivante, et la notification tardive réveillait CETTE attente-là alors que rien
 *     n'était écrit — longueur 0, `JSON.parse("")`, une 500 sur une lecture
 *     authentifiée. Reproduit deux fois en 32 552 cycles par `SOAK_MINUTES=60
 *     verify:soak` (docs/STRESS-TEST-LOG.md), avec la trace dans `resolveActive` et
 *     `membership` ;
 *   - une réponse ORPHELINE : après un délai dépassé, la réponse tardive de la requête N
 *     était lue comme celle de la requête N+1 — des lignes d'identité rendues à une autre
 *     requête que la leur.
 *
 * Désormais le thread principal attend que la GÉNÉRATION change, ignore tout réveil qui
 * ne l'a pas fait changer, et ignore toute réponse qui ne porte pas SON identifiant.
 */
const SLOT_GENERATION = 0;
const SLOT_LENGTH = 1;
const SLOT_REQUEST = 2;
const SLOT_STATE = 3;
/*
 * Écrit par le worker, jamais par ce fichier. La constante reste nommée pour que le
 * protocole soit lisible des deux côtés.
 */
const _STATE_DONE = 1;
const STATE_TOO_LARGE = 2;
const HEADER_BYTES = 16;

/** 32 MiB de mémoire partagée pour la plus grande réponse d'identité (une liste de sessions plafonnée). */
const DEFAULT_BUFFER_BYTES = 32 * 1024 * 1024;

export class IdentityDatabaseError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "IdentityDatabaseError";
    this.code = code;
  }
}

export interface SyncStatement<Result = unknown> {
  get(...params: unknown[]): Result | undefined;
  all(...params: unknown[]): Result[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
}

export interface SyncPostgresDatabase {
  readonly open: boolean;
  /**
   * Les deux paramètres de type reproduisent la signature de better-sqlite3
   * (`prepare<Params, Row>`) : les magasins d'identité l'appellent déjà ainsi, et seul le
   * second est utilisé ici.
   */
  prepare<_Args = unknown, R = unknown>(sql: string): SyncStatement<R>;
  exec(sql: string): void;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  pragma(statement: string): unknown[];
  close(): void;
}

interface WorkerReply {
  ok: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  error?: string;
  code?: string | null;
  connectionLost?: boolean;
  fatal?: boolean;
}

/**
 * Le worker est un fichier réel sur le disque, cherché à des emplacements explicites.
 *
 * Aucun de ces chemins n'est deviné à partir de `import.meta.url` : ce module est
 * compilé à la fois en ESM (tsx, vitest) et en CommonJS (bundle de production), et les
 * deux n'exposent pas la même chose. Une liste de candidats, une variable
 * d'environnement pour les déploiements atypiques, et un refus clair si rien n'existe.
 */
export function resolveIdentityWorkerPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OATHRION_IDENTITY_PG_WORKER?.trim();
  /*
   * Un chemin explicite qui n'existe pas est une erreur, pas un candidat parmi d'autres.
   * Retomber en silence sur le fichier du dépôt ferait exactement ce que la Phase 12
   * interdit : exécuter autre chose que ce que l'opérateur a demandé, sans le dire.
   */
  if (override !== undefined && override !== "" && !fs.existsSync(override)) {
    throw new IdentityDatabaseError(
      `OATHRION_IDENTITY_PG_WORKER points at a file that does not exist: ${override}\n` +
        `  Oathrion will not silently use another worker, and will not start on SQLite instead.`,
    );
  }
  /*
   * Phase 13: in the production bundle (CommonJS) `__dirname` is the bundle's own
   * directory, where the build copies the worker. Tried after the explicit override
   * and before the working directory, so `node /opt/placet/dist/index.cjs` started from
   * any directory (systemd without WorkingDirectory, a container entrypoint) finds the
   * worker it was shipped with. Not used under tsx/vitest (ESM), where it is undefined.
   */
  const bundleDir = typeof __dirname === "string" ? __dirname : null;
  const candidates = [
    ...(override ? [override] : []),
    ...(bundleDir ? [path.join(bundleDir, "sync-postgres-worker.cjs")] : []),
    path.join(process.cwd(), "server/identity/sync-postgres-worker.cjs"),
    path.join(process.cwd(), "dist/sync-postgres-worker.cjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new IdentityDatabaseError(
    `the identity plane is configured on PostgreSQL but its worker file was not found.\n` +
      `  Looked for:\n${candidates.map((c) => `    - ${c}`).join("\n")}\n` +
      `  Set OATHRION_IDENTITY_PG_WORKER to its absolute path. Oathrion will not start on SQLite instead.`,
  );
}

/**
 * Réécriture de dialecte, réduite au strict nécessaire.
 *
 * Le SQL d'identité était déjà portable à trois exceptions près, et chacune est traitée
 * ici plutôt que dans les magasins — pour que le texte exécuté sur les deux moteurs
 * reste le même fichier source :
 *
 *   - les paramètres positionnels `?` deviennent `$1..$n` ;
 *   - les paramètres nommés de better-sqlite3 (`@id`) deviennent positionnels ;
 *   - `INSERT OR IGNORE` devient `ON CONFLICT DO NOTHING`.
 *
 * `INSERT OR REPLACE` n'est pas traduit : il n'est utilisé nulle part sur ce plan, et
 * l'inventer sans appelant produirait une sémantique non testée. Il lève.
 */
export function translateIdentitySql(sql: string): { text: string; names: string[] | null } {
  let text = sql;

  if (/insert\s+or\s+replace/i.test(text)) {
    throw new IdentityDatabaseError(
      `INSERT OR REPLACE has no tested PostgreSQL translation on the identity plane: ${sql}`,
    );
  }

  const ignore = /insert\s+or\s+ignore\s+into/i;
  const wasIgnore = ignore.test(text);
  if (wasIgnore) text = text.replace(ignore, "INSERT INTO");

  /*
   * Substitution consciente des littéraux. Un `?` ou un `@nom` à l'intérieur d'une
   * chaîne (`'why?'`), d'un identifiant entre guillemets doubles ou d'un commentaire
   * n'est pas un paramètre : le remplacer changerait la donnée écrite plutôt que la
   * requête. Un simple `String.replace` global l'aurait fait — c'est le défaut qu'un
   * test de la Phase 12 a trouvé avant qu'un appelant ne le rencontre.
   */
  const names: string[] = [];
  let positional = 0;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];

    // Chaîne littérale SQL : `''` à l'intérieur est un apostrophe échappé.
    if (char === "'") {
      const end = ((): number => {
        let cursor = index + 1;
        while (cursor < text.length) {
          if (text[cursor] === "'") {
            if (text[cursor + 1] === "'") cursor += 2;
            else return cursor;
          } else cursor += 1;
        }
        return text.length - 1;
      })();
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    // Identifiant entre guillemets doubles.
    if (char === '"') {
      const end = text.indexOf('"', index + 1);
      const stop = end === -1 ? text.length - 1 : end;
      out += text.slice(index, stop + 1);
      index = stop + 1;
      continue;
    }

    // Commentaire de fin de ligne.
    if (char === "-" && text[index + 1] === "-") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      out += text.slice(index, stop);
      index = stop;
      continue;
    }

    // Commentaire de bloc.
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === "?") {
      positional += 1;
      out += `$${positional}`;
      index += 1;
      continue;
    }

    if (char === "@") {
      const match = /^@([a-zA-Z_][a-zA-Z0-9_]*)/.exec(text.slice(index));
      if (match) {
        const name = match[1];
        let slot = names.indexOf(name);
        if (slot === -1) {
          names.push(name);
          slot = names.length - 1;
        }
        out += `$${slot + 1}`;
        index += match[0].length;
        continue;
      }
    }

    out += char;
    index += 1;
  }
  text = out;

  /*
   * Les deux styles ne se mélangent pas : better-sqlite3 lie soit une liste, soit un
   * objet, et un mélange rendrait la numérotation ambiguë. Refus explicite.
   */
  if (names.length > 0 && positional > 0) {
    throw new IdentityDatabaseError(
      `mixed named and positional parameters are not supported on the identity plane: ${sql}`,
    );
  }

  if (wasIgnore && !/on\s+conflict/i.test(text)) {
    text = `${text.replace(/;\s*$/, "")} ON CONFLICT DO NOTHING`;
  }

  return { text, names: names.length > 0 ? names : null };
}

/**
 * Ouvre le plan d'identité sur PostgreSQL.
 *
 * Échoue à l'ouverture si le serveur ne répond pas : un processus qui démarre sans
 * savoir où vit l'identité est plus dangereux qu'un processus qui refuse de démarrer.
 */
export function createSyncPostgresDatabase(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): SyncPostgresDatabase {
  const workerPath = resolveIdentityWorkerPath(env);
  const timeoutMs = Number(env.OATHRION_IDENTITY_PG_TIMEOUT_MS?.trim() || 15_000);
  const bufferBytes = Number(env.OATHRION_IDENTITY_PG_BUFFER_BYTES?.trim() || DEFAULT_BUFFER_BYTES);

  const shared = new SharedArrayBuffer(HEADER_BYTES + bufferBytes);
  const control = new Int32Array(shared, 0, 4);
  const data = new Uint8Array(shared, HEADER_BYTES);

  const worker = new Worker(workerPath, {
    workerData: {
      shared,
      connectionString,
      // `pg` is resolved from the worker's own location first (the Oathrion install),
      // then from the working directory, as before.
      requireBase: workerPath,
      fallbackRequireBases: [path.join(process.cwd(), "package.json")],
      statementTimeoutMs: timeoutMs,
      connectTimeoutMs: timeoutMs,
    },
  });
  /*
   * `unref` : le worker ne doit pas maintenir le processus en vie. Il continue de
   * traiter les messages pendant que le thread principal est bloqué sur `Atomics.wait`
   * (ce sont deux threads), mais il n'empêche ni un test ni un conteneur de se terminer.
   */
  worker.unref();
  let closed = false;
  let workerFailed: Error | null = null;
  worker.on("error", (error) => {
    workerFailed = error instanceof Error ? error : new Error(String(error));
  });

  const cache = new Map<string, { text: string; names: string[] | null }>();

  function translated(sql: string) {
    const hit = cache.get(sql);
    if (hit) return hit;
    const built = translateIdentitySql(sql);
    cache.set(sql, built);
    return built;
  }

  let lastRequestId = 0;

  function request(sql: string, params: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } {
    if (closed) {
      throw new IdentityDatabaseError("the identity database handle is closed");
    }
    lastRequestId = (lastRequestId % 0x7fffffff) + 1;
    const id = lastRequestId;
    /* Lue AVANT l'envoi : une réponse publiée entre l'envoi et l'attente change la génération. */
    let seen = Atomics.load(control, SLOT_GENERATION);
    worker.postMessage({ id, sql, params });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new IdentityDatabaseError(
          `the identity plane did not answer within ${timeoutMs}ms` +
            (workerFailed ? ` (identity worker error: ${workerFailed.message})` : "") +
            `. No SQLite fallback: the caller is treated as unauthenticated.`,
        );
      }
      Atomics.wait(control, SLOT_GENERATION, seen, remaining);
      const now = Atomics.load(control, SLOT_GENERATION);
      /* Un réveil sans nouvelle réponse — la notification tardive d'une réponse déjà lue. */
      if (now === seen) continue;
      seen = now;
      /* La réponse tardive d'une requête abandonnée sur délai : jamais rendue à celle-ci. */
      if (Atomics.load(control, SLOT_REQUEST) === id) break;
    }
    const state = Atomics.load(control, SLOT_STATE);
    if (state === STATE_TOO_LARGE) {
      throw new IdentityDatabaseError(
        `an identity query returned ${control[SLOT_LENGTH]} bytes, more than the ${data.byteLength}-byte shared ` +
          `buffer. Raise OATHRION_IDENTITY_PG_BUFFER_BYTES. The result is refused rather than truncated.`,
      );
    }
    const length = control[SLOT_LENGTH];
    const reply = JSON.parse(Buffer.from(data.subarray(0, length)).toString("utf8")) as WorkerReply;
    if (!reply.ok) {
      throw new IdentityDatabaseError(reply.error ?? "unknown identity database error", reply.code ?? null);
    }
    return { rows: reply.rows ?? [], rowCount: reply.rowCount ?? 0 };
  }

  function bind(sql: string, params: unknown[]): { text: string; values: unknown[] } {
    const { text, names } = translated(sql);
    if (names) {
      const bag = (params[0] ?? {}) as Record<string, unknown>;
      return { text, values: names.map((name) => bag[name] ?? null) };
    }
    const flat = params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
    return { text, values: flat };
  }

  const handle: SyncPostgresDatabase = {
    get open() {
      return !closed;
    },

    prepare<_Args = unknown, R = unknown>(sql: string): SyncStatement<R> {
      // Traduit une fois, tôt : une requête intraduisible doit échouer au chargement du
      // module, pas au premier login.
      translated(sql);
      return {
        get(...params: unknown[]) {
          const { text, values } = bind(sql, params);
          const result = request(text, values);
          return (result.rows[0] as R | undefined) ?? undefined;
        },
        all(...params: unknown[]) {
          const { text, values } = bind(sql, params);
          return request(text, values).rows as R[];
        },
        run(...params: unknown[]) {
          const { text, values } = bind(sql, params);
          const result = request(text, values);
          // `lastInsertRowid` n'existe pas en PostgreSQL et aucun appelant du plan
          // d'identité ne le lit. Renvoyer 0 est honnête ; inventer une valeur ne
          // le serait pas.
          return { changes: result.rowCount, lastInsertRowid: 0 };
        },
      };
    },

    exec(sql: string) {
      request(sql, []);
    },

    transaction<T extends (...args: never[]) => unknown>(fn: T): T {
      return ((...args: never[]) => {
        request("BEGIN", []);
        try {
          const result = fn(...args);
          request("COMMIT", []);
          return result;
        } catch (error) {
          try {
            request("ROLLBACK", []);
          } catch {
            // Une transaction déjà avortée par le serveur refuse le ROLLBACK. L'erreur
            // d'origine est celle qui doit remonter.
          }
          throw error;
        }
      }) as T;
    },

    pragma() {
      /*
       * Les pragmas sont propres à SQLite. Ils sont ignorés plutôt que refusés parce que
       * le seul appelant en production est `journal_mode = WAL` au démarrage, qui n'a
       * aucun sens ici. Les tests qui lisent `pragma_table_info` sont des tests SQLite et
       * ne passent pas par ce chemin.
       */
      return [];
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        worker.terminate();
      } catch {
        // ignored: shutdown must not fail on a worker that is already gone
      }
    },
  };

  /*
   * Une requête réelle avant de rendre le handle. Un `SELECT 1` qui échoue ici est la
   * différence entre « Oathrion refuse de démarrer parce que l'identité est injoignable » et
   * « Oathrion démarre et refusera silencieusement tous les logins ».
   */
  request("SELECT 1", []);
  return handle;
}
