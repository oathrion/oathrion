/**
 * PostgreSQL schema, migration and transaction tests (P0-4) — against a real server.
 *
 * These run against a live PostgreSQL instance, not a mock. A mocked driver would
 * assert that we send the SQL we think we send, which is not the question: the
 * question is whether PostgreSQL accepts it and produces the schema we claim.
 *
 * PHASE 9 DEFECT P9-1 — THESE TESTS USED TO REPORT A VACUOUS PASS
 * ---------------------------------------------------------------
 * The header used to say the file skips loudly, and PHASE-8-REPORT.md section 1
 * went further: it claimed these tests contain no skipIf and that without a
 * reachable PostgreSQL server they fail rather than fall silent.
 *
 * Both statements were false, and the second inverted the truth. Every test body
 * began with an early RETURN when no pool was available - not a skip and not a
 * failure. On a machine with no PostgreSQL, vitest therefore counted all 21 of
 * them as PASSED while executing not one line of PostgreSQL. The only trace was
 * a console.warn in beforeAll, invisible in a CI summary. So the headline 1756
 * passed was reachable with zero PostgreSQL coverage, and the Phase 8 report
 * cited that number as proof of a real run against PostgreSQL 18.6.
 *
 * Measured, not inferred: this file reported 21 passed against an empty port
 * during the Phase 9 baseline. That is precisely the class of evidence the
 * Phase 9 brief forbids - a report saying PASS where nothing ran.
 *
 * WHAT IT DOES NOW
 * ----------------
 * Availability is probed once, at module scope, before collection. Then:
 *
 *   - reachable: the tests run, exactly as before;
 *   - unreachable: describe.skipIf marks them SKIPPED, counted in the skipped
 *     total, so the suite summary itself tells the reader the PostgreSQL path
 *     was not exercised. It can no longer be mistaken for a pass;
 *   - unreachable AND OATHRION_REQUIRE_POSTGRES=true: the probe throws, so the file
 *     FAILS. That is the switch a release run sets, and npm run verify:postgres
 *     sets it, so the claim that the PostgreSQL evidence is real becomes a
 *     property of the command rather than of the machine it happened to run on.
 *
 * npm run smoke:postgres already failed hard rather than skipping; unchanged.
 */

import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  createSqliteMigrationDriver,
  LATEST_VERSION,
  MIGRATIONS,
  migrationHistory,
  migratePostgres,
  createPostgresMigrationDriver,
  runMigrations,
  runMigrationsAsync,
  RATE_LIMIT_TABLE,
  INSPECTED_TABLES,
} from "../migrations";
import Database from "better-sqlite3";

const BASE_URL = process.env.OATHRION_TEST_PG_URL ?? "postgres://user@localhost:55432/postgres";
/** A database per run, so a leftover from a previous run can never make this pass. */
const DB_NAME = `oathrion_pgtest_${process.pid}_${Date.now().toString(36)}`;

function urlFor(database: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Silences the one error a force-drop is guaranteed to produce, and nothing else.
 *
 * `DROP DATABASE ... WITH (FORCE)` tells PostgreSQL to terminate every backend
 * still attached to that database. `pool.end()` resolves when the pool has asked
 * its sockets to close, which is not the same instant as the server finishing
 * with them, so a force-drop issued immediately afterwards can still race a
 * connection that is mid-shutdown. The backend then reports 57P01,
 * "terminating connection due to administrator command" — on a pool nobody is
 * awaiting any more, which makes it an UNHANDLED error. Vitest reports it and
 * warns that unhandled errors can cause false positives, which is exactly the
 * kind of noise that trains a reader to ignore a failing suite.
 *
 * We are the administrator that issued the command, so 57P01 here is expected.
 * The handler is deliberately narrow: any other pool error is re-thrown rather
 * than swallowed, because a blanket `pool.on("error", () => {})` in a test
 * suite would hide the connection failures worth knowing about.
 */
function ignoreForcedTermination(target: Pool): Pool {
  target.on("error", (error: Error & { code?: string }) => {
    if (error.code === "57P01") return;
    throw error;
  });
  return target;
}

/** Redacts the password before any connection string reaches a log line. */
function safeUrl(raw: string): string {
  return raw.replace(/:[^:@/]*@/, ":***@");
}

/**
 * Whether this run demands real PostgreSQL evidence.
 *
 * Only the exact string enables it, as everywhere else in this codebase. A run
 * that did not ask for PostgreSQL is not punished for not having it; a run that
 * did ask cannot be told "nothing to check".
 */
function postgresRequired(): boolean {
  return process.env.OATHRION_REQUIRE_POSTGRES === "true";
}

/*
 * Probed at module scope, before collection, so the result can drive
 * `describe.skipIf`. Inside `beforeAll` it is already too late: the tests have
 * been collected, and the only remaining options are to pass vacuously - which
 * is defect P9-1 - or to fail on a machine that was never asked to have
 * PostgreSQL at all.
 */
let available = false;
let unavailableReason = "";
let pool: Pool | undefined;

{
  const admin = new Pool({ connectionString: BASE_URL, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    await admin.query("SELECT 1");
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    available = true;
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
  } finally {
    await admin.end();
  }

  if (available) {
    pool = ignoreForcedTermination(new Pool({ connectionString: urlFor(DB_NAME), max: 4 }));
  } else if (postgresRequired()) {
    /*
     * Thrown at module scope on purpose: it makes the whole file a load error,
     * which vitest reports as a FAILURE of this file rather than as 21 skipped
     * tests. A release run must not be able to read "no server" as "nothing to
     * check".
     */
    throw new Error(
      `OATHRION_REQUIRE_POSTGRES=true but no PostgreSQL is reachable at ${safeUrl(BASE_URL)} ` +
        `(${unavailableReason}). Refusing to report the PostgreSQL tests as skipped in a run ` +
        `that asked for them.`,
    );
  } else {
    console.warn(
      `\n[postgres.test] SKIPPED: no PostgreSQL reachable at ${safeUrl(BASE_URL)} ` +
        `(${unavailableReason}).\n` +
        `           The PostgreSQL path was NOT exercised in this run. These tests are reported\n` +
        `           as SKIPPED, not as passed - see defect P9-1 in the file header. Set\n` +
        `           OATHRION_REQUIRE_POSTGRES=true to make this a failure instead; the\n` +
        `           npm run verify:postgres script does exactly that.\n`,
    );
  }
}

afterAll(async () => {
  await pool?.end();
  if (!available) return;
  const admin = new Pool({ connectionString: BASE_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}, 30_000);

/**
 * The pool, for tests that only run when there is one.
 *
 * Phase 9: this used to return `undefined` when no server was reachable, and
 * every test opened with `if (pg() === undefined) return;`. That early return is
 * what produced defect P9-1 - 21 tests reported as PASSED without touching
 * PostgreSQL. The guard now lives one level up, in `describe.skipIf(!available)`,
 * where vitest can account for it honestly.
 *
 * So by the time a test body runs, a pool exists. If it somehow does not, that
 * is a bug in the skip condition and it throws rather than quietly returning a
 * pass - the failure direction matters more here than the message.
 */
const pg = (): Pool => {
  if (!available || pool === undefined) {
    throw new Error(
      "postgres.test: a test body ran with no pool. describe.skipIf(!available) should have " +
        "skipped it. Refusing to pass vacuously (see defect P9-1 in the file header).",
    );
  }
  return pool;
};

/**
 * True when the PostgreSQL suites must not run.
 *
 * Named rather than inlined so the reason shows up at each `describe`, and so
 * the meta-test below can assert that every PostgreSQL suite is guarded by it.
 */
const NO_POSTGRES = !available;

describe.skipIf(NO_POSTGRES)("PostgreSQL migrations", () => {
  it("brings an empty database to the latest version", async () => {
    const result = await migratePostgres(urlFor(DB_NAME), MIGRATIONS);
    expect(result.version).toBe(LATEST_VERSION);
    expect(result.baselined).toBe(false);
    expect(result.applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
  }, 30_000);

  it("is idempotent: a second run applies nothing and changes nothing", async () => {
    const p = pg();
    if (p === undefined) return;
    const before = await p.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = current_schema()
        ORDER BY table_name, column_name`,
    );

    const result = await migratePostgres(urlFor(DB_NAME), MIGRATIONS);
    expect(result.applied).toEqual([]);
    expect(result.version).toBe(LATEST_VERSION);

    const after = await p.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = current_schema()
        ORDER BY table_name, column_name`,
    );
    expect(after.rows).toEqual(before.rows);
  }, 30_000);

  it("creates every table the SQLite schema has, plus the shared limiter table", async () => {
    const p = pg();
    if (p === undefined) return;
    const rows = await p.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    const tables = new Set(rows.rows.map((r) => r.table_name));
    for (const expected of [
      "agents",
      "policies",
      "executions",
      "approvals",
      "sessions",
      "integrations",
      "organizations",
      "users",
      "memberships",
      "api_keys",
      "schema_migrations",
      RATE_LIMIT_TABLE,
    ]) {
      expect(tables.has(expected), `missing table ${expected}`).toBe(true);
    }
  });

  /*
   * The type conversions are the substance of P0-4. Each of these was a decision, so
   * each is pinned: a later "tidy-up" that turns a timestamptz back into text, or a
   * boolean back into an integer, fails here rather than in production.
   */
  it("converted timestamps to timestamptz rather than keeping ISO strings", async () => {
    const p = pg();
    if (p === undefined) return;
    const rows = await p.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name IN ('created_at','updated_at','expires_at','requested_at','last_seen_at',
                              'revoked_at','last_used_at','password_updated_at','last_login_at',
                              'connected_at','tool_executed_at','tool_started_at','reset_at','timestamp')`,
    );
    for (const row of rows.rows) {
      // The ledger's `applied_at` is text on both engines on purpose — the comment on
      // `ledgerDdl` says why — and it is the one exception.
      if (row.table_name === "schema_migrations") continue;
      expect(row.data_type, `${row.table_name}.${row.column_name}`).toBe("timestamp with time zone");
    }
    expect(rows.rows.length).toBeGreaterThan(10);
  });

  it("converted 0/1 flags to real booleans", async () => {
    const p = pg();
    if (p === undefined) return;
    const rows = await p.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'integrations' AND column_name = 'connected')
            OR (table_name = 'organizations' AND column_name = 'active'))`,
    );
    expect(rows.rows.map((r) => r.data_type)).toEqual(["boolean", "boolean"]);
  });

  it("refuses a non-boolean in a boolean column, which SQLite would have accepted", async () => {
    const p = pg();
    if (p === undefined) return;
    await expect(
      p.query(
        `INSERT INTO integrations (id, name, category, connected) VALUES ('int_bad', 'x', 'y', 7)`,
      ),
    ).rejects.toThrow();
  });

  it("kept identifiers as text, so prefixed ids are storable", async () => {
    const p = pg();
    if (p === undefined) return;
    const rows = await p.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'id'`,
    );
    expect(rows.rows[0]?.data_type).toBe("text");
    // The concrete reason `uuid` would have been wrong: this is a real identifier.
    await p.query(
      `INSERT INTO agents (organization_id, id, name, provider, model, status, created_at, risk_level)
         VALUES ('org_default', 'agt_billing', 'Billing', 'openai', 'gpt-4', 'idle', now(), 'low')`,
    );
    const back = await p.query<{ id: string }>(`SELECT id FROM agents WHERE id = 'agt_billing'`);
    expect(back.rows[0]?.id).toBe("agt_billing");
  });

  it("made the tenant discriminator mandatory with no default, so a forgotten column fails", async () => {
    const p = pg();
    if (p === undefined) return;
    const rows = await p.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'executions' AND column_name = 'organization_id'`,
    );
    expect(rows.rows[0]?.is_nullable).toBe("NO");
    // The DROP DEFAULT half of the backfill: without it, an INSERT that omits the
    // tenant lands in org_default instead of failing.
    expect(rows.rows[0]?.column_default).toBeNull();
    await expect(
      p.query(
        `INSERT INTO executions (id, agent_id, agent_name, action, target, status, risk, "timestamp", decision)
           VALUES ('exec_x','agt_billing','Billing','a','t','allowed','low', now(), 'allow')`,
      ),
    ).rejects.toThrow();
  });

  it("gave every tenant-scoped table a composite primary key led by the organization", async () => {
    const p = pg();
    if (p === undefined) return;
    const rows = await p.query<{ table_name: string; cols: string }>(
      `SELECT c.relname AS table_name,
              string_agg(a.attname, ',' ORDER BY k.ord) AS cols
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE con.contype = 'p' AND c.relname IN ('agents','policies','executions','approvals','integrations','sessions','api_keys')
        GROUP BY c.relname`,
    );
    const keys = new Map(rows.rows.map((r) => [r.table_name, r.cols]));
    for (const table of ["agents", "policies", "executions", "approvals", "integrations"]) {
      expect(keys.get(table), table).toBe("organization_id,id");
    }
    // The two documented exceptions: a credential resolves before its tenant is known.
    expect(keys.get("sessions")).toBe("id");
    expect(keys.get("api_keys")).toBe("id");
  });

  it("enforces the api-key digest uniqueness in the engine", async () => {
    const p = pg();
    if (p === undefined) return;
    const insert = (id: string) =>
      p.query(
        `INSERT INTO api_keys (id, organization_id, name, role, secret_hash, prefix, created_at, created_by)
           VALUES ($1, 'org_default', 'k', 'viewer', 'sha256$dup', 'oathrion_abc', now(), 'test')`,
        [id],
      );
    await insert("key_one");
    await expect(insert("key_two")).rejects.toThrow();
  });

  it("created the case-folded unique index sign-in depends on", async () => {
    const p = pg();
    if (p === undefined) return;
    const rows = await p.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_users_email_lower'`,
    );
    expect(rows.rows[0]?.indexdef).toContain("lower");
    await p.query(
      `INSERT INTO users (id, email, name, password_hash, password_updated_at, created_at)
         VALUES ('usr_a', 'Ada@example.com', 'Ada', 'scrypt$x', now(), now())`,
    );
    await expect(
      p.query(
        `INSERT INTO users (id, email, name, password_hash, password_updated_at, created_at)
           VALUES ('usr_b', 'ADA@example.com', 'Ada2', 'scrypt$y', now(), now())`,
      ),
    ).rejects.toThrow();
  });

  it("created the tenant-leading indexes and dropped the ones they dominate", async () => {
    const p = pg();
    if (p === undefined) return;
    const rows = await p.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
    );
    const names = new Set(rows.rows.map((r) => r.indexname));
    for (const expected of [
      "idx_executions_org_ts",
      "idx_executions_org_agent_ts",
      "idx_executions_org_spend",
      "idx_sessions_org_subject",
      "idx_approvals_org_status_ts",
      "idx_api_keys_org",
      "idx_api_keys_source",
      "idx_memberships_user",
      "idx_rate_limit_reset",
    ]) {
      expect(names.has(expected), `missing index ${expected}`).toBe(true);
    }
    for (const dropped of ["idx_executions_ts", "idx_executions_agent_ts", "idx_executions_spend", "idx_sessions_subject"]) {
      expect(names.has(dropped), `${dropped} should have been dropped by migration 3`).toBe(false);
    }
  });

  it("uses the tenant-leading index for the daily-spend query, not a scan", async () => {
    const p = pg();
    if (p === undefined) return;
    /*
     * The plan, not the timing. `dailySpend` runs inside the decision transaction, so it
     * is on the critical path of every governed action; on SQLite its plan is locked by
     * query-plans.test.ts and the same guarantee is asserted here rather than assumed to
     * have survived the port.
     *
     * ROWS FIRST, AND THIS IS THE POINT. The first version of this test ran EXPLAIN
     * against a table holding one row and failed — correctly. On a tiny table a
     * sequential scan *is* the cheaper plan, so the assertion was not testing the index,
     * it was testing that the planner is bad at its job. Data is loaded and ANALYZE is
     * run so the planner has statistics, which is the only condition under which
     * "does it choose the index" is a meaningful question.
     *
     * `enable_seqscan = off` is deliberately NOT used: it would prove the index is
     * usable, not that it is chosen.
     */
    await p.query(
      `INSERT INTO executions (organization_id, id, agent_id, agent_name, action, target, status, risk,
                               "timestamp", decision, cost)
       SELECT 'org_default', 'exec_bulk_' || g, 'agt_' || (g % 12), 'Agent', 'act', 'tgt',
              CASE WHEN g % 5 = 0 THEN 'allowed' ELSE 'blocked' END, 'low',
              now() - (g || ' seconds')::interval, 'allow', (g % 100) / 10.0
         FROM generate_series(1, 20000) AS g`,
    );
    await p.query(`ANALYZE executions`);

    const plan = await p.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT coalesce(sum(cost), 0) FROM executions
        WHERE organization_id = 'org_default' AND agent_id = 'agt_7'
          AND status = 'allowed' AND "timestamp" >= now() - interval '1 day'`,
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toContain("idx_executions_org_spend");
    expect(text).not.toContain("Seq Scan");
  }, 60_000);
});

describe.skipIf(NO_POSTGRES)("PostgreSQL transactions", () => {
  it("rolls back a failed migration completely, leaving the version unchanged", async () => {
    const p = pg();
    if (p === undefined) return;
    const before = await p.query<{ version: number }>(
      `SELECT max(version) AS version FROM schema_migrations`,
    );

    const broken = [
      ...MIGRATIONS,
      {
        version: 999,
        name: "deliberately-broken",
        statements: () => [
          `CREATE TABLE should_not_survive (id text)`,
          `THIS IS NOT SQL`,
        ],
      },
    ];

    await expect(migratePostgres(urlFor(DB_NAME), broken)).rejects.toThrow(/deliberately-broken/);

    // Both halves matter: the DDL is gone AND the ledger did not record the attempt.
    const survived = await p.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'should_not_survive'`,
    );
    expect(survived.rowCount).toBe(0);
    const after = await p.query<{ version: number }>(`SELECT max(version) AS version FROM schema_migrations`);
    expect(Number(after.rows[0]?.version)).toBe(Number(before.rows[0]?.version));
  }, 30_000);

  it("isolates concurrent writers: one row, one winner", async () => {
    const p = pg();
    if (p === undefined) return;
    /*
     * The engine-level guarantee the shared rate limiter is built on, asserted
     * directly: two concurrent inserts of the same primary key must not both succeed.
     * If this ever passed twice, the limiter's atomicity claim would be false.
     */
    const insert = () =>
      p.query(
        `INSERT INTO organizations (id, name, created_at) VALUES ('org_race', 'Race', now())`,
      );
    const outcomes = await Promise.allSettled([insert(), insert(), insert()]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(2);
  });

  it("refuses a downgrade, exactly as the SQLite runner does", async () => {
    const p = pg();
    if (p === undefined) return;
    const older = MIGRATIONS.slice(0, 2);
    await expect(migratePostgres(urlFor(DB_NAME), older)).rejects.toThrow(/downgrade/i);
  }, 30_000);

  it("refuses a rewritten history, exactly as the SQLite runner does", async () => {
    const p = pg();
    if (p === undefined) return;
    const renamed = MIGRATIONS.map((m) =>
      m.version === 3 ? { ...m, name: "tenancy-renamed", statements: m.statements } : m,
    );
    await expect(migratePostgres(urlFor(DB_NAME), renamed)).rejects.toThrow(/never be rewritten/i);
  }, 30_000);
});

describe.skipIf(NO_POSTGRES)("SQLite / PostgreSQL parity", () => {
  it("produces an identical ledger on both engines", async () => {

    const sqlite = new Database(":memory:");
    runMigrations(createSqliteMigrationDriver(sqlite), MIGRATIONS);
    const sqliteHistory = migrationHistory(createSqliteMigrationDriver(sqlite));

    const fresh = `${DB_NAME}_parity`;
    const admin = new Pool({ connectionString: BASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${fresh}`);
    try {
      await migratePostgres(urlFor(fresh), MIGRATIONS);
      const pgPool = ignoreForcedTermination(new Pool({ connectionString: urlFor(fresh), max: 1 }));
      const rows = await pgPool.query<{ version: number | string; name: string; statement_count: number | string }>(
        `SELECT version, name, statement_count FROM schema_migrations ORDER BY version ASC`,
      );
      await pgPool.end();

      /*
       * Versions and names must match exactly — that is what makes "the database is at
       * version 6" mean the same thing on both engines, which the downgrade check
       * depends on.
       */
      expect(rows.rows.map((r) => Number(r.version))).toEqual(sqliteHistory.map((h) => h.version));
      expect(rows.rows.map((r) => r.name)).toEqual(sqliteHistory.map((h) => h.name));

      /*
       * Where the two histories differ, and where they must not.
       *
       * An earlier version of this test asserted that migration 3 emits *fewer*
       * statements on PostgreSQL. That was simply false — 33 against 29 — and the test
       * caught the claim, not a bug: SQLite's rebuild is four statements per table
       * (create, copy, drop, rename) and PostgreSQL's in-place conversion is also four
       * (add column, drop default, drop key, add key). Statement count was never the
       * meaningful difference, and the corrected assertion is on what the statements
       * actually do — see the test below.
       */
      const pgCounts = new Map(rows.rows.map((r) => [r.name, Number(r.statement_count)]));
      const liteCounts = new Map(sqliteHistory.map((h) => [h.name, h.statementCount]));
      expect(pgCounts.get("legacy-columns")).toBe(0);
      expect(liteCounts.get("legacy-columns")).toBe(0);
      expect(pgCounts.get("rate-limit-buckets")).toBe(2);
      expect(liteCounts.get("rate-limit-buckets")).toBe(0);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${fresh} WITH (FORCE)`);
      await admin.end();
      sqlite.close();
    }
  }, 60_000);

  it("converts tenancy in place on PostgreSQL and never copies the rows", () => {
    /*
     * The substantive difference between the two dialects, asserted on the emitted SQL
     * rather than on a statement count.
     *
     * SQLite cannot alter a primary key, so it rebuilds: create a replacement, copy
     * every row, drop, rename. On a large executions table that means holding two
     * copies of the data at once. PostgreSQL can alter a key in place, so it does — no
     * copy, no rename, no second copy of the rows.
     *
     * Transcribing the rebuild dance onto PostgreSQL would have worked and would have
     * carried a limitation of SQLite into an engine that does not have it. This test is
     * what stops a future "make the dialects consistent" change from doing exactly that.
     */
    const inspect = (dialect: "sqlite" | "postgres") => ({
      dialect,
      columns: () => new Set<string>(),
      tableExists: () => false,
    });
    const tenancy = MIGRATIONS.find((m) => m.name === "tenancy");
    expect(tenancy).toBeDefined();

    const lite = tenancy?.statements(inspect("sqlite")) ?? [];
    const post = tenancy?.statements(inspect("postgres")) ?? [];

    expect(lite.filter((s) => /_tenanted \(organization_id/.test(s))).not.toHaveLength(0);
    expect(lite.filter((s) => /RENAME TO/.test(s))).not.toHaveLength(0);

    expect(post.filter((s) => /_tenanted/.test(s))).toHaveLength(0);
    expect(post.filter((s) => /RENAME TO/.test(s))).toHaveLength(0);
    expect(post.filter((s) => /SELECT .* FROM/.test(s))).toHaveLength(0);
    expect(post.filter((s) => /DROP CONSTRAINT \w+_pkey/.test(s))).toHaveLength(5);
    expect(post.filter((s) => /ALTER COLUMN organization_id DROP DEFAULT/.test(s))).toHaveLength(6);
  });

  it("gives both engines the same column names for every shared table", async () => {
    const p = pg();
    if (p === undefined) return;

    const sqlite = new Database(":memory:");
    runMigrations(createSqliteMigrationDriver(sqlite), MIGRATIONS);
    const liteDriver = createSqliteMigrationDriver(sqlite);

    /*
     * Columns, not types: the types differ on purpose (timestamptz, boolean) and that
     * divergence is asserted above. What must NOT differ is the set of columns — a
     * missing one means the repository port will fail at runtime on a query that works
     * on SQLite, which is the failure this parity test exists to catch early.
     *
     * `rate_limit_buckets` is excluded: it is PostgreSQL-only by design (migration 6
     * explains why a shared store on a local file shares nothing).
     */
    const shared = [
      "agents",
      "policies",
      "executions",
      "approvals",
      "sessions",
      "integrations",
      "organizations",
      "users",
      "memberships",
      "api_keys",
      "schema_migrations",
      /*
       * P7: both are created on both engines and were absent from this list, so
       * column drift on either was unchecked. `usage_counters` is created on both
       * because a high-water mark kept only in memory is destroyed by every deploy
       * (migration 7); `identity_tokens` is core identity (migration 8).
       */
      "usage_counters",
      "identity_tokens",
      // Chantier 1 — created on both engines by migration 17.
      "organization_quotas",
    ];

    for (const table of shared) {
      const liteCols = [...liteDriver.columns(table)].sort();
      const pgRows = await p.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        [table],
      );
      const pgCols = pgRows.rows.map((r) => r.column_name).sort();
      expect(pgCols, `column drift on ${table}`).toEqual(liteCols);
    }
    sqlite.close();
  }, 30_000);

  it("inspects every table the registry touches, so no migration takes a blind branch", async () => {
    const p = pg();
    if (p === undefined) return;
    /*
     * `runMigrationsAsync` pre-fetches metadata for a fixed list of tables, because
     * `statements()` is synchronous by contract. A table missing from that list reads
     * as "does not exist", so a migration inspecting it would silently take the wrong
     * branch — a bug that would only appear on an upgrade, never on a fresh database.
     * This pins the list against the schema the migrations actually produce.
     */
    const client = await p.connect();
    try {
      const driver = createPostgresMigrationDriver(client);
      const result = await runMigrationsAsync(driver, MIGRATIONS);
      expect(result.applied).toEqual([]);
    } finally {
      client.release();
    }

    const rows = await p.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    /*
     * P7: read from the driver rather than re-typed here. The duplicate list this
     * replaces was itself correct — the *driver's* list was the one missing
     * `usage_counters` and `identity_tokens` — so the two could disagree, and did.
     * A guard that keeps its own copy of the thing it guards can pass while the
     * real value is wrong.
     */
    const inspected = new Set<string>(INSPECTED_TABLES);
    for (const row of rows.rows) {
      if (row.table_name === "schema_migrations") continue;
      expect(inspected.has(row.table_name), `${row.table_name} is not in INSPECTED_TABLES`).toBe(true);
    }
  }, 30_000);
});

/*
 * TEST DE CHARGE DU 9 NOVEMBRE : le plafond du mois d'un mandat, sous des autorisations
 * simultanées, sur plusieurs connexions réelles. Sans le verrou de `MandateService.grant`,
 * chacune lisait le même cumul et toutes passaient.
 */
describe.skipIf(NO_POSTGRES)("PostgreSQL mandates under concurrency", () => {
  it("eight authorizations of 4,000 EUR at once, monthly cap 10,000 EUR: exactly two pass", async () => {
    const p = pg();
    await migratePostgres(urlFor(DB_NAME), MIGRATIONS);
    const { generateKeyPairSync, randomBytes, sign } = await import("node:crypto");
    const { publicKeyOf } = await import("@shared/mandate");
    const { canonical } = await import("@shared/receipt-share");
    const { MandateService } = await import("../mandates");
    const { postgresExecutor } = await import("../sql/executor");
    const { resetVaultKeyring } = await import("../connectors/vault");
    resetVaultKeyring();
    const env = { OATHRION_KEK: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;
    const org = `org_pgrace${Date.now().toString(36)}`.padEnd(26, "0") as never;
    const service = new MandateService(postgresExecutor(p), org, env);
    const now = new Date("2026-12-10T10:00:00.000Z");
    const keys = { awa: generateKeyPairSync("ed25519").privateKey, agent: generateKeyPairSync("ed25519").privateKey };
    await service.registerSignerKey("awa", publicKeyOf(keys.awa), now);
    const created = await service.create(
      {
        agent: { id: "agt_ap", name: "Accounts payable", publicKey: publicKeyOf(keys.agent) },
        grants: [{ actions: ["payment.transfer"], constraints: { maxAmount: { value: 5_000, currency: "EUR" }, periodCap: { value: 10_000, currency: "EUR", period: "P1M" } } }],
        notBefore: "2026-12-01T00:00:00.000Z",
        notAfter: "2027-03-31T00:00:00.000Z",
        required: 1,
        signers: [{ userId: "awa", role: "CFO" }],
      },
      "user:admin",
      "https://oathrion.acme.example/status",
      now,
    );
    await service.sign(created.id, "awa", sign(null, Buffer.from(canonical(created.signed.mandate), "utf8"), keys.awa).toString("base64"), now);
    const pay = { type: "payment.transfer", destination: "bank:acme-main", amount: { value: 4_000, currency: "EUR" } };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.grant(created.id, "agt_ap", pay, now)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) {
      expect(String(r.reason)).toMatch(/above the mandate's 10,000 EUR per period/);
    }
    resetVaultKeyring();
  }, 60_000);
});

/**
 * Meta-test: the honesty of this file is itself checked.
 *
 * Defect P9-1 was not a wrong assertion. It was an accounting bug: the tests
 * were correct, they simply did not run, and nothing in the summary said so.
 * That class of defect is invisible to the tests themselves, so it needs a test
 * that reads the file.
 *
 * This one runs unconditionally - it needs no server, which is the point, since
 * the situation it guards against is exactly the one where no server exists.
 */
describe("PostgreSQL test honesty (regression guard for P9-1)", () => {
  const source = readFileSync(new URL(import.meta.url), "utf8");

  it("never turns an unavailable server into a silent early return", () => {
    /*
     * The exact shape of the defect: a test body that returns when there is no
     * pool. vitest counts that as a pass. If this pattern comes back - and it is
     * a natural thing to reach for - the file must fail rather than inflate.
     *
     * The literal is assembled so this assertion does not match itself.
     */
    const banned = new RegExp("if\\s*\\(\\s*pg\\(\\)\\s*===\\s*undefined\\s*\\)\\s*return");
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(banned.test(codeOnly)).toBe(false);
  });

  it("guards every PostgreSQL suite with a real skip", () => {
    /*
     * Every `describe` in this file that touches PostgreSQL must be a
     * `describe.skipIf`, so an absent server is reported as SKIPPED and counted
     * as such. The only unguarded suite permitted is this one.
     */
    const suites = [...source.matchAll(/^describe(\.skipIf\([^)]*\))?\(\s*"([^"]+)"/gm)];
    expect(suites.length).toBeGreaterThan(1);
    for (const [, guard, name] of suites) {
      if (name.startsWith("PostgreSQL test honesty")) {
        expect(guard, "the honesty guard must run everywhere").toBeUndefined();
        continue;
      }
      expect(guard, `suite "${name}" is not skip-guarded`).toBe(".skipIf(NO_POSTGRES)");
    }
  });

  it("can be made a hard failure by OATHRION_REQUIRE_POSTGRES", () => {
    /*
     * The behavioural half is not reachable from inside this process - the probe
     * already ran at import. What is checkable, and what actually matters, is
     * that the switch is read and that it throws rather than warns. The
     * end-to-end proof is `npm run verify:postgres`, which sets the variable.
     */
    expect(source).toContain('process.env.OATHRION_REQUIRE_POSTGRES === "true"');
    expect(source).toMatch(/postgresRequired\(\)\s*\)\s*\{[\s\S]{0,600}?throw new Error\(/);
  });

  it("never prints a password in its skip notice", () => {
    // The skip notice names the URL so the operator can fix it; it must not
    // name the credential in it.
    expect(source).toContain("safeUrl(BASE_URL)");
    expect(source).not.toMatch(/console\.warn\([\s\S]{0,200}\$\{BASE_URL\}/);
  });
});
