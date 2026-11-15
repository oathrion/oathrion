/**
 * Tenancy primitives.
 *
 * One rule, and it is the reason this file exists: **every row that belongs to a
 * customer carries an `organizationId`, and every query that reads or writes such
 * a row is filtered by it.** The filter is applied in the repository layer, not by
 * callers, because a rule that each caller has to remember is a rule that will be
 * forgotten exactly once — and once is enough for one customer to read another's
 * data.
 *
 * `OrganizationId` is a branded type. That is not decoration: it means a bare
 * `string` cannot be passed where an organization is expected, so a caller cannot
 * accidentally scope a query by an agent id, a user id, or a name. The only way to
 * produce one is `organizationId()`, which validates the format.
 */

import type { CurrencyCode } from "./money";

declare const ORGANIZATION_ID: unique symbol;

/** An organization (tenant) identifier. Constructed only via `organizationId()`. */
export type OrganizationId = string & { readonly [ORGANIZATION_ID]: true };

/** `org_` followed by 3–48 characters of lowercase alphanumerics, `-` or `_`. */
const ORGANIZATION_ID_PATTERN = /^org_[a-z0-9][a-z0-9_-]{2,47}$/;

export class InvalidOrganizationId extends Error {
  constructor(value: unknown) {
    super(
      `"${String(value)}" is not a valid organization id. Expected "org_" followed by 3-48 ` +
        `characters (lowercase letters, digits, "-" or "_").`,
    );
    this.name = "InvalidOrganizationId";
  }
}

/**
 * Validates and brands an organization id.
 *
 * Throws rather than returning a fallback. A silently defaulted tenant scope is the
 * worst possible failure here: it would point a query at whichever organization the
 * fallback names, which is precisely a cross-tenant read.
 */
export function organizationId(value: unknown): OrganizationId {
  if (typeof value !== "string" || !ORGANIZATION_ID_PATTERN.test(value)) {
    throw new InvalidOrganizationId(value);
  }
  return value as OrganizationId;
}

/** Non-throwing variant, for validating untrusted input before deciding what to do. */
export function isOrganizationId(value: unknown): value is OrganizationId {
  return typeof value === "string" && ORGANIZATION_ID_PATTERN.test(value);
}

/**
 * The organization every pre-multi-tenant row is assigned to.
 *
 * An existing single-tenant deployment is not "no organization" — it is exactly one
 * organization, and saying so is what lets the same code serve both cases without a
 * nullable column and without a "global" scope that bypasses filtering.
 */
export const DEFAULT_ORGANIZATION_ID = "org_default" as OrganizationId;

/**
 * The lookup key for an organization's name: the name, lowercased and trimmed.
 *
 * ## Why this function exists at all
 *
 * Until migration 18 the identifier WAS the name, slugged (`"Acme Corp"` →
 * `org_acme_corp`). That made "the same name at the next boot finds the same tenant"
 * free, and it made three other things true, all of them defects: the identifier
 * leaked the customer's name into every log line, audit row and receipt; two similar
 * company names collided after slugging and truncation, turning a primary-key error
 * into a cross-tenant existence oracle; and a legal rename could never be reflected,
 * since an organization is never renamed.
 *
 * Identifiers are now opaque and random (`newOrganizationId`, in
 * `server/repositories/organizations.ts` — the only place allowed to make one). The
 * idempotence that the slug used to provide for free now comes from a lookup on this
 * key, backed by a UNIQUE index (migration 18).
 *
 * ## Why the normalisation is this small
 *
 * Lowercase and trim, and deliberately NOT a collapse of internal whitespace, because
 * the identical rule has to be applied by the SQL backfill of migration 18 — `lower`
 * and `trim` exist on both engines, `regexp_replace` does not. Two definitions of "the
 * same name" that could drift apart would be worse than this one's bluntness: `"Acme
 * Corp"` and `"Acme  Corp"` (two spaces) are two different organizations. Stated in
 * `docs/limitations.md`.
 *
 * It is NOT a validator: emptiness and length are refused by the store, where the
 * error can name the call that was refused.
 */
export function organizationNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The longest name an organization may carry.
 *
 * Not a style preference: `name_key` is indexed, and PostgreSQL's btree refuses an
 * entry beyond roughly 2700 bytes. Without a bound here, a long name would be accepted
 * by the application and then rejected by the engine, with an error naming an index
 * instead of the call. 200 characters is far below the limit and far above any real
 * legal name.
 */
export const MAX_ORGANIZATION_NAME_LENGTH = 200;

/**
 * The one rule for what an organization name may be, whoever writes it. Returns the
 * reason, or `null` when valid.
 *
 * Takes `unknown` because the callers are an environment variable
 * (`OATHRION_CONSOLE_USERS`), a command-line argument (`bootstrap:admin`) and, later, a
 * JSON body: none of them is guaranteed to hand over a string. Same shape as
 * `quotaCeilingProblem` in `shared/quotas.ts`, for the same reason — one definition,
 * so the weaker of two cannot become the one an operator happens to reach.
 *
 * Emptiness is refused rather than defaulted. A name that normalises to nothing would
 * take the `name_key` value `''`, which is a real key: the next nameless organization
 * would silently resolve to the first one, i.e. one tenant handed another's scope.
 */
export function organizationNameProblem(name: unknown): string | null {
  if (typeof name !== "string") {
    return `an organization name must be a string, not ${typeof name}.`;
  }
  if (organizationNameKey(name) === "") {
    return (
      `an organization name cannot be empty or whitespace only. It is the key a tenant is ` +
      `found by when a deployment restarts, so an empty one would make two nameless ` +
      `organizations resolve to the same tenant.`
    );
  }
  if (name.length > MAX_ORGANIZATION_NAME_LENGTH) {
    return (
      `an organization name is limited to ${MAX_ORGANIZATION_NAME_LENGTH} characters ` +
      `(this one has ${name.length}), because the normalised name is indexed.`
    );
  }
  return null;
}

/** An organization record. */
export interface Organization {
  id: OrganizationId;
  name: string;
  createdAt: string;
  /** `false` suspends every credential in the organization without deleting data. */
  active: boolean;
  /**
   * The tenant's unit of account (ISO 4217, from `shared/money.ts`).
   *
   * Every ceiling and budget belonging to this organization is denominated in it. An
   * action in another currency is refused, never converted. Declared per tenant since
   * migration 15; before that a single deployment-wide constant made it impossible to
   * serve a franc CFA tenant and a euro tenant from one instance.
   */
  currency: CurrencyCode;
}
