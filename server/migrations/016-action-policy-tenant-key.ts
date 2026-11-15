/**
 * Migration 16 — `action_policies` keyed on (organization_id, id), not id alone.
 *
 * THE DEFECT
 * ----------
 * Migration 12 created `action_policies` with `id TEXT PRIMARY KEY`. The id of an
 * action rule is CLIENT-SUPPLIED (`PUT /api/action-policies` accepts `id`), so a
 * global primary key made one tenant's rule ids collide with every other tenant's:
 *
 *   - organization B writing rule "apol_refund" after A had one got a 500
 *     (UNIQUE constraint failed) — an oracle telling B which rule ids exist in A;
 *   - whoever wrote an id first squatted it for every other tenant.
 *
 * Found by `multitenant-authority-isolation.test.ts` (Phase 13). Every legacy
 * tenant table (agents, policies, executions, approvals, integrations) already uses
 * the composite key for exactly this reason (see `shared/schema.ts`).
 *
 * WHY A NEW MIGRATION AND NOT AN EDIT OF 12
 * -----------------------------------------
 * Append-only, like every migration here: databases already at version 12+ recorded
 * 12 under its current shape, and `assertHistoryMatches` would refuse them.
 *
 * Data is preserved: ids were globally unique before, so they are trivially unique
 * per (organization_id, id) after.
 */

import type { Migration, SchemaInspect } from "./types";
import { ACTION_POLICIES_TABLE } from "./012-action-authority";

export const actionPolicyTenantKey: Migration = {
  version: 16,
  name: "action-policy-tenant-key",
  statements(schema: SchemaInspect): string[] {
    if (!schema.tableExists(ACTION_POLICIES_TABLE)) return [];

    if (schema.dialect === "postgres") {
      // The constraint name is PostgreSQL's default for an inline PRIMARY KEY.
      return [
        `ALTER TABLE ${ACTION_POLICIES_TABLE} DROP CONSTRAINT IF EXISTS ${ACTION_POLICIES_TABLE}_pkey`,
        `ALTER TABLE ${ACTION_POLICIES_TABLE} ADD CONSTRAINT ${ACTION_POLICIES_TABLE}_pkey ` +
          `PRIMARY KEY (organization_id, id)`,
      ];
    }

    // SQLite cannot alter a primary key: rebuild, copy, swap, re-index.
    const next = `${ACTION_POLICIES_TABLE}_m16`;
    const columns =
      "organization_id, id, name, action, destination_id, effect, constraints, priority, " +
      "status, created_at, updated_at";
    return [
      `CREATE TABLE ${next} (
        organization_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        action TEXT NOT NULL,
        destination_id TEXT,
        effect TEXT NOT NULL,
        constraints TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, id)
      )`,
      `INSERT INTO ${next} (${columns}) SELECT ${columns} FROM ${ACTION_POLICIES_TABLE}`,
      `DROP TABLE ${ACTION_POLICIES_TABLE}`,
      `ALTER TABLE ${next} RENAME TO ${ACTION_POLICIES_TABLE}`,
      `CREATE INDEX IF NOT EXISTS idx_action_policies_lookup
         ON ${ACTION_POLICIES_TABLE} (organization_id, action, priority)`,
    ];
  },
};
