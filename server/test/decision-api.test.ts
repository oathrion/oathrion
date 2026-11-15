/**
 * Core-product validation.
 *
 * These tests prove the full chain end to end, over real HTTP, against the real
 * SQLite store:
 *
 *   POST /api/decision → DecisionService → evaluateAction() → Execution
 *                      → Approval (when required) → audit trail
 *
 * Nothing here touches React. If the UI were deleted, every assertion below
 * would still hold.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startTestServer,
  TEST_SERVICE_IDENTITY,
  type DecisionBody,
  type TestClient,
} from "./harness";

const PROCUREMENT = "agt_procurement";
const DATA = "agt_data";
const SUPPORT = "agt_support";

let api: TestClient;

async function decide(
  agentId: string,
  action: string,
  target: string,
  metadata: Record<string, unknown> = {},
) {
  const res = await api.post<DecisionBody>("/api/decision", { agentId, action, target, metadata });
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  api = await startTestServer();
});

afterAll(async () => {
  await api.close();
});

/* ------------------------------------------------------------------ *
 * 1. The five reference scenarios
 * ------------------------------------------------------------------ */

describe("reference scenarios", () => {
  it("Test 1 — Procurement Agent · purchase · $420 → ALLOW (inside its mandate)", async () => {
    const r = await decide(PROCUREMENT, "purchase", "supplier-x.com", {
      amount: 420,
      category: "Office supplies",
    });
    expect(r.decision).toBe("ALLOW");
  });

  it("Test 2 — Procurement Agent · purchase · $850 → APPROVAL_REQUIRED (mandate limit $500)", async () => {
    const r = await decide(PROCUREMENT, "purchase", "supplier-x.com", {
      amount: 850,
      category: "Office supplies",
    });
    expect(r.decision).toBe("APPROVAL_REQUIRED");
    /*
     * Phase 12.3: the euro now keeps its centimes. The previous formatter pinned
     * `maximumFractionDigits: 0` for every currency, so an amount of 850,50 € was
     * rendered "851 €" in the reason an operator reads and in the audit entry — the
     * number that justified the decision was not the number decided on. The fraction
     * digits now come from the currency registry, which is also what lets the franc CFA
     * render without decimals it does not have.
     */
    expect(r.reason).toContain("autonomous spending limit of 500,00 €");
  });

  it("Test 3 — Data Agent · purchase · $10,001 → APPROVAL_REQUIRED (org ceiling)", async () => {
    const r = await decide(DATA, "purchase", "shop", { amount: 10001 });
    expect(r.decision).toBe("APPROVAL_REQUIRED");
    expect(r.policyName).toBe("Maximum purchase amount");
    expect(r.riskLevel).toBe("HIGH");
  });

  it("Test 4 — Data Agent · access · production_database → BLOCK", async () => {
    const r = await decide(DATA, "access", "production_database");
    expect(r.decision).toBe("BLOCK");
    expect(r.policyName).toBe("Production database protection");
    expect(r.riskLevel).toBe("CRITICAL");
  });

  it("Test 5 — Support Agent · send_email · external_email → APPROVAL_REQUIRED", async () => {
    const r = await decide(SUPPORT, "send_email", "external_email");
    expect(r.decision).toBe("APPROVAL_REQUIRED");
    expect(r.policyName).toBe("External email approval");
  });
});

/* ------------------------------------------------------------------ *
 * 2. Numeric boundaries — 9999 / 10000 / 10001
 * ------------------------------------------------------------------ */

describe("numeric boundaries around the $10,000 org ceiling (agent with no mandate limit)", () => {
  it("9999 → ALLOW (strictly under)", async () => {
    expect((await decide(DATA, "purchase", "shop", { amount: 9999 })).decision).toBe("ALLOW");
  });

  it("10000 → ALLOW (the limit is inclusive)", async () => {
    expect((await decide(DATA, "purchase", "shop", { amount: 10000 })).decision).toBe("ALLOW");
  });

  it("10001 → APPROVAL_REQUIRED (first value over)", async () => {
    expect((await decide(DATA, "purchase", "shop", { amount: 10001 })).decision).toBe(
      "APPROVAL_REQUIRED",
    );
  });

  it("10000.01 → APPROVAL_REQUIRED (no float truncation)", async () => {
    expect((await decide(DATA, "purchase", "shop", { amount: 10000.01 })).decision).toBe(
      "APPROVAL_REQUIRED",
    );
  });

  it('"$10,000" as a formatted string → ALLOW (no lexicographic comparison)', async () => {
    expect((await decide(DATA, "purchase", "shop", { amount: "$10,000" })).decision).toBe(
      "ALLOW",
    );
  });

  it('"9999" as a string → ALLOW, not treated as > "10000"', async () => {
    expect((await decide(DATA, "purchase", "shop", { amount: "9999" })).decision).toBe(
      "ALLOW",
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. API contract
 * ------------------------------------------------------------------ */

describe("POST /api/decision contract", () => {
  it("returns decision, reason, policyId and riskLevel", async () => {
    const r = await decide(DATA, "purchase", "shop", { amount: 12000 });
    expect(r).toMatchObject({
      decision: "APPROVAL_REQUIRED",
      policyId: "pol_purchase_limit",
      riskLevel: "HIGH",
    });
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await api.post("/api/decision", { action: "purchase" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown agent with 404", async () => {
    const res = await api.post("/api/decision", {
      agentId: "agt_does_not_exist",
      action: "purchase",
      target: "supplier-x.com",
    });
    expect(res.status).toBe(404);
  });

  it("supports a dry run that returns a verdict without persisting", async () => {
    const before = await api.get<unknown[]>("/api/executions");
    const res = await api.post<DecisionBody>("/api/decision", {
      agentId: DATA,
      action: "purchase",
      target: "supplier-x.com",
      metadata: { amount: 99999, category: "Equipment" },
      persist: false,
    });
    expect(res.body.decision).toBe("APPROVAL_REQUIRED");
    expect(res.body.executionId).toBeNull();
    const after = await api.get<unknown[]>("/api/executions");
    expect(after.body.length).toBe(before.body.length);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Execution records
 * ------------------------------------------------------------------ */

describe("every decision leaves an Execution", () => {
  it("persists agentId, action, target, input, decision, policyId, risk and timestamp", async () => {
    const r = await decide(DATA, "purchase", "shop", { amount: 7500 });
    const id = r.executionId;
    expect(id).toBeTruthy();

    const stored = await api.get<DecisionBody["execution"]>(`/api/executions/${id}`);
    expect(stored.status).toBe(200);
    const e = stored.body!;
    expect(e.agentId).toBe(DATA);
    expect(e.action).toBe("purchase");
    expect(e.target).toBe("shop");
    expect(e.input.amount).toBe(7500);
    expect(e.decision).toBe("allow");
    expect(e.policyId).toBe("pol_purchase_limit");
    expect(e.risk).toBe("low");
    expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
  });

  it("survives a reload from the store, not just the response payload", async () => {
    const r = await decide(DATA, "access", "production_database");
    const list = await api.get<{ id: string }[]>("/api/executions");
    expect(list.body.some((e) => e.id === r.executionId)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 5. ALLOW / BLOCK / APPROVAL_REQUIRED side effects
 * ------------------------------------------------------------------ */

describe("decision side effects", () => {
  it("ALLOW → execution allowed, no approval created", async () => {
    const before = await api.get<unknown[]>("/api/approvals");
    const r = await decide(DATA, "purchase", "shop", { amount: 4200 });
    expect(r.execution?.status).toBe("allowed");
    expect(r.approvalId).toBeNull();
    const after = await api.get<unknown[]>("/api/approvals");
    expect(after.body.length).toBe(before.body.length);
  });

  it("BLOCK → execution blocked, no approval created", async () => {
    const before = await api.get<unknown[]>("/api/approvals");
    const r = await decide(DATA, "access", "production_database");
    expect(r.execution?.status).toBe("blocked");
    expect(r.approvalId).toBeNull();
    expect(r.execution?.approvalId).toBeNull();
    const after = await api.get<unknown[]>("/api/approvals");
    expect(after.body.length).toBe(before.body.length);
  });

  it("APPROVAL_REQUIRED → execution pending, linked approval created", async () => {
    const r = await decide(DATA, "purchase", "shop", { amount: 12000 });
    expect(r.execution?.status).toBe("pending");
    expect(r.approvalId).toBeTruthy();
    expect(r.execution?.approvalId).toBe(r.approvalId);
    expect(r.approval?.executionId).toBe(r.executionId);

    const list = await api.get<{ id: string; status: string }[]>("/api/approvals");
    const found = list.body.find((a) => a.id === r.approvalId);
    expect(found?.status).toBe("pending");
  });
});

/* ------------------------------------------------------------------ *
 * 6. Approval resolution mutates the data layer
 * ------------------------------------------------------------------ */

describe("resolving an approval", () => {
  it("approve → approval approved AND execution becomes allowed in the store", async () => {
    const r = await decide(DATA, "purchase", "shop", { amount: 12000 });
    const res = await api.post(`/api/approvals/${r.approvalId}/approve`, {});
    expect(res.status).toBe(200);

    const approval = (await api.get<{ status: string; resolvedBy: string | null }>(
      `/api/approvals/${r.approvalId}`,
    )).body;
    expect(approval.status).toBe("approved");
    // The approver comes from the authenticated credential, not the body.
    expect(approval.resolvedBy).toBe(TEST_SERVICE_IDENTITY);

    const execution = (await api.get<DecisionBody["execution"]>(
      `/api/executions/${r.executionId}`,
    )).body!;
    expect(execution.status).toBe("allowed");
    expect(execution.decision).toBe("allow");
  });

  it("reject → approval rejected AND execution becomes blocked in the store", async () => {
    const r = await decide(DATA, "purchase", "shop", { amount: 15000 });
    const res = await api.post(`/api/approvals/${r.approvalId}/reject`, {});
    expect(res.status).toBe(200);

    const approval = (await api.get<{ status: string }>(`/api/approvals/${r.approvalId}`)).body;
    expect(approval.status).toBe("rejected");

    const execution = (await api.get<DecisionBody["execution"]>(
      `/api/executions/${r.executionId}`,
    )).body!;
    expect(execution.status).toBe("blocked");
    expect(execution.decision).toBe("block");
  });

  it("returns 404 for an unknown approval", async () => {
    const res = await api.post("/api/approvals/apr_nope/approve", {});
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Audit trail
 * ------------------------------------------------------------------ */

describe("audit trail", () => {
  it("records request → verdict → approval created → approval granted", async () => {
    const r = await decide(DATA, "purchase", "shop", { amount: 12000 });
    expect(r.execution?.audit.map((a) => a.event)).toEqual([
      "Action requested",
      "Policy evaluated",
      "Approval requested",
    ]);

    await api.post(`/api/approvals/${r.approvalId}/approve`, {});
    const execution = (await api.get<DecisionBody["execution"]>(
      `/api/executions/${r.executionId}`,
    )).body!;

    // Approving now routes through the Gateway, which appends the two tool
    // events after the grant.
    expect(execution.audit).toHaveLength(6);
    expect(execution.audit[3].event).toBe("Approval granted");
    expect(execution.audit[3].actor).toBe(TEST_SERVICE_IDENTITY);
    for (const entry of execution.audit) {
      expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
    }
  });

  it("records the rejection on the audit trail", async () => {
    const r = await decide(DATA, "purchase", "shop", { amount: 15000 });
    await api.post(`/api/approvals/${r.approvalId}/reject`, {});
    const execution = (await api.get<DecisionBody["execution"]>(
      `/api/executions/${r.executionId}`,
    )).body!;
    expect(execution.audit.at(-1)?.event).toBe("Approval rejected");
  });

  it("records a BLOCK verdict without an approval entry", async () => {
    const r = await decide(DATA, "access", "production_database");
    expect(r.execution?.audit.map((a) => a.event)).toEqual([
      "Action requested",
      "Policy evaluated",
      "Action blocked",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 8. The engine is the source of truth, not the UI
 * ------------------------------------------------------------------ */

describe("policies drive the outcome", () => {
  it("disabling a policy changes the verdict for the same request", async () => {
    expect((await decide(DATA, "access", "production_database")).decision).toBe("BLOCK");

    await api.patch("/api/policies/pol_db_prod", { status: "disabled" });
    const relaxed = await decide(DATA, "access", "production_database");
    expect(relaxed.decision).toBe("ALLOW");

    await api.patch("/api/policies/pol_db_prod", { status: "enabled" });
    expect((await decide(DATA, "access", "production_database")).decision).toBe("BLOCK");
  });

  it("a paused agent is refused before any policy is consulted", async () => {
    await api.patch(`/api/agents/${PROCUREMENT}`, { status: "paused" });
    const r = await decide(PROCUREMENT, "purchase", "shop", { amount: 10 });
    expect(r.decision).toBe("BLOCK");
    expect(r.policyId).toBeNull();
    await api.patch(`/api/agents/${PROCUREMENT}`, { status: "active" });
  });
});

/* ------------------------------------------------------------------ *
 * 9. Reproducible end-to-end demo
 * ------------------------------------------------------------------ */

describe("end-to-end demo scenario", () => {
  it("$12,000 → approval → APPROVED, then $15,000 → reject → BLOCKED", async () => {
    // Step 1 — the $12,000 purchase is escalated.
    const first = await decide(DATA, "purchase", "shop", { amount: 12000 });
    expect(first.decision).toBe("APPROVAL_REQUIRED");
    expect(first.policyName).toBe("Maximum purchase amount");
    expect(first.riskLevel).toBe("HIGH");
    expect(first.reason).toContain("exceeds");
    expect(first.reason).toContain("10 000,00 €");

    // Step 2 — a human approves it.
    await api.post(`/api/approvals/${first.approvalId}/approve`, {});
    const approved = (await api.get<DecisionBody["execution"]>(
      `/api/executions/${first.executionId}`,
    )).body!;
    expect(approved.status).toBe("allowed");

    // Step 3 — the $15,000 purchase is escalated too.
    const second = await decide(DATA, "purchase", "shop", { amount: 15000 });
    expect(second.decision).toBe("APPROVAL_REQUIRED");

    // Step 4 — a human rejects it.
    await api.post(`/api/approvals/${second.approvalId}/reject`, {});
    const rejected = (await api.get<DecisionBody["execution"]>(
      `/api/executions/${second.executionId}`,
    )).body!;
    expect(rejected.status).toBe("blocked");

    // Both executions are distinct rows in the ledger.
    expect(first.executionId).not.toBe(second.executionId);
  });
});
