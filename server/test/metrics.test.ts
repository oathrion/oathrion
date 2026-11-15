/**
 * Chantier 5 — the numbers the UI shows must come from the ledger.
 *
 * These tests pin the derivations that replaced the hand-written fixtures on
 * the Analytics page, the dashboard activity feed and the billing usage panel.
 * They run without a browser: give the module a ledger, check the numbers.
 */

import { describe, expect, it } from "vitest";
import {
  activityFromExecutions,
  costInWindow,
  costPerAgent,
  executionsByDay,
  executionsInWindow,
  successRate,
  successRateByDay,
} from "@shared/metrics";
import type { Execution, ExecutionStatus } from "@shared/types";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function execution(overrides: Partial<Execution> & { id: string }): Execution {
  return {
    agentId: "agt_sales",
    agentName: "Sales Agent",
    action: "purchase",
    target: "supplier-x.com",
    status: "allowed" as ExecutionStatus,
    risk: "low",
    durationMs: 120,
    cost: 0,
    timestamp: NOW.toISOString(),
    input: {},
    decision: "allow",
    decisionReason: "Within mandate",
    policyEvaluated: null,
    policyId: null,
    result: "ok",
    audit: [],
    ...overrides,
  };
}

describe("execution volume is counted, never assumed", () => {
  it("counts only executions inside the window", () => {
    const ledger = [
      execution({ id: "e1", timestamp: new Date(NOW.getTime() - 2 * HOUR).toISOString() }),
      execution({ id: "e2", timestamp: new Date(NOW.getTime() - 20 * HOUR).toISOString() }),
      execution({ id: "e3", timestamp: new Date(NOW.getTime() - 40 * HOUR).toISOString() }),
    ];
    expect(executionsInWindow(ledger, NOW, 24)).toBe(2);
    expect(executionsInWindow(ledger, NOW, 24 * 7)).toBe(3);
  });

  it("returns zero for an empty ledger instead of a placeholder", () => {
    expect(executionsInWindow([], NOW, 24)).toBe(0);
    expect(costInWindow([], NOW, 24)).toBe(0);
    expect(costPerAgent([], NOW)).toEqual([]);
  });

  it("sums provider spend from the rows themselves", () => {
    const ledger = [
      execution({ id: "e1", cost: 1.5 }),
      execution({ id: "e2", cost: 2.25 }),
      execution({ id: "e3", cost: 99, timestamp: new Date(NOW.getTime() - 40 * HOUR).toISOString() }),
    ];
    expect(costInWindow(ledger, NOW, 24)).toBe(3.75);
  });
});

describe("success rate reflects finished executions only", () => {
  it("excludes pending rows from the denominator", () => {
    const ledger = [
      execution({ id: "e1", status: "allowed" }),
      execution({ id: "e2", status: "allowed" }),
      execution({ id: "e3", status: "failed" }),
      execution({ id: "e4", status: "pending" }),
    ];
    // 2 of 3 finished executions succeeded.
    expect(successRate(ledger, NOW, 24)).toBe(66.7);
  });

  it("does not count a blocked action as a failure", () => {
    const ledger = [
      execution({ id: "e1", status: "allowed" }),
      execution({ id: "e2", status: "blocked" }),
      execution({ id: "e3", status: "blocked" }),
    ];
    // The Policy Engine denying two actions is the control plane working, not
    // an outage: the one permitted execution succeeded, so the rate is 100.
    expect(successRate(ledger, NOW, 24)).toBe(100);
    expect(successRateByDay(ledger, NOW, 7).at(-1)?.value).toBe(100);
  });

  it("reports 100 when nothing has failed yet", () => {
    expect(successRate([], NOW, 24)).toBe(100);
  });

  it("produces one point per day, oldest first", () => {
    const series = successRateByDay([], NOW, 7);
    expect(series).toHaveLength(7);
    expect(series.every((p) => p.value === 100)).toBe(true);
  });
});

describe("daily buckets split allowed from blocked", () => {
  it("places each execution in the right day", () => {
    const ledger = [
      execution({ id: "e1", status: "allowed" }),
      execution({
        id: "e2",
        status: "blocked",
        timestamp: new Date(NOW.getTime() - 25 * HOUR).toISOString(),
      }),
    ];
    const series = executionsByDay(ledger, NOW, 7);
    expect(series).toHaveLength(7);
    expect(series.at(-1)?.allowed).toBe(1);
    expect(series.at(-2)?.blocked).toBe(1);
  });
});

describe("the activity feed is the audit trail", () => {
  it("is empty when nothing has run", () => {
    expect(activityFromExecutions([], NOW)).toEqual([]);
  });

  it("renders audit entries newest first and classifies them", () => {
    const ledger = [
      execution({
        id: "e1",
        decision: "block",
        audit: [
          { at: new Date(NOW.getTime() - 3 * HOUR).toISOString(), actor: "Sales Agent", event: "Action requested", detail: "purchase" },
          { at: new Date(NOW.getTime() - 60_000).toISOString(), actor: "Policy Engine", event: "Action blocked", detail: "Category not allowed" },
        ],
      }),
    ];
    const feed = activityFromExecutions(ledger, NOW);
    expect(feed).toHaveLength(2);
    expect(feed[0].message).toContain("Action blocked");
    expect(feed[0].kind).toBe("blocked");
    expect(feed[1].kind).toBe("info");
    expect(feed[1].at).toBe("3h ago");
  });

  it("honours the limit so the dashboard stays bounded", () => {
    const ledger = Array.from({ length: 20 }, (_, i) =>
      execution({
        id: `e${i}`,
        audit: [{ at: new Date(NOW.getTime() - i * 60_000).toISOString(), actor: "System", event: "Decision made", detail: "" }],
      }),
    );
    expect(activityFromExecutions(ledger, NOW, 8)).toHaveLength(8);
  });
});
