/**
 * LE BANC DE CHARGE : ce qu'Oathrion tient quand plusieurs agents appellent en même temps.
 *
 *   npm run build
 *   DATABASE_URL=postgres://… npm run verify:load
 *   DATABASE_URL=postgres://… LOAD_SECONDS=20 npm run verify:load
 *   DATABASE_URL=postgres://… LOAD_LEVELS=1,8,32,128,256 LOAD_MODE=execute npm run verify:load
 *
 * `LOAD_LEVELS` remplace les paliers (défaut 1, 4, 16, 64) pour chercher le point de
 * saturation. `LOAD_MODE=execute` fait de chaque itération un cycle complet — autoriser
 * PUIS exécuter —, donc une écriture de reçu dans la chaîne du locataire, sous son verrou :
 * c'est la voie d'écriture que le mode par défaut (décision seule) n'exerce pas.
 *
 * ## Pourquoi il n'existait pas, et pourquoi c'est un problème
 *
 * Tous les bancs de ce dépôt envoient **un appel à la fois**. `verify:soak` mesure une
 * dérive dans le temps, `profile:intercept` une répartition par phase — les deux en
 * séquentiel. Aucun chiffre de DÉBIT n'était donc défendable, et il manquait précisément
 * là où une direction technique regarde : combien de requêtes par seconde, et que devient
 * la latence quand la charge monte.
 *
 * ## LA MESURE QUI COMPTE N'EST PAS LE DÉBIT
 *
 * Le débit dépend de la machine, donc il s'imprime et ne conclut rien. Ce qui est
 * transposable est la FORME de la courbe :
 *
 *   · un service sain voit son débit MONTER avec la concurrence jusqu'à saturer un cœur
 *     ou la base, puis se stabiliser ;
 *   · un service qui BLOQUE sa boucle d'événements voit son débit plafonner tout de
 *     suite, et sa latence croître linéairement avec la concurrence — chaque requête
 *     attend toutes les précédentes.
 *
 * ## ET LA SONDE, QUI EST L'IDÉE DE CE FICHIER
 *
 * Pendant que N clients appellent la voie authentifiée, un client solitaire appelle
 * `/api/live` — une route SANS authentification, SANS base, qui ne fait rien. Sa latence
 * est donc, à peu de chose près, **le temps d'attente dans la file de la boucle
 * d'événements**.
 *
 * Si Oathrion ne bloque pas, cette sonde reste rapide quelle que soit la charge. Si elle
 * s'effondre, c'est que du travail synchrone tient la boucle — et `server/db.ts` en a :
 * le plan d'identité parle à PostgreSQL de façon BLOQUANTE, à chaque requête
 * authentifiée. Cette sonde est la façon de le mesurer de l'extérieur, sans instrumenter
 * le processus.
 *
 * Codes de sortie : 0 mesuré · 1 une erreur sous charge · 2 impossible à monter.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  baseUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";
import { startExampleMcpServer, type ExampleMcpServer } from "../examples/mcp-server/server";
import { Pool } from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5294;
const BASE = `http://127.0.0.1:${PORT}`;
const DEST = "local-fixture";

/** La durée de chaque palier de concurrence. */
const SECONDS = Math.max(3, Number(process.env.LOAD_SECONDS ?? "8"));
/** Les paliers. Un, pour la référence, puis des multiplications par quatre. */
const LEVELS = parseLevels(process.env.LOAD_LEVELS) ?? [1, 4, 16, 64];
/** `decide` : la décision seule. `execute` : décision puis exécution, donc un reçu écrit. */
const MODE: "decide" | "execute" = process.env.LOAD_MODE === "execute" ? "execute" : "decide";

function parseLevels(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const levels = raw.split(",").map((part) => Number(part.trim()));
  if (levels.length === 0 || levels.some((n) => !Number.isInteger(n) || n < 1 || n > 1024)) {
    throw new Error(`LOAD_LEVELS invalide : « ${raw} » — des entiers de 1 à 1024 séparés par des virgules`);
  }
  return levels;
}

const SESSION_SECRET = `load-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const SCRAPE_TOKEN = `load-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-scrape`;
const EMAIL = "admin@charge.test";
const PASSWORD = `load-${Math.random().toString(36).slice(2)}-pw-0123`;

type Child = ChildProcessByStdio<null, Readable, Readable>;
interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
/** Les `execute` qui ont répondu 200, tous paliers confondus : ce que l'intégrité doit retrouver. */
let acceptedExecutions = 0;
/**
 * `LOAD_QUOTA=<n>` (mode execute) : le plafond mensuel d'exécutions posé à `n`, pour
 * éprouver qu'aucune concurrence ne le dépasse. Les 429 `quota_exceeded` sont alors
 * comptés à part, pas comme des erreurs.
 */
/**
 * `LOAD_ORGS=<n>` : n ORGANISATIONS, chacune avec son agent, sa règle et sa clé, et les
 * clients répartis entre elles à tour de rôle. La voie d'écriture est sérialisée PAR
 * LOCATAIRE (la chaîne de reçus, le verrou du quota) : un seul locataire sature vers
 * 55–60 cycles/s, et ce réglage mesure si le débit TOTAL croît avec le nombre
 * d'organisations, comme le dessin le promet.
 */
const ORGS = Math.max(1, Math.min(64, Math.floor(Number(process.env.LOAD_ORGS ?? "1")) || 1));
/*
 * Un compte de CONSOLE par organisation, et non une clé de service : seul un
 * administrateur connecté peut émettre une clé d'agent (`POST /api/keys`).
 */
const ORG_USERS = Array.from({ length: ORGS }, (_, i) => ({
  org: i === 0 ? "Charge" : `Charge ${String(i + 1)}`,
  email: i === 0 ? "admin@charge.test" : `admin${String(i + 1)}@charge.test`,
  password: `load-org${String(i + 1)}-${Math.random().toString(36).slice(2)}-pw-0123`,
}));
const QUOTA = process.env.LOAD_QUOTA && Number(process.env.LOAD_QUOTA) > 0 ? Math.floor(Number(process.env.LOAD_QUOTA)) : null;
let quotaRefusals = 0;
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 66 - label.length))}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = (sorted.length - 1) * q;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

interface Res {
  status: number;
  body: Record<string, unknown>;
  /** `Retry-After` en secondes (1 quand absent ou illisible), pour qu'un client refusé attende comme un agent correct. */
  retryAfter: number;
}
async function call(
  pathname: string,
  init: { method?: string; token?: string; json?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    return { status: res.status, body, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1 };
  } catch {
    return { status: 0, body: {}, retryAfter: 1 };
  }
}

const intent = (amount: number) => ({
  action: "stripe.refund",
  destinationId: DEST,
  arguments: { customer: "cus_load", amount, currency: "EUR" },
});

interface LevelResult {
  concurrency: number;
  requests: number;
  errors: number;
  /** Les refus immédiats `503 overloaded` : voulus, pas des erreurs. Hors des latences. */
  shed: number;
  /** Les échecs par étape et statut — « execute 503 », « authorize 0 » (connexion perdue)… */
  errorsByStatus: Record<string, number>;
  seconds: number;
  perSecond: number;
  p50: number;
  p95: number;
  p99: number;
  /** La latence de la sonde `/api/live` PENDANT ce palier. */
  probeP50: number;
  probeP95: number;
  probeP99: number;
}

/**
 * Un palier : `concurrency` clients en boucle pendant `SECONDS`, plus la sonde.
 *
 * Les clients tournent en boucle fermée — chacun renvoie dès que sa réponse arrive. C'est
 * le modèle qui correspond à des agents : ils n'envoient pas à cadence fixe, ils attendent
 * leur réponse avant la suivante.
 */
async function runLevel(concurrency: number, tokens: string[]): Promise<LevelResult> {
  const latencies: number[] = [];
  const probe: number[] = [];
  let errors = 0;
  let shed = 0;
  const errorsByStatus: Record<string, number> = {};
  const fail = (step: string, status: number): void => {
    errors += 1;
    const label = `${step} ${String(status)}`;
    errorsByStatus[label] = (errorsByStatus[label] ?? 0) + 1;
  };
  const deadline = Date.now() + SECONDS * 1000;

  const worker = async (index: number): Promise<void> => {
    /* À tour de rôle : le client n°i agit pour l'organisation n°(i mod n). */
    const token = tokens[index % tokens.length]!;
    while (Date.now() < deadline) {
      const started = performance.now();
      const res = await call("/api/actions/authorize", { token, json: intent(1) });
      /*
       * LE REFUS IMMÉDIAT (`server/admission.ts`) n'est pas une erreur : c'est la réponse
       * voulue quand l'instance est pleine. Compté à part, et le client attend le
       * `Retry-After` comme le ferait un agent correct — sans cela, un client en boucle
       * fermée relancerait aussitôt et ne mesurerait que sa propre insistance.
       */
      if (res.status === 503 && res.body.code === "overloaded") {
        shed += 1;
        await sleep(1000 * res.retryAfter);
        continue;
      }
      if (res.status !== 200 || res.body.decision !== "ALLOW") {
        latencies.push(performance.now() - started);
        fail("authorize", res.status);
        continue;
      }
      if (MODE === "execute") {
        const run = await call("/api/actions/execute", {
          token,
          json: { ...intent(1), grantId: String(res.body.grantId ?? "") },
        });
        if (run.status === 503 && run.body.code === "overloaded") {
          /* Refusé AVANT toute décision : l'autorisation reste `issued`, non exécutée. */
          shed += 1;
          await sleep(1000 * run.retryAfter);
          continue;
        }
        if (run.status === 429 && run.body.code === "quota_exceeded" && QUOTA !== null) quotaRefusals += 1;
        else if (run.status !== 200) fail("execute", run.status);
        else acceptedExecutions += 1;
      }
      latencies.push(performance.now() - started);
    }
  };

  /*
   * LA SONDE. Séquentielle, et volontairement : elle mesure ce qu'une requête TRIVIALE
   * attend, donc elle ne doit pas elle-même ajouter de la charge. `/api/live` ne
   * s'authentifie pas et ne touche pas la base — sa latence est l'attente dans la file.
   */
  const prober = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const started = performance.now();
      await call("/api/live");
      probe.push(performance.now() - started);
      await sleep(20);
    }
  };

  const startedAt = Date.now();
  await Promise.all([...Array.from({ length: concurrency }, (_, i) => worker(i)), prober()]);
  const seconds = (Date.now() - startedAt) / 1000;

  const sorted = [...latencies].sort((a, b) => a - b);
  const probeSorted = [...probe].sort((a, b) => a - b);
  return {
    concurrency,
    requests: latencies.length,
    errors,
    shed,
    errorsByStatus,
    seconds,
    perSecond: latencies.length / seconds,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    probeP50: percentile(probeSorted, 0.5),
    probeP95: percentile(probeSorted, 0.95),
    probeP99: percentile(probeSorted, 0.99),
  };
}

async function main(): Promise<number> {
  console.log("OATHRION — BANC DE CHARGE : LE DÉBIT, ET CE QU'UNE REQUÊTE TRIVIALE ATTEND");
  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE} :\n  npm run build`);
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante : le bundle de production ne tourne que sur PostgreSQL.");
    return 2;
  }

  let db: ThrowawayDatabase | undefined;
  let tools: ExampleMcpServer | undefined;
  let child: Child | undefined;

  try {
    section(`MISE EN PLACE — paliers ${LEVELS.join(", ")} × ${SECONDS} s, mode ${MODE}${ORGS > 1 ? `, ${String(ORGS)} organisations` : ""}`);
    db = await createThrowawayDatabase("oathrion_load");
    tools = await startExampleMcpServer();
    console.log(`Base : ${db.name} sur ${redactUrl(baseUrl())}`);

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
        OATHRION_CONSOLE_USERS: [`Charge/${EMAIL}:admin:${PASSWORD}`, ...ORG_USERS.slice(1).map((u) => `${u.org}/${u.email}:admin:${u.password}`)].join(","),
        OATHRION_SEED: "",
        OATHRION_METRICS_TOKEN: SCRAPE_TOKEN,
        OATHRION_LOCAL_MCP_URL: tools.url,
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
        /*
         * Les plafonds du limiteur sont relevés : ce banc EST le trafic que
         * `DEPLOYMENT.md` dit de régler selon l'usage attendu, et les buter mesurerait le
         * limiteur au lieu du serveur. Ce n'est pas une protection désactivée — c'est la
         * valeur qu'un déploiement à ce débit configurerait.
         */
        RATE_LIMIT_DECISION: "10000000",
        RATE_LIMIT_WRITE: "10000000",
        RATE_LIMIT_APPROVAL: "10000000",
        ...(QUOTA !== null ? { OATHRION_QUOTAS: `default:executions=${String(QUOTA)}`, OATHRION_QUOTA_MODE: "enforce" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    let log = "";
    child.stdout.on("data", (c: Buffer) => (log += c.toString()));
    child.stderr.on("data", (c: Buffer) => (log += c.toString()));

    let ready = false;
    for (let i = 0; i < 200 && !ready; i += 1) {
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
     * Un administrateur par organisation, connecté à la console. Chaque organisation
     * reçoit son agent, sa règle et sa clé d'opérateur.
     */
    const admins: string[] = [];
    for (const [i, user] of ORG_USERS.entries()) {
      const login = i === 0 ? { email: EMAIL, password: PASSWORD } : { email: user.email, password: user.password };
      admins.push(String((await call("/api/auth/login", { json: login })).body.token ?? ""));
    }
    const tokens: string[] = [];
    for (const admin of admins) {
      await call("/api/agents", {
        token: admin,
        json: {
          id: "agt_load", name: "Agent de charge", description: "banc", provider: "openai", model: "gpt-4o",
          status: "active", owner: "ops",
          mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
          permissions: [], policyIds: [], tags: [],
        },
      });
      await call("/api/action-policies", {
        token: admin, method: "PUT",
        json: {
          id: "apol_load", name: "charge", action: "stripe.refund", destinationId: DEST,
          effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100,
        },
      });
      const key = await call("/api/keys", { token: admin, json: { name: "clé de charge", role: "operator", agentId: "agt_load" } });
      tokens.push(String(key.body.secret ?? ""));
    }
    record(
      `agent, règle et credential en place${ORGS > 1 ? ` dans ${String(ORGS)} organisations` : ""}`,
      tokens.length === ORGS && tokens.every((t) => t !== ""),
    );
    if (tokens.some((t) => t === "")) return 2;
    const token = tokens[0]!;

    /* La chauffe : JIT, pools, caches. Sans elle le premier palier mesure un démarrage. */
    for (let i = 0; i < 200; i += 1) await call("/api/actions/authorize", { token, json: intent(1) });

    /* ---------------------------------------------------- LES PALIERS */
    section("PALIERS — débit, latence, et ce qu'attend une requête triviale");
    console.log(
      MODE === "execute"
        ? "  conc. cycles/s     p50      p95      p99  │  sonde /api/live p50/p95/p99   (cycle = autoriser + exécuter)"
        : "  conc.   req/s      p50      p95      p99  │  sonde /api/live p50/p95/p99",
    );
    const results: LevelResult[] = [];
    for (const concurrency of LEVELS) {
      if (child.exitCode !== null) {
        record("le processus est resté vivant", false, "mort pendant le banc");
        console.log(log.slice(-2000));
        return 1;
      }
      const result = await runLevel(concurrency, tokens);
      results.push(result);
      console.log(
        `  ${String(concurrency).padStart(5)}` +
          `${result.perSecond.toFixed(0).padStart(8)}` +
          `${result.p50.toFixed(0).padStart(9)} ms` +
          `${result.p95.toFixed(0).padStart(6)} ms` +
          `${result.p99.toFixed(0).padStart(6)} ms  │  ` +
          `${result.probeP50.toFixed(0)} / ${result.probeP95.toFixed(0)} / ${result.probeP99.toFixed(0)} ms` +
          (result.shed > 0 ? `   ⤫ ${String(result.shed)} refusées aussitôt (débordé)` : "") +
          (result.errors > 0
            ? `   ⚠ ${String(result.errors)} erreurs (${Object.entries(result.errorsByStatus)
                .map(([label, n]) => `${label}×${String(n)}`)
                .join(", ")})`
            : ""),
      );
    }

    /*
     * LE RETOUR AU CALME. Un client seul, après le palier le plus haut : un service qui a
     * tenu la charge revient à sa latence de repos ; un service qui a laissé derrière lui
     * une file, des connexions épuisées ou un verrou tenu ne revient pas. Le seuil est
     * large (trois fois le premier palier, plus 20 ms de bruit) : il attrape un état
     * dégradé, pas une variation de cache.
     */
    const recovery = await runLevel(1, tokens);
    console.log(
      `  calme${recovery.perSecond.toFixed(0).padStart(8)}` +
        `${recovery.p50.toFixed(0).padStart(9)} ms` +
        `${recovery.p95.toFixed(0).padStart(6)} ms` +
        `${recovery.p99.toFixed(0).padStart(6)} ms  │  ` +
        `${recovery.probeP50.toFixed(0)} / ${recovery.probeP95.toFixed(0)} / ${recovery.probeP99.toFixed(0)} ms` +
        (recovery.errors > 0 ? `   ⚠ ${String(recovery.errors)} erreurs` : ""),
    );

    /* ------------------------------------------- L'ATTRIBUTION */
    section("LA CAUSE — une file de tâches, ou un BLOCAGE ?");

    /*
     * La sonde mesure l'attente depuis l'extérieur ; elle ne dit pas si cette attente est
     * une file de tâches asynchrones ou un blocage de la boucle. La jauge de retard de
     * boucle, elle, le dit depuis l'intérieur :
     *
     *   · un processus SATURÉ de travail asynchrone garde un retard faible — il passe
     *     d'une tâche à l'autre, et la lenteur vient du nombre de tâches ;
     *   · un processus qui fait des entrées-sorties SYNCHRONES voit son retard égaler la
     *     durée de ces appels, et pendant ce temps il ne peut rien chevaucher.
     *
     * Sans ce croisement, « la sonde est lente » autorise les deux conclusions, et
     * refactorer sur la mauvaise coûte des jours.
     */
    const scrape = await fetch(`${BASE}/api/metrics`, {
      headers: { authorization: `Bearer ${SCRAPE_TOKEN}` },
    });
    const metrics = scrape.ok ? await scrape.text() : "";
    const readGauge = (name: string): number | null => {
      const match = new RegExp(`^${name} (\\d+)$`, "m").exec(metrics);
      return match ? Number(match[1]) : null;
    };
    const loopP50 = readGauge("oathrion_event_loop_delay_p50_ms");
    const loopP99 = readGauge("oathrion_event_loop_delay_p99_ms");
    const loopMax = readGauge("oathrion_event_loop_delay_max_ms");

    if (loopP50 === null) {
      record("le retard de boucle est lisible dans /api/metrics", false, "jauge absente");
    } else {
      console.log(
        `  retard de la boucle d'événements, mesuré DANS le processus :\n` +
          `    p50 ${String(loopP50)} ms · p99 ${String(loopP99)} ms · max ${String(loopMax)} ms`,
      );
      /*
       * Le seuil sépare les deux diagnostics. Un retard p99 supérieur à 50 ms veut dire
       * que la boucle a été tenue pendant des dizaines de millisecondes d'affilée :
       * aucune quantité de travail asynchrone ne produit ça, seulement un appel
       * bloquant.
       */
      const blocked = (loopP99 ?? 0) > 50;
      console.log(
        blocked
          ? `\n  ⚠ DIAGNOSTIC : la boucle est BLOQUÉE, pas seulement chargée. Du travail\n` +
              `    synchrone la tient pendant des dizaines de millisecondes. Le plan d'identité\n` +
              `    d'Oathrion parle à PostgreSQL de façon bloquante à chaque requête\n` +
              `    authentifiée (\`createSyncPostgresDatabase\`, server/db.ts).`
          : `\n  DIAGNOSTIC : la boucle n'est pas bloquée — le retard reste faible. La lenteur\n` +
              `    sous charge vient du NOMBRE de tâches et des limites de la base, pas d'un\n` +
              `    appel synchrone. Un passage à l'asynchrone ne la corrigerait pas.`,
      );
      record("le retard de boucle est mesuré et attribué", true, `p99 ${String(loopP99)} ms`);
    }

    /* ---------------------------------------------------- LE VERDICT */
    section("CE QUE LA COURBE DIT");

    const first = results[0]!;
    const last = results[results.length - 1]!;
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0) + recovery.errors;
    record("aucune erreur sous charge", totalErrors === 0, `${String(totalErrors)} sur ${String(results.reduce((s, r) => s + r.requests, 0))} requêtes`);
    record("le processus est resté vivant", child.exitCode === null);
    record(
      "le service revient à sa latence de repos après le pic",
      recovery.p95 <= first.p95 * 3 + 20,
      `p95 ${first.p95.toFixed(0)} ms avant · ${recovery.p95.toFixed(0)} ms après ${String(last.concurrency)} clients`,
    );

    /*
     * LE GAIN DE DÉBIT ENTRE 1 ET 64 CLIENTS.
     *
     * Un service qui chevauche ses requêtes multiplie son débit jusqu'à saturer une
     * ressource. Un service qui bloque sa boucle d'événements n'y gagne presque rien : les
     * requêtes font la queue, et 64 clients obtiennent le débit d'un seul.
     *
     * Le seuil est à 1,5× et non à 64× : une partie du travail est réellement
     * synchrone — hachage, sérialisation — et la base a ses propres limites. On ne demande
     * pas la perfection, on demande que la concurrence serve à QUELQUE CHOSE.
     */
    /*
     * AU MEILLEUR PALIER, et non au dernier, depuis le refus immédiat
     * (`server/admission.ts`). Au-delà du plafond, une partie du temps du processus sert à
     * refuser : le débit du DERNIER palier baisse, et c'est le prix voulu d'une attente
     * bornée — mesuré et imprimé, pas caché. La question de ce contrôle reste la même :
     * la concurrence sert-elle à quelque chose, ou la boucle est-elle bloquée ?
     */
    const best = results.reduce((a, b) => (b.perSecond > a.perSecond ? b : a), first);
    const speedup = best.perSecond / Math.max(first.perSecond, 0.001);
    record(
      "la concurrence augmente le débit",
      speedup >= 1.5,
      `×${speedup.toFixed(2)} entre 1 et ${String(best.concurrency)} clients ` +
        `(${first.perSecond.toFixed(0)} → ${best.perSecond.toFixed(0)} req/s ; ${last.perSecond.toFixed(0)} à ${String(last.concurrency)})`,
    );

    /*
     * LE REFUS IMMÉDIAT BORNE L'ATTENTE. Sans lui (journal §5.27), le p99 grandissait avec
     * le nombre de clients : 10 s pour une décision, 20 s pour un cycle à 1 024. Avec lui,
     * le p99 au palier le plus chargé doit rester dans le double de celui du dernier
     * palier sans refus.
     */
    const calm = [...results].reverse().find((r) => r.shed === 0);
    if (results.some((r) => r.shed > 0) && calm) {
      record(
        "au-delà du plafond, l'attente des requêtes admises reste bornée",
        last.p99 <= calm.p99 * 2,
        `p99 ${last.p99.toFixed(0)} ms à ${String(last.concurrency)} clients · ${calm.p99.toFixed(0)} ms à ${String(calm.concurrency)} (sans refus) · ` +
          `${String(results.reduce((n, r) => n + r.shed, 0))} refus 503 overloaded`,
      );
    }

    /*
     * LA SONDE, ET C'EST LE CHIFFRE LE PLUS PARLANT DE CE BANC.
     *
     * `/api/live` ne s'authentifie pas, ne touche pas la base, et ne fait rien. Sa latence
     * sous charge est donc l'attente dans la file de la boucle d'événements. Si elle
     * explose, du travail SYNCHRONE tient la boucle — et le plan d'identité d'Oathrion en
     * fait à chaque requête authentifiée.
     */
    const probeGrowth = last.probeP95 / Math.max(first.probeP95, 0.001);
    console.log(
      `\n  Une requête TRIVIALE (/api/live, sans auth, sans base) attend :\n` +
        `    à 1 client    p95 ${first.probeP95.toFixed(1)} ms\n` +
        `    à ${String(last.concurrency)} clients   p95 ${last.probeP95.toFixed(1)} ms   (×${probeGrowth.toFixed(1)})`,
    );
    console.log(
      "\n  Une croissance forte ici n'est pas de la charge CPU : c'est une file. Le plan\n" +
        "  d'identité d'Oathrion parle à PostgreSQL de façon BLOQUANTE à chaque requête\n" +
        "  authentifiée (`createSyncPostgresDatabase` dans server/db.ts), donc la boucle\n" +
        "  d'événements ne peut rien chevaucher pendant ce temps.",
    );

    if (MODE === "execute" && db && tools) {
      /*
       * L'INTÉGRITÉ SOUS PRESSION — ce qu'aucun chiffre de débit ne dit.
       *
       * À 1 024 clients, des centaines d'autorisations se disputent le même verrou de
       * chaîne. Ce qui doit tenir quoi qu'il arrive : chaque autorisation s'exécute au plus
       * une fois, chaque exécution acceptée a son reçu et un seul appel en aval, et la
       * chaîne du locataire se vérifie encore de bout en bout. Lu dans la base même et
       * chez le fournisseur simulé, pas dans les réponses d'Oathrion.
       */
      section("INTÉGRITÉ — après la pression");
      const pool = new Pool({ connectionString: db.url, max: 1 });
      try {
        const counts = await pool.query<{ receipts: string; grants: string; consumed: string }>(
          `SELECT (SELECT count(*) FROM action_receipts) AS receipts,
                  (SELECT count(DISTINCT grant_id) FROM action_receipts) AS grants,
                  (SELECT count(*) FROM action_grants WHERE state = 'consumed') AS consumed`,
        );
        const receipts = Number(counts.rows[0]?.receipts ?? -1);
        const grants = Number(counts.rows[0]?.grants ?? -1);
        const consumed = Number(counts.rows[0]?.consumed ?? -1);
        record("un reçu par exécution acceptée", receipts === acceptedExecutions, `${String(receipts)} reçus · ${String(acceptedExecutions)} exécutions acceptées`);
        record("aucune autorisation exécutée deux fois", grants === receipts && consumed === receipts, `${String(grants)} autorisations distinctes · ${String(consumed)} consommées`);
        record(
          "un seul appel en aval par exécution",
          tools.receivedCount() === acceptedExecutions && tools.executedCount() === acceptedExecutions,
          `${String(tools.receivedCount())} reçus par le fournisseur · ${String(tools.executedCount())} exécutés`,
        );
        if (QUOTA !== null) {
          const peak = Math.max(...LEVELS);
          const over = Math.max(0, receipts - QUOTA);
          record("le plafond a mordu", quotaRefusals > 0, `${String(quotaRefusals)} refus 429 quota_exceeded`);
          /*
           * ZÉRO, et non « borné par la concurrence ». Le premier comptage, hors
           * transaction, laissait passer 1 279 exécutions pour 600 à 1 024 clients
           * (journal §5.27). Le comptage se fait maintenant dans la transaction qui
           * consomme, sous un verrou par locataire : aucun dépassement n'est admis.
           */
          record(
            "le plafond n'est jamais dépassé, même sous concurrence",
            over === 0,
            `${String(receipts)} exécutions pour un plafond de ${String(QUOTA)} à ${String(peak)} clients : dépassement ${String(over)}`,
          );
        }
        /* Une chaîne PAR organisation : chacune se vérifie, et leur somme est le total des reçus. */
        let entries = 0;
        const broken: string[] = [];
        for (const [i, admin] of admins.entries()) {
          const verdict = await call("/api/actions/receipts/verify", { token: admin });
          entries += Number(verdict.body.entries ?? 0);
          if (verdict.body.ok !== true) broken.push(`organisation ${String(i + 1)} : ${String(verdict.body.reason)}`);
        }
        record(
          `la chaîne de reçus se vérifie de bout en bout${ORGS > 1 ? `, dans chacune des ${String(ORGS)} organisations` : ""}`,
          broken.length === 0 && entries === receipts,
          `${String(entries)} entrées${broken.length > 0 ? ` · ${broken.join(" ; ")}` : ""}`,
        );
      } finally {
        await pool.end().catch(() => undefined);
      }
    }

    section("CE QUE CE BANC NE PROUVE PAS");
    console.log("  Les chiffres absolus sont ceux de CETTE machine, avec la base dans un");
    console.log("  conteneur voisin. Ce qui est transposable est la FORME : le gain de débit");
    console.log("  avec la concurrence, et la croissance de la sonde. Les deux ont la même");
    console.log("  cause et se corrigent ensemble.");
    console.log("");
    console.log("  Les plafonds du limiteur sont relevés pour ce banc. Un déploiement réel");
    console.log("  les règle selon son trafic attendu, et c'est eux qui bornent le débit");
    console.log("  d'un agent — pas la capacité du serveur.");

    return 0;
  } finally {
    const spawned = child;
    if (spawned && spawned.exitCode === null) {
      const exited = new Promise((r) => spawned.on("exit", r));
      spawned.kill("SIGTERM");
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
    process.exit(2);
  });
