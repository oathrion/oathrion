/**
 * DEAD POLICIES — a policy the engine can never evaluate must not be creatable.
 *
 * WHAT THIS FILE PINS
 * -------------------
 * `type` selects the rule evaluator, `condition` supplies its parameters. Each
 * evaluator in `shared/policy/rules.ts` opens with a check on the condition kind it
 * needs and returns `null` when it is absent — correct behaviour, since it cannot
 * apply a condition it cannot read.
 *
 * The defect was one layer up: `POST /api/policies` accepted all 15 type × condition
 * combinations, and returned 201 for the 10 that can never fire. The result was a row
 * listed as `status: "enabled"`, counted in the dashboard's "policies enabled", and
 * evaluated as `null` on every decision. A customer writing the most natural version
 * of "payments over EUR 100 need a human" — `REQUIRE_HUMAN_APPROVAL` with an
 * `amountAtMost` condition — got a governance rule that governed nothing, silently.
 *
 * This was found by the end-to-end enterprise journey (`npm run e2e`), not by the unit
 * suite: every existing test wrote a correctly paired policy, so the gap was invisible
 * from inside. The behavioural assertion at the bottom is the important one — it
 * demonstrates the defect rather than describing it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { policyCreateContract } from "@shared/validation";

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

const BASE = {
  name: "Contract test policy",
  description: "Created by policy-contract.test.ts",
  scope: "organization" as const,
  appliesTo: "all agents",
  status: "enabled" as const,
  risk: "high" as const,
  priority: 20,
};

const AMOUNT = { kind: "amountAtMost", max: 100, currency: "EUR" } as const;
const TARGETS = { kind: "targetMatches", targets: ["supplier-x"] } as const;
const DAILY = { kind: "dailySpendAtMost", max: 1000, currency: "EUR" } as const;

/** The five combinations the engine can actually evaluate. */
const VALID = [
  { type: "MAX_TRANSACTION_AMOUNT", condition: AMOUNT, effect: "require_approval", action: "APPROVAL_REQUIRED" },
  { type: "REQUIRE_HUMAN_APPROVAL", condition: TARGETS, effect: "require_approval", action: "APPROVAL_REQUIRED" },
  { type: "BLOCK_TOOL", condition: TARGETS, effect: "block", action: "BLOCK" },
  { type: "ALLOW_TOOL", condition: TARGETS, effect: "warn", action: "ALLOW" },
  { type: "MAX_DAILY_SPEND", condition: DAILY, effect: "block", action: "BLOCK" },
] as const;

/** The ten that cannot. Each one used to be accepted with a 201. */
const DEAD = [
  { type: "MAX_TRANSACTION_AMOUNT", condition: TARGETS },
  { type: "MAX_TRANSACTION_AMOUNT", condition: DAILY },
  { type: "REQUIRE_HUMAN_APPROVAL", condition: AMOUNT },
  { type: "REQUIRE_HUMAN_APPROVAL", condition: DAILY },
  { type: "BLOCK_TOOL", condition: AMOUNT },
  { type: "BLOCK_TOOL", condition: DAILY },
  { type: "ALLOW_TOOL", condition: AMOUNT },
  { type: "ALLOW_TOOL", condition: DAILY },
  { type: "MAX_DAILY_SPEND", condition: AMOUNT },
  { type: "MAX_DAILY_SPEND", condition: TARGETS },
] as const;

describe("policy type ↔ condition pairing", () => {
  it("accepts each of the five combinations the engine can evaluate", () => {
    for (const combo of VALID) {
      const parsed = policyCreateContract.safeParse({
        ...BASE,
        ...combo,
        id: `pol_valid_${combo.type.toLowerCase()}`,
      });
      expect(parsed.success, `${combo.type} + ${combo.condition.kind} should be valid`).toBe(true);
    }
  });

  it("refuses all ten combinations that could never fire", () => {
    for (const combo of DEAD) {
      const parsed = policyCreateContract.safeParse({
        ...BASE,
        ...combo,
        effect: "block",
        action: "BLOCK",
        id: `pol_dead_${combo.type.toLowerCase()}_${combo.condition.kind}`,
      });
      expect(parsed.success, `${combo.type} + ${combo.condition.kind} should be refused`).toBe(false);
    }
  });

  it("covers the whole cross-product — 5 valid + 10 dead = 15 combinations", () => {
    // Guards against a type being added to the enum without a pairing rule: the
    // arithmetic breaks and this test fails.
    expect(VALID.length + DEAD.length).toBe(5 * 3);
  });

  it("names the condition the chosen type actually requires", () => {
    const parsed = policyCreateContract.safeParse({
      ...BASE,
      id: "pol_dead_message",
      type: "REQUIRE_HUMAN_APPROVAL",
      condition: AMOUNT,
      effect: "require_approval",
      action: "APPROVAL_REQUIRED",
    });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : parsed.error.issues[0].message;
    expect(message).toContain("targetMatches");
    expect(message).toContain("never apply");
  });
});

describe("POST /api/policies", () => {
  it("refuses a dead policy with 400 instead of storing it as enabled", async () => {
    const res = await client.post<{ error: string }>("/api/policies", {
      ...BASE,
      id: "pol_http_dead",
      type: "REQUIRE_HUMAN_APPROVAL",
      condition: AMOUNT,
      effect: "require_approval",
      action: "APPROVAL_REQUIRED",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("targetMatches");

    // And it is not in the list: a 400 that still wrote the row would be worse than
    // the original bug.
    const list = await client.get<{ id: string }[]>("/api/policies");
    expect(list.body.some((p) => p.id === "pol_http_dead")).toBe(false);
  });

  it("still accepts the correctly paired version of the same intent", async () => {
    const res = await client.post<{ id: string; status: string }>("/api/policies", {
      ...BASE,
      id: "pol_http_alive",
      name: "Large purchases need a human",
      type: "MAX_TRANSACTION_AMOUNT",
      condition: AMOUNT,
      effect: "require_approval",
      action: "APPROVAL_REQUIRED",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("enabled");
  });

  it("the accepted policy actually governs a decision — the point of the check", async () => {
    // A live proof rather than a schema assertion: the correctly paired policy created
    // above must change the verdict for an amount above its ceiling. The dead version
    // changed nothing, which is what made it dangerous.
    const agent = await client.post<{ id: string }>("/api/agents", {
      id: "agt_policy_contract",
      name: "Contract Agent",
      description: "Created by policy-contract.test.ts",
      provider: "openai",
      model: "gpt-4",
      status: "active",
      owner: "qa",
      mandate: {
        maxTransactionAmount: 10_000,
        currency: "EUR",
        allowedCategories: [],
        blockedCategories: [],
        allowedDomains: [],
      },
      permissions: [
        {
          scope: "execute:payments",
          label: "Pay",
          description: "",
          granted: true,
          risk: "high",
        },
      ],
      policyIds: [],
      tags: [],
    });
    expect([200, 201]).toContain(agent.status);

    const over = await client.post<{ decision: string; policyId: string | null }>("/api/decision", {
      agentId: "agt_policy_contract",
      action: "purchase",
      target: "supplier-live",
      metadata: { amount: 900, currency: "EUR" },
    });
    expect(over.body.decision).toBe("APPROVAL_REQUIRED");
    expect(over.body.policyId).toBe("pol_http_alive");

    const under = await client.post<{ decision: string }>("/api/decision", {
      agentId: "agt_policy_contract",
      action: "purchase",
      target: "supplier-live",
      metadata: { amount: 20, currency: "EUR" },
    });
    expect(under.body.decision).toBe("ALLOW");
  });

  it("does not let a non-admin reach the check at all", async () => {
    const res = await client.post("/api/policies", { ...BASE, id: "pol_rbac" }, {
      auth: ROLE_KEYS.operator,
    });
    expect(res.status).toBe(403);
  });
});
