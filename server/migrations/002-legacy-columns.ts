/**
 * Migration 2 — top up columns added after the first schema shipped.
 *
 * This is the inherited `PRAGMA table_info` diffing logic from `server/db.ts`,
 * moved into the ledger unchanged in behaviour. It is conditional because it has
 * to be: a database created by build N is missing whatever build N+1 added, and
 * SQLite has no `ADD COLUMN IF NOT EXISTS`.
 *
 * On a database that migration 1 has just created, every column already exists
 * and this migration produces zero statements — which is recorded in the ledger
 * as `statement_count = 0`, so an operator can see it ran and did nothing.
 */

import type { Migration, SchemaInspect } from "./types";

/** Columns the Gateway added to `executions`, with the DDL that creates them. */
const EXECUTION_COLUMNS: readonly (readonly [string, string])[] = [
  ["tool_id", "TEXT"],
  ["tool_executed_at", "TEXT"],
  ["tool_result", "TEXT"],
  ["run_state", "TEXT NOT NULL DEFAULT 'pending'"],
  ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["last_error", "TEXT"],
  ["tool_started_at", "TEXT"],
];

export const legacyColumns: Migration = {
  version: 2,
  name: "legacy-columns",
  statements(schema: SchemaInspect): string[] {
    if (schema.dialect !== "sqlite") {
      // A PostgreSQL database is necessarily created by this build's baseline, so
      // it can never be missing these columns. Nothing to do, and saying so is
      // more honest than emitting no-op DDL.
      return [];
    }

    const out: string[] = [];

    // Per-agent mandates arrived after the first schema.
    if (!schema.columns("agents").has("mandate")) {
      out.push(`ALTER TABLE agents ADD COLUMN mandate TEXT NOT NULL DEFAULT '{}'`);
    }

    /*
     * Sessions predating the credential binding. A row without a fingerprint
     * cannot be verified against the current console users, and `server/auth.ts`
     * refuses it rather than trusting it — so the cost of this upgrade is one
     * extra sign-in, never a silently trusted session.
     */
    if (!schema.columns("sessions").has("credential_fp")) {
      out.push(`ALTER TABLE sessions ADD COLUMN credential_fp TEXT`);
    }

    const executionColumns = schema.columns("executions");
    const addingRunState = !executionColumns.has("run_state");

    for (const [column, ddl] of EXECUTION_COLUMNS) {
      if (!executionColumns.has(column)) {
        out.push(`ALTER TABLE executions ADD COLUMN ${column} ${ddl}`);
      }
    }

    /*
     * Backfill the tool-run lifecycle for rows that predate it, so the retry and
     * claim queries never see an ambiguous NULL/'pending' on a row whose tool has
     * demonstrably already run. Ordered after the ALTERs, and only when the
     * column was actually just added — re-running it later would rewrite live
     * lifecycle state.
     */
    if (addingRunState) {
      out.push(
        `UPDATE executions SET run_state = 'succeeded', attempts = 1, tool_started_at = tool_executed_at
           WHERE tool_executed_at IS NOT NULL AND status <> 'failed'`,
        `UPDATE executions SET run_state = 'failed', attempts = 1, tool_started_at = tool_executed_at
           WHERE tool_executed_at IS NOT NULL AND status = 'failed'`,
        `UPDATE executions SET run_state = 'skipped'
           WHERE tool_executed_at IS NULL AND status = 'blocked'`,
      );
    }

    return out;
  },
};
