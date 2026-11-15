/**
 * MULTI-TENANT PRODUCTION PROOF — two companies on one Oathrion deployment.
 *
 * What this proves, with the shipped bundle (`dist/index.cjs`), NODE_ENV=production,
 * every plane on a real PostgreSQL server, and a real MCP downstream whose received
 * calls are COUNTED:
 *
 *   1. two organizations operate simultaneously on one instance;
 *   2. each has its own users, agents (even with the SAME id), credentials, policies,
 *      grants, approvals, receipts and audit;
 *   3. organization B, with a fully privileged admin and its own agent credential,
 *      tries to read / modify / delete / use every object of A — and is refused, with
 *      zero downstream effect;
 *   4. the three action scenarios on the enforced path:
 *        A  ALLOW              → tool called once → receipt → audit
 *        B  APPROVAL_REQUIRED  → tool NOT called → human approval → grant → tool called
 *                                EXACTLY once → replay refused
 *        C  BLOCK              → no grant → tool never called
 *   5. grant misuse: replay, wrong agent, wrong tenant, wrong action hash, wrong
 *      destination — all refused, downstream unchanged;
 *   6. the rows really are in PostgreSQL, partitioned by organization_id.
 *
 * Exit codes: 0 every check passed · 1 a check failed · 2 could not be set up
 * (no bundle, no PostgreSQL) — never a silent pass.
 *
 *   npm run build
 *   DATABASE_URL=postgres://user:pass@host:5432/postgres npm run e2e:multitenant
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";

import {
  baseUrl,
  containerUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";
import { startMockDownstream, type MockDownstream } from "../server/mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../server/mcp-local/local-mcp-server";
import { exportTenant } from "./lib/tenant-export";
import { purgeTenant, PurgeRefused } from "./lib/tenant-purge";
import { LATEST_VERSION } from "../server/migrations";

/**
 * LES OUTILS CLIENTS POSTGRESQL, PAR LA MÊME INDIRECTION QUE LES SCRIPTS DE DÉPLOIEMENT.
 *
 * ## Le défaut corrigé
 *
 * Ce banc appelait `spawnSync("pg_dump", …)` directement. Or le dépôt a déjà une
 * convention pour cela — `deploy/scripts/pg-run.sh` et `OATHRION_PG_CONTAINER` — parce que
 * ni l'image Oathrion (`node:20-slim`) ni l'hôte d'un `docker compose up` ne portent
 * `postgresql-client`. Les deux vérifications de sauvegarde échouaient donc sur
 * « pg_dump : commande introuvable », et c'est exactement le défaut « à moitié fait » que
 * le commentaire de `pg-run.sh` décrit pour `backup.sh`.
 *
 * ## La subtilité, répétée ici parce qu'elle se paie
 *
 * Avec un conteneur, l'URL doit être joignable DEPUIS L'INTÉRIEUR : `127.0.0.1:5432`
 * désigne alors le serveur lui-même, et le port publié sur l'hôte n'y existe pas. On
 * passe donc l'URL telle quelle et on laisse l'exploitant la choisir — l'adresse du
 * conteneur sur le pont Docker est joignable des DEUX côtés, et c'est la seule qui l'est.
 */
function pgDump(url: string, file: string): { status: number | null; stderr: string } {
  const container = process.env.OATHRION_PG_CONTAINER?.trim() ?? "";
  const argv = ["pg_dump", "-Fc", "--no-owner", "-d", url];
  if (!container) {
    const run = spawnSync(argv[0]!, [...argv.slice(1), "-f", file], { encoding: "utf8" });
    return { status: run.status, stderr: run.stderr ?? "" };
  }
  /*
   * PAR STDOUT, ET NON PAR `-f`.
   *
   * `-f` fait écrire le fichier là où `pg_dump` TOURNE — donc dans le conteneur, où le
   * banc ne peut pas le relire. C'est la deuxième moitié du même piège que l'URL : avec
   * un client dans un conteneur, tout chemin de fichier et toute adresse réseau
   * changent de sens. Le flux standard est la seule frontière qui reste commune.
   */
  /*
   * L'URL vue DE L'HÔTE (127.0.0.1:<port publié>) ne désigne rien à l'intérieur du
   * conteneur, où PostgreSQL écoute sur 5432 : `pg_dump` échouait, aucun fichier n'était
   * écrit, et la suite plantait sur ENOENT. Même réécriture que `verify:dr`.
   */
  const run = spawnSync("docker", ["exec", "-i", container, ...argv.slice(0, -1), containerUrl(url)], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer",
  });
  if (run.status === 0 && run.stdout) writeFileSync(file, run.stdout);
  return { status: run.status, stderr: run.stderr?.toString("utf8") ?? "" };
}

function pgRestore(url: string, file: string): { status: number | null; stderr: string } {
  const container = process.env.OATHRION_PG_CONTAINER?.trim() ?? "";
  const argv = ["pg_restore", "--no-owner", "--exit-on-error", "-d", url];
  if (!container) {
    const run = spawnSync(argv[0]!, [...argv.slice(1), file], { encoding: "utf8" });
    return { status: run.status, stderr: run.stderr ?? "" };
  }
  /* Par stdin, pour la même raison : le fichier vit sur l'hôte, le client dans l'image. */
  const run = spawnSync("docker", ["exec", "-i", container, ...argv.slice(0, -1), containerUrl(url)], {
    input: readFileSync(file),
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer",
  });
  return { status: run.status, stderr: run.stderr?.toString("utf8") ?? "" };
}


const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5231;
const BASE = `http://127.0.0.1:${PORT}`;

/* Throwaway credentials for this run only (never written anywhere). */
const SESSION_SECRET = `mt-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const T = {
  A: { name: "Alpha Industries", email: "admin@alpha.test", password: `alpha-${Math.random().toString(36).slice(2)}-pw-0123` },
  B: { name: "Bravo Logistics", email: "admin@bravo.test", password: `bravo-${Math.random().toString(36).slice(2)}-pw-0123` },
};
/*
 * Les identifiants ne sont plus devinables depuis le nom (migration 18) : ils sont
 * opaques et n'existent que dans le registre. Ce harnais les apprend donc comme un
 * exploitant le fait — en démarrant une fois, en lisant l'identifiant dans la session
 * de l'administrateur du locataire, puis en configurant `OATHRION_DESTINATIONS` avec ce
 * qu'il a lu et en redémarrant. C'est une étape de plus qu'avant, et c'est le coût
 * réel de la correction : il est reproduit ici plutôt que contourné.
 */
let ORG_A = "";
let ORG_B = "";
const SHARED_AGENT = "agt_payments"; // the SAME id in both tenants, on purpose
const A_ONLY_AGENT = "agt_alpha_treasury";
const DEST = "local-fixture";

type Child = ChildProcessByStdio<null, Readable, Readable>;
interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 70 - label.length))}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res { status: number; body: any }
async function call(pathname: string, init: { method?: string; token?: string; json?: unknown } = {}): Promise<Res> {
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
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `destinations: null` démarre sans aucune destination — l'état du premier démarrage,
 * quand les identifiants opaques des deux locataires ne sont pas encore connus. Un
 * `OATHRION_DESTINATIONS` absent n'autorise rien, ce qui est la bonne valeur par défaut
 * pour cette phase : aucune action ne peut être dépêchée avant que l'exploitant ait
 * nommé les destinataires.
 */
function boot(
  databaseUrl: string,
  mcpUrl: string,
  destinations: { orgA: string; orgB: string } | null,
): { child: Child; output: () => string } {
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(databaseUrl),
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: "",
      OATHRION_CONSOLE_USERS: [
        `${T.A.name}/${T.A.email}:admin:${T.A.password}`,
        `${T.B.name}/${T.B.email}:admin:${T.B.password}`,
      ].join(","),
      OATHRION_SEED: "",
      /*
       * La fixture loopback n'est posée QU'EN phase 2. Depuis le point 5 du chantier 1,
       * `OATHRION_LOCAL_MCP_URL` doit déclarer ses locataires en production
       * (`OATHRION_LOCAL_MCP_ORGANIZATIONS`) — sans quoi elle enregistrerait une destination
       * partagée par tous. En phase 1 les identifiants ne sont pas encore connus, et la
       * phase 1 n'en a pas besoin : elle ne fait que lire les identifiants. Un déploiement
       * neuf sans aucune destination est d'ailleurs l'état réel au premier démarrage.
       */
      OATHRION_LOCAL_MCP_URL: destinations ? mcpUrl : undefined,
      OATHRION_LOCAL_MCP_ORGANIZATIONS: destinations
        ? `${destinations.orgA},${destinations.orgB}`
        : undefined,
      // One tenant-scoped destination per company. Public, allowlisted, never contacted:
      // they exist to prove that one tenant cannot target the other's destination.
      OATHRION_DESTINATIONS: destinations
        ? JSON.stringify([
            { id: "alpha-erp", url: "https://mcp.alpha.example.com", label: "Alpha ERP", organizations: [destinations.orgA] },
            { id: "bravo-erp", url: "https://mcp.bravo.example.com", label: "Bravo ERP", organizations: [destinations.orgB] },
          ])
        : undefined,
      OATHRION_MCP_ALLOWED_DESTINATIONS: "https://mcp.alpha.example.com,https://mcp.bravo.example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as Child;
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  return { child, output: () => output };
}

async function waitReady(child: Child, timeoutMs = 40_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return `exited with code ${child.exitCode}`;
    const r = await call("/api/ready");
    if (r.status === 200) return "ready";
    await sleep(250);
  }
  return "timeout";
}

async function stop(child: Child): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000).then(() => child.kill("SIGKILL"))]);
}

/* ------------------------------------------------------------------------ */

const agentBody = (id: string, name: string) => ({
  id,
  name,
  description: "Multi-tenant proof agent",
  provider: "openai",
  model: "gpt-4",
  status: "active",
  owner: "finance",
  mandate: { maxTransactionAmount: 5000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
  permissions: [],
  policyIds: [],
  tags: ["mt"],
});

const rules = [
  { id: "apol_delete_block", name: "Customer deletion is never authorized", action: "customer.delete", effect: "BLOCK", priority: 300 },
  { id: "apol_refund_large", name: "Refunds above 100 need a human", action: "stripe.refund", destinationId: DEST, effect: "APPROVAL_REQUIRED", constraints: [{ field: "amount", op: "gt", value: 100 }], priority: 200 },
  { id: "apol_refund_small", name: "Small refunds are routine", action: "stripe.refund", destinationId: DEST, effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 },
];

const refund = (amount: number, extra: Record<string, unknown> = {}) => ({
  action: "stripe.refund",
  destinationId: DEST,
  arguments: { customer: "cus_42", amount, currency: "EUR" },
  ...extra,
});

interface Tenant {
  org: string;
  admin: string; // console session token
  agentKey: string; // key bound to SHARED_AGENT
  agentKeyId: string;
}

/**
 * Lit l'identifiant opaque d'un locataire depuis la session de son administrateur.
 * Aucune route ne liste les organisations — et c'est volontaire : un endpoint qui le
 * ferait livrerait à chaque client le nom de tous les autres.
 */
async function learnOrganizationId(label: "A" | "B"): Promise<string> {
  const login = await call("/api/auth/login", { json: { email: T[label].email, password: T[label].password } });
  const session = await call("/api/auth/session", { token: login.body?.token ?? "" });
  const id = (session.body as { identity?: { organizationId?: string } })?.identity?.organizationId ?? "";
  record(`${label}: son identifiant d'organisation se lit dans sa session`, /^org_[a-z0-9]{20}$/.test(id), id || `status ${session.status}`);
  return id;
}

async function setupTenant(label: "A" | "B", org: string): Promise<Tenant> {
  const login = await call("/api/auth/login", { json: { email: T[label].email, password: T[label].password } });
  const admin = login.body?.token ?? "";
  record(`${label}: admin signs in to its own organization`, login.status === 200 && admin !== "", `status ${login.status}`);
  const session = await call("/api/auth/session", { token: admin });
  record(`${label}: the session is scoped to ${org}`, JSON.stringify(session.body).includes(org), `status ${session.status}`);

  const agent = await call("/api/agents", { token: admin, json: agentBody(SHARED_AGENT, `${label} payments`) });
  record(`${label}: creates agent "${SHARED_AGENT}" (same id in both tenants)`, agent.status === 201 || agent.status === 200, `status ${agent.status}`);

  for (const rule of rules) {
    const r = await call("/api/action-policies", { method: "PUT", token: admin, json: rule });
    if (r.status !== 200) record(`${label}: writes rule ${rule.id}`, false, `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  const listed = await call("/api/action-policies", { token: admin });
  record(`${label}: writes its 3 action rules (same ids as the other tenant)`, listed.body?.policies?.length === 3, `${listed.body?.policies?.length} rules`);

  const key = await call("/api/keys", { token: admin, json: { name: `${label} payments agent`, role: "operator", agentId: SHARED_AGENT } });
  record(`${label}: issues a credential bound to its agent`, key.status === 201 && typeof key.body?.secret === "string", `status ${key.status}`);
  return { org, admin, agentKey: key.body?.secret ?? "", agentKeyId: key.body?.key?.id ?? "" };
}

async function main(): Promise<number> {
  console.log("=".repeat(78));
  console.log("Oathrion — MULTI-TENANT PRODUCTION PROOF (bundle, NODE_ENV=production, PostgreSQL)");
  console.log("=".repeat(78));
  if (!existsSync(BUNDLE)) {
    console.error("No bundle at dist/index.cjs. Run `npm run build` first.");
    return 2;
  }

  let db: ThrowawayDatabase;
  try {
    db = await createThrowawayDatabase("oathrion_mt");
    console.log(`Database: ${db.name} on ${redactUrl(baseUrl())}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const mock: MockDownstream = await startMockDownstream();
  const mcp: LocalMcpServer = await startLocalMcpServer(mock.url);
  const refunds = () => mock.receivedOn("/mock/refund").length;
  const deletions = () => mock.receivedOn("/mock/customer/delete").length;
  const pool = new Pool({ connectionString: db.url, max: 2 });
  pool.on("error", () => undefined);

  let booted = boot(db.url, mcp.url, null);
  let restored: ThrowawayDatabase | undefined;
  try {
    section("BOOT — one production instance, PostgreSQL everywhere");
    const ready = await waitReady(booted.child);
    record("the production bundle boots and reports ready", ready === "ready", ready);
    if (ready !== "ready") {
      console.log(booted.output().slice(-3000));
      return 1;
    }
    const version = await pool.query("SELECT max(version) AS v FROM schema_migrations").catch(() => null);
    /*
     * LA VERSION VIENT DU REGISTRE, plus d'un littéral.
     *
     * Cette ligne affirmait `=== 18`. Le schéma est à 23 depuis cinq migrations, donc
     * cette vérification échouait — ce qui veut dire que ce banc n'était plus exécuté,
     * ou que son échec était ignoré. Les deux sont pires que le littéral lui-même.
     *
     * `LATEST_VERSION` est calculé depuis `MIGRATIONS`, donc la prochaine migration
     * n'oblige plus à se souvenir de ce fichier.
     */
    record(
      `the schema in PostgreSQL is at the latest migration (${String(LATEST_VERSION)})`,
      Number(version?.rows[0]?.v) === LATEST_VERSION,
      `version ${version?.rows[0]?.v}`,
    );

    section("IDENTIFIANTS — opaques, appris comme un exploitant les apprend");
    /*
     * Un exploitant ne peut plus calculer l'identifiant d'un locataire : il le lit. La
     * session de l'administrateur est la source disponible aujourd'hui ; l'API
     * d'administration de l'étape 2 du chantier 1 la remplacera.
     */
    ORG_A = await learnOrganizationId("A");
    ORG_B = await learnOrganizationId("B");
    record("A et B ont deux identifiants distincts", ORG_A !== "" && ORG_B !== "" && ORG_A !== ORG_B, `${ORG_A} / ${ORG_B}`);
    record(
      "aucun identifiant ne contient le nom de son entreprise",
      !ORG_A.includes("alpha") && !ORG_B.includes("bravo"),
      `${ORG_A} / ${ORG_B}`,
    );

    /*
     * Redémarrage avec les destinations enfin nommables. C'est l'étape supplémentaire
     * que la migration 18 impose à un exploitant, et elle est ici pour qu'on la voie.
     */
    await stop(booted.child);
    booted = boot(db.url, mcp.url, { orgA: ORG_A, orgB: ORG_B });
    const rebooted = await waitReady(booted.child);
    record("l'instance redémarre avec les destinations des deux locataires", rebooted === "ready", rebooted);
    if (rebooted !== "ready") {
      console.log(booted.output().slice(-3000));
      return 1;
    }

    section("TENANTS — two companies set themselves up, independently");
    const A = await setupTenant("A", ORG_A);
    const B = await setupTenant("B", ORG_B);
    const aOnly = await call("/api/agents", { token: A.admin, json: agentBody(A_ONLY_AGENT, "Alpha treasury") });
    record("A: creates a second agent only A has", aOnly.status === 201 || aOnly.status === 200, `status ${aOnly.status}`);
    const aTreasuryKey = await call("/api/keys", { token: A.admin, json: { name: "A treasury", role: "operator", agentId: A_ONLY_AGENT } });
    const aTreasury = aTreasuryKey.body?.secret ?? "";

    section("SCENARIO A — ALLOW: tool called once, receipt, audit");
    let before = refunds();
    const allow = await call("/api/actions/authorize", { token: A.agentKey, json: refund(40) });
    record("A: a 40 EUR refund is ALLOWed with an issued grant", allow.body?.decision === "ALLOW" && allow.body?.grantState === "issued", `decision ${allow.body?.decision}`);
    record("authorization alone calls nothing downstream", refunds() === before, `${refunds() - before} calls`);
    const exec = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(40), grantId: allow.body?.grantId } });
    record("A: executing the grant calls the tool exactly once and returns a receipt", exec.status === 200 && exec.body?.executed === true && refunds() === before + 1, `status ${exec.status}, calls +${refunds() - before}`);
    const receiptA = exec.body?.receiptId as string;
    const receiptRead = await call(`/api/actions/receipts/${receiptA}`, { token: A.admin });
    record("A: the receipt is readable by A, with outcome succeeded", receiptRead.status === 200 && receiptRead.body?.receipt?.outcome === "succeeded", `status ${receiptRead.status}`);

    section("SCENARIO B — APPROVAL_REQUIRED: held, human approves, executed exactly once");
    before = refunds();
    const held = await call("/api/actions/authorize", { token: A.agentKey, json: refund(500) });
    record("A: a 500 EUR refund is APPROVAL_REQUIRED, grant pending", held.body?.decision === "APPROVAL_REQUIRED" && held.body?.grantState === "pending_approval", `decision ${held.body?.decision}`);
    const early = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(500), grantId: held.body?.grantId } });
    record("executing before approval is refused, tool NOT called", early.status === 403 && refunds() === before, `status ${early.status} ${early.body?.code ?? ""}`);
    const bApprove = await call(`/api/actions/grants/${held.body?.grantId}/approve`, { token: B.admin, json: { actionHash: held.body?.actionHash } });
    record("B's admin cannot approve A's held action", bApprove.status >= 400 && bApprove.status < 500, `status ${bApprove.status}`);
    const bReject = await call(`/api/actions/grants/${held.body?.grantId}/reject`, { token: B.admin, json: {} });
    record("B's admin cannot reject A's held action", bReject.status >= 400 && bReject.status < 500, `status ${bReject.status}`);
    const wrongHash = await call(`/api/actions/grants/${held.body?.grantId}/approve`, { token: A.admin, json: { actionHash: "0".repeat(64) } });
    record("an approval naming a different action hash is refused", wrongHash.status >= 400, `status ${wrongHash.status}`);
    const approve = await call(`/api/actions/grants/${held.body?.grantId}/approve`, { token: A.admin, json: { actionHash: held.body?.actionHash } });
    record("A's human admin approves it", approve.status === 200, `status ${approve.status}`);
    const replayApprove = await call(`/api/actions/grants/${held.body?.grantId}/approve`, { token: A.admin, json: { actionHash: held.body?.actionHash } });
    record("the approval cannot be replayed", replayApprove.status >= 400, `status ${replayApprove.status}`);
    const approvedExec = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(500), grantId: held.body?.grantId } });
    record("the approved grant executes: tool called exactly once", approvedExec.status === 200 && refunds() === before + 1, `status ${approvedExec.status}, calls +${refunds() - before}`);
    const replayExec = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(500), grantId: held.body?.grantId } });
    record("replaying the consumed grant is refused, tool not called again", replayExec.status === 403 && refunds() === before + 1, `status ${replayExec.status} ${replayExec.body?.code ?? ""}`);

    section("SCENARIO C — BLOCK: no grant, nothing downstream");
    const delBefore = deletions();
    const block = await call("/api/actions/authorize", { token: A.agentKey, json: { action: "customer.delete", destinationId: DEST, arguments: { customer: "cus_42" } } });
    record("customer.delete is BLOCKed with no grant", block.body?.decision === "BLOCK" && block.body?.grantId === null, `decision ${block.body?.decision}`);
    const blockExec = await call("/api/actions/execute", { token: A.agentKey, json: { action: "customer.delete", destinationId: DEST, arguments: { customer: "cus_42" }, grantId: "grant_forged_0000" } });
    record("executing it with a forged grant id is refused", blockExec.status === 403, `status ${blockExec.status}`);
    const unknownVerb = await call("/api/actions/authorize", { token: A.agentKey, json: { action: "crm.wipe_all", destinationId: DEST, arguments: {} } });
    record("an action no rule names is BLOCKed by default (fail-closed)", unknownVerb.body?.decision === "BLOCK", `decision ${unknownVerb.body?.decision}`);
    record("no deletion ever reached the downstream", deletions() === delBefore, `${deletions() - delBefore} calls`);

    section("GRANT MISUSE — wrong agent, wrong tenant, wrong hash, wrong destination");
    before = refunds();
    const fresh = await call("/api/actions/authorize", { token: A.agentKey, json: refund(30) });
    const g = fresh.body?.grantId;
    const wrongAgent = await call("/api/actions/execute", { token: aTreasury, json: { ...refund(30), grantId: g } });
    record("A's OTHER agent cannot use the grant (wrong agent)", wrongAgent.status === 403, `status ${wrongAgent.status} ${wrongAgent.body?.code ?? ""}`);
    const wrongTenant = await call("/api/actions/execute", { token: B.agentKey, json: { ...refund(30), grantId: g } });
    record("B's agent (same agent id!) cannot use A's grant (wrong tenant)", wrongTenant.status === 403, `status ${wrongTenant.status} ${wrongTenant.body?.code ?? ""}`);
    const wrongAmount = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(31), grantId: g } });
    record("a changed amount is refused (wrong action hash)", wrongAmount.status === 403 && wrongAmount.body?.code === "action_mismatch", `status ${wrongAmount.status} ${wrongAmount.body?.code ?? ""}`);
    const wrongDest = await call("/api/actions/authorize", { token: B.agentKey, json: refund(10, { destinationId: "alpha-erp" }) });
    record("B cannot target A's destination (BLOCK, no grant)", wrongDest.body?.decision === "BLOCK" && wrongDest.body?.grantId === null, `decision ${wrongDest.body?.decision}`);
    record("none of these misuses reached the downstream", refunds() === before, `${refunds() - before} calls`);
    const stillGood = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(30), grantId: g } });
    record("the grant was not burnt by the refusals: A's own agent executes it once", stillGood.status === 200 && refunds() === before + 1, `status ${stillGood.status}`);

    section("ISOLATION — B (full admin) attacks every object of A");
    const bAgents = await call("/api/agents", { token: B.admin });
    const bSeesOnlyOwn = Array.isArray(bAgents.body) && bAgents.body.every((a: any) => a.id !== A_ONLY_AGENT);
    record("B → list agents: A's agents are absent", bSeesOnlyOwn, `${Array.isArray(bAgents.body) ? bAgents.body.length : "?"} agents`);
    const bShared = await call(`/api/agents/${SHARED_AGENT}`, { token: B.admin });
    record(`B → read "${SHARED_AGENT}": B gets its OWN agent, not A's`, bShared.status === 200 && bShared.body?.name === "B payments", `name ${bShared.body?.name}`);
    record("B → read A's agent: 404", (await call(`/api/agents/${A_ONLY_AGENT}`, { token: B.admin })).status === 404);
    const bPatch = await call(`/api/agents/${A_ONLY_AGENT}`, { method: "PATCH", token: B.admin, json: { status: "paused" } });
    record("B → modify A's agent: refused", bPatch.status === 404, `status ${bPatch.status}`);
    const aAfter = await call(`/api/agents/${A_ONLY_AGENT}`, { token: A.admin });
    record("A's agent is unchanged", aAfter.body?.status === "active", `status ${aAfter.body?.status}`);
    const bBind = await call("/api/keys", { token: B.admin, json: { name: "steal", role: "operator", agentId: A_ONLY_AGENT } });
    record("B → issue a credential bound to A's agent: refused", bBind.status === 400, `status ${bBind.status}`);
    const bKeys = await call("/api/keys", { token: B.admin });
    record("B → list credentials: A's credentials are absent", !JSON.stringify(bKeys.body).includes(A.agentKeyId), `${bKeys.body?.total} keys`);
    const bRevoke = await call(`/api/keys/${A.agentKeyId}`, { method: "DELETE", token: B.admin, json: {} });
    record("B → delete (revoke) A's credential: 404", bRevoke.status === 404, `status ${bRevoke.status}`);
    const aKeyStill = await call("/api/actions/authorize", { token: A.agentKey, json: refund(1) });
    record("A's credential still works after B's attempt", aKeyStill.body?.decision === "ALLOW", `decision ${aKeyStill.body?.decision}`);
    const bRules = await call("/api/action-policies", { token: B.admin });
    record("B → read policies: only B's own 3 rules", bRules.body?.policies?.length === 3, `${bRules.body?.policies?.length} rules`);
    const bOverwrite = await call("/api/action-policies", { method: "PUT", token: B.admin, json: { ...rules[2], effect: "BLOCK" } });
    const aRules = await call("/api/action-policies", { token: A.admin });
    const aSmall = aRules.body?.policies?.find((p: any) => p.id === "apol_refund_small");
    record("B → overwrite a rule with A's id: only B's copy changes", bOverwrite.status === 200 && aSmall?.effect === "ALLOW", `A's effect ${aSmall?.effect}`);
    // B restores its own rule, so B's later traffic is judged by B's intended policy.
    await call("/api/action-policies", { method: "PUT", token: B.admin, json: rules[2] });
    record("B → read A's grant: 404", (await call(`/api/actions/grants/${g}`, { token: B.admin })).status === 404);
    record("B → read A's receipt: 404", (await call(`/api/actions/receipts/${receiptA}`, { token: B.admin })).status === 404);
    const bReceipts = await call("/api/actions/receipts", { token: B.admin });
    const aReceipts = await call("/api/actions/receipts", { token: A.admin });
    record("A → its own receipt list contains it (positive control)", JSON.stringify(aReceipts.body).includes(receiptA), `${aReceipts.body?.receipts?.length} receipts`);
    record("B → list receipts: none of A's", !JSON.stringify(bReceipts.body).includes(receiptA), `${bReceipts.body?.receipts?.length} receipts`);
    const bDest = await call("/api/actions/destinations", { token: B.admin });
    const bDestIds = (bDest.body?.destinations ?? []).map((d: any) => d.id);
    record("B → list destinations: A's destination is absent", !bDestIds.includes("alpha-erp") && bDestIds.includes("bravo-erp"), bDestIds.join(","));

    // Legacy decision plane + audit trail
    const decision = await call("/api/decision", { token: A.agentKey, json: { agentId: SHARED_AGENT, action: "purchase", target: "supplier-1", metadata: { amount: 10, currency: "EUR" }, persist: true } });
    const execId = decision.body?.executionId as string | undefined;
    record("A: a persisted decision produces an execution with an audit trail", typeof execId === "string", `decision ${decision.body?.decision}`);
    if (execId) {
      record("B → read A's execution: 404", (await call(`/api/executions/${execId}`, { token: B.admin })).status === 404);
      record("B → verify A's audit chain: 404", (await call(`/api/executions/${execId}/audit/verify`, { token: B.admin })).status === 404);
      const bAudit = await call("/api/audit", { token: B.admin });
      const aAudit = await call("/api/audit", { token: A.admin });
      record("A → its own audit log contains the entry (positive control)", JSON.stringify(aAudit.body).includes(execId), `status ${aAudit.status}`);
      record("B → read the audit log: none of A's entries", bAudit.status === 200 && !JSON.stringify(bAudit.body).includes(execId), `status ${bAudit.status}`);
      const bRetry = await call(`/api/executions/${execId}/retry`, { token: B.admin, json: {} });
      record("B → retry A's execution: refused", bRetry.status === 404, `status ${bRetry.status}`);
      const aVerify = await call(`/api/executions/${execId}/audit/verify`, { token: A.admin });
      record("A → its own audit chain verifies", aVerify.status === 200 && aVerify.body?.valid !== false, `status ${aVerify.status}`);
    }
    const bMembers = await call("/api/members", { token: B.admin });
    record("B → list members: A's admin is absent", !JSON.stringify(bMembers.body).includes(T.A.email), `status ${bMembers.status}`);
    const bUsage = await call("/api/usage", { token: B.admin });
    record("B → usage counters are B's own", bUsage.status === 200 && !JSON.stringify(bUsage.body).includes(ORG_A), `status ${bUsage.status}`);

    section("CONCURRENCY — both tenants act at the same time");
    const beforeConc = refunds();
    const run = async (t: Tenant, n: number) => {
      let ok = 0;
      for (let i = 0; i < n; i++) {
        const a = await call("/api/actions/authorize", { token: t.agentKey, json: refund(5 + i, { idempotencyKey: `${t.org}-conc-${i}` }) });
        const e = await call("/api/actions/execute", { token: t.agentKey, json: { ...refund(5 + i, { idempotencyKey: `${t.org}-conc-${i}` }), grantId: a.body?.grantId } });
        if (e.status === 200) ok++;
      }
      return ok;
    };
    const [okA, okB] = await Promise.all([run(A, 8), run(B, 8), run(A, 0)]);
    record("8 + 8 concurrent executions across two tenants all succeed", okA === 8 && okB === 8, `A ${okA}, B ${okB}`);
    record("the downstream received exactly 16 calls", refunds() === beforeConc + 16, `+${refunds() - beforeConc}`);

    section("POSTGRESQL — the rows are really there, partitioned by organization_id");
    const counts = await pool.query(
      `SELECT organization_id, count(*)::int AS n FROM action_receipts GROUP BY organization_id ORDER BY organization_id`,
    );
    const byOrg = Object.fromEntries(counts.rows.map((r) => [r.organization_id, r.n]));
    record("receipts are stored per tenant (A: 3+8, B: 8)", byOrg[ORG_A] === 11 && byOrg[ORG_B] === 8, JSON.stringify(byOrg));
    const agents = await pool.query(`SELECT organization_id, id FROM agents WHERE id = $1 ORDER BY organization_id`, [SHARED_AGENT]);
    record(`"${SHARED_AGENT}" is two rows, one per tenant`, agents.rows.length === 2, agents.rows.map((r) => r.organization_id).join(","));
    const cross = await pool.query(
      `SELECT count(*)::int AS n FROM action_receipts r JOIN action_grants g ON g.id = r.grant_id WHERE g.organization_id <> r.organization_id`,
    );
    record("no receipt points at another tenant's grant", cross.rows[0].n === 0, `${cross.rows[0].n} rows`);
    const sqlite = existsSync(path.join(ROOT, "data.db"));
    record("no SQLite file was created by the production process", !sqlite, sqlite ? "data.db exists" : "no data.db");

    section("LOGS — nothing secret reached the process output");
    const out = booted.output();
    const leaked = [T.A.password, T.B.password, SESSION_SECRET, A.agentKey, B.agentKey].filter((s) => s && out.includes(s));
    record("no password, session secret or API key in the log", leaked.length === 0, `${out.length} bytes inspected`);

    section("BACKUP / RESTORE — pg_dump, restore into a new database, boot on it");
    await stop(booted.child);
    const tableCounts = async (p: Pool) => {
      const t = await p.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
      );
      const out: Record<string, number> = {};
      for (const { table_name } of t.rows) {
        out[table_name] = (await p.query(`SELECT count(*)::int AS n FROM "${table_name}"`)).rows[0].n;
      }
      return out;
    };
    const srcCounts = await tableCounts(pool);
    const dumpFile = path.join(tmpdir(), `placet-mt-${process.pid}.dump`);
    let t0 = Date.now();
    const dump = pgDump(db.url, dumpFile);
    const dumpMs = Date.now() - t0;
    record("pg_dump of the live tenant data succeeds", dump.status === 0 && existsSync(dumpFile), `${dumpMs} ms${dump.status ? " " + dump.stderr.slice(0, 200) : ""}`);
    restored = await createThrowawayDatabase("oathrion_mt_restore", process.env, { migrate: false });
    t0 = Date.now();
    const rest = pgRestore(restored.url, dumpFile);
    const restoreMs = Date.now() - t0;
    record("pg_restore into a NEW, empty database succeeds", rest.status === 0, `${restoreMs} ms${rest.status ? " " + rest.stderr.slice(0, 200) : ""}`);
    rmSync(dumpFile, { force: true });
    const restoredPool = new Pool({ connectionString: restored.url, max: 2 });
    restoredPool.on("error", () => undefined);
    try {
      const dstCounts = await tableCounts(restoredPool);
      const diff = Object.keys({ ...srcCounts, ...dstCounts }).filter((k) => srcCounts[k] !== dstCounts[k]);
      record("every table has the same row count after restore", diff.length === 0, diff.length ? diff.join(",") : `${Object.keys(dstCounts).length} tables`);

      t0 = Date.now();
      const again = boot(restored.url, mcp.url, { orgA: ORG_A, orgB: ORG_B });
      try {
        const readyAgain = await waitReady(again.child);
        const bootMs = Date.now() - t0;
        record("the production bundle boots on the restored database", readyAgain === "ready", `${readyAgain}, ${bootMs} ms`);
        console.log(`  · measured on this machine: dump ${dumpMs} ms, restore ${restoreMs} ms, boot-to-ready ${bootMs} ms`);
        const sess = await call("/api/auth/session", { token: A.admin });
        record("A's console session survived the restore (identity plane in PG)", sess.status === 200 && JSON.stringify(sess.body).includes(ORG_A), `status ${sess.status}`);
        const beforeR = refunds();
        const replay = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(500), grantId: held.body?.grantId } });
        record("a grant consumed before the backup stays consumed after restore (no replay)", replay.status === 403 && refunds() === beforeR, `status ${replay.status} ${replay.body?.code ?? ""}`);
        const okAfter = await call("/api/actions/authorize", { token: A.agentKey, json: refund(7) });
        const exAfter = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(7), grantId: okAfter.body?.grantId } });
        record("A's credential and policies work after restore (ALLOW → executed once)", exAfter.status === 200 && refunds() === beforeR + 1, `status ${exAfter.status}`);
        if (execId) {
          const v = await call(`/api/executions/${execId}/audit/verify`, { token: A.admin });
          record("A's audit chain still verifies after restore", v.status === 200 && v.body?.valid !== false, `status ${v.status}`);
        }
        record("B still cannot read A's receipt after restore", (await call(`/api/actions/receipts/${receiptA}`, { token: B.admin })).status === 404);

        section("PROVIDER ERROR — the downstream disappears mid-flight");
        const pre = await call("/api/actions/authorize", { token: A.agentKey, json: refund(9) });
        await mock.close().catch(() => undefined); // the provider is now unreachable
        const failedExec = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(9), grantId: pre.body?.grantId } });
        const failedReceipt = failedExec.body?.receiptId
          ? await call(`/api/actions/receipts/${failedExec.body.receiptId}`, { token: A.admin })
          : { status: 0, body: null };
        record(
          "a provider failure is recorded, not hidden: receipt with outcome failed",
          // `executed: true` means "the grant was spent and dispatch attempted"; the result
          // is carried by `outcome` and `downstream.ok` (existing API contract).
          failedExec.body?.outcome === "failed" && failedExec.body?.downstream?.ok === false &&
            failedReceipt.body?.receipt?.outcome === "failed",
          `status ${failedExec.status}, response outcome ${failedExec.body?.outcome}, receipt ${failedReceipt.body?.receipt?.outcome}`,
        );
        const retrySame = await call("/api/actions/execute", { token: A.agentKey, json: { ...refund(9), grantId: pre.body?.grantId } });
        record(
          "the spent grant cannot be silently retried (a retry needs a NEW authorization)",
          retrySame.status === 403,
          `status ${retrySame.status} ${retrySame.body?.code ?? ""}`,
        );
        record("Oathrion stays up and ready after the provider failure", (await call("/api/ready")).status === 200);
      } finally {
        await stop(again.child);
      }

      section("TENANT EXPORT — one organization's rows, nothing of the other, no credential");
      const exp = await exportTenant(restoredPool, ORG_A);
      const text = JSON.stringify(exp);
      const nRows = Object.values(exp.tables).reduce((n, t) => n + t.length, 0);
      record("A's export contains A's data", (exp.tables.action_receipts?.length ?? 0) === 13 && (exp.tables.agents?.length ?? 0) === 2, `${nRows} rows, ${Object.keys(exp.tables).length} tables, receipts ${exp.tables.action_receipts?.length}`);
      record("A's export contains nothing of B", !text.includes(ORG_B) && !text.includes(T.B.email), "searched for B's org id and admin email");
      const secretsIn = [T.A.password, A.agentKey, SESSION_SECRET, A.admin, A.admin.split(".")[0]].filter((x) => x && text.includes(x));
      record("A's export contains no password, API key, session token or session secret", secretsIn.length === 0, `redacted: ${exp.redactedColumns.join(", ") || "none"}`);
      const allOrgRowsAreA = Object.entries(exp.tables).every(([name, rows]) => name === "organizations" || rows.every((r) => r.organization_id === ORG_A));
      record("every exported row carries organization_id = A", allOrgRowsAreA);

      /*
       * TENANT PURGE — l'épreuve se fait ICI et nulle part ailleurs.
       *
       * C'est le seul endroit du dépôt où deux locataires réels coexistent dans un
       * PostgreSQL réel, avec des reçus chaînés, des grants consommés et des clés d'API.
       * Une purge qui n'est éprouvée que sur une base vide ne prouve rien : ce qu'il faut
       * démontrer, c'est qu'elle emporte TOUT de A et RIEN de B.
       *
       * L'ordre compte : la purge vient après l'export, parce qu'exporter après avoir
       * effacé n'a plus d'objet — et que c'est précisément la consigne que le script
       * imprime à l'opérateur.
       */
      section("TENANT PURGE — everything of A, nothing of B, and a proof that survives");

      const bBefore = await restoredPool
        .query<{ n: string }>(`SELECT count(*)::text AS n FROM agents WHERE organization_id = $1`, [ORG_B])
        .then((r) => Number(r.rows[0]?.n ?? 0));

      const dry = await purgeTenant(restoredPool, ORG_A, { requestedBy: "", reason: "" });
      record(
        "a purge without --confirm counts and deletes nothing",
        !dry.erased && dry.totalRows > 0 && dry.erasureId === null,
        `${dry.totalRows} row(s) across ${Object.keys(dry.rowCounts).length} table(s)`,
      );
      const stillThere = await restoredPool
        .query<{ n: string }>(`SELECT count(*)::text AS n FROM agents WHERE organization_id = $1`, [ORG_A])
        .then((r) => Number(r.rows[0]?.n ?? 0));
      record("after the dry run A still owns its rows", stillThere === 2, `${stillThere} agent(s)`);

      /*
       * A est ACTIF à cet instant : le refus attendu n'est pas une formalité, c'est le
       * verrou qui empêche d'effacer un client qui travaille.
       */
      let refusedActive = "";
      try {
        await purgeTenant(restoredPool, ORG_A, { confirmName: T.A.name, requestedBy: "e2e", reason: "e2e" });
      } catch (error) {
        refusedActive = error instanceof PurgeRefused ? error.message : `wrong error: ${String(error)}`;
      }
      record("an ACTIVE tenant is refused", refusedActive.includes("still ACTIVE"), refusedActive.slice(0, 80));

      await restoredPool.query(`UPDATE organizations SET active = false WHERE id = $1`, [ORG_A]);

      let refusedName = "";
      try {
        await purgeTenant(restoredPool, ORG_A, { confirmName: T.B.name, requestedBy: "e2e", reason: "e2e" });
      } catch (error) {
        refusedName = error instanceof PurgeRefused ? error.message : `wrong error: ${String(error)}`;
      }
      record("the other tenant's name does not confirm this one", refusedName.includes("does not match"), refusedName.slice(0, 80));

      const purged = await purgeTenant(restoredPool, ORG_A, {
        confirmName: `  ${T.A.name.toUpperCase()}  `,
        requestedBy: "e2e@placet.test",
        reason: "multitenant campaign",
      });
      record(
        "a deactivated tenant is erased, and the name matches case-insensitively",
        purged.erased && purged.erasureId !== null,
        `${purged.totalRows} row(s), record ${purged.erasureId}`,
      );

      const aLeft = await restoredPool
        .query<{ n: string }>(
          `SELECT (
             (SELECT count(*) FROM agents WHERE organization_id = $1) +
             (SELECT count(*) FROM action_receipts WHERE organization_id = $1) +
             (SELECT count(*) FROM action_grants WHERE organization_id = $1) +
             (SELECT count(*) FROM api_keys WHERE organization_id = $1) +
             (SELECT count(*) FROM organizations WHERE id = $1)
           )::text AS n`,
          [ORG_A],
        )
        .then((r) => Number(r.rows[0]?.n ?? 0));
      record("nothing of A survives the purge", aLeft === 0, `${aLeft} row(s) left across agents, receipts, grants, keys, organization`);

      const bAfter = await restoredPool
        .query<{ n: string }>(`SELECT count(*)::text AS n FROM agents WHERE organization_id = $1`, [ORG_B])
        .then((r) => Number(r.rows[0]?.n ?? 0));
      record("B is untouched by A's purge", bAfter === bBefore && bAfter > 0, `B had ${bBefore} agent(s), still has ${bAfter}`);

      /*
       * Le registre doit SURVIVRE, et c'est le piège que la migration 20 évite : sa
       * colonne s'appelle `purged_organization_id`, donc la découverte des tables du
       * locataire ne la ramasse pas et la purge n'efface pas sa propre preuve.
       */
      const ledger = await restoredPool.query<{ row_counts: string; purged_name_key: string; requested_by: string }>(
        `SELECT row_counts, purged_name_key, requested_by FROM tenant_erasures WHERE purged_organization_id = $1`,
        [ORG_A],
      );
      const kept = ledger.rows[0];
      record("the erasure record survives the purge it describes", ledger.rowCount === 1, `${ledger.rowCount} record(s)`);
      record(
        "the record keeps counts, not content",
        !!kept && JSON.parse(kept.row_counts).agents === 2 && !JSON.stringify(kept).includes(T.A.email),
        kept ? `agents=${JSON.parse(kept.row_counts).agents}, no admin e-mail in the record` : "no record",
      );
    } finally {
      await restoredPool.end().catch(() => undefined);
    }
  } finally {
    await stop(booted.child);
    await restored?.dispose().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await mcp.close().catch(() => undefined);
    await mock.close().catch(() => undefined);
    await db.dispose();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("\n" + "=".repeat(78));
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  console.log("=".repeat(78));
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
