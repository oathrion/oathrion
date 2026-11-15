/**
 * The canonical action envelope and the constraint language (Phase 10, §§10, 13).
 *
 * WHY THESE TWO IN ONE FILE
 * -------------------------
 * They are the two places where a wrong answer is silent. A canonical form that
 * is not stable produces a hash that is not stable, and a grant bound to an
 * unstable hash refuses honest work and — worse — a form that ignores a field
 * makes a grant authorize actions nobody approved. A constraint evaluator that
 * coerces types turns `amount: "1000"` into a number small enough to pass.
 * Neither failure raises an error; both just quietly say yes.
 */

import { describe, expect, it } from "vitest";
import {
  ActionCanonicalizationError,
  buildActionEnvelope,
  canonicalizeAction,
  hashCanonicalAction,
} from "../action/canonical";
import { assertNoAuthoritativeFields } from "../action/canonical";
import {
  ConstraintError,
  evaluateConstraints,
  parseConstraints,
  type ConstraintSubject,
} from "@shared/policy/constraints";

const BASE = {
  tenantId: "org_default",
  agentId: "agt_refund_bot",
  action: "stripe.refund",
  destinationId: "local-fixture",
  arguments: { customer: "cus_1", amount: 75, currency: "EUR" },
};

describe("canonical action envelope", () => {
  it("is insensitive to the order the caller happened to write the keys in", () => {
    const a = canonicalizeAction(BASE);
    const b = canonicalizeAction({
      ...BASE,
      arguments: { currency: "EUR", amount: 75, customer: "cus_1" },
    });
    expect(a).toBe(b);
    expect(hashCanonicalAction(a)).toBe(hashCanonicalAction(b));
  });

  it("changes when any authoritative part of the action changes", () => {
    const base = hashCanonicalAction(canonicalizeAction(BASE));
    const variants = {
      amount: { ...BASE, arguments: { ...BASE.arguments, amount: 750 } },
      currency: { ...BASE, arguments: { ...BASE.arguments, currency: "USD" } },
      recipient: { ...BASE, arguments: { ...BASE.arguments, customer: "cus_2" } },
      verb: { ...BASE, action: "stripe.payout" },
      agent: { ...BASE, agentId: "agt_other" },
      tenant: { ...BASE, tenantId: "org_rival_corp" },
      destination: { ...BASE, destinationId: "other-fixture" },
    };
    for (const [name, variant] of Object.entries(variants)) {
      expect(hashCanonicalAction(canonicalizeAction(variant)), name).not.toBe(base);
    }
  });

  it("preserves array order, because order is meaning in a list of recipients", () => {
    const one = canonicalizeAction({ ...BASE, arguments: { items: ["a", "b"] } });
    const two = canonicalizeAction({ ...BASE, arguments: { items: ["b", "a"] } });
    expect(one).not.toBe(two);
  });

  it("treats -0 and 0 as the same number, so a hash cannot depend on a sign bit", () => {
    expect(canonicalizeAction({ ...BASE, arguments: { amount: -0 } })).toBe(
      canonicalizeAction({ ...BASE, arguments: { amount: 0 } }),
    );
  });

  it("refuses values that have no deterministic serialisation", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(() =>
        canonicalizeAction({ ...BASE, arguments: { amount: bad as never } }),
      ).toThrow(ActionCanonicalizationError);
    }
  });

  it("refuses a caller-supplied hash, tenant or verdict instead of ignoring it", () => {
    for (const field of ["tenantId", "actionHash", "action_hash", "decision", "grantId", "actor"]) {
      expect(() => assertNoAuthoritativeFields({ [field]: "x" }, "a test body")).toThrow(/authoritative/i);
    }
    // The agent MAY be named: `resolveActingAgent` decides whether the claim stands.
    expect(() => assertNoAuthoritativeFields({ agentId: "agt_x" }, "a test body")).not.toThrow();
  });

  it("builds an envelope whose hash is the hash of its own canonical form", () => {
    const envelope = buildActionEnvelope({
      tenantId: "org_default",
      agentId: "agt_refund_bot",
      request: { action: "stripe.refund", destinationId: "local-fixture", arguments: { amount: 75 } },
    });
    expect(envelope.actionHash).toBe(hashCanonicalAction(envelope.canonical));
    expect(envelope.actionHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deterministic constraint language", () => {
  const subject: ConstraintSubject = {
    action: "stripe.refund",
    destinationId: "local-fixture",
    agentId: "agt_refund_bot",
    arguments: { amount: 75, currency: "EUR", note: "ok", live: true },
  };

  function ok(constraint: unknown): boolean {
    return evaluateConstraints(subject, parseConstraints([constraint])).satisfied;
  }

  it("evaluates every documented operator", () => {
    expect(ok({ field: "amount", op: "lte", value: 100 })).toBe(true);
    expect(ok({ field: "amount", op: "lt", value: 75 })).toBe(false);
    expect(ok({ field: "amount", op: "gte", value: 75 })).toBe(true);
    expect(ok({ field: "amount", op: "gt", value: 75 })).toBe(false);
    expect(ok({ field: "currency", op: "eq", value: "EUR" })).toBe(true);
    expect(ok({ field: "currency", op: "neq", value: "USD" })).toBe(true);
    expect(ok({ field: "currency", op: "in", value: ["EUR", "GBP"] })).toBe(true);
    expect(ok({ field: "currency", op: "not_in", value: ["USD"] })).toBe(true);
    expect(ok({ field: "note", op: "len_lte", value: 10 })).toBe(true);
    expect(ok({ field: "currency", op: "matches", value: "EU*" })).toBe(true);
  });

  it("fails a missing field for EVERY operator, including the negative ones", () => {
    /*
     * The subtle one. `not_in` on an absent field reads as "the field is not one
     * of the forbidden values", which is true of a field that does not exist —
     * and would let an argument the rule was written to constrain pass simply by
     * being omitted. A missing field is unevaluatable, so the constraint fails.
     */
    expect(ok({ field: "missing", op: "not_in", value: ["USD"] })).toBe(false);
    expect(ok({ field: "missing", op: "neq", value: "USD" })).toBe(false);
    expect(ok({ field: "missing", op: "eq", value: "USD" })).toBe(false);
    expect(ok({ field: "missing", op: "lte", value: 1_000_000 })).toBe(false);
  });

  it("does not coerce across types, so a numeric string is not a number", () => {
    const stringly: ConstraintSubject = { ...subject, arguments: { amount: "75" } };
    expect(evaluateConstraints(stringly, parseConstraints([{ field: "amount", op: "lte", value: 100 }])).satisfied).toBe(
      false,
    );
    expect(evaluateConstraints(stringly, parseConstraints([{ field: "amount", op: "eq", value: 75 }])).satisfied).toBe(
      false,
    );
  });

  it("requires ALL constraints, so a rule is a conjunction not a menu", () => {
    expect(
      evaluateConstraints(
        subject,
        parseConstraints([
          { field: "amount", op: "lte", value: 100 },
          { field: "currency", op: "eq", value: "USD" },
        ]),
      ).satisfied,
    ).toBe(false);
  });

  it("refuses an unknown operator and a malformed rule at write time", () => {
    expect(() => parseConstraints([{ field: "amount", op: "eval", value: 1 }])).toThrow(ConstraintError);
    expect(() => parseConstraints([{ field: "amount", op: "lte" }])).toThrow(ConstraintError);
    expect(() => parseConstraints([{ op: "lte", value: 1 }])).toThrow(ConstraintError);
    // No expression language: a rule is data, so there is nothing to execute.
    expect(() => parseConstraints(["amount < 100"])).toThrow(ConstraintError);
  });

  it("treats `matches` as a glob over strings, never as a regular expression", () => {
    // `*` is the ONE wildcard. Every other regex metacharacter is a literal, so a
    // pattern copied from a regex cannot quietly widen a rule.
    expect(ok({ field: "currency", op: "matches", value: "E*" })).toBe(true);
    expect(ok({ field: "currency", op: "matches", value: "E.R" })).toBe(false);
    expect(ok({ field: "currency", op: "matches", value: "E?R" })).toBe(false);
    expect(ok({ field: "currency", op: "matches", value: ".*" })).toBe(false);
  });
});
