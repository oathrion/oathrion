/**
 * LE BANC DE PANNES : ce qui reste vrai quand tout casse SOUS LA CHARGE.
 *
 *   npm run build
 *   DATABASE_URL=postgres://… npm run verify:faults
 *   DATABASE_URL=postgres://… FAULT_PG_DOCKER=placet-proof-pg npm run verify:faults
 *
 * `FAULT_CLIENTS` agents (32 par défaut) bouclent « autoriser puis exécuter » pendant
 * que trois pannes sont provoquées, l'une après l'autre :
 *
 *   1. LE FOURNISSEUR RALENTIT, PUIS NE RÉPOND PLUS. Un relais intercalé devant le
 *      fournisseur simulé retarde chaque appel de 2 s, puis les retient sans jamais
 *      répondre. `OATHRION_MCP_TIMEOUT_MS` est posé à 4 s.
 *   2. LE PROCESSUS EST TUÉ NET (`SIGKILL`) en pleine charge, puis relancé sur la même base.
 *   3. LA BASE EST COUPÉE 15 s (`docker stop` puis `docker start`), seulement si
 *      `FAULT_PG_DOCKER` nomme le conteneur : ce banc n'arrête jamais une base que
 *      personne n'a nommée. Sans lui, la panne est SAUTÉE et dite, jamais comptée réussie.
 *
 * Après chaque panne, l'intégrité est lue DANS LA BASE et chez le fournisseur, pas dans
 * les réponses d'Oathrion :
 *
 *   · aucune autorisation n'est exécutée deux fois ;
 *   · chaque autorisation consommée a son reçu — sauf, après un `SIGKILL`, celles qui
 *     étaient EN VOL au moment exact de la mort : celles-là, aucun logiciel ne peut les
 *     enregistrer. Elles doivent être bornées par le nombre d'agents et VISIBLES
 *     (`GET /api/actions/receipts/verify` → `consumedWithoutReceipt`) ;
 *   · chaque appel qui a réellement agi chez le fournisseur a un reçu « réussi », aux
 *     mêmes exceptions près ;
 *   · la chaîne de reçus se vérifie de bout en bout ;
 *   · le service revient seul, et accepte de nouveau des exécutions.
 *
 * Codes de sortie : 0 tout tient · 1 une propriété ne tient pas · 2 impossible à monter.
 */

import { spawn, execFileSync, type ChildProcessByStdio } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { baseUrl, createThrowawayDatabase, productionPostgresEnv, redactUrl, type ThrowawayDatabase } from "./lib/throwaway-postgres";
import { startExampleMcpServer, type ExampleMcpServer } from "../examples/mcp-server/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5295;
const BASE = `http://127.0.0.1:${PORT}`;
const DEST = "local-fixture";
const CLIENTS = Math.max(1, Math.min(512, Number(process.env.FAULT_CLIENTS ?? "32")));
const DOCKER = process.env.FAULT_PG_DOCKER?.trim() || null;
const MCP_TIMEOUT_MS = 4_000;

const SESSION_SECRET = `faults-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const EMAIL = "admin@pannes.test";
const PASSWORD = `faults-${Math.random().toString(36).slice(2)}-pw-0123`;

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
const clock = () => new Date().toISOString().slice(11, 19);

interface Res { status: number; body: Record<string, unknown> }
async function call(pathname: string, init: { method?: string; token?: string; json?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: {} };
  }
}

/* ------------------------------------------------------------------ le relais */

/**
 * Un relais devant le fournisseur simulé, pour le ralentir ou le rendre muet SANS
 * toucher au fournisseur : ce qu'il a réellement exécuté reste compté par lui seul.
 */
type ProviderMode = { kind: "normal" } | { kind: "slow"; ms: number } | { kind: "hang" };
let providerMode: ProviderMode = { kind: "normal" };
const held: ServerResponse[] = [];

async function startRelay(target: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const mode = providerMode;
        if (mode.kind === "hang") {
          held.push(res);
          return;
        }
        if (mode.kind === "slow") await sleep(mode.ms);
        try {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers[k] = v;
          }
          const upstream = await fetch(new URL(req.url ?? "/", target), {
            method: req.method,
            headers,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          });
          const out = Buffer.from(await upstream.arrayBuffer());
          const responseHeaders: Record<string, string> = {};
          upstream.headers.forEach((v, k) => {
            if (!["content-length", "transfer-encoding", "connection", "content-encoding"].includes(k)) responseHeaders[k] = v;
          });
          res.writeHead(upstream.status, responseHeaders);
          res.end(out);
        } catch {
          res.writeHead(502).end();
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: async () => {
      for (const r of held.splice(0)) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/* ------------------------------------------------------------------ les alertes */

/** Le webhook de l'exploitant, joué en local : on y attend l'alerte « actions sans reçu ». */
const alerts: { type: string; grants: string[] }[] = [];
async function startAlertSink(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      try {
        const event = JSON.parse(raw) as { type?: string; data?: { grants?: { grantId?: string }[] } };
        alerts.push({ type: String(event.type), grants: (event.data?.grants ?? []).map((g) => String(g.grantId)) });
      } catch {
        alerts.push({ type: "illisible", grants: [] });
      }
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/alertes`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/* ------------------------------------------------------------------ le trafic */

interface Tally { accepted: number; refusedSafe: number; lost: number; other: Record<string, number> }

/**
 * Les agents. Une réponse 503 (débordé, base indisponible) et une connexion coupée
 * (processus tué) ne sont pas des erreurs de ce banc : ce sont les réponses attendues
 * d'une panne. Ce qui compte est ce que la base et le fournisseur disent après.
 */
async function traffic(token: string, untilMs: number, tally: Tally): Promise<void> {
  const intent = () => ({ action: "stripe.refund", destinationId: DEST, arguments: { customer: "cus_panne", amount: 1, currency: "EUR" } });
  const note = (label: string) => (tally.other[label] = (tally.other[label] ?? 0) + 1);
  const worker = async () => {
    while (Date.now() < untilMs) {
      const decision = await call("/api/actions/authorize", { token, json: intent() });
      if (decision.status === 0) { tally.lost += 1; await sleep(250); continue; }
      if (decision.status === 503) { tally.refusedSafe += 1; await sleep(500); continue; }
      if (decision.status !== 200 || decision.body.decision !== "ALLOW") { note(`authorize ${String(decision.status)}`); await sleep(250); continue; }
      const run = await call("/api/actions/execute", { token, json: { ...intent(), grantId: String(decision.body.grantId ?? "") } });
      if (run.status === 200) tally.accepted += 1;
      else if (run.status === 0) { tally.lost += 1; await sleep(250); }
      else if (run.status === 503) { tally.refusedSafe += 1; await sleep(500); }
      else note(`execute ${String(run.status)}`);
    }
  };
  await Promise.all(Array.from({ length: CLIENTS }, () => worker()));
}

/* ------------------------------------------------------------------ l'intégrité */

interface Integrity {
  consumed: number;
  receipts: number;
  succeeded: number;
  distinctGrants: number;
  consumedWithoutReceipt: number;
  providerExecuted: number;
  chainOk: boolean;
  chainEntries: number;
  reportedConsumedWithoutReceipt: number | null;
}

async function integrity(pool: Pool, tools: ExampleMcpServer, admin: string): Promise<Integrity> {
  const row = (
    await pool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM action_grants WHERE consumed_at IS NOT NULL) AS consumed,
              (SELECT count(*) FROM action_receipts) AS receipts,
              (SELECT count(*) FROM action_receipts WHERE outcome = 'succeeded') AS succeeded,
              (SELECT count(DISTINCT grant_id) FROM action_receipts) AS distinct_grants,
              (SELECT count(*) FROM action_grants g WHERE g.consumed_at IS NOT NULL AND NOT EXISTS
                 (SELECT 1 FROM action_receipts r WHERE r.organization_id = g.organization_id AND r.grant_id = g.id)) AS orphans`,
    )
  ).rows[0]!;
  const verdict = await call("/api/actions/receipts/verify", { token: admin });
  const reported = verdict.body.consumedWithoutReceipt;
  return {
    consumed: Number(row.consumed),
    receipts: Number(row.receipts),
    succeeded: Number(row.succeeded),
    distinctGrants: Number(row.distinct_grants),
    consumedWithoutReceipt: Number(row.orphans),
    providerExecuted: tools.executedCount(),
    chainOk: verdict.body.ok === true,
    chainEntries: Number(verdict.body.entries ?? -1),
    reportedConsumedWithoutReceipt: typeof reported === "number" ? reported : null,
  };
}

/**
 * `baseline` : les autorisations sans reçu laissées par les pannes PRÉCÉDENTES (un
 * `SIGKILL` en laisse, et c'est voulu qu'elles restent visibles) ; `allowedNew` : ce que
 * CETTE panne a le droit d'en ajouter.
 */
function judge(label: string, state: Integrity, baseline: number, allowedNew: number): number {
  const allowedOrphans = baseline + allowedNew;
  record(`${label} : aucune autorisation exécutée deux fois`, state.distinctGrants === state.receipts, `${String(state.receipts)} reçus · ${String(state.distinctGrants)} autorisations distinctes`);
  record(
    `${label} : chaque autorisation consommée a son reçu${allowedNew > 0 ? ` (hors celles en vol à la mort, ≤ ${String(allowedNew)})` : ""}`,
    state.consumedWithoutReceipt <= allowedOrphans,
    `${String(state.consumed)} consommées · ${String(state.receipts)} reçus · ${String(state.consumedWithoutReceipt - baseline)} nouvelle(s) sans reçu` +
      (baseline > 0 ? ` (+ ${String(baseline)} des pannes précédentes)` : ""),
  );
  const providerGap = state.providerExecuted - state.succeeded;
  record(
    `${label} : chaque action réellement faite chez le fournisseur a un reçu « réussi »`,
    providerGap >= 0 && providerGap <= state.consumedWithoutReceipt,
    `${String(state.providerExecuted)} faites chez le fournisseur · ${String(state.succeeded)} reçus réussis`,
  );
  record(
    `${label} : les autorisations sans reçu sont VISIBLES par l'API`,
    state.reportedConsumedWithoutReceipt === state.consumedWithoutReceipt,
    `verify rapporte ${String(state.reportedConsumedWithoutReceipt)} · la base en compte ${String(state.consumedWithoutReceipt)}`,
  );
  record(`${label} : la chaîne de reçus se vérifie`, state.chainOk && state.chainEntries === state.receipts, `${String(state.chainEntries)} entrées`);
  return state.consumedWithoutReceipt;
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<number> {
  console.log("OATHRION — BANC DE PANNES : CE QUI RESTE VRAI QUAND TOUT CASSE SOUS LA CHARGE");
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
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  let sink: Awaited<ReturnType<typeof startAlertSink>> | undefined;
  /** Les autorisations laissées sans reçu par le `SIGKILL` : celles que l'alerte doit nommer. */
  let killOrphans: string[] = [];
  let child: Child | undefined;
  let pool: Pool | undefined;
  let log = "";
  let patienceLines = 0;

  const launch = async (): Promise<boolean> => {
    child = spawn("node", [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...productionPostgresEnv(db!.url),
        OATHRION_DB: undefined,
        ARIA_DB: undefined,
        PORT: String(PORT),
        OATHRION_SESSION_SECRET: SESSION_SECRET,
        OATHRION_API_KEYS: "",
        OATHRION_CONSOLE_USERS: `Pannes/${EMAIL}:admin:${PASSWORD}`,
        OATHRION_SEED: "",
        OATHRION_LOCAL_MCP_URL: relay!.url,
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
        OATHRION_MCP_TIMEOUT_MS: String(MCP_TIMEOUT_MS),
        /*
         * L'alerte des actions sans reçu, rendue observable en quelques minutes : la
         * recherche toutes les 60 s (le minimum), une patience du reçu de 30 s — plus que les
         * 15 s de coupure de la base, sinon la coupure fabriquerait de faux trous —, donc un
         * délai de grâce de 4 + 30 + 30 = 64 s. Le webhook est le récepteur local ci-dessus.
         */
        OATHRION_RECEIPT_GAP_INTERVAL_MS: "60000",
        OATHRION_RECEIPT_PATIENCE_MS: "30000",
        OATHRION_RECONCILE_INTERVAL_MS: "0",
        OATHRION_WEBHOOK_URL: sink!.url,
        OATHRION_WEBHOOK_ALLOW_PRIVATE: "true",
        RATE_LIMIT_DECISION: "10000000",
        RATE_LIMIT_WRITE: "10000000",
        RATE_LIMIT_APPROVAL: "10000000",
        OATHRION_QUOTAS: "default:executions=100000000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    const keep = (c: Buffer) => {
      const text = c.toString();
      /* `FAULT_SERVER_LOG=<fichier>` : le journal complet du serveur, pour diagnostiquer une mort. */
      if (process.env.FAULT_SERVER_LOG) appendFileSync(process.env.FAULT_SERVER_LOG, text);
      patienceLines += (text.match(/le reçu de axn_[0-9a-f]+ sera réessayé/g) ?? []).length;
      log += text;
      if (log.length > 4_000_000) log = log.slice(-2_000_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    for (let i = 0; i < 240; i += 1) {
      if (child.exitCode !== null) return false;
      if ((await call("/api/ready")).status === 200) return true;
      await sleep(250);
    }
    return false;
  };

  try {
    section(`MISE EN PLACE — ${String(CLIENTS)} agents, délai du fournisseur ${String(MCP_TIMEOUT_MS)} ms`);
    db = await createThrowawayDatabase("oathrion_faults");
    tools = await startExampleMcpServer();
    relay = await startRelay(tools.url);
    sink = await startAlertSink();
    pool = new Pool({ connectionString: db.url, max: 1 });
    pool.on("error", () => undefined);
    console.log(`Base : ${db.name} sur ${redactUrl(baseUrl())}`);
    record("le bundle démarre", await launch());

    const admin = String((await call("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
    await call("/api/agents", {
      token: admin,
      json: {
        id: "agt_faults", name: "Agent des pannes", description: "banc", provider: "openai", model: "gpt-4o", status: "active", owner: "ops",
        mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
        permissions: [], policyIds: [], tags: [],
      },
    });
    await call("/api/action-policies", {
      token: admin, method: "PUT",
      json: { id: "apol_faults", name: "pannes", action: "stripe.refund", destinationId: DEST, effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
    });
    const token = String((await call("/api/keys", { token: admin, json: { name: "clé des pannes", role: "operator", agentId: "agt_faults" } })).body.secret ?? "");
    record("agent, règle et credential en place", token !== "" && admin !== "");
    if (token === "" || admin === "") return 2;

    let orphans = 0;

    /* ---------------------------------------------------- 1. le fournisseur */
    section("1. LE FOURNISSEUR RALENTIT (2 s), PUIS NE RÉPOND PLUS");
    {
      const tally: Tally = { accepted: 0, refusedSafe: 0, lost: 0, other: {} };
      const run = traffic(token, Date.now() + 36_000, tally);
      await sleep(6_000);
      providerMode = { kind: "slow", ms: 2_000 };
      console.log(`  ${clock()} fournisseur ralenti à 2 s`);
      await sleep(10_000);
      providerMode = { kind: "hang" };
      console.log(`  ${clock()} fournisseur muet`);
      await sleep(10_000);
      providerMode = { kind: "normal" };
      for (const r of held.splice(0)) r.destroy();
      console.log(`  ${clock()} fournisseur rétabli`);
      await run;
      console.log(`  exécutions acceptées ${String(tally.accepted)} · 503 ${String(tally.refusedSafe)} · autres ${JSON.stringify(tally.other)}`);
      const failed = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM action_receipts WHERE outcome = 'failed'`)).rows[0]!.n;
      record("un appel resté sans réponse finit en reçu « échoué », pas en attente sans fin", Number(failed) > 0, `${failed} reçus « échoué »`);
      orphans = judge("fournisseur", await integrity(pool, tools, admin), orphans, 0);
    }

    /* ---------------------------------------------------- 2. le processus tué */
    section("2. LE PROCESSUS EST TUÉ NET (SIGKILL), PUIS RELANCÉ");
    {
      const tally: Tally = { accepted: 0, refusedSafe: 0, lost: 0, other: {} };
      const run = traffic(token, Date.now() + 30_000, tally);
      await sleep(8_000);
      const before = tally.accepted;
      child!.kill("SIGKILL");
      await new Promise((r) => child!.once("exit", r));
      console.log(`  ${clock()} processus tué (${String(before)} exécutions acceptées avant)`);
      const back = await launch();
      console.log(`  ${clock()} processus relancé : ${back ? "prêt" : "PAS PRÊT"}`);
      record("le service relancé redevient prêt", back);
      await run;
      console.log(`  exécutions acceptées ${String(tally.accepted)} · connexions perdues ${String(tally.lost)} · 503 ${String(tally.refusedSafe)} · autres ${JSON.stringify(tally.other)}`);
      record("le service relancé accepte de nouveau des exécutions", tally.accepted > before, `${String(tally.accepted - before)} après la relance`);
      orphans = judge("processus tué", await integrity(pool, tools, admin), orphans, CLIENTS);
      killOrphans = (
        await pool.query<{ id: string }>(
          `SELECT g.id FROM action_grants g WHERE g.consumed_at IS NOT NULL AND NOT EXISTS
             (SELECT 1 FROM action_receipts r WHERE r.organization_id = g.organization_id AND r.grant_id = g.id)`,
        )
      ).rows.map((r) => r.id);
    }

    /* ---------------------------------------------------- 3. la base coupée */
    section("3. LA BASE EST COUPÉE 15 s");
    if (DOCKER === null) {
      console.log("  SAUTÉE : FAULT_PG_DOCKER ne nomme aucun conteneur. Ce banc n'arrête pas une base que personne n'a nommée.");
    } else {
      const tally: Tally = { accepted: 0, refusedSafe: 0, lost: 0, other: {} };
      const run = traffic(token, Date.now() + 50_000, tally);
      await sleep(10_000);
      const before = tally.accepted;
      execFileSync("docker", ["stop", DOCKER], { stdio: "ignore" });
      console.log(`  ${clock()} base arrêtée`);
      await sleep(15_000);
      execFileSync("docker", ["start", DOCKER], { stdio: "ignore" });
      console.log(`  ${clock()} base relancée`);
      await run;
      console.log(`  exécutions acceptées ${String(tally.accepted)} · 503 ${String(tally.refusedSafe)} · connexions perdues ${String(tally.lost)} · autres ${JSON.stringify(tally.other)}`);
      record("le MÊME processus est resté vivant", child!.exitCode === null);
      record("il accepte de nouveau des exécutions après le retour de la base", tally.accepted > before, `${String(tally.accepted - before)} après la coupure`);
      /* Le pool de vérification a perdu sa connexion avec la base. */
      await pool.end().catch(() => undefined);
      pool = new Pool({ connectionString: db.url, max: 1 });
      pool.on("error", () => undefined);
      orphans = judge("base coupée", await integrity(pool, tools, admin), orphans, 0);
    }

    /*
     * L'ALERTE DES ACTIONS SANS REÇU (`server/authority/receipt-gaps.ts`) : elle doit
     * arriver au webhook, nommer exactement les autorisations laissées par le `SIGKILL`, et
     * une seule fois.
     */
    section("4. L'ALERTE DES ACTIONS SANS REÇU");
    if (killOrphans.length === 0) {
      console.log("  SAUTÉE : le SIGKILL n'a laissé aucune autorisation sans reçu cette fois-ci.");
    } else {
      for (let i = 0; i < 120 && !alerts.some((a) => a.type === "receipt.gap"); i += 1) await sleep(2_000);
      await sleep(65_000);
      const gapAlerts = alerts.filter((a) => a.type === "receipt.gap");
      const named = gapAlerts.flatMap((a) => a.grants);
      console.log(`  ${clock()} ${String(gapAlerts.length)} alerte(s) « receipt.gap » reçue(s), ${String(named.length)} autorisation(s) nommée(s)`);
      record(
        "l'alerte arrive et nomme exactement les autorisations sans reçu",
        gapAlerts.length > 0 && [...named].sort().join() === [...killOrphans].sort().join(),
        `${String(killOrphans.length)} sans reçu · ${String(named.length)} nommée(s)`,
      );
      record("chacune n'est signalée qu'une fois, même après un passage de plus", new Set(named).size === named.length, `${String(gapAlerts.length)} alerte(s)`);
    }

    /*
     * La patience du reçu (`EnforcementPoint.writeReceiptPatiently`) a-t-elle SERVI ? Sans
     * ce compte, « 0 sans reçu après la coupure » pourrait vouloir dire qu'aucune
     * exécution n'était en vol au moment de la coupure.
     */
    const waited = patienceLines;
    const gaveUp = (log.match(/RECEIPT NOT WRITTEN/g) ?? []).length;
    console.log(`\n  patience du reçu : ${String(waited)} reçu(s) réessayé(s) sur base indisponible · ${String(gaveUp)} abandon(s)`);
    if (DOCKER !== null) record("la patience du reçu a servi pendant la coupure, sans abandon", waited > 0 && gaveUp === 0, `${String(waited)} réessayé(s) · ${String(gaveUp)} abandon(s)`);

    record("aucun secret dans la sortie du processus", !log.includes(SESSION_SECRET) && !log.includes(PASSWORD) && !log.includes(token));
    return 0;
  } finally {
    if (child && child.exitCode === null) {
      const c = child;
      const exited = new Promise((r) => c.once("exit", r));
      c.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
    }
    await pool?.end().catch(() => undefined);
    await relay?.close();
    await sink?.close();
    await tools?.close();
    await db?.dispose();
  }
}

main()
  .then((code) => {
    const failed = checks.filter((c) => !c.ok);
    if (checks.length > 0) {
      console.log(`\n${"=".repeat(72)}`);
      console.log(`${String(checks.length - failed.length)}/${String(checks.length)} contrôles passés`);
      console.log("=".repeat(72));
    }
    return code === 2 ? 2 : code === 0 && failed.length === 0 ? 0 : 1;
  })
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(2);
  });
