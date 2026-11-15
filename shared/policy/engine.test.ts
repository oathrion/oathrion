import { describe, expect, it } from "vitest";
import { evaluateAction } from "./engine";
import { toPolicyRules } from "./adapters";
import { policies as policyFixtures } from "../seed/policies";
import type { AgentMandate } from "./mandate";
import type { EvaluationAgent, PolicyRule } from "./types";

const RULES: PolicyRule[] = toPolicyRules(policyFixtures);

function agent(overrides: Partial<EvaluationAgent> = {}): EvaluationAgent {
  return {
    id: "agt_procurement",
    name: "Procurement Agent",
    status: "active",
    permissions: ["execute:payments", "call:external-api"],
    policyIds: [],
    ...overrides,
  };
}

const procurement = agent();
const dataAgent = agent({
  id: "agt_data",
  name: "Data Analyst",
  permissions: ["read:database", "read:analytics"],
});
const support = agent({
  id: "agt_support",
  name: "Support Agent",
  permissions: ["send:email", "manage:tickets"],
});

describe("evaluateAction — the five reference scenarios", () => {
  it("scenario 1: purchase of $5,000 is allowed", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 5_000 },
      policies: RULES,
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.policyId).toBe("pol_purchase_limit");
  });

  it("scenario 2: purchase of $12,000 requires approval", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 12_000 },
      policies: RULES,
    });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
    expect(result.policyId).toBe("pol_purchase_limit");
    expect(result.riskLevel).toBe("HIGH");
    expect(result.reason).toContain("exceeds");
  });

  it("scenario 3: access to the production database is blocked", () => {
    const result = evaluateAction({
      agent: dataAgent,
      action: "access",
      target: "production_database",
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.policyId).toBe("pol_db_prod");
    expect(result.riskLevel).toBe("CRITICAL");
  });

  it("scenario 4: sending an external email requires approval", () => {
    const result = evaluateAction({
      agent: support,
      action: "send_email",
      target: "external_email",
      policies: RULES,
    });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
    expect(result.policyId).toBe("pol_email_approval");
  });

  it("scenario 5: purchase of $300 is allowed", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 300 },
      policies: RULES,
    });
    expect(result.decision).toBe("ALLOW");
  });
});

describe("MAX_TRANSACTION_AMOUNT boundaries", () => {
  const run = (amount: number) =>
    evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount },
      policies: RULES,
    });

  it("allows exactly the limit (10000)", () => {
    expect(run(10_000).decision).toBe("ALLOW");
  });

  it("requires approval one unit above the limit (10001)", () => {
    expect(run(10_001).decision).toBe("APPROVAL_REQUIRED");
  });

  it("allows zero", () => {
    expect(run(0).decision).toBe("ALLOW");
  });

  it("parses string amounts such as '$12,000'", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: "$12,000" },
      policies: RULES,
    });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
  });
});

describe("MAX_DAILY_SPEND", () => {
  it("allows a purchase that keeps the daily budget intact", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 100, cost: 100 },
      dailySpend: 200,
      policies: RULES,
    });
    expect(result.decision).toBe("ALLOW");
  });

  it("blocks once the projected daily spend crosses $500", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 100, cost: 100 },
      dailySpend: 450,
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.policyId).toBe("pol_api_spend");
  });

  it("allows exactly $500 of projected spend", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 50, cost: 50 },
      dailySpend: 450,
      policies: RULES,
    });
    expect(result.decision).toBe("ALLOW");
  });

  /*
   * The exact arête, added after a mutation audit. The two tests above sit at 500 and
   * at 550, so relaxing the comparison to `projected <= max + 1` — a one-character
   * change that lets every agent overshoot the budget by one unit on every single
   * action, forever — passed the whole suite. A boundary that is only tested from
   * fifty units away is not tested.
   */
  it("blocks one unit past the budget (501)", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 51, cost: 51 },
      dailySpend: 450,
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.policyId).toBe("pol_api_spend");
  });

  it("blocks a fractional overshoot (500.01)", () => {
    // Money is not integers. A cent over budget is over budget, and rounding the
    // projection before comparing would silently reopen the overshoot.
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 50.01, cost: 50.01 },
      dailySpend: 450,
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
  });

  it("counts spend already made, not just the action in hand", () => {
    /*
     * The projection is `dailySpend + cost`. An implementation that compared only
     * `cost` against the budget would pass every test that starts from a low
     * dailySpend, and would let an agent spend $499 per action indefinitely.
     */
    const alone = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 100, cost: 100 },
      dailySpend: 0,
      policies: RULES,
    });
    expect(alone.decision).toBe("ALLOW");

    const accumulated = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "shop",
      metadata: { amount: 100, cost: 100 },
      dailySpend: 480,
      policies: RULES,
    });
    expect(accumulated.decision).toBe("BLOCK");
  });
});

describe("precedence and guard rails", () => {
  it("BLOCK wins over APPROVAL_REQUIRED and ALLOW", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "purchase",
      target: "production_database",
      metadata: { amount: 12_000 },
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.matched.length).toBeGreaterThan(1);
    expect(result.matched[0].decision).toBe("BLOCK");
  });

  it("APPROVAL_REQUIRED wins over ALLOW", () => {
    const result = evaluateAction({
      agent: support,
      action: "send_email",
      target: "external_email",
      metadata: { cost: 10 },
      policies: RULES,
    });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
  });

  it("blocks any action from a paused agent", () => {
    const result = evaluateAction({
      agent: agent({ status: "paused" }),
      action: "purchase",
      target: "shop",
      metadata: { amount: 10 },
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.policyId).toBeNull();
  });

  it("falls back to ALLOW when no policy has an opinion", () => {
    const result = evaluateAction({
      agent: procurement,
      action: "read",
      target: "internal_wiki",
      policies: RULES,
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.policyId).toBeNull();
    expect(result.reason).toBe("No policy constrains this action.");
  });

  it("ignores disabled and draft policies", () => {
    const disabled = RULES.map((r) => ({ ...r, status: "disabled" as const }));
    const result = evaluateAction({
      agent: dataAgent,
      action: "access",
      target: "production_database",
      policies: disabled,
    });
    expect(result.decision).toBe("ALLOW");
  });

  it("normalises target casing and separators", () => {
    const result = evaluateAction({
      agent: dataAgent,
      action: "access",
      target: "Production-Database",
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
  });

  it("honours wildcard targets", () => {
    const result = evaluateAction({
      agent: dataAgent,
      action: "access",
      target: "postgres.prod.orders",
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
  });
});

describe("ALLOW_TOOL", () => {
  it("explicitly allow-lists the analytics warehouse", () => {
    const result = evaluateAction({
      agent: dataAgent,
      action: "query",
      target: "analytics_warehouse",
      policies: RULES,
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.policyId).toBe("pol_readonly_analytics");
  });
});

describe("agent-scoped policies", () => {
  const scoped: PolicyRule[] = [
    {
      id: "pol_scoped",
      name: "Scoped block",
      description: "",
      type: "BLOCK_TOOL",
      condition: { kind: "targetMatches", targets: ["shop"] },
      action: "BLOCK",
      status: "enabled",
      appliesToAgentIds: ["agt_finance"],
      risk: "HIGH",
      priority: 50,
    },
  ];

  /*
   * `purchase` is a financial verb, and the engine now requires that SOME ceiling
   * govern a financial verb before it may run autonomously (see
   * `ungovernedMoneyVerdict` in engine.ts). The `scoped` set above contains only a
   * BLOCK_TOOL rule, so without a mandate ceiling these two cases would be held
   * for approval as ungoverned money movement.
   *
   * These tests are about policy *scoping*, not about ceilings, so both agents
   * carry an explicit mandate ceiling and the amount sits well inside it. That
   * isolates the behaviour actually under test.
   */
  const ceiling: AgentMandate = {
    maxTransactionAmount: 10_000,
    currency: "EUR",
    allowedCategories: [],
    blockedCategories: [],
    allowedDomains: [],
  };

  it("does not apply to an unrelated agent", () => {
    expect(
      evaluateAction({
        agent: agent({ mandate: ceiling }),
        action: "purchase",
        target: "shop",
        metadata: { amount: 100 },
        policies: scoped,
      }).decision,
    ).toBe("ALLOW");
  });

  it("applies to the targeted agent", () => {
    expect(
      evaluateAction({
        agent: agent({ id: "agt_finance", name: "Finance Agent", mandate: ceiling }),
        action: "purchase",
        target: "shop",
        metadata: { amount: 100 },
        policies: scoped,
      }).decision,
    ).toBe("BLOCK");
  });
});
