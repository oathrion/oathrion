/*
 * ============================================================================
 *  PILOT SIMULATION — 100 companies, first three months
 * ============================================================================
 *
 * `npm run pilot`
 *
 * This harness exists to answer the one question the rest of the verification
 * deliberately does not: **what does Oathrion actually do when a pilot programme
 * runs on it for three months?** The suite proves the code is correct on a fresh
 * database. The smoke test proves the shipped binary boots. The mutation audit
 * proves the tests hold something. The chaos bench proves a broken environment
 * fails loudly. None of them run the software with three months of accumulated
 * data in it, and none of them say how many companies one host can carry.
 *
 * Those were risks 1 and 6 of the final report, both filed as "reasoned, never
 * measured". This file measures them.
 *
 * ---------------------------------------------------------------------------
 *  THE TOPOLOGY — MEASURED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * One structural fact decides the entire shape of the simulation: whether 100
 * pilot companies mean one instance or a hundred.
 *
 * This file used to conclude "a hundred": at the time, no table carried a tenant
 * column, `GET /api/agents` was `repositories.agents.list()` with no request
 * context, and phase A measured company B reading company A's agents. That
 * measurement was real and it is why P0-1 exists.
 *
 * Since P0-1 every tenant-scoped table carries a NOT NULL `organization_id`, the
 * repository layer takes the organization in its constructor rather than in each
 * call, and the organization comes from the credential. Phase A therefore no
 * longer documents a boundary's absence — it tries to cross the boundary and
 * reports whether it held. It creates two organizations in one instance and has a
 * fully privileged admin of the second one attempt to read the first one's agent.
 *
 * The consequence for the cost model is the reason this matters: if the boundary
 * holds, 100 companies can share one instance and the capacity numbers below
 * describe a shared deployment; if it does not, the pilot is 100 processes on 100
 * database files. Phase A decides which, and it fails the run if the boundary
 * leaks.
 *
 * Everything after phase A measures **one instance carrying one company's
 * volume**, which remains the useful unit either way.
 *
 * ---------------------------------------------------------------------------
 *  WORKLOAD MODEL — stated so it can be argued with
 * ---------------------------------------------------------------------------
 * A model nobody can inspect is a model nobody should trust. Every number below
 * is a parameter at the top of this file, not a constant buried in a loop.
 *
 *   100 companies × 8 agents × 200 decisions/agent/day = 1 600 decisions/day
 *   per company, over 90 days → 144 000 executions per instance, and 14.4 M
 *   across the pilot.
 *
 * 8 agents matches the shipped `config` seed. 200 decisions per agent per day is
 * roughly one every seven minutes of a working day — deliberately chosen as
 * *plausible but not conservative*, because a capacity claim built on a gentle
 * number is worth nothing.
 *
 * ---------------------------------------------------------------------------
 *  METHOD — and why the ageing is done with direct inserts
 * ---------------------------------------------------------------------------
 * Phase C fast-forwards three months by writing execution rows straight into
 * SQLite rather than driving 144 000 HTTP requests. This is not a shortcut that
 * weakens the result, and the distinction matters:
 *
 *   - What is being measured is **the latency of a real HTTP decision against a
 *     database that already holds three months of rows.** The rows are the
 *     independent variable; how they got there is irrelevant to the read plan.
 *   - Driving them through HTTP would measure this harness's own request loop,
 *     not the server, and would take hours in a sandbox that stops at 630 s.
 *   - `script/bench-daily-spend.ts` already established this method for the same
 *     query. Phases B and D use the **real HTTP endpoint on the real bundle**,
 *     so the measured latency is end-to-end and includes Express, auth, policy
 *     evaluation, the transaction and the insert.
 *
 * The honest limitation, stated here rather than discovered later: the aged rows
 * are synthetic, so they exercise row *volume* and index selectivity, not the
 * exact value distribution a real customer would produce.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
// The organization the raw inserts below must be attributed to. Imported rather
// than written as "org_default" so the sim cannot drift from the product's own
// definition of the default tenant.
import { DEFAULT_ORGANIZATION_ID } from "../shared/tenancy";

/* ------------------------------ Parameters -------------------------------- */

const COMPANIES = 100;
const AGENTS_PER_COMPANY = 8;
const DECISIONS_PER_AGENT_PER_DAY = 200;
const DAYS = 90;

/** Share of decisions that land in an approval queue rather than resolving outright. */
const APPROVAL_RATE = 0.04;
/** Share of approvals a busy operator never gets round to. This is what builds a backlog. */
const APPROVAL_ABANDON_RATE = 0.25;

const DECISIONS_PER_COMPANY_PER_DAY = AGENTS_PER_COMPANY * DECISIONS_PER_AGENT_PER_DAY;
const EXECUTIONS_PER_INSTANCE = DECISIONS_PER_COMPANY_PER_DAY * DAYS;

/** How many real HTTP decisions each latency sample takes. */
const LATENCY_SAMPLES = 400;
/** Parallel clients for the contention phase. */
const CONCURRENT_CLIENTS = 32;
/** Requests each concurrent client issues. */
const REQUESTS_PER_CLIENT = 25;

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE = join(ROOT, "dist", "index.cjs");

const API_KEY = "pilot-api-key-0123456789abcdef";
/* A second organization's admin key. Same privilege level as the first — the point
 * of phase A is that privilege does not cross a tenant boundary, so testing with a
 * viewer would be testing the wrong thing. */
const RIVAL_KEY = "pilot-rival-key-0123456789abcd";
const CONSOLE_PASSWORD = "pilot-console-password-0123";

/*
 * The decision rate limit is 120 requests per minute **keyed by the authenticated
 * identity** (`server/rate-limit/index.ts`, `quotaKey` → `identity.id`). That is a
 * pilot-relevant fact in itself, recorded as a finding below: a company whose
 * eight agents share one API key shares one 120/min bucket between them.
 *
 * For measurement it is also a trap. Firing 400 samples down one credential would
 * measure the limiter, not the decision engine. So the harness issues one
 * credential per simulated agent and rotates — which is exactly how a correctly
 * configured pilot tenant would be provisioned anyway.
 */
const LOAD_KEYS = Array.from(
  { length: 40 },
  (_, i) => `pilot-load-key-${String(i).padStart(4, "0")}-abcdef`,
);
// Unprefixed, like the admin key: these are the credentials that actually issue the
// measured decisions, so they must resolve to the organization the seed populated.
// See the note on `OATHRION_API_KEYS` in `launch`.
const LOAD_KEY_SPEC = LOAD_KEYS.map((k, i) => `loader${i}:admin:${k}`).join(",");

let nextPort = 5600;

/* -------------------------------- Utilities -------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "placet-pilot-"));
}

interface Instance {
  port: number;
  dbPath: string;
  // stdin is `ignore`, so this is not `ChildProcessWithoutNullStreams`: the child
  // has no writable stdin and the type has to say so.
  child: ChildProcessByStdio<null, Readable, Readable>;
  output: () => string;
  rssKb: () => number | null;
  stop: () => Promise<void>;
}

function launch(port: number, dbPath: string, extra: Record<string, string> = {}): Instance {
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      /*
       * Stated rather than inherited, and deliberately NOT production.
       *
       * This simulator measures the SQLite engine specifically: it ages rows with
       * better-sqlite3, reads the database file's size off disk, and counts tables in
       * it. Those measurements have no PostgreSQL equivalent, so unlike smoke and e2e
       * this script was not moved to PostgreSQL — and since Phase 12.2, production
       * means PostgreSQL on every plane, so it cannot run in production mode.
       *
       * What that costs, stated plainly: the figures below describe the SQLite
       * development engine outside production mode, not a production deployment. A
       * PostgreSQL capacity study is a separate piece of work and is not in this file.
       */
      NODE_ENV: "development",
      PORT: String(port),
      OATHRION_DB: dbPath,
      /*
       * Two organizations. The `Org Name/` prefix on the credential name is what
       * binds a key to a tenant (see `parseTriples`), so a second tenant needs no
       * extra configuration surface — just a second key.
       *
       * THE MEASURING CREDENTIALS DELIBERATELY CARRY NO PREFIX. An unprefixed name
       * binds to `DEFAULT_ORGANIZATION_ID`, and that is the organization
       * `OATHRION_SEED=config` writes into (`seedConfig(db, org = DEFAULT_ORGANIZATION_ID)`).
       * When these keys were `Acme/…` they resolved to `org_acme` while the seeded
       * `agt_procurement` sat in `org_default`, so every decision in phases B and D
       * answered `404 Unknown agent "agt_procurement"` — 400 failures out of 400
       * samples, reported as `p50 0.0 ms`. Tenant isolation was working exactly as
       * designed; the bench was asking the wrong tenant.
       *
       * Phase A still has the two distinct tenants it needs: the default
       * organization on one side and `Rival` on the other.
       */
      OATHRION_API_KEYS: `Pilot Admin:admin:${API_KEY},Rival/Rival Admin:admin:${RIVAL_KEY},${LOAD_KEY_SPEC}`,
      OATHRION_CONSOLE_USERS: `Pilot Admin:admin:${CONSOLE_PASSWORD}`,
      OATHRION_SESSION_SECRET: "pilot-session-secret-0123456789abcdef",
      OATHRION_SEED: "config",
      ...extra,
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr.on("data", (c: Buffer) => (out += c.toString()));
  return {
    port,
    dbPath,
    child,
    output: () => out,
    // Resident set size of the real process. This is the number that decides how
    // many instances fit on a host, so it is read from the kernel rather than
    // estimated.
    rssKb: () => {
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
        const m = /VmRSS:\s+(\d+) kB/.exec(status);
        return m ? Number(m[1]) : null;
      } catch {
        return null;
      }
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      for (let i = 0; i < 60 && child.exitCode === null; i += 1) await sleep(100);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

async function waitUntilServing(inst: Instance, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inst.child.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  return false;
}

interface Res {
  status: number;
  body: string;
  ms: number;
}

async function req(
  port: number,
  path: string,
  init: { method?: string; body?: string; key?: string | null } = {},
): Promise<Res> {
  const started = performance.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = init.key === undefined ? API_KEY : init.key;
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
    });
    // Read the body in full. An earlier harness in this repo truncated it and
    // reported a data-integrity fault that did not exist; never again.
    const body = await res.text();
    return { status: res.status, body, ms: performance.now() - started };
  } catch (err) {
    return { status: 0, body: String(err), ms: performance.now() - started };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
    mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
  };
}

const ms = (v: number): string => `${v.toFixed(1)} ms`;
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const int = (v: number): string => v.toLocaleString("en-US");

/* --------------------------- The decision payload -------------------------- */

/*
 * `agt_procurement` carries a 500 EUR per-transaction mandate and the org policy
 * `pol_api_spend` caps daily spend at 500 EUR.
 *
 * The amount is 0, and that is the whole point. The first version of this harness
 * sent 1 EUR, which looked harmless and silently destroyed the measurement: the
 * 400 requests of phase B spent 400 EUR of *today's* ceiling, so by phase D every
 * request was over the cap and returned BLOCK. BLOCK short-circuits before the
 * execution is written, so phase D was timing a cheaper code path than phase B
 * and the resulting "x1.11, no degradation" was meaningless — it could have
 * concealed real degradation entirely.
 *
 * A zero amount keeps the verdict pinned to ALLOW no matter how many samples are
 * taken, in either phase, while still being a financial verb that runs the
 * `dailySpend` aggregate over the full aged row set. The row volume — the actual
 * independent variable — is untouched. The comparability guard in phase D refuses
 * to report a ratio at all if the two phases still disagree on the verdict.
 *
 * The target and category also matter, and the first two attempts got them wrong.
 * `target: "software"` is not a resolvable destination, so the mandate's domain
 * check blocked it fail-closed — correct behaviour, but it meant both phases were
 * timing the short BLOCK path and the aged aggregate was never touched at all.
 * `supplier-x.com` with "Office supplies" is inside the seeded Procurement mandate
 * (the shape `server/test/gateway.test.ts` uses for its ALLOW case), so the
 * decision runs the full length of the engine: mandate, domain, category, daily
 * spend, then the persisted write.
 */
function decisionBody(): string {
  return JSON.stringify({
    agentId: "agt_procurement",
    action: "purchase",
    target: "supplier-x.com",
    persist: true,
    metadata: { amount: 0, currency: "EUR", category: "Office supplies" },
  });
}

/** The dominant verdict, so two phases can be checked for path equivalence. */
function dominantOutcome(outcomes: Record<string, number>): string {
  return Object.entries(outcomes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
}

async function measureDecisionLatency(port: number, samples: number): Promise<{
  stats: Stats;
  outcomes: Record<string, number>;
  failures: number;
}> {
  const durations: number[] = [];
  const outcomes: Record<string, number> = {};
  let failures = 0;
  for (let i = 0; i < samples; i += 1) {
    const res = await req(port, "/api/decision", {
      method: "POST",
      body: decisionBody(),
      key: LOAD_KEYS[i % LOAD_KEYS.length],
    });
    if (res.status !== 200) {
      failures += 1;
      continue;
    }
    durations.push(res.ms);
    try {
      const decision = (JSON.parse(res.body) as { decision?: string }).decision ?? "?";
      outcomes[decision] = (outcomes[decision] ?? 0) + 1;
    } catch {
      outcomes["unparseable"] = (outcomes["unparseable"] ?? 0) + 1;
    }
  }
  return { stats: stats(durations), outcomes, failures };
}

/* ------------------------- Phase C: fast-forward 3 months ------------------ */

/*
 * Writes `EXECUTIONS_PER_INSTANCE` execution rows and the matching approval rows
 * spread across `DAYS` days, ending today. The server must be stopped first: two
 * writers on one file is a different experiment (the chaos bench owns it).
 */
function ageDatabase(dbPath: string): { executions: number; approvals: number; elapsedMs: number } {
  const started = performance.now();
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  /*
   * `organization_id` LEADS BOTH INSERTS, and it is not merely there to satisfy a
   * constraint.
   *
   * Migration `003-tenancy` added `organization_id text NOT NULL` to every
   * tenant-scoped table with a composite primary key `(organization_id, id)`, so
   * these raw inserts — which bypass the repository layer that would otherwise
   * supply it — failed with `NOT NULL constraint failed: executions.organization_id`.
   *
   * Filling it with any value would have stopped the crash and quietly broken the
   * experiment instead. Every measured read now leads with `organization_id = ?`
   * and is served by `idx_executions_org_ts` / `idx_executions_org_spend`, so rows
   * written under a different tenant are invisible to the phase D decision: the
   * ageing would appear to succeed while phase D measured a table that, from the
   * caller's point of view, was still empty. The value must therefore be the
   * organization the measuring credentials resolve to — the default one.
   *
   * The column list is read from `server/migrations/` (001-baseline plus 003-tenancy),
   * not from `server/db.ts`, where the DDL no longer lives.
   */
  const insertExec = db.prepare(
    `INSERT INTO executions
       (organization_id, id, agent_id, agent_name, action, target, status, risk,
        duration_ms, cost, timestamp, input, decision, decision_reason, result, audit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, '', '', '[]')`,
  );
  // The approvals table has `title`/`summary`/`requested_value`, not action/target.
  const insertApproval = db.prepare(
    `INSERT INTO approvals
       (organization_id, id, execution_id, agent_id, agent_name, title, summary,
        requested_value, policy_id, policy_name, policy_limit, risk, status,
        requested_at, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
  );

  // Only `allowed` rows count toward daily spend, so a realistic mix is required:
  // an all-allowed table would understate how many rows the aggregate must skip.
  const STATUSES = ["allowed", "allowed", "blocked", "failed", "allowed"] as const;
  const DECISIONS = ["ALLOW", "ALLOW", "BLOCK", "ALLOW", "APPROVAL_REQUIRED"] as const;

  const now = Date.now();
  const spanMs = DAYS * 24 * 60 * 60 * 1000;
  let approvals = 0;

  const write = db.transaction(() => {
    for (let i = 0; i < EXECUTIONS_PER_INSTANCE; i += 1) {
      const ts = new Date(now - spanMs + Math.floor((i / EXECUTIONS_PER_INSTANCE) * spanMs));
      const agent = `agt_sim_${i % AGENTS_PER_COMPANY}`;
      insertExec.run(
        DEFAULT_ORGANIZATION_ID,
        `exec_sim_${i}`,
        // Every eighth agent is the real seeded procurement agent, so the aged
        // rows actually land in the partition the measured query reads.
        i % AGENTS_PER_COMPANY === 0 ? "agt_procurement" : agent,
        `Sim Agent ${i % AGENTS_PER_COMPANY}`,
        "purchase",
        "software",
        STATUSES[i % STATUSES.length],
        "medium",
        (i % 400) + 10,
        // Procurement rows are costed at zero on purpose. They must still be
        // *counted* by the `dailySpend` aggregate — that is the point of the
        // ageing — but if they also summed to real money, today's slice would
        // breach the 500 EUR/day org ceiling and phase D would measure the BLOCK
        // path while phase B measured ALLOW. A latency comparison across two
        // different code paths is worthless, so the row volume is held identical
        // and only the money is neutralised.
        i % AGENTS_PER_COMPANY === 0 ? 0 : (i % 23) + 1,
        ts.toISOString(),
        DECISIONS[i % DECISIONS.length],
      );
      if (i % Math.round(1 / APPROVAL_RATE) === 0) {
        // A quarter are never resolved: that is the backlog an operator inherits.
        const abandoned = approvals % Math.round(1 / APPROVAL_ABANDON_RATE) === 0;
        insertApproval.run(
          DEFAULT_ORGANIZATION_ID,
          `apr_sim_${i}`,
          `exec_sim_${i}`,
          agent,
          `Sim Agent ${i % AGENTS_PER_COMPANY}`,
          "Purchase software licence",
          "Simulated pilot traffic",
          "1 EUR",
          "pol_api_spend",
          "API spend ceiling",
          "500 EUR/day",
          "high",
          abandoned ? "pending" : "approved",
          ts.toISOString(),
        );
        approvals += 1;
      }
    }
  });
  write();
  const execCount = (db.prepare("SELECT count(*) AS n FROM executions").get() as { n: number }).n;
  const aprCount = (db.prepare("SELECT count(*) AS n FROM approvals").get() as { n: number }).n;
  db.close();
  return { executions: execCount, approvals: aprCount, elapsedMs: performance.now() - started };
}

function tableCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  const out: Record<string, number> = {};
  for (const t of ["agents", "policies", "executions", "approvals", "sessions", "integrations"]) {
    out[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  out["approvals_pending"] = (
    db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get() as {
      n: number;
    }
  ).n;
  db.close();
  return out;
}

function dbBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) total += statSync(p).size;
  }
  return total;
}

/* ------------------------------- The phases -------------------------------- */

interface Finding {
  severity: "ok" | "note" | "WARN" | "BLOCKER";
  text: string;
}

const findings: Finding[] = [];
const note = (severity: Finding["severity"], text: string): void => {
  findings.push({ severity, text });
};

function header(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

/*
 * Phase A — try to cross the tenant boundary in a shared instance.
 *
 * Two organizations, one instance, one database. A fully privileged admin of the
 * second organization attempts to read the first one's agent. Anything other than
 * "absent" is a breach and fails the run, because the deployment topology and the
 * entire cost model below depend on this answer.
 */
async function phaseTopology(): Promise<void> {
  header("PHASE A — does the tenant boundary hold in a shared instance?");
  const inst = launch(nextPort++, join(tempDir(), "data.db"));
  if (!(await waitUntilServing(inst))) {
    console.log("  instance would not boot; phase skipped");
    await inst.stop();
    note("WARN", "Phase A could not run: the instance did not boot.");
    return;
  }

  const acme = await req(inst.port, "/api/agents", {
    method: "POST",
    body: JSON.stringify({
      id: "agt_acme_payroll",
      name: "ACME Payroll Bot",
      description: "Company A. Its existence must not be visible to company B.",
      provider: "openai",
      model: "gpt-4o",
      status: "active",
      owner: "cfo@acme.example",
      // `mandateSchema` is a strictObject with no defaults for these two lists.
      // Omitting them returned 400, which made the first version of this phase
      // vacuous: nothing was written, so "no leak" proved nothing. The assertion
      // below now refuses to conclude unless the setup write really succeeded.
      mandate: {
        maxTransactionAmount: 250,
        currency: "EUR",
        allowedCategories: ["Software"],
        blockedCategories: [],
        allowedDomains: [],
      },
      permissions: [],
      policyIds: [],
      tags: ["company-a"],
    }),
  });

  if (acme.status !== 201) {
    console.log(`  SETUP FAILED: company A's agent was not created (${acme.status})`);
    console.log(`  ${acme.body.slice(0, 300)}`);
    await inst.stop();
    note(
      "WARN",
      `Phase A is inconclusive: the setup write returned ${acme.status}, so no isolation claim ` +
        `can be made either way. Not reported as "isolated".`,
    );
    return;
  }

  // Every read a privileged outsider has: the collection, the single row, and the
  // audit stream, which is the one that carries another company's inputs verbatim.
  const list = await req(inst.port, "/api/agents", { key: RIVAL_KEY });
  const byId = await req(inst.port, "/api/agents/agt_acme_payroll", { key: RIVAL_KEY });
  const audit = await req(inst.port, "/api/audit", { key: RIVAL_KEY });
  // And a write, because a boundary that only filters reads is not a boundary.
  const write = await req(inst.port, "/api/agents/agt_acme_payroll", {
    method: "PATCH",
    key: RIVAL_KEY,
    body: JSON.stringify({ status: "paused" }),
  });
  const ownerAfter = await req(inst.port, "/api/agents/agt_acme_payroll");

  await inst.stop();

  const idLeaked = list.body.includes("agt_acme_payroll") || byId.body.includes("agt_acme_payroll");
  const ownerLeaked =
    list.body.includes("cfo@acme.example") ||
    byId.body.includes("cfo@acme.example") ||
    audit.body.includes("cfo@acme.example");
  const stillActive = ownerAfter.body.includes('"status":"active"');

  console.log(`  company A wrote an agent                  → ${acme.status}`);
  console.log(`  B's admin lists agents                    → ${list.status}`);
  console.log(`  B's admin reads A's agent by id           → ${byId.status} (expected 404)`);
  console.log(`  B's admin reads the audit stream          → ${audit.status}`);
  console.log(`  B's admin patches A's agent               → ${write.status} (expected 404)`);
  console.log(`  A's identifier visible to B               → ${idLeaked ? "YES" : "no"}`);
  console.log(`  A's owner e-mail visible to B             → ${ownerLeaked ? "YES" : "no"}`);
  console.log(`  A's agent still active after B's write    → ${stillActive ? "yes" : "NO"}`);

  const clean =
    !idLeaked && !ownerLeaked && stillActive && byId.status === 404 && write.status === 404;

  if (clean) {
    console.log(
      "\n  CONCLUSION: the boundary held under a privileged cross-tenant attempt.\n" +
        "  A shared instance is therefore a supported topology, and the capacity\n" +
        "  numbers below describe one shared deployment rather than one per company.",
    );
  } else {
    console.log(
      "\n  CONCLUSION: the tenant boundary leaked. A shared instance would expose one\n" +
        "  company's agents, mandates or audit trail to another. Until this is fixed the\n" +
        "  pilot MUST be one instance per company.",
    );
    note(
      "BLOCKER",
      `Cross-tenant access succeeded in a shared instance (id leaked: ${idLeaked}, owner ` +
        `leaked: ${ownerLeaked}, foreign write applied: ${!stillActive}). P0-1 has regressed.`,
    );
  }
}

/** Phase B/D — real HTTP decision latency, cold then aged. */
async function phaseLatency(): Promise<void> {
  header("PHASE B — decision latency on a fresh instance (day 1)");
  const dir = tempDir();
  const dbPath = join(dir, "data.db");
  let inst = launch(nextPort++, dbPath);
  if (!(await waitUntilServing(inst))) {
    console.log(`  instance would not boot:\n${inst.output().slice(-400)}`);
    await inst.stop();
    note("WARN", "Latency phases could not run: the instance did not boot.");
    return;
  }

  const cold = await measureDecisionLatency(inst.port, LATENCY_SAMPLES);
  const coldRss = inst.rssKb();
  console.log(`  ${int(cold.stats.n)} real HTTP decisions`);
  console.log(
    `  p50 ${ms(cold.stats.p50)}   p95 ${ms(cold.stats.p95)}   p99 ${ms(cold.stats.p99)}   max ${ms(cold.stats.max)}`,
  );
  console.log(`  outcomes ${JSON.stringify(cold.outcomes)}   failures ${cold.failures}`);
  console.log(`  RSS ${coldRss ? `${(coldRss / 1024).toFixed(0)} MB` : "?"}   DB ${mb(dbBytes(dbPath))}`);

  /*
   * A measurement of nothing is not a measurement. With every sample refused, the
   * lines above printed `p50 0.0 ms` — which reads like a very fast system rather
   * than a harness that never reached one — and the run carried on to age the
   * database and "compare" phase D against it.
   *
   * Stopping here rather than continuing: without a phase B baseline there is
   * nothing for phase D to be compared to, so the remaining work would only produce
   * more numbers of the same kind. Exit stays 0 by the deliberate contract at the end
   * of `main` — this harness reports, it does not gate — but it now reports the truth.
   */
  if (cold.stats.n === 0) {
    console.log(
      `\n  NOT MEASURED: all ${cold.failures} decision(s) were refused, so p50/p95/p99 above are` +
        ` zeros from an empty sample, not timings.`,
    );
    await inst.stop();
    note(
      "BLOCKER",
      `The latency phases did not run: all ${cold.failures} decision requests were refused, so no ` +
        `baseline exists and no capacity claim can be made. The reported 0.0 ms are an empty sample.`,
    );
    return;
  }

  // Stop before writing: one writer at a time.
  await inst.stop();

  header(`PHASE C — fast-forward ${DAYS} days of one company's traffic`);
  console.log(
    `  model: ${AGENTS_PER_COMPANY} agents × ${DECISIONS_PER_AGENT_PER_DAY} decisions/day` +
      ` × ${DAYS} days = ${int(EXECUTIONS_PER_INSTANCE)} executions`,
  );
  const aged = ageDatabase(dbPath);
  console.log(
    `  wrote ${int(aged.executions)} executions and ${int(aged.approvals)} approvals in ${(aged.elapsedMs / 1000).toFixed(1)} s`,
  );
  const counts = tableCounts(dbPath);
  console.log(`  rows now: ${JSON.stringify(counts)}`);
  console.log(`  database on disk: ${mb(dbBytes(dbPath))}`);

  header(`PHASE D — the SAME decision, on a database holding ${DAYS} days of data`);
  inst = launch(nextPort++, dbPath, { OATHRION_SEED: "none" });
  const bootStarted = performance.now();
  const bootedOk = await waitUntilServing(inst, 60_000);
  const bootMs = performance.now() - bootStarted;
  if (!bootedOk) {
    console.log(`  THE AGED INSTANCE DID NOT BOOT after ${(bootMs / 1000).toFixed(1)} s`);
    console.log(inst.output().slice(-600));
    await inst.stop();
    note("BLOCKER", `The instance failed to boot on a database holding ${DAYS} days of pilot data.`);
    return;
  }
  console.log(`  boot to serving: ${ms(bootMs)} (fresh instance booted in well under a second)`);

  const warm = await measureDecisionLatency(inst.port, LATENCY_SAMPLES);
  const warmRss = inst.rssKb();
  console.log(`  ${int(warm.stats.n)} real HTTP decisions`);
  console.log(
    `  p50 ${ms(warm.stats.p50)}   p95 ${ms(warm.stats.p95)}   p99 ${ms(warm.stats.p99)}   max ${ms(warm.stats.max)}`,
  );
  console.log(`  outcomes ${JSON.stringify(warm.outcomes)}   failures ${warm.failures}`);
  console.log(`  RSS ${warmRss ? `${(warmRss / 1024).toFixed(0)} MB` : "?"}`);

  // Same rule as phase B: an empty sample must not become a ratio.
  if (warm.stats.n === 0) {
    console.log(
      `\n  NOT MEASURED: all ${warm.failures} decision(s) were refused on the aged database.`,
    );
    await inst.stop();
    note(
      "BLOCKER",
      `Phase D took no sample: all ${warm.failures} decision requests against the aged database were ` +
        `refused, so no degradation ratio is reported.`,
    );
    return;
  }

  const ratio = cold.stats.p50 > 0 ? warm.stats.p50 / cold.stats.p50 : 0;
  console.log(`\n  p50 day 1 → day ${DAYS}: ${ms(cold.stats.p50)} → ${ms(warm.stats.p50)}  (×${ratio.toFixed(2)})`);

  // Guard against the exact mistake described above `decisionBody`: if the two
  // phases did not take the same decision path, the ratio compares two different
  // amounts of work and must not be reported as a degradation measurement.
  const coldPath = dominantOutcome(cold.outcomes);
  const warmPath = dominantOutcome(warm.outcomes);
  if (coldPath !== warmPath) {
    console.log(
      `\n  NOT COMPARABLE: phase B settled on ${coldPath}, phase D on ${warmPath}.` +
        ` Different code paths, so this ratio is discarded.`,
    );
    note(
      "WARN",
      `The latency comparison is void: phase B measured ${coldPath} and phase D measured ${warmPath}. ` +
        `No claim is made about degradation over ${DAYS} days.`,
    );
  } else if (ratio > 3) {
    note(
      "WARN",
      `Decision p50 degraded ×${ratio.toFixed(2)} once ${int(EXECUTIONS_PER_INSTANCE)} executions had ` +
        `accumulated (${ms(cold.stats.p50)} → ${ms(warm.stats.p50)}). A pilot would feel this by month three.`,
    );
  } else if (warmPath !== "ALLOW") {
    // ALLOW is the only verdict that runs the engine end to end and writes a row.
    // Anything else short-circuits, so the number would understate the cost.
    note(
      "WARN",
      `Both phases settled on ${warmPath}, not ALLOW. That path short-circuits before the daily-spend ` +
        `aggregate and the persisted write, so ×${ratio.toFixed(2)} understates the real decision cost ` +
        `and is not reported as a capacity result.`,
    );
  } else {
    note(
      "ok",
      `Decision p50 held within ×${ratio.toFixed(2)} across ${DAYS} days of accumulation ` +
        `(${ms(cold.stats.p50)} → ${ms(warm.stats.p50)}), p99 ${ms(warm.stats.p99)}, both phases on ` +
        `the same ${warmPath} path.`,
    );
  }

  /* -------- Phase G — what the console asks for on month-3 data -------- */
  /*
   * A decision is a single-row write and stays fast. The console is the opposite:
   * it asks for lists. On day one those lists are empty, which is why nothing in
   * the existing verification ever noticed how large they become. This phase asks
   * for exactly what the console asks for, against 90 days of rows, and measures
   * the bytes on the wire.
   */
  header("PHASE G — console list endpoints against 90 days of rows");
  const listPaths = [
    "/api/agents",
    "/api/policies",
    "/api/approvals",
    "/api/executions",
    "/api/audit",
    "/api/notifications",
    "/api/integrations",
    "/api/tools",
  ];
  let worstBytes = 0;
  let worstPath = "";
  for (const p of listPaths) {
    const res = await req(inst.port, p);
    const bytes = Buffer.byteLength(res.body, "utf8");
    let rows: number | string = "-";
    try {
      const parsed: unknown = JSON.parse(res.body);
      if (Array.isArray(parsed)) rows = parsed.length;
      else if (parsed && typeof parsed === "object") {
        const arr = Object.values(parsed).find((v) => Array.isArray(v));
        if (Array.isArray(arr)) rows = arr.length;
      }
    } catch {
      rows = "unparseable";
    }
    console.log(
      `  ${p.padEnd(22)} ${String(res.status).padStart(3)}  ${mb(bytes).padStart(9)}  ` +
        `${String(rows).padStart(8)} rows  ${ms(res.ms)}`,
    );
    if (bytes > worstBytes) {
      worstBytes = bytes;
      worstPath = p;
    }
  }
  if (worstBytes > 2 * 1024 * 1024) {
    note(
      "WARN",
      `${worstPath} returned ${mb(worstBytes)} in a single unpaginated response on month-3 data. ` +
        `On day one it is a few kilobytes, which is why no existing test caught it. A console user ` +
        `on a pilot would download this on every page load.`,
    );
  } else {
    note("ok", `Largest console list response on month-3 data was ${mb(worstBytes)} (${worstPath}).`);
  }

  /* -------- Phase E — contention, on the aged database -------- */
  header(`PHASE E — ${CONCURRENT_CLIENTS} concurrent clients on the aged instance`);
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_CLIENTS }, async (_unused, client) => {
      const mine: number[] = [];
      let errors = 0;
      const codes: Record<number, number> = {};
      for (let i = 0; i < REQUESTS_PER_CLIENT; i += 1) {
        const res = await req(inst.port, "/api/decision", {
          method: "POST",
          body: decisionBody(),
          key: LOAD_KEYS[client % LOAD_KEYS.length],
        });
        codes[res.status] = (codes[res.status] ?? 0) + 1;
        if (res.status === 200) mine.push(res.ms);
        else errors += 1;
      }
      return { mine, errors, codes };
    }),
  );
  const wall = performance.now() - started;
  const allLatencies = results.flatMap((r) => r.mine);
  const totalErrors = results.reduce((a, r) => a + r.errors, 0);
  const codeTotals: Record<number, number> = {};
  for (const r of results) {
    for (const [code, n] of Object.entries(r.codes)) {
      codeTotals[Number(code)] = (codeTotals[Number(code)] ?? 0) + n;
    }
  }
  const total = CONCURRENT_CLIENTS * REQUESTS_PER_CLIENT;
  const conc = stats(allLatencies);
  console.log(`  ${int(total)} requests in ${(wall / 1000).toFixed(1)} s → ${(total / (wall / 1000)).toFixed(0)} req/s`);
  console.log(`  p50 ${ms(conc.p50)}   p95 ${ms(conc.p95)}   p99 ${ms(conc.p99)}   max ${ms(conc.max)}`);
  console.log(`  status codes ${JSON.stringify(codeTotals)}`);

  const throughput = total / (wall / 1000);
  const needed = DECISIONS_PER_COMPANY_PER_DAY / (8 * 3600);
  console.log(
    `\n  the model needs ${needed.toFixed(3)} decisions/s per company across an 8-hour day;` +
      ` one instance sustained ${throughput.toFixed(0)}/s`,
  );

  // A 429 here is the rate limiter doing its job, not a failure. Anything else is.
  const rateLimited = codeTotals[429] ?? 0;
  const hardErrors = totalErrors - rateLimited;
  if (hardErrors > 0) {
    note(
      "WARN",
      `${int(hardErrors)} of ${int(total)} concurrent requests failed for reasons other than rate ` +
        `limiting: ${JSON.stringify(codeTotals)}.`,
    );
  } else {
    note(
      "ok",
      `${int(total)} concurrent requests at ${CONCURRENT_CLIENTS} clients produced 0 hard errors ` +
        `(${int(rateLimited)} rate-limited by design), ${throughput.toFixed(0)} req/s, p99 ${ms(conc.p99)}.`,
    );
  }
  if (throughput < needed * COMPANIES) {
    note(
      "note",
      `One instance sustains ${throughput.toFixed(0)} decisions/s. The model's whole pilot needs ` +
        `${(needed * COMPANIES).toFixed(2)}/s aggregate — comfortably inside one instance's rate, but ` +
        `spread over ${COMPANIES} processes.`,
    );
  }

  /* -------- Phase F — footprint and the ×100 extrapolation -------- */
  header(`PHASE F — host footprint, extrapolated to ${COMPANIES} companies`);
  const finalRss = inst.rssKb() ?? 0;
  const finalDb = dbBytes(dbPath);
  const finalCounts = tableCounts(dbPath);
  await inst.stop();

  console.log(`  measured, one instance at month 3:`);
  console.log(`    resident memory      ${(finalRss / 1024).toFixed(0)} MB`);
  console.log(`    database on disk     ${mb(finalDb)}`);
  console.log(`    executions           ${int(finalCounts["executions"])}`);
  console.log(`    approvals            ${int(finalCounts["approvals"])} (${int(finalCounts["approvals_pending"])} still pending)`);
  console.log(`\n  extrapolated to ${COMPANIES} independent instances (labelled: this is arithmetic, not a measurement):`);
  console.log(`    resident memory      ${((finalRss * COMPANIES) / 1024 / 1024).toFixed(1)} GB`);
  console.log(`    database on disk     ${((finalDb * COMPANIES) / 1024 / 1024 / 1024).toFixed(1)} GB`);
  console.log(`    executions           ${int(finalCounts["executions"] * COMPANIES)}`);
  console.log(
    `    pending approvals    ${int(finalCounts["approvals_pending"] * COMPANIES)} across the programme`,
  );

  note(
    "note",
    `Per company at month 3: ${(finalRss / 1024).toFixed(0)} MB resident, ${mb(finalDb)} on disk. ` +
      `×${COMPANIES} = ${((finalRss * COMPANIES) / 1024 / 1024).toFixed(1)} GB RAM and ` +
      `${((finalDb * COMPANIES) / 1024 / 1024 / 1024).toFixed(1)} GB disk — a planning figure, not a measured one.`,
  );

  const pending = finalCounts["approvals_pending"];
  if (pending > 500) {
    note(
      "WARN",
      `${int(pending)} approvals sit pending after ${DAYS} days at a ${(APPROVAL_RATE * 100).toFixed(0)}% ` +
        `approval rate with a ${(APPROVAL_ABANDON_RATE * 100).toFixed(0)}% abandon rate. There is no ageing, ` +
        `expiry or escalation on an approval: the queue only grows. Per company.`,
    );
  }
}

/* --------------------------------- Runner ---------------------------------- */

async function main(): Promise<void> {
  if (!existsSync(BUNDLE)) {
    console.error(`Missing ${BUNDLE}. Run \`npm run build\` first — this harness deliberately\n` +
      `exercises the shipped bundle, not the TypeScript sources.`);
    process.exit(2);
  }

  console.log(`Oathrion — pilot simulation`);
  console.log(
    `${COMPANIES} companies · ${AGENTS_PER_COMPANY} agents each · ` +
      `${int(DECISIONS_PER_COMPANY_PER_DAY)} decisions/company/day · ${DAYS} days`,
  );
  console.log(
    `= ${int(EXECUTIONS_PER_INSTANCE)} executions per instance, ` +
      `${int(EXECUTIONS_PER_INSTANCE * COMPANIES)} across the programme`,
  );

  // Recorded before any phase runs, because it is a fact read from the source
  // rather than something the run discovers, and a pilot needs to know it during
  // provisioning rather than after the first 429.
  note(
    "note",
    `The decision limiter allows 120 requests/minute keyed by identity, not by instance ` +
      `(server/rate-limit/index.ts). The model's ${DECISIONS_PER_COMPANY_PER_DAY} decisions/day per ` +
      `company average ${(DECISIONS_PER_COMPANY_PER_DAY / (8 * 60)).toFixed(1)}/min, so the average ` +
      `fits easily — but ${AGENTS_PER_COMPANY} agents sharing one API key share one 120/min bucket, ` +
      `and a morning burst would be throttled. Provision one credential per agent.`,
  );

  const only = process.argv[2];
  if (!only || only.includes("topology")) await phaseTopology();
  if (!only || only.includes("load")) await phaseLatency();

  header("FINDINGS");
  const order: Finding["severity"][] = ["BLOCKER", "WARN", "note", "ok"];
  for (const sev of order) {
    for (const f of findings.filter((x) => x.severity === sev)) {
      console.log(`  [${sev}] ${f.text}\n`);
    }
  }
  const blockers = findings.filter((f) => f.severity === "BLOCKER").length;
  const warns = findings.filter((f) => f.severity === "WARN").length;
  console.log(`${"=".repeat(78)}`);
  console.log(`blockers: ${blockers}   warnings: ${warns}   notes/ok: ${findings.length - blockers - warns}`);
  // A blocker here is architectural information, not a build failure: exiting
  // non-zero would make this harness unusable in a pipeline that reports it.
  process.exit(0);
}

void main();
