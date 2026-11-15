/**
 * Regression barrier for the "silent bypass" class of defect.
 *
 * `server/test/action-evasion.test.ts` documents, and pins down, a latent hole:
 * verbs like `refund`, `payout`, `withdraw`, `charge` and `reimburse` move money
 * but appear in NONE of the three hand-written lists that protect money:
 *
 *   1. `requiredPermissionForAction()`  (shared/policy/engine.ts) — permission barrier
 *   2. `SPENDING_ACTIONS`               (shared/policy/mandate.ts) — mandate ceiling
 *   3. `OUTBOUND_ACTIONS`               (shared/policy/mandate.ts) — domain allowlist
 *
 * ...and a fourth, `createDefaultRegistry()`'s action→tool table, decides
 * whether a verb can reach a side effect at all. Today verbs in group (1..3)
 * are un-gated but also un-wired, so the engine returns ALLOW and the Gateway
 * marks the run "skipped". The protection is real but *incidental*: it depends
 * entirely on nobody wiring a tool to an ungated verb.
 *
 * That is the exact failure mode this file exists to make impossible. It asserts
 * the INVARIANT rather than today's coincidence:
 *
 *   every action a tool is wired to must be declared in the central catalog,
 *   and every action the catalog marks financial or outbound must be covered by
 *   the permission barrier, the spending ceiling and the domain allowlist.
 *
 * If a future developer adds `refund_tool` for action `"refund"` without
 * classifying `refund` in `shared/policy/actions.ts`, these tests fail. There is
 * no way to wire a dangerous tool and keep a green suite.
 *
 * A FOURTH gap surfaced while building the catalog, and section 5 below covers
 * it. Unifying the permission barrier was necessary but not sufficient: each
 * MAX_TRANSACTION_AMOUNT *policy* carries its own `condition.actions` list, so an
 * agent that legitimately holds `execute:payments` and has no mandate ceiling
 * could still get a plain ALLOW for a €999,999,999 `refund` — no ceiling of any
 * kind was ever evaluated against the amount. The engine now asserts "money never
 * moves without a ceiling check" as an invariant rather than trusting every policy
 * author to enumerate every financial verb.
 */

import { describe, expect, it } from "vitest";
import {
  ACTION_CATALOG,
  DANGEROUS_ACTION_PATTERN,
  OUTBOUND_ACTIONS,
  SPENDING_ACTIONS,
  isDangerousActionName,
  lookupAction,
} from "./actions";
import { evaluateAction, requiredPermissionForAction } from "./engine";
import { toPolicyRules } from "./adapters";
import { policies as policyFixtures } from "../seed/policies";
import { createDefaultRegistry } from "../../server/gateway/tool-registry";
import type { EvaluationAgent, PolicyRule } from "./types";

const RULES: PolicyRule[] = toPolicyRules(policyFixtures);

/** An agent holding no dangerous scope at all — the worst case for a bypass. */
const unprivileged: EvaluationAgent = {
  id: "agt_data",
  name: "Data Analyst",
  status: "active",
  permissions: ["read:analytics"],
  policyIds: [],
};

/* ------------------------------------------------------------------------- */
/* 1. The catalog is the single source of truth                              */
/* ------------------------------------------------------------------------- */

describe("central action catalog", () => {
  it("covers every verb named in the mission brief as dangerous", () => {
    const required = [
      "refund",
      "payout",
      "withdraw",
      "charge",
      "transfer",
      "reimburse",
      "payment",
      "delete",
      "modify",
      "publish",
      "execute",
      "deploy",
    ];
    const missing = required.filter((action) => lookupAction(action) === undefined);
    expect(missing).toEqual([]);
  });

  it("derives SPENDING_ACTIONS from the catalog rather than a parallel list", () => {
    const fromCatalog = ACTION_CATALOG.filter((entry) => entry.financial)
      .map((entry) => entry.action)
      .sort();
    expect([...SPENDING_ACTIONS].sort()).toEqual(fromCatalog);
  });

  it("derives OUTBOUND_ACTIONS from the catalog rather than a parallel list", () => {
    const fromCatalog = ACTION_CATALOG.filter((entry) => entry.outbound)
      .map((entry) => entry.action)
      .sort();
    expect([...OUTBOUND_ACTIONS].sort()).toEqual(fromCatalog);
  });

  it("gives every financial action a required permission scope", () => {
    const ungated = ACTION_CATALOG.filter(
      (entry) => entry.financial && !entry.requiredScope,
    ).map((entry) => entry.action);
    expect(ungated).toEqual([]);
  });

  it("treats every financial action as outbound — money always leaves", () => {
    const inbound = ACTION_CATALOG.filter((entry) => entry.financial && !entry.outbound).map(
      (entry) => entry.action,
    );
    expect(inbound).toEqual([]);
  });

  it("declares no duplicate entries", () => {
    const seen = ACTION_CATALOG.map((entry) => entry.action);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

/* ------------------------------------------------------------------------- */
/* 2. The engine and the catalog cannot drift apart                          */
/* ------------------------------------------------------------------------- */

describe("permission barrier is catalog-driven", () => {
  it.each(ACTION_CATALOG.filter((entry) => entry.requiredScope))(
    "$action requires $requiredScope",
    (entry) => {
      expect(requiredPermissionForAction(entry.action)).toBe(entry.requiredScope);
    },
  );

  it.each(
    ACTION_CATALOG.filter((entry) => entry.financial).map((entry) => entry.action),
  )("blocks %s outright for an agent lacking the scope, whatever the amount", (action) => {
    const result = evaluateAction({
      agent: unprivileged,
      action,
      target: "https://vendor.example.com",
      metadata: { amount: 999_999_999 },
      policies: RULES,
    });
    // The whole point: an unprivileged agent must never receive ALLOW for a
    // money-moving verb. Before the catalog existed, `refund` returned ALLOW.
    expect(result.decision).toBe("BLOCK");
    expect(result.reason).toContain("required permission");
  });
});

/* ------------------------------------------------------------------------- */
/* 3. Unknown-but-dangerous verbs fail closed                               */
/* ------------------------------------------------------------------------- */

describe("unknown dangerous verbs fail closed", () => {
  it.each([
    "refund_v2",
    "bulk_payout",
    "wire_transfer",
    "force_delete",
    "hard_drop_table",
    "emergency_withdrawal",
  ])("%s is recognised as dangerous by name even though it is not catalogued", (action) => {
    expect(lookupAction(action)).toBeUndefined();
    expect(isDangerousActionName(action)).toBe(true);
  });

  it.each(["read", "summarise", "analyse", "list", "observe"])(
    "%s is correctly treated as harmless",
    (action) => {
      expect(isDangerousActionName(action)).toBe(false);
    },
  );

  it("never returns ALLOW for an uncatalogued verb that looks dangerous", () => {
    const result = evaluateAction({
      agent: { ...unprivileged, permissions: ["read:analytics", "execute:payments"] },
      action: "bulk_payout_v2",
      target: "https://vendor.example.com",
      metadata: { amount: 999_999_999 },
      policies: RULES,
    });
    // The permissive default is fine for `summarise`. It is NOT fine for a verb
    // whose own name says it moves money: an unrecognised dangerous verb is by
    // definition one nobody has risk-assessed, so it needs a human.
    expect(result.decision).not.toBe("ALLOW");
  });

  /*
   * RETARGETED IN PHASE 8, NOT DELETED.
   *
   * This assertion used to read `expect(result.decision).toBe("ALLOW")` with no
   * posture argument, and it was correct for the engine as it stood: the default
   * for an unrecognised verb was ALLOW.
   *
   * Phase 8 changed that default to BLOCK (see `shared/policy/posture.ts`), so
   * the old expectation is now asserting a posture the product no longer ships.
   * Both halves of the change are kept under test rather than one replacing the
   * other:
   *
   *   - the permissive behaviour still exists and is still exercised, but only
   *     where it now lives: behind an explicit `allow`;
   *   - the new default is asserted separately, without passing a posture at
   *     all, because "what happens when nobody configured anything" is the whole
   *     question and a test that always passes the argument could never catch a
   *     regression in the default itself.
   */
  it("keeps the permissive default for ordinary unrecognised verbs under an explicit `allow`", () => {
    const result = evaluateAction({
      agent: unprivileged,
      action: "summarise",
      target: "warehouse.dim_customer",
      policies: RULES,
      undeclaredActionPosture: "allow",
    });
    expect(result.decision).toBe("ALLOW");
  });

  it("refuses that same ordinary unrecognised verb when no posture is configured", () => {
    const result = evaluateAction({
      agent: unprivileged,
      action: "summarise",
      target: "warehouse.dim_customer",
      policies: RULES,
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.policyId).toBe("sys_undeclared_action");
  });

  it("has a pattern that is anchored and case-insensitive", () => {
    expect(DANGEROUS_ACTION_PATTERN.flags).toContain("i");
    expect(isDangerousActionName("REFUND")).toBe(true);
    expect(isDangerousActionName("Transfer_Funds")).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* 4. No tool may be wired to an unclassified action                        */
/* ------------------------------------------------------------------------- */

describe("tool registry cannot outrun the catalog", () => {
  it("every action wired to a tool in the default registry is catalogued", () => {
    const registry = createDefaultRegistry();
    const uncatalogued = registry
      .actions()
      .filter((action) => lookupAction(action) === undefined);
    expect(uncatalogued).toEqual([]);
  });

  it("every action wired to a tool has a required permission scope", () => {
    const registry = createDefaultRegistry();
    const ungated = registry
      .actions()
      .filter((action) => requiredPermissionForAction(action) === null);
    // A wired verb with no scope requirement is reachable by any agent. That is
    // precisely the bypass this suite exists to prevent.
    expect(ungated).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* 5. Money never moves without a ceiling having been checked                */
/* ------------------------------------------------------------------------- */

/**
 * The fourth gap, and the subtlest one.
 *
 * Unifying the permission barrier was necessary but not sufficient. Each
 * MAX_TRANSACTION_AMOUNT *policy* carries its own `condition.actions` list, and
 * the shipped `pol_purchase_limit` names only `purchase`, `payment` and
 * `checkout`. So an agent that legitimately holds `execute:payments` and has no
 * mandate ceiling — `agt_data` in the seed — could obtain a plain ALLOW for a
 * €999,999,999 `refund`: it cleared the permission barrier, and no ceiling of any
 * kind was ever evaluated against the amount.
 *
 * The engine now asserts the invariant directly instead of relying on every
 * policy author to enumerate every financial verb.
 */
describe("financial actions always meet a ceiling", () => {
  /** Holds payment authority, no mandate ceiling — the seeded `agt_data` shape. */
  const payerWithoutCeiling: EvaluationAgent = {
    id: "agt_data",
    name: "Data Analyst",
    status: "active",
    permissions: ["execute:payments", "read:analytics"],
    policyIds: [],
  };

  const payerWithCeiling: EvaluationAgent = {
    ...payerWithoutCeiling,
    mandate: {
      maxTransactionAmount: 10_000,
      currency: "EUR",
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
  };

  it.each(SPENDING_ACTIONS)(
    "%s is never plainly allowed when no ceiling governs it",
    (action) => {
      const result = evaluateAction({
        agent: payerWithoutCeiling,
        action,
        target: "vendor.example.com",
        metadata: { amount: 999_999_999 },
        policies: RULES,
      });
      expect(result.decision).not.toBe("ALLOW");
    },
  );

  it("names the ungoverned-money policy in the audit trail", () => {
    /*
     * `payout`, not `refund`.
     *
     * This assertion was written against `refund` back when NO policy in the
     * shipped set named that verb, which made it the clearest example of
     * ungoverned money. `pol_refund_approval` now governs `refund` at €500, so
     * the invariant correctly stops firing for it — the ceiling it demands
     * exists. Continuing to assert the synthetic verdict for `refund` would be
     * asserting that the fix did not work.
     *
     * `payout` is named by no MAX_TRANSACTION_AMOUNT policy in the seed and
     * `payerWithoutCeiling` has no mandate, so it still exercises exactly the
     * gap this suite exists for. The test below pins the other half: that
     * `refund` is now stopped by a rule an operator wrote.
     */
    const result = evaluateAction({
      agent: payerWithoutCeiling,
      action: "payout",
      target: "vendor.example.com",
      metadata: { amount: 999_999_999 },
      policies: RULES,
    });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
    expect(result.matched.map((v) => v.policyId)).toContain("sys_ungoverned_money_movement");
  });

  it("defers to a named org policy once one governs the verb", () => {
    /*
     * The complement of the test above, and the reason the seed gained
     * `pol_refund_approval`.
     *
     * The synthetic "ungoverned money movement" verdict is a backstop, not a
     * control an operator can reason about: its reason text explains that no
     * ceiling exists, which answers "why was this held?" with an absence. Once a
     * real policy governs the verb, the held decision must be attributable to
     * THAT policy, so the console can name the rule and the operator can change
     * it.
     */
    const result = evaluateAction({
      agent: payerWithoutCeiling,
      action: "refund",
      target: "vendor.example.com",
      metadata: { amount: 999_999_999 },
      policies: RULES,
    });

    expect(result.decision).toBe("APPROVAL_REQUIRED");
    // The backstop stands down because the condition it guards is satisfied.
    expect(result.matched.map((v) => v.policyId)).not.toContain(
      "sys_ungoverned_money_movement",
    );
    // And the reported reason is the operator's rule, not an internal invariant.
    expect(result.policyId).toBe("pol_refund_approval");
    expect(result.reason).toContain("Refund approval threshold");
  });

  it("a declared MAX_DAILY_SPEND ceiling does not satisfy the invariant", () => {
    // MAX_DAILY_SPEND reads `cost`, not `amount`. An agent declaring a one-cent
    // cost alongside a billion-euro amount would otherwise slip through with the
    // transaction amount never examined.
    const dailyOnly: PolicyRule[] = RULES.filter((p) => p.type === "MAX_DAILY_SPEND");
    const result = evaluateAction({
      agent: payerWithoutCeiling,
      action: "refund",
      target: "vendor.example.com",
      metadata: { amount: 1_000_000_000, cost: 0.01 },
      policies: dailyOnly,
    });
    expect(result.decision).not.toBe("ALLOW");
  });

  it("a mandate ceiling satisfies the invariant, so amounts inside it flow", () => {
    // The guard must not become a blanket ban: an operator who has set a ceiling
    // gets autonomous execution inside it.
    const result = evaluateAction({
      agent: payerWithCeiling,
      action: "refund",
      target: "vendor.example.com",
      metadata: { amount: 100 },
      policies: RULES,
    });
    expect(result.decision).toBe("ALLOW");
  });

  it("a mandate ceiling still catches amounts above it", () => {
    const result = evaluateAction({
      agent: payerWithCeiling,
      action: "refund",
      target: "vendor.example.com",
      metadata: { amount: 999_999_999 },
      policies: RULES,
    });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
  });

  it("non-financial actions are unaffected by the ceiling invariant", () => {
    // `access` is catalogued but not financial. Requiring a spending ceiling for
    // a read would be nonsense, and would break ordinary work.
    const reader: EvaluationAgent = {
      id: "agt_data",
      name: "Data Analyst",
      status: "active",
      permissions: ["read:database"],
      policyIds: [],
    };
    const result = evaluateAction({
      agent: reader,
      action: "access",
      target: "warehouse.dim_customer",
      policies: [],
    });
    expect(result.decision).toBe("ALLOW");
  });
});
