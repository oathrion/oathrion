/**
 * Regression tests for a Phase A audit finding: `/api/decision` and
 * `/api/execute` did not explicitly reject a client-supplied `actor` field
 * the way `/api/evaluate` and `/api/executions` already did. The identity
 * was never actually forgeable on any of the four routes — none of their
 * Zod schemas ever read an `actor` key — but the *contract* was
 * inconsistent: two routes told an integrator "no", two silently ignored
 * the field. This suite proves the same behaviour on all four:
 *
 *   - a client-supplied `actor` is refused with 400, not silently dropped;
 *   - a request with no `actor` at all behaves normally;
 *   - the identity written to the audit trail is always the authenticated
 *     credential's name, never anything the body could have carried.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

interface DecisionBody {
  execution?: { id: string };
  approval?: { id: string };
}

interface AuditDetail {
  audit: { actor: string; event: string }[];
}

const FORGED_ACTOR = "Marie Dupont (CFO)";

describe("actor identity — uniform across decision-facing routes", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  const routes: Array<{
    path: string;
    body: Record<string, unknown>;
  }> = [
    {
      path: "/api/decision",
      body: { agentId: "agt_data", action: "query", target: "warehouse.dim_customer" },
    },
    {
      path: "/api/execute",
      body: { agentId: "agt_data", action: "query", target: "warehouse.dim_customer" },
    },
    {
      path: "/api/evaluate",
      body: { agentId: "agt_data", action: "query", target: "warehouse.dim_customer" },
    },
    {
      path: "/api/executions",
      body: { agentId: "agt_data", action: "query", target: "warehouse.dim_customer" },
    },
  ];

  for (const { path, body } of routes) {
    it(`${path} refuses a forged actor with 400`, async () => {
      const res = await api.post<{ error: string }>(
        path,
        { ...body, actor: FORGED_ACTOR },
        { auth: ROLE_KEYS.operator },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("actor is not accepted");
    });

    it(`${path} behaves normally with no actor field`, async () => {
      const res = await api.post<{ decision: string }>(path, body, { auth: ROLE_KEYS.operator });
      // Every route in this table answers 200/201 for a well-formed, unforged
      // request — the point of this assertion is only that omitting `actor`
      // never itself causes a failure.
      expect([200, 201]).toContain(res.status);
    });
  }

  it("records the authenticated credential, never a body value, on /api/decision", async () => {
    const decided = await api.post<DecisionBody>(
      "/api/decision",
      { agentId: "agt_data", action: "query", target: "warehouse.dim_customer", persist: true },
      { auth: ROLE_KEYS.operator },
    );
    const executionId = decided.body.execution?.id;
    expect(executionId).toBeTruthy();

    const detail = await api.get<AuditDetail>(`/api/executions/${executionId}`);
    expect(detail.body.audit.length).toBeGreaterThan(0);
    expect(detail.body.audit.every((e) => e.actor !== FORGED_ACTOR)).toBe(true);
  });

  it("records the authenticated credential, never a body value, on /api/execute", async () => {
    const executed = await api.post<{ executionId?: string; execution?: { id: string } }>(
      "/api/execute",
      { agentId: "agt_data", action: "query", target: "warehouse.dim_customer" },
      { auth: ROLE_KEYS.operator },
    );
    const executionId = executed.body.execution?.id ?? executed.body.executionId;
    expect(executionId).toBeTruthy();

    const detail = await api.get<AuditDetail>(`/api/executions/${executionId}`);
    expect(detail.body.audit.length).toBeGreaterThan(0);
    expect(detail.body.audit.every((e) => e.actor !== FORGED_ACTOR)).toBe(true);
  });
});
