/**
 * Migration 3 — multi-tenancy.
 *
 * Adds the `organizations` table, an `organization_id` discriminator on every table
 * that holds customer data, and — for the five customer-data tables — a **composite
 * primary key `(organization_id, id)`**. This is the schema half of P0-1; the
 * enforcement half is in `server/repositories/sqlite.ts`, and neither is sufficient
 * on its own.
 *
 * ## Why a discriminator column and not a database per tenant
 *
 * Schema-per-tenant and database-per-tenant give isolation by construction, and
 * both were rejected deliberately: they multiply every migration by the number of
 * customers, make any operational cross-tenant question impossible to answer, and
 * require a connection-routing layer before the first customer exists. The
 * discriminator behaves identically on SQLite and PostgreSQL, so one adversarial
 * test suite proves the isolation for both engines.
 *
 * PostgreSQL row-level security is planned as defence in depth on top of this
 * (P2-1), never as a substitute: the application has to be correct on its own,
 * because the SQLite deployment has no RLS to fall back on.
 *
 * ## Why the primary key changes, which is the expensive part
 *
 * `id` used to be globally unique, and the API lets the caller choose it
 * (`POST /api/agents` takes `id`). With one global namespace:
 *
 *   1. two customers cannot both own an agent called `agt_billing` — a functional
 *      defect in a multi-tenant product, not a subtlety;
 *   2. the second customer's `create` fails on a primary-key conflict, which is an
 *      oracle: it reveals that some other tenant already uses that identifier.
 *
 * Making the key `(organization_id, id)` gives every organization its own namespace,
 * so both problems disappear at the schema level rather than being papered over by
 * error-message handling. SQLite cannot alter a primary key, so each table is
 * rebuilt: create, copy, drop, rename — inside the runner's transaction, so a
 * failure leaves the original tables untouched.
 *
 * `sessions` keeps its single-column primary key on purpose. A bearer token is
 * resolved to a session *before* the organization is known — that is where the
 * organization comes from — so the lookup cannot be scoped by tenant. Session ids
 * are server-generated random values, never caller-supplied, so a global namespace
 * is correct there and creates no collision.
 *
 * ## Why existing rows go to one organization
 *
 * An existing deployment is not "no tenant"; it is exactly one tenant. Backfilling
 * to `org_default` states that fact, instead of introducing a nullable column —
 * and a nullable discriminator is precisely what would allow a row that no tenant
 * filter matches: invisible to every customer, and visible to any query that forgot
 * the filter.
 */

import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import type { Migration, SchemaInspect } from "./types";

const ORG = DEFAULT_ORGANIZATION_ID;

/**
 * One table rebuild: create the replacement, copy every row into it with the
 * default organization, drop the original, rename.
 *
 * `columns` is the ordered column list shared by both tables, so the copy never
 * relies on `SELECT *` — which would silently mis-assign values the moment the two
 * definitions differ by one column.
 */
function rebuild(
  schema: SchemaInspect,
  table: string,
  ddlBody: string,
  columns: readonly string[],
): string[] {
  /*
   * INTERSECTED WITH THE LIVE TABLE, not taken as given.
   *
   * A database created by an older build genuinely has fewer columns than the
   * current schema — `policies` predates `type`, `condition`, `action`,
   * `applies_to_agent_ids` and `risk`, and migration 2 only tops up the handful it
   * was written for. Copying a hard-coded list from such a table fails with
   * "no such column", which aborts the whole upgrade: the operator's database stays
   * at version 2 and the product will not start.
   *
   * `server/test/migrations.test.ts` ("adopting a pre-migration database") is what
   * caught this, on a fixture built from the real historical DDL. Columns absent from
   * the source are simply not listed in the copy, so the rebuilt table supplies its
   * own default for them — which is the same value a fresh install would hold.
   */
  const live = schema.columns(table);
  const present = columns.filter((c) => live.has(c));
  const list = present.join(", ");
  return [
    `CREATE TABLE ${table}_tenanted (\n${ddlBody}\n)`,
    `INSERT INTO ${table}_tenanted (organization_id, ${list}) SELECT '${ORG}', ${list} FROM ${table}`,
    `DROP TABLE ${table}`,
    `ALTER TABLE ${table}_tenanted RENAME TO ${table}`,
  ];
}

const AGENT_COLUMNS = [
  "id", "name", "description", "provider", "model", "status", "current_task", "owner",
  "created_at", "executions_24h", "success_rate", "cost_24h", "cost_month", "risk_level",
  "permissions", "mandate", "policy_ids", "tags",
];

const POLICY_COLUMNS = [
  "id", "name", "description", "rule", "scope", "applies_to", "effect", "status",
  "triggered_count", "updated_at", "type", "condition", "action", "applies_to_agent_ids",
  "risk", "priority",
];

const EXECUTION_COLUMNS = [
  "id", "agent_id", "agent_name", "action", "target", "status", "risk", "duration_ms",
  "cost", "timestamp", "input", "decision", "decision_reason", "policy_evaluated",
  "policy_id", "result", "audit", "approval_id", "tool_id", "tool_executed_at",
  "tool_result", "run_state", "attempts", "last_error", "tool_started_at",
];

const APPROVAL_COLUMNS = [
  "id", "execution_id", "agent_id", "agent_name", "title", "summary", "requested_value",
  "policy_id", "policy_name", "policy_limit", "risk", "status", "requested_at",
  "resolved_by", "context",
];

const INTEGRATION_COLUMNS = [
  "id", "name", "category", "description", "connected", "scopes", "connected_at",
  "agents_using",
];

/**
 * The PostgreSQL tenancy migration (P0-4).
 *
 * This is where the two dialects genuinely diverge, and not for cosmetic reasons.
 * The SQLite path rebuilds five tables — create, copy, drop, rename — because
 * SQLite cannot alter a primary key. PostgreSQL can: a named primary-key
 * constraint is dropped and a composite one added in place. So the PostgreSQL
 * version is three statements per table instead of four plus a full data copy,
 * and it never holds two copies of the rows at once.
 *
 * Transcribing the rebuild dance onto PostgreSQL would have "worked" and would
 * have carried a limitation of SQLite into an engine that does not have it. That
 * is precisely the mechanical translation this migration was told not to be.
 *
 * The backfill uses `ADD COLUMN ... DEFAULT` and then `DROP DEFAULT`. The default
 * is what fills existing rows in one pass; dropping it immediately afterwards is
 * the important half. A permanent default on the tenant discriminator would mean
 * an INSERT that forgot the column silently lands in `org_default` — a
 * cross-tenant write caused by an omission, which is the failure mode this whole
 * migration exists to make impossible. Without the default, that INSERT fails.
 */
function postgresTenancy(schema: SchemaInspect): string[] {
  const out: string[] = [
    `CREATE TABLE IF NOT EXISTS organizations (
      id text NOT NULL,
      name text NOT NULL,
      created_at timestamptz NOT NULL,
      active boolean NOT NULL DEFAULT true,
      CONSTRAINT organizations_pkey PRIMARY KEY (id)
    )`,

    // `INSERT OR IGNORE` has no PostgreSQL equivalent; `ON CONFLICT DO NOTHING` is
    // the same intent expressed in the dialect's own terms.
    `INSERT INTO organizations (id, name, created_at, active)
       VALUES ('${ORG}', 'Default organization', '1970-01-01T00:00:00.000Z', true)
       ON CONFLICT (id) DO NOTHING`,
  ];

  /*
   * `active` is a real boolean here where SQLite stores 0/1 — same reasoning as
   * `integrations.connected` in migration 1.
   */
  const tenanted = ["agents", "policies", "executions", "approvals", "integrations"] as const;
  for (const table of tenanted) {
    if (schema.columns(table).has("organization_id")) continue;
    out.push(
      `ALTER TABLE ${table} ADD COLUMN organization_id text NOT NULL DEFAULT '${ORG}'`,
      `ALTER TABLE ${table} ALTER COLUMN organization_id DROP DEFAULT`,
      `ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`,
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (organization_id, id)`,
    );
  }

  /*
   * Sessions keep a single-column key for the reason in the header: a bearer token
   * is resolved before the organization is known. The tenant column is added but
   * the key is not touched — identical to the SQLite path, and the one place where
   * both dialects do the same thing for the same reason.
   */
  if (!schema.columns("sessions").has("organization_id")) {
    out.push(
      `ALTER TABLE sessions ADD COLUMN organization_id text NOT NULL DEFAULT '${ORG}'`,
      `ALTER TABLE sessions ALTER COLUMN organization_id DROP DEFAULT`,
    );
  }

  out.push(
    `DROP INDEX IF EXISTS idx_sessions_subject`,
    /*
     * The three execution indexes, recreated with the discriminator leading. The
     * measured justification for their column order is in migration 1 and is
     * unchanged: every tenant-scoped read leads with `organization_id = ?`, so an
     * index leading with the sort column cannot serve it.
     *
     * The SQLite versions are dropped rather than kept: they are now strictly
     * dominated by the tenant-leading ones, and each surviving index would cost a
     * write on every execution insert while serving no query the product issues.
     */
    `DROP INDEX IF EXISTS idx_executions_ts`,
    `DROP INDEX IF EXISTS idx_executions_agent_ts`,
    `DROP INDEX IF EXISTS idx_executions_spend`,
    `CREATE INDEX IF NOT EXISTS idx_executions_org_ts ON executions (organization_id, "timestamp")`,
    `CREATE INDEX IF NOT EXISTS idx_executions_org_agent_ts ON executions (organization_id, agent_id, "timestamp")`,
    `CREATE INDEX IF NOT EXISTS idx_executions_org_spend ON executions (organization_id, agent_id, status, "timestamp", cost)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_org_subject ON sessions (organization_id, subject)`,
    `CREATE INDEX IF NOT EXISTS idx_approvals_org_status_ts ON approvals (organization_id, status, requested_at)`,
  );

  return out;
}

export const tenancy: Migration = {
  version: 3,
  name: "tenancy",
  statements(schema: SchemaInspect): string[] {
    if (schema.dialect === "postgres") return postgresTenancy(schema);

    const out: string[] = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      )`,

      /*
       * Created unconditionally, including on a brand new database, so every
       * deployment has at least one organization from its first boot. Nothing then
       * has to handle "no organization exists yet" — a state that would otherwise
       * need a special case inside authentication, which is the last place that
       * should contain special cases.
       */
      `INSERT OR IGNORE INTO organizations (id, name, created_at, active)
         VALUES ('${ORG}', 'Default organization', '1970-01-01T00:00:00.000Z', 1)`,
    ];

    /*
     * The rebuilds. Guarded on the column being absent so the migration is safe to
     * reason about in isolation, even though the runner already guarantees it runs
     * exactly once.
     */
    if (!schema.columns("agents").has("organization_id")) {
      out.push(
        ...rebuild(
          schema,
          "agents",
          `        organization_id TEXT NOT NULL,
        id TEXT NOT NULL,
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
        tags TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (organization_id, id)`,
          AGENT_COLUMNS,
        ),
      );
    }

    if (!schema.columns("policies").has("organization_id")) {
      out.push(
        ...rebuild(
          schema,
          "policies",
          `        organization_id TEXT NOT NULL,
        id TEXT NOT NULL,
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
        priority INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (organization_id, id)`,
          POLICY_COLUMNS,
        ),
      );
    }

    if (!schema.columns("executions").has("organization_id")) {
      out.push(
        ...rebuild(
          schema,
          "executions",
          `        organization_id TEXT NOT NULL,
        id TEXT NOT NULL,
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
        tool_started_at TEXT,
        PRIMARY KEY (organization_id, id)`,
          EXECUTION_COLUMNS,
        ),
      );
    }

    if (!schema.columns("approvals").has("organization_id")) {
      out.push(
        ...rebuild(
          schema,
          "approvals",
          `        organization_id TEXT NOT NULL,
        id TEXT NOT NULL,
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
        context TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (organization_id, id)`,
          APPROVAL_COLUMNS,
        ),
      );
    }

    if (!schema.columns("integrations").has("organization_id")) {
      out.push(
        ...rebuild(
          schema,
          "integrations",
          `        organization_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        connected INTEGER NOT NULL DEFAULT 0,
        scopes TEXT NOT NULL DEFAULT '[]',
        connected_at TEXT,
        agents_using INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (organization_id, id)`,
          INTEGRATION_COLUMNS,
        ),
      );
    }

    /*
     * Sessions are altered, not rebuilt — see the header for why the primary key
     * stays on `id` alone.
     */
    if (!schema.columns("sessions").has("organization_id")) {
      out.push(`ALTER TABLE sessions ADD COLUMN organization_id TEXT NOT NULL DEFAULT '${ORG}'`);
    }

    /*
     * Indexes. The rebuilt tables lost theirs with the DROP, and they would have been
     * the wrong shape anyway: every tenant-scoped read now leads with
     * `organization_id = ?`, which an index leading with `timestamp` cannot serve.
     * Recreated with the discriminator first, preserving the access patterns the
     * measurements in migration 1 were taken against.
     */
    out.push(
      `DROP INDEX IF EXISTS idx_sessions_subject`,

      /*
       * The console timeline: equality on the tenant, then the sort column. Same
       * shape as the old `idx_executions_ts` with the discriminator prepended, so the
       * plan stays a single index scan in `timestamp` order — restricted to one
       * tenant instead of scanning every tenant's rows (187.3 ms -> 4.8 ms, measured
       * in migration 1 on 145 600 rows).
       */
      `CREATE INDEX IF NOT EXISTS idx_executions_org_ts ON executions (organization_id, timestamp)`,

      // "This agent's executions, newest first", within one tenant.
      `CREATE INDEX IF NOT EXISTS idx_executions_org_agent_ts ON executions (organization_id, agent_id, timestamp)`,

      /*
       * The daily-spend index. This query runs INSIDE the decision transaction, so it
       * is on the critical path of every governed action. Equalities first (tenant,
       * agent, status), the range last, `cost` appended to keep the index COVERING —
       * the shape that measured 21.4x faster than the naive one.
       */
      `CREATE INDEX IF NOT EXISTS idx_executions_org_spend ON executions (organization_id, agent_id, status, timestamp, cost)`,

      // Listing and revoking sessions always happens within one tenant.
      `CREATE INDEX IF NOT EXISTS idx_sessions_org_subject ON sessions (organization_id, subject)`,

      /*
       * Approvals are listed with every pending row included and resolved history
       * capped, so tenant and status are both equalities and `requested_at` is the
       * sort. See `ApprovalRepository.list` for why that asymmetry is load-bearing.
       */
      `CREATE INDEX IF NOT EXISTS idx_approvals_org_status_ts ON approvals (organization_id, status, requested_at)`,
    );

    /*
     * No index is created for `agents`, `policies` or `integrations`: the composite
     * primary key already leads with `organization_id`, so SQLite serves
     * "everything in this tenant" from the key itself. Adding a second index on the
     * same leading column would cost a write on every insert and serve no query.
     */

    return out;
  },
};
