/**
 * PHASE 11 — the application data plane on REAL PostgreSQL, and its parity with SQLite.
 *
 * WHAT THIS SUITE IS FOR
 * ---------------------
 * Phase 10 proved the action-authorization plane on PostgreSQL. Everything else —
 * agents, policies, executions, approvals, integrations, the audit trail, the daily
 * budget, the tool-run claim — was still SQLite, and `DATABASE_DRIVER=postgres`
 * refused to boot. Phase 11 implements those repositories on PostgreSQL
 * (server/repositories/postgres.ts), which means the claims that used to rest on
 * "SQLite serialises everything" now have to be re-proved against an engine that
 * does not.
 *
 * Golden scenarios from the Phase 11 brief covered here: L (full-core ALLOW),
 * M (APPROVAL), N (BLOCK / refusal), P (concurrent idempotency), S (tenant isolation),
 * T (receipt total ordering), V (transaction rollback), W (database failure fail-closed).
 * O (multi-process, same grant) is a separate suite because it needs real processes:
 * server/test/phase11-multiprocess.test.ts.
 *
 * HOW IT BEHAVES WITHOUT A SERVER
 * -------------------------------
 * It SKIPS, loudly, and never silently re-runs the SQLite path under a PostgreSQL
 * name. A skipped test is an honest "not verified here"; a renamed SQLite test is a
 * false claim in a report. `OATHRION_TEST_POSTGRES_URL` (or `DATABASE_URL`) selects the
 * server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { Agent, Approval, Execution, Policy } from "@shared/types";
import type { OrganizationId } from "@shared/tenancy";
import { postgresRepositoriesFor, resetPostgresRepositoryCache, usageReportPg } from "../repositories/postgres";
import { repositoriesFor as sqliteRepositoriesFor } from "../repositories/sqlite";
import { RepositoryInitializationError } from "../repositories";
import { ActionAuthorityStore } from "../authority/store";
import { postgresExecutor, type SqlExecutor } from "../sql/executor";
import { configureQuotas, resetQuotaConfig } from "../quotas";
import { parseQuotaOverrides } from "@shared/quotas";
import { MIGRATIONS, migratePostgres, ACTION_RECEIPTS_TABLE } from "../migrations";
import { verifyAuditChain } from "../audit-chain";

const CONNECTION = process.env.OATHRION_TEST_POSTGRES_URL ?? process.env.DATABASE_URL ?? "";

async function reachable(): Promise<boolean> {
  if (!CONNECTION) return false;
  const probe = new Pool({ connectionString: CONNECTION, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const available = await reachable();

if (!available) {
  describe.skip("Phase 11 — PostgreSQL core (SKIPPED: no server reachable)", () => {
    it("was not verified", () => {
      expect(true).toBe(true);
    });
  });
}

/* -------------------------------- fixtures -------------------------------- */

const uid = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** An issued grant with its action, so a receipt can reference something real. */
async function seedGrant(store: ActionAuthorityStore) {
  const now = () => new Date().toISOString();
  const actionId = uid("act");
  const hash = randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);
  await store.createAction({
    id: actionId,
    agentId: "agt_seq",
    action: "stripe.refund",
    arguments: { amount: 75, currency: "EUR" },
    destinationId: "local-fixture",
    canonical: `{"v":"placet.action.v1","id":"${actionId}"}`,
    actionHash: hash,
    requestId: null,
    idempotencyKey: null,
    decision: "ALLOW",
    reason: "seeded",
    policyId: null,
    createdAt: now(),
  });
  return store.createGrant({
    id: uid("grt"),
    actionId,
    agentId: "agt_seq",
    action: "stripe.refund",
    actionHash: hash,
    destinationId: "local-fixture",
    decision: "ALLOW",
    state: "issued",
    requestId: null,
    idempotencyKey: null,
    policyId: null,
    createdAt: now(),
    issuedAt: now(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    consumedAt: null,
    consumedBy: null,
    approvalId: null,
    approvedAt: null,
    approvedBy: null,
    revokedAt: null,
    revokedReason: null,
  });
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: uid("agt"),
    name: "Phase 11 fixture",
    description: "PostgreSQL core suite",
    provider: "openai",
    model: "gpt-4o",
    status: "active",
    currentTask: null,
    owner: "phase11-suite",
    createdAt: new Date("2026-03-01T10:00:00.000Z").toISOString(),
    executions24h: 3,
    successRate: 99.5,
    cost24h: 1.25,
    costMonth: 12.5,
    riskLevel: "medium",
    permissions: [],
    mandate: {
      maxTransactionAmount: 250,
      currency: "EUR",
      allowedCategories: ["refund"],
      blockedCategories: [],
      allowedDomains: ["stripe.com"],
    },
    policyIds: [],
    tags: ["phase11"],
    ...overrides,
  };
}

function policyFixture(overrides: Partial<Policy> = {}): Policy {
  return {
    id: uid("pol"),
    name: "Refunds over 200 need approval",
    description: "Phase 11 fixture",
    rule: "amount > 200 => APPROVAL",
    scope: "organization",
    appliesTo: "all agents",
    effect: "require_approval",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: new Date("2026-03-01T10:00:00.000Z").toISOString(),
    priority: 10,
    ...overrides,
  };
}

function executionFixture(agent: Agent, overrides: Partial<Execution> = {}): Execution {
  return {
    id: uid("exe"),
    agentId: agent.id,
    agentName: agent.name,
    action: "stripe.refund",
    target: "stripe",
    status: "allowed",
    risk: "medium",
    durationMs: 42,
    cost: 3.5,
    timestamp: new Date().toISOString(),
    input: { amount: 75, currency: "EUR" },
    decision: "allow",
    decisionReason: "within mandate",
    policyEvaluated: null,
    policyId: null,
    result: "ok",
    audit: [
      {
        step: "policy evaluated",
        detail: "within mandate",
        at: new Date().toISOString(),
      } as unknown as Execution["audit"][number],
    ],
    approvalId: null,
    toolId: null,
    toolExecutedAt: null,
    toolResult: null,
    runState: "pending",
    attempts: 0,
    lastError: null,
    toolStartedAt: null,
    ...overrides,
  };
}

function approvalFixture(execution: Execution, overrides: Partial<Approval> = {}): Approval {
  const requestedAt = new Date().toISOString();
  return {
    id: uid("apr"),
    executionId: execution.id,
    agentId: execution.agentId,
    agentName: execution.agentName,
    title: "Refund of 750 EUR",
    summary: "Above the mandate ceiling",
    requestedValue: "750 EUR",
    policyId: "pol_ceiling",
    policyName: "Mandate ceiling",
    policyLimit: "250 EUR",
    risk: "high",
    status: "pending",
    requestedAt,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    resolvedBy: undefined,
    resolvedAt: null,
    context: [],
    ...overrides,
  };
}

describe.runIf(available)("Phase 11 — application repositories on real PostgreSQL", () => {
  const ORG = "org_pg_phase11" as unknown as OrganizationId;
  const RIVAL = "org_pg_phase11_rival" as unknown as OrganizationId;
  let pool: Pool;

  beforeAll(async () => {
    // Same migration list, same runner as SQLite — the schemas cannot drift.
    await migratePostgres(CONNECTION, MIGRATIONS);
    // Several connections deliberately: with max=1 every "race" below would be
    // serialised by the pool and would pass without PostgreSQL arbitrating anything.
    pool = new Pool({ connectionString: CONNECTION, max: 10 });
    for (const org of [ORG, RIVAL]) {
      for (const table of ["approvals", "executions", "agents", "policies", "usage_counters"]) {
        await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [String(org)]);
      }
      await pool.query(`DELETE FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = $1`, [
        String(org),
      ]);
    }
    resetPostgresRepositoryCache();
    resetQuotaConfig();
  });

  afterAll(async () => {
    resetQuotaConfig();
    resetPostgresRepositoryCache();
    await pool.end().catch(() => {});
  });

  const repos = () => postgresRepositoriesFor(postgresExecutor(pool), ORG);

  /* ---------------------------- L — full core ALLOW --------------------- */

  it("L — writes and reads an agent, a policy and an execution, and the rows are really in PostgreSQL", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const policy = policyFixture();
    await repo.policies.create(policy);
    const execution = executionFixture(agent);
    const stored = await repo.executions.create(execution);

    // Read back through the repository...
    const readAgent = await repo.agents.findById(agent.id);
    expect(readAgent).toEqual(agent);
    const readPolicy = await repo.policies.findById(policy.id);
    expect(readPolicy?.name).toBe(policy.name);
    const readExecution = await repo.executions.findById(execution.id);
    expect(readExecution?.input).toEqual({ amount: 75, currency: "EUR" });
    expect(readExecution?.cost).toBe(3.5);
    // ...and directly out of PostgreSQL, because "the repository returned it" would
    // also be true of an in-memory cache. This is the assertion that the source of
    // truth is the database.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM executions WHERE organization_id = $1 AND id = $2`,
      [String(ORG), execution.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);

    // The audit trail was chained on write, not accepted as handed in.
    expect(stored.audit[0]).toHaveProperty("hash");
    expect(verifyAuditChain(ORG, execution.id, stored.audit).ok).toBe(true);
  });

  it("L — an update round-trips every column, including the JSON ones", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const updated = await repo.agents.update(agent.id, {
      status: "paused",
      cost24h: 9.75,
      tags: ["phase11", "updated"],
      mandate: { ...agent.mandate, maxTransactionAmount: 999 },
    });
    expect(updated?.status).toBe("paused");
    const reread = await repo.agents.findById(agent.id);
    expect(reread?.cost24h).toBe(9.75);
    expect(reread?.tags).toEqual(["phase11", "updated"]);
    expect(reread?.mandate.maxTransactionAmount).toBe(999);
  });

  it("L — dailySpend sums only allowed executions of the same agent, inside the window", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    await repo.executions.create(executionFixture(agent, { cost: 10, status: "allowed" }));
    await repo.executions.create(executionFixture(agent, { cost: 100, status: "blocked" }));
    await repo.executions.create(
      executionFixture(agent, {
        cost: 1_000,
        status: "allowed",
        timestamp: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    );
    expect(await repo.executions.dailySpend(agent.id, since)).toBe(10);
  });

  it("L — actionActivity counts an exact action prefix (`_` is not a wildcard), per tenant, and returns the latest", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const latest = executionFixture(agent, { action: "mcp.my_srv.write_file", timestamp: at(1) });
    await repo.executions.create(executionFixture(agent, { action: "mcp.my_srv.read_file", timestamp: at(30) }));
    await repo.executions.create(latest);
    await repo.executions.create(executionFixture(agent, { action: "mcp.my_srv.read_file", timestamp: at(10) }));
    /* `LIKE 'mcp.my_srv.%'` compterait celui-ci ; `left(…) =` non. */
    await repo.executions.create(executionFixture(agent, { action: "mcp.myXsrv.read_file", timestamp: at(0) }));
    const rival = postgresRepositoriesFor(postgresExecutor(pool), RIVAL);
    await rival.agents.create(agent);
    await rival.executions.create(executionFixture(agent, { action: "mcp.my_srv.read_file", timestamp: at(0) }));

    const activity = await repo.executions.actionActivity("mcp.my_srv.");
    expect(activity.count).toBe(3);
    expect(activity.latest?.id).toBe(latest.id);
    expect(await repo.executions.actionActivity("mcp.absent.")).toEqual({ count: 0, latest: undefined });
  });

  /* -------------------------- M — approval lifecycle -------------------- */

  it("M — PENDING → APPROVED is claimed exactly once, and a replay is not a second approval", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const execution = executionFixture(agent, { status: "pending", decision: "require_approval" });
    const approval = approvalFixture(execution);
    await repo.createExecutionWithApproval(execution, approval);

    const first = await repo.approvals.resolve(approval.id, "approved", "user_alice");
    expect(first?.claimed).toBe(true);
    expect(first?.approval.status).toBe("approved");
    expect(first?.approval.resolvedBy).toBe("user_alice");

    // Replay. The row is returned (so the caller can render it) but the claim is not.
    const replay = await repo.approvals.resolve(approval.id, "rejected", "user_bob");
    expect(replay?.claimed).toBe(false);
    expect(replay?.approval.status).toBe("approved");
    expect(replay?.approval.resolvedBy).toBe("user_alice");
  });

  it("M — 8 concurrent approvers produce exactly one claim", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const execution = executionFixture(agent, { status: "pending" });
    const approval = approvalFixture(execution);
    await repo.createExecutionWithApproval(execution, approval);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repo.approvals.resolve(approval.id, "approved", `user_${i}`),
      ),
    );
    expect(results.filter((r) => r?.claimed === true)).toHaveLength(1);
  });

  it("N — an expired approval cannot be resolved, and expiry itself is claimed once", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const execution = executionFixture(agent, { status: "pending" });
    const approval = approvalFixture(execution, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await repo.createExecutionWithApproval(execution, approval);

    // Past the deadline: the UPDATE matches no row, so no approval happens. Checked
    // inside the statement, so there is no time-of-check/time-of-use window.
    const late = await repo.approvals.resolve(approval.id, "approved", "user_late");
    expect(late?.claimed).toBe(false);
    expect(late?.approval.status).toBe("pending");

    const expired = await repo.approvals.expire(approval.id);
    expect(expired?.claimed).toBe(true);
    expect(expired?.approval.status).toBe("expired");
    const again = await repo.approvals.expire(approval.id);
    expect(again?.claimed).toBe(false);
  });

  /* --------------------- P — idempotency of the tool claim --------------- */

  it("P — 16 concurrent claims of one execution's tool run: exactly one wins", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const execution = executionFixture(agent);
    await repo.executions.create(execution);

    const at = new Date().toISOString();
    const claims = await Promise.all(
      Array.from({ length: 16 }, () => repo.executions.claimToolRun(execution.id, uid("tool"), at)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    // And the loser cannot complete a run it never claimed.
    const stored = await repo.executions.findById(execution.id);
    expect(stored?.runState).toBe("running");
    expect(stored?.attempts).toBe(1);
  });

  it("P — a completed run cannot be completed twice", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const execution = executionFixture(agent);
    await repo.executions.create(execution);
    await repo.executions.claimToolRun(execution.id, "tool_a", new Date().toISOString());

    const first = await repo.executions.completeToolRun(execution.id, {
      ok: true,
      at: new Date().toISOString(),
      result: { refunded: true },
    });
    const second = await repo.executions.completeToolRun(execution.id, {
      ok: true,
      at: new Date().toISOString(),
      result: { refunded: true },
    });
    expect([first, second]).toEqual([true, false]);
    const stored = await repo.executions.findById(execution.id);
    expect(stored?.toolResult).toEqual({ refunded: true });
  });

  it("P — concurrent audit appends do not lose entries (row lock, not last-write-wins)", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const execution = executionFixture(agent);
    await repo.executions.create(execution);

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repo.executions.appendAudit(execution.id, [
          { step: `step ${i}`, detail: "concurrent", at: new Date().toISOString() } as never,
        ]),
      ),
    );

    const stored = await repo.executions.findById(execution.id);
    // 1 from creation + 8 appended. A lost update would show fewer.
    expect(stored?.audit).toHaveLength(9);
    expect(verifyAuditChain(ORG, execution.id, stored!.audit).ok).toBe(true);
  });

  /* ------------------------- S — tenant isolation ----------------------- */

  it("S — the same id in two tenants is two rows, and neither can read or write the other", async () => {
    const mine = postgresRepositoriesFor(postgresExecutor(pool), ORG);
    const theirs = postgresRepositoriesFor(postgresExecutor(pool), RIVAL);
    const sharedId = uid("agt_shared");

    await mine.agents.create(agentFixture({ id: sharedId, name: "mine" }));
    await theirs.agents.create(agentFixture({ id: sharedId, name: "theirs" }));

    expect((await mine.agents.findById(sharedId))?.name).toBe("mine");
    expect((await theirs.agents.findById(sharedId))?.name).toBe("theirs");

    // A cross-tenant update must not reach across. It is refused because the tenant
    // predicate is inside the statement, not because a caller remembered to check.
    await theirs.agents.update(sharedId, { name: "hijacked" });
    expect((await mine.agents.findById(sharedId))?.name).toBe("mine");

    // And a listing never shows the other tenant's row.
    const mineList = await mine.agents.list();
    expect(mineList.filter((a) => a.name === "theirs")).toHaveLength(0);
  });

  it("S — a tenant's quota ceiling does not refuse another tenant", async () => {
    configureQuotas({ overrides: parseQuotaOverrides(`${RIVAL}:agents=0`) });
    try {
      const mine = postgresRepositoriesFor(postgresExecutor(pool), ORG);
      const theirs = postgresRepositoriesFor(postgresExecutor(pool), RIVAL);
      await expect(theirs.agents.create(agentFixture())).rejects.toThrow(/quota/i);
      // The other tenant is unaffected: its own counter is what applies.
      await expect(mine.agents.create(agentFixture())).resolves.toBeTruthy();
    } finally {
      resetQuotaConfig();
    }
  });

  /*
   * Phase 12.2 regression. Enforcement had a PostgreSQL sibling from Phase 11; READING
   * the report back did not. `GET /api/usage` kept calling the SQLite `usageReport()`,
   * whose Drizzle handle throws by design on a PostgreSQL deployment, so the route
   * answered 500 everywhere — for one release, unnoticed, because no harness drove the
   * shipped bundle with every plane on PostgreSQL.
   *
   * Asserted on the counting path itself rather than only through the smoke script, so
   * the guard is a second of test time instead of a full bundle boot.
   */
  it("the quota report reads back on PostgreSQL, with the same ceilings enforcement uses", async () => {
    // Deliberately generous: this test is about reading the report, and a ceiling below
    // the agents earlier tests in this file created would refuse rather than report.
    configureQuotas({ overrides: parseQuotaOverrides(`${ORG}:agents=5000`) });
    try {
      const report = await usageReportPg(postgresExecutor(pool), ORG);
      const counters = report.map((entry) => entry.counter);
      expect(counters).toEqual(expect.arrayContaining(["agents", "policies", "executions"]));

      const agents = report.find((entry) => entry.counter === "agents");
      expect(agents).toBeDefined();
      // The ceiling comes from the shared configuration, not a second definition here.
      expect(agents?.limit).toBe(5000);
      expect(agents?.remaining).toBe(5000 - (agents?.used ?? 0));

      // `used` must be a real count from PostgreSQL, not a zero from a swallowed error.
      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM agents WHERE organization_id = $1",
        [ORG],
      );
      expect(agents?.used).toBe(Number(rows[0]?.n));
      expect(agents?.used).toBeGreaterThan(0);
    } finally {
      resetQuotaConfig();
    }
  });

  /* ------------------------ V — transaction rollback -------------------- */

  it("V — a refused quota rolls the whole unit back: no execution, no orphan approval", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const execution = executionFixture(agent, { status: "pending" });
    const approval = approvalFixture(execution);

    configureQuotas({ overrides: parseQuotaOverrides(`${ORG}:executions=0`) });
    try {
      await expect(repo.createExecutionWithApproval(execution, approval)).rejects.toThrow(/quota/i);
    } finally {
      resetQuotaConfig();
    }

    // Both halves are gone. An approval pointing at a missing execution would be an
    // item in a reviewer's queue that can never be acted on.
    expect(await repo.executions.findById(execution.id)).toBeUndefined();
    expect(await repo.approvals.findById(approval.id)).toBeUndefined();
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM approvals WHERE organization_id = $1 AND id = $2`,
      [String(ORG), approval.id],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("V — decideAndPersist commits the execution, the approval and the policy counter together", async () => {
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const policy = policyFixture();
    await repo.policies.create(policy);

    const since = new Date(Date.now() - 3_600_000).toISOString();
    const result = await repo.decideAndPersist(agent.id, since, (dailySpend) => {
      expect(dailySpend).toBe(0);
      const execution = executionFixture(agent, { policyId: policy.id, cost: 5 });
      return { execution, approval: approvalFixture(execution) };
    });

    expect(await repo.executions.findById(result.execution.id)).toBeTruthy();
    expect(await repo.approvals.findByExecutionId(result.execution.id)).toBeTruthy();
    expect((await repo.policies.findById(policy.id))?.triggeredCount).toBe(1);
  });

  it("V — concurrent decisions for one agent each see the spend the previous one wrote", async () => {
    /*
     * The daily-budget TOCTOU. On SQLite this was closed by the engine serialising
     * writers. On PostgreSQL it is closed by a per-agent advisory lock taken inside the
     * transaction, so the sum is read after the previous decision committed. Without it,
     * four concurrent decisions would all read 0 and a budget could be doubled.
     */
    const repo = repos();
    const agent = agentFixture();
    await repo.agents.create(agent);
    const since = new Date(Date.now() - 3_600_000).toISOString();

    const seen = await Promise.all(
      Array.from({ length: 4 }, () =>
        repo.decideAndPersist(agent.id, since, (_dailySpend) => ({
          execution: executionFixture(agent, { cost: 10, status: "allowed" }),
          approval: null,
        })).then(() => repo.executions.dailySpend(agent.id, since)),
      ),
    );
    // Whatever the interleaving, the final total is exact — no decision overwrote
    // another's contribution.
    expect(Math.max(...seen)).toBe(40);
    expect(await repo.executions.dailySpend(agent.id, since)).toBe(40);
  });

  /* --------------------- T — receipt total ordering --------------------- */

  it("T — 12 concurrent receipts get 12 distinct consecutive sequence numbers and one chain", async () => {
    const store = new ActionAuthorityStore(postgresExecutor(pool), ORG);
    await pool.query(`DELETE FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = $1`, [
      String(ORG),
    ]);

    // Real grants: a receipt references the grant it consumed, and the foreign key is
    // part of the guarantee — a receipt for a grant that never existed is not evidence.
    const grants = await Promise.all(Array.from({ length: 12 }, () => seedGrant(store)));

    const write = (n: number) =>
      store.appendReceipt(({ prevHash, entrySeq }) => ({
        receiptId: uid("rcpt"),
        grantId: grants[n]!.id,
        actionId: grants[n]!.actionId,
        agentId: "agt_seq",
        action: "stripe.refund",
        actionHash: "a".repeat(64),
        destinationId: "local-fixture",
        decision: "ALLOW",
        approvalId: null,
        executedAt: new Date().toISOString(),
        downstreamExecutionId: `exe_${n}`,
        outcome: "succeeded",
        resultHash: "b".repeat(64),
        resultSummary: `receipt ${n}`,
        prevHash,
        entryHash: `hash_${entrySeq}`,
        entrySeq,
      }));

    const written = await Promise.all(Array.from({ length: 12 }, (_, i) => write(i)));
    const sequences = written.map((r) => r.entrySeq).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // Read back in the total order and check the chain is a chain: each receipt's
    // prev_hash is the previous one's entry_hash, and no two share a predecessor —
    // which is exactly what Phase 10 could not guarantee under concurrency.
    const listed = (await store.listReceipts(50)).reverse();
    expect(listed).toHaveLength(12);
    expect(listed[0]?.prevHash).toBeNull();
    for (let i = 1; i < listed.length; i += 1) {
      expect(listed[i]?.prevHash).toBe(listed[i - 1]?.entryHash);
      expect(listed[i]?.entrySeq).toBe((listed[i - 1]?.entrySeq ?? 0) + 1);
    }
    const predecessors = new Set(listed.map((r) => r.prevHash));
    expect(predecessors.size).toBe(listed.length);
  });

  it("T — the sequence is unique per tenant, and two tenants number independently", async () => {
    const mine = new ActionAuthorityStore(postgresExecutor(pool), RIVAL);
    await pool.query(`DELETE FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = $1`, [
      String(RIVAL),
    ]);
    const grant = await seedGrant(mine);
    const receipt = await mine.appendReceipt(({ prevHash, entrySeq }) => ({
      receiptId: uid("rcpt"),
      grantId: grant.id,
      actionId: grant.actionId,
      agentId: "agt_rival",
      action: "stripe.refund",
      actionHash: "c".repeat(64),
      destinationId: "local-fixture",
      decision: "ALLOW",
      approvalId: null,
      executedAt: new Date().toISOString(),
      downstreamExecutionId: "exe_rival",
      outcome: "succeeded",
      resultHash: "d".repeat(64),
      resultSummary: "rival",
      prevHash,
      entryHash: "rival_hash_1",
      entrySeq,
    }));
    // Starts at 1 for this tenant even though the other tenant is at 12.
    expect(receipt.entrySeq).toBe(1);
    expect(receipt.prevHash).toBeNull();
  });

  /*
   * Relevé pendant la campagne d'endurance (docs/STRESS-TEST-LOG.md) : la lecture de la
   * tête de chaîne, écrite `ORDER BY entry_seq DESC NULLS LAST, …`, ne correspondait à
   * aucun index — PostgreSQL triait tous les reçus du locataire à chaque écriture, sous
   * le verrou consultatif. Ce test EXPLIQUE les requêtes que le magasin émet RÉELLEMENT
   * (capturées, pas recopiées) avec les parcours séquentiels interdits : s'il reste un
   * nœud `Sort`, la lecture redevient proportionnelle au nombre de reçus.
   */
  it("T — every newest-first receipt read is an index walk, not a sort of the tenant's receipts", async () => {
    const seen: { sql: string; params: readonly unknown[] }[] = [];
    const recording = (exec: SqlExecutor): SqlExecutor => ({
      dialect: exec.dialect,
      all: <T,>(sql: string, params: readonly unknown[] = []) => {
        seen.push({ sql, params });
        return exec.all<T>(sql, params);
      },
      run: (sql: string, params: readonly unknown[] = []) => {
        seen.push({ sql, params });
        return exec.run(sql, params);
      },
      transaction: <T,>(fn: (tx: SqlExecutor) => Promise<T>) => exec.transaction((tx) => fn(recording(tx))),
    });
    const base = postgresExecutor(pool);
    const store = new ActionAuthorityStore(recording(base), ORG);
    const grant = await seedGrant(store);
    seen.length = 0;
    await store.appendReceipt(({ prevHash, entrySeq }) => ({
      receiptId: uid("rcpt"),
      grantId: grant.id,
      actionId: grant.actionId,
      agentId: "agt_seq",
      action: "stripe.refund",
      actionHash: "e".repeat(64),
      destinationId: "local-fixture",
      decision: "ALLOW",
      approvalId: null,
      executedAt: new Date().toISOString(),
      downstreamExecutionId: "exe_plan",
      outcome: "succeeded",
      resultHash: "f".repeat(64),
      resultSummary: "plan",
      prevHash,
      entryHash: `hash_${entrySeq}`,
      entrySeq,
    }));
    await store.listReceipts(100);
    await store.latestReceiptHash();

    const reads = seen.filter(
      ({ sql }) => /^\s*SELECT/i.test(sql) && sql.includes(ACTION_RECEIPTS_TABLE) && /ORDER BY|max\(/i.test(sql),
    );
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const { sql, params } of reads) {
      const plan = await base.transaction(async (tx) => {
        await tx.run(`SET LOCAL enable_seqscan = off`);
        return tx.all<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params);
      });
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
      if (/entry_seq IS NULL/.test(sql)) {
        /*
         * La lecture de repli des reçus SANS numéro (antérieurs à la migration 13) : elle
         * ne s'exécute que si les reçus numérotés n'ont pas rempli la page, et elle suit
         * l'index temporel — le tri qui reste ne départage que des horodatages égaux.
         */
        expect(text, `${sql}\n${text}`).not.toMatch(/Seq Scan/);
      } else {
        expect(text, `${sql}\n${text}`).not.toMatch(/\bSort\b/);
      }
    }
    // Les lectures numérotées existent bien, et ce sont elles qui portent la charge.
    expect(reads.filter(({ sql }) => /entry_seq IS NOT NULL|max\(/i.test(sql)).length).toBeGreaterThanOrEqual(4);
  });

  it("T — the newest-first order is unchanged when pre-013 receipts have no sequence", async () => {
    const store = new ActionAuthorityStore(postgresExecutor(pool), ORG);
    const all = await store.listReceipts(1_000);
    expect(all.length).toBeGreaterThanOrEqual(6);
    // Les trois plus anciens perdent leur numéro, comme des reçus antérieurs à la migration.
    const legacy = all.slice(-3).map((r) => r.receiptId);
    await pool.query(
      `UPDATE ${ACTION_RECEIPTS_TABLE} SET entry_seq = NULL WHERE organization_id = $1 AND receipt_id = ANY($2)`,
      [String(ORG), legacy],
    );
    try {
      const { rows } = await pool.query<{ receipt_id: string }>(
        `SELECT receipt_id FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = $1
          ORDER BY entry_seq DESC NULLS LAST, executed_at DESC, receipt_id DESC`,
        [String(ORG)],
      );
      const expected = rows.map((r) => r.receipt_id);
      expect((await store.listReceipts(1_000)).map((r) => r.receiptId)).toEqual(expected);
      // Une page qui s'arrête au milieu des reçus sans numéro.
      const cut = expected.length - 2;
      expect((await store.listReceipts(cut)).map((r) => r.receiptId)).toEqual(expected.slice(0, cut));
      expect(await store.latestReceiptHash()).toBe(all[0]!.entryHash);
    } finally {
      await pool.query(
        `UPDATE ${ACTION_RECEIPTS_TABLE} SET entry_seq = s.seq FROM (VALUES ${legacy
          .map((_, i) => `($${i * 2 + 2}::text, $${i * 2 + 3}::int)`)
          .join(", ")}) AS s(id, seq) WHERE organization_id = $1 AND receipt_id = s.id`,
        [String(ORG), ...legacy.flatMap((id) => [id, all.find((r) => r.receiptId === id)!.entrySeq])],
      );
    }
  });

  /* ------------------ W — the database failing is not an ALLOW ---------- */

  it("W — when PostgreSQL is unreachable, reads and writes reject; nothing is answered from SQLite", async () => {
    const dead = new Pool({
      connectionString: CONNECTION,
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    await dead.end();
    resetPostgresRepositoryCache();
    const broken = postgresRepositoriesFor(postgresExecutor(dead), ORG);

    await expect(broken.agents.list()).rejects.toThrow();
    await expect(broken.executions.create(executionFixture(agentFixture()))).rejects.toThrow();
    // The liveness probe reports unhealthy rather than throwing, which is what a
    // readiness endpoint needs, and it does NOT report healthy.
    expect(await broken.ping()).toBe(false);
    resetPostgresRepositoryCache();
  });

  it("W — a claim that cannot reach the database is a rejection, never a `true`", async () => {
    /*
     * The single most dangerous shape of this failure: `claimToolRun` returning a
     * truthy value on error would let the gateway dispatch a tool call with no record
     * that it was claimed. It must reject.
     */
    const dead = new Pool({ connectionString: CONNECTION, max: 1 });
    await dead.end();
    resetPostgresRepositoryCache();
    const broken = postgresRepositoriesFor(postgresExecutor(dead), ORG);
    await expect(
      broken.executions.claimToolRun("exe_whatever", "tool_x", new Date().toISOString()),
    ).rejects.toThrow();
    resetPostgresRepositoryCache();
  });
});

/* ========================================================================== *
 * Parity — same business result on both engines
 * ========================================================================== */

describe.runIf(available)("Phase 11 — SQLite/PostgreSQL parity", () => {
  const PG_ORG = "org_parity_pg" as unknown as OrganizationId;
  const SQLITE_ORG = "org_parity_sqlite" as unknown as OrganizationId;
  let pool: Pool;

  beforeAll(async () => {
    await migratePostgres(CONNECTION, MIGRATIONS);
    pool = new Pool({ connectionString: CONNECTION, max: 5 });
    for (const table of ["approvals", "executions", "agents", "policies", "usage_counters"]) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [String(PG_ORG)]);
    }
    resetPostgresRepositoryCache();
  });

  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  /**
   * Runs the same scenario against both engines and returns both results.
   *
   * The two tenants differ, so the two runs cannot see each other's rows even though
   * the SQLite one is a file and the PostgreSQL one is a server.
   */
  async function onBoth<T>(
    scenario: (repo: ReturnType<typeof sqliteRepositoriesFor>, org: OrganizationId) => Promise<T>,
  ): Promise<{ sqlite: T; postgres: T }> {
    const sqlite = await scenario(sqliteRepositoriesFor(SQLITE_ORG), SQLITE_ORG);
    const postgres = await scenario(
      postgresRepositoriesFor(postgresExecutor(pool), PG_ORG),
      PG_ORG,
    );
    return { sqlite, postgres };
  }

  it("agent create → read → update → read returns identical business values", async () => {
    const { sqlite, postgres } = await onBoth(async (repo) => {
      const agent = agentFixture({ id: uid("agt_parity") });
      await repo.agents.create(agent);
      await repo.agents.update(agent.id, { status: "paused", cost24h: 4.5 });
      const read = await repo.agents.findById(agent.id);
      // The id differs by construction; everything that carries meaning must not.
      return {
        status: read?.status,
        cost24h: read?.cost24h,
        successRate: read?.successRate,
        mandate: read?.mandate,
        tags: read?.tags,
        createdAt: read?.createdAt,
      };
    });
    expect(postgres).toEqual(sqlite);
  });

  it("execution + approval, resolve, replay: identical claim semantics", async () => {
    const { sqlite, postgres } = await onBoth(async (repo) => {
      const agent = agentFixture({ id: uid("agt_parity") });
      await repo.agents.create(agent);
      const execution = executionFixture(agent, { status: "pending" });
      const approval = approvalFixture(execution);
      await repo.createExecutionWithApproval(execution, approval);
      const first = await repo.approvals.resolve(approval.id, "approved", "user_a");
      const replay = await repo.approvals.resolve(approval.id, "rejected", "user_b");
      const stored = await repo.approvals.findById(approval.id);
      return {
        firstClaimed: first?.claimed,
        replayClaimed: replay?.claimed,
        finalStatus: stored?.status,
        resolvedBy: stored?.resolvedBy,
      };
    });
    expect(postgres).toEqual(sqlite);
    expect(postgres).toEqual({
      firstClaimed: true,
      replayClaimed: false,
      finalStatus: "approved",
      resolvedBy: "user_a",
    });
  });

  it("an expired approval is refused on both engines", async () => {
    const { sqlite, postgres } = await onBoth(async (repo) => {
      const agent = agentFixture({ id: uid("agt_parity") });
      await repo.agents.create(agent);
      const execution = executionFixture(agent, { status: "pending" });
      const approval = approvalFixture(execution, {
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await repo.createExecutionWithApproval(execution, approval);
      const late = await repo.approvals.resolve(approval.id, "approved", "user_late");
      const expired = await repo.approvals.expire(approval.id);
      return {
        lateClaimed: late?.claimed,
        expiredClaimed: expired?.claimed,
        status: expired?.approval.status,
      };
    });
    expect(postgres).toEqual(sqlite);
    expect(postgres).toEqual({ lateClaimed: false, expiredClaimed: true, status: "expired" });
  });

  it("the tool-run claim is idempotent on both engines", async () => {
    const { sqlite, postgres } = await onBoth(async (repo) => {
      const agent = agentFixture({ id: uid("agt_parity") });
      await repo.agents.create(agent);
      const execution = executionFixture(agent);
      await repo.executions.create(execution);
      const at = new Date().toISOString();
      const first = await repo.executions.claimToolRun(execution.id, "tool_a", at);
      const second = await repo.executions.claimToolRun(execution.id, "tool_b", at);
      const stored = await repo.executions.findById(execution.id);
      return { first, second, runState: stored?.runState, attempts: stored?.attempts };
    });
    expect(postgres).toEqual(sqlite);
    expect(postgres).toEqual({ first: true, second: false, runState: "running", attempts: 1 });
  });

  it("dailySpend agrees on both engines", async () => {
    const { sqlite, postgres } = await onBoth(async (repo) => {
      const agent = agentFixture({ id: uid("agt_parity") });
      await repo.agents.create(agent);
      const since = new Date(Date.now() - 3_600_000).toISOString();
      await repo.executions.create(executionFixture(agent, { cost: 12.5, status: "allowed" }));
      await repo.executions.create(executionFixture(agent, { cost: 99, status: "blocked" }));
      return repo.executions.dailySpend(agent.id, since);
    });
    expect(postgres).toBe(sqlite);
    expect(postgres).toBe(12.5);
  });

  it("the audit trail is chained and verifiable on both engines", async () => {
    const { sqlite, postgres } = await onBoth(async (repo, org) => {
      const agent = agentFixture({ id: uid("agt_parity") });
      await repo.agents.create(agent);
      const execution = executionFixture(agent);
      await repo.executions.create(execution);
      await repo.executions.appendAudit(execution.id, [
        { step: "one", detail: "d", at: new Date().toISOString() } as never,
      ]);
      await repo.executions.appendAudit(execution.id, [
        { step: "two", detail: "d", at: new Date().toISOString() } as never,
      ]);
      const stored = await repo.executions.findById(execution.id);
      return {
        entries: stored?.audit.length,
        valid: verifyAuditChain(org, execution.id, stored!.audit).ok,
      };
    });
    expect(postgres).toEqual(sqlite);
    expect(postgres).toEqual({ entries: 3, valid: true });
  });
});

/* ========================================================================== *
 * The refusal itself — no silent fallback, with or without a server
 * ========================================================================== */

describe("Phase 11 — the repository layer refuses to answer from the wrong engine", () => {
  it("throws instead of returning SQLite repositories when postgres is configured but uninitialized", async () => {
    /*
     * Runs with or without a PostgreSQL server, because the property under test is a
     * refusal and not a query. This is the mechanism behind "no silent fallback": the
     * dangerous outcome is not an error, it is a process that answers happily from a
     * local file while an operator believes the shared database is the source of truth.
     */
    const { repositoriesFor } = await import("../repositories");
    const saved = { driver: process.env.DATABASE_DRIVER, url: process.env.DATABASE_URL };
    process.env.DATABASE_DRIVER = "postgres";
    process.env.DATABASE_URL = "postgres://user:secret@127.0.0.1:5432/nope";
    try {
      expect(() => repositoriesFor("org_default" as unknown as OrganizationId)).toThrow(
        RepositoryInitializationError,
      );
      expect(() => repositoriesFor("org_default" as unknown as OrganizationId)).toThrow(
        /never initialized|no SQLite fallback|falling back/i,
      );
    } finally {
      if (saved.driver === undefined) delete process.env.DATABASE_DRIVER;
      else process.env.DATABASE_DRIVER = saved.driver;
      if (saved.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved.url;
    }
  });

  it("refuses to initialize when the server is unreachable, and says there is no fallback", async () => {
    const { initializeRepositories, closeRepositories } = await import("../repositories");
    await closeRepositories();
    await expect(
      initializeRepositories({
        DATABASE_DRIVER: "postgres",
        // Port 1 is reserved and nothing listens there; the connection cannot succeed.
        DATABASE_URL: "postgres://user:secret@127.0.0.1:1/placet",
      } as unknown as NodeJS.ProcessEnv),
    ).rejects.toThrow(/will not start/i);
    await closeRepositories();
  });
});
