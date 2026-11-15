/**
 * Money: a currency registry and integer arithmetic in minor units.
 *
 * ## Why this module exists
 *
 * Before Phase 12.3 the deployment had ONE currency, `ORG_CURRENCY = "EUR"`, as a
 * module constant, and every amount was a JavaScript `number`. Two consequences, both
 * blocking for the target market:
 *
 *  1. **XOF and XAF were inexpressible.** The franc CFA zones are the commercial target,
 *     and a type union of `"EUR" | "USD"` cannot name them. A single module constant also
 *     cannot serve a tenant in Dakar and a tenant in Paris from one deployment, which is
 *     what a multi-tenant SaaS is.
 *  2. **Ceilings were compared in floating point.** `0.1 + 0.2 > 0.3` is true in IEEE 754.
 *     A spending ceiling is the one number in this system that must not be approximately
 *     right, because the whole product is "this action was within its limit".
 *
 * So amounts are integers in the currency's **minor unit**, and the currency travels with
 * them. 10,50 EUR is `{ minor: 1050, currency: "EUR" }`. 1 000 XOF is
 * `{ minor: 1000, currency: "XOF" }` — the franc CFA has no subdivision in practice, so
 * its minor unit IS the franc.
 *
 * ## Two rules that are not negotiable here
 *
 * **No conversion, ever.** This module has no exchange rates and must never acquire any.
 * Comparing amounts in different currencies returns a refusal, not a converted number.
 * A policy ceiling in EUR cannot judge an amount in XOF; the honest answer is that the
 * configuration is wrong.
 *
 * **No silent rounding.** An amount carrying more precision than its currency allows —
 * `1000,50 XOF`, or `10,005 EUR` — is REFUSED rather than rounded. Rounding would decide,
 * silently, whether an action sits above or below its ceiling. An operator who meant a
 * half-franc has a configuration error, and being told so is the only safe answer.
 */

/** ISO 4217 code of a currency this deployment understands. */
export type CurrencyCode = "EUR" | "USD" | "XOF" | "XAF";

interface CurrencyDefinition {
  /** Digits after the decimal separator. 0 for the franc CFA, 2 for EUR and USD. */
  readonly exponent: 0 | 2;
  /** French label, used in operator-facing text. */
  readonly label: string;
  /** BCP 47 locale whose conventions suit this currency's usual audience. */
  readonly locale: string;
}

/**
 * The registry. Adding a currency is adding one entry here — the type, the validator,
 * the formatter and the API schemas are all derived from it, so there is no second list
 * to forget.
 *
 * XOF (franc CFA BCEAO — UEMOA: Bénin, Burkina Faso, Côte d'Ivoire, Guinée-Bissau, Mali,
 * Niger, Sénégal, Togo) and XAF (franc CFA BEAC — CEMAC: Cameroun, Centrafrique, Congo,
 * Gabon, Guinée équatoriale, Tchad) are DISTINCT currencies with separate issuers. They
 * are not interchangeable and this module never treats them as such, even though both are
 * pegged to the euro at 655,957.
 */
export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyDefinition>> = {
  EUR: { exponent: 2, label: "euro", locale: "fr-FR" },
  USD: { exponent: 2, label: "US dollar", locale: "en-US" },
  XOF: { exponent: 0, label: "CFA franc (BCEAO)", locale: "fr-SN" },
  XAF: { exponent: 0, label: "CFA franc (BEAC)", locale: "fr-CM" },
};

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = Object.keys(
  CURRENCIES,
) as readonly CurrencyCode[];

/** The currency a deployment falls back to when a tenant has not declared one. */
export const DEFAULT_CURRENCY: CurrencyCode = "EUR";

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

/**
 * Normalises a declared currency, or returns null.
 *
 * Null means "not a currency this deployment understands", and every caller must treat it
 * as a refusal rather than substituting a default. The distinction between "absent" and
 * "unknown" belongs to the caller: absent may legitimately mean "use the tenant's
 * currency", whereas `"EURO"` or `"CFA"` is a mistake that must surface.
 */
export function parseCurrency(raw: unknown): CurrencyCode | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return isCurrencyCode(code) ? code : null;
}

/** Digits after the decimal separator for this currency. */
export function exponentOf(currency: CurrencyCode): 0 | 2 {
  return CURRENCIES[currency].exponent;
}

/** An amount of money. `minor` is an integer count of the currency's smallest unit. */
export interface Money {
  readonly minor: number;
  readonly currency: CurrencyCode;
}

/**
 * The largest amount this module will accept, in minor units.
 *
 * `Number.MAX_SAFE_INTEGER` is 9,007,199,254,740,991. Every value below this limit adds
 * and compares exactly as an integer, which is the whole point of the representation.
 * The limit is deliberately well under it so that a sum of several amounts — a daily
 * spend projection, for instance — cannot reach the unsafe range either.
 *
 * In practice this is about 90 000 milliards de francs CFA, which is several times the
 * GDP of the whole franc zone, so the ceiling constrains nothing real. It exists to make
 * overflow impossible rather than unlikely.
 */
export const MAX_MINOR_UNITS = 1e15;

export type MoneyError =
  | { kind: "unknown_currency"; declared: string }
  | { kind: "not_a_number"; value: unknown }
  | { kind: "too_precise"; value: number; currency: CurrencyCode; allowedDecimals: 0 | 2 }
  | { kind: "out_of_range"; value: number; currency: CurrencyCode }
  | { kind: "negative"; value: number };

export type MoneyResult = { ok: true; money: Money } | { ok: false; error: MoneyError };

/**
 * Builds a `Money` from a decimal amount as a client would send it (`10.5`, `1000`).
 *
 * The scaling is done on a rounded product, not by truncation: `10.5 * 100` is
 * 1050.0000000000001 in IEEE 754, and truncating that yields 1050 by luck and 1049 for
 * some other value. `Math.round` on the product is exact for every decimal with at most
 * `exponent` digits, and anything with more digits is rejected below rather than rounded,
 * so no silent precision loss is possible on this path.
 */
export function moneyFromDecimal(value: unknown, currency: CurrencyCode): MoneyResult {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: { kind: "not_a_number", value } };
  }
  if (value < 0) return { ok: false, error: { kind: "negative", value } };

  const exponent = exponentOf(currency);
  const scale = exponent === 0 ? 1 : 100;
  const scaled = Math.round(value * scale);

  /*
   * Refused, not rounded. `Math.abs` guards against a representation whose scaled value
   * lands just under rather than just over. The tolerance is far tighter than one minor
   * unit and far looser than IEEE 754 noise on realistic magnitudes.
   */
  if (Math.abs(value * scale - scaled) > 1e-6) {
    return {
      ok: false,
      error: { kind: "too_precise", value, currency, allowedDecimals: exponent },
    };
  }
  if (scaled > MAX_MINOR_UNITS) {
    return { ok: false, error: { kind: "out_of_range", value, currency } };
  }
  return { ok: true, money: { minor: scaled, currency } };
}

/** Builds a `Money` directly from minor units, which must already be a whole number. */
export function moneyFromMinor(minor: number, currency: CurrencyCode): MoneyResult {
  if (!Number.isInteger(minor)) {
    return { ok: false, error: { kind: "too_precise", value: minor, currency, allowedDecimals: exponentOf(currency) } };
  }
  if (minor < 0) return { ok: false, error: { kind: "negative", value: minor } };
  if (minor > MAX_MINOR_UNITS) return { ok: false, error: { kind: "out_of_range", value: minor, currency } };
  return { ok: true, money: { minor, currency } };
}

/**
 * The decimal value, for display and for an API response.
 *
 * Never use the result in a comparison or a sum — that is what `minor` is for. This
 * exists because clients and humans read `10,50`, not `1050`.
 */
export function toDecimal(money: Money): number {
  const exponent = exponentOf(money.currency);
  return exponent === 0 ? money.minor : money.minor / 100;
}

/** True when both amounts are in the same currency, so they may be compared at all. */
export function sameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}

/**
 * Compares two amounts: negative, zero or positive, exactly as integers.
 *
 * Throws on a currency mismatch rather than returning a number, because every ordering
 * answer would be a lie and a caller that forgot to check must not get a plausible one.
 * Callers that can legitimately receive mixed currencies check `sameCurrency` first and
 * turn the mismatch into a refusal the operator can read.
 */
export function compareMoney(a: Money, b: Money): number {
  if (!sameCurrency(a, b)) {
    throw new Error(
      `refusing to compare ${a.currency} with ${b.currency}: Oathrion holds no exchange rates and ` +
        `must not invent an ordering between two currencies.`,
    );
  }
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
}

/** Adds two amounts of the same currency. Throws on a mismatch, as `compareMoney` does. */
export function addMoney(a: Money, b: Money): Money {
  if (!sameCurrency(a, b)) {
    throw new Error(
      `refusing to add ${a.currency} to ${b.currency}: Oathrion holds no exchange rates.`,
    );
  }
  return { minor: a.minor + b.minor, currency: a.currency };
}

const FORMATTERS = new Map<CurrencyCode, Intl.NumberFormat>();

/**
 * Formats an amount for a decision reason, an audit entry or the console.
 *
 * `Intl` emits narrow no-break spaces (U+202F) and no-break spaces (U+00A0) as group and
 * currency separators, and which one it picks varies with the ICU version. Audit text
 * must be stable, searchable and diffable across runtimes, so every space is normalised
 * to a plain one — a property `formatAmount` already had and which is kept here.
 *
 * The fraction digits come from the registry, so a franc CFA never renders as `1 000,00`
 * and a euro never loses its centimes. The previous implementation hard-coded
 * `maximumFractionDigits: 0` for every currency, which silently dropped EUR cents from
 * every reason string it produced.
 */
export function formatMoney(money: Money): string {
  let formatter = FORMATTERS.get(money.currency);
  if (!formatter) {
    const { exponent, locale } = CURRENCIES[money.currency];
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: money.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    });
    FORMATTERS.set(money.currency, formatter);
  }
  return formatter.format(toDecimal(money)).replace(/[\u202f\u00a0\u2009]/g, " ");
}

/** An explanation of a money error, for an operator or an API response. */
export function describeMoneyError(error: MoneyError): string {
  switch (error.kind) {
    case "unknown_currency":
      return (
        `The currency "${error.declared}" is not supported. ` +
        `Accepted currencies: ${SUPPORTED_CURRENCIES.join(", ")}.`
      );
    case "not_a_number":
      return "The amount must be a number.";
    case "too_precise":
      return error.allowedDecimals === 0
        ? `The ${CURRENCIES[error.currency].label} has no subdivision: the amount ${error.value} ` +
            `must be a whole number. The amount is refused rather than rounded.`
        : `The amount ${error.value} has more than ${error.allowedDecimals} decimals, ` +
            `which the ${CURRENCIES[error.currency].label} does not allow. ` +
            `The amount is refused rather than rounded.`;
    case "out_of_range":
      return `The amount ${error.value} ${error.currency} exceeds the limit this system handles.`;
    case "negative":
      return `A negative amount (${error.value}) is not a spend and is refused.`;
  }
}
