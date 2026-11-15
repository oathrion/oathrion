/**
 * What `GET /api/approvals` returns once a pilot has been running for months.
 *
 * `script/pilot-sim.ts` aged a database to ninety days of one company's traffic
 * and then asked for exactly what the console asks for. `/api/executions` came
 * back with 300 rows and `/api/audit` with 200 — both already capped. But
 * `/api/approvals` returned **5 760 rows and 2.1 MB in one unpaginated response**,
 * because `SqliteApprovalRepository.list()` took no limit at all while its sibling
 * `executions.list(limit?)` did. On day one the table is empty, which is why no
 * existing test ever noticed.
 *
 * The obvious fix — return the newest N — would have been a silent bug, and this
 * file exists mainly to stop anyone applying it. Two places derive the pending
 * count by filtering the whole array:
 *
 *   - `client/src/components/layout/Sidebar.tsx:40` (the navigation badge)
 *   - `shared/metrics.ts:79` (`pendingApprovals` on the dashboard)
 *
 * Truncate to the newest 300 and an operator with 400 old pending approvals sees
 * a badge reading a number that is simply wrong, with nothing anywhere to say so.
 * That is precisely the "frontend must reflect backend truth" rule being broken.
 *
 * So the contract asserted below is narrower and provable: **every pending
 * approval is always returned; only resolved history is capped.** Pending is the
 * actionable set and the only thing anything counts; resolved rows are the part
 * that grows without bound and that nobody counts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestClient } from "./harness";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { computeDashboardMetrics } from "@shared/metrics";
import type { Approval } from "@shared/types";


/*
 * These tests exercise behaviour *within* one tenant, so they take the default
 * organization's repositories. Cross-tenant behaviour is not asserted here — it has
 * its own suite in `tenant-isolation.test.ts`, with two real organizations.
 */
const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

let api: TestClient;

/** Comfortably more resolved rows than the cap, so truncation must be observable. */
const RESOLVED_ROWS = 420;
/** More pending rows than would survive a naive "newest N" cap applied after them. */
const PENDING_ROWS = 40;

const RESOLVED_PREFIX = "apr_scale_resolved_";
const PENDING_PREFIX = "apr_scale_pending_";

function approval(id: string, status: Approval["status"], requestedAt: string): Approval {
  return {
    id,
    executionId: null,
    agentId: "agt_sales",
    agentName: "Sales Agent",
    title: "Scale fixture",
    summary: "Written by approval-list-scale.test.ts",
    requestedValue: "0 EUR",
    policyId: "pol_api_spend",
    policyName: "API spend ceiling",
    policyLimit: "500 EUR/day",
    risk: "high",
    status,
    requestedAt,
    context: [],
  };
}

beforeAll(async () => {
  api = await startTestServer();

  /*
   * Ordering matters. The resolved rows are given the *newest* timestamps and the
   * pending rows the oldest, which is the arrangement a naive newest-N cap fails:
   * the 420 newest rows are all resolved, so a plain limit would return zero
   * pending approvals and both counters above would read 0 while 40 requests sat
   * waiting for a human.
   */
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < PENDING_ROWS; i += 1) {
    await repositories.approvals.create(
      approval(`${PENDING_PREFIX}${i}`, "pending", new Date(base + i * 1000).toISOString()),
    );
  }
  const newerBase = base + 10_000_000;
  for (let i = 0; i < RESOLVED_ROWS; i += 1) {
    await repositories.approvals.create(
      approval(`${RESOLVED_PREFIX}${i}`, "approved", new Date(newerBase + i * 1000).toISOString()),
    );
  }
});

afterAll(async () => {
  await api.close();
});

describe("GET /api/approvals at pilot scale", () => {
  it("returns every pending approval, however old, and however much resolved history exists", async () => {
    const { status, body } = await api.get<Approval[]>("/api/approvals");
    expect(status).toBe(200);

    const returnedPendingIds = new Set(
      body.filter((a) => a.id.startsWith(PENDING_PREFIX)).map((a) => a.id),
    );
    for (let i = 0; i < PENDING_ROWS; i += 1) {
      expect(returnedPendingIds.has(`${PENDING_PREFIX}${i}`)).toBe(true);
    }
  });

  it("caps resolved history instead of returning all of it", async () => {
    const { body } = await api.get<Approval[]>("/api/approvals");
    const resolved = body.filter((a) => a.status !== "pending");
    // The cap is the point of the change: without one this is >= RESOLVED_ROWS.
    expect(resolved.length).toBeLessThan(RESOLVED_ROWS);
  });

  it("keeps the pending count the console displays equal to the pending count in the store", async () => {
    /*
     * The real regression guard. `Sidebar.tsx` and `shared/metrics.ts` both count
     * pending rows by filtering this response, so the number the operator sees is
     * only true if the response never omits a pending row. This asserts the two
     * against each other rather than against a constant, so it keeps holding as
     * fixtures from other suites come and go.
     */
    const { body } = await api.get<Approval[]>("/api/approvals");
    const storePending = (await repositories.approvals.list()).filter(
      (a) => a.status === "pending",
    ).length;
    const consoleWouldShow = body.filter((a) => a.status === "pending").length;
    expect(consoleWouldShow).toBe(storePending);

    const metrics = computeDashboardMetrics({
      agents: await repositories.agents.list(),
      executions: await repositories.executions.list(300),
      approvals: body,
      policies: await repositories.policies.list(),
    });
    expect(metrics.pendingApprovals).toBe(storePending);
  });

  it("stays newest-first after pending and resolved rows are merged", async () => {
    // Merging two ordered queries is easy to get wrong; the console renders this
    // order directly.
    const { body } = await api.get<Approval[]>("/api/approvals");
    const times = body.map((a) => Date.parse(a.requestedAt));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
  });
});
