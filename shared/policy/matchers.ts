/**
 * Small, dependency-free helpers used by the rule evaluators.
 *
 * Three invariants govern this file:
 *
 *  1. **Deny broadly, allow narrowly.** Target matching for BLOCK and
 *     APPROVAL_REQUIRED inspects every segment of the target, so
 *     `postgres://prod/production_database` is caught by a rule written against
 *     `production_database`. ALLOW keeps strict equality: widening a deny-list
 *     is safe, widening an allow-list is not.
 *  2. **A host is parsed, not pattern-matched.** `https://evil.com/checkout`
 *     and `evil.com.` both resolve to the host `evil.com`.
 *  3. **Money carries a currency.** Two amounts are only comparable when they
 *     are denominated in the same currency, and the currency belongs to the
 *     tenant — see `EvaluationContext.orgCurrency` and `shared/money.ts`.
 */

import { formatMoney, moneyFromDecimal, parseCurrency, type CurrencyCode } from "../money";

/*
 * `ORG_CURRENCY` used to live here: one constant, `"EUR"`, for the whole deployment.
 * It was removed in Phase 12.3 because a single instance has to serve a tenant in the
 * franc CFA zone and a tenant in the euro zone, which a module constant cannot express.
 * The unit of account is now a column on `organizations` (migration 15) and reaches the
 * engine as `EvaluationContext.orgCurrency`.
 *
 * `SUPPORTED_CURRENCIES` was also declared here, as a second list beside the one in the
 * registry. It is re-exported from `shared/money.ts` so that adding a currency is a
 * single edit.
 */
export { SUPPORTED_CURRENCIES } from "../money";

/** Normalises `Production Database`, `production-database` and `production_database` to one token. */
export function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Glob match supporting `*` as a multi-character wildcard.
 * Comparison is case-insensitive and separator-insensitive.
 */
export function matchesPattern(value: string, pattern: string): boolean {
  const v = normalizeToken(value);
  const p = normalizeToken(pattern);
  if (p === "*") return true;
  if (!p.includes("*")) return v === p;
  return compilePattern(p).test(v);
}

/**
 * Compiled-pattern cache.
 *
 * Every decision walks every enabled policy, and each rule may hold several
 * patterns, so `matchesPattern` is one of the hottest functions in the engine.
 * It used to recompile a `RegExp` from scratch on every single call — pure waste
 * on a path that runs before every agent action. Patterns come from policies, so
 * the key space is bounded by the policy set; the cap below is belt-and-braces.
 */
const PATTERN_CACHE = new Map<string, RegExp>();
const PATTERN_CACHE_MAX = 1_000;

function compilePattern(normalized: string): RegExp {
  const cached = PATTERN_CACHE.get(normalized);
  if (cached) return cached;

  // Only `*` is a wildcard; every other regex metacharacter is escaped, so a
  // policy author cannot inject a pattern that backtracks pathologically.
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const compiled = new RegExp(`^${escaped}$`);

  if (PATTERN_CACHE.size >= PATTERN_CACHE_MAX) PATTERN_CACHE.clear();
  PATTERN_CACHE.set(normalized, compiled);
  return compiled;
}

/** True when `value` matches any pattern. An empty/undefined pattern list means "no constraint". */
export function matchesAny(value: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => matchesPattern(value, p));
}

/** True only when an explicit, non-empty pattern list matches exactly. Used by ALLOW rules. */
export function matchesExplicit(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((p) => matchesPattern(value, p));
}

/* ------------------------------ Target matching ----------------------------- */

/**
 * Splits a target into the pieces a rule may legitimately name.
 *
 * `postgres://prod/production_database` → `postgres`, `prod`,
 * `production_database` (plus the whole string). Segments are compared whole,
 * never as substrings, so `production_database2` does **not** match a rule
 * written against `production_database`.
 */
export function targetSegments(target: string): string[] {
  const whole = target.trim();
  const parts = whole
    .split(/[/:@?#\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== "*");
  return [whole, ...parts];
}

/**
 * Deny-side target matching: a rule matches if its pattern matches the whole
 * target or any one of its segments. Deliberately broader than
 * `matchesExplicit` — see invariant 1 at the top of this file.
 */
export function matchesTargetForDeny(target: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const candidates = targetSegments(target);
  return patterns.some((pattern) => candidates.some((c) => matchesPattern(c, pattern)));
}

/* ------------------------------- Host matching ------------------------------ */

/**
 * Extracts the host from an action target.
 *
 * Handles bare hosts (`evil.com`), absolute URLs (`https://evil.com/checkout`),
 * scheme-relative URLs (`//evil.com/x`), userinfo (`user@evil.com`), ports and
 * the root-label trailing dot (`evil.com.`). Returns `null` when the target
 * cannot be read as a host — which callers must treat as "cannot verify",
 * never as "permitted".
 */
export function extractHost(target: string): string | null {
  const raw = target.trim();
  if (raw.length === 0) return null;

  let candidate = raw;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) || candidate.startsWith("//")) {
    try {
      const url = new URL(candidate.startsWith("//") ? `https:${candidate}` : candidate);
      candidate = url.hostname;
    } catch {
      return null;
    }
  } else {
    // Bare host, possibly with userinfo, port or a path glued on.
    candidate = candidate.split(/[/?#]/, 1)[0] ?? "";
    const at = candidate.lastIndexOf("@");
    if (at !== -1) candidate = candidate.slice(at + 1);
    const colon = candidate.lastIndexOf(":");
    if (colon !== -1) candidate = candidate.slice(0, colon);
  }

  let host = candidate.trim().toLowerCase();
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0) return null;

  // A host is labels joined by dots, with a non-numeric TLD of 2+ characters.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return null;
  }
  if (!/\.[a-z]{2,}$/.test(host)) return null;

  return host;
}

/**
 * True when `host` is the allowlisted domain or a subdomain of it.
 * `*` and leading `*.` wildcards are honoured; nothing else is interpreted.
 */
export function matchesDomain(host: string, allowed: string): boolean {
  const pattern = allowed.trim().toLowerCase().replace(/\.+$/, "");
  if (pattern === "*") return true;

  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === pattern || host.endsWith(`.${pattern}`);
}

/* ---------------------------------- Money ----------------------------------- */

/**
 * Reads a numeric field out of an untyped metadata bag. Returns `null` when
 * absent, not finite, or negative.
 *
 * Every caller of this function evaluates a financial ceiling (a transaction
 * cap, a daily budget, the mandate's autonomous spending limit) — there is no
 * non-money usage anywhere in the engine. A negative value satisfies any
 * `<= max` comparison by construction, so `amountAtMost` and the mandate's own
 * ceiling check both silently returned ALLOW for `amount: -50000`, and
 * `dailySpendAtMost` would fold a negative "cost" into the running total,
 * eroding a future, legitimate purchase's budget. None of the three simulated
 * tools (`purchase_tool`, `send_email_tool`, `database_tool`) define a
 * legitimate negative-amount action — there is no refund/credit tool in this
 * system — so a negative amount is refused the same way `NaN` already is:
 * treated as if the field were absent, which every caller already handles as
 * "cannot be checked" (fail-closed, not silently permitted).
 */
export function readNumber(
  metadata: Record<string, unknown>,
  field: string,
): number | null {
  const raw = metadata[field];
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw.replace(/[$€,\s]/g, ""));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/**
 * Reads the currency an action declares.
 *
 * - a supported code → that currency
 * - absent → `null`, meaning "not declared"; the caller evaluates in `ORG_CURRENCY`
 * - present but unrecognised → `"INVALID"`, which callers must refuse
 */
export function readCurrency(
  metadata: Record<string, unknown>,
): CurrencyCode | null | "INVALID" {
  const raw = metadata.currency;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return "INVALID";
  return parseCurrency(raw) ?? "INVALID";
}

/**
 * Formats money for a decision reason, an audit entry or the console.
 *
 * **The currency is required.** It used to default to the deployment-wide `ORG_CURRENCY`,
 * which meant a franc CFA amount passed to a caller that omitted the argument was
 * rendered with a euro sign \u2014 a financial control displaying the wrong unit. There is no
 * safe default here, so there is none.
 *
 * Delegates to `formatMoney`, which takes the fraction digits from the currency registry.
 * The formatters this function used to hold were pinned at `maximumFractionDigits: 0` for
 * every currency, so every euro amount silently lost its centimes on the way into an
 * audit entry.
 *
 * A value that is not a representable amount in `currency` is rendered as the raw number
 * followed by the code, rather than throwing: this is a display helper on a path that is
 * often already reporting a refusal, and a formatter that throws would replace a readable
 * explanation with a stack trace. The refusal itself is decided in `rules.ts`, which
 * validates the amount properly.
 */
export function formatAmount(value: number, currency: CurrencyCode): string {
  const built = moneyFromDecimal(value, currency);
  return built.ok ? formatMoney(built.money) : `${value} ${currency}`;
}
