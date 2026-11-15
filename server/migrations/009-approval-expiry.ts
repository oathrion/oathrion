/**
 * Migration 9 — `expires_at` and `resolved_at` on `approvals`.
 *
 * ## What this changes about the security model
 *
 * Until now an approval had no deadline, so a pending request was a standing
 * authorisation: releasable on day one and equally releasable on day thirty. The
 * reasoning for bounding that window is in `shared/approvals/ttl.ts`; this file
 * is only the storage half of it.
 *
 * ## Why the backfill exists, and why it uses a constant rather than the env
 *
 * The decision paths treat an absent deadline as **expired**, not as "no
 * deadline" (fail-closed). Applied to a live database with no backfill, that
 * would silently kill every in-flight approval the moment the build shipped.
 * Rows created before this migration are therefore given a deadline derived from
 * their own `requested_at`, which is the honest answer to "when should this have
 * expired": most historic rows land in the past and become unreleasable, which
 * is the correct outcome, but they get there by the same rule as everything
 * else rather than by a special case.
 *
 * The interval is the hard-coded default (3600 s), not `OATHRION_APPROVAL_TTL_MS`. A
 * migration must produce the same database from the same starting point on every
 * machine that runs it; one that reads the environment would write different
 * history depending on who applied it and when, and the ledger would record a
 * version number that no longer identifies a schema state. Deployments wanting a
 * different window get it for every *new* approval, via the environment, without
 * rewriting what already happened.
 *
 * ## Why `resolved_at` comes along
 *
 * `resolved_by` existed without a companion timestamp, so the trail could say who
 * ended a request but not when. Expiry makes that gap worse: it produces
 * terminal rows with no human at all, and without a timestamp such a row would
 * be indistinguishable from one that was never touched. Both halves of the
 * question have to be answerable for the trail to be worth keeping.
 *
 * Additive and reversible: dropping the two columns returns the database to
 * version 8 with no loss anywhere else.
 */

import type { Migration, SchemaInspect } from "./types";

/** Kept in step with `DEFAULT_APPROVAL_TTL_MS`; see the note above on why it is frozen here. */
export const APPROVAL_BACKFILL_TTL_SECONDS = 3600;

export const approvalExpiry: Migration = {
  version: 9,
  name: "approval-expiry",
  statements(schema: SchemaInspect): string[] {
    const out: string[] = [];
    if (!schema.tableExists("approvals")) return out;

    const columns = schema.columns("approvals");
    const sqlite = schema.dialect === "sqlite";
    const stamp = sqlite ? "TEXT" : "timestamptz";

    if (!columns.has("expires_at")) {
      out.push(`ALTER TABLE approvals ADD COLUMN expires_at ${stamp}`);
    }
    if (!columns.has("resolved_at")) {
      out.push(`ALTER TABLE approvals ADD COLUMN resolved_at ${stamp}`);
    }

    /*
     * Guarded by `expires_at IS NULL` rather than by whether the column was just
     * added, so re-running against a partially-migrated database converges on the
     * same state instead of overwriting deadlines that already exist.
     *
     * SQLite is handed an explicit ISO format because `datetime()` would return
     * `YYYY-MM-DD HH:MM:SS` — a space instead of the `T`, no `Z` — which
     * `Date.parse` reads as *local* time. On a machine east of UTC that silently
     * shortens every backfilled window, and on one west of UTC it lengthens it.
     * The format string is the difference between a deadline and a guess.
     */
    out.push(
      sqlite
        ? `UPDATE approvals
             SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', requested_at, '+${APPROVAL_BACKFILL_TTL_SECONDS} seconds')
           WHERE expires_at IS NULL`
        : `UPDATE approvals
             SET expires_at = requested_at + interval '${APPROVAL_BACKFILL_TTL_SECONDS} seconds'
           WHERE expires_at IS NULL`,
    );

    /*
     * Historic terminal rows get a `resolved_at` too, so the column does not start
     * life as "populated for new rows, null for old ones" — a shape that makes any
     * later query over it quietly wrong. `requested_at` is the only instant these
     * rows carry; using it is an admission that the true resolution time was never
     * recorded, which is better than inventing `now()` and making every historic
     * approval look like it was resolved at deploy time.
     */
    out.push(
      `UPDATE approvals
         SET resolved_at = requested_at
       WHERE resolved_at IS NULL AND status <> 'pending'`,
    );

    /*
     * The sweep reads "pending rows of this tenant whose deadline has passed", so
     * the index matches that shape. Without it the sweep degrades into a full scan
     * of every approval the deployment has ever recorded.
     */
    out.push(
      `CREATE INDEX IF NOT EXISTS idx_approvals_expiry
         ON approvals (organization_id, status, expires_at)`,
    );

    return out;
  },
};
