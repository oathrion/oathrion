/**
 * Migration 17 — a tenant's quota ceilings become rows, not an environment variable.
 *
 * Until now a per-organization ceiling lived in `OATHRION_QUOTAS` (`org_x:agents=…`), parsed
 * once per process. Changing one customer's ceiling meant editing the deployment's
 * environment and restarting every replica: configuration of ONE tenant was a property
 * of the whole deployment. This table holds those values per organization; the
 * deployment-wide `default:` entries deliberately stay in the environment, since they
 * describe the deployment and not a tenant.
 *
 * ## Shape
 *
 * One row per (organization, counter), keyed in that order, so the read on the hot
 * path — "every ceiling of this tenant", once per guarded write — is a primary-key
 * prefix scan and needs no secondary index. A row is absent rather than NULL when a
 * tenant has no ceiling of its own for a counter: absence means "inherit", and a
 * nullable column would add a third state nobody could interpret.
 *
 * ## Why CHECK constraints, when the application already validates
 *
 * `quotaCeilingProblem` (shared/quotas.ts) refuses bad values before they are written.
 * The constraints are the second line, for the writes that do not go through the
 * application — a manual fix in psql, a restore, a future script. A negative ceiling
 * or an unknown counter that reached this table could only surface later, at read
 * time, as a tenant whose every write fails; refusing it at INSERT puts the error in
 * front of the person who typed it. The counter list is copied here as a literal on
 * purpose: a migration is a frozen snapshot, and adding a counter later is a new
 * migration that widens the constraint, not an edit of this one.
 *
 * `source` records where a value came from (`environment` = imported from
 * OATHRION_QUOTAS at boot, `api` = written by the application). It is what makes the boot
 * conflict message actionable: "the database says 99, set through the API; the
 * environment says 12".
 *
 * No foreign key to `organizations`, matching every other tenant-scoped table: an
 * `OATHRION_QUOTAS` entry may name an organization that does not exist yet (documented as
 * harmless since P3), and its import must not fail the boot for that.
 *
 * Append-only: no earlier migration is touched.
 */

import type { Migration, SchemaInspect } from "./types";

export const ORGANIZATION_QUOTAS_TABLE = "organization_quotas";

const COUNTERS = "('agents', 'policies', 'executions')";
const SOURCES = "('environment', 'api')";

export const organizationQuotas: Migration = {
  version: 17,
  name: "organization-quotas",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(ORGANIZATION_QUOTAS_TABLE)) return [];

    /*
     * BIGINT on PostgreSQL: a ceiling is any safe integer (up to 2^53 − 1), which an
     * INTEGER column would refuse above 2^31. SQLite's INTEGER is already 64-bit. Both
     * engines bound it at 2^53 − 1, the largest value JavaScript compares exactly. The
     * timestamp follows `organizations.created_at` (migration 3): text on SQLite,
     * timestamptz on PostgreSQL.
     */
    if (schema.dialect === "sqlite") {
      return [
        `CREATE TABLE IF NOT EXISTS ${ORGANIZATION_QUOTAS_TABLE} (
           organization_id TEXT NOT NULL,
           counter         TEXT NOT NULL CHECK (counter IN ${COUNTERS}),
           ceiling         INTEGER NOT NULL CHECK (ceiling >= 0 AND ceiling <= 9007199254740991),
           source          TEXT NOT NULL CHECK (source IN ${SOURCES}),
           updated_at      TEXT NOT NULL,
           PRIMARY KEY (organization_id, counter)
         )`,
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS ${ORGANIZATION_QUOTAS_TABLE} (
         organization_id TEXT NOT NULL,
         counter         TEXT NOT NULL CHECK (counter IN ${COUNTERS}),
         ceiling         BIGINT NOT NULL CHECK (ceiling >= 0 AND ceiling <= 9007199254740991),
         source          TEXT NOT NULL CHECK (source IN ${SOURCES}),
         updated_at      TIMESTAMPTZ NOT NULL,
         PRIMARY KEY (organization_id, counter)
       )`,
    ];
  },
};
