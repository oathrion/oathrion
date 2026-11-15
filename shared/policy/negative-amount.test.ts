/**
 * Phase B, finding #1 — regression tests.
 *
 * `readNumber()` used to accept a negative amount as a valid number: `-50000
 * <= 10000` is true, so `amountAtMost` returned ALLOW for a purchase
 * declaring a negative amount, and `dailySpendAtMost` would have folded a
 * negative "cost" into the running daily total. Neither rule, nor the
 * mandate's own autonomous-spending check, treated a negative amount as
 * invalid — only `NaN`/`Infinity` were caught.
 *
 * These tests describe the vulnerable behaviour in the comments and assert
 * the fixed one. Reverting the `raw >= 0` guard in `readNumber`
 * (shared/policy/matchers.ts) makes every test below fail.
 */

import { describe, expect, it } from "vitest";
import { evaluateAction } from "./engine";
import { toPolicyRules } from "./adapters";
import { policies as policyFixtures } from "../seed/policies";
import type { EvaluationAgent, PolicyRule } from "./types";

const RULES: PolicyRule[] = toPolicyRules(policyFixtures);

const procurement: EvaluationAgent = {
  id: "agt_procurement",
  name: "Procurement Agent",
  status: "active",
  permissions: ["execute:payments", "call:external-api"],
  policyIds: [],
};

describe("amountAtMost — negative amount is refused, not trivially within limit", () => {
  it("does not allow a purchase that declares a negative amount", () => {
    // Before the fix: -50000 <= 10000 was read as "within the limit" → ALLOW.
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: -50_000 },
      policies: RULES,
    });

    expect(result.decision).not.toBe("ALLOW");
    expect(result.decision).toBe("BLOCK");
  });

  it("still allows a genuine, non-negative purchase under the ceiling", () => {
    // Guards against an over-broad fix that rejects legitimate amounts.
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 5_000 },
      policies: RULES,
    });

    expect(result.decision).toBe("ALLOW");
  });

  it("still requires approval above the ceiling, for a positive amount", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 25_000 },
      policies: RULES,
    });

    expect(result.decision).toBe("APPROVAL_REQUIRED");
  });

  it("does not allow a negative amount expressed as a numeric string", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: "-50,000" },
      policies: RULES,
    });

    expect(result.decision).not.toBe("ALLOW");
  });
});
