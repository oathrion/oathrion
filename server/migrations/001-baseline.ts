/**
 * Migration 1 — the inherited baseline schema.
 *
 * This is the schema as it existed at the end of the audit, transcribed from the
 * `CREATE TABLE IF NOT EXISTS` block that used to live in `server/db.ts`. It is
 * reproduced faithfully and not "improved": foreign keys, tenant columns and the
 * dedicated audit table are later migrations, so that an existing deployment
 * moves forward one reviewable step at a time.
 *
 * The three index definitions carry their measured justification with them,
 * because that reasoning is the reason they exist and it belongs next to the DDL,
 * not in a commit message nobody will find.
 *
 * A database created by a pre-ledger build is *adopted* at this version by the
 * runner rather than having this DDL replayed — see `runner.ts`.
 */

import type { Migration, SchemaInspect } from "./types";

function sqliteStatements(): string[] {
  return [
    /*
     * Earlier builds created a `users` table with a plaintext `password` column.
     * Nothing ever read it, but a database file carried over from one of those
     * builds still holds the rows, so it is dropped rather than merely no longer
     * created. Safe precisely because no code path has ever selected from it.
     *
     * P0-2 introduces a real `users` table with a hashed password in a later
     * migration; that one is created only after this drop has run.
     */
    `DROP TABLE IF EXISTS users`,

    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      current_task TEXT,
      owner TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      executions_24h INTEGER NOT NULL DEFAULT 0,
      success_rate REAL NOT NULL DEFAULT 100,
      cost_24h REAL NOT NULL DEFAULT 0,
      cost_month REAL NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]',
      mandate TEXT NOT NULL DEFAULT '{}',
      policy_ids TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]'
    )`,

    `CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      rule TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL,
      applies_to TEXT NOT NULL DEFAULT '',
      effect TEXT NOT NULL,
      status TEXT NOT NULL,
      triggered_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      type TEXT,
      condition TEXT,
      action TEXT,
      applies_to_agent_ids TEXT,
      risk TEXT,
      priority INTEGER NOT NULL DEFAULT 0
    )`,

    `CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      risk TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '{}',
      decision TEXT NOT NULL,
      decision_reason TEXT NOT NULL DEFAULT '',
      policy_evaluated TEXT,
      policy_id TEXT,
      result TEXT NOT NULL DEFAULT '',
      audit TEXT NOT NULL DEFAULT '[]',
      approval_id TEXT,
      tool_id TEXT,
      tool_executed_at TEXT,
      tool_result TEXT,
      run_state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      tool_started_at TEXT
    )`,

    // Serves "list this agent's executions, newest first".
    `CREATE INDEX IF NOT EXISTS idx_executions_agent_ts ON executions (agent_id, timestamp)`,

    /*
     * The console-timeline index. Both list reads the console performs on every
     * page load are unfiltered and newest-first, which idx_executions_agent_ts
     * cannot serve (its leading column constrains agent_id). Measured on the
     * 145,600-row database built by script/pilot-sim.ts:
     *   without  SCAN executions | USE TEMP B-TREE FOR ORDER BY   187.3 ms
     *   with     SCAN executions USING INDEX idx_executions_ts      4.8 ms
     * The plan, not the timing, is locked by server/test/query-plans.test.ts.
     */
    `CREATE INDEX IF NOT EXISTS idx_executions_ts ON executions (timestamp)`,

    /*
     * The daily-spend index. `dailySpend` runs INSIDE the decision transaction,
     * so it is on the critical path of every governed action. Two equalities
     * first, the range last, `cost` appended to make the index COVERING.
     * Measured on 200k rows, 12 agents, ~20% allowed (script/bench-daily-spend.ts):
     *   (agent_id, timestamp)                2038.6 µs/query
     *   (agent_id, status, timestamp)         703.5 µs/query    2.9x
     *   (agent_id, status, timestamp, cost)    95.3 µs/query   21.4x  <- this one
     */
    `CREATE INDEX IF NOT EXISTS idx_executions_spend ON executions (agent_id, status, timestamp, cost)`,

    `CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      execution_id TEXT,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      requested_value TEXT NOT NULL DEFAULT '',
      policy_id TEXT NOT NULL DEFAULT '',
      policy_name TEXT NOT NULL DEFAULT '',
      policy_limit TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_by TEXT,
      context TEXT NOT NULL DEFAULT '[]'
    )`,

    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT,
      credential_fp TEXT
    )`,

    `CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions (subject)`,

    `CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      connected INTEGER NOT NULL DEFAULT 0,
      scopes TEXT NOT NULL DEFAULT '[]',
      connected_at TEXT,
      agents_using INTEGER NOT NULL DEFAULT 0
    )`,
  ];
}

/*
 * PostgreSQL DDL for the same logical schema (P0-4).
 *
 * NOT A MECHANICAL TRANSLATION. Four categories of column were converted rather
 * than transcribed, and each choice is a decision that could have gone the other
 * way:
 *
 *   1. `TEXT` timestamps -> `timestamptz`. SQLite has no date type, so the
 *      application writes ISO-8601 UTC strings and compares them
 *      lexicographically. That happens to be correct for a fixed-width UTC format
 *      and it produced a real defect once (the session-expiry sweep in `db.ts`
 *      compared an ISO `'T'` against `datetime('now')`'s space and never swept
 *      anything). PostgreSQL has a real type, so the ordering becomes the
 *      engine's job instead of a property of the string format. `timestamptz`,
 *      not `timestamp`: the values are unambiguously UTC, and a naive column
 *      would silently reinterpret them in the server's local zone.
 *
 *   2. `INTEGER` 0/1 flags -> `boolean`. `integrations.connected` is a boolean
 *      that SQLite cannot express. Keeping it an integer here would preserve a
 *      limitation of the engine we are moving away from, and permit the value 7.
 *
 *   3. Identifiers stay `text`. They are NOT converted to `uuid`, which is the
 *      obvious-looking and wrong move: the values are prefixed, human-readable,
 *      partly caller-supplied strings (`agt_billing`, `pol_high_risk`), not
 *      UUIDs. A `uuid` column would reject every identifier the product actually
 *      issues.
 *
 *   4. `REAL` -> `double precision`, deliberately NOT `numeric`. `cost` is money
 *      and `numeric` would be the textbook choice, but the SQLite path stores and
 *      sums a binary float, and node-postgres returns `numeric` as a *string*.
 *      Switching the type here would make the two engines disagree on rounding
 *      and on the JavaScript type of a summed budget — a behavioural divergence
 *      introduced by a storage decision, which is exactly what the parity tests
 *      exist to prevent. The float is a pre-existing weakness of the money
 *      handling, recorded as such; it is fixed for both engines together or not
 *      at all.
 *
 * Primary keys are given explicit names (`agents_pkey`) even though PostgreSQL
 * would generate exactly those. Migration 3 has to DROP them by name, and a
 * generated name is not a contract.
 */
function postgresStatements(): string[] {
  return [
    // Same reason as the SQLite path: an early build left a plaintext `password`
    // column behind. Harmless on a fresh PostgreSQL database, kept so the two
    // dialects do not diverge in what they guarantee about the final state.
    `DROP TABLE IF EXISTS users`,

    `CREATE TABLE IF NOT EXISTS agents (
      id text NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      provider text NOT NULL,
      model text NOT NULL,
      status text NOT NULL,
      current_task text,
      owner text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL,
      executions_24h integer NOT NULL DEFAULT 0,
      success_rate double precision NOT NULL DEFAULT 100,
      cost_24h double precision NOT NULL DEFAULT 0,
      cost_month double precision NOT NULL DEFAULT 0,
      risk_level text NOT NULL,
      permissions text NOT NULL DEFAULT '[]',
      mandate text NOT NULL DEFAULT '{}',
      policy_ids text NOT NULL DEFAULT '[]',
      tags text NOT NULL DEFAULT '[]',
      CONSTRAINT agents_pkey PRIMARY KEY (id)
    )`,

    `CREATE TABLE IF NOT EXISTS policies (
      id text NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      rule text NOT NULL DEFAULT '',
      scope text NOT NULL,
      applies_to text NOT NULL DEFAULT '',
      effect text NOT NULL,
      status text NOT NULL,
      triggered_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL,
      type text,
      condition text,
      action text,
      applies_to_agent_ids text,
      risk text,
      priority integer NOT NULL DEFAULT 0,
      CONSTRAINT policies_pkey PRIMARY KEY (id)
    )`,

    // `"timestamp"` is quoted throughout the PostgreSQL path: it is a type name,
    // and while PostgreSQL accepts it as a column name, an unquoted occurrence
    // inside a future expression index or cast is a parse error waiting to happen.
    `CREATE TABLE IF NOT EXISTS executions (
      id text NOT NULL,
      agent_id text NOT NULL,
      agent_name text NOT NULL,
      action text NOT NULL,
      target text NOT NULL,
      status text NOT NULL,
      risk text NOT NULL,
      duration_ms integer NOT NULL DEFAULT 0,
      cost double precision NOT NULL DEFAULT 0,
      "timestamp" timestamptz NOT NULL,
      input text NOT NULL DEFAULT '{}',
      decision text NOT NULL,
      decision_reason text NOT NULL DEFAULT '',
      policy_evaluated text,
      policy_id text,
      result text NOT NULL DEFAULT '',
      audit text NOT NULL DEFAULT '[]',
      approval_id text,
      tool_id text,
      tool_executed_at timestamptz,
      tool_result text,
      run_state text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      tool_started_at timestamptz,
      CONSTRAINT executions_pkey PRIMARY KEY (id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_executions_agent_ts ON executions (agent_id, "timestamp")`,
    `CREATE INDEX IF NOT EXISTS idx_executions_ts ON executions ("timestamp")`,
    `CREATE INDEX IF NOT EXISTS idx_executions_spend ON executions (agent_id, status, "timestamp", cost)`,

    `CREATE TABLE IF NOT EXISTS approvals (
      id text NOT NULL,
      execution_id text,
      agent_id text NOT NULL,
      agent_name text NOT NULL,
      title text NOT NULL,
      summary text NOT NULL DEFAULT '',
      requested_value text NOT NULL DEFAULT '',
      policy_id text NOT NULL DEFAULT '',
      policy_name text NOT NULL DEFAULT '',
      policy_limit text NOT NULL DEFAULT '',
      risk text NOT NULL,
      status text NOT NULL,
      requested_at timestamptz NOT NULL,
      resolved_by text,
      context text NOT NULL DEFAULT '[]',
      CONSTRAINT approvals_pkey PRIMARY KEY (id)
    )`,

    `CREATE TABLE IF NOT EXISTS sessions (
      id text NOT NULL,
      subject text NOT NULL,
      name text NOT NULL,
      role text NOT NULL,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL,
      revoked_at timestamptz,
      revoked_by text,
      credential_fp text,
      CONSTRAINT sessions_pkey PRIMARY KEY (id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions (subject)`,

    `CREATE TABLE IF NOT EXISTS integrations (
      id text NOT NULL,
      name text NOT NULL,
      category text NOT NULL,
      description text NOT NULL DEFAULT '',
      connected boolean NOT NULL DEFAULT false,
      scopes text NOT NULL DEFAULT '[]',
      connected_at timestamptz,
      agents_using integer NOT NULL DEFAULT 0,
      CONSTRAINT integrations_pkey PRIMARY KEY (id)
    )`,
  ];
}

export const baseline: Migration = {
  version: 1,
  name: "baseline",
  statements(schema: SchemaInspect): string[] {
    if (schema.dialect === "sqlite") return sqliteStatements();
    return postgresStatements();
  },
};
