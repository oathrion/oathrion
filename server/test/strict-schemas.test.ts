/**
 * Phase A closure — Zod strictness. `decisionSchema`, `executeSchema`,
 * `evaluateSchema` and `executionCreateSchema` were built with `z.object()`,
 * which silently drops unknown top-level keys instead of rejecting them.
 * Functionally harmless (the dropped key was never read), but inconsistent
 * with the rest of the write-path contracts (`agentCreateSchema`,
 * `policyCreateSchema`, `approvalResolveSchema`, the login schema), which all
 * reject an unrecognised key with 400. This suite proves the same behaviour
 * now holds on all four routes, for a key that has nothing to do with
 * identity (that guarantee is covered separately in `actor-identity.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const UNKNOWN_FIELD_BODY = {
  agentId: "agt_data",
  action: "query",
  target: "warehouse.dim_customer",
  totallyUnexpectedField: "should never be silently accepted",
};

describe("strict schemas — unknown top-level field is rejected, not dropped", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  const routes = ["/api/decision", "/api/execute", "/api/evaluate", "/api/executions"];

  for (const path of routes) {
    it(`${path} returns 400 on an unrecognised body key`, async () => {
      const res = await api.post<{ error: string }>(path, UNKNOWN_FIELD_BODY, {
        auth: ROLE_KEYS.operator,
      });

      // A real 400, not a 200/201 that silently ignored the field.
      expect(res.status).toBe(400);
      // The route must still work normally without the stray field — proves
      // the 400 is specifically about the unknown key, not a body shape the
      // route would have rejected anyway.
    });

    it(`${path} accepts the same body once the unrecognised field is removed`, async () => {
      const { totallyUnexpectedField: _drop, ...clean } = UNKNOWN_FIELD_BODY;
      const res = await api.post<{ decision?: string }>(path, clean, { auth: ROLE_KEYS.operator });
      expect([200, 201]).toContain(res.status);
    });
  }
});
