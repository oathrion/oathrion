/**
 * Phase B, point 3 — daily budget TOCTOU.
 *
 * `DecisionService.decide()` wraps the daily-spend read, the full policy
 * re-evaluation and the Execution/Approval write in one call to
 * `repositories.decideAndPersist()`, which is a single `better-sqlite3`
 * `.transaction()` (see `decideAndPersistTx` in `server/repositories/sqlite.ts`).
 * better-sqlite3 transactions run fully synchronously and SQLite serialises
 * writers, so no second call to this transaction — for the same agent or a
 * different one — can read the daily total between this one's read and its
 * write. The classic read-then-write race is closed by construction, not by
 * hoping the interleaving window stays small.
 *
 * This suite proves it numerically rather than by inspecting `runState`: with
 * a 500 €/day ceiling (`pol_api_spend`) and five parallel 200 € requests, a
 * broken (non-atomic) implementation could let three or more through — three
 * separate reads could each observe "0 spent so far" before any write lands.
 * An atomic implementation admits exactly two, because after those two land
 * the daily total is 400 € and every following request sees a total that
 * would cross 500 € and is refused. The count is deterministic; only which
 * two of the five callers win the race is not, and this test does not care
 * which.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

interface Outcome {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  toolId: string | null;
  executionId: string | null;
}

describe("daily budget — atomic under a parallel burst", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("admits exactly floor(ceiling / request cost), never more", async () => {
    // agt_data has no other test in this suite spending against `cost`, so
    // this agent's rolling daily total starts at 0 for this assertion.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api.post<Outcome>(
          "/api/executions",
          {
            agentId: "agt_data",
            action: "query",
            target: "warehouse.dim_customer",
            metadata: { cost: 200, currency: "EUR" },
          },
          { auth: ROLE_KEYS.operator },
        ),
      ),
    );

    const allowed = results.filter((r) => r.body.decision === "ALLOW");
    const blocked = results.filter((r) => r.body.decision === "BLOCK");

    // 500 / 200 = 2.5 → exactly two requests fit, regardless of arrival order.
    expect(allowed.length).toBe(2);
    expect(blocked.length).toBe(3);

    // The invariant that actually matters: a blocked request never carries a
    // toolId and never reached dispatch.
    for (const r of blocked) {
      expect(r.body.toolId).toBeNull();
    }
  });
});
