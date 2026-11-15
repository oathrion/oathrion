/**
 * Regression tests for the defects found during the pre-release audit.
 *
 * Each block names the bug it pins down. They are grouped in one file on
 * purpose: a reader auditing "what went wrong before release" gets the whole
 * list in one place, and every case here failed before its fix.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { sessionStore } from "../repositories/sessions";
import { rawDb } from "../db";
import { startTestServer, ROLE_KEYS, type DecisionBody, type TestClient } from "./harness";


/*
 * These tests exercise behaviour *within* one tenant, so they take the default
 * organization's repositories. Cross-tenant behaviour is not asserted here — it has
 * its own suite in `tenant-isolation.test.ts`, with two real organizations.
 */
const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

/** An action the seeded `pol_email_approval` policy holds for a human. */
const HELD_ACTION = {
  // `agt_sales` carries `send:email` and no category mandate, so the policy
  // — not a mandate — decides.
  agentId: "agt_sales",
  action: "send_email",
  target: "external_email",
  metadata: { recipient: "someone@outside.example", cost: 0 },
};

describe("expired-session sweep compares comparable timestamps", () => {
  it("sees an ISO-8601 expiry as past when it is past", () => {
    /*
     * The boot sweep used to compare the JS ISO string in `expires_at`
     * ("2026-08-19T01:00:00.000Z") against SQLite's `datetime('now')`
     * ("2026-08-19 01:00:00") with a plain `<`. The strings diverge at index 10:
     * 'T' (0x54) sorts after ' ' (0x20), so a session that expired earlier the
     * same day compared as *greater* than now and was never swept. The fix binds
     * a JS ISO string, so both sides of the comparison share one format.
     */
    const session = sessionStore.create({
      organizationId: DEFAULT_ORGANIZATION_ID,
      subject: "sweep@test",
      name: "Sweep",
      role: "viewer",
      ttlMs: -60_000, // already expired, one minute ago
      // Store-level probe: this row never goes through resolveBearer, so the
      // credential fingerprint is inert here. Kept explicit so the field stays
      // required for the real sign-in path.
      credentialFp: "fp:store-level-probe",
    });

    const matched = rawDb
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE id = ? AND revoked_at IS NULL AND expires_at < ?`,
      )
      .get(session.id, new Date().toISOString()) as { n: number };

    expect(matched.n).toBe(1);

    // The same row under the old, mixed-format comparison: not matched.
    const legacy = rawDb
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE id = ? AND revoked_at IS NULL AND expires_at < datetime('now')`,
      )
      .get(session.id) as { n: number };
    expect(legacy.n).toBe(0);
  });

  it("refuses an expired session at resolve time as well", () => {
    const session = sessionStore.create({
      organizationId: DEFAULT_ORGANIZATION_ID,
      subject: "expired@test",
      name: "Expired",
      role: "admin",
      ttlMs: -1,
      // Store-level probe: this row never goes through resolveBearer, so the
      // credential fingerprint is inert here. Kept explicit so the field stays
      // required for the real sign-in path.
      credentialFp: "fp:store-level-probe",
    });
    expect(sessionStore.resolveActive(session.id)).toBeNull();
  });
});

describe("an approval can only be resolved once", () => {
  it("does not dispatch, or re-audit, on a repeated approve", async () => {
    // Provoke a real APPROVAL_REQUIRED verdict rather than fabricating a row:
    // the bug lived in the resolve path of a genuine pending approval.
    const decision = await client.post<DecisionBody>("/api/decision", HELD_ACTION);
    expect(decision.body.decision).toBe("APPROVAL_REQUIRED");
    const approvalId = decision.body.approvalId;
    expect(approvalId).toBeTruthy();

    const first = await client.post<{ executed: boolean }>(
      `/api/approvals/${approvalId}/approve`,
      {},
      { auth: ROLE_KEYS.approver },
    );
    const second = await client.post<{ executed: boolean }>(
      `/api/approvals/${approvalId}/approve`,
      {},
      { auth: ROLE_KEYS.approver },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The second call must claim nothing. Before the fix both callers believed
    // they had performed the write, which duplicated the "Approval granted"
    // audit entry, the `approval.resolved` notification and the tool dispatch.
    expect(second.body.executed).toBe(false);

    const execution = await repositories.executions.findById(decision.body.executionId!);
    const granted = (execution?.audit ?? []).filter((entry) => /granted/i.test(entry.event));
    expect(granted).toHaveLength(1);
  });

  /*
   * The SAME invariant under contention, and it is a separate test for a reason.
   *
   * A mutation audit disabled the early `before.status !== "pending"` return and the
   * suite stayed green; it then disabled the conditional UPDATE's `claimed` result and
   * the suite stayed green again. Both survived individually, and disabling the two
   * together turned this file red. Idempotency here is defence in depth: the early
   * return covers the sequential double-click, the atomic UPDATE covers the real race,
   * and the test above only exercises the first one — so the layer that protects
   * against two approvers clicking at the same instant had nothing pinning it down.
   *
   * This test issues both approvals concurrently, so the early return cannot help: both
   * requests read `pending` before either writes. Only the conditional UPDATE can keep
   * the second one from dispatching the tool a second time.
   */
  it("does not dispatch twice when two approvers resolve the same approval at once", async () => {
    const decision = await client.post<DecisionBody>("/api/decision", HELD_ACTION);
    expect(decision.body.decision).toBe("APPROVAL_REQUIRED");
    const approvalId = decision.body.approvalId;
    expect(approvalId).toBeTruthy();

    // Fired together, not awaited in turn: the point is that both are in flight
    // before either has committed.
    const [a, b] = await Promise.all([
      client.post<{ executed: boolean }>(
        `/api/approvals/${approvalId}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      ),
      client.post<{ executed: boolean }>(
        `/api/approvals/${approvalId}/approve`,
        {},
        { auth: ROLE_KEYS.admin },
      ),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Exactly one of the two may claim the resolution. Which one is a race and is
    // deliberately not asserted; that there is exactly one is the invariant.
    const claims = [a.body.executed, b.body.executed].filter(Boolean);
    expect(claims, "exactly one caller may claim the approval").toHaveLength(1);

    // The durable evidence: one human decision leaves one audit entry.
    const execution = await repositories.executions.findById(decision.body.executionId!);
    const granted = (execution?.audit ?? []).filter((entry) => /granted/i.test(entry.event));
    expect(granted, "a concurrent double-approve duplicated the audit trail").toHaveLength(1);

    // And one resolution: a second write would overwrite the recorded approver,
    // erasing who actually authorised the spend.
    const approval = await repositories.approvals.findById(approvalId!);
    expect(approval?.status).toBe("approved");
  });
});

describe("the policy trigger counter is committed with the decision", () => {
  it("increments exactly once per decision that matched a policy", async () => {
    const before = await repositories.policies.list();
    const decision = await client.post<DecisionBody>("/api/decision", HELD_ACTION);

    const policyId = decision.body.policyId;
    expect(policyId).toBeTruthy();

    const after = await repositories.policies.list();
    const priorCount = before.find((p) => p.id === policyId)?.triggeredCount ?? 0;
    const newCount = after.find((p) => p.id === policyId)?.triggeredCount ?? 0;

    // The increment used to run after the persistence transaction returned, so
    // a crash in between lost it; it now lands in the same commit as the row.
    expect(newCount).toBe(priorCount + 1);
  });
});

describe("the verification scenario printed in DEPLOYMENT.md works verbatim", () => {
  /*
   * §10 of the deployment guide tells an operator to POST a body carrying
   * `amount` and `currency` side by side — the natural way to state a sum of
   * money. The strict schemas promoted `amount` but not `currency`, so every
   * command in the guide answered `400 Unrecognized key: "currency"` and the
   * post-install check could not be completed. `currency` is now a first-class
   * field, folded into `metadata` like `amount` and `category`.
   */
  const body = (amount: number, category = "Software") => ({
    agentId: "agt_procurement",
    action: "purchase",
    target: "vendor.company.com",
    amount,
    currency: "EUR",
    category,
  });

  it("accepts a top-level currency on /api/executions", async () => {
    const res = await client.post<{ decision: string }>("/api/executions", body(40));
    expect(res.status).toBe(201);
    expect(res.body.decision).toBe("ALLOW");
  });

  it("accepts a top-level currency on /api/evaluate", async () => {
    const res = await client.post<{ decision: string }>("/api/evaluate", body(40));
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("ALLOW");
  });

  it("still reads the currency, rather than merely tolerating the field", async () => {
    // A non-EUR amount cannot be compared with a EUR ceiling, so it must be
    // refused. If the promoted field were dropped instead of forwarded, this
    // would come back ALLOW and the promotion would be silently decorative.
    const res = await client.post<{ decision: string }>("/api/evaluate", {
      ...body(40),
      currency: "USD",
    });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("BLOCK");
  });

  it("holds an amount above the mandate for approval and blocks one above the policy", async () => {
    const held = await client.post<{ decision: string; toolId?: string }>(
      "/api/evaluate",
      body(700),
    );
    const blocked = await client.post<{ decision: string; toolId?: string }>(
      "/api/evaluate",
      body(40, "Cryptocurrency"),
    );
    expect(held.body.decision).not.toBe("ALLOW");
    expect(blocked.body.decision).toBe("BLOCK");
    // The point of the guide's table: no tool is named on a verdict that is not
    // an allow, which is the evidence nothing was executed.
    expect(held.body.toolId ?? null).toBeNull();
    expect(blocked.body.toolId ?? null).toBeNull();
  });
});

describe("unknown API paths answer as an API", () => {
  it("returns JSON 404 rather than the console's index.html", async () => {
    const res = await client.get<{ message?: string }>("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });
});
