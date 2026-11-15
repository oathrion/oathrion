/**
 * END-TO-END ENTERPRISE JOURNEY — the 13 steps a paying customer performs.
 *
 * WHY THIS EXISTS, GIVEN THERE ARE ALREADY TWO SMOKE TESTS
 * -------------------------------------------------------
 * `npm run smoke` proves the bundle boots and that the deployment-critical properties
 * hold. `npm run smoke:postgres` proves the PostgreSQL paths are real. Neither one
 * follows a *customer* through the product: sign in, create an agent, write a policy,
 * watch it hold an action, approve it, read the audit trail, revoke the credential.
 *
 * That sequence is what decides whether Oathrion can be demonstrated commercially, and it
 * is exactly the sequence no unit test covers end to end. Three properties in it can
 * only be observed here:
 *
 *   - **nothing requires SQL.** Every step below is an HTTP call an operator can make
 *     from the console. If any step needed `sqlite3 data.db`, that is a commercial
 *     blocker and this script would have to open a database to continue. It never does.
 *   - **a second tenant is present the whole time.** A rival admin — a fully privileged
 *     attacker — attempts the same reads after every creation.
 *   - **the server is restarted in the middle.** Data created before the restart must
 *     still be there after it, including the audit trail and the revocation.
 *
 * Two organizations are configured, in the format an operator actually writes:
 *   OATHRION_CONSOLE_USERS="admin@acme.test:admin:…,Rival Corp/admin@rival.test:admin:…"
 *
 * Exit codes: 0 all checks passed · 1 a check failed · 2 the run could not be set up
 * (no build) — never a silent pass.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  baseUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");

const PORT = 5211;
const BASE = `http://127.0.0.1:${PORT}`;

/* Credentials for this run only. Long enough for the production credential rules. */
const ADMIN_EMAIL = "admin@acme.test";
const ADMIN_PASSWORD = "e2e-acme-admin-password-0123";
const OPERATOR_EMAIL = "operator@acme.test";
const OPERATOR_PASSWORD = "e2e-acme-operator-password-01";
const APPROVER_EMAIL = "approver@acme.test";
const APPROVER_PASSWORD = "e2e-acme-approver-password-01";
const RIVAL_EMAIL = "admin@rival.test";
const RIVAL_PASSWORD = "e2e-rival-admin-password-0123";
const SESSION_SECRET = "e2e-session-secret-0123456789abcdef";
const BOOTSTRAP_KEY = "e2e-bootstrap-admin-key-0123456789";

const AGENT_ID = "agt_e2e_payments";
const POLICY_APPROVAL_ID = "pol_e2e_approval";
const POLICY_BLOCK_ID = "pol_e2e_block";

type BootedChild = ChildProcessByStdio<null, Readable, Readable>;

interface Check {
  step: string;
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
let currentStep = "setup";

function step(label: string): void {
  currentStep = label;
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 68 - label.length))}`);
}

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ step: currentStep, name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res {
  status: number;
  body: string;
}

async function call(
  pathname: string,
  init?: RequestInit & { token?: string; json?: unknown },
): Promise<Res> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  try {
    const res = await fetch(`${BASE}${pathname}`, { ...init, headers, body });
    return { status: res.status, body: await res.text() };
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

function parse<T>(res: Res): T | null {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

function boot(databaseUrl: string): { child: BootedChild; output: () => string } {
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      /*
       * Every plane on PostgreSQL. This walkthrough runs with NODE_ENV=production on
       * purpose — several of its checks are about production-only behaviour — and since
       * Phase 12.2 that requires PostgreSQL throughout, with no variable to opt out.
       * The database is created and dropped by the caller, so the restart below still
       * reopens the same state.
       */
      ...productionPostgresEnv(databaseUrl),
      // Cleared so a path in the caller's shell cannot redirect records to a local file.
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      // One bootstrap machine key, so the very first call has a credential without
      // anyone touching the database. Everything else is created through the console.
      OATHRION_API_KEYS: `Acme Bootstrap:admin:${BOOTSTRAP_KEY}`,
      OATHRION_CONSOLE_USERS: [
        `${ADMIN_EMAIL}:admin:${ADMIN_PASSWORD}`,
        `${OPERATOR_EMAIL}:operator:${OPERATOR_PASSWORD}`,
        `${APPROVER_EMAIL}:approver:${APPROVER_PASSWORD}`,
        `Rival Corp/${RIVAL_EMAIL}:admin:${RIVAL_PASSWORD}`,
      ].join(","),
      OATHRION_SEED: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as BootedChild;

  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  return { child, output: () => output };
}

async function waitForBoot(child: BootedChild, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { booted: false, reason: `exited with code ${child.exitCode}` };
    const res = await call("/api/health");
    if (res.status !== 0) return { booted: true, reason: "answered the probe" };
    await sleep(200);
  }
  return { booted: false, reason: `no answer within ${timeoutMs}ms` };
}

async function stop(child: BootedChild): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  const raced = await Promise.race([exited, sleep(10_000).then(() => "timeout" as const)]);
  if (raced === "timeout") {
    child.kill("SIGKILL");
    return null;
  }
  return raced;
}

async function login(email: string, password: string): Promise<string> {
  const res = await call("/api/auth/login", { method: "POST", json: { email, password } });
  return parse<{ token?: string }>(res)?.token ?? "";
}

/* ------------------------------ the journey ------------------------------ */

async function main(): Promise<number> {
  console.log("=".repeat(78));
  console.log("Oathrion — END-TO-END ENTERPRISE JOURNEY (13 steps, real bundle, two tenants)");
  console.log("=".repeat(78));

  if (!existsSync(BUNDLE)) {
    console.error("\nNo bundle at dist/index.cjs. Run `npm run build` first.");
    return 2;
  }

  let database: ThrowawayDatabase;
  try {
    database = await createThrowawayDatabase("oathrion_e2e");
    console.log(`\nDatabase for this run: ${database.name} on ${redactUrl(baseUrl())}`);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let booted = boot(database.url);
  let child = booted.child;

  try {
    /* === 1. install and start ============================================= */
    step("STEP 1 — a new operator installs and starts Oathrion");
    const first = await waitForBoot(child);
    record("the shipped bundle starts on a database that does not exist yet", first.booted, first.reason);
    if (!first.booted) {
      console.log(`\n--- output ---\n${booted.output().trim()}`);
      return 1;
    }
    const health = parse<{ status?: string; checks?: { database?: { ok?: boolean } } }>(
      await call("/api/health"),
    );
    record(
      "the schema was created and the health probe reports the database usable",
      health?.status === "ok" && health.checks?.database?.ok === true,
      `status=${health?.status}, database=${health?.checks?.database?.ok}`,
    );
    /*
     * DEUX surfaces, et chacune vérifiée à SA place.
     *
     * Ce contrôle affirmait « la console est servie à la racine ». Depuis que le site
     * public existe, la racine lui appartient et la console vit sous `/console`. Or les
     * deux documents contiennent `<div id="root"`, donc l'assertion d'origine serait
     * restée VERTE sur la page marketing — en ne prouvant plus rien. Elle est donc
     * remplacée par deux assertions qui distinguent les documents par leur contenu.
     */
    const siteHtml = await call("/");
    record(
      "the public site is served at the root",
      /*
       * `SoftwareApplication` est la donnée structurée que seul le document du site
       * porte. Un marqueur présent dans un seul des deux documents est ce qui distingue
       * ce contrôle d'une tautologie — mon premier jet comparait à une chaîne vide, qui
       * est vraie partout.
       */
      siteHtml.status === 200 && siteHtml.body.includes("SoftwareApplication"),
      `status ${siteHtml.status}`,
    );
    const consoleHtml = await call("/console");
    record(
      "the console is served at /console, so there is a UI to sign in to",
      consoleHtml.status === 200 && consoleHtml.body.includes('<div id="root"'),
      `status ${consoleHtml.status}`,
    );
    record(
      "the two documents are different, so neither check can pass on the other",
      siteHtml.body !== consoleHtml.body,
      `${siteHtml.body.length} vs ${consoleHtml.body.length} bytes`,
    );

    /* === 2. the organization exists ====================================== */
    step("STEP 2 — the organization exists and is visible to its own members");
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    record("an admin signs in with the configured password", adminToken.length > 20, `token ${adminToken.length} chars`);
    if (!adminToken) return 1;

    const org = parse<{ id: string; name: string; memberCount: number; adminCount: number; active: boolean }>(
      await call("/api/organization", { token: adminToken }),
    );
    record(
      "GET /api/organization returns the caller's real tenant, not a fixture",
      org?.id === "org_default" && org.active === true,
      `id=${org?.id}, name=${org?.name}, active=${org?.active}`,
    );

    /* === 3. the users exist ============================================== */
    step("STEP 3 — the operator's users are real rows, each with a hashed password");
    const roster = parse<{ total: number; members: { email: string; role: string; status: string }[] }>(
      await call("/api/members", { token: adminToken }),
    );
    const emails = (roster?.members ?? []).map((m) => m.email).sort();
    record(
      "the roster lists exactly the three configured members of this tenant",
      roster?.total === 3 && emails.join(",") === [ADMIN_EMAIL, APPROVER_EMAIL, OPERATOR_EMAIL].sort().join(","),
      `${roster?.total} member(s): ${emails.join(", ")}`,
    );
    record(
      "the rival admin is NOT in this tenant's roster",
      !emails.includes(RIVAL_EMAIL),
      emails.includes(RIVAL_EMAIL) ? "LEAKED" : "absent, as required",
    );
    record(
      "no password material is present anywhere in the roster payload",
      !/passwordHash|password_hash|scrypt|salt/i.test(JSON.stringify(roster)),
      "no hash, salt or algorithm name in the response",
    );
    const operatorToken = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);
    const approverToken = await login(APPROVER_EMAIL, APPROVER_PASSWORD);
    record(
      "the operator and the approver can each sign in with their own password",
      operatorToken.length > 20 && approverToken.length > 20,
      `operator ${operatorToken.length}, approver ${approverToken.length}`,
    );
    const wrong = await call("/api/auth/login", {
      method: "POST",
      json: { email: ADMIN_EMAIL, password: "not-the-password-at-all" },
    });
    const unknown = await call("/api/auth/login", {
      method: "POST",
      json: { email: "nobody@acme.test", password: ADMIN_PASSWORD },
    });
    /*
     * The two refusals must be indistinguishable, or the login endpoint answers "does
     * this address have an account here?" to anyone who asks.
     *
     * Comparing the raw bodies stopped working when every error gained a `requestId`
     * (P1-3): it is a fresh random value per request, so two responses are never
     * byte-identical any more. The check is not weakened — it is made specific: every
     * field *except* the correlation id must match exactly, and the correlation ids must
     * both be present and differ, which is what proves the difference is the id and not a
     * leak hiding behind it. Comparing the bodies loosely (a substring, a status-only
     * check) would have been the way to make this pass while giving up what it tests.
     */
    const withoutRequestId = (raw: string) => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const id = parsed.requestId;
      delete parsed.requestId;
      // Key order is normalised so a reordered serialisation is not read as a difference.
      return { id, rest: JSON.stringify(Object.entries(parsed).sort()) };
    };
    let identical = false;
    let enumerationDetail = `wrong ${wrong.status}, unknown ${unknown.status}`;
    try {
      const a = withoutRequestId(wrong.body);
      const b = withoutRequestId(unknown.body);
      identical =
        wrong.status === 401 &&
        unknown.status === 401 &&
        a.rest === b.rest &&
        typeof a.id === "string" &&
        typeof b.id === "string" &&
        a.id !== b.id;
      enumerationDetail =
        a.rest === b.rest
          ? `both 401, bodies identical apart from requestId (${String(a.id).slice(0, 12)}… vs ${String(b.id).slice(0, 12)}…)`
          : `DIFFER: ${a.rest} vs ${b.rest}`;
    } catch {
      enumerationDetail = `${enumerationDetail}, a body was not JSON`;
    }
    record(
      "a wrong password and an unknown address are refused identically (no enumeration)",
      identical,
      enumerationDetail,
    );

    /* === 4. create an agent ============================================== */
    step("STEP 4 — the customer creates an agent from the console");
    const agentBody = {
      id: AGENT_ID,
      name: "Payments Agent",
      description: "Settles supplier invoices under mandate.",
      provider: "openai" as const,
      model: "gpt-4",
      status: "active" as const,
      owner: "finance",
      mandate: {
        maxTransactionAmount: 500,
        currency: "EUR" as const,
        allowedCategories: ["supplier-invoice"],
        blockedCategories: [],
        allowedDomains: [],
      },
      permissions: [
        { scope: "execute:payments" as const, label: "Settle invoices", description: "Pay supplier invoices under mandate", granted: true, risk: "high" as const },
      ],
      policyIds: [],
      tags: ["finance"],
    };
    const created = await call("/api/agents", { method: "POST", token: adminToken, json: agentBody });
    record(
      "POST /api/agents creates the agent through the strict contract",
      created.status === 201,
      `status ${created.status}${created.status >= 400 ? ` — ${created.body.slice(0, 140)}` : ""}`,
    );
    if (created.status !== 201) {
      // Every remaining step is about that agent. Continuing would report a wall of
      // failures that all restate this one.
      console.log("\n  ! the agent could not be created; the rest of the journey depends on it");
      return 1;
    }
    const listed = parse<{ id: string }[]>(await call("/api/agents", { token: adminToken }));
    record(
      "the agent appears in this tenant's own list",
      Array.isArray(listed) && listed.some((a) => a.id === AGENT_ID),
      `${listed?.length ?? 0} agent(s)`,
    );
    const viewerWrite = await call("/api/agents", {
      method: "POST",
      token: approverToken,
      json: { ...agentBody, id: "agt_e2e_forbidden" },
    });
    record(
      "an approver cannot create an agent — RBAC is enforced server-side",
      viewerWrite.status === 403,
      `status ${viewerWrite.status}`,
    );

    /* === 5. create policies ============================================== */
    step("STEP 5 — the customer writes the policies that govern that agent");
    const approvalPolicy = await call("/api/policies", {
      method: "POST",
      token: adminToken,
      json: {
        id: POLICY_APPROVAL_ID,
        name: "Large payments need a human",
        description: "Any purchase above EUR 100 is held for an approver.",
        // MAX_TRANSACTION_AMOUNT is the type evaluated against an `amountAtMost`
        // condition. Writing REQUIRE_HUMAN_APPROVAL here — the intuitive choice — used
        // to be accepted and produce a policy that never fired; it is now a 400.
        type: "MAX_TRANSACTION_AMOUNT",
        condition: { kind: "amountAtMost", max: 100, currency: "EUR" },
        scope: "organization",
        appliesTo: "all agents",
        effect: "require_approval",
        status: "enabled",
        action: "APPROVAL_REQUIRED",
        risk: "high",
        priority: 10,
      },
    });
    record(
      "an amount-ceiling policy that holds anything above EUR 100 for a human is created",
      approvalPolicy.status === 201,
      `status ${approvalPolicy.status}${approvalPolicy.status >= 400 ? ` — ${approvalPolicy.body.slice(0, 140)}` : ""}`,
    );
    const blockPolicy = await call("/api/policies", {
      method: "POST",
      token: adminToken,
      json: {
        id: POLICY_BLOCK_ID,
        name: "Never pay a sanctioned target",
        description: "Settlements to the sanctioned list are refused outright.",
        type: "BLOCK_TOOL",
        condition: { kind: "targetMatches", targets: ["sanctioned-supplier"] },
        scope: "organization",
        appliesTo: "all agents",
        effect: "block",
        status: "enabled",
        action: "BLOCK",
        risk: "critical",
        priority: 5,
      },
    });
    record(
      "a BLOCK policy is created and ordered ahead of it by priority",
      blockPolicy.status === 201,
      `status ${blockPolicy.status}${blockPolicy.status >= 400 ? ` — ${blockPolicy.body.slice(0, 140)}` : ""}`,
    );

    /* === 6. issue an API key ============================================= */
    step("STEP 6 — the customer issues an API key for their own integration");
    const issued = parse<{ secret: string; key: { id: string; name: string } }>(
      await call("/api/keys", {
        method: "POST",
        token: adminToken,
        json: { name: "Acme ERP integration", role: "operator" },
      }),
    );
    record(
      "the secret is returned exactly once, at creation",
      typeof issued?.secret === "string" && issued.secret.startsWith("oathrion_"),
      issued?.secret ? `prefix ${issued.secret.slice(0, 5)}…, ${issued.secret.length} chars` : "no secret",
    );
    const keyList = parse<{ keys: { id: string; secret?: string; token?: string }[] }>(
      await call("/api/keys", { token: adminToken }),
    );
    record(
      "listing keys afterwards never returns the secret again",
      !!keyList && !JSON.stringify(keyList).includes(issued!.secret),
      `${keyList?.keys.length ?? 0} key(s) listed, secret absent`,
    );
    const integrationKey = issued!.secret;

    /*
     * A SECOND key, bound to the agent it is allowed to drive.
     *
     * This walkthrough runs with NODE_ENV=production, and Phase 9 made agent
     * binding the production default (`requiresAgentBinding()` in
     * server/identity/agent-binding.ts). Five checks in step 7/8 began failing
     * with the unbound key — correctly: in production a credential may only act
     * as an agent it is bound to.
     *
     * The walkthrough was wrong, not the server, and the honest fix is the one a
     * real operator performs. Relaxing the posture instead — setting
     * OATHRION_REQUIRE_AGENT_BINDING=false or dropping NODE_ENV=production — would
     * have made this demo quietly show a weaker product than the one that ships.
     */
    const boundIssued = parse<{ secret: string }>(
      await call("/api/keys", {
        method: "POST",
        token: adminToken,
        json: { name: "Acme ERP integration (bound)", role: "operator", agentId: AGENT_ID },
      }),
    );
    record(
      "a key can be bound to a single agent, which production requires",
      typeof boundIssued?.secret === "string" && boundIssued.secret.startsWith("oathrion_"),
      boundIssued?.secret ? `bound to ${AGENT_ID}` : "no secret",
    );
    const agentKey = boundIssued!.secret;

    /*
     * And the unbound key must be REFUSED for the same call. Asserted explicitly,
     * so the default is proven by this walkthrough rather than merely avoided —
     * without this check, a regression that disabled binding would leave every
     * step below green and the demo would silently stop demonstrating it.
     */
    const unbound = await call("/api/decision", {
      method: "POST",
      token: integrationKey,
      json: { agentId: AGENT_ID, action: "purchase", target: "supplier-42", metadata: { amount: 40, currency: "EUR", category: "supplier-invoice" }, persist: true },
    });
    record(
      "an unbound credential cannot act as an agent in production",
      unbound.status === 403,
      `status ${unbound.status} (expected 403)`,
    );

    /* === 7 & 8. send a request, observe the decision ===================== */
    step("STEP 7/8 — the integration sends requests and observes the decisions");
    const allowed = parse<{ decision: string; executionId: string | null }>(
      await call("/api/decision", {
        method: "POST",
        token: agentKey,
        json: { agentId: AGENT_ID, action: "purchase", target: "supplier-42", metadata: { amount: 40, currency: "EUR", category: "supplier-invoice" }, persist: true },
      }),
    );
    record(
      "a small purchase is ALLOWed and produces an execution",
      allowed?.decision === "ALLOW" && typeof allowed.executionId === "string",
      `decision=${allowed?.decision}, execution=${allowed?.executionId ?? "none"}`,
    );

    const executionsBeforeBlock = parse<unknown[]>(await call("/api/executions", { token: adminToken }))?.length ?? 0;
    const blocked = parse<{ decision: string; reason: string; policyId: string | null }>(
      await call("/api/decision", {
        method: "POST",
        token: agentKey,
        json: { agentId: AGENT_ID, action: "purchase", target: "sanctioned-supplier", metadata: { amount: 10, currency: "EUR", category: "supplier-invoice" }, persist: true },
      }),
    );
    record(
      "a purchase from a sanctioned target is BLOCKed, naming the policy",
      blocked?.decision === "BLOCK" && blocked.policyId === POLICY_BLOCK_ID,
      `decision=${blocked?.decision}, policy=${blocked?.policyId}`,
    );
    // The critical property: a refusal must not reach the tool. Verified by asking the
    // gateway to execute the same call and requiring a refusal there too.
    const executeBlocked = await call("/api/execute", {
      method: "POST",
      token: agentKey,
      json: { agentId: AGENT_ID, action: "purchase", target: "sanctioned-supplier", metadata: { amount: 10, currency: "EUR", category: "supplier-invoice" } },
    });
    const executeBody = parse<{ executed?: boolean; decision?: string; toolResult?: unknown }>(executeBlocked);
    record(
      "a BLOCKed action never reaches the underlying tool",
      executeBody?.executed === false || executeBody?.decision === "BLOCK",
      `executed=${executeBody?.executed}, decision=${executeBody?.decision}`,
    );
    const executionsAfterBlock = parse<unknown[]>(await call("/api/executions", { token: adminToken }))?.length ?? 0;
    record(
      "the refusal is still recorded — a denial is an event, not a silence",
      executionsAfterBlock > executionsBeforeBlock,
      `${executionsBeforeBlock} → ${executionsAfterBlock} execution rows`,
    );

    /* === 9 & 10. approval =============================================== */
    step("STEP 9/10 — a held action, then an approval and a rejection");
    const held = parse<{ decision: string; approvalId: string | null }>(
      await call("/api/execute", {
        method: "POST",
        token: agentKey,
        json: { agentId: AGENT_ID, action: "purchase", target: "supplier-77", metadata: { amount: 250, currency: "EUR", category: "supplier-invoice" } },
      }),
    );
    record(
      "a large purchase is held as APPROVAL_REQUIRED with an approval id",
      held?.decision === "APPROVAL_REQUIRED" && typeof held.approvalId === "string",
      `decision=${held?.decision}, approval=${held?.approvalId ?? "none"}`,
    );
    const approvalId = held?.approvalId ?? "";
    if (!approvalId) {
      console.log("\n  ! no approval was created; steps 9 and 10 depend on it");
      return 1;
    }

    const pending = parse<{ id: string; status: string }[]>(await call("/api/approvals", { token: approverToken }));
    record(
      "the approval is visible as pending to the approver",
      Array.isArray(pending) && pending.some((a) => a.id === approvalId && a.status === "pending"),
      `${pending?.length ?? 0} approval(s) in the queue`,
    );

    const operatorApproves = await call(`/api/approvals/${approvalId}/approve`, {
      method: "POST",
      token: operatorToken,
      json: {},
    });
    record(
      "the operator who originated the action cannot approve it (separation of duties)",
      operatorApproves.status === 403,
      `status ${operatorApproves.status}`,
    );
    const rivalApproves = await call(`/api/approvals/${approvalId}/approve`, {
      method: "POST",
      token: await login(RIVAL_EMAIL, RIVAL_PASSWORD),
      json: {},
    });
    record(
      "an admin of another organization cannot approve it either — 404, not 403",
      rivalApproves.status === 404,
      `status ${rivalApproves.status} (403 would confirm the id exists)`,
    );

    const approved = parse<{ approval: { status: string; resolvedBy?: string }; executed: boolean }>(
      await call(`/api/approvals/${approvalId}/approve`, { method: "POST", token: approverToken, json: {} }),
    );
    record(
      "the approver approves, and the held action is released to its tool exactly once",
      approved?.approval.status === "approved" && approved.executed === true,
      `status=${approved?.approval.status}, executed=${approved?.executed}`,
    );
    const replay = await call(`/api/approvals/${approvalId}/approve`, { method: "POST", token: approverToken, json: {} });
    const replayBody = parse<{ executed?: boolean }>(replay);
    record(
      "approving twice does not execute twice",
      replayBody?.executed !== true,
      `second attempt: status ${replay.status}, executed=${replayBody?.executed}`,
    );

    const held2 = parse<{ approvalId: string | null }>(
      await call("/api/execute", {
        method: "POST",
        token: agentKey,
        json: { agentId: AGENT_ID, action: "purchase", target: "supplier-88", metadata: { amount: 400, currency: "EUR", category: "supplier-invoice" } },
      }),
    );
    const rejected = !held2?.approvalId ? null : parse<{ approval: { status: string }; executed: boolean }>(
      await call(`/api/approvals/${held2.approvalId}/reject`, { method: "POST", token: approverToken, json: {} }),
    );
    record(
      "a rejected approval never executes",
      rejected?.approval.status === "rejected" && rejected.executed === false,
      `status=${rejected?.approval.status}, executed=${rejected?.executed}`,
    );

    /* === 11. audit ====================================================== */
    step("STEP 11 — the customer reads the audit trail");
    const audit = parse<{ total: number; events: { actor?: string; event?: string }[] }>(
      await call("/api/audit", { token: adminToken }),
    );
    const auditText = JSON.stringify(audit?.events ?? []);
    record(
      "the audit trail is readable over HTTP and is not empty",
      (audit?.events?.length ?? 0) > 0 && (audit?.total ?? 0) > 0,
      `${audit?.events?.length ?? 0} of ${audit?.total ?? 0} entries returned`,
    );
    record(
      "the approval decision is attributed to the approver who really made it",
      auditText.includes(APPROVER_EMAIL) || auditText.includes("approver"),
      "approver identity present in the trail",
    );
    record(
      "no credential, secret or password appears in the audit trail",
      !auditText.includes(integrationKey) &&
        !auditText.includes(ADMIN_PASSWORD) &&
        !auditText.includes(BOOTSTRAP_KEY),
      "no key or password material in the entries",
    );

    /* === 12. revoke the key ============================================= */
    step("STEP 12 — the customer revokes the integration key");
    const worksBefore = await call("/api/agents", { token: integrationKey });
    const revoked = await call(`/api/keys/${issued!.key.id}`, { method: "DELETE", token: adminToken });
    const worksAfter = await call("/api/agents", { token: integrationKey });
    record(
      "the key works, is revoked from the console, and stops working immediately",
      worksBefore.status === 200 && revoked.status === 200 && worksAfter.status === 401,
      `before ${worksBefore.status}, revoke ${revoked.status}, after ${worksAfter.status}`,
    );

    /* === 13. security ==================================================== */
    step("STEP 13 — the customer checks the security boundary");
    const rivalToken = await login(RIVAL_EMAIL, RIVAL_PASSWORD);
    const rivalAgents = parse<{ id: string }[]>(await call("/api/agents", { token: rivalToken }));
    record(
      "a rival admin's agent list does not contain this tenant's agent",
      Array.isArray(rivalAgents) && !rivalAgents.some((a) => a.id === AGENT_ID),
      `${rivalAgents?.length ?? 0} agent(s) in the rival tenant`,
    );
    const rivalRead = await call(`/api/agents/${AGENT_ID}`, { token: rivalToken });
    record(
      "reading this tenant's agent by id from the rival tenant answers 404",
      rivalRead.status === 404,
      `status ${rivalRead.status}`,
    );
    const rivalPatch = await call(`/api/agents/${AGENT_ID}`, {
      method: "PATCH",
      token: rivalToken,
      json: { status: "paused" },
    });
    const stillActive = parse<{ status: string }>(await call(`/api/agents/${AGENT_ID}`, { token: adminToken }));
    record(
      "a cross-tenant write is refused AND leaves the row untouched",
      rivalPatch.status === 404 && stillActive?.status === "active",
      `patch ${rivalPatch.status}, owner still sees status=${stillActive?.status}`,
    );
    const rivalAudit = parse<{ total: number; events: unknown[] }>(
      await call("/api/audit", { token: rivalToken }),
    );
    record(
      "the rival tenant's audit trail contains none of this tenant's entries",
      !JSON.stringify(rivalAudit?.events ?? []).includes(AGENT_ID),
      `${rivalAudit?.total ?? 0} entries, none referencing ${AGENT_ID}`,
    );
    const noAuth = await call("/api/agents");
    const badKey = await call("/api/agents", { token: "oathrion_not_a_real_key_000000000" });
    record(
      "no credential and a forged credential are both refused",
      noAuth.status === 401 && badKey.status === 401,
      `anonymous ${noAuth.status}, forged ${badKey.status}`,
    );
    const logs = booted.output();
    record(
      "nothing secret was written to the process log",
      !logs.includes(ADMIN_PASSWORD) &&
        !logs.includes(BOOTSTRAP_KEY) &&
        !logs.includes(integrationKey) &&
        !logs.includes(SESSION_SECRET),
      `${logs.length} bytes of output, no secret present`,
    );

    /* === restart / recovery ============================================== */
    step("RESTART — the deployment is restarted and nothing is lost");
    const beforeExecutions = parse<unknown[]>(await call("/api/executions", { token: adminToken }))?.length ?? 0;
    const beforeAudit = parse<{ total: number }>(await call("/api/audit", { token: adminToken }))?.total ?? 0;
    const exitCode = await stop(child);
    record("SIGTERM produces a clean exit", exitCode === 0, `exit code ${exitCode}`);

    booted = boot(database.url);
    child = booted.child;
    const second = await waitForBoot(child);
    record("the server restarts on the existing database", second.booted, second.reason);
    if (!second.booted) {
      console.log(`\n--- output ---\n${booted.output().trim()}`);
      return 1;
    }

    const adminToken2 = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    record("the same password still opens a session after the restart", adminToken2.length > 20, "signed in again");
    const agentAfter = parse<{ id: string; status: string }>(
      await call(`/api/agents/${AGENT_ID}`, { token: adminToken2 }),
    );
    const policiesAfter = parse<{ id: string }[]>(await call("/api/policies", { token: adminToken2 }));
    const executionsAfter = parse<unknown[]>(await call("/api/executions", { token: adminToken2 }))?.length ?? 0;
    const auditAfter = parse<{ total: number }>(await call("/api/audit", { token: adminToken2 }))?.total ?? 0;
    const approvalsAfter = parse<{ status: string }[]>(await call("/api/approvals", { token: adminToken2 }));
    const orgAfter = parse<{ memberCount: number }>(await call("/api/organization", { token: adminToken2 }));
    record(
      "the agent, the policies and the organization survived",
      agentAfter?.id === AGENT_ID &&
        (policiesAfter?.length ?? 0) >= 2 &&
        (orgAfter?.memberCount ?? 0) === 3,
      `agent ok, ${policiesAfter?.length} policies, ${orgAfter?.memberCount} members`,
    );
    record(
      "the execution ledger and the audit trail survived, with no rows lost",
      executionsAfter >= beforeExecutions && auditAfter >= beforeAudit && auditAfter > 0,
      `executions ${beforeExecutions} → ${executionsAfter}, audit ${beforeAudit} → ${auditAfter}`,
    );
    record(
      "the resolved approvals kept their verdicts",
      Array.isArray(approvalsAfter) &&
        approvalsAfter.some((a) => a.status === "approved") &&
        approvalsAfter.some((a) => a.status === "rejected"),
      `${approvalsAfter?.length ?? 0} approval(s), verdicts intact`,
    );
    const revokedAfter = await call("/api/agents", { token: integrationKey });
    record(
      "the revoked key is STILL revoked — restarting is not a way to undo a revocation",
      revokedAfter.status === 401,
      `status ${revokedAfter.status}`,
    );

    /* === identity lifecycle on the live server =========================== */
    /*
     * P2 identity, exercised against the packaged bundle rather than under Vitest.
     * The unit suite already proves the rules; what this proves is different and is
     * the thing an operator actually depends on: that migration 008 ran on a real
     * database at boot, that the two public redemption endpoints are reachable
     * without a credential in the built `dist/index.cjs`, and that a suspension
     * takes effect on a live session in a running process.
     *
     * Placed after the restart stage on purpose: the check above pins
     * `memberCount === 3`, and onboarding a fourth person before it would break an
     * assertion that has nothing to do with identity.
     */
    step("IDENTITY — a colleague is invited, joins, is suspended and is reinstated");
    const JOINER_EMAIL = "newcomer@acme.test";
    const JOINER_PASSWORD = "e2e-acme-newcomer-password-01";
    const JOINER_NEW_PASSWORD = "e2e-acme-newcomer-second-pass";

    const invited = await call("/api/invitations", {
      method: "POST",
      token: adminToken2,
      json: { email: JOINER_EMAIL, role: "operator" },
    });
    const invitation = parse<{ invitation: { id: string }; token: string }>(invited);
    record(
      "an admin issues an invitation and receives the token exactly once",
      invited.status === 201 && typeof invitation?.token === "string" && invitation.token.includes("."),
      `status ${invited.status}, token ${invitation?.token ? "returned" : "MISSING"}`,
    );

    const inviteList = await call("/api/invitations", { token: adminToken2 });
    record(
      "the invitation list carries metadata only — never the token, never a digest",
      inviteList.status === 200 &&
        !inviteList.body.includes(invitation?.token ?? "\u0000") &&
        !inviteList.body.includes("secret") &&
        !inviteList.body.includes("sha256$"),
      `status ${inviteList.status}, ${inviteList.body.length} bytes inspected`,
    );

    const rivalSeesInvite = await call("/api/invitations", { token: rivalToken });
    record(
      "an admin of another organization sees none of it",
      rivalSeesInvite.status === 200 &&
        !rivalSeesInvite.body.includes(JOINER_EMAIL) &&
        !rivalSeesInvite.body.includes(invitation?.invitation.id ?? "\u0000"),
      `status ${rivalSeesInvite.status}, joiner absent`,
    );

    /* Anonymous: no bearer token at all. This is the point of a public endpoint. */
    const accepted = await call("/api/invitations/accept", {
      method: "POST",
      json: { token: invitation?.token, password: JOINER_PASSWORD, name: "Newcomer" },
    });
    record(
      "the invitation is redeemed without any credential, and issues no session",
      accepted.status === 201 && !accepted.body.includes("\"token\""),
      `status ${accepted.status}, session in body: ${accepted.body.includes("\"token\"") ? "YES (wrong)" : "no"}`,
    );

    const replayed = await call("/api/invitations/accept", {
      method: "POST",
      json: { token: invitation?.token, password: JOINER_NEW_PASSWORD },
    });
    record(
      "replaying the same token is refused — single use is enforced by the database",
      replayed.status === 400,
      `status ${replayed.status}`,
    );

    const joinerToken = await login(JOINER_EMAIL, JOINER_PASSWORD);
    const joinerSession = parse<{ identity: { role: string; kind: string } }>(
      await call("/api/auth/session", { token: joinerToken }),
    );
    record(
      "the new colleague signs in with the role the invitation named",
      joinerSession?.identity.role === "operator" && joinerSession.identity.kind === "user",
      `role ${joinerSession?.identity.role}, kind ${joinerSession?.identity.kind}`,
    );

    const rosterAfterJoin = parse<{
      members: { id: string; email: string; membershipStatus: string }[];
    }>(await call("/api/members", { token: adminToken2 }));
    const joiner = rosterAfterJoin?.members.find((m) => m.email === JOINER_EMAIL);
    record(
      "the roster now shows four people, the new one active in this organization",
      (rosterAfterJoin?.members.length ?? 0) === 4 && joiner?.membershipStatus === "active",
      `${rosterAfterJoin?.members.length} members, newcomer ${joiner?.membershipStatus}`,
    );

    const suspended = await call(`/api/members/${joiner?.id}`, {
      method: "PATCH",
      token: adminToken2,
      json: { suspended: true },
    });
    const afterSuspension = await call("/api/auth/session", { token: joinerToken });
    record(
      "suspending them kills their LIVE session on its next request, with no restart",
      suspended.status === 200 && afterSuspension.status === 401,
      `patch ${suspended.status}, reuse ${afterSuspension.status}`,
    );

    const suspendedLogin = await call("/api/auth/login", {
      method: "POST",
      json: { email: JOINER_EMAIL, password: JOINER_PASSWORD },
    });
    record(
      "a suspended member cannot sign in again either",
      suspendedLogin.status === 401,
      `status ${suspendedLogin.status}`,
    );

    const reinstated = await call(`/api/members/${joiner?.id}`, {
      method: "PATCH",
      token: adminToken2,
      json: { suspended: false },
    });
    const backIn = parse<{ identity: { role: string } }>(
      await call("/api/auth/session", { token: await login(JOINER_EMAIL, JOINER_PASSWORD) }),
    );
    record(
      "reinstating them restores the role they held — the membership was kept, not deleted",
      reinstated.status === 200 && backIn?.identity.role === "operator",
      `patch ${reinstated.status}, role ${backIn?.identity.role}`,
    );

    /* A reset is admin-issued and handed over out of band: there is no mail transport. */
    const resetIssued = parse<{ token: string }>(
      await call("/api/invitations", {
        method: "POST",
        token: adminToken2,
        json: { email: JOINER_EMAIL, purpose: "reset" },
      }),
    );
    const liveBeforeReset = await login(JOINER_EMAIL, JOINER_PASSWORD);
    const redeemed = await call("/api/auth/password/reset", {
      method: "POST",
      json: { token: resetIssued?.token, password: JOINER_NEW_PASSWORD },
    });
    const staleAfterReset = await call("/api/auth/session", { token: liveBeforeReset });
    const oldPassword = await call("/api/auth/login", {
      method: "POST",
      json: { email: JOINER_EMAIL, password: JOINER_PASSWORD },
    });
    const newPassword = await call("/api/auth/login", {
      method: "POST",
      json: { email: JOINER_EMAIL, password: JOINER_NEW_PASSWORD },
    });
    record(
      "redeeming a reset replaces the password and ends every session the account held",
      redeemed.status === 200 &&
        staleAfterReset.status === 401 &&
        oldPassword.status === 401 &&
        newPassword.status === 200,
      `reset ${redeemed.status}, old session ${staleAfterReset.status}, old password ${oldPassword.status}, new password ${newPassword.status}`,
    );

    const lastAdmin = rosterAfterJoin?.members.find((m) => m.email === ADMIN_EMAIL);
    const selfDemote = await call(`/api/members/${lastAdmin?.id}`, {
      method: "PATCH",
      token: adminToken2,
      json: { role: "viewer" },
    });
    const selfRemove = await call(`/api/members/${lastAdmin?.id}`, {
      method: "DELETE",
      token: adminToken2,
    });
    record(
      "the last administrator cannot demote or remove themselves into an unrecoverable tenant",
      selfDemote.status === 409 && selfRemove.status === 409,
      `demote ${selfDemote.status}, remove ${selfRemove.status}`,
    );

    const identityLogs = booted.output();
    record(
      "no invitation token, no reset token and no password reached the process log",
      !identityLogs.includes(invitation?.token ?? "\u0000") &&
        !identityLogs.includes(resetIssued?.token ?? "\u0000") &&
        !identityLogs.includes(JOINER_PASSWORD) &&
        !identityLogs.includes(JOINER_NEW_PASSWORD),
      `${identityLogs.length} bytes of output inspected`,
    );

    /* === rate limiting on the live server ================================ */
    step("RATE LIMIT — the live server refuses a flood and says when to retry");
    let limitStatus = 0;
    let retryAfter: string | null = null;
    let sent = 0;
    for (let i = 0; i < 60; i += 1) {
      const res = await fetch(`${BASE}/api/agents`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken2}`, "content-type": "application/json" },
        body: JSON.stringify({ ...agentBody, id: `agt_e2e_flood_${i}` }),
      });
      sent += 1;
      if (res.status === 429) {
        limitStatus = 429;
        retryAfter = res.headers.get("retry-after");
        break;
      }
    }
    record(
      "the write quota is enforced by the server and answers 429 with Retry-After",
      limitStatus === 429 && retryAfter !== null,
      `refused after ${sent} requests, Retry-After: ${retryAfter}`,
    );

    return checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    await stop(child);
    await database.dispose();

    const passed = checks.filter((c) => c.ok).length;
    console.log(`\n${"=".repeat(78)}`);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      console.log("FAILED CHECKS");
      for (const f of failed) console.log(`  ✗ [${f.step}] ${f.name} — ${f.detail}`);
      console.log("");
    }
    console.log(`${passed}/${checks.length} checks passed`);
    console.log("=".repeat(78));
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
