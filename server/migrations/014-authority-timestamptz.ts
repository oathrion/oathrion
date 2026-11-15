/**
 * Migration 14 — the action-authority tables store real instants on PostgreSQL (Phase 11).
 *
 * ## The defect
 *
 * Migration 12 created `actions`, `action_grants`, `action_policies` and
 * `action_receipts`. Its PostgreSQL branch declared every instant in them as `TEXT`,
 * copying the SQLite branch verbatim. Every other instant in this schema is a
 * `timestamptz`, and `server/test/postgres.test.ts` pins that rule for exactly the
 * reason it matters here: a text column compares lexicographically, so
 * `expires_at > $1` answers wrongly the moment two values are written with different
 * offset spellings (`…+00:00` and `…Z` are the same instant and sort differently), and
 * an index on it cannot serve a range scan the way a timestamptz one does.
 *
 * That comparison is not decorative. `consumeGrant` refuses an expired grant with
 * `AND expires_at > ?` inside the UPDATE. On text, its correctness depends on every
 * writer having chosen the same string format — which is true today by accident of one
 * code path, and would stop being true the first time a grant is written by anything
 * else. This migration removes the accident.
 *
 * It was not caught in Phase 10 because the test that pins the rule needs a reachable
 * PostgreSQL server, and Phase 10 had none for that file: it was reported SKIPPED. It
 * failed on the first Phase 11 run against real PostgreSQL 18.6, at
 * `action_policies.created_at: expected 'text' to be 'timestamp with time zone'`.
 *
 * ## Why an ALTER rather than an edit to migration 12
 *
 * Migration 12 is applied and recorded in the ledger. `assertHistoryMatches` refuses a
 * database whose recorded history disagrees with the code, so editing 12 would lock out
 * every database that already ran it and leave those databases with text columns anyway.
 * Append-only is the rule; migration 11 set this precedent for the same class of defect.
 *
 * ## Why it is safe, idempotent, and asymmetric
 *
 * The statements cast with an explicit `USING …::timestamptz`. PostgreSQL refuses the
 * implicit text→timestamptz change, and casting a column that is already `timestamptz`
 * to `timestamptz` is accepted and rewrites nothing observable — so a second run
 * converges instead of failing, like migrations 9 and 11.
 *
 * On SQLite it emits nothing: SQLite has no timestamp type, every instant there is TEXT,
 * and there is no drift to correct. `schema.dialect` exists for this.
 *
 * ## What had to change with it
 *
 * `node-postgres` returns a `Date` for a `timestamptz`, where it returned a string
 * before. `server/authority/store.ts` now normalises instants through `instant()` /
 * `instantOrNull()`, which convert a Date back to the millisecond ISO form that was
 * written. Without that, `String(date)` would have produced a non-ISO instant, and the
 * receipt hash chain — computed over the executed_at value — would not have verified
 * after a round trip. The tests that cover this are in
 * `server/test/phase11-postgres-core.test.ts` and `server/test/phase10-postgres.test.ts`.
 */

import type { Migration, SchemaInspect } from "./types";
import {
  ACTIONS_TABLE,
  ACTION_GRANTS_TABLE,
  ACTION_POLICIES_TABLE,
  ACTION_RECEIPTS_TABLE,
} from "./012-action-authority";

/** The cast for one column. Explicit `USING`, because PostgreSQL refuses the implicit one. */
const cast = (table: string, column: string): string =>
  `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TIMESTAMPTZ USING ${column}::timestamptz`;

export const authorityTimestamptz: Migration = {
  version: 14,
  name: "authority-timestamptz",
  statements(schema: SchemaInspect): string[] {
    // SQLite stores every instant as TEXT; there is nothing to convert.
    if (schema.dialect === "sqlite") return [];

    const out: string[] = [];
    /*
     * Guarded per table, because `SchemaInspect` answers "does this exist" and never
     * "what type is it" — that restriction is what lets one migration definition serve
     * both the synchronous and the asynchronous driver. The idempotency of the cast is
     * what makes the weaker guard sufficient.
     *
     * All four tables are in the PostgreSQL driver's `INSPECTED_TABLES` as of this
     * phase. Before that, these checks would have answered "does not exist" on a
     * database where the tables plainly do, and this migration would have emitted
     * nothing at all — the blind branch this phase also closes.
     *
     * Written out one table at a time, with the constants passed directly, so that
     * `server/test/migration-inspection-coverage.test.ts` can resolve every inspected
     * name statically. A loop variable is invisible to that test, and it refuses what
     * it cannot resolve rather than assuming it is covered.
     */
    if (schema.tableExists(ACTIONS_TABLE)) {
      out.push(cast(ACTIONS_TABLE, "created_at"));
    }
    if (schema.tableExists(ACTION_GRANTS_TABLE)) {
      for (const column of [
        "created_at",
        "issued_at",
        "expires_at",
        "consumed_at",
        "approved_at",
        "revoked_at",
      ]) {
        out.push(cast(ACTION_GRANTS_TABLE, column));
      }
    }
    if (schema.tableExists(ACTION_POLICIES_TABLE)) {
      for (const column of ["created_at", "updated_at"]) {
        out.push(cast(ACTION_POLICIES_TABLE, column));
      }
    }
    if (schema.tableExists(ACTION_RECEIPTS_TABLE)) {
      out.push(cast(ACTION_RECEIPTS_TABLE, "executed_at"));
    }
    return out;
  },
};
