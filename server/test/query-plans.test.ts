import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
/**
 * Query-plan regression barrier.
 *
 * An index is easy to add and easy to lose: a later migration reorders the schema,
 * someone "tidies up" a duplicate-looking index, and the query silently degrades to
 * a scan. Nothing fails, no test goes red, the system just gets slower under load —
 * and in this codebase "slower" means the write lock is held longer inside the
 * decision transaction, so every agent's decisions queue behind it.
 *
 * These tests assert the PLAN, not a duration. A timing assertion on shared CI is a
 * flake; a plan is deterministic and it is the thing that actually matters.
 */

import { describe, expect, it } from "vitest";
import { rawDb } from "../db";
import { dailySpendSqlForPlan, executionTimelineSqlForPlan } from "../repositories/sqlite";

interface PlanStep {
  detail: string;
}

function plan(sql: string, params: unknown[] = []): string {
  const steps = rawDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as PlanStep[];
  return steps.map((s) => s.detail).join(" | ");
}

describe("daily spend query plan", () => {
  /*
   * The plan is taken from the REAL query builder, not from a copy of the SQL. A
   * plan test written against a hand-copied string keeps passing after the original
   * query has drifted, which is the one failure mode this test exists to prevent.
   */
  function spendPlan(): string {
    const { sql: text, params } = dailySpendSqlForPlan(DEFAULT_ORGANIZATION_ID, "agt_sales", "2026-01-01T00:00:00.000Z");
    return plan(text, params);
  }

  it("uses the covering spend index", () => {
    /*
     * This query runs inside the decision transaction, on the critical path of every
     * governed action, while the write lock is held. COVERING is the load-bearing
     * word: the sum is computed from index pages without touching the table.
     *
     * Measured on 200k rows across 7 tenants (script/bench-daily-spend.ts):
     * 616.2µs with the pre-tenancy index `(agent_id, status, timestamp, cost)` that
     * 003-tenancy drops, 476.7µs tenant-led but not covering, 16.8µs with this one.
     * (The earlier figures quoted here — 2038.6µs / 95.3µs — came from the benchmark
     * before it was repointed at the post-tenancy layout; they measured indexes this
     * schema no longer has. Audit finding I7.)
     */
    const detail = spendPlan();
    expect(detail).toContain("idx_executions_org_spend");
    expect(detail).toContain("COVERING INDEX");
  });

  it("never falls back to a full table scan", () => {
    const detail = spendPlan();
    expect(detail).not.toContain("SCAN executions");
  });

  it("keeps the per-agent timeline index, which the spend index cannot replace", () => {
    /*
     * (agent_id, status, timestamp, cost) cannot serve "this agent's executions,
     * newest first": `status` sits between the two columns that read needs, so
     * SQLite would have to sort. Both indexes are load-bearing, which is exactly why
     * one of them looks redundant and is at risk of being deleted.
     */
    const detail = plan(
      `SELECT id FROM executions
        WHERE organization_id = ? AND agent_id = ? ORDER BY timestamp DESC LIMIT 50`,
      [DEFAULT_ORGANIZATION_ID, "agt_sales"],
    );
    expect(detail).toContain("idx_executions_org_agent_ts");
    expect(detail).not.toContain("USE TEMP B-TREE");
  });

  it("declares both indexes on the executions table", () => {
    const names = (
      rawDb
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'executions'`)
        .all() as { name: string }[]
    ).map((r) => r.name);

    /*
     * All three now lead with `organization_id`. That is the whole point: an index
     * whose leading column is `agent_id` makes SQLite walk another tenant's entries
     * before the filter rejects them, so the query gets slower as OTHER customers
     * grow — a performance coupling between tenants, on top of being the wrong shape.
     */
    expect(names).toContain("idx_executions_org_spend");
    expect(names).toContain("idx_executions_org_agent_ts");
    expect(names).toContain("idx_executions_org_ts");
  });
});

describe("console timeline query plan", () => {
  /*
   * GET /api/executions and GET /api/audit both read the executions table
   * newest-first with no WHERE clause. idx_executions_org_agent_ts cannot serve that
   * ordering — its leading column is agent_id — so before idx_executions_org_ts existed
   * SQLite scanned the whole table and built a temporary b-tree to sort it.
   *
   * Nothing went red when that was the case, because on a fresh install the table
   * is empty. script/pilot-sim.ts found it by aging a database to ninety days of one
   * pilot company's traffic: 145,600 rows, 187.3 ms per console page load, dropping
   * to 4.8 ms once the index was added.
   *
   * The plan is asserted rather than the duration, for the reason at the top of this
   * file.
   */
  function timelinePlan(limit: number): string {
    const { sql: text, params } = executionTimelineSqlForPlan(DEFAULT_ORGANIZATION_ID, limit);
    return plan(text, params);
  }

  it("orders by the timestamp index instead of sorting the whole table", () => {
    const detail = timelinePlan(300);
    // The index name changed with tenancy: the tenant column must LEAD, otherwise
    // SQLite scans every organization's rows before filtering.
    expect(detail).toContain("idx_executions_org_ts");
    // The load-bearing assertion. A temp b-tree here means the console is sorting
    // every execution ever recorded on every page load.
    expect(detail).not.toContain("USE TEMP B-TREE");
  });

  it("holds for the wider window the audit endpoint reads", () => {
    // GET /api/audit takes 500 rows rather than 300 and then filters in the handler,
    // so the larger limit must take the same plan.
    expect(timelinePlan(500)).not.toContain("USE TEMP B-TREE");
  });
});

describe("session lookup query plan", () => {
  it("resolves a session by primary key rather than scanning", () => {
    // Every authenticated browser request resolves a session. A scan here would tax
    // literally every request the console makes.
    const detail = plan(`SELECT * FROM sessions WHERE id = ?`, ["sess_x"]);
    expect(detail).not.toContain("SCAN sessions");
  });
});
