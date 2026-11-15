/**
 * Migration 8 — the identity half of P2: `identity_tokens`, and `suspended_at`
 * on `memberships`.
 *
 * ## Why a table called `identity_tokens` and not `invitations`
 *
 * The roadmap named this table `invitations`. It is named `identity_tokens` here
 * because it holds two things, and only one of them is an invitation:
 *
 *   - `purpose = 'invite'` — a person who has no account yet is offered one, in
 *     one organization, with one role.
 *   - `purpose = 'reset'`  — a person who already has an account is given one
 *     chance to replace a password they can no longer use.
 *
 * They share every mechanical property (single use, expiring, hashed at rest,
 * bound to one organization) and differ only in what accepting them does. Two
 * tables would duplicate the expiry, the replay guard and the revocation logic,
 * and the second copy is where the bug would live. A single table called
 * `invitations` that stores password resets would be a schema that lies, and the
 * next person to read it would believe it.
 *
 * ## Why the secret is hashed, and what the token actually is
 *
 * The token handed to a person is `<id>.<secret>`: an unguessable row id and 32
 * random bytes. Only `sha256(secret)` is stored. A database read out of a backup,
 * a log, or a support export therefore yields nothing that can be presented — the
 * same property that keeps `api_keys.secret_hash` and `users.password_hash`
 * useless to a reader. There is no column here that can be turned back into a
 * credential.
 *
 * A row is looked up by `id` rather than by the digest, which is why `id` carries
 * a `UNIQUE`-by-primary-key guarantee and no index on the digest exists: the
 * digest is only ever *compared*, never searched. That comparison is
 * constant-time in `server/repositories/identity-tokens.ts`.
 *
 * ## Why `organization_id` is NOT NULL, including for a reset
 *
 * Every other tenant table in this schema carries the column, and the structural
 * isolation barriers added in P3 judge a statement against the set of tables that
 * have it. A nullable tenant column would create a class of row that those
 * barriers cannot reason about, which is a worse outcome than requiring the
 * caller to say which organization a reset belongs to. A reset is issued by an
 * administrator of one organization for one of *its* members, so the value is
 * always known at the moment of issue.
 *
 * ## Why `suspended_at` on `memberships` rather than `users`
 *
 * `users.status` already exists and is already honoured by `login` and by
 * `credentialStillValid`. It is deployment-wide: suspending it locks the person
 * out of every organization they belong to. That is the wrong tool for "this
 * contractor is off our project", because a shared-account user working for two
 * customers would be cut off from both by one customer's decision — a tenant
 * reaching into another tenant. Suspension therefore belongs on the relationship,
 * exactly as `role` already does.
 *
 * Additive and reversible: dropping the table and the column returns the database
 * to version 7 with no data loss anywhere else.
 */

import type { Migration, SchemaInspect } from "./types";

export const IDENTITY_TOKENS_TABLE = "identity_tokens";

export const identity: Migration = {
  version: 8,
  name: "identity",
  statements(schema: SchemaInspect): string[] {
    const out: string[] = [];

    if (!schema.tableExists(IDENTITY_TOKENS_TABLE)) {
      if (schema.dialect === "sqlite") {
        out.push(
          `CREATE TABLE IF NOT EXISTS ${IDENTITY_TOKENS_TABLE} (
             id            TEXT PRIMARY KEY,
             organization_id TEXT NOT NULL,
             purpose       TEXT NOT NULL,
             email         TEXT NOT NULL,
             role          TEXT NOT NULL,
             secret_hash   TEXT NOT NULL,
             created_at    TEXT NOT NULL,
             created_by    TEXT NOT NULL,
             expires_at    TEXT NOT NULL,
             consumed_at   TEXT,
             consumed_by   TEXT,
             revoked_at    TEXT,
             revoked_by    TEXT
           )`,
          /*
           * The inventory read is "every token of this organization, newest
           * first", so the index matches that shape rather than indexing the
           * organization alone. Nothing queries the digest, so nothing indexes it.
           */
          `CREATE INDEX IF NOT EXISTS idx_identity_tokens_org
             ON ${IDENTITY_TOKENS_TABLE} (organization_id, created_at)`,
        );
      } else {
        out.push(
          `CREATE TABLE IF NOT EXISTS ${IDENTITY_TOKENS_TABLE} (
             id            text PRIMARY KEY,
             organization_id text NOT NULL,
             purpose       text NOT NULL,
             email         text NOT NULL,
             role          text NOT NULL,
             secret_hash   text NOT NULL,
             created_at    timestamptz NOT NULL,
             created_by    text NOT NULL,
             expires_at    timestamptz NOT NULL,
             consumed_at   timestamptz,
             consumed_by   text,
             revoked_at    timestamptz,
             revoked_by    text
           )`,
          `CREATE INDEX IF NOT EXISTS idx_identity_tokens_org
             ON ${IDENTITY_TOKENS_TABLE} (organization_id, created_at)`,
        );
      }
    }

    /*
     * Conditional for the same reason migration 2 is: a database created by an
     * earlier build has the column missing, and neither engine offers
     * `ADD COLUMN IF NOT EXISTS` in a form both dialects share. On a database that
     * this build's baseline just created the column is already present and this
     * emits nothing, which the ledger records as a statement that ran and did
     * nothing rather than as a migration that was skipped.
     */
    if (schema.tableExists("memberships") && !schema.columns("memberships").has("suspended_at")) {
      out.push(`ALTER TABLE memberships ADD COLUMN suspended_at ${schema.dialect === "sqlite" ? "TEXT" : "timestamptz"}`);
    }

    return out;
  },
};
