/**
 * Migration 7 — `usage_counters`, the quota MEASUREMENT record (P3).
 *
 * ## What this table is, and what it is emphatically not
 *
 * It is not the source of truth for a quota decision. Read that twice before
 * changing anything here, because the obvious design is the wrong one.
 *
 * The obvious design is a counter row per organization that is incremented on every
 * write and compared against the ceiling. It is O(1), it is what most quota systems
 * do, and it has one property that disqualifies it here: it drifts. The moment a row
 * is deleted, a migration rebuilds a table, a restore runs from a backup taken at a
 * different instant, or a transaction rolls back after the counter was bumped, the
 * counter and reality disagree — and the direction of the drift decides whether a
 * paying customer is refused writes they are entitled to, or silently allowed past
 * the ceiling they are billed against. Neither failure announces itself: both look
 * like a working system holding a wrong number.
 *
 * So enforcement in `server/quotas.ts` compares against an **exact, tenant-filtered
 * `count(*)` issued inside the same transaction as the write it guards**. It cannot
 * drift, because there is nothing to drift from: the count is the data. The cost is
 * one indexed aggregate per guarded write, and the cost is affordable for a measured
 * reason — the executions period count is served by `idx_executions_org_ts`
 * `(organization_id, timestamp)`, created back in migration 3, and the agent and
 * policy counts are served by the composite primary key `(organization_id, id)` from
 * the same migration. No new index is needed, and none is created: an extra index
 * would cost a write on every insert to buy a read this one already has.
 *
 * ## Then why does the table exist at all
 *
 * Because two questions cannot be answered from the data:
 *
 *  1. **"How close did we get?"** The exact count says what is true now. It says
 *     nothing about the peak reached last Tuesday, which is precisely the number an
 *     operator needs in order to set a ceiling that will not interrupt the customer.
 *     The roadmap's stated mitigation for this phase is "measure before enforcing";
 *     a high-water mark is that measurement.
 *  2. **"How often are we refusing this customer?"** A refusal is a support ticket
 *     and, eventually, an upsell. It leaves no trace in the data by definition —
 *     the write did not happen — so if it is not recorded here it is recorded
 *     nowhere except a log line that rotates away.
 *
 * Both are advisory. A row that is wrong, stale or missing degrades a report; it can
 * never refuse a request or allow one, because no code path reads it to decide.
 *
 * ## Why this table is created on BOTH engines
 *
 * Unlike `rate_limit_buckets` (migration 6), which is PostgreSQL-only because a
 * "shared" bucket store shares nothing on a single-process SQLite deployment, this
 * table is about durability rather than sharing. A high-water mark kept in memory is
 * reset by every deploy, which destroys exactly the long-horizon measurement it
 * exists to provide. A single-process SQLite deployment needs that just as much as a
 * replicated one, so both dialects get the table.
 */

import type { Migration, SchemaInspect } from "./types";

export const USAGE_COUNTERS_TABLE = "usage_counters";

export const usageCounters: Migration = {
  version: 7,
  name: "usage-counters",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(USAGE_COUNTERS_TABLE)) return [];

    /*
     * The primary key is `(organization_id, counter, period_start)` and there is no
     * surrogate id. Every access is an upsert on exactly that triple or a range read
     * over one organization, so the primary-key index is the only index either
     * pattern needs — and putting `organization_id` first means a per-tenant read is
     * a prefix scan rather than a filter over the whole table.
     *
     * `period_start` is text on both engines, holding either an ISO-8601 instant or
     * the literal `lifetime` for a count counter. A timestamp column could not hold
     * the second, and splitting the two kinds into two tables would double every
     * query for a distinction that is one string comparison.
     */
    if (schema.dialect === "sqlite") {
      return [
        `CREATE TABLE IF NOT EXISTS ${USAGE_COUNTERS_TABLE} (
           organization_id TEXT NOT NULL,
           counter         TEXT NOT NULL,
           period_start    TEXT NOT NULL,
           observed_max    INTEGER NOT NULL DEFAULT 0,
           refusals        INTEGER NOT NULL DEFAULT 0,
           updated_at      TEXT NOT NULL,
           PRIMARY KEY (organization_id, counter, period_start)
         )`,
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS ${USAGE_COUNTERS_TABLE} (
         organization_id TEXT NOT NULL,
         counter         TEXT NOT NULL,
         period_start    TEXT NOT NULL,
         observed_max    BIGINT NOT NULL DEFAULT 0,
         refusals        BIGINT NOT NULL DEFAULT 0,
         updated_at      TEXT NOT NULL,
         PRIMARY KEY (organization_id, counter, period_start)
       )`,
    ];
  },
};
