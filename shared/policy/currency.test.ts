/**
 * Currency behaviour of the policy engine, per tenant.
 *
 * The engine used to reason in one deployment-wide currency (`ORG_CURRENCY = "EUR"`).
 * These tests pin the behaviour that replaced it, and in particular the three answers
 * that must never be the same thing:
 *
 *   - **absent** currency on an action: the tenant's currency is used;
 *   - **unknown** currency ("CFA", "EURO"): refused, because it is a mistake;
 *   - **different, valid** currency: refused, because Oathrion holds no exchange rates.
 *
 * The last one is the dangerous case. Converting would be the "helpful" behaviour and it
 * would mean a ceiling of 500 approving a payment of 300 000 — so the engine refuses and
 * says why.
 */
import { describe, expect, it } from "vitest";

import { evaluateAction } from "./engine";
import { EMPTY_MANDATE } from "./mandate";
import type { EvaluationAgent, PolicyRule } from "./types";
import type { CurrencyCode } from "../money";

function agent(overrides: Partial<EvaluationAgent> = {}): EvaluationAgent {
  return {
    id: "agt_test",
    name: "Agent de test",
    status: "active",
    permissions: ["execute:payments"],
    policyIds: [],
    mandate: EMPTY_MANDATE,
    ...overrides,
  } as EvaluationAgent;
}

/** A transaction ceiling policy. `currency` omitted means "the tenant's". */
function ceiling(max: number, currency?: string): PolicyRule {
  return {
    id: "pol_ceiling",
    name: "Plafond par transaction",
    type: "MAX_TRANSACTION_AMOUNT",
    status: "enabled",
    action: "APPROVAL_REQUIRED",
    risk: "HIGH",
    priority: 50,
    appliesToAgentIds: null,
    condition: {
      kind: "amountAtMost",
      max,
      actions: ["purchase"],
      ...(currency === undefined ? {} : { currency: currency as CurrencyCode }),
    },
  } as PolicyRule;
}

function evaluate(opts: {
  orgCurrency: CurrencyCode;
  amount: number;
  declared?: string;
  max?: number;
  policyCurrency?: string;
}) {
  return evaluateAction({
    agent: agent(),
    action: "purchase",
    target: "fournisseur.example",
    metadata: {
      amount: opts.amount,
      ...(opts.declared === undefined ? {} : { currency: opts.declared }),
    },
    policies: [ceiling(opts.max ?? 500, opts.policyCurrency)],
    orgCurrency: opts.orgCurrency,
  });
}

describe("a tenant in the franc CFA zone", () => {
  it("evaluates its ceilings in XOF, not in the deployment's euro", () => {
    // 400 000 XOF is about 610 €. Under a 500 000 XOF ceiling it is ALLOWED; read as
    // euros against a 500 ceiling it would have been held for approval.
    const result = evaluate({ orgCurrency: "XOF", amount: 400_000, max: 500_000 });
    expect(result.decision).toBe("ALLOW");
    expect(result.reason).toMatch(/400\s?000/);
    expect(result.reason).not.toMatch(/€/);
  });

  it("names the franc, never the euro, in the reason an operator reads", () => {
    const result = evaluate({ orgCurrency: "XOF", amount: 900_000, max: 500_000 });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
    expect(result.reason).not.toMatch(/€/);
  });

  it("keeps XOF and XAF apart even though both are pegged to the euro", () => {
    // Same nominal amount, same peg, different currencies. Comparing them is refused.
    const result = evaluate({ orgCurrency: "XOF", amount: 1000, declared: "XAF", max: 5000 });
    expect(result.decision).toBe("BLOCK");
  });
});

describe("the boundary of a ceiling", () => {
  it("allows an amount exactly equal to the limit", () => {
    for (const [currency, max] of [
      ["EUR", 500],
      ["XOF", 500_000],
    ] as const) {
      const result = evaluate({ orgCurrency: currency, amount: max, max });
      expect(result.decision, `${max} ${currency} at the limit`).toBe("ALLOW");
    }
  });

  it("holds an amount one minor unit above the limit", () => {
    expect(evaluate({ orgCurrency: "EUR", amount: 500.01, max: 500 }).decision).toBe(
      "APPROVAL_REQUIRED",
    );
    expect(evaluate({ orgCurrency: "XOF", amount: 500_001, max: 500_000 }).decision).toBe(
      "APPROVAL_REQUIRED",
    );
  });

  it("allows a sum that floating point would have pushed over the limit", () => {
    /*
     * The regression this representation exists for. 0.1 + 0.2 > 0.3 is true in IEEE 754,
     * so a ceiling compared in floats refuses an action that is exactly at its limit for
     * no reason an operator could ever explain.
     */
    const result = evaluate({ orgCurrency: "EUR", amount: 0.1 + 0.2, max: 0.3 });
    expect(result.decision).toBe("ALLOW");
  });
});

describe("rounding is refused, not performed", () => {
  it("refuses a fractional franc rather than rounding it to the nearest franc", () => {
    // 1000,5 XOF is not an amount of money. Rounding it would silently decide whether the
    // action sits above or below its ceiling.
    const result = evaluate({ orgCurrency: "XOF", amount: 1000.5, max: 1000 });
    expect(result.decision).toBe("BLOCK");
    expect(result.reason).toMatch(/refused rather than rounded/);
  });

  it("refuses a euro amount with three decimals", () => {
    const result = evaluate({ orgCurrency: "EUR", amount: 10.005, max: 500 });
    expect(result.decision).toBe("BLOCK");
    expect(result.reason).toMatch(/decimals/);
  });

  it("refuses a POLICY whose ceiling is not a representable amount", () => {
    // The configuration is at fault, not the action, and the message says so.
    const result = evaluate({ orgCurrency: "XOF", amount: 100, max: 1000.5 });
    expect(result.decision).toBe("BLOCK");
    expect(result.reason).toMatch(/plafond/i);
  });
});

describe("the three ways a currency can be wrong", () => {
  it("absent: inherits the tenant's currency and evaluates normally", () => {
    const result = evaluate({ orgCurrency: "XOF", amount: 100, max: 500 });
    expect(result.decision).toBe("ALLOW");
  });

  it("unknown: refused, because an unrecognised code is a mistake", () => {
    // "CFA" is the dangerous one: ambiguous between XOF and XAF, and the abbreviation
    // people actually write. Resolving it either way would be a guess about money.
    for (const declared of ["CFA", "FCFA", "EURO", "GBP", "euros"]) {
      const result = evaluate({ orgCurrency: "XOF", amount: 100, declared, max: 500 });
      expect(result.decision, `currency "${declared}"`).toBe("BLOCK");
    }
  });

  it("different but valid: refused rather than converted", () => {
    /*
     * 100 EUR is about 65 600 XOF. A tenant whose ceiling is 500 XOF must not see an
     * action declaring 100 EUR allowed because 100 <= 500 compared as bare numbers —
     * which is exactly what a single-currency engine did when the action carried a
     * currency it had no way to represent.
     */
    const result = evaluate({ orgCurrency: "XOF", amount: 100, declared: "EUR", max: 500 });
    expect(result.decision).toBe("BLOCK");
    expect(result.reason).toMatch(/not comparable|comparable/i);
  });

  it("a policy written in another currency than its tenant is refused, with the fix named", () => {
    const result = evaluate({
      orgCurrency: "XOF",
      amount: 100,
      max: 500,
      policyCurrency: "EUR",
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.reason).toMatch(/XOF/);
    expect(result.reason).toMatch(/exchange rate/);
  });
});

describe("the engine's default currency is an ergonomic, not a security fallback", () => {
  it("falls back to EUR only when no tenant currency is supplied", () => {
    const result = evaluateAction({
      agent: agent(),
      action: "purchase",
      target: "fournisseur.example",
      metadata: { amount: 100 },
      policies: [ceiling(500)],
      // orgCurrency deliberately omitted.
    });
    expect(result.decision).toBe("ALLOW");
  });

  it("cannot turn a refusal into an allowance", () => {
    // Whatever the default, a mismatch is still a BLOCK: the default decides which
    // currency an undeclared policy inherits, never whether a comparison is safe.
    const result = evaluateAction({
      agent: agent(),
      action: "purchase",
      target: "fournisseur.example",
      metadata: { amount: 100, currency: "XOF" },
      policies: [ceiling(500, "EUR")],
    });
    expect(result.decision).toBe("BLOCK");
  });
});
