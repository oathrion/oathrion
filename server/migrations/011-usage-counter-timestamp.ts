/**
 * Migration 11 — `usage_counters.updated_at` becomes a real timestamptz on PostgreSQL (P7).
 *
 * ## The defect this closes, and how it was found
 *
 * Every other instant Oathrion stores on PostgreSQL is a `timestamptz`. That is not a
 * stylistic preference: `server/test/postgres.test.ts` pins it, with one documented
 * exception (`schema_migrations.applied_at`, whose reason is on `ledgerDdl`). The
 * pin exists so that a later "tidy-up" turning a timestamp back into text fails in a
 * test rather than in production, where a text column compares lexicographically and
 * silently answers range queries wrongly across timezone offsets and across the
 * boundary where `+00:00` and `Z` spell the same instant differently.
 *
 * `usage_counters.updated_at` was text. Migration 7 declared it `TEXT` for SQLite and
 * carried the same `text` into its PostgreSQL branch, while converting `observed_max`
 * and `refusals` to `BIGINT` — so the conversion was considered, and this column was
 * missed rather than decided. Nothing in migration 7's own comments claims it as
 * intentional: the deliberate text column in that table is `period_start`, and the
 * comment says exactly why (it holds either an ISO instant or the literal `lifetime`,
 * which no timestamp type can express). `updated_at` holds only an instant.
 *
 * It was never caught because the test that pins the rule skips when no PostgreSQL
 * server is reachable, and no run before this phase had one. It failed on the first
 * run against a real PostgreSQL 18.6 server.
 *
 * ## Why an ALTER and not an edit to migration 7
 *
 * Migration 7 is applied. Editing it would make the runner refuse every database that
 * already recorded it — `assertHistoryMatches` exists precisely to stop that — and
 * would leave any deployment that already migrated with a text column and a ledger
 * claiming otherwise. Append-only is the rule; this is the append.
 *
 * ## Why it is safe to run twice, and on either engine
 *
 * On PostgreSQL the statement casts `updated_at` to `timestamptz` with an explicit
 * `USING`. Casting a column that is *already* `timestamptz` to `timestamptz` is
 * accepted and rewrites nothing observable, so a re-run converges instead of failing —
 * the same convergence property migration 9 relies on. The cast is explicit rather
 * than implicit because PostgreSQL refuses an implicit text→timestamptz change, and an
 * implicit one would be the sort of statement that works on an empty table and fails
 * on a populated one.
 *
 * On SQLite this migration emits nothing. SQLite has no timestamp type: every instant
 * in this schema is TEXT there, so there is no drift to correct and an `ALTER` would
 * be a no-op at best. This makes the migration dialect-asymmetric, which is
 * deliberate and is exactly what `schema.dialect` is for — migration 6 is asymmetric
 * for a different reason and sets the precedent.
 *
 * ## What this migration does NOT claim
 *
 * No repository writes this table on PostgreSQL today, because the repositories are
 * still synchronous better-sqlite3 (see `server/database-config.ts`, which refuses to
 * boot on the postgres driver rather than imply otherwise). So this fixes a schema the
 * product does not yet write through. That is the point of fixing it now: the column
 * is corrected while the table is empty everywhere, rather than after a deployment has
 * put rows in it that a type change would have to rewrite under load.
 */

import type { Migration, SchemaInspect } from "./types";
import { USAGE_COUNTERS_TABLE } from "./007-usage-counters";

export const usageCounterTimestamp: Migration = {
  version: 11,
  name: "usage-counter-timestamp",
  statements(schema: SchemaInspect): string[] {
    // SQLite stores every instant as TEXT; there is nothing to convert.
    if (schema.dialect === "sqlite") return [];

    /*
     * Guarded on the table rather than on the column type, because `SchemaInspect`
     * deliberately exposes only names — it answers "does this exist", never "what
     * type is it", so that one migration definition can serve both a synchronous
     * and an asynchronous driver. The idempotency argument above is what makes that
     * sufficient here.
     *
     * The table is now in the PostgreSQL driver's `INSPECTED_TABLES`, so this check
     * reads the real schema. Before this phase it did not, and would have answered
     * "does not exist" on a database where the table was present — the blind branch
     * this phase also closes.
     */
    if (!schema.tableExists(USAGE_COUNTERS_TABLE)) return [];

    return [
      `ALTER TABLE ${USAGE_COUNTERS_TABLE}
         ALTER COLUMN updated_at TYPE timestamptz
         USING updated_at::timestamptz`,
    ];
  },
};
