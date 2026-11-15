/**
 * OÙ passent les millisecondes du pare-feu.
 *
 *   npm run build
 *   DATABASE_URL=postgres://… npm run profile:intercept
 *   DATABASE_URL=postgres://… PROFILE_CALLS=600 npm run profile:intercept
 *
 * ## Pourquoi ce banc est distinct de `verify:soak`
 *
 * `verify:soak` a répondu à « combien ? » : **32 à 37 ms** de surcoût, médiane à médiane,
 * reproductible sur trois passages. C'est honnête et ça ne permet pas d'agir — un total
 * ne dit pas quoi réparer. Optimiser à partir de ce seul chiffre revient à deviner, à
 * remesurer le total, et à ne rien apprendre quand il ne bouge pas.
 *
 * Ce banc répond à « où ? ». Il allume `OATHRION_TIMING_HEADER`, qui fait porter à chaque
 * réponse relayée un en-tête `Server-Timing` détaillant les phases internes, et il
 * agrège ces phases sur plusieurs centaines d'appels.
 *
 * ## Ce qu'il mesure vraiment
 *
 * Trois nombres par passage, et ils ne disent pas la même chose :
 *
 *   · **l'amont en direct** — le plancher. Ce que l'agent paierait sans Oathrion.
 *   · **le total vu par le client** — ce que l'agent paie avec Oathrion.
 *   · **les phases serveur** — où va la différence.
 *
 * La somme des phases est INFÉRIEURE au total serveur, et l'écart est lui aussi une
 * information : c'est Express, la sérialisation JSON, l'ordonnanceur de Node et ce que
 * personne n'a instrumenté. Un écart qui dominerait le tableau voudrait dire que
 * l'instrumentation regarde au mauvais endroit.
 *
 * Les appels sont SÉQUENTIELS et l'amont est une boucle locale : ce banc établit la
 * répartition, pas un SLO. Sous concurrence, les phases d'attente de base changent de
 * poids et il faudrait un banc de charge, qui n'existe pas encore.
 *
 * Codes de sortie : 0 mesuré · 2 impossible à monter.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5293;
const BASE = `http://127.0.0.1:${PORT}`;
const DEST = "local-fixture";
const PROXY_PATH = "/v1/refunds";
const AGENT = "agt_profil";

const CALLS = Math.max(50, Number(process.env.PROFILE_CALLS ?? "400"));
/*
 * La chauffe est écartée pour la même raison que dans `verify:soak` : le JIT n'a rien
 * compilé, les pools ne sont pas ouverts, et les premiers appels sont lents pour une
 * raison qui n'est pas une panne. Les garder décalerait toutes les médianes vers le haut
 * et ferait croire à un surcoût que personne ne paie en régime.
 */
const WARMUP = 60;

const SESSION_SECRET = `prof-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const EMAIL = "admin@profil.test";
const PASSWORD = `prof-${Math.random().toString(36).slice(2)}-pw-0123`;
const PROVIDER_KEY = `sk_profil_${Math.random().toString(36).slice(2)}`;
const KEK = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString("base64");

type Child = ChildProcessByStdio<null, Readable, Readable>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 68 - label.length))}`);
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = (sorted.length - 1) * q;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}
const med = (xs: number[]) => percentile([...xs].sort((a, b) => a - b), 0.5);
const p95 = (xs: number[]) => percentile([...xs].sort((a, b) => a - b), 0.95);

/* --------------------------- l'API amont, minimale ----------------------- */

/*
 * Volontairement la plus bête possible : une réponse fixe, aucun calcul, aucune E/S. Un
 * amont qui travaille mélangerait son coût au nôtre, et c'est le nôtre qu'on cherche.
 */
async function startTarget(): Promise<{ url: string; close: () => Promise<void> }> {
  const body = '{"id":"re_profil","status":"succeeded"}';
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* --------------------------------- client -------------------------------- */

interface Res { status: number; body: Record<string, unknown>; raw: string }
async function call(
  pathname: string,
  init: { method?: string; token?: string; json?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = { raw };
  }
  return { status: res.status, body, raw };
}

/** `nom;dur=12.34, autre;dur=5` → `{ nom: 12.34, autre: 5 }`. */
function parseServerTiming(header: string | null): Record<string, number> {
  if (!header) return {};
  const out: Record<string, number> = {};
  for (const part of header.split(",")) {
    const [name, ...rest] = part.trim().split(";");
    const dur = rest.find((p) => p.trim().startsWith("dur="));
    if (name && dur) {
      const value = Number(dur.trim().slice(4));
      if (Number.isFinite(value)) out[name.trim()] = value;
    }
  }
  return out;
}

const RULE = {
  id: "profil_refunds",
  destination: DEST,
  method: "POST",
  path: PROXY_PATH,
  action: "refund",
  target: "body.charge",
  amount: "body.amount",
  currency: "body.currency",
  amountScale: 100,
  forwardHeaders: ["content-type"],
};

const BODY = { charge: "ch_profil", amount: 1_200, currency: "EUR" };

async function main(): Promise<number> {
  console.log("OATHRION — OÙ PASSENT LES MILLISECONDES DU PARE-FEU");
  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE} :\n  npm run build`);
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante : le bundle de production ne tourne que sur PostgreSQL.");
    return 2;
  }

  let db: ThrowawayDatabase | undefined;
  let target: { url: string; close: () => Promise<void> } | undefined;
  let child: Child | undefined;

  try {
    section(`MISE EN PLACE — ${CALLS} appels mesurés, ${WARMUP} de chauffe écartés`);
    db = await createThrowawayDatabase("oathrion_profil");
    target = await startTarget();
    console.log(`Base : ${db.name} sur ${redactUrl(baseUrl())}`);
    console.log(`Amont : ${target.url} (réponse fixe, aucun calcul)`);

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
        OATHRION_CONSOLE_USERS: `Profil/${EMAIL}:admin:${PASSWORD}`,
        OATHRION_SEED: "",
        OATHRION_LOCAL_MCP_URL: target.url,
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
        OATHRION_INTERCEPTS: JSON.stringify([RULE]),
        OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE: PROVIDER_KEY,
        OATHRION_KEK: KEK,
        /* LA RAISON D'ÊTRE DE CE BANC. */
        OATHRION_TIMING_HEADER: "1",
        RATE_LIMIT_DECISION: "1000000",
        RATE_LIMIT_WRITE: "1000000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    let log = "";
    child.stdout.on("data", (c: Buffer) => (log += c.toString()));
    child.stderr.on("data", (c: Buffer) => (log += c.toString()));

    let ready = false;
    for (let i = 0; i < 160 && !ready; i += 1) {
      if (child.exitCode !== null) break;
      try {
        ready = (await call("/api/ready")).status === 200;
      } catch {
        ready = false;
      }
      if (!ready) await sleep(250);
    }
    if (!ready) {
      console.error("\nLe bundle n'a pas démarré.");
      console.error(log.slice(-2000));
      return 2;
    }

    const admin = String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
    await call("/api/agents", {
      token: admin,
      json: {
        id: AGENT, name: "Agent de profilage", description: "banc", provider: "openai", model: "gpt-4o",
        status: "active", owner: "ops",
        mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
        permissions: [
          { scope: "execute:payments", label: "Rembourser", description: "Sous mandat.", granted: true, risk: "high" },
        ],
        policyIds: [], tags: [],
      },
    });
    await call("/api/policies", {
      token: admin,
      json: {
        id: "pol_profil", name: "Au-dessus de 500, un humain", description: "Plafond.",
        type: "MAX_TRANSACTION_AMOUNT", condition: { kind: "amountAtMost", max: 500, currency: "EUR" },
        scope: "organization", appliesTo: "all agents", effect: "require_approval",
        status: "enabled", action: "APPROVAL_REQUIRED", risk: "high", priority: 10,
      },
    });
    const key = await call("/api/keys", { token: admin, json: { name: "clé profil", role: "operator", agentId: AGENT } });
    const agentKey = String(key.body.secret ?? "");
    if (agentKey === "") {
      console.error("\nAucune clé d'agent délivrée ; rien à mesurer.");
      return 2;
    }

    /* ------------------------------------------------------- LA MESURE */
    section("MESURE — séquentielle, un appel à la fois");

    const totals: number[] = [];
    const directs: number[] = [];
    const phases = new Map<string, number[]>();
    let nonAllow = 0;
    let withoutTiming = 0;

    for (let i = 0; i < WARMUP + CALLS; i += 1) {
      const measured = i >= WARMUP;

      const t0 = performance.now();
      const relayed = await fetch(`${BASE}/api/v1/intercept/${DEST}${PROXY_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
        body: JSON.stringify(BODY),
      });
      await relayed.text();
      const total = performance.now() - t0;

      if (relayed.status !== 200 || relayed.headers.get("x-oathrion-decision") !== "ALLOW") {
        nonAllow += 1;
        continue;
      }
      const timing = parseServerTiming(relayed.headers.get("server-timing"));
      if (Object.keys(timing).length === 0) withoutTiming += 1;

      const t1 = performance.now();
      await fetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(BODY),
      }).then((r) => r.text());
      const direct = performance.now() - t1;

      if (measured) {
        totals.push(total);
        directs.push(direct);
        for (const [name, ms] of Object.entries(timing)) {
          const bucket = phases.get(name) ?? [];
          bucket.push(ms);
          phases.set(name, bucket);
        }
      }
      if ((i + 1) % 100 === 0) console.log(`    ${i + 1} appels…`);
    }

    if (nonAllow > 0) {
      console.log(`\n  ⚠ ${nonAllow} appel(s) non-ALLOW, écartés de la mesure.`);
    }
    if (withoutTiming > 0 && process.env.PROFILE_ALLOW_NO_TIMING !== "1") {
      console.error(
        `\n  ✗ ${withoutTiming} réponse(s) sans en-tête Server-Timing : OATHRION_TIMING_HEADER ` +
          `n'a pas pris effet, et ce banc ne mesurerait qu'un total.\n` +
          `    PROFILE_ALLOW_NO_TIMING=1 le force — utile pour comparer un build ANTÉRIEUR à ` +
          `l'instrumentation, où le total est la seule chose comparable.`,
      );
      return 2;
    }
    if (totals.length === 0) {
      console.error("\nAucun appel mesuré.");
      return 2;
    }

    /* ------------------------------------------------------- LE TABLEAU */
    section("RÉPARTITION — médiane par phase, sur les appels mesurés");

    const totalMed = med(totals);
    const directMed = med(directs);
    const rows = [...phases]
      .map(([name, xs]) => ({ name, p50: med(xs), p95: p95(xs) }))
      /*
       * `gateway` et `dispatch` CONTIENNENT les autres : les afficher comme des lignes de
       * somme serait compter deux fois. Elles restent dans le tableau, marquées, parce que
       * leur écart avec la somme de leurs filles est exactement ce qui n'est pas instrumenté.
       */
      .sort((a, b) => b.p50 - a.p50);

    const CONTAINERS = new Set(["gateway", "dispatch"]);
    const leaves = rows.filter((r) => !CONTAINERS.has(r.name));
    const leafSum = leaves.reduce((a, r) => a + r.p50, 0);

    console.log(`  total vu par le client   ${totalMed.toFixed(1)} ms`);
    console.log(`  amont en direct          ${directMed.toFixed(1)} ms   ← le plancher`);
    console.log(`  SURCOÛT OATHRION           ${(totalMed - directMed).toFixed(1)} ms\n`);
    console.log("  phase            p50       p95     part du surcoût");
    for (const row of rows) {
      const share = CONTAINERS.has(row.name)
        ? "    (englobante)"
        : `${((row.p50 / Math.max(totalMed - directMed, 0.01)) * 100).toFixed(0).padStart(10)} %`;
      console.log(
        `  ${row.name.padEnd(14)}${row.p50.toFixed(2).padStart(7)} ms${row.p95.toFixed(2).padStart(9)} ms${share}`,
      );
    }
    console.log(
      `\n  somme des phases feuilles ${leafSum.toFixed(1)} ms sur ${totalMed.toFixed(1)} ms de total : ` +
        `${(totalMed - leafSum).toFixed(1)} ms ne sont pas instrumentés (Express, JSON, ordonnanceur).`,
    );

    section("CE QUE CE BANC NE DIT PAS");
    console.log("  Les appels sont séquentiels et l'amont est une boucle locale. Sous");
    console.log("  concurrence, les attentes de base changent de poids : la répartition");
    console.log("  ci-dessus est celle d'un appel seul, pas celle d'une instance chargée.");
    console.log("  Aucun SLO n'en sort. C'est une carte pour savoir quoi réparer.");

    return 0;
  } finally {
    const spawned = child;
    if (spawned && spawned.exitCode === null) {
      const exited = new Promise((r) => spawned.on("exit", r));
      spawned.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
    }
    await target?.close();
    await db?.dispose();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(2);
  });
