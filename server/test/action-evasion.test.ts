/**
 * Red team on action-name evasion of financial protections.
 *
 * HISTORY OF THIS FILE
 * --------------------
 * It used to assert the OPPOSITE of what it asserts now, and deliberately so. Its
 * original header explained that verbs like `refund`, `payout`, `reimburse`,
 * `withdraw` and `charge` were covered by none of the amount-checking mechanisms,
 * that a €999,999,999 `refund` therefore produced a decision of `ALLOW` via the
 * engine's permissive default, and that this was safe only because
 * `ToolRegistry`'s hand-written action→tool table happened not to wire a tool to
 * any of them — so `dispatch()` marked the run "skipped" and nothing ran.
 *
 * It then said, correctly:
 *
 *   "That is a real, working safety net today, but it is an *incidental* one:
 *    nothing in the codebase asserts that every tool carrying financial
 *    semantics is also covered by both amount-check action lists. If a future
 *    `refund_tool` were wired to action "refund" without someone remembering to
 *    also add "refund" to SPENDING_ACTIONS and to pol_purchase_limit, the bypass
 *    would become real and silent."
 *
 * The protection is no longer incidental, so this file no longer pins a
 * permissive decision. Three changes made the difference:
 *
 *   1. `shared/policy/actions.ts` is now the single source of truth for which
 *      verbs are financial/outbound and what scope each requires. It replaced
 *      the three drifting lists (`requiredPermissionForAction`,
 *      `SPENDING_ACTIONS`, `OUTBOUND_ACTIONS`), and every verb named above is
 *      declared financial and gated on `execute:payments`.
 *   2. `ToolRegistry` refuses at construction time to wire a tool to a verb that
 *      is not declared in the catalog, or that is declared without a required
 *      scope. The "future refund_tool" scenario is now a boot failure, not a
 *      silent hole.
 *   3. The engine asserts that money never moves without a ceiling: a financial
 *      verb that no mandate ceiling and no MAX_TRANSACTION_AMOUNT policy governs
 *      is held for a human rather than allowed by default. This was the gap that
 *      survived (1) — `agt_data` legitimately holds `execute:payments` and has no
 *      mandate ceiling, and the shipped `pol_purchase_limit` names only
 *      `purchase`, `payment` and `checkout`, so a `refund` passed the permission
 *      barrier with no amount check of any kind.
 *
 * `shared/policy/dangerous-action-coverage.test.ts` holds the invariants; this
 * file keeps the end-to-end HTTP proof that the evasion attempt fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

interface Outcome {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  executed?: boolean;
  reason: string;
  toolId: string | null;
  executionId: string | null;
}

/**
 * Every seeded agent that is `active` happens to hold `execute:payments`, and the
 * agents that lack it are `paused`, `draft` or `review` — so they are stopped by
 * the lifecycle guard before the permission barrier is ever consulted. Proving the
 * barrier end-to-end therefore needs a purpose-built agent: active, no payment
 * authority, and a generous ceiling so that nothing but the missing scope can be
 * responsible for the refusal.
 */
const UNPRIVILEGED_AGENT = {
  id: "agt_test_unprivileged",
  name: "Unprivileged Test Agent",
  description: "Active agent deliberately without execute:payments.",
  provider: "openai" as const,
  model: "gpt-4.1-mini",
  status: "active" as const,
  owner: "Test Suite",
  mandate: {
    maxTransactionAmount: 1_000_000,
    currency: "EUR" as const,
    allowedCategories: [],
    blockedCategories: [],
    allowedDomains: [],
  },
  permissions: [
    {
      scope: "read:files" as const,
      label: "Read files",
      description: "Read documents.",
      granted: true,
      risk: "low" as const,
    },
  ],
  policyIds: [],
  tags: ["test"],
};

describe("action-name evasion of financial protections", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
    const created = await api.post("/api/agents", UNPRIVILEGED_AGENT, {
      auth: ROLE_KEYS.admin,
    });
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    await api.close();
  });

  it.each(["refund", "payout", "reimburse", "withdraw", "charge"])(
    "%s: a huge amount is never allowed autonomously, and never dispatches",
    async (action) => {
      const res = await api.post<Outcome>(
        "/api/execute",
        {
          agentId: "agt_data",
          action,
          target: "warehouse.dim_customer",
          metadata: { amount: 999_999_999 },
        },
        { auth: ROLE_KEYS.operator },
      );

      // `agt_data` holds `execute:payments`, so it clears the permission barrier.
      // What stops it is the ceiling invariant: no mandate ceiling and no
      // MAX_TRANSACTION_AMOUNT policy governs these verbs for this agent, so the
      // amount was never checked against a limit and cannot be released.
      expect(res.body.decision).toBe("APPROVAL_REQUIRED");
      expect(res.body.reason).toMatch(/ceiling|limit/i);

      // The original safety net still holds too: nothing was, in fact, run.
      expect(res.body.executed).toBe(false);
      expect(res.body.toolId).toBeNull();
    },
  );

  it.each(["refund", "payout", "withdraw", "charge", "reimburse", "transfer", "subscribe"])(
    "%s is refused outright for an agent that lacks execute:payments",
    async (action) => {
      // Before the catalog, none of these verbs required any permission, so this
      // agent reached the same permissive ALLOW as an agent that had actually been
      // granted payment authority. The amount is trivial and well inside the
      // agent's €1,000,000 ceiling, so only the missing scope can explain a BLOCK.
      const res = await api.post<Outcome>(
        "/api/execute",
        {
          agentId: UNPRIVILEGED_AGENT.id,
          action,
          target: "vendor.example.com",
          metadata: { amount: 10 },
        },
        { auth: ROLE_KEYS.operator },
      );

      expect(res.body.decision).toBe("BLOCK");
      expect(res.body.reason).toContain("execute:payments");
      expect(res.body.executed).toBe(false);
      expect(res.body.toolId).toBeNull();
    },
  );

  it.each(["refund", "payout", "withdraw", "charge", "reimburse"])(
    "%s above the agent's mandate ceiling is now held for approval",
    async (action) => {
      // `agt_support`'s mandate caps autonomous spend at €100. These verbs were
      // absent from the old `SPENDING_ACTIONS`, so the ceiling did not apply to
      // them and €500 sailed through as ALLOW. Deriving `SPENDING_ACTIONS` from the
      // catalog is what brings them under the ceiling the operator already set.
      const res = await api.post<Outcome>(
        "/api/execute",
        { agentId: "agt_support", action, target: "vendor.example.com", metadata: { amount: 500 } },
        { auth: ROLE_KEYS.operator },
      );

      expect(res.body.decision).toBe("APPROVAL_REQUIRED");
      expect(res.body.executed).toBe(false);
    },
  );

  it("a refund within the agent's mandate ceiling still runs autonomously", async () => {
    // The ceiling is a ceiling, not a blanket ban: €50 is inside `agt_support`'s
    // €100 mandate, so the action is allowed. Hardening must not turn every
    // financial verb into an approval queue.
    const res = await api.post<Outcome>(
      "/api/execute",
      { agentId: "agt_support", action: "refund", target: "vendor.example.com", metadata: { amount: 50 } },
      { auth: ROLE_KEYS.operator },
    );

    expect(res.body.decision).toBe("ALLOW");
  });

  it("an undeclared verb whose name advertises money movement is held for a human", async () => {
    const res = await api.post<Outcome>(
      "/api/execute",
      {
        agentId: "agt_data",
        action: "bulk_payout_v2",
        target: "vendor.example.com",
        metadata: { amount: 999_999_999 },
      },
      { auth: ROLE_KEYS.operator },
    );

    // Renaming the verb to dodge the catalog does not restore the permissive
    // default: an undeclared verb has not been risk-assessed.
    expect(res.body.decision).not.toBe("ALLOW");
    expect(res.body.executed).toBe(false);
  });

  /*
   * RETARGETED IN PHASE 8, NOT DELETED.
   *
   * This test asserted `ALLOW` for an undeclared-but-harmless verb, and it was
   * an accurate description of the engine at the time. Phase 8 made the default
   * posture BLOCK, so the same request now has the opposite answer.
   *
   * What the test is really for — "the posture that governs undeclared verbs is
   * the one actually applied at the HTTP boundary, not just inside the pure
   * engine" — is unchanged, and is now worth MORE than before: the engine
   * defaults fail-closed on its own, so a wiring mistake in `decision-service`
   * would be invisible to the unit tests and visible only here.
   *
   * So both postures are exercised end to end, through Express.
   */
  it("refuses an undeclared harmless verb over HTTP when no posture is configured", async () => {
    expect(process.env.OATHRION_UNDECLARED_ACTION).toBeUndefined();

    const res = await api.post<Outcome>(
      "/api/execute",
      { agentId: "agt_data", action: "summarise", target: "warehouse.dim_customer" },
      { auth: ROLE_KEYS.operator },
    );

    expect(res.body.decision).toBe("BLOCK");
    expect(res.body.executed).toBe(false);
  });

  it("restores the pre-Phase-8 permissive behaviour under an explicit OATHRION_UNDECLARED_ACTION=allow", async () => {
    const previous = process.env.OATHRION_UNDECLARED_ACTION;
    process.env.OATHRION_UNDECLARED_ACTION = "allow";
    try {
      const res = await api.post<Outcome>(
        "/api/execute",
        { agentId: "agt_data", action: "summarise", target: "warehouse.dim_customer" },
        { auth: ROLE_KEYS.operator },
      );

      expect(res.body.decision).toBe("ALLOW");
      expect(res.body.executed).toBe(false); // no tool is wired to `summarise`
    } finally {
      if (previous === undefined) delete process.env.OATHRION_UNDECLARED_ACTION;
      else process.env.OATHRION_UNDECLARED_ACTION = previous;
    }
  });

  it("the verb wired to a real financial tool (purchase) is still fully capped", async () => {
    const res = await api.post<Outcome>(
      "/api/execute",
      { agentId: "agt_data", action: "purchase", target: "shop", metadata: { amount: 999_999_999 } },
      { auth: ROLE_KEYS.operator },
    );
    expect(res.body.decision).not.toBe("ALLOW");
  });
});
