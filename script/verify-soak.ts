/**
 * Endurance : laisser Oathrion tourner, sous trafic continu, et regarder ce qui dérive.
 *
 *   npm run build
 *   DATABASE_URL=postgres://… npm run verify:soak                 # 10 minutes
 *   DATABASE_URL=postgres://… SOAK_MINUTES=120 npm run verify:soak
 *
 * ## Pourquoi ce banc existe
 *
 * Toute la vérification de ce dépôt porte sur des exécutions COURTES : la suite démarre
 * un serveur, l'éprouve, l'arrête. `npm run pilot` simule trois mois de **données** mais
 * pas une minute de trafic soutenu. Personne n'avait jamais laissé Oathrion tourner.
 *
 * Les pannes que cela cache sont d'une famille entière et d'une seule : celles qui ne se
 * manifestent qu'avec le temps. Une fuite mémoire, un descripteur de fichier jamais
 * refermé, une connexion PostgreSQL qui s'accumule, une table de limiteur qui croît sans
 * être purgée, et — propre à ce produit — une **vérification de chaîne de reçus en
 * O(n)** dont le coût grandit avec le nombre de reçus du locataire.
 *
 * ## Ce que ce banc mesure, et ce qu'il ne peut pas conclure
 *
 * Il mesure une PENTE. Toutes les trente secondes il relève la mémoire résidente, les
 * descripteurs ouverts, les connexions PostgreSQL, le nombre de lignes du limiteur, le
 * nombre de reçus, et la durée d'une vérification de chaîne par étapes ; une vérification
 * complète, toutes les dix minutes. À la fin il compare la seconde moitié du passage à la
 * première.
 *
 * **Dix minutes ne prouvent pas vingt-quatre heures.** Ce banc attrape une fuite rapide
 * et établit la courbe ; il ne peut pas écarter une dérive lente. Le chiffre est donc
 * imprimé à chaque passage, avec sa durée, et `SOAK_MINUTES` existe pour qu'un exploitant
 * fasse tourner la version longue avant un pilote. C'est dit plutôt que laissé entendre.
 *
 * ## Le trafic
 *
 * Volontairement modeste et RÉALISTE plutôt que maximal : ce n'est pas un banc de
 * performance. Un cycle = une décision, une exécution, une lecture de reçus, une lecture
 * de métriques. Le plafond mesuré de l'instance est de 90–190 req/s ; on tourne bien en
 * dessous, parce qu'on cherche une dérive dans le temps et non un point de rupture.
 *
 * ## LA VOIE DU PARE-FEU, ET LA QUESTION QU'ON NOUS POSERA
 *
 * Ce banc ne mesurait que le plan d'autorisation : décider, exécuter, lire. Or depuis que
 * Oathrion se met DEVANT l'API d'un client, c'est `POST /api/v1/intercept/…` qui est sur le
 * chemin critique de la production du client — et la première question d'une direction
 * technique n'est pas « ça fuit ? » mais **« combien de millisecondes ça me coûte ? »**.
 *
 * Un passage relève donc aussi, à chaque cycle, deux durées :
 *
 *   · l'appel à l'API amont **en direct**, depuis ce script, sans Oathrion ;
 *   · le même appel **à travers** le pare-feu.
 *
 * La différence des médianes est le surcoût du pare-feu. Deux précautions sur ce chiffre :
 * il contient une boucle locale au lieu d'un lien réseau réel — en vrai réseau, la part de
 * Oathrion est RELATIVEMENT plus faible, puisque le trajet amont grandit et pas lui ; et il
 * est propre à cette machine. Ce qui est transposable, et ce sur quoi ce banc PREND un
 * contrôle, est la DÉRIVE : un p95 qui double entre la première et la seconde moitié du
 * passage est une panne, où que l'on tourne.
 *
 * Codes de sortie : 0 tout est passé · 1 un contrôle a échoué · 2 impossible à monter.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { Pool } from "pg";

import {
  baseUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";
import { startExampleMcpServer, type ExampleMcpServer } from "../examples/mcp-server/server";
import { PROTOCOL_VERSION } from "../server/mcp/protocol";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5291;
const BASE = `http://127.0.0.1:${PORT}`;
const DEST = "local-fixture";
/** Ce que le banc garde du journal du serveur en mémoire, et autour de chaque premier échec. */
const LOG_CAP = 8 * 1024 * 1024;
const FAILURE_WINDOW = 1024 * 1024;

/*
 * LA VOIE DU PARE-FEU. Le chemin est déclaré dans la règle et relayé tel quel ; le serveur
 * d'outils d'exemple répond à tout chemin en POST, donc l'amont existe vraiment et rend un
 * vrai 200 — ce qui est la condition pour que la durée mesurée veuille dire quelque chose.
 *
 * La destination est la même `local-fixture` que le reste du banc, et pas une seconde
 * entrée : `OATHRION_LOCAL_MCP_URL` est la SEULE variable qui accepte une adresse de boucle
 * locale, et `OATHRION_DESTINATIONS` la refuse par les règles d'adresse. Détourner cette
 * règle pour le confort d'un banc serait désactiver une protection pour faire passer un
 * test.
 */
const PROXY_PATH = "/v1/refunds";
const PROVIDER_KEY = `soak-provider-${Math.random().toString(36).slice(2)}-0123456789`;
const KEK = Buffer.from(
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)),
).toString("base64");

/*
 * `amountScale: 100` n'est pas décoratif : l'amont compte en centimes et le plafond de la
 * politique en unités. Sans le diviseur, 1 200 serait comparé à un plafond de 500 et
 * passerait — le défaut silencieux que `securityPostureNotices()` signale au démarrage.
 */
const INTERCEPT_RULE = {
  id: "soak_refunds",
  destination: DEST,
  method: "POST",
  path: PROXY_PATH,
  action: "refund",
  target: "body.charge",
  amount: "body.amount",
  currency: "body.currency",
  amountScale: 100,
  /*
   * `mcp-protocol-version` EST NOMMÉ ICI, et le premier passage de ce banc explique
   * pourquoi cette ligne n'est pas de la décoration.
   *
   * Avec `["content-type"]` seul, l'amont a refusé les 2 100 appels en 400 : il exige
   * l'en-tête de version, l'agent l'envoyait, et l'allowlist l'a retiré. C'est-à-dire que
   * l'allowlist a fait exactement son travail — un en-tête non déclaré par la règle
   * n'atteint pas le fournisseur, et aucune tolérance n'a été accordée au cas où ce
   * serait « probablement inoffensif ».
   *
   * Deux choses se sont prouvées toutes seules au passage : Oathrion a rendu le 400 DU
   * FOURNISSEUR au lieu de fabriquer un 200, et son en-tête de décision disait ALLOW —
   * la décision de gouvernance et la réponse de l'API sont deux informations distinctes,
   * et le relais ne confond pas « autorisé » avec « réussi ».
   *
   * La correction est celle qu'un exploitant ferait : déclarer dans la règle l'en-tête
   * dont son fournisseur a besoin.
   */
  forwardHeaders: ["content-type", "mcp-protocol-version"],
};

/** Le corps que l'agent envoie. Les champs en trop sont ignorés par l'amont JSON-RPC. */
const proxyBody = (cents: number) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  charge: "ch_soak",
  amount: cents,
  currency: "EUR",
});

const MINUTES = Math.max(1, Number(process.env.SOAK_MINUTES ?? "10"));
const SAMPLE_MS = 30_000;
/*
 * Une vérification COMPLÈTE tous les 20 relevés (dix minutes), et au premier. Le banc la
 * lançait à chaque relevé : à 360 000 reçus, 6 à 8 s de lecture de toute la chaîne toutes
 * les 30 s, sous le trafic (§5.36). Ce n'est pas l'usage prévu — c'est la vérification par
 * étapes qui tourne souvent, la complète se planifie (`docs/ON-CALL.md`).
 */
const FULL_VERIFY_EVERY = 20;
/*
 * La première minute est écartée de TOUTE conclusion — mémoire comme latence. Un tas V8
 * encore petit, des pools pas ouverts, aucun cache chaud et le JIT qui n'a rien compilé :
 * les premiers appels sont lents pour une raison qui n'est pas une panne. Le comparer à la
 * suite donnait « +28,5 % » sur un processus parfaitement stable.
 */
const WARMUP_MS = 60_000;
const SESSION_SECRET = `soak-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const SCRAPE = `soak-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const EMAIL = "admin@endurance.test";
const PASSWORD = `soak-${Math.random().toString(36).slice(2)}-pw-0123`;

type Child = ChildProcessByStdio<null, Readable, Readable>;
interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 66 - label.length))}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Un percentile, par interpolation la plus simple qui soit sur un échantillon trié.
 *
 * La moyenne est écartée volontairement : sur une latence, elle cache exactement ce qu'un
 * exploitant veut voir. Mille appels à 2 ms et dix à 2 s donnent une moyenne rassurante
 * et un p99 qui dit la vérité.
 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = (sorted.length - 1) * q;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

interface Res { status: number; body: Record<string, unknown>; text: string }
async function call(p: string, init: { method?: string; token?: string; json?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${BASE}${p}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* texte */ }
    return { status: res.status, body, text };
  } catch (error) {
    return { status: 0, body: {}, text: error instanceof Error ? error.message : String(error) };
  }
}

const intent = (amount: number) => ({
  action: "stripe.refund",
  destinationId: DEST,
  arguments: { customer: "cus_soak", amount, currency: "EUR" },
});

/** Un relevé, pris toutes les `SAMPLE_MS`. */
interface Sample {
  atMs: number;
  rssMb: number;
  handles: number;
  pgConnections: number;
  rateLimitRows: number;
  receipts: number;
  /* La vérification par étapes : sa durée, les reçus qu'elle a relus, et son verdict. */
  chainStepMs: number;
  chainStepRead: number;
  chainStepOk: boolean;
  chainStepMode: string;
  /* La vérification complète, prise un relevé sur `FULL_VERIFY_EVERY` ; `null` sinon. */
  chainFullMs: number | null;
  /*
   * Les requêtes garées en attente d'un humain. Un ALLOW n'écrit PAS ici — la voie rapide
   * reste en mémoire et la requête repart dans le même aller-retour HTTP. Cette colonne
   * est donc un zéro attendu, et un zéro attendu qu'on mesure : si elle montait sous un
   * trafic entièrement autorisé, le pare-feu paierait une écriture et une suppression par
   * appel, et la table grandirait sous le trafic d'une table qui ne devrait pas bouger.
   */
  pendingRows: number;
}

/** La mémoire résidente et les descripteurs du processus, lus dans /proc. */
function processStats(pid: number): { rssMb: number; handles: number } {
  try {
    // `statm` champ 2 = pages résidentes. Lu plutôt que `status`/VmRSS : un seul
    // nombre à analyser, donc rien à mal interpréter.
    const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1] ?? "0");
    return {
      rssMb: Math.round((pages * 4096) / 1024 / 1024),
      handles: readdirSync(`/proc/${pid}/fd`).length,
    };
  } catch {
    // -1 plutôt que 0 : une valeur illisible ne doit pas ressembler à « aucune fuite ».
    return { rssMb: -1, handles: -1 };
  }
}

async function main(): Promise<number> {
  console.log("OATHRION — ENDURANCE SOUS TRAFIC CONTINU");
  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE} :\n  npm run build`);
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante.");
    return 2;
  }
  if (!existsSync("/proc/self/statm")) {
    console.log("\nSKIPPÉ BRUYAMMENT : pas de /proc sur ce système.");
    console.log("La mémoire résidente et les descripteurs se lisent là ; sans eux, ce banc");
    console.log("ne mesurerait que le taux d'erreur et ne prétend donc rien.");
    return 0;
  }

  let db: ThrowawayDatabase | undefined;
  let tools: ExampleMcpServer | undefined;
  let child: Child | undefined;

  try {
    section(`MISE EN PLACE — ${MINUTES} minute(s), un relevé toutes les ${SAMPLE_MS / 1000} s`);
    db = await createThrowawayDatabase("oathrion_soak");
    tools = await startExampleMcpServer();
    console.log(`Base : ${db.name} sur ${redactUrl(baseUrl())}`);
    console.log(`Outils aval : ${tools.url}`);

    child = spawn("node", [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...productionPostgresEnv(db.url),
        OATHRION_DB: undefined,
        ARIA_DB: undefined,
        PORT: String(PORT),
        OATHRION_SESSION_SECRET: SESSION_SECRET,
        OATHRION_API_KEYS: "",
        OATHRION_CONSOLE_USERS: `Endurance/${EMAIL}:admin:${PASSWORD}`,
        OATHRION_SEED: "",
        OATHRION_METRICS_TOKEN: SCRAPE,
        OATHRION_LOCAL_MCP_URL: tools.url,
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
        /*
         * Plafonds relevés pour ce banc : il tourne en continu pendant des minutes, et
         * les valeurs livrées (120 décisions / minute) le feraient buter sur le limiteur
         * au lieu de mesurer une dérive. Ce n'est pas un contournement — c'est la
         * configuration que `§4.1bis` de DEPLOYMENT.md dit de régler selon le trafic
         * attendu, et un agent qui tourne en boucle EST ce trafic.
         */
        RATE_LIMIT_DECISION: "100000",
        RATE_LIMIT_WRITE: "100000",
        RATE_LIMIT_APPROVAL: "100000",
        /*
         * Le quota mensuel d'exécutions, relevé pour la même raison. La valeur livrée
         * (100 000 par mois) est atteinte en 2 h 42 à ce rythme : la passe de 12 h du 26
         * octobre a buté dessus, et ses neuf heures suivantes ne mesuraient plus le relais
         * mais un refus. Ce refus a révélé un défaut réel (le relais le rendait en 500),
         * corrigé et éprouvé par `intercept-gateway-failure.test.ts` ; ce banc, lui,
         * mesure l'endurance.
         */
        OATHRION_QUOTAS: "default:executions=100000000",
        /*
         * Le pare-feu : la règle, le credential du fournisseur, et la clé du coffre qui
         * le scelle. L'agent ne voit jamais `PROVIDER_KEY` — il n'a que sa clé Oathrion.
         */
        OATHRION_INTERCEPTS: JSON.stringify([INTERCEPT_RULE]),
        OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE: PROVIDER_KEY,
        OATHRION_KEK: KEK,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    let log = "";
    /*
     * `SOAK_SERVER_LOG=<fichier>` : le journal COMPLET du serveur, en plus des fenêtres
     * imprimées autour des premiers échecs. Ajouté parce qu'une expérience de coupure a
     * laissé six réponses 500 qu'aucune fenêtre ne montrait. Le banc vérifie déjà qu'aucun
     * secret n'apparaît dans la sortie ; ce fichier est un journal de diagnostic local.
     */
    const serverLog = process.env.SOAK_SERVER_LOG?.trim() || null;
    /*
     * LE JOURNAL GARDÉ EN MÉMOIRE EST BORNÉ. Il était cumulé sans limite : au bout de
     * 9 h 06 de trafic (passage du 26 octobre, 295 000 reçus), la chaîne a dépassé la
     * taille maximale d'une chaîne V8 et le BANC est mort (`RangeError: Invalid string
     * length`) — le serveur, lui, était stable à 289 Mo depuis sept heures. On garde la
     * fin du journal (de quoi imprimer les 40 dernières lignes) ; le contexte des premiers
     * échecs est capturé au moment où ils se produisent (`keepFailure`). Le journal
     * complet reste disponible sur disque avec `SOAK_SERVER_LOG`.
     */
    const keep = (c: Buffer) => {
      log += c.toString();
      if (log.length > LOG_CAP) log = log.slice(-LOG_CAP / 2);
      if (serverLog) appendFileSync(serverLog, c);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    let ready = false;
    for (let i = 0; i < 160 && !ready; i += 1) {
      if (child.exitCode !== null) break;
      ready = (await call("/api/ready")).status === 200;
      if (!ready) await sleep(250);
    }
    record("le bundle démarre", ready);
    if (!ready) {
      console.log(log.slice(-2000));
      return 2;
    }

    /*
     * La session de la console expire au bout de 12 h (`DEFAULT_TTL_MS`), et c'est voulu.
     * Une passe de 12 h la voit donc expirer à la toute fin : celle du 26 octobre a fini
     * sur trois 401 et une vérification finale illisible. Le banc se reconnecte comme le
     * ferait une personne, et le COMPTE au lieu de le prendre pour une erreur.
     */
    const login = async () => String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
    let admin = await login();
    let sessionRenewals = 0;
    const asAdmin = async (p: string): Promise<Res> => {
      const first = await call(p, { token: admin });
      if (first.status !== 401) return first;
      admin = await login();
      sessionRenewals += 1;
      return call(p, { token: admin });
    };
    await call("/api/agents", {
      token: admin,
      json: {
        id: "agt_soak", name: "Agent d'endurance", description: "banc", provider: "openai", model: "gpt-4o",
        status: "active", owner: "ops",
        mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
        /* Le verbe relayé est un remboursement : sans la portée, le pare-feu refuserait. */
        permissions: [
          { scope: "execute:payments", label: "Rembourser", description: "Sous mandat.", granted: true, risk: "high" },
        ],
        policyIds: [], tags: [],
      },
    });
    await call("/api/action-policies", {
      token: admin, method: "PUT",
      json: { id: "apol_soak", name: "courant", action: "stripe.refund", destinationId: DEST, effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
    });
    /*
     * Une politique de plafond, pour que la voie du pare-feu ÉVALUE quelque chose. Sans
     * elle, le passage mesurerait la latence d'un moteur de règles vide, ce qui n'est pas
     * la latence que le client verra.
     */
    await call("/api/policies", {
      token: admin,
      json: {
        id: "pol_soak_ceiling", name: "Au-dessus de 500, un humain", description: "Plafond.",
        type: "MAX_TRANSACTION_AMOUNT", condition: { kind: "amountAtMost", max: 500, currency: "EUR" },
        scope: "organization", appliesTo: "all agents", effect: "require_approval",
        status: "enabled", action: "APPROVAL_REQUIRED", risk: "high", priority: 10,
      },
    });
    const key = await call("/api/keys", { token: admin, json: { name: "clé endurance", role: "operator", agentId: "agt_soak" } });
    const agentKey = String(key.body.secret ?? "");
    record("agent, règle et credential en place", agentKey !== "");

    /* ------------------------------------------------- LE PASSAGE */
    section("TRAFIC — décider, exécuter, lire, scruter, en boucle");
    const pool = new Pool({ connectionString: db.url, max: 2 });
    /*
     * Une connexion inactive coupée par le serveur (base arrêtée, redémarrée) émet `error`
     * hors de toute requête ; sans écouteur, Node arrêterait LE BANC — et une coupure de base
     * provoquée pendant le passage mesurerait la chute de l'outil, pas celle d'Oathrion.
     */
    pool.on("error", () => undefined);
    const samples: Sample[] = [];
    const started = Date.now();
    const deadline = started + MINUTES * 60_000;
    let cycles = 0;
    let errors = 0;
    /* Les durées, en millisecondes, appariées cycle par cycle : à travers, puis en direct. */
    const proxyMs: number[] = [];
    const directMs: number[] = [];
    /* L'indice du premier cycle en régime établi, pour que la dérive compare deux moitiés
     * comparables au lieu d'opposer la montée en régime au reste du passage. */
    let steadyFrom = -1;
    const errorKinds = new Map<string, number>();
    let nextSample = started;

    const note = (what: string) => errorKinds.set(what, (errorKinds.get(what) ?? 0) + 1);
    /*
     * LES TROIS PREMIERS ÉCHECS EN ENTIER. Un compteur dit qu'il y a eu un 500 sur 2 451
     * appels ; il ne dit pas pourquoi, et un défaut à une occurrence sur deux mille est
     * exactement celui qu'on ne retrouvera pas en le cherchant à la main. On garde donc le
     * corps et le moment, bornés à trois pour que la sortie reste lisible.
     */
    const firstFailures: string[] = [];
    /* La fin du journal, prise deux secondes après chaque premier échec : le serveur écrit sa ligne après avoir répondu. */
    const failureWindows = new Map<string, string>();
    const keepFailure = (text: string) => {
      if (firstFailures.length >= 3) return;
      firstFailures.push(text);
      setTimeout(() => failureWindows.set(text, log.slice(-FAILURE_WINDOW)), 2000).unref();
    };

    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        record("le processus est resté vivant pendant tout le passage", false, `mort après ${Math.round((Date.now() - started) / 1000)} s`);
        console.log(log.slice(-2000));
        return 1;
      }

      const amount = 1 + (cycles % 90);
      const decision = await call("/api/actions/authorize", { token: agentKey, json: intent(amount) });
      if (decision.body.decision !== "ALLOW") { errors += 1; note(`autorisation ${decision.status}/${String(decision.body.decision)}`); }
      else {
        const run = await call("/api/actions/execute", {
          token: agentKey, json: { ...intent(amount), grantId: String(decision.body.grantId ?? "") },
        });
        if (run.status !== 200) { errors += 1; note(`exécution ${run.status}`); }
      }
      /*
       * LA VOIE DU PARE-FEU, chronométrée, et l'amont en direct juste après — dans le même
       * cycle et donc sous la même charge de machine. Mesurer les deux à des moments
       * différents produirait une différence qui ne serait pas celle d'Oathrion.
       */
      const tProxy = Date.now();
      const relayed = await fetch(`${BASE}/api/v1/intercept/${DEST}${PROXY_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${agentKey}`,
          "content-type": "application/json",
          "mcp-protocol-version": PROTOCOL_VERSION,
        },
        body: JSON.stringify(proxyBody(1_200)),
      });
      const relayedText = await relayed.text();
      proxyMs.push(Date.now() - tProxy);
      if (relayed.status !== 200 || relayed.headers.get("x-oathrion-decision") !== "ALLOW") {
        errors += 1;
        note(`relais ${relayed.status}/${String(relayed.headers.get("x-oathrion-decision"))}`);
        keepFailure(
          `cycle ${cycles} à ${Math.round((Date.now() - started) / 1000)} s — statut ${relayed.status}, ` +
            `décision ${String(relayed.headers.get("x-oathrion-decision"))}, ` +
            `exécution ${String(relayed.headers.get("x-oathrion-execution-id"))}\n      ${relayedText.slice(0, 400)}`,
        );
      } else if (!relayedText.includes("tools")) {
        /* Le corps du FOURNISSEUR, pas un 200 fabriqué par Oathrion. */
        errors += 1;
        note("le corps relayé n'est pas celui de l'amont");
      }

      const tDirect = Date.now();
      await fetch(tools.url, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": PROTOCOL_VERSION },
        body: JSON.stringify(proxyBody(1_200)),
      }).then((r) => r.text()).catch(() => "");
      directMs.push(Date.now() - tDirect);
      if (steadyFrom < 0 && Date.now() - started >= WARMUP_MS) steadyFrom = proxyMs.length;

      /*
       * LE STATUT EST CONSERVÉ, et ce n'est pas un détail de confort.
       *
       * Ces deux lignes comptaient « une erreur » sans dire laquelle. Un passage de dix
       * minutes a rendu `lecture des reçus×1` : une lecture non-200 sur ~4 300, et
       * impossible de savoir si c'était un 429 du limiteur (qui ferait son travail), un
       * 500 (qui serait un défaut), ou un 503 (qui en serait un autre).
       *
       * C'est exactement le défaut d'instrumentation qui a rendu le 500 relayé de §5decies
       * si long à cerner : un compteur sans la preuve. Le statut entre donc dans le nom,
       * et le premier échec est conservé en entier.
       */
      const receipts = await asAdmin("/api/actions/receipts");
      if (receipts.status !== 200) {
        errors += 1;
        note(`lecture des reçus ${String(receipts.status)}`);
        keepFailure(
          `cycle ${cycles} à ${Math.round((Date.now() - started) / 1000)} s — ` +
            `GET /api/actions/receipts a rendu ${String(receipts.status)} : ` +
            `${JSON.stringify(receipts.body).slice(0, 300)}`,
        );
      }
      const scrape = await call("/api/metrics", { token: SCRAPE });
      if (scrape.status !== 200) {
        errors += 1;
        note(`scrape ${String(scrape.status)}`);
        keepFailure(
          `cycle ${cycles} à ${Math.round((Date.now() - started) / 1000)} s — ` +
            `GET /api/metrics a rendu ${String(scrape.status)}`,
        );
      }
      cycles += 1;

      if (Date.now() >= nextSample) {
        nextSample = Date.now() + SAMPLE_MS;
        const stats = processStats(child.pid ?? 0);
        /*
         * Un relevé que la base ne peut pas fournir (coupée) est DIT et sauté, pas inventé :
         * le passage continue, et les contrôles portent sur les relevés réellement pris.
         */
        let counts: [{ rows: { n: string }[] }, { rows: { n: string }[] }, { rows: { n: string }[] }, { rows: { n: string }[] }];
        try {
          counts = [
            await pool.query<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database()`),
            await pool.query<{ n: string }>(`SELECT count(*) AS n FROM rate_limit_buckets`),
            await pool.query<{ n: string }>(`SELECT count(*) AS n FROM action_receipts`),
            await pool.query<{ n: string }>(`SELECT count(*) AS n FROM pending_interceptions`),
          ];
        } catch (error) {
          console.log(
            `    ${String(Math.round((Date.now() - started) / 1000)).padStart(5)} s  relevé impossible : la base ne répond pas ` +
              `(${error instanceof Error ? error.message.slice(0, 60) : "erreur"})`,
          );
          continue;
        }
        const [conns, rl, rc, pi] = counts;
        /*
         * Par étapes d'abord, puis la complète quand c'est son tour : la complète avance
         * aussi le point de reprise, et la mesure par étapes suivante ne relit alors que
         * les reçus des trente dernières secondes — ce qu'elle relirait en service.
         */
        const t0 = Date.now();
        const step = await asAdmin("/api/actions/receipts/verify?mode=incremental");
        const chainStepMs = Date.now() - t0;
        let chainFullMs: number | null = null;
        if (samples.length % FULL_VERIFY_EVERY === 0) {
          const t1 = Date.now();
          await asAdmin("/api/actions/receipts/verify");
          chainFullMs = Date.now() - t1;
        }
        const sample: Sample = {
          atMs: Date.now() - started,
          rssMb: stats.rssMb,
          handles: stats.handles,
          pgConnections: Number(conns.rows[0]?.n ?? "0"),
          rateLimitRows: Number(rl.rows[0]?.n ?? "0"),
          receipts: Number(rc.rows[0]?.n ?? "0"),
          pendingRows: Number(pi.rows[0]?.n ?? "0"),
          chainStepMs,
          chainStepRead: Number(step.body.entries ?? 0) - Number(step.body.verifiedFrom ?? 0),
          chainStepOk: step.body.ok === true,
          chainStepMode: String(step.body.mode ?? ""),
          chainFullMs,
        };
        samples.push(sample);
        console.log(
          `    ${String(Math.round(sample.atMs / 1000)).padStart(5)} s  ` +
            `rss ${String(sample.rssMb).padStart(4)} Mo  fd ${String(sample.handles).padStart(3)}  ` +
            `pg ${String(sample.pgConnections).padStart(2)}  limiteur ${String(sample.rateLimitRows).padStart(3)}  ` +
            `reçus ${String(sample.receipts).padStart(5)}  sas ${String(sample.pendingRows).padStart(2)}  ` +
            `étapes ${String(sample.chainStepMs).padStart(4)} ms (${String(sample.chainStepRead).padStart(5)} relus)` +
            (sample.chainFullMs === null ? "" : `  complète ${String(sample.chainFullMs).padStart(5)} ms`),
        );
      }
    }
    await pool.end().catch(() => undefined);

    /* ------------------------------------------------- LE VERDICT */
    section("VERDICT — la pente, pas l'instantané");
    const elapsedMin = (Date.now() - started) / 60_000;
    if (sessionRenewals > 0) console.log(`  session de la console renouvelée ${String(sessionRenewals)} fois (expiration normale, pas une erreur)`);
    console.log(`  ${cycles} cycles en ${elapsedMin.toFixed(1)} min (~${(cycles / elapsedMin / 60).toFixed(1)} cycles/s), ${samples.length} relevés`);

    record("le processus est resté vivant", child.exitCode === null);
    record("aucune erreur sur tout le passage", errors === 0,
      errors === 0 ? `${cycles * 6} requêtes` : [...errorKinds].map(([k, n]) => `${k}×${n}`).join(", "));
    if (firstFailures.length > 0) {
      console.log("\n  LES PREMIERS ÉCHECS, EN ENTIER :");
      for (const failure of firstFailures) console.log(`    · ${failure}`);
      /*
       * Et la sortie du processus. Un corps d'erreur dit ce que l'appelant a vu ; le
       * journal du serveur dit ce qui s'est passé. Les deux sont nécessaires pour un
       * défaut rare. Vérifié secret par secret avant impression, comme partout ailleurs.
       */
      const safe = log
        .split("\n")
        .filter((line) => !line.includes(SESSION_SECRET) && !line.includes(PASSWORD) && !line.includes(SCRAPE) && !line.includes(agentKey) && !line.includes(PROVIDER_KEY) && !line.includes(KEK))
        .slice(-40)
        .join("\n");
      console.log(`\n  LES 40 DERNIÈRES LIGNES DU PROCESSUS :\n${safe}`);
      /*
       * ET LES LIGNES DU PROCESSUS QUI PORTENT L'IDENTIFIANT DE CHAQUE ÉCHEC, avec ce qui
       * les suit. Les 40 dernières lignes ne couvraient jamais un échec survenu à la
       * 90e seconde d'un passage de dix minutes : la cause d'un 500 rare restait
       * inconnue. Mêmes filtres de secrets que ci-dessus.
       */
      for (const failure of firstFailures) {
        const requestId = /req_[0-9a-f]{32}/.exec(failure)?.[0];
        if (!requestId) continue;
        const lines = (failureWindows.get(failure) ?? log).split("\n");
        const at = lines.findIndex((line) => line.includes(requestId));
        const context = (at < 0 ? [] : lines.slice(Math.max(0, at - 15), at + 25))
          .filter((line) => !line.includes(SESSION_SECRET) && !line.includes(PASSWORD) && !line.includes(SCRAPE) && !line.includes(agentKey) && !line.includes(PROVIDER_KEY) && !line.includes(KEK))
          .filter((line) => !/ 200 in \d+ms/.test(line));
        console.log(`\n  AUTOUR DE ${requestId} :\n${context.length > 0 ? context.join("\n") : "    (identifiant absent du journal du processus)"}`);
      }
    }
    /*
     * LA MONTÉE EN RÉGIME EST ÉCARTÉE, et il faut dire pourquoi plutôt que de déplacer
     * une borne.
     *
     * Le premier relevé est pris AVANT qu'aucun trafic n'ait circulé : tas V8 encore
     * petit, pools de connexions pas encore ouverts, aucun cache chaud. Mesuré de 130 Mo
     * à 228 Mo sur le premier passage — puis 228, puis 228. Ce n'est pas une fuite,
     * c'est un démarrage, et le comparer à la suite donnait « +28,5 % » sur un processus
     * parfaitement stable.
     *
     * Une mesure d'endurance porte sur la dérive EN RÉGIME ÉTABLI. On écarte donc la
     * première minute, et on exige assez de relevés après elle pour que la pente ait un
     * sens — ce qui rend ce banc inutilisable en dessous de trois minutes, et c'est
     * honnête : deux minutes ne mesuraient rien.
     */
    const steady = samples.filter((s) => s.atMs >= WARMUP_MS);
    console.log(`  Montée en régime écartée : ${samples.length - steady.length} relevé(s) avant ${WARMUP_MS / 1000} s`);
    record("assez de relevés APRÈS la montée en régime", steady.length >= 4,
      `${steady.length} relevés en régime établi${steady.length < 4 ? ` — relancez avec SOAK_MINUTES≥${Math.max(4, MINUTES * 2)}` : ""}`);

    if (steady.length >= 4) {
      const half = Math.floor(steady.length / 2);
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const firstHalf = steady.slice(0, half);
      const lastHalf = steady.slice(half);

      const rssFirst = mean(firstHalf.map((s) => s.rssMb));
      const rssLast = mean(lastHalf.map((s) => s.rssMb));
      const rssGrowth = ((rssLast - rssFirst) / Math.max(rssFirst, 1)) * 100;
      /*
       * 25 % sur la seconde moitié : au-delà, ce n'est plus le ramasse-miettes qui
       * respire. Le seuil est arbitraire et assumé comme tel — ce qui compte est la
       * COURBE imprimée au-dessus, qu'un lecteur peut juger lui-même.
       */
      record("la mémoire résidente ne croît pas franchement", rssGrowth < 25,
        `${rssFirst.toFixed(0)} → ${rssLast.toFixed(0)} Mo (${rssGrowth >= 0 ? "+" : ""}${rssGrowth.toFixed(1)} %)`);

      const fdFirst = mean(firstHalf.map((s) => s.handles));
      const fdLast = mean(lastHalf.map((s) => s.handles));
      record("les descripteurs de fichier ne fuient pas", fdLast - fdFirst < 10,
        `${fdFirst.toFixed(0)} → ${fdLast.toFixed(0)}`);

      const pgMax = Math.max(...steady.map((s) => s.pgConnections));
      record("les connexions PostgreSQL restent bornées", pgMax <= 12, `maximum ${pgMax}`);

      const pendingMax = Math.max(...steady.map((s) => s.pendingRows));
      /*
       * Zéro, et c'est la propriété. Tout le trafic de ce banc est ALLOW, et un ALLOW ne
       * passe pas par le sas persisté : la requête reste en mémoire et repart dans le même
       * aller-retour. Une valeur non nulle ici voudrait dire que la voie rapide écrit en
       * base à chaque appel autorisé — une amplification d'écriture au bénéfice de
       * personne, et une table qui grandit sous le trafic.
       */
      record("un appel AUTORISÉ n'écrit rien dans le sas d'approbation", pendingMax === 0,
        `maximum ${pendingMax} ligne(s)`);

      const rlMax = Math.max(...steady.map((s) => s.rateLimitRows));
      /*
       * Le limiteur est keyé par (portée, sujet) : trois portées et deux credentials, donc
       * une poignée de lignes quoi qu'il arrive. Une croissance ici voudrait dire que la
       * clé contient quelque chose de variable — l'exacte panne de cardinalité que le
       * registre de métriques évite par construction.
       */
      record("la table du limiteur ne croît pas avec le trafic", rlMax <= 20, `maximum ${rlMax} lignes`);

      /*
       * LA MESURE PROPRE À CE PRODUIT, en deux temps depuis la migration 29.
       *
       * La vérification PAR ÉTAPES est celle qui tourne souvent : elle contrôle l'ancre
       * puis ne relit que les reçus postérieurs au point de reprise. Son coût doit suivre
       * le trafic des trente dernières secondes, pas la taille de la chaîne. C'est elle
       * qui porte le contrôle « praticable » — jusqu'au §5.36, ce contrôle portait sur la
       * complète, qui l'a échoué (8 s à 360 000 reçus) ; c'est consigné là, pas effacé.
       */
      const steps = steady.map((s) => s.chainStepMs).sort((a, b) => a - b);
      const stepReadMax = Math.max(...steady.map((s) => s.chainStepRead));
      const stepBad = steady.filter((s) => !s.chainStepOk || s.chainStepMode !== "incremental");
      console.log(
        `\n  Vérification par étapes : p50 ${percentile(steps, 0.5).toFixed(0)} ms · p95 ${percentile(steps, 0.95).toFixed(0)} ms · ` +
          `max ${percentile(steps, 1).toFixed(0)} ms ; au plus ${stepReadMax} reçus relus sur ${steady[steady.length - 1]!.receipts}.`,
      );
      record("chaque vérification par étapes réussit, et relit par étapes", stepBad.length === 0,
        stepBad.length === 0 ? `${steady.length} vérifications` : `${stepBad.length} en échec ou complètes`);
      record("la vérification par étapes reste praticable à ce volume", percentile(steps, 1) < 1_000,
        `max ${percentile(steps, 1).toFixed(0)} ms`);

      /*
       * La vérification COMPLÈTE reste en O(n) sur les reçus du locataire, et son coût
       * grandit pour toujours, puisque rien ne purge les reçus (décision du 27 octobre
       * 2026). Ce banc en donne la pente réelle — ce dont un exploitant a besoin pour
       * choisir l'heure et la fréquence de `audit:chains` — et prend un contrôle sur sa
       * FORME : le coût par reçu ne doit pas s'emballer avec le volume. Mesurée sous les
       * 10 000 reçus, la durée est trop courte pour qu'un rapport ait un sens.
       */
      const fulls = steady.filter((s) => s.chainFullMs !== null && s.receipts >= 10_000);
      if (fulls.length >= 2) {
        const perReceipt = (s: Sample) => (s.chainFullMs ?? 0) / s.receipts;
        const firstFull = fulls[0]!;
        const lastFull = fulls[fulls.length - 1]!;
        console.log(
          `  Vérification complète : ${firstFull.chainFullMs} ms pour ${firstFull.receipts} reçus, puis ` +
            `${lastFull.chainFullMs} ms pour ${lastFull.receipts} (~${(perReceipt(lastFull) * 1000).toFixed(0)} µs/reçu). ` +
            `C'est du O(n) : à 1 million de reçus, comptez ~${Math.round(perReceipt(lastFull) * 1000)} s. À planifier.`,
        );
        record("la vérification complète reste linéaire", perReceipt(lastFull) <= perReceipt(firstFull) * 2,
          `${(perReceipt(firstFull) * 1000).toFixed(1)} → ${(perReceipt(lastFull) * 1000).toFixed(1)} µs/reçu`);
      } else {
        console.log(`  Vérification complète : pas assez de reçus pour une pente (≥ 10 000, deux mesures) — non jugée.`);
      }
    }

    /* ------------------------------------------- LA LATENCE DU PARE-FEU */
    section("LATENCE — ce qu'Oathrion coûte sur le chemin critique du client");
    const steadyProxy = steadyFrom >= 0 ? proxyMs.slice(steadyFrom) : [];
    const steadyDirect = steadyFrom >= 0 ? directMs.slice(steadyFrom) : [];
    record("assez d'appels relayés APRÈS la montée en régime", steadyProxy.length >= 40,
      `${steadyProxy.length} appels en régime établi`);

    if (steadyProxy.length >= 40) {
      const sortedProxy = [...steadyProxy].sort((a, b) => a - b);
      const sortedDirect = [...steadyDirect].sort((a, b) => a - b);
      const fmt = (xs: number[]) =>
        `p50 ${percentile(xs, 0.5).toFixed(0)} ms · p95 ${percentile(xs, 0.95).toFixed(0)} ms · ` +
        `p99 ${percentile(xs, 0.99).toFixed(0)} ms · max ${xs[xs.length - 1]!.toFixed(0)} ms`;
      console.log(`  à travers Oathrion   ${fmt(sortedProxy)}`);
      console.log(`  amont en direct    ${fmt(sortedDirect)}`);
      const overhead = percentile(sortedProxy, 0.5) - percentile(sortedDirect, 0.5);
      console.log(
        `\n  SURCOÛT DU PARE-FEU, médiane à médiane : ${overhead.toFixed(0)} ms ` +
          `(${steadyProxy.length} appels appariés).`,
      );
      console.log("  Ce chiffre est propre à CETTE machine, et l'amont est une boucle locale :");
      console.log("  sur un vrai lien réseau, le trajet amont grandit et la part d'Oathrion non,");
      console.log("  donc le surcoût RELATIF y est plus faible qu'ici. Aucun SLO n'en sort.");

      /*
       * LE CONTRÔLE, lui, ne porte pas sur la valeur absolue mais sur la DÉRIVE : un p95
       * qui double entre les deux moitiés du régime établi est une panne sur n'importe
       * quelle machine, et c'est la seule conclusion qu'un banc de dix minutes sur un
       * portable peut honnêtement prendre.
       */
      const half = Math.floor(steadyProxy.length / 2);
      const p95First = percentile([...steadyProxy.slice(0, half)].sort((a, b) => a - b), 0.95);
      const p95Last = percentile([...steadyProxy.slice(half)].sort((a, b) => a - b), 0.95);
      record("le p95 du relais ne dérive pas sur la durée du passage",
        p95Last <= Math.max(p95First * 2, p95First + 25),
        `${p95First.toFixed(0)} → ${p95Last.toFixed(0)} ms`);

      /*
       * Et une borne de SANTÉ, large à dessein : au-delà d'une seconde au p99, ce n'est
       * plus un surcoût de gouvernance, c'est une attente sur une ressource — verrou,
       * pool, ou socket. Le seuil est assumé comme arbitraire ; les percentiles imprimés
       * au-dessus permettent à un lecteur de juger lui-même.
       */
      record("aucun appel relayé ne part en attente longue", percentile(sortedProxy, 0.99) < 1_000,
        `p99 ${percentile(sortedProxy, 0.99).toFixed(0)} ms`);
    }

    const finalChain = await asAdmin("/api/actions/receipts/verify");
    record("la chaîne de reçus vérifie à la fin du passage", finalChain.body.ok === true,
      `${String(finalChain.body.entries)} reçus`);
    record("le fournisseur a bien reçu le trafic", tools.executedCount() > 0, `${tools.executedCount()} exécutions`);
    record("aucun secret dans la sortie du processus",
      !log.includes(SESSION_SECRET) && !log.includes(PASSWORD) && !log.includes(SCRAPE) && !log.includes(agentKey));

    section("CE QUE CE PASSAGE NE PROUVE PAS");
    console.log(`  ${elapsedMin.toFixed(0)} minutes ne prouvent pas 24 heures. Ce banc attrape une fuite`);
    console.log("  RAPIDE et établit une courbe ; il ne peut pas écarter une dérive lente.");
    console.log("  Avant un pilote, relancez-le long : SOAK_MINUTES=720 npm run verify:soak");
    console.log("");
    console.log("  Et ce n'est pas un banc de performance : le trafic est volontairement");
    console.log("  très en dessous du plafond mesuré (90–190 req/s). Aucun SLO n'en sort.");
    console.log("");
    console.log("  Sur la latence : l'amont est une boucle locale et un seul appel circule à");
    console.log("  la fois. Ce passage ne dit donc RIEN de la latence sous concurrence, ni du");
    console.log("  comportement quand l'amont lui-même ralentit — deux mesures qui demandent");
    console.log("  un banc de charge, et que personne n'a encore faites.");

    return 0;
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child!.on("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
    }
    await tools?.close();
    await db?.dispose();
  }
}

main()
  .then((code) => {
    const failed = checks.filter((c) => !c.ok);
    if (checks.length > 0) {
      console.log(`\n${"=".repeat(72)}`);
      console.log(`${checks.length - failed.length}/${checks.length} contrôles passés`);
      console.log("=".repeat(72));
    }
    return code === 2 ? 2 : code === 0 && failed.length === 0 ? 0 : 1;
  })
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
