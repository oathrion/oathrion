/**
 * 013 — a per-tenant total order over action receipts (Phase 11).
 *
 * WHAT PHASE 10 LEFT OPEN
 * -----------------------
 * Receipts were hash-chained: each one carried `prev_hash`, the `entry_hash` of the
 * tenant's previous receipt. PHASE-10-REPORT.md recorded the hole plainly — the
 * predecessor was read and the successor inserted in two statements, so two receipts
 * written concurrently for one tenant could name the same predecessor. The chain
 * became a tree, and "the newest receipt" stopped being a well-defined row. Ordering
 * fell back to `executed_at DESC, receipt_id DESC`, and `executed_at` has millisecond
 * resolution, so two receipts in the same millisecond ordered by a random UUID.
 *
 * WHAT THIS MIGRATION ADDS
 * ------------------------
 * `entry_seq`: a gap-free per-tenant counter, 1, 2, 3, ..., with a UNIQUE index on
 * `(organization_id, entry_seq)`. The uniqueness is the mechanism, not documentation:
 * two concurrent writers that both compute the same next sequence cannot both commit,
 * so a fork is refused by the database instead of being detected afterwards. The
 * winner commits; the loser retries and gets the next number.
 *
 * WHAT IT IS NOT
 * --------------
 * This is not external anchoring and not cryptographic proof against an operator with
 * database access. Anyone who can write to this table can recompute a chain of hashes
 * and renumber a sequence. What the sequence buys is precise: a missing receipt leaves
 * a hole an auditor can see, a reordered one breaks a hash, and two concurrent
 * receipts can no longer both claim the same position. Claiming more than that would
 * be the kind of security theatre this project refuses.
 *
 * BACKFILL
 * --------
 * Existing rows get numbers in `(executed_at, receipt_id)` order — the best order
 * available, and the same order the reads used before this migration, so no history is
 * reinterpreted. The column is left nullable rather than NOT NULL: SQLite cannot add a
 * NOT NULL column without a default, and a default of 0 would collide under the unique
 * index. Reads treat a NULL as "unnumbered", which only pre-013 rows can be.
 */

import type { Migration, SchemaInspect } from "./types";
import { ACTION_RECEIPTS_TABLE } from "./012-action-authority";

function statementsFor(schema: SchemaInspect): string[] {
  const statements: string[] = [];

  // Idempotent by inspection rather than by `IF NOT EXISTS`: SQLite's ALTER TABLE has
  // no such clause, and the runner may re-inspect a database that is already at 13.
  if (!schema.columns(ACTION_RECEIPTS_TABLE).has("entry_seq")) {
    statements.push(`ALTER TABLE ${ACTION_RECEIPTS_TABLE} ADD COLUMN entry_seq INTEGER`);
  }

  /*
   * The backfill. Written as a correlated subquery so it runs identically on both
   * engines: for each row, count the rows of the same tenant that come at or before it
   * in (executed_at, receipt_id) order. O(n²) in the number of receipts per tenant,
   * which is acceptable exactly once, on a table that holds at most a pilot's history.
   */
  statements.push(
    `UPDATE ${ACTION_RECEIPTS_TABLE} SET entry_seq = (
       SELECT count(*) FROM ${ACTION_RECEIPTS_TABLE} earlier
        WHERE earlier.organization_id = ${ACTION_RECEIPTS_TABLE}.organization_id
          AND (earlier.executed_at, earlier.receipt_id)
              <= (${ACTION_RECEIPTS_TABLE}.executed_at, ${ACTION_RECEIPTS_TABLE}.receipt_id)
     ) WHERE entry_seq IS NULL`,
  );

  statements.push(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_receipts_seq
       ON ${ACTION_RECEIPTS_TABLE} (organization_id, entry_seq)`,
  );

  return statements;
}

export const receiptOrdering: Migration = {
  version: 13,
  name: "receipt-ordering",
  statements(schema: SchemaInspect): string[] {
    return statementsFor(schema);
  },
};
