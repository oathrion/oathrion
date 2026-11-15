/**
 * Migration 15 — each organization declares its own currency (Phase 12.3).
 *
 * ## The defect this closes
 *
 * The currency was a module constant: `ORG_CURRENCY = "EUR"` in
 * `shared/policy/matchers.ts`. Every mandate ceiling, every policy threshold and every
 * daily-spend budget in the whole deployment was denominated in it, and an action
 * declaring anything else was refused.
 *
 * For a single-tenant pilot in the euro zone that was adequate and honest. For a
 * multi-tenant B2B service whose stated market is francophone Africa it is a hard
 * blocker: one Oathrion instance cannot serve a tenant invoicing in francs CFA and a tenant
 * invoicing in euros, because the unit of account belongs to the *deployment* rather
 * than to the tenant. Serving both meant running two deployments, which is not a SaaS.
 *
 * So the unit of account moves to where the tenant is: this column.
 *
 * ## Why the backfill is EUR and why that is not a guess
 *
 * Every row that exists when this migration runs was created under the old constant, so
 * its amounts are already denominated in EUR. Writing EUR is recording what those amounts
 * have always meant, not choosing a default for them. A new organization declares its
 * currency at creation.
 *
 * The column is `NOT NULL` with that default for the same reason the rest of this schema
 * avoids nullable discriminators: a null currency would have to be resolved somewhere at
 * read time, and "somewhere" is where a silent fallback to EUR would reappear — the exact
 * behaviour this migration exists to remove.
 *
 * ## Why no CHECK constraint on the set of codes
 *
 * Tempting, and rejected. The supported set lives in `shared/money.ts`, and adding a
 * currency would then need a migration to widen a constraint — so the database and the
 * code could disagree about which currencies exist, with the database winning silently at
 * write time and the application unable to explain the refusal. Validation happens at the
 * boundary, in `parseCurrency`, which returns a refusal an operator can read. The column
 * stores what the application validated.
 *
 * ## Idempotency
 *
 * Guarded on the column's absence, so a second run emits nothing. Both dialects need the
 * same change, so unlike migrations 11 and 14 there is no dialect branch — `TEXT` is the
 * right type on SQLite and on PostgreSQL alike for a three-letter ISO 4217 code.
 */

import type { Migration, SchemaInspect } from "./types";

export const ORGANIZATIONS_TABLE = "organizations";
export const ORGANIZATION_CURRENCY_COLUMN = "currency";

export const organizationCurrency: Migration = {
  version: 15,
  name: "organization-currency",
  statements(schema: SchemaInspect): string[] {
    if (!schema.tableExists(ORGANIZATIONS_TABLE)) return [];
    if (schema.columns(ORGANIZATIONS_TABLE).has(ORGANIZATION_CURRENCY_COLUMN)) return [];

    /*
     * The default does double duty: it backfills existing rows in the same statement
     * (both engines apply it to the rows already present) and it keeps the column
     * writable by any code path that has not been taught about currency yet. Removing
     * the default later would be a separate, deliberate migration.
     */
    return [
      `ALTER TABLE ${ORGANIZATIONS_TABLE} ` +
        `ADD COLUMN ${ORGANIZATION_CURRENCY_COLUMN} TEXT NOT NULL DEFAULT 'EUR'`,
    ];
  },
};
