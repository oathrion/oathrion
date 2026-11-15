/**
 * Migration 5 — API keys in the database.
 *
 * ## What this replaces
 *
 * `resolveBearer` looped over every entry of `OATHRION_API_KEYS` and compared the presented
 * credential to each plaintext. That has four defects, and only the first is about
 * hashing:
 *
 *   1. **The keys were stored in clear.** Whoever can read the environment — a platform
 *      dashboard, a config dump, a backup of a `.env`, a misdirected screenshot — holds
 *      working credentials for the agents' gateway.
 *   2. **Nothing could be revoked.** A leaked key stayed valid until someone edited a
 *      file and restarted the process. For a plane of control over autonomous agents,
 *      "restart the server to cut off a compromised agent" is not an incident response.
 *   3. **Nothing could be issued.** A customer could not create a key for a new
 *      integration without the vendor's help, so the console's "API keys" tab showed
 *      three fabricated rows and a disabled "coming soon" button.
 *   4. **No key had a history.** Not when it was created, by whom, when it was last
 *      used, or whether it had ever been used at all — so "is this key still needed?"
 *      and "did the key we rotated away from stop being called?" were unanswerable.
 *
 * ## Shape, and why resolution is the one unscoped read
 *
 * `api_keys` is tenant-scoped — a key belongs to exactly one organization, unlike a user,
 * who may belong to several. But the primary key is `id` alone rather than
 * `(organization_id, id)`, which departs from the pattern migration 3 established for
 * agents, policies and executions. The reason is the same one that keeps `sessions`
 * single-keyed: a credential arrives with nothing but its own bytes, so the read that
 * turns it into an identity cannot be filtered by a tenant it has not determined yet.
 * That read is `WHERE secret_hash = ?`, and it *produces* the organization. Every other
 * access — listing, revoking, renaming — is scoped, and the repository enforces it.
 *
 * ## Why `secret_hash` is UNIQUE
 *
 * Two rows with the same digest would mean one credential resolving to two identities,
 * possibly in two different tenants, with the winner decided by row order. That is the
 * exact failure the boot-time duplicate-secret refusal exists to prevent for configured
 * credentials; here the engine enforces it, so no code path can create it.
 *
 * The digest is also the lookup key on the hot path, so the constraint's index is the
 * index the authentication query needs. One structure, two purposes, no redundancy.
 *
 * ## No data is migrated
 *
 * There is nothing to read: keys existed only in the environment. Adoption happens at
 * boot in `server/auth.ts`, for the reason given in migration 4 — a migration that read
 * `process.env` would produce different databases on two hosts running the same build.
 */

import type { Migration, SchemaInspect } from "./types";

export const apiKeys: Migration = {
  version: 5,
  name: "api-keys",
  statements(schema: SchemaInspect): string[] {
    if (schema.dialect === "postgres") {
      return [
        /*
         * The PostgreSQL key store (P0-4).
         *
         * `secret_hash` keeps its inline UNIQUE: it is the constraint that makes one
         * credential resolve to exactly one identity, and it is also the index the
         * authentication query uses. Both properties matter on both engines.
         *
         * The digest stays `text` (the `sha256$<hex>` envelope) rather than becoming
         * `bytea`, so the stored value is byte-identical across engines and a key
         * adopted from `OATHRION_API_KEYS` resolves the same way on either — which is
         * what the parity tests assert.
         */
        `CREATE TABLE IF NOT EXISTS api_keys (
          id text NOT NULL,
          organization_id text NOT NULL,
          name text NOT NULL,
          role text NOT NULL,
          secret_hash text NOT NULL UNIQUE,
          prefix text NOT NULL,
          source text NOT NULL DEFAULT 'user',
          created_at timestamptz NOT NULL,
          created_by text NOT NULL,
          expires_at timestamptz,
          last_used_at timestamptz,
          revoked_at timestamptz,
          revoked_by text,
          revoked_reason text,
          CONSTRAINT api_keys_pkey PRIMARY KEY (id)
        )`,

        `CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys (organization_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_api_keys_source ON api_keys (source, organization_id)`,
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT,
        revoked_by TEXT,
        revoked_reason TEXT
      )`,

      /*
       * The console lists one organization's keys, newest first. Without this index that
       * page scans every key in the deployment and then sorts — and it is a page an
       * administrator opens precisely when they are in a hurry, during a rotation.
       */
      `CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys (organization_id, created_at DESC)`,

      /*
       * Boot-time adoption asks "which keys did the environment create?" so that a line
       * deleted from `OATHRION_API_KEYS` can be revoked while a key issued through the
       * product is left alone. That question is asked once per start, but it is asked
       * before the server accepts traffic, so it stays off the table-scan path.
       */
      `CREATE INDEX IF NOT EXISTS idx_api_keys_source ON api_keys (source, organization_id)`,
    ];
  },
};
