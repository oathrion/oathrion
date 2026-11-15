/**
 * Migration 4 — real user accounts.
 *
 * ## What this replaces
 *
 * Console sign-in matched a plaintext password from `OATHRION_CONSOLE_USERS` against
 * every configured entry, with no username. Three consequences, all of them
 * commercial blockers rather than refinements:
 *
 *   1. The password was readable wherever the environment is readable, and the
 *      person it belongs to could not change it.
 *   2. Two users could not share a password without one silently receiving the
 *      other's identity and role — the reason `build()` has to refuse duplicate
 *      secrets at boot. With a username there is nothing to collide.
 *   3. Removing someone meant editing a file and restarting the server.
 *
 * ## Shape
 *
 * `users` is not tenant-scoped; `memberships` is what binds a person to an
 * organization and a role. The reasoning is in `shared/schema.ts` next to the
 * declarations, and it is the same reasoning that keeps `sessions` unscoped for
 * token resolution: a sign-in cannot be filtered by a tenant it has not yet
 * determined.
 *
 * ## Why the e-mail uniqueness index is separate from the column
 *
 * SQLite creates an implicit index for `UNIQUE` in a column definition, but the
 * name is generated and therefore not something a later migration can rely on. The
 * constraint is declared inline (it must be enforced by the engine, not by
 * application code that a future caller can bypass) and a named index is created
 * for the case-folded lookup path. Both exist on purpose.
 *
 * ## No data is migrated here
 *
 * There is nothing to migrate: no user table existed. Adoption of the configured
 * console users happens at boot in `server/auth.ts`, not in a migration, because it
 * depends on the environment rather than on the database — a migration that read
 * `process.env` would produce a different schema on two hosts running the same
 * version, which is exactly what a versioned ledger exists to prevent.
 */

import type { Migration, SchemaInspect } from "./types";

export const users: Migration = {
  version: 4,
  name: "users",
  statements(schema: SchemaInspect): string[] {
    if (schema.dialect === "postgres") {
      return [
        /*
         * The PostgreSQL user store (P0-4). Timestamps become `timestamptz`; the
         * hash stays `text` (it is the printable `scrypt$N$r$p$salt$hash` envelope,
         * not raw bytes, so `bytea` would mean parsing a format the SQLite path
         * stores verbatim — a divergence for no gain).
         *
         * `email` carries an inline UNIQUE, and the case-folded unique index is
         * created separately, for the same reason as on SQLite: the constraint must
         * be enforced by the engine, and the lookup path uses `lower(email)`, which
         * the plain constraint's index cannot serve. PostgreSQL supports expression
         * indexes natively, so this is one of the few places the DDL is identical.
         */
        `CREATE TABLE IF NOT EXISTS users (
          id text NOT NULL,
          email text NOT NULL UNIQUE,
          name text NOT NULL,
          password_hash text NOT NULL,
          password_updated_at timestamptz NOT NULL,
          password_source text NOT NULL DEFAULT 'config',
          status text NOT NULL DEFAULT 'active',
          created_at timestamptz NOT NULL,
          last_login_at timestamptz,
          CONSTRAINT users_pkey PRIMARY KEY (id)
        )`,

        `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email))`,

        `CREATE TABLE IF NOT EXISTS memberships (
          organization_id text NOT NULL,
          user_id text NOT NULL,
          role text NOT NULL,
          created_at timestamptz NOT NULL,
          CONSTRAINT memberships_pkey PRIMARY KEY (organization_id, user_id)
        )`,

        `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id)`,
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_updated_at TEXT NOT NULL,
        password_source TEXT NOT NULL DEFAULT 'config',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_login_at TEXT
      )`,

      /*
       * Sign-in looks up a lower-cased address, so the index is on the same
       * expression the query uses. An index on `email` alone would be ignored by a
       * `lower(email) = ?` predicate, and the lookup would degrade to a table scan
       * on the one code path an unauthenticated caller can reach — which is also
       * the path a brute-force attempt hammers.
       */
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email))`,

      `CREATE TABLE IF NOT EXISTS memberships (
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, user_id)
      )`,

      /*
       * The primary key answers "who is in this organization"; this index answers
       * "which organizations is this person in", which is the question sign-in asks.
       * Without it that lookup scans every membership in the deployment.
       */
      `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id)`,
    ];
  },
};
