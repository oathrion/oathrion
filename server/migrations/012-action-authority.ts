/**
 * Migration 12 — Phase 10: the action authorization data plane.
 *
 * WHAT THIS ADDS AND WHY IT IS FOUR TABLES
 * ----------------------------------------
 * Phase 9 authorised an *execution*: a row describing an agent, a verb and a
 * free-form target. Phase 10 authorises an **action** — an exact verb with exact
 * arguments, aimed at an exact server-registered destination — and then has to
 * prove that the thing which reached the downstream was that action and not a
 * neighbouring one. Four tables, each carrying one fact that cannot be inferred
 * from the others:
 *
 *   actions          the canonical action, its server-computed hash, and the
 *                    verdict that was reached for it.
 *   action_policies  the deterministic constraint rules the verdict came from.
 *   action_grants    the *authority* to execute one exact action once. This is
 *                    the row that makes single-use enforceable in the database
 *                    rather than in a process's memory.
 *   action_receipts  what actually happened downstream, linked back to the grant.
 *
 * THE COLUMNS THAT ARE LOAD-BEARING
 * ---------------------------------
 * `action_grants.state` plus the partial-uniqueness of a consumption is the whole
 * replay defence: consumption is a conditional UPDATE from `issued` to `consumed`,
 * so two concurrent consumers produce exactly one row change (PostgreSQL
 * serialises the two UPDATEs on the row lock; SQLite serialises writers).
 *
 * `actions.idempotency_key` is UNIQUE per organisation. That is what makes "same
 * key + different action" a database-level refusal rather than a check somebody
 * has to remember. NULL keys stay distinct in both engines, which is the correct
 * reading: "no key supplied" is not a claim of identity.
 *
 * FOREIGN KEYS
 * ------------
 * Declared in both dialects. They are advisory in SQLite unless
 * `PRAGMA foreign_keys` is on, and enforced in PostgreSQL — which is the engine
 * the production claim is about.
 */

import type { Migration, SchemaInspect } from "./types";

export const ACTIONS_TABLE = "actions";
export const ACTION_POLICIES_TABLE = "action_policies";
export const ACTION_GRANTS_TABLE = "action_grants";
export const ACTION_RECEIPTS_TABLE = "action_receipts";

function sqliteStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${ACTIONS_TABLE} (
      organization_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      arguments TEXT NOT NULL DEFAULT '{}',
      destination_id TEXT NOT NULL,
      canonical TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      request_id TEXT,
      idempotency_key TEXT,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      policy_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_idempotency
       ON ${ACTIONS_TABLE} (organization_id, idempotency_key)`,
    `CREATE INDEX IF NOT EXISTS idx_actions_hash
       ON ${ACTIONS_TABLE} (organization_id, action_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_actions_agent
       ON ${ACTIONS_TABLE} (organization_id, agent_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS ${ACTION_POLICIES_TABLE} (
      organization_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      destination_id TEXT,
      effect TEXT NOT NULL,
      constraints TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_action_policies_lookup
       ON ${ACTION_POLICIES_TABLE} (organization_id, action, priority)`,

    `CREATE TABLE IF NOT EXISTS ${ACTION_GRANTS_TABLE} (
      organization_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL REFERENCES ${ACTIONS_TABLE} (id),
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      state TEXT NOT NULL,
      request_id TEXT,
      idempotency_key TEXT,
      policy_id TEXT,
      created_at TEXT NOT NULL,
      issued_at TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_by TEXT,
      approval_id TEXT,
      approved_at TEXT,
      approved_by TEXT,
      revoked_at TEXT,
      revoked_reason TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_action_grants_state
       ON ${ACTION_GRANTS_TABLE} (organization_id, state, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_action_grants_hash
       ON ${ACTION_GRANTS_TABLE} (organization_id, action_hash)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_grants_approval
       ON ${ACTION_GRANTS_TABLE} (organization_id, approval_id)`,

    `CREATE TABLE IF NOT EXISTS ${ACTION_RECEIPTS_TABLE} (
      organization_id TEXT NOT NULL,
      receipt_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES ${ACTION_GRANTS_TABLE} (id),
      action_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      approval_id TEXT,
      executed_at TEXT NOT NULL,
      downstream_execution_id TEXT,
      outcome TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      result_summary TEXT NOT NULL DEFAULT '',
      prev_hash TEXT,
      entry_hash TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_receipts_grant
       ON ${ACTION_RECEIPTS_TABLE} (organization_id, grant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_action_receipts_time
       ON ${ACTION_RECEIPTS_TABLE} (organization_id, executed_at)`,
  ];
}

function postgresStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${ACTIONS_TABLE} (
      organization_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      arguments TEXT NOT NULL DEFAULT '{}',
      destination_id TEXT NOT NULL,
      canonical TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      request_id TEXT,
      idempotency_key TEXT,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      policy_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_idempotency
       ON ${ACTIONS_TABLE} (organization_id, idempotency_key)`,
    `CREATE INDEX IF NOT EXISTS idx_actions_hash
       ON ${ACTIONS_TABLE} (organization_id, action_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_actions_agent
       ON ${ACTIONS_TABLE} (organization_id, agent_id, created_at)`,

    `CREATE TABLE IF NOT EXISTS ${ACTION_POLICIES_TABLE} (
      organization_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      destination_id TEXT,
      effect TEXT NOT NULL,
      constraints TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_action_policies_lookup
       ON ${ACTION_POLICIES_TABLE} (organization_id, action, priority)`,

    `CREATE TABLE IF NOT EXISTS ${ACTION_GRANTS_TABLE} (
      organization_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL REFERENCES ${ACTIONS_TABLE} (id),
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      state TEXT NOT NULL,
      request_id TEXT,
      idempotency_key TEXT,
      policy_id TEXT,
      created_at TEXT NOT NULL,
      issued_at TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_by TEXT,
      approval_id TEXT,
      approved_at TEXT,
      approved_by TEXT,
      revoked_at TEXT,
      revoked_reason TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_action_grants_state
       ON ${ACTION_GRANTS_TABLE} (organization_id, state, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_action_grants_hash
       ON ${ACTION_GRANTS_TABLE} (organization_id, action_hash)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_grants_approval
       ON ${ACTION_GRANTS_TABLE} (organization_id, approval_id)`,

    `CREATE TABLE IF NOT EXISTS ${ACTION_RECEIPTS_TABLE} (
      organization_id TEXT NOT NULL,
      receipt_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES ${ACTION_GRANTS_TABLE} (id),
      action_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      approval_id TEXT,
      executed_at TEXT NOT NULL,
      downstream_execution_id TEXT,
      outcome TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      result_summary TEXT NOT NULL DEFAULT '',
      prev_hash TEXT,
      entry_hash TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_action_receipts_grant
       ON ${ACTION_RECEIPTS_TABLE} (organization_id, grant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_action_receipts_time
       ON ${ACTION_RECEIPTS_TABLE} (organization_id, executed_at)`,
  ];
}

export const actionAuthority: Migration = {
  version: 12,
  name: "action-authority",
  statements(schema: SchemaInspect): string[] {
    return schema.dialect === "postgres" ? postgresStatements() : sqliteStatements();
  },
};
