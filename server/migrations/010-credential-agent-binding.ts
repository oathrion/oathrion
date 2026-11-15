/**
 * Migration 10 — `agent_id` on `api_keys`.
 *
 * ## The hole this closes
 *
 * Until now the agent a request acted as came from the request: the `agentId`
 * field of `/api/decision`, `/api/execute`, `/api/evaluate` and
 * `POST /api/executions`, or the `X-Oathrion-Agent-Id` header on the MCP endpoint.
 * The credential decided the *tenant* and the *role*; it said nothing about
 * *which agent*. So any credential holding `execute` could act as any agent in
 * its organisation, simply by naming a different one.
 *
 * That matters because Oathrion's whole authorisation model is per-agent. A policy
 * that holds `agt_billing` to a 500 EUR refund ceiling is not a control if a
 * credential issued for `agt_billing` can present itself as `agt_finance`
 * instead. Every mandate, every permission set and every per-agent policy was
 * one header away from being someone else's.
 *
 * This column is the server-side half of the fix: a credential may be pinned to
 * exactly one agent, and from then on the agent is *derived* from the credential
 * rather than accepted from the caller. The enforcement lives in
 * `server/identity/agent-binding.ts`; this file only gives it somewhere to read
 * the answer from.
 *
 * ## Why the column is nullable, and why that is not a weakening
 *
 * `NOT NULL` was considered and rejected. It cannot be applied without inventing
 * an agent for every credential that already exists, and two whole classes of
 * credential have no agent to invent:
 *
 *   - **console sessions.** A signed-in administrator is a human operating the
 *     control plane. Pinning a person to one agent is not a security property,
 *     it is a bug: an administrator has to be able to see and act across the
 *     agents they administer. Sessions do not read this column at all.
 *   - **existing API keys.** Every key in every deployed database predates this
 *     column. A `NOT NULL DEFAULT '<something>'` would silently bind live
 *     credentials to an agent nobody chose — a destructive change disguised as a
 *     schema tweak, and one that would take effect on the next request.
 *
 * So the column is nullable and no data is rewritten. `NULL` means "this
 * credential is not pinned", which is precisely the state every existing key is
 * already in. Nothing is migrated, nothing is revoked, nothing changes behaviour
 * for a row this migration touches — because it touches none.
 *
 * What stops `NULL` from being a permanent bypass is the enforcement policy, not
 * the schema: `OATHRION_REQUIRE_AGENT_BINDING=true` refuses an unpinned *service*
 * credential outright. That switch is off by default for the reason above —
 * turning it on by default would break every existing deployment on upgrade —
 * and it is exercised by tests in both positions. The honest summary is in
 * PHASE-6-REPORT.md §5 and §18, and it is not "binding is mandatory".
 *
 * ## Why there is no foreign key to `agents`
 *
 * Two reasons, and the second is the one that decides it.
 *
 * First, `agents` is keyed `(organization_id, id)` since migration 3, so a
 * single-column reference could not express the relationship anyway; a composite
 * FK would need `organization_id` duplicated into the constraint, which it
 * already is on the row.
 *
 * Second, and more important: a foreign key would make the *database* the thing
 * that decides whether a binding is valid, and it would decide it only at write
 * time. The property that actually has to hold is at *read* time, on every
 * request — "does this agent still exist, in this tenant, right now". That check
 * runs through the tenant-scoped agent repository, which cannot see another
 * organisation's rows at all, so a binding naming a foreign agent resolves to
 * "not found" and the request is refused. An FK would add a write-time guarantee
 * that is already enforced at issue time, while leaving the read-time one to be
 * written anyway. It would also turn agent deletion into a schema-level error
 * instead of a refusal the audit trail can record.
 *
 * ## Index
 *
 * `idx_api_keys_agent` supports "which credentials are pinned to this agent?",
 * scoped by organisation first because every such read is tenant-scoped.
 *
 * Stated plainly: **no query in this build uses it yet.** The authentication
 * path reads by `secret_hash`, and the console lists by organisation; neither
 * touches this index. It is created here because it belongs with the column and
 * because adding an index to a live `api_keys` table later is a lock on the
 * table every request authenticates against — but it is unused today, and
 * calling it "supports the console" would be a claim about code that does not
 * exist.
 *
 * Additive and reversible: dropping the column returns the database to
 * version 9 with no loss anywhere else.
 */

import type { Migration, SchemaInspect } from "./types";

export const credentialAgentBinding: Migration = {
  version: 10,
  name: "credential-agent-binding",
  statements(schema: SchemaInspect): string[] {
    const out: string[] = [];
    if (!schema.tableExists("api_keys")) return out;

    const columns = schema.columns("api_keys");

    /*
     * Guarded by the column check rather than by the migration having run, so a
     * partially-migrated database converges instead of failing on a duplicate
     * column. Same shape on both engines: the value is an opaque agent id, and
     * keeping the storage type identical is what lets the parity tests compare
     * a SQLite row and a PostgreSQL row field by field.
     */
    if (!columns.has("agent_id")) {
      out.push(`ALTER TABLE api_keys ADD COLUMN agent_id text`);
    }

    /*
     * Deliberately no UPDATE. Every existing key stays unpinned, which is the
     * state it is already in — see the header. A migration that guessed a
     * binding would be changing what live credentials are allowed to do, which
     * is not something a schema version should be able to do silently.
     */

    out.push(
      `CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys (organization_id, agent_id)`,
    );

    return out;
  },
};
