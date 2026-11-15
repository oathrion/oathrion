/**
 * Dashboard metrics are derived, not decorative — these tests pin the numbers
 * to the execution ledger so a KPI cannot silently drift back to a constant.
 */

import { describe, expect, it } from "vitest";
import { computeDashboardMetrics, costPerAgent, delta, executionsOverTime } from "./metrics";
import type { Agent, Approval, Execution, Policy } from "./types";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function execution(overrides: Partial<Execution> & Pick<Execution, "id" | "timestamp">): Execution {
  return {
    agentId: "agt_procurement",
    agentName: "Procurement Agent",
    action: "purchase",
    target: "shop",
    status: "allowed",
    risk: "low",
    durationMs: 2,
    cost: 0,
    input: {},
    decision: "allow",
    decisionReason: "",
    policyEvaluated: null,
    policyId: null,
    result: "",
    audit: [{ at: overrides.timestamp, actor: "Policy Engine", event: "Action requested", detail: "" }],
    approvalId: null,
    ...overrides,
  };
}

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

const agents = [
  { status: "active" },
  { status: "active" },
  { status: "paused" },
  { status: "draft" },
].map((a, i) => ({ id: `agt_${i}`, status: a.status }) as unknown as Agent);

const policies = [
  { id: "p1", status: "enabled" },
  { id: "p2", status: "enabled" },
  { id: "p3", status: "disabled" },
] as unknown as Policy[];

const approvals = [
  { id: "a1", status: "pending" },
  { id: "a2", status: "approved" },
  { id: "a3", status: "pending" },
] as unknown as Approval[];

describe("delta", () => {
  it("computes a percentage change", () => {
    expect(delta(12, 10)).toBeCloseTo(20);
    expect(delta(8, 10)).toBeCloseTo(-20);
  });

  it("returns null when there is no baseline", () => {
    expect(delta(5, 0)).toBeNull();
  });

  it("returns 0 when both windows are empty", () => {
    expect(delta(0, 0)).toBe(0);
  });
});

describe("computeDashboardMetrics", () => {
  const executions: Execution[] = [
    // Last 24 hours: 3 allowed, 1 blocked, 1 pending.
    execution({ id: "e1", timestamp: hoursAgo(1), cost: 1.5 }),
    execution({ id: "e2", timestamp: hoursAgo(4), cost: 0.5 }),
    execution({ id: "e3", timestamp: hoursAgo(20), cost: 2 }),
    execution({ id: "e4", timestamp: hoursAgo(6), status: "blocked", decision: "block" }),
    execution({ id: "e5", timestamp: hoursAgo(2), status: "pending", decision: "require_approval" }),
    // Preceding 24 hours: 2 executions, 2 blocked among them is 1.
    execution({ id: "e6", timestamp: hoursAgo(30), cost: 2 }),
    execution({ id: "e7", timestamp: hoursAgo(40), status: "blocked", decision: "block" }),
    // Outside both windows.
    execution({ id: "e8", timestamp: hoursAgo(100), cost: 99 }),
  ];

  const m = computeDashboardMetrics({ agents, executions, approvals, policies }, NOW);

  it("counts only active agents", () => {
    expect(m.activeAgents).toBe(2);
  });

  it("counts executions from the last 24 hours only", () => {
    expect(m.executionsToday).toBe(5);
  });

  it("compares against the preceding 24 hours", () => {
    expect(m.executionsDelta).toBeCloseTo(150); // 5 vs 2
  });

  it("sums cost from the ledger, not from static agent fields", () => {
    expect(m.totalCost).toBeCloseTo(4);
    expect(m.costDelta).toBeCloseTo(100); // 4 vs 2
  });

  it("counts blocked executions as policy violations", () => {
    expect(m.violations).toBe(1);
    expect(m.violationsDelta).toBeCloseTo(0); // 1 vs 1
  });

  it("counts pending approvals and enabled policies", () => {
    expect(m.pendingApprovals).toBe(2);
    expect(m.enabledPolicies).toBe(2);
  });

  it("reports audit coverage over the whole ledger", () => {
    expect(m.auditCoverage).toBe(100);
    const partial = computeDashboardMetrics(
      {
        agents,
        approvals,
        policies,
        executions: [...executions, execution({ id: "e9", timestamp: hoursAgo(1), audit: [] })],
      },
      NOW,
    );
    expect(partial.auditCoverage).toBeCloseTo((8 / 9) * 100);
  });

  it("returns zeroes on an empty ledger instead of inventing numbers", () => {
    const empty = computeDashboardMetrics(
      { agents: [], executions: [], approvals: [], policies: [] },
      NOW,
    );
    expect(empty).toMatchObject({
      activeAgents: 0,
      executionsToday: 0,
      totalCost: 0,
      violations: 0,
      pendingApprovals: 0,
      auditCoverage: 100,
    });
  });
});

describe("executionsOverTime", () => {
  it("produces twelve 2-hour buckets covering 24 hours", () => {
    const series = executionsOverTime([], NOW);
    expect(series).toHaveLength(12);
  });

  it("places each execution in exactly one bucket", () => {
    const series = executionsOverTime(
      [
        execution({ id: "a", timestamp: hoursAgo(1) }),
        execution({ id: "b", timestamp: hoursAgo(1.5) }),
        execution({ id: "c", timestamp: hoursAgo(9), status: "blocked" }),
        execution({ id: "d", timestamp: hoursAgo(9), status: "pending" }),
      ],
      NOW,
    );
    expect(series.reduce((s, p) => s + p.allowed, 0)).toBe(2);
    expect(series.reduce((s, p) => s + p.blocked, 0)).toBe(1);
    expect(series.reduce((s, p) => s + p.pending, 0)).toBe(1);
  });
});

describe("costPerAgent", () => {
  it("aggregates spend per agent and drops zero-cost agents", () => {
    const points = costPerAgent(
      [
        execution({ id: "a", timestamp: hoursAgo(1), agentName: "Sales Agent", cost: 3 }),
        execution({ id: "b", timestamp: hoursAgo(2), agentName: "Sales Agent", cost: 1.25 }),
        execution({ id: "c", timestamp: hoursAgo(3), agentName: "Data Analyst", cost: 2 }),
        execution({ id: "d", timestamp: hoursAgo(4), agentName: "Support Agent", cost: 0 }),
      ],
      NOW,
    );
    expect(points).toEqual([
      { label: "Sales Agent", value: 4.25 },
      { label: "Data Analyst", value: 2 },
    ]);
  });
});
