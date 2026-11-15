/**
 * The undeclared-action posture (Phase 8, priority A).
 *
 * WHAT THIS FILE HAS TO PROVE
 * ---------------------------
 * Before Phase 8 the engine answered ALLOW to any verb it had never heard of,
 * mitigated only by a heuristic over the verb's spelling. That was survivable
 * while Oathrion governed a closed catalog. Phase 8 invites arbitrary agents to send
 * arbitrary verb names, which turns the gap into the product's central risk:
 * `crm.update_record` and `k8s.scale_down` are invisible to a spelling
 * heuristic, so both used to come back ALLOW.
 *
 * The assertions below are therefore not "does the flag work". They are:
 *
 *   1. the DEFAULT — what an operator who configured nothing gets — is BLOCK,
 *      asserted by omitting the argument entirely rather than passing "block",
 *      because a test that always passes the argument cannot detect a regression
 *      in the default;
 *   2. the specific verbs that motivated the change are refused, by name;
 *   3. the fail-closed default does not make Oathrion a closed catalog: naming a verb
 *      in a policy is a working escape hatch;
 *   4. `allow` reproduces the pre-Phase-8 engine exactly, so the backward
 *      compatibility promised in the docs is a tested claim rather than a
 *      sentence;
 *   5. relaxing the posture cannot disarm the older dangerous-name heuristic;
 *   6. a catalogued verb is untouched by any of this.
 */

import { describe, expect, it } from "vitest";
import { evaluateAction } from "./engine";
import {
  DEFAULT_UNDECLARED_ACTION_POSTURE,
  UNDECLARED_ACTION_ENV,
  resolveUndeclaredActionPosture,
} from "./posture";
import type { EvaluationAgent, PolicyRule } from "./types";

const AGENT: EvaluationAgent = {
  id: "agt_test",
  name: "Test Agent",
  status: "active",
  permissions: ["read:analytics", "execute:payments", "write:database", "read:database"],
  policyIds: [],
  mandate: undefined,
};

/**
 * Verbs a real developer would send that the dangerous-name heuristic cannot
 * see. Every one of these returned ALLOW before Phase 8 — that measurement is
 * what motivated the change, so the list is pinned here rather than described.
 */
const INVISIBLE_TO_THE_HEURISTIC = [
  "crm.update_record",
  "email.send_bulk",
  "k8s.scale_down",
  "s3.putObject",
  "unknown.internal_action",
  "totally.unknown.verb",
];

describe("undeclared action posture", () => {
  describe("the default, with nothing configured", () => {
    it("is block", () => {
      expect(DEFAULT_UNDECLARED_ACTION_POSTURE).toBe("block");
      expect(resolveUndeclaredActionPosture({})).toBe("block");
    });

    it.each(INVISIBLE_TO_THE_HEURISTIC)(
      "refuses %s without any posture argument",
      (action) => {
        // No `undeclaredActionPosture` key at all. This is the case that matters:
        // it is what every caller that has not been updated will hit.
        const result = evaluateAction({
          agent: AGENT,
          action,
          target: "some.target",
          policies: [],
        });
        expect(result.decision).toBe("BLOCK");
        expect(result.policyId).toBe("sys_undeclared_action");
      },
    );

    it("explains itself, and says how to proceed", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: "crm.update_record",
        target: "acct_1",
        policies: [],
      });
      // A refusal a developer cannot act on is a support ticket. The reason has
      // to name the three real ways forward.
      expect(result.reason).toContain("not a declared action");
      expect(result.reason).toContain("shared/policy/actions.ts");
      expect(result.reason).toContain(UNDECLARED_ACTION_ENV);
    });
  });

  describe("the escape hatch: a policy that names the verb", () => {
    const namesTheVerb: PolicyRule = {
      id: "pol_crm",
      name: "CRM writes",
      description: "Governs the CRM verbs Oathrion does not ship.",
      type: "MAX_TRANSACTION_AMOUNT",
      condition: { kind: "amountAtMost", max: 1000, actions: ["crm.update_record"] },
      action: "APPROVAL_REQUIRED",
      status: "enabled",
      appliesToAgentIds: null,
      risk: "MEDIUM",
      priority: 10,
    };

    it("stops treating the verb as undeclared", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: "crm.update_record",
        target: "acct_1",
        metadata: { amount: 10 },
        policies: [namesTheVerb],
      });
      expect(result.decision).toBe("ALLOW");
    });

    it("still lets that policy do its job", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: "crm.update_record",
        target: "acct_1",
        metadata: { amount: 5000 },
        policies: [namesTheVerb],
      });
      expect(result.decision).toBe("APPROVAL_REQUIRED");
      expect(result.policyId).toBe("pol_crm");
    });

    it("accepts a wildcard, because typing one is itself the act of taking responsibility", () => {
      const wildcard: PolicyRule = {
        ...namesTheVerb,
        id: "pol_crm_all",
        condition: { kind: "amountAtMost", max: 1000, actions: ["crm.*"] },
      };
      const result = evaluateAction({
        agent: AGENT,
        action: "crm.update_record",
        target: "acct_1",
        metadata: { amount: 10 },
        policies: [wildcard],
      });
      expect(result.decision).toBe("ALLOW");
    });

    /*
     * The hole this closes: `actions: []` and a missing `actions` key both mean
     * "every action" to `matchesAny`. If that counted as declaring a verb, a
     * single org-wide ceiling would re-authorise every unknown verb in the
     * system and the posture would be decorative.
     */
    it.each([
      ["an absent actions list", undefined],
      ["an empty actions list", [] as string[]],
    ])("does NOT treat %s as naming the verb", (_label, actions) => {
      const orgWide: PolicyRule = {
        ...namesTheVerb,
        id: "pol_org_wide",
        condition: { kind: "amountAtMost", max: 1000, actions },
      };
      const result = evaluateAction({
        agent: AGENT,
        action: "crm.update_record",
        target: "acct_1",
        metadata: { amount: 10 },
        policies: [orgWide],
      });
      expect(result.decision).toBe("BLOCK");
      expect(result.policyId).toBe("sys_undeclared_action");
    });

    it("ignores a policy that is disabled", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: "crm.update_record",
        target: "acct_1",
        metadata: { amount: 10 },
        policies: [{ ...namesTheVerb, status: "disabled" }],
      });
      expect(result.decision).toBe("BLOCK");
    });

    it("ignores a policy bound to a different agent", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: "crm.update_record",
        target: "acct_1",
        metadata: { amount: 10 },
        policies: [{ ...namesTheVerb, appliesToAgentIds: ["agt_someone_else"] }],
      });
      expect(result.decision).toBe("BLOCK");
    });
  });

  describe("approval posture", () => {
    it.each(INVISIBLE_TO_THE_HEURISTIC)("escalates %s to a human", (action) => {
      const result = evaluateAction({
        agent: AGENT,
        action,
        target: "some.target",
        policies: [],
        undeclaredActionPosture: "approval",
      });
      expect(result.decision).toBe("APPROVAL_REQUIRED");
      expect(result.policyId).toBe("sys_undeclared_action");
    });
  });

  describe("allow posture reproduces the pre-Phase-8 engine", () => {
    it.each(INVISIBLE_TO_THE_HEURISTIC)("allows %s again", (action) => {
      const result = evaluateAction({
        agent: AGENT,
        action,
        target: "some.target",
        policies: [],
        undeclaredActionPosture: "allow",
      });
      expect(result.decision).toBe("ALLOW");
      expect(result.reason).toBe("No policy constrains this action.");
    });

    /*
     * The failure this guards against is subtle and would be easy to ship: an
     * operator sets `allow` for an unrelated migration reason and silently loses
     * the dangerous-name protection that predates Phase 8 entirely. The two
     * mechanisms are independent by construction in `engine.ts`; this asserts it.
     */
    it("does NOT disarm the dangerous-name heuristic", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: "bulk_payout_v2",
        target: "https://vendor.example.com",
        metadata: { amount: 999_999_999 },
        policies: [],
        undeclaredActionPosture: "allow",
      });
      expect(result.decision).not.toBe("ALLOW");
    });
  });

  describe("catalogued verbs are untouched", () => {
    it("is unaffected by the strictest posture", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: "query",
        target: "warehouse.dim_customer",
        policies: [],
      });
      // `query` is in the catalog, so the posture never applies to it: the
      // permission barrier (`read:database`, held by AGENT) is what decides.
      expect(result.decision).toBe("ALLOW");
    });

    /*
     * Guards against a false green. A catalogued verb can also be refused by the
     * permission barrier, and if this suite ever asserted only "BLOCK" it could
     * pass while the posture had stopped working entirely. So when a catalogued
     * verb IS refused, assert it is refused for the OTHER reason — the posture
     * must not be the one talking.
     */
    it("is refused by the permission barrier, not by the posture, when a scope is missing", () => {
      const result = evaluateAction({
        agent: { ...AGENT, permissions: [] },
        action: "query",
        target: "warehouse.dim_customer",
        policies: [],
      });
      expect(result.decision).toBe("BLOCK");
      expect(result.policyId).not.toBe("sys_undeclared_action");
      expect(result.reason).toContain("required permission");
    });
  });

  describe("environment resolution", () => {
    it.each([
      ["block", "block"],
      ["approval", "approval"],
      ["allow", "allow"],
      ["  BLOCK  ", "block"],
      ["Approval", "approval"],
    ])("reads %s as %s", (raw, expected) => {
      expect(resolveUndeclaredActionPosture({ [UNDECLARED_ACTION_ENV]: raw })).toBe(expected);
    });

    it.each([["", "block"], [undefined, "block"]])(
      "treats %s as the fail-closed default",
      (raw, expected) => {
        expect(resolveUndeclaredActionPosture({ [UNDECLARED_ACTION_ENV]: raw })).toBe(expected);
      },
    );

    /*
     * A typo must not choose the security posture. `blok` silently falling back
     * to anything is the failure mode; refusing is the feature.
     */
    it.each(["blok", "deny", "true", "1", "off", "BLOCK!"])("refuses %s rather than defaulting", (raw) => {
      expect(() => resolveUndeclaredActionPosture({ [UNDECLARED_ACTION_ENV]: raw })).toThrow(
        /is not one of/,
      );
    });
  });
});

/**
 * Phase 8 defect P8-3: the escape hatch, on a verb that SOUNDS dangerous.
 *
 * `sys_undeclared_action` accepted an explicit policy as a risk assessment. The
 * older `sys_unknown_dangerous_action` heuristic did not, so an operator who
 * followed Oathrion's own printed remedy — "write a policy whose condition names
 * it" — for a verb like `stripe.refund` got APPROVAL_REQUIRED on every call
 * forever, and the threshold they had just written could never produce an
 * ALLOW at any amount. The hatch was unusable for exactly the verbs it matters
 * most for.
 *
 * The half of this that is about safety rather than usability is the wildcard
 * rule, and it gets the most tests: honouring `*` here would have let one
 * ordinary org-wide policy disarm the dangerous-name heuristic for every
 * unknown verb in the system at once.
 */
describe("an explicit policy stands down the dangerous-name heuristic", () => {
  const DANGEROUS_UNCATALOGUED = "stripe.refund";

  function amountPolicy(overrides: Partial<PolicyRule> = {}): PolicyRule {
    return {
      id: "pol_stripe",
      name: "Stripe refund threshold",
      description: "Refunds up to 500 are automatic.",
      type: "MAX_TRANSACTION_AMOUNT",
      condition: { kind: "amountAtMost", max: 500, actions: [DANGEROUS_UNCATALOGUED] },
      action: "APPROVAL_REQUIRED",
      status: "enabled",
      appliesToAgentIds: null,
      risk: "HIGH",
      priority: 60,
      ...overrides,
    } as PolicyRule;
  }

  function evaluate(policies: PolicyRule[], amount = 75, action = DANGEROUS_UNCATALOGUED) {
    return evaluateAction({
      agent: AGENT,
      action,
      target: "customer_123",
      metadata: { amount, currency: "EUR" },
      policies,
    });
  }

  it("holds the verb when nothing names it", () => {
    // The pre-existing behaviour, pinned so the fix below is visible as a change
    // of behaviour and not merely as a new passing test.
    const result = evaluate([]);
    expect(result.decision).not.toBe("ALLOW");
    expect(result.matched.map((m) => m.policyId)).toContain("sys_unknown_dangerous_action");
  });

  it("allows an amount under the threshold once a policy names the verb", () => {
    const result = evaluate([amountPolicy()]);
    expect(result.decision).toBe("ALLOW");
    expect(result.matched.map((m) => m.policyId)).not.toContain("sys_unknown_dangerous_action");
  });

  it("still enforces that policy above its threshold", () => {
    // Standing the heuristic down must not stand the POLICY down: the whole
    // point is that the operator's own rule becomes the thing that decides.
    const result = evaluate([amountPolicy()], 750);
    expect(result.decision).toBe("APPROVAL_REQUIRED");
    expect(result.policyId).toBe("pol_stripe");
  });

  describe("a wildcard is not an off-switch", () => {
    it.each([
      ["a bare wildcard", ["*"]],
      ["a namespace wildcard", ["stripe.*"]],
      ["a prefix wildcard", ["stripe.ref*"]],
    ])("%s does not disarm the heuristic", (_label, actions) => {
      /*
       * The security-critical case. `actions: ["*"]` is a perfectly ordinary
       * thing for an operator to write as an org-wide ceiling, and if it
       * counted as a risk assessment of every verb, one such policy would
       * silently turn the dangerous-name heuristic off across the whole system.
       * Disarming it has to be per-verb and deliberate.
       */
      const result = evaluate([amountPolicy({ condition: { kind: "amountAtMost", max: 500, actions } })]);
      expect(result.matched.map((m) => m.policyId)).toContain("sys_unknown_dangerous_action");
      expect(result.decision).not.toBe("ALLOW");
    });

    it("does not disarm it for a sibling verb the policy never named", () => {
      // The policy names `stripe.refund`; `stripe.transfer` is a different verb
      // and nobody assessed it.
      const result = evaluate([amountPolicy()], 75, "stripe.transfer");
      expect(result.matched.map((m) => m.policyId)).toContain("sys_unknown_dangerous_action");
      expect(result.decision).not.toBe("ALLOW");
    });
  });

  it("is not disarmed by a policy that is disabled", () => {
    // A rule not in force is not an assessment.
    const result = evaluate([amountPolicy({ status: "disabled" })]);
    expect(result.matched.map((m) => m.policyId)).toContain("sys_unknown_dangerous_action");
    expect(result.decision).not.toBe("ALLOW");
  });

  it("is not disarmed by a policy that does not apply to this agent", () => {
    const result = evaluate([amountPolicy({ appliesToAgentIds: ["agt_somebody_else"] })]);
    expect(result.matched.map((m) => m.policyId)).toContain("sys_unknown_dangerous_action");
    expect(result.decision).not.toBe("ALLOW");
  });

  it("is not disarmed by a condition with no actions list at all", () => {
    // An absent list means "every action"; treating that as naming the verb
    // would be the same global off-switch as `*`.
    const result = evaluate([amountPolicy({ condition: { kind: "amountAtMost", max: 500 } })]);
    expect(result.matched.map((m) => m.policyId)).toContain("sys_unknown_dangerous_action");
    expect(result.decision).not.toBe("ALLOW");
  });

  describe("which synthetic verdict the caller is told about", () => {
    /*
     * WHY THIS BLOCK EXISTS - a real gap, found by mutating the code.
     *
     * `undeclaredActionVerdict` carries `priority: 95`, and the comment above it
     * explains that this places it over `sys_unknown_dangerous_action` (90) and
     * `sys_ungoverned_money` (88) so the caller reads "the most fundamental"
     * reason. That was documented and unmeasured: changing 95 to 1 left the
     * whole suite green, because all three synthetic verdicts BLOCK and every
     * test asserted only the decision.
     *
     * The decision is not the only thing that matters here. `policyId` and
     * `reason` are what a developer acts on, and they are what the audit trail
     * records as the justification for a refusal. Being told "this verb looks
     * dangerous" when the truth is "nothing has ever assessed this verb" sends
     * the developer to the wrong fix, and leaves the audit trail attributing the
     * refusal to a heuristic that was incidental to it.
     */

    /** A verb that trips the dangerous-name heuristic AND is undeclared. */
    const UNDECLARED_AND_DANGEROUS = "vendor.delete_everything";

    it("reports the undeclared reason, not the dangerous-name heuristic", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: UNDECLARED_AND_DANGEROUS,
        target: "acct_1",
        policies: [],
      });

      expect(result.decision).toBe("BLOCK");
      // Both verdicts fire; the caller must be told the fundamental one.
      expect(result.policyId).toBe("sys_undeclared_action");
      expect(result.matched.map((entry) => entry.policyId)).toContain(
        "sys_unknown_dangerous_action",
      );
    });

    it("reports the undeclared reason ahead of the ungoverned-money verdict", () => {
      const result = evaluateAction({
        agent: AGENT,
        action: "vendor.wire_transfer",
        target: "acct_1",
        metadata: { amount: 5000, currency: "EUR" },
        policies: [],
      });

      expect(result.decision).toBe("BLOCK");
      expect(result.policyId).toBe("sys_undeclared_action");
    });

    it("keeps the undeclared verdict at a strictly higher priority than the others", () => {
      /*
       * Asserted on the emitted verdicts rather than on a constant, so the
       * ordering is measured where it is actually used. Numbers are not pinned
       * to 95/90/88 - only the relation is a guarantee, and pinning the literals
       * would break this test for a renumbering that changes nothing.
       */
      const result = evaluateAction({
        agent: AGENT,
        action: UNDECLARED_AND_DANGEROUS,
        target: "acct_1",
        metadata: { amount: 5000, currency: "EUR" },
        policies: [],
      });

      const priorityOf = (policyId: string): number => {
        const entry = result.matched.find((match) => match.policyId === policyId);
        expect(entry, `expected ${policyId} to be among the matched verdicts`).toBeDefined();
        return entry!.priority;
      };

      const undeclared = priorityOf("sys_undeclared_action");
      for (const other of result.matched) {
        if (other.policyId === "sys_undeclared_action") continue;
        expect(
          undeclared,
          `sys_undeclared_action (${undeclared}) must outrank ${other.policyId} (${other.priority})`,
        ).toBeGreaterThan(other.priority);
      }
    });

    it("hands over to the dangerous-name verdict when a wildcard declares the namespace", () => {
      /*
       * The other side of the ordering, and the reason the two heuristics are
       * separate rules rather than one.
       *
       * A policy that names the verb LITERALLY disarms the dangerous-name
       * heuristic as well - a human read that exact verb and decided, so Oathrion
       * stops second-guessing it (`namesActionLiterally` in engine.ts). Measured,
       * not assumed: an earlier version of this test asserted the heuristic still
       * fired for a literal `actions: [UNDECLARED_AND_DANGEROUS]` policy and
       * failed, which is how the distinction below got written down.
       *
       * A wildcard is different in kind. `vendor.*` declares a namespace, so the
       * verb is no longer undeclared - but nobody read *this* verb, so the
       * dangerous-name heuristic must survive. That is the case that proves the
       * lower-priority verdict is real and not dead code hidden behind
       * priority 95.
       */
      const declaresTheNamespace: PolicyRule = {
        id: "pol_vendor_ns",
        name: "Vendor namespace",
        description: "A human took responsibility for vendor.*, not for each verb in it.",
        type: "MAX_TRANSACTION_AMOUNT",
        condition: { kind: "amountAtMost", max: 1000, actions: ["vendor.*"] },
        action: "ALLOW",
        status: "enabled",
        appliesToAgentIds: null,
        risk: "LOW",
        priority: 10,
      };

      const result = evaluateAction({
        agent: AGENT,
        action: UNDECLARED_AND_DANGEROUS,
        target: "acct_1",
        policies: [declaresTheNamespace],
      });

      // No longer undeclared - the wildcard covers it.
      expect(result.matched.map((entry) => entry.policyId)).not.toContain(
        "sys_undeclared_action",
      );
      // But a wildcard is not a reading of this verb, so the heuristic holds,
      // and an explicit ALLOW policy does not turn `delete_everything` loose.
      expect(result.matched.map((entry) => entry.policyId)).toContain(
        "sys_unknown_dangerous_action",
      );
      expect(result.decision).not.toBe("ALLOW");
    });

    it("lets a literal declaration settle the verb, and the human's policy decides", () => {
      /*
       * Named explicitly so the asymmetry above is a documented guarantee rather
       * than an accident of implementation: a literal name disarms BOTH synthetic
       * verdicts, and the policy the human wrote is what decides.
       */
      const namesItLiterally: PolicyRule = {
        id: "pol_vendor",
        name: "Vendor deletes",
        description: "A human read this exact verb and required approval for it.",
        type: "MAX_TRANSACTION_AMOUNT",
        condition: { kind: "amountAtMost", max: 1000, actions: [UNDECLARED_AND_DANGEROUS] },
        action: "APPROVAL_REQUIRED",
        status: "enabled",
        appliesToAgentIds: null,
        risk: "MEDIUM",
        priority: 10,
      };

      const result = evaluateAction({
        agent: AGENT,
        action: UNDECLARED_AND_DANGEROUS,
        target: "acct_1",
        // The amount lives in `metadata`, which is where the amount matchers
        // read it from (`readNumber(ctx.metadata, field)` in rules.ts). Passing
        // it top-level is silently ignored - see the fail-closed test below,
        // which is how this was discovered.
        metadata: { amount: 5000 },
        policies: [namesItLiterally],
      });

      // Only the human's policy is left: both synthetic verdicts stood down,
      // and the cap the human wrote is what produces the answer.
      expect(result.matched.map((entry) => entry.policyId)).toEqual(["pol_vendor"]);
      expect(result.decision).toBe("APPROVAL_REQUIRED");
      expect(result.policyId).toBe("pol_vendor");
    });

    it("will reach ALLOW for a dangerous-looking verb a human explicitly governed", () => {
      /*
       * The sharp edge of the escape hatch, written down because it is the one
       * thing in this area that could be mistaken for a bug.
       *
       * `vendor.delete_everything` looks alarming and is not in
       * `shared/policy/actions.ts`. Both synthetic verdicts would refuse it. But
       * a policy that names the verb literally and whose own condition is
       * satisfied produces ALLOW - a plain, unqualified ALLOW.
       *
       * That is correct, and it is the point of the posture: the synthetic
       * verdicts exist to refuse what nobody has considered, not to overrule
       * somebody who considered it. A control plane that could not be told
       * "yes, I mean this verb, within this cap" would be unusable, and its
       * operators would set OATHRION_UNDECLARED_ACTION=allow globally - which is
       * far worse than one narrow policy.
       *
       * The guarantee is therefore: nothing reaches ALLOW without a human having
       * named it. It is NOT: dangerous-looking verbs can never be allowed.
       */
      const governed: PolicyRule = {
        id: "pol_vendor_ok",
        name: "Vendor deletes under cap",
        description: "A human named this exact verb and set a limit for it.",
        type: "MAX_TRANSACTION_AMOUNT",
        condition: { kind: "amountAtMost", max: 1000, actions: [UNDECLARED_AND_DANGEROUS] },
        action: "APPROVAL_REQUIRED",
        status: "enabled",
        appliesToAgentIds: null,
        risk: "MEDIUM",
        priority: 10,
      };

      const result = evaluateAction({
        agent: AGENT,
        action: UNDECLARED_AND_DANGEROUS,
        target: "acct_1",
        metadata: { amount: 500 },
        policies: [governed],
      });

      expect(result.decision).toBe("ALLOW");
      // And the trail records which human decision permitted it, so the ALLOW
      // is attributable rather than anonymous.
      expect(result.matched.map((entry) => entry.policyId)).toEqual(["pol_vendor_ok"]);
    });

    it("fails closed when an amount cap is asked about an action with no amount", () => {
      /*
       * Found while writing the test above, which originally omitted `amount` and
       * expected APPROVAL_REQUIRED. It got BLOCK, and the BLOCK is right: an
       * amount cap cannot be evaluated against an action that declares no amount,
       * and a check that cannot be performed must not be treated as a check that
       * passed. Recorded here so the behaviour is a guarantee rather than a
       * surprise the next reader has to rediscover.
       */
      const cap: PolicyRule = {
        id: "pol_cap",
        name: "Capped",
        description: "Caps an amount that this action does not carry.",
        type: "MAX_TRANSACTION_AMOUNT",
        condition: { kind: "amountAtMost", max: 1000, actions: [UNDECLARED_AND_DANGEROUS] },
        action: "APPROVAL_REQUIRED",
        status: "enabled",
        appliesToAgentIds: null,
        risk: "MEDIUM",
        priority: 10,
      };

      const result = evaluateAction({
        agent: AGENT,
        action: UNDECLARED_AND_DANGEROUS,
        target: "acct_1",
        policies: [cap],
      });

      expect(result.decision).toBe("BLOCK");
      expect(result.reason).toContain("cannot be checked");
    });
  });
});
