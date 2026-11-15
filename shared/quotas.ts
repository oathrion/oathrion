/**
 * Per-organization resource quotas — the vocabulary and the arithmetic.
 *
 * WHY THIS FILE IS SEPARATE FROM THE ENFORCEMENT (P3)
 * --------------------------------------------------
 * Everything here is pure: no database, no `process.env` read at import time, no
 * Express. `server/limits.ts` holds the half that touches the database and throws.
 * The split is not tidiness — it is what lets the period arithmetic and the operator
 * override parser be tested exhaustively over hostile input (a leap-year February, a
 * December roll-over, `agents=-1`, an unknown counter name) without a schema, and it
 * keeps a limit that must be identical on SQLite and PostgreSQL in a single place
 * neither driver owns.
 *
 * WHAT A QUOTA IS, AND WHAT IT IS NOT
 * -----------------------------------
 * This is NOT the rate limiter. `server/rate-limit/` bounds requests per minute per
 * *credential*: it answers "you are going too fast". A quota bounds how much a
 * *tenant* may accumulate: it answers "your plan holds 500 agents and you have 500".
 * They are deliberately independent dimensions, and conflating them would break both
 * — an organization at its agent ceiling must still be able to read, and a credential
 * hammering the decision endpoint must still be slowed down even when the tenant is
 * far below every quota.
 *
 * The two therefore keep different keys, different stores, different windows and
 * different refusal codes. A caller can distinguish them without parsing prose:
 * `rate_limited` versus `quota_exceeded`.
 */

/**
 * The counters Oathrion meters, and the kind of ceiling each one has.
 *
 * `count` counters bound how many rows may exist at once. They fall as soon as
 * something is removed and have no reset instant — telling a caller to "retry after"
 * a ceiling on live rows would be a lie, because waiting changes nothing.
 *
 * `period` counters bound how many events may be recorded inside a calendar window.
 * They only ever rise until the window turns over, so they do have an honest reset
 * instant, and it is reported.
 */
export const QUOTA_COUNTERS = {
  agents: "count",
  policies: "count",
  executions: "period",
} as const;

export type QuotaCounter = keyof typeof QUOTA_COUNTERS;
export type QuotaKind = (typeof QUOTA_COUNTERS)[QuotaCounter];

/** Every metered counter, in a stable order for documentation and API responses. */
export const QUOTA_COUNTER_NAMES = Object.keys(QUOTA_COUNTERS) as readonly QuotaCounter[];

export function isQuotaCounter(value: unknown): value is QuotaCounter {
  return typeof value === "string" && Object.hasOwn(QUOTA_COUNTERS, value);
}

export function quotaKind(counter: QuotaCounter): QuotaKind {
  return QUOTA_COUNTERS[counter];
}

/**
 * Human-readable names for the refusal message and the console.
 *
 * In the message the caller reads, not only in a log: a refusal that says
 * `counter "executions"` makes the reader map an internal identifier to their own
 * mental model before they can act.
 */
export const QUOTA_LABELS: Readonly<Record<QuotaCounter, string>> = {
  agents: "registered agents",
  policies: "policies",
  executions: "executions this month",
};

/**
 * Defaults, and why they are this high.
 *
 * The roadmap's own stated risk for this phase is that a mis-calibrated quota
 * interrupts a legitimate customer, and nobody has yet run Oathrion at customer scale, so
 * there is no measurement to calibrate against. Picking a number that feels
 * reasonable and enforcing it would be guessing with someone else's production
 * traffic. These are therefore set an order of magnitude above anything the largest
 * simulated workload in this repository produces — `script/pilot-sim.ts` generates
 * 5 760 executions for ninety days of one company's traffic, i.e. roughly 1 900 a
 * month, against a ceiling of 100 000 — so on any existing deployment the quota is
 * inert, while the mechanism, its counters and its refusal path are real, tested and
 * ready to be lowered per organization once there is data.
 *
 * The alternative — ship the counters in observe mode and enforce later — is
 * available and is `OATHRION_QUOTA_MODE=observe`. It is not the default, because a
 * ceiling that is recorded but not applied protects nothing: the runaway integration
 * that writes ten million executions still writes them.
 */
export const DEFAULT_QUOTAS: Readonly<Record<QuotaCounter, number>> = {
  agents: 500,
  policies: 500,
  executions: 100_000,
};

/** How a quota decision behaves when the ceiling is reached. */
export type QuotaMode = "enforce" | "observe";

/**
 * The `period_start` recorded for a `count` counter.
 *
 * A literal word rather than an empty string or a null: this value ends up in a
 * composite primary key and in database dumps an operator reads during an incident.
 * `""` would be indistinguishable from a bug that failed to compute a period, and a
 * nullable column cannot be part of a primary key on either engine.
 */
export const LIFETIME_PERIOD = "lifetime";

/**
 * Start of the UTC calendar month containing `at`, as an ISO-8601 instant.
 *
 * UTC and not the server's local zone. A period boundary that moved with
 * `process.env.TZ` would mean two replicas of the same deployment disagreeing about
 * which month a write belongs to — so the same execution would be counted twice, or
 * not at all, depending on which instance served it.
 *
 * A calendar month and not a rolling 30-day window: the ceiling is a commercial
 * quantity an operator has to be able to explain to a customer, and "your month
 * resets on the 1st" is explainable where "your window is the trailing 30 days from
 * whenever you happened to start" is not.
 */
export function periodStartFor(counter: QuotaCounter, at: Date = new Date()): string {
  if (QUOTA_COUNTERS[counter] === "count") return LIFETIME_PERIOD;
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

/**
 * The instant a `period` counter resets, or `null` for a `count` counter.
 *
 * Built from `Date.UTC` with a month index that is allowed to reach 12 — the
 * constructor normalises it to January of the following year, so the December
 * roll-over needs no special case and cannot be got wrong by one.
 */
export function periodResetFor(counter: QuotaCounter, at: Date = new Date()): string | null {
  if (QUOTA_COUNTERS[counter] === "count") return null;
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
}

/** A resolved set of ceilings for one organization. */
export type QuotaLimits = Readonly<Record<QuotaCounter, number>>;

/** Parsed operator overrides: ceilings for `default` and per organization id. */
export interface QuotaOverrides {
  default: Partial<Record<QuotaCounter, number>>;
  byOrganization: Record<string, Partial<Record<QuotaCounter, number>>>;
}

export class InvalidQuotaOverride extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuotaOverride";
  }
}

/**
 * The one rule for what a ceiling may be, whoever writes it.
 *
 * `OATHRION_QUOTAS` (parsed above) and the per-tenant rows in the database (written by
 * `server/quotas.ts`) both go through this function, so "a valid ceiling" cannot come to
 * mean two different things on the two paths — the weaker of two definitions would be
 * the one an operator happened to use. Returns the reason, or `null` when valid.
 *
 * It takes `unknown` because the database path receives values that were never strings:
 * a JSON body can carry `1.5`, `-1`, `"10"` or `1e20`, and each is refused here rather
 * than coerced. The string-shape checks (`5O`, `1e3`, whitespace) stay in the parser,
 * because they are about how a value is SPELLED in an environment variable.
 */
export function quotaCeilingProblem(counter: unknown, ceiling: unknown): string | null {
  if (!isQuotaCounter(counter)) {
    return (
      `"${String(counter)}" is not a counter Oathrion meters. ` +
      `Known counters: ${QUOTA_COUNTER_NAMES.join(", ")}.`
    );
  }
  if (typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling < 0) {
    return (
      `the ceiling for "${counter}" is ${JSON.stringify(ceiling) ?? String(ceiling)}, which is not a ` +
      `non-negative whole number. A quota is a count of things, so decimals, signs and ` +
      `non-numbers are refused rather than rounded.`
    );
  }
  if (!Number.isSafeInteger(ceiling)) {
    return `the ceiling for "${counter}" is ${ceiling}, which is too large to compare exactly.`;
  }
  return null;
}

export const EMPTY_QUOTA_OVERRIDES: QuotaOverrides = { default: {}, byOrganization: {} };

/**
 * Parses `OATHRION_QUOTAS`.
 *
 * Format: comma-separated `scope:counter=value`, where `scope` is either the word
 * `default` or an organization id.
 *
 *   OATHRION_QUOTAS="default:agents=50,org_acme_corp:executions=1000000"
 *
 * WHY THE ENVIRONMENT AND NOT AN ADMIN ROUTE
 * ------------------------------------------
 * There is deliberately no endpoint for raising a quota. The only roles that could
 * plausibly be allowed to call it are roles that belong to the tenant being limited,
 * and a ceiling its own admin can lift is not a ceiling. Quotas are a commercial
 * decision made by whoever operates the deployment, so they enter the same way every
 * other operator decision does: an environment variable, read at boot, reported at
 * boot, and outside every tenant's reach.
 *
 * Every malformed entry throws rather than being skipped. A typo in a quota is
 * exactly the kind of mistake that must not degrade quietly: `agents=5O` with a
 * letter O, ignored, leaves the deployment on a default of 500 while its operator
 * believes they configured 50.
 */
export function parseQuotaOverrides(raw: string | undefined): QuotaOverrides {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return { default: {}, byOrganization: {} };

  const parsed: QuotaOverrides = { default: {}, byOrganization: {} };

  for (const rawEntry of trimmed.split(",")) {
    const entry = rawEntry.trim();
    if (entry === "") continue;

    const colon = entry.indexOf(":");
    if (colon <= 0) {
      throw new InvalidQuotaOverride(
        `OATHRION_QUOTAS entry "${entry}" is missing a scope. Expected "default:counter=value" or ` +
          `"org_id:counter=value".`,
      );
    }
    const scope = entry.slice(0, colon).trim();
    const assignment = entry.slice(colon + 1);

    const equals = assignment.indexOf("=");
    if (equals <= 0) {
      throw new InvalidQuotaOverride(
        `OATHRION_QUOTAS entry "${entry}" is missing "=value". Expected "${scope}:counter=value".`,
      );
    }
    const counter = assignment.slice(0, equals).trim();
    const value = assignment.slice(equals + 1).trim();

    if (!isQuotaCounter(counter)) {
      throw new InvalidQuotaOverride(
        `OATHRION_QUOTAS entry "${entry}" names counter "${counter}", which Oathrion does not meter. ` +
          `Known counters: ${QUOTA_COUNTER_NAMES.join(", ")}.`,
      );
    }

    /*
     * `/^\d+$/` and not `Number()`. `Number("1e6")`, `Number(" 12 ")` and
     * `Number("0x10")` all succeed and none of them is what an operator writing a
     * customer's ceiling meant to type; `Number("")` is 0, which would silently
     * refuse every write in the organization.
     */
    if (!/^\d+$/.test(value)) {
      throw new InvalidQuotaOverride(
        `OATHRION_QUOTAS entry "${entry}" has value "${value}", which is not a non-negative whole ` +
          `number. A quota is a count of things, so decimals, signs and exponents are refused ` +
          `rather than rounded.`,
      );
    }

    const limit = Number(value);
    const problem = quotaCeilingProblem(counter, limit);
    if (problem !== null) {
      throw new InvalidQuotaOverride(`OATHRION_QUOTAS entry "${entry}": ${problem}`);
    }

    if (scope === "default") {
      parsed.default[counter] = limit;
      continue;
    }

    /*
     * The scope is NOT validated against `organizationId()` here, and that is
     * deliberate rather than an omission. This parser must be usable before any
     * database exists and must not import tenancy validation into a pure module; and
     * more importantly, an override naming an organization that does not exist is
     * harmless — it is never looked up. An override naming one that DOES exist but
     * is misspelled is caught by the boot report, which prints every override it
     * accepted, so an operator sees `org_acme_crop` in the log and fixes it.
     */
    (parsed.byOrganization[scope] ??= {})[counter] = limit;
  }

  return parsed;
}

/** The ceilings that apply to one organization: defaults, then default overrides, then its own. */
export function limitsFor(organization: string, overrides: QuotaOverrides): QuotaLimits {
  return {
    ...DEFAULT_QUOTAS,
    ...overrides.default,
    ...(overrides.byOrganization[organization] ?? {}),
  };
}

/** Renders the accepted overrides for the boot report. Empty string when there are none. */
export function describeQuotaOverrides(overrides: QuotaOverrides): string {
  const parts: string[] = [];
  for (const [counter, limit] of Object.entries(overrides.default)) {
    parts.push(`default:${counter}=${limit}`);
  }
  for (const [org, counters] of Object.entries(overrides.byOrganization)) {
    for (const [counter, limit] of Object.entries(counters)) {
      parts.push(`${org}:${counter}=${limit}`);
    }
  }
  return parts.join(", ");
}

/** The state of one counter for one organization, as reported by `GET /api/usage`. */
export interface QuotaUsage {
  counter: QuotaCounter;
  label: string;
  kind: QuotaKind;
  /** Rows or events currently counted. Exact — read from the data, not from a cache. */
  used: number;
  limit: number;
  remaining: number;
  /** ISO-8601 instant the period counter resets, or `null` for a count counter. */
  resetAt: string | null;
  /** Requests this organization has had refused for this counter in the current period. */
  refusals: number;
}
