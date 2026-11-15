/**
 * The money module is the floor every spending decision stands on, so it is tested on
 * its own before anything depends on it.
 *
 * The cases that matter are not the happy ones. They are: the franc CFA having no
 * subdivision, an amount carrying more precision than its currency allows, and two
 * currencies meeting in a comparison that has no honest answer.
 */
import { describe, expect, it } from "vitest";

import {
  addMoney,
  compareMoney,
  CURRENCIES,
  DEFAULT_CURRENCY,
  describeMoneyError,
  exponentOf,
  formatMoney,
  isCurrencyCode,
  MAX_MINOR_UNITS,
  moneyFromDecimal,
  moneyFromMinor,
  parseCurrency,
  sameCurrency,
  SUPPORTED_CURRENCIES,
  toDecimal,
  type Money,
} from "./money";

/** Unwraps a result the test asserts is valid, so a failure names the error. */
function must(result: ReturnType<typeof moneyFromDecimal>): Money {
  if (!result.ok) throw new Error(`expected a valid amount, got ${JSON.stringify(result.error)}`);
  return result.money;
}

describe("the currency registry", () => {
  it("covers the franc CFA zones the product targets, as two distinct currencies", () => {
    expect(SUPPORTED_CURRENCIES).toEqual(expect.arrayContaining(["XOF", "XAF", "EUR", "USD"]));
    // Pegged to the euro at the same rate, issued by different central banks. Treating
    // them as one would be wrong even though the peg makes it look harmless.
    expect("XOF").not.toBe("XAF");
    expect(CURRENCIES.XOF.label).not.toBe(CURRENCIES.XAF.label);
  });

  it("gives the franc CFA no subdivision and the euro two decimals", () => {
    expect(exponentOf("XOF")).toBe(0);
    expect(exponentOf("XAF")).toBe(0);
    expect(exponentOf("EUR")).toBe(2);
    expect(exponentOf("USD")).toBe(2);
  });

  it("derives the supported list from the registry, so there is no second list to forget", () => {
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual(Object.keys(CURRENCIES).sort());
    for (const code of SUPPORTED_CURRENCIES) expect(isCurrencyCode(code)).toBe(true);
  });

  it("recognises a declared currency case- and space-insensitively", () => {
    expect(parseCurrency("xof")).toBe("XOF");
    expect(parseCurrency("  EUR  ")).toBe("EUR");
    expect(parseCurrency("Xaf")).toBe("XAF");
  });

  it("returns null for an unknown currency rather than falling back to a default", () => {
    // The tempting fallbacks are exactly the dangerous ones: "CFA" is ambiguous between
    // XOF and XAF, and "EURO" is a typo that must not resolve to EUR.
    for (const raw of ["CFA", "EURO", "FCFA", "GBP", "", "   ", null, undefined, 42, {}]) {
      expect(parseCurrency(raw), `parseCurrency(${JSON.stringify(raw)})`).toBeNull();
    }
    expect(DEFAULT_CURRENCY).toBe("EUR");
  });
});

describe("building an amount", () => {
  it("scales a decimal euro amount to centimes exactly", () => {
    expect(must(moneyFromDecimal(10.5, "EUR")).minor).toBe(1050);
    expect(must(moneyFromDecimal(0.01, "EUR")).minor).toBe(1);
    expect(must(moneyFromDecimal(0, "EUR")).minor).toBe(0);
    // 10.5 * 100 is 1050.0000000000001 in IEEE 754. Truncation would give 1050 here and
    // the wrong answer for some other value; rounding the product is exact for every
    // amount this function accepts.
    expect(must(moneyFromDecimal(1.15, "EUR")).minor).toBe(115);
  });

  it("treats a franc CFA amount as its own minor unit", () => {
    expect(must(moneyFromDecimal(1000, "XOF")).minor).toBe(1000);
    expect(must(moneyFromDecimal(655957, "XAF")).minor).toBe(655957);
    expect(toDecimal(must(moneyFromDecimal(1000, "XOF")))).toBe(1000);
  });

  it("REFUSES a fractional franc rather than rounding it", () => {
    for (const value of [1000.5, 0.5, 1.01, 999.999]) {
      for (const currency of ["XOF", "XAF"] as const) {
        const result = moneyFromDecimal(value, currency);
        expect(result.ok, `${value} ${currency} should be refused`).toBe(false);
        if (!result.ok) {
          expect(result.error.kind).toBe("too_precise");
          // The operator is told it was refused, not quietly given a different number.
          expect(describeMoneyError(result.error)).toMatch(/refused rather than rounded/);
        }
      }
    }
  });

  it("REFUSES a euro amount with more than two decimals rather than rounding it", () => {
    const result = moneyFromDecimal(10.005, "EUR");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("too_precise");
      expect(describeMoneyError(result.error)).toMatch(/decimals/);
    }
  });

  it("refuses a negative amount, which is not a spend", () => {
    const result = moneyFromDecimal(-1, "EUR");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("negative");
  });

  it("refuses NaN, Infinity and non-numbers", () => {
    for (const value of [NaN, Infinity, -Infinity, "10", null, undefined, {}]) {
      const result = moneyFromDecimal(value, "EUR");
      expect(result.ok, `moneyFromDecimal(${String(value)})`).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_a_number");
    }
  });

  it("refuses an amount beyond the range it can add without losing precision", () => {
    const result = moneyFromDecimal(MAX_MINOR_UNITS + 1, "XOF");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("out_of_range");
    // Two amounts at the ceiling still add exactly, which is why the ceiling is where
    // it is rather than at MAX_SAFE_INTEGER.
    const top = must(moneyFromMinor(MAX_MINOR_UNITS, "XOF"));
    expect(Number.isSafeInteger(addMoney(top, top).minor)).toBe(true);
  });

  it("refuses minor units that are not whole", () => {
    const result = moneyFromMinor(10.5, "EUR");
    expect(result.ok).toBe(false);
  });
});

describe("comparing and adding", () => {
  it("compares ceilings exactly, where floating point would not", () => {
    /*
     * The case that motivates the whole representation: 0.1 + 0.2 > 0.3 is TRUE in IEEE
     * 754. Expressed in centimes it is 10 + 20 === 30, and an action at exactly its
     * ceiling is allowed rather than refused by a rounding artefact.
     */
     expect(0.1 + 0.2 > 0.3).toBe(true);
    const tenth = must(moneyFromDecimal(0.1, "EUR"));
    const fifth = must(moneyFromDecimal(0.2, "EUR"));
    const ceiling = must(moneyFromDecimal(0.3, "EUR"));
    expect(compareMoney(addMoney(tenth, fifth), ceiling)).toBe(0);
  });

  it("orders amounts of one currency", () => {
    const small = must(moneyFromDecimal(100, "XOF"));
    const large = must(moneyFromDecimal(500, "XOF"));
    expect(compareMoney(small, large)).toBeLessThan(0);
    expect(compareMoney(large, small)).toBeGreaterThan(0);
    expect(compareMoney(small, small)).toBe(0);
  });

  it("REFUSES to compare two currencies instead of inventing an ordering", () => {
    const euros = must(moneyFromDecimal(100, "EUR"));
    const francs = must(moneyFromDecimal(100, "XOF"));
    expect(sameCurrency(euros, francs)).toBe(false);
    // 100 EUR is about 65 596 XOF. Any ordering this returned would be a guess, and a
    // ceiling check that got a guess would allow or refuse the wrong actions.
    expect(() => compareMoney(euros, francs)).toThrow(/no exchange rates/i);
    expect(() => addMoney(euros, francs)).toThrow(/no exchange rates/i);
  });

  it("refuses to compare the two franc CFA currencies with each other", () => {
    // Same peg, different issuers. The peg is not a licence to treat them as one.
    const bceao = must(moneyFromDecimal(1000, "XOF"));
    const beac = must(moneyFromDecimal(1000, "XAF"));
    expect(() => compareMoney(bceao, beac)).toThrow(/XOF|XAF/);
  });
});

describe("formatting", () => {
  it("keeps euro centimes, which the previous formatter dropped", () => {
    // The old implementation hard-coded maximumFractionDigits: 0 for every currency, so
    // every reason string said "11 €" for 10,50 €.
    expect(formatMoney(must(moneyFromDecimal(10.5, "EUR")))).toMatch(/10,50/);
  });

  it("never gives the franc CFA decimals it does not have", () => {
    for (const currency of ["XOF", "XAF"] as const) {
      const text = formatMoney(must(moneyFromDecimal(1000, currency)));
      expect(text, `${currency}: ${text}`).not.toMatch(/[.,]\d/);
      expect(text).toMatch(/1\s?000/);
    }
  });

  it("names the currency, so an audit line is never ambiguous between the two francs", () => {
    const xof = formatMoney(must(moneyFromDecimal(1000, "XOF")));
    const xaf = formatMoney(must(moneyFromDecimal(1000, "XAF")));
    expect(xof).not.toBe(xaf);
  });

  it("emits only plain spaces, so audit text is stable across ICU versions", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const text = formatMoney(must(moneyFromDecimal(1234, currency)));
      expect(text, `${currency}: ${JSON.stringify(text)}`).not.toMatch(/[\u202f\u00a0\u2009]/);
    }
  });
});
