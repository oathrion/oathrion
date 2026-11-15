/**
 * The action-authority cross-tenant attacks of `helpers/authority-tenant-attacks.ts`,
 * run against a REAL PostgreSQL server, in a throwaway database created for this run.
 *
 * Availability:
 *   - reachable                        → the attacks run;
 *   - unreachable                      → SKIPPED (visible in the summary, never a pass);
 *   - unreachable + OATHRION_REQUIRE_POSTGRES=true → this file FAILS.
 *
 *   OATHRION_TEST_PG_URL=postgres://user:pass@host:5432/postgres OATHRION_REQUIRE_POSTGRES=true \
 *     npx vitest run server/test/multitenant-authority-postgres.test.ts
 */

import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { MIGRATIONS, migratePostgres } from "../migrations";
import { postgresExecutor } from "../sql/executor";
import { defineAuthorityTenantAttacks } from "./helpers/authority-tenant-attacks";

const BASE = process.env.OATHRION_TEST_PG_URL ?? "";
const REQUIRED = process.env.OATHRION_REQUIRE_POSTGRES === "true";

async function reachable(): Promise<boolean> {
  if (!BASE) return false;
  const probe = new Pool({ connectionString: BASE, max: 1, connectionTimeoutMillis: 2_000 });
  probe.on("error", () => undefined);
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

const available = await reachable();
if (!available && REQUIRED) {
  throw new Error(
    "OATHRION_REQUIRE_POSTGRES=true but OATHRION_TEST_PG_URL is unset or unreachable: the PostgreSQL " +
      "multi-tenant authority attacks cannot be reported as verified.",
  );
}

if (!available) {
  describe.skip("multi-tenant authority on PostgreSQL (SKIPPED: no server reachable)", () => {
    it("was not verified", () => expect(true).toBe(true));
  });
} else {
  defineAuthorityTenantAttacks("postgres", async () => {
    const name = `oathrion_mt_${process.pid}_${Date.now().toString(36)}`;
    const admin = new Pool({ connectionString: BASE, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(BASE);
    url.pathname = `/${name}`;
    await migratePostgres(url.toString(), MIGRATIONS);
    const pool = new Pool({ connectionString: url.toString(), max: 8 });
    pool.on("error", () => undefined);
    return {
      executor: postgresExecutor(pool),
      cleanup: async () => {
        await pool.end().catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      },
    };
  });

  describe("migration 16 on PostgreSQL", () => {
    it("keys action_policies on (organization_id, id)", async () => {
      const name = `oathrion_m16_${process.pid}_${Date.now().toString(36)}`;
      const admin = new Pool({ connectionString: BASE, max: 1 });
      admin.on("error", () => undefined);
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(BASE);
      url.pathname = `/${name}`;
      try {
        await migratePostgres(url.toString(), MIGRATIONS);
        const pool = new Pool({ connectionString: url.toString(), max: 1 });
        const { rows } = await pool.query(
          `SELECT a.attname AS column
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'action_policies'::regclass AND i.indisprimary
            ORDER BY array_position(i.indkey, a.attnum)`,
        );
        await pool.end();
        expect(rows.map((r: { column: string }) => r.column)).toEqual(["organization_id", "id"]);
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
    });
  });
}
