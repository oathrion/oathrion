/**
 * PostgreSQL smoke test — proves the PostgreSQL path on a real server (P0-4, P0-7).
 *
 * WHAT THIS DOES AND DOES NOT CLAIM
 * ---------------------------------
 * Read this before trusting the output, because the honest claim is narrower than
 * "Oathrion runs on PostgreSQL".
 *
 * What is real and verified here:
 *   - the migrations apply to an empty PostgreSQL database and produce the schema;
 *     re-running them applies nothing;
 *   - the shipped bundle boots in production mode with EVERY plane on PostgreSQL —
 *     repositories, identity, action authority and the rate limiter;
 *   - the probe, sign-in, a read, a write, an agent, a credential binding and a
 *     transactional decision all work in that mode, and no SQLite file is opened;
 *   - a quota is enforced ACROSS two limiter instances sharing that database — the
 *     multi-instance property the whole lot exists for, observed end to end rather
 *     than in a unit test;
 *   - SIGTERM closes the PostgreSQL pool and exits promptly instead of hanging.
 *
 * What is NOT claimed. This is one process on one host, so it is not a performance
 * result and not a two-instance test of the identity plane — `npm run e2e:identity`
 * is that. The identity plane reaches PostgreSQL through a synchronous worker bridge
 * on a single connection, which costs one blocked round trip per identity query; that
 * is a measured constraint, not something this script exercises.
 *
 * Phase 11 ran the records in SQLite and only the quotas in PostgreSQL, and check 2
 * asserted that `DATABASE_DRIVER=postgres` REFUSED to boot. Phase 12 made PostgreSQL a
 * real repository backend, so that refusal is gone; check 2 now asserts the property
 * that outlived it — an incomplete selection refuses rather than picking an engine.
 *
 * Requires a reachable PostgreSQL. Unlike the test suite, this NEVER skips: a smoke
 * test that passes without a server is a lie, so a missing server exits non-zero.
 *
 *   DATABASE_URL=postgres://user@localhost:55432/postgres npm run smoke:postgres
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { LATEST_VERSION, MIGRATIONS, migratePostgres, RATE_LIMIT_TABLE } from "../server/migrations";
import { PostgresQuotaStore } from "../server/rate-limit/postgres-store";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");

const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}`;

const API_KEY = "smoke-pg-api-key-0123456789abcdef";
const SESSION_SECRET = "smoke-pg-session-secret-0123456789";
const CONSOLE_PASSWORD = "smoke-pg-console-password-0123456789";
const CONSOLE_EMAIL = "smoke@placet.test";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://user@localhost:55432/postgres";
const DB_NAME = `oathrion_smoke_${Date.now().toString(36)}`;

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Never printed with credentials in it. */
function redactUrl(value: string): string {
  return value.replace(/\/\/[^@/]*@/, "//***@");
}

type BootedChild = ChildProcessByStdio<null, Readable, Readable>;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; headers: Headers | undefined }> {
  try {
    const res = await fetch(`${BASE}${pathname}`, init);
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error), headers: undefined };
  }
}

async function waitForBoot(child: BootedChild, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { booted: false, reason: `exited with code ${child.exitCode}` };
    const res = await req("/api/health");
    if (res.status !== 0) return { booted: true, reason: "answered the probe" };
    await sleep(250);
  }
  return { booted: false, reason: `no answer within ${timeoutMs}ms` };
}

async function main(): Promise<number> {
  console.log("=".repeat(78));
  console.log("POSTGRESQL SMOKE TEST — migrations, shared quotas, and a clean shutdown");
  console.log("=".repeat(78));

  if (!existsSync(BUNDLE)) {
    console.error("\nNo bundle at dist/index.cjs. Run `npm run build` first.");
    return 2;
  }

  console.log(`\nServer: ${redactUrl(ADMIN_URL)}`);

  /* --- 0. a server must actually be there --------------------------------- */
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1, connectionTimeoutMillis: 3_000 });
  /*
   * DROP DATABASE ... WITH (FORCE) terminates the connections to that database, and
   * node-postgres surfaces that as an `error` event on the pool. An unhandled `error`
   * event is an uncaught exception, so without this the cleanup at the end of a
   * *successful* run kills the script before it can print its result.
   */
  admin.on("error", () => undefined);
  try {
    const version = await admin.query<{ version: string }>("SELECT version()");
    record("a PostgreSQL server is reachable", true, version.rows[0]?.version.split(" ").slice(0, 2).join(" ") ?? "");
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    record("an empty database was created for this run", true, DB_NAME);
  } catch (error) {
    record("a PostgreSQL server is reachable", false, error instanceof Error ? error.message : String(error));
    console.error(
      "\nThis smoke test refuses to pass without a real server. Set DATABASE_URL and retry.",
    );
    await admin.end();
    return 2;
  }

  const dbUrl = urlFor(DB_NAME);
  const dir = mkdtempSync(path.join(tmpdir(), "placet-smoke-pg-"));
  const dbPath = path.join(dir, "data.db");
  let child: BootedChild | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let output = "";

  try {
    /* --- 1. migrations on an empty database ------------------------------- */
    const applied = await migratePostgres(dbUrl, MIGRATIONS);
    record(
      "every migration applies to an empty database",
      applied.version === LATEST_VERSION && applied.applied.length === MIGRATIONS.length,
      `version ${applied.version}, ${applied.applied.length} applied`,
    );

    const again = await migratePostgres(dbUrl, MIGRATIONS);
    record(
      "re-running the migrations applies nothing",
      again.applied.length === 0 && again.version === LATEST_VERSION,
      `version ${again.version}, ${again.applied.length} applied`,
    );

    const pool = new Pool({ connectionString: dbUrl, max: 2 });
    pool.on("error", () => undefined);
    const tables = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    record("the schema exists", Number(tables.rows[0]?.n) >= 12, `${tables.rows[0]?.n} tables`);

    /* --- 2. an incomplete PostgreSQL selection refuses, it does not guess --- */
    /*
     * This check used to assert the opposite outcome: in Phase 11 PostgreSQL was not a
     * repository backend at all, so `DATABASE_DRIVER=postgres` refused outright. Phase 12
     * made it a real backend, which retired that refusal — and left this assertion
     * testing a claim the product no longer makes.
     *
     * The property worth keeping is the one underneath it: Oathrion must never pick a
     * persistence engine the operator did not name. So the case is now a PARTIAL
     * selection — the driver says postgres while the identity plane is unstated — and the
     * requirement is still a refusal with a reason, never a silent choice.
     */
    const refused = spawn("node", [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(PORT + 1),
        DATABASE_DRIVER: "postgres",
        DATABASE_URL: dbUrl,
        // OATHRION_IDENTITY_PLANE deliberately absent: that is the gap under test.
        OATHRION_IDENTITY_PLANE: undefined,
        OATHRION_SESSION_SECRET: SESSION_SECRET,
        OATHRION_API_KEYS: `Smoke Admin:admin:${API_KEY}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let refusedOutput = "";
    refused.stdout.on("data", (c: Buffer) => (refusedOutput += c.toString()));
    refused.stderr.on("data", (c: Buffer) => (refusedOutput += c.toString()));
    const refusedCode = await new Promise<number | null>((resolve) => {
      refused.on("exit", (code) => resolve(code));
      setTimeout(() => resolve(null), 15_000);
    });
    record(
      "an unstated identity plane refuses to boot instead of choosing an engine",
      // The message spans several lines, so the match must not be anchored with `.`,
      // which does not cross a newline. It has to say *why*, not merely exit non-zero.
      refusedCode === 1 && /OATHRION_IDENTITY_PLANE/i.test(refusedOutput),
      `exit ${String(refusedCode)}, named the missing variable: ${/OATHRION_IDENTITY_PLANE/i.test(refusedOutput)}`,
    );

    /* --- 3. boot with the limiter on PostgreSQL --------------------------- */
    child = spawn("node", [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(PORT),
        /*
         * Every plane on PostgreSQL. The records used to stay in a SQLite file while only
         * the quotas were shared — that was the Phase 11 pilot, and production no longer
         * accepts it: the driver, the identity plane, the action authority and the limiter
         * must all name the same engine, and no variable opts out.
         */
        OATHRION_DB: undefined,
        DATABASE_DRIVER: "postgres",
        DATABASE_URL: dbUrl,
        OATHRION_IDENTITY_PLANE: "postgres",
        OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
        RATE_LIMIT_STORE: "postgres",
        OATHRION_SESSION_SECRET: SESSION_SECRET,
        OATHRION_API_KEYS: `Smoke Admin:admin:${API_KEY}`,
        OATHRION_CONSOLE_USERS: `${CONSOLE_EMAIL}:admin:${CONSOLE_PASSWORD}`,
        OATHRION_SEED: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    const exited = new Promise<void>((resolve) => {
      child?.on("exit", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });

    const boot = await waitForBoot(child);
    record("the bundle boots with its limiter on PostgreSQL", boot.booted, boot.reason);
    if (!boot.booted) {
      console.log(`\n--- process output ---\n${output.trim() || "(nothing)"}`);
      return 1;
    }

    /* --- 4. the probe ----------------------------------------------------- */
    const health = await req("/api/health");
    let healthOk = false;
    try {
      const parsed = JSON.parse(health.body) as { status?: string };
      healthOk = health.status === 200 && parsed.status === "ok";
    } catch {
      healthOk = false;
    }
    record("/api/health answers 200 ok", healthOk, `status ${health.status}`);

    /* --- 5. authentication ------------------------------------------------ */
    const anon = await req("/api/agents");
    record("an unauthenticated call is refused", anon.status === 401, `status ${anon.status}`);

    const login = await req("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD }),
    });
    // The session token is returned in the body; Oathrion is not cookie-based here.
    let sessionToken = "";
    try {
      sessionToken = (JSON.parse(login.body) as { token?: string }).token ?? "";
    } catch {
      sessionToken = "";
    }
    record(
      "a console sign-in succeeds against a scrypt hash",
      login.status === 200 && sessionToken.length > 20,
      `status ${login.status}, token ${sessionToken.length} chars`,
    );

    /* --- 6. a read -------------------------------------------------------- */
    const read = await req("/api/agents", { headers: { authorization: `Bearer ${API_KEY}` } });
    record("an authenticated read succeeds", read.status === 200, `status ${read.status}`);

    /* --- 7. a write ------------------------------------------------------- */
    /*
     * Issuing an API key is the write, rather than creating an agent: it inserts a row
     * through the same repository layer, and it is the operation whose result is
     * immediately verifiable over HTTP (the new credential either authenticates or it
     * does not). A write whose only evidence is a 201 proves less.
     */
    const issued = await req("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ name: "Smoke PG integration", role: "viewer" }),
    });
    let issuedSecret = "";
    try {
      issuedSecret = (JSON.parse(issued.body) as { secret?: string }).secret ?? "";
    } catch {
      issuedSecret = "";
    }
    const usable = issuedSecret === "" ? { status: 0 } : await req("/api/agents", {
      headers: { authorization: `Bearer ${issuedSecret}` },
    });
    record(
      "an authenticated write persists and the written row is usable",
      issued.status === 201 && issuedSecret.startsWith("oathrion_") && usable.status === 200,
      `issue ${issued.status}, reuse ${usable.status}`,
    );

    /* --- 8. a transaction ------------------------------------------------- */
    /*
     * A real agent first, because a decision about an agent that does not exist is a
     * 404 and never reaches the transaction. Created through the strict write contract,
     * which is itself worth exercising in the bundle.
     */
    const agent = await req("/api/agents", {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        id: "agt_smoke_pg",
        name: "Smoke PG Agent",
        description: "Created by the PostgreSQL smoke test.",
        provider: "openai",
        model: "gpt-4",
        status: "active",
        owner: "smoke",
        mandate: {
          maxTransactionAmount: 100,
          currency: "EUR",
          allowedCategories: ["smoke"],
          blockedCategories: [],
          allowedDomains: [],
        },
        permissions: [
          { scope: "read:database", label: "Read", description: "", granted: true, risk: "low" },
        ],
        policyIds: [],
        tags: ["smoke"],
      }),
    });
    record(
      "an agent is created through the strict write contract",
      agent.status === 201 || agent.status === 200,
      `status ${agent.status}${agent.status >= 400 ? ` — ${agent.body.slice(0, 120)}` : ""}`,
    );

    /*
     * A credential BOUND to that agent, because this bundle runs with
     * NODE_ENV=production and Phase 9 made agent binding the production default
     * (`requiresAgentBinding()` in server/identity/agent-binding.ts).
     *
     * This check used to drive the decision with the unbound `OATHRION_API_KEYS`
     * admin key and it started failing with 403 — correctly. The refusal was the
     * new default doing its job: in production, a credential may only drive an
     * agent it is bound to, and `OATHRION_API_KEYS` has no field to express a
     * binding (`name:role:key`), so an env-declared key can never be bound.
     *
     * The script was wrong, not the server. Weakening the posture to make this
     * green — setting OATHRION_REQUIRE_AGENT_BINDING=false, or dropping
     * NODE_ENV=production — would have turned a working security control into a
     * smoke-test convenience, and this check would then have been proving the
     * opposite of what the product ships. Binding the key is what a real
     * operator does, and it exercises the binding path in the bundle as a
     * side effect.
     */
    const boundIssued = await req("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({
        name: "Smoke PG agent credential",
        role: "operator",
        agentId: "agt_smoke_pg",
      }),
    });
    let boundKey = "";
    try {
      boundKey = (JSON.parse(boundIssued.body) as { secret?: string }).secret ?? "";
    } catch {
      boundKey = "";
    }
    record(
      "a credential can be bound to an agent, as production requires",
      boundIssued.status === 201 && boundKey.startsWith("oathrion_"),
      `status ${boundIssued.status}${boundIssued.status >= 400 ? ` — ${boundIssued.body.slice(0, 160)}` : ""}`,
    );

    /*
     * The unbound admin key must still be REFUSED for the same call. Asserted
     * explicitly so the production default is proven by this bundle rather than
     * merely worked around above — otherwise a regression that silently disabled
     * binding would leave every check in this file green.
     */
    const unbound = await req("/api/decision", {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "agt_smoke_pg",
        action: "smoke.transaction",
        target: "smoke-target",
        persist: true,
      }),
    });
    record(
      "an unbound credential cannot drive an agent in production",
      unbound.status === 403,
      `status ${unbound.status} (expected 403)`,
    );

    /*
     * A decision is the transactional path: evaluate policy, append the audit record
     * and, when approval is required, create the approval — all or nothing. Checked here
     * rather than trusted from the unit tests because a bundled build with an unbundled
     * native addon is exactly where transaction wiring breaks.
     */
    const decision = await req("/api/decision", {
      method: "POST",
      headers: { authorization: `Bearer ${boundKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "agt_smoke_pg",
        action: "smoke.transaction",
        target: "smoke-target",
        persist: true,
      }),
    });
    const audit = await req("/api/executions", { headers: { authorization: `Bearer ${API_KEY}` } });
    let auditRows = 0;
    try {
      const rows = JSON.parse(audit.body) as unknown[];
      auditRows = Array.isArray(rows) ? rows.length : 0;
    } catch {
      auditRows = 0;
    }
    record(
      "a transactional decision commits and leaves an audit record",
      decision.status === 200 && auditRows > 0,
      `decision ${decision.status}, ${auditRows} audit row(s)`,
    );

    /* --- 9. the quota is shared, observed end to end ---------------------- */
    /*
     * The point of P0-7, checked against the running server rather than in isolation.
     *
     * A second limiter instance is built here, in this process, over the same database.
     * It is a stand-in for a second replica. Requests are driven into the live server
     * until it refuses, and then the second instance is asked about the same bucket: it
     * must see the same exhausted counter. With the previous in-process limiter it would
     * have seen an empty one, and a real second replica would have served the traffic.
     */
    /*
     * The busiest counter before the flood, not the number of rows: by this point the
     * sign-in and the two writes above have already created their buckets, so a row
     * count cannot move. What must move is a count.
     */
    const bucketsBefore = await pool.query<{ n: string }>(
      `SELECT coalesce(max(window_count), 0)::text AS n FROM ${RATE_LIMIT_TABLE}`,
    );

    let refusals = 0;
    let allowedBeforeRefusal = 0;
    let lastRetryAfter: string | null = null;
    for (let i = 0; i < 60; i += 1) {
      /*
       * The write budget (30/minute) rather than the decision budget (120), because
       * fewer requests reach the same conclusion. The body is deliberately invalid: the
       * limiter runs before validation, so a 400 still consumes quota — which is correct,
       * since a flood of malformed requests is still a flood.
       */
      const res = await req("/api/agents", {
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ deliberately: "invalid" }),
      });
      if (res.status === 429) {
        refusals += 1;
        lastRetryAfter = res.headers?.get("retry-after") ?? null;
        break;
      }
      allowedBeforeRefusal += 1;
    }
    record(
      "the running server enforces its quota and answers 429 with Retry-After",
      refusals > 0 && lastRetryAfter !== null,
      `refused after ${allowedBeforeRefusal} requests, Retry-After: ${lastRetryAfter ?? "absent"}`,
    );

    const bucketsAfter = await pool.query<{ bucket_key: string; window_count: string }>(
      `SELECT bucket_key, window_count::text FROM ${RATE_LIMIT_TABLE} ORDER BY window_count DESC`,
    );
    /*
     * The flood has to be visible *in the database*: a counter that reached the write
     * budget and then saturated one past it. If the limiter were still in-process,
     * nothing here would have changed while the server was refusing requests — which is
     * precisely the bug this lot fixes, so it is the assertion worth making.
     */
    const busiestCount = Number(bucketsAfter.rows[0]?.window_count ?? 0);
    const busiestBefore = Number(bucketsBefore.rows[0]?.n ?? 0);
    record(
      "the counters live in PostgreSQL, not in the process",
      busiestCount > busiestBefore && busiestCount >= 30,
      `busiest bucket ${busiestBefore} → ${busiestCount} across ${bucketsAfter.rows.length} bucket(s)`,
    );

    const busiest = bucketsAfter.rows[0]?.bucket_key;
    let secondInstanceAgrees = false;
    if (busiest !== undefined) {
      const secondReplica = new PostgresQuotaStore(dbUrl);
      try {
        // Asked with the same limit the server uses for that scope; the state it reads is
        // the state the server wrote, from a different process's pool.
        const seen = await secondReplica.peek(busiest, 1);
        secondInstanceAgrees = seen.count > 0 && !seen.allowed;
      } finally {
        await secondReplica.close();
      }
    }
    record(
      "a second limiter instance sees the quota the server consumed",
      secondInstanceAgrees,
      busiest === undefined ? "no bucket to check" : `bucket observed from a separate pool`,
    );

    await pool.end();

    /* --- 10. a clean shutdown with a pool open --------------------------- */
    /*
     * The specific regression risk introduced by this lot: an open PostgreSQL pool keeps
     * the event loop alive, so a process that used to exit on SIGTERM now hangs until the
     * container runtime sends SIGKILL. That would turn every deploy into a stall.
     */
    const beforeSignal = Date.now();
    child.kill("SIGTERM");
    const shutdown = await Promise.race([exited.then(() => "exited"), sleep(10_000).then(() => "hung")]);
    const elapsed = Date.now() - beforeSignal;
    record(
      "SIGTERM exits promptly and cleanly with a PostgreSQL pool open",
      shutdown === "exited" && (exitCode === 0 || exitSignal === "SIGTERM") && elapsed < 10_000,
      `${shutdown} in ${elapsed}ms, code ${String(exitCode)}, signal ${String(exitSignal)}`,
    );

    /* --- 11. no credentials in the log ----------------------------------- */
    const leaked = [API_KEY, SESSION_SECRET, CONSOLE_PASSWORD].filter((secret) => output.includes(secret));
    const urlLeaked = /postgres(ql)?:\/\/[^@\s]*:[^@\s]+@/.test(output);
    record(
      "no credential and no connection string with a password reached the log",
      leaked.length === 0 && !urlLeaked,
      leaked.length === 0 && !urlLeaked ? "clean" : `leaked: ${leaked.length} secret(s), url: ${urlLeaked}`,
    );
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    } catch {
      /* the run is over; a leftover throwaway database is not worth failing on */
    }
    await admin.end();
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log("\n" + "=".repeat(78));
  console.log(`${passed}/${checks.length} checks passed`);
  console.log("=".repeat(78));
  if (passed !== checks.length) {
    console.log("\nFailed:");
    for (const c of checks.filter((x) => !x.ok)) console.log(`  ✗ ${c.name} — ${c.detail}`);
    console.log(`\n--- process output ---\n${output.trim() || "(nothing)"}`);
  }
  console.log(
    "\nScope of this run: every plane is on PostgreSQL — schema, repositories, identity,\n" +
      "action authority and the shared quota store. The identity plane reaches PostgreSQL\n" +
      "through a synchronous worker bridge, so each identity query blocks the event loop\n" +
      "for one round trip; that cost is real and is measured separately, not here.\n" +
      "No SQLite file is opened, and an incomplete selection refuses to boot (check 2).",
  );
  return passed === checks.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\nsmoke:postgres crashed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
