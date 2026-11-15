/**
 * P0-3 — versioned schema migrations.
 *
 * The claims this file has to substantiate are the ones an operator bets a
 * production database on: a migration runs once, in order, atomically; a rewritten
 * history is refused; a downgrade is refused; a pre-migration database is adopted
 * rather than re-created; and a failure leaves the schema exactly as it was.
 *
 * Everything runs against a real on-disk SQLite database, because the failure modes
 * worth testing are transaction and DDL failure modes. Nothing is mocked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRegistryIsSound,
  createSqliteMigrationDriver,
  LATEST_VERSION,
  LEDGER_TABLE,
  MIGRATIONS,
  MigrationError,
  migrationHistory,
  runMigrations,
  schemaVersion,
  type Migration,
  type MigrationDriver,
} from "../migrations";

let dir: string;
let sqlite: Database.Database;
let driver: MigrationDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "placet-migrations-"));
  sqlite = new Database(join(dir, "test.db"));
  driver = createSqliteMigrationDriver(sqlite);
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- *
 * The real registry
 * -------------------------------------------------------------------------- */

describe("the shipped migration registry", () => {
  it("is sound: ascending, unique, named", () => {
    expect(() => assertRegistryIsSound(MIGRATIONS)).not.toThrow();
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(LATEST_VERSION).toBe(MIGRATIONS.at(-1)!.version);
  });

  it("builds the whole baseline schema on an empty database", () => {
    const result = runMigrations(driver, MIGRATIONS);

    expect(result.baselined).toBe(false);
    expect(result.version).toBe(LATEST_VERSION);
    expect(result.applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));

    for (const table of [
      "agents",
      "policies",
      "executions",
      "approvals",
      "sessions",
      "integrations",
      "organizations",
      "users",
      "memberships",
    ]) {
      expect(driver.tableExists(table), `${table} should exist`).toBe(true);
    }

    /*
     * `users` existed as an assertion of ABSENCE before P0-2, when console passwords
     * lived in the environment. Now the table exists, and the property worth keeping
     * is the one that assertion was really protecting: no column holds a password. A
     * column literally named `password` is what an "improvement" to the login flow
     * would plausibly add, so it is refused by name.
     */
    const userColumns = (
      sqlite.prepare(`SELECT name FROM pragma_table_info('users')`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(userColumns).toContain("password_hash");
    expect(userColumns).not.toContain("password");
    expect(userColumns).not.toContain("password_plain");
  });

  it("creates the measured performance indexes, all led by the tenant column", () => {
    runMigrations(driver, MIGRATIONS);
    const indexes = driver
      .query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .map((row) => row.name);

    // These are not decorative: query-plans.test.ts locks the plans they enable.
    // Migration 3 replaced the pre-tenancy names, because an index that does not
    // start with `organization_id` makes every query walk other tenants' rows first.
    expect(indexes).toContain("idx_executions_org_ts");
    expect(indexes).toContain("idx_executions_org_agent_ts");
    expect(indexes).toContain("idx_executions_org_spend");

    // And the pre-tenancy ones are gone rather than left behind as dead weight on
    // every write.
    expect(indexes).not.toContain("idx_executions_ts");
    expect(indexes).not.toContain("idx_executions_agent_ts");
    expect(indexes).not.toContain("idx_executions_spend");
  });

  it("is idempotent — a second run applies nothing", () => {
    runMigrations(driver, MIGRATIONS);
    const second = runMigrations(driver, MIGRATIONS);

    expect(second.applied).toEqual([]);
    expect(second.baselined).toBe(false);
    expect(second.version).toBe(LATEST_VERSION);
  });

  it("records every migration in the ledger, in order, with a timestamp", () => {
    runMigrations(driver, MIGRATIONS, { now: () => new Date("2026-08-19T12:00:00.000Z") });
    const history = migrationHistory(driver);

    expect(history.map((row) => row.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(history.map((row) => row.name)).toEqual(MIGRATIONS.map((m) => m.name));
    for (const row of history) expect(row.appliedAt).toBe("2026-08-19T12:00:00.000Z");
  });

  it("reports version 0 before anything has run", () => {
    expect(schemaVersion(driver)).toBe(0);
    expect(migrationHistory(driver)).toEqual([]);
  });

  it("leaves legacy-columns as a recorded no-op on a freshly built schema", () => {
    runMigrations(driver, MIGRATIONS);
    const legacy = migrationHistory(driver).find((row) => row.name === "legacy-columns");

    // It must be *recorded* (so it never runs again) while having changed nothing:
    // migration 1 already created those columns.
    expect(legacy).toBeDefined();
    expect(legacy!.statementCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------- *
 * Ordering and once-only semantics
 * -------------------------------------------------------------------------- */

describe("ordering and once-only application", () => {
  const order: number[] = [];

  function tracked(version: number, name: string, sql: string): Migration {
    return {
      version,
      name,
      statements() {
        order.push(version);
        return [sql];
      },
    };
  }

  beforeEach(() => {
    order.length = 0;
  });

  it("applies in ascending version order", () => {
    const list = [
      tracked(1, "first", "CREATE TABLE a (id TEXT)"),
      tracked(2, "second", "CREATE TABLE b (id TEXT)"),
      tracked(3, "third", "CREATE TABLE c (id TEXT)"),
    ];

    runMigrations(driver, list);
    expect(order).toEqual([1, 2, 3]);
  });

  it("only applies the versions the database is missing", () => {
    const first = tracked(1, "first", "CREATE TABLE a (id TEXT)");
    runMigrations(driver, [first]);
    order.length = 0;

    const second = tracked(2, "second", "CREATE TABLE b (id TEXT)");
    const result = runMigrations(driver, [first, second]);

    expect(order).toEqual([2]);
    expect(result.applied.map((m) => m.version)).toEqual([2]);
  });

  it("lets migration N see the schema migration N-1 produced", () => {
    let observed: string[] = [];
    const list: Migration[] = [
      { version: 1, name: "create", statements: () => ["CREATE TABLE thing (id TEXT)"] },
      {
        version: 2,
        name: "inspect",
        statements: (schema) => {
          observed = [...schema.columns("thing")];
          return [];
        },
      },
    ];

    runMigrations(driver, list);
    // Proves metadata is re-read between migrations rather than snapshotted once.
    expect(observed).toEqual(["id"]);
  });
});

/* -------------------------------------------------------------------------- *
 * Atomicity
 * -------------------------------------------------------------------------- */

describe("atomicity", () => {
  it("rolls back every statement of a failing migration", () => {
    const list: Migration[] = [
      { version: 1, name: "ok", statements: () => ["CREATE TABLE kept (id TEXT)"] },
      {
        version: 2,
        name: "broken",
        statements: () => [
          "CREATE TABLE partial (id TEXT)",
          "THIS IS NOT SQL", // fails here
        ],
      },
    ];

    expect(() => runMigrations(driver, list)).toThrow(MigrationError);

    // The first statement of the failing migration must not have survived.
    expect(driver.tableExists("partial")).toBe(false);
    // The migration that succeeded before it must still be there.
    expect(driver.tableExists("kept")).toBe(true);
  });

  it("does not record a failed migration in the ledger", () => {
    const list: Migration[] = [
      { version: 1, name: "ok", statements: () => ["CREATE TABLE kept (id TEXT)"] },
      { version: 2, name: "broken", statements: () => ["THIS IS NOT SQL"] },
    ];

    expect(() => runMigrations(driver, list)).toThrow();

    // A ledger that claims a migration which did not commit is worse than no
    // ledger at all: the next deploy would skip it forever.
    expect(migrationHistory(driver).map((row) => row.version)).toEqual([1]);
    expect(schemaVersion(driver)).toBe(1);
  });

  it("names the failing migration and preserves the underlying cause", () => {
    const list: Migration[] = [{ version: 1, name: "broken-one", statements: () => ["NOPE"] }];

    try {
      runMigrations(driver, list);
      expect.unreachable("the migration should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as Error).message).toContain("broken-one");
      // The SQLite error is kept rather than swallowed, or the operator cannot
      // tell a syntax error from a constraint violation.
      expect((error as Error).cause).toBeDefined();
    }
  });

  it("can be re-run after a failure is fixed, and applies only what is missing", () => {
    const broken: Migration = { version: 2, name: "two", statements: () => ["NOPE"] };
    const first: Migration = { version: 1, name: "one", statements: () => ["CREATE TABLE t1 (id TEXT)"] };

    expect(() => runMigrations(driver, [first, broken])).toThrow();

    const fixed: Migration = { version: 2, name: "two", statements: () => ["CREATE TABLE t2 (id TEXT)"] };
    const result = runMigrations(driver, [first, fixed]);

    expect(result.applied.map((m) => m.version)).toEqual([2]);
    expect(driver.tableExists("t1")).toBe(true);
    expect(driver.tableExists("t2")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * Adversarial: tampered history and downgrades
 * -------------------------------------------------------------------------- */

describe("refusing an inconsistent history", () => {
  it("refuses a version applied under a different name", () => {
    runMigrations(driver, [{ version: 1, name: "original-name", statements: () => [] }]);

    expect(() =>
      runMigrations(driver, [{ version: 1, name: "renamed", statements: () => [] }]),
    ).toThrow(/never be rewritten/i);
  });

  it("refuses a downgrade — an old build against a newer schema", () => {
    runMigrations(driver, [
      { version: 1, name: "one", statements: () => [] },
      { version: 2, name: "two", statements: () => [] },
    ]);

    // Simulates deploying a rollback that does not contain migration 2.
    expect(() => runMigrations(driver, [{ version: 1, name: "one", statements: () => [] }])).toThrow(
      /downgrade/i,
    );
  });

  it("refuses a downgrade before applying anything else", () => {
    runMigrations(driver, [
      { version: 1, name: "one", statements: () => [] },
      { version: 5, name: "five", statements: () => [] },
    ]);

    const list: Migration[] = [
      { version: 1, name: "one", statements: () => [] },
      { version: 2, name: "two", statements: () => ["CREATE TABLE should_not_exist (id TEXT)"] },
    ];

    expect(() => runMigrations(driver, list)).toThrow(/downgrade/i);
    // The check must happen before any DDL, or a refused deploy still mutates the schema.
    expect(driver.tableExists("should_not_exist")).toBe(false);
  });

  it("refuses a registry with a duplicated version", () => {
    expect(() =>
      assertRegistryIsSound([
        { version: 1, name: "a", statements: () => [] },
        { version: 1, name: "b", statements: () => [] },
      ]),
    ).toThrow(/share version 1/);
  });

  it("refuses a registry that is not in ascending order", () => {
    expect(() =>
      assertRegistryIsSound([
        { version: 2, name: "b", statements: () => [] },
        { version: 1, name: "a", statements: () => [] },
      ]),
    ).toThrow(/ascending/);
  });

  it("refuses version 0 and non-integer versions", () => {
    expect(() => assertRegistryIsSound([{ version: 0, name: "zero", statements: () => [] }])).toThrow(
      /invalid version/,
    );
    expect(() => assertRegistryIsSound([{ version: 1.5, name: "half", statements: () => [] }])).toThrow(
      /invalid version/,
    );
  });

  it("refuses an unnamed migration", () => {
    expect(() => assertRegistryIsSound([{ version: 1, name: "  ", statements: () => [] }])).toThrow(
      /empty name/,
    );
  });

  it("validates the registry before touching the database", () => {
    expect(() =>
      runMigrations(driver, [
        { version: 1, name: "a", statements: () => ["CREATE TABLE early (id TEXT)"] },
        { version: 1, name: "b", statements: () => [] },
      ]),
    ).toThrow(MigrationError);

    expect(driver.tableExists("early")).toBe(false);
    expect(driver.tableExists(LEDGER_TABLE)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * Adopting a database created before the ledger existed
 * -------------------------------------------------------------------------- */

describe("adopting a pre-migration database", () => {
  /**
   * Builds a database that looks like one created by the previous build: the
   * baseline tables exist, and there is no ledger. Deliberately missing the
   * columns that were added later, so the top-up migration has real work to do.
   */
  function buildLegacyDatabase(): void {
    sqlite.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
        current_task TEXT, owner TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        executions_24h INTEGER NOT NULL DEFAULT 0, success_rate REAL NOT NULL DEFAULT 100,
        cost_24h REAL NOT NULL DEFAULT 0, cost_month REAL NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]',
        policy_ids TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE policies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        rule TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL, applies_to TEXT NOT NULL DEFAULT '',
        effect TEXT NOT NULL, status TEXT NOT NULL, triggered_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE executions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
        action TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, risk TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL, input TEXT NOT NULL DEFAULT '{}', decision TEXT NOT NULL,
        decision_reason TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
        audit TEXT NOT NULL DEFAULT '[]', tool_executed_at TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        revoked_at TEXT, revoked_by TEXT
      );
      CREATE TABLE integrations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', connected INTEGER NOT NULL DEFAULT 0,
        scopes TEXT NOT NULL DEFAULT '[]', connected_at TEXT, agents_using INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, execution_id TEXT, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', requested_value TEXT NOT NULL DEFAULT '',
        policy_id TEXT NOT NULL DEFAULT '', policy_name TEXT NOT NULL DEFAULT '',
        policy_limit TEXT NOT NULL DEFAULT '', risk TEXT NOT NULL, status TEXT NOT NULL,
        requested_at TEXT NOT NULL, resolved_by TEXT, context TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  it("adopts it at the baseline instead of replaying baseline DDL", () => {
    buildLegacyDatabase();
    const result = runMigrations(driver, MIGRATIONS);

    expect(result.baselined).toBe(true);
    const history = migrationHistory(driver);
    expect(history[0]!.version).toBe(1);
    expect(history[0]!.name).toBe("baseline");
    // Adopted, not executed — recorded as having run zero statements.
    expect(history[0]!.statementCount).toBe(0);
  });

  it("still tops up the columns a legacy database is missing", () => {
    buildLegacyDatabase();
    expect(driver.columns("agents").has("mandate")).toBe(false);
    expect(driver.columns("sessions").has("credential_fp")).toBe(false);
    expect(driver.columns("executions").has("run_state")).toBe(false);

    runMigrations(driver, MIGRATIONS);

    expect(driver.columns("agents").has("mandate")).toBe(true);
    expect(driver.columns("sessions").has("credential_fp")).toBe(true);
    expect(driver.columns("executions").has("run_state")).toBe(true);
    expect(driver.columns("executions").has("attempts")).toBe(true);
    expect(driver.columns("executions").has("tool_started_at")).toBe(true);
  });

  it("preserves the rows a legacy database already held", () => {
    buildLegacyDatabase();
    sqlite
      .prepare(
        `INSERT INTO agents (id, name, provider, model, status, created_at, risk_level)
         VALUES ('agt_legacy', 'Legacy Agent', 'openai', 'gpt-4', 'active', '2026-01-01T00:00:00.000Z', 'low')`,
      )
      .run();

    runMigrations(driver, MIGRATIONS);

    const row = sqlite.prepare(`SELECT id, name, mandate FROM agents WHERE id = 'agt_legacy'`).get() as {
      id: string;
      name: string;
      mandate: string;
    };
    // Adoption must never be destructive. The new column arrives with its default.
    expect(row.name).toBe("Legacy Agent");
    expect(row.mandate).toBe("{}");
  });

  it("backfills the tool-run lifecycle so no pre-Gateway row looks retryable-but-run", () => {
    buildLegacyDatabase();
    const insert = sqlite.prepare(
      `INSERT INTO executions (id, agent_id, agent_name, action, target, status, risk, timestamp,
                               decision, tool_executed_at)
       VALUES (?, 'agt_1', 'A', 'act', 'tgt', ?, 'low', '2026-01-01T00:00:00.000Z', 'allow', ?)`,
    );
    insert.run("exec_done", "completed", "2026-01-01T00:00:01.000Z");
    insert.run("exec_failed", "failed", "2026-01-01T00:00:02.000Z");
    insert.run("exec_blocked", "blocked", null);

    runMigrations(driver, MIGRATIONS);

    const states = Object.fromEntries(
      sqlite
        .prepare(`SELECT id, run_state, attempts FROM executions`)
        .all()
        .map((row) => [(row as { id: string }).id, row as { run_state: string; attempts: number }]),
    );

    // A row whose tool demonstrably ran must never be left looking like it hasn't:
    // that is what would let a retry double-charge a real purchase.
    expect(states["exec_done"]!.run_state).toBe("succeeded");
    expect(states["exec_done"]!.attempts).toBe(1);
    expect(states["exec_failed"]!.run_state).toBe("failed");
    expect(states["exec_blocked"]!.run_state).toBe("skipped");
  });

  it("does not adopt a database that merely has an unrelated table", () => {
    sqlite.exec("CREATE TABLE something_else (id TEXT)");
    const result = runMigrations(driver, MIGRATIONS);

    // Only the real baseline markers count, otherwise any stray table would make
    // the runner skip building the schema and leave a broken installation.
    expect(result.baselined).toBe(false);
    expect(driver.tableExists("agents")).toBe(true);
  });

  it("reaches the same schema version as a freshly created database", () => {
    buildLegacyDatabase();
    runMigrations(driver, MIGRATIONS);
    expect(schemaVersion(driver)).toBe(LATEST_VERSION);
  });
});

/* -------------------------------------------------------------------------- *
 * Migration 3 — tenancy
 * -------------------------------------------------------------------------- */

describe("migration 3 (tenancy)", () => {
  it("creates the organization registry with a default tenant already in it", () => {
    runMigrations(driver, MIGRATIONS);

    const rows = sqlite
      .prepare(`SELECT id, name, active FROM organizations`)
      .all() as { id: string; name: string; active: number }[];

    // Without this row nothing can authenticate: `organizationStore.isActive`
    // treats an unknown organization as inactive, deliberately, so the tenant every
    // existing deployment's data belongs to has to exist from the first boot.
    expect(rows.map((r) => r.id)).toContain("org_default");
    expect(rows.find((r) => r.id === "org_default")!.active).toBe(1);
  });

  it("gives every tenant-scoped table a NOT NULL organization_id", () => {
    runMigrations(driver, MIGRATIONS);

    for (const table of ["agents", "policies", "executions", "approvals", "integrations", "sessions"]) {
      const column = (
        sqlite.prepare(`SELECT name, "notnull" FROM pragma_table_info(?)`).all(table) as {
          name: string;
          notnull: number;
        }[]
      ).find((c) => c.name === "organization_id");

      expect(column, `${table} has no organization_id`).toBeDefined();
      // Nullable would be worse than absent: a NULL discriminator matches no tenant's
      // filter, so the row becomes invisible to everyone while still consuming ids and
      // still being returned by any query that forgets the filter.
      expect(column!.notnull, `${table}.organization_id is nullable`).toBe(1);
    }
  });

  it("keys the tenant-scoped tables on (organization_id, id), not on id alone", () => {
    runMigrations(driver, MIGRATIONS);

    for (const table of ["agents", "policies", "executions", "approvals", "integrations"]) {
      const pk = (
        sqlite.prepare(`SELECT name, pk FROM pragma_table_info(?)`).all(table) as {
          name: string;
          pk: number;
        }[]
      )
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort();

      expect(pk, `${table} primary key`).toEqual(["id", "organization_id"]);
    }
  });

  it("lets two organizations hold the same id, which a global key would forbid", () => {
    runMigrations(driver, MIGRATIONS);
    sqlite
      .prepare(`INSERT INTO organizations (id, name, created_at, active) VALUES (?, ?, ?, 1)`)
      .run("org_second", "Second", new Date().toISOString());

    const insert = sqlite.prepare(
      `INSERT INTO agents (organization_id, id, name, description, provider, model, status,
         current_task, owner, created_at, executions_24h, success_rate, cost_24h, cost_month,
         risk_level, permissions, mandate, policy_ids, tags)
       VALUES (?, 'agt_billing', 'Billing', '', 'openai', 'gpt-4o', 'active', NULL, 'o',
         '2026-01-01', 0, 0, 0, 0, 'low', '[]', '{}', '[]', '[]')`,
    );

    insert.run("org_default");
    // The assertion: this must NOT throw. A caller-chosen id is a name inside one
    // company, not a globally reserved word, and a conflict here would both deny the
    // second customer a natural name and confirm to them that somebody else took it.
    expect(() => insert.run("org_second")).not.toThrow();

    const count = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM agents WHERE id = 'agt_billing'`)
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("assigns every pre-existing row to the default organization, losing none", () => {
    // Stop at version 2 — the last schema before tenancy — and put data in it, the way
    // a real deployment would have. Then upgrade. This is the path that carries a
    // paying customer's history across the change, so losing a row here is data loss.
    runMigrations(driver, MIGRATIONS.filter((m) => m.version <= 2));

    const insert = sqlite.prepare(
      `INSERT INTO executions (id, agent_id, agent_name, action, target, status, risk,
         duration_ms, cost, timestamp, input, decision, decision_reason, result, audit)
       VALUES (?, 'agt_sales', 'Sales', 'purchase', 'x.example.com', 'allowed', 'low',
         5, 1.5, '2026-02-01T10:00:00.000Z', '{}', 'allow', '', '', '[]')`,
    );
    for (const id of ["exec_a", "exec_b", "exec_c"]) insert.run(id);

    const before = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM executions`).get() as { n: number }
    ).n;
    expect(before).toBe(3);

    runMigrations(driver, MIGRATIONS);

    const rows = sqlite
      .prepare(`SELECT organization_id, COUNT(*) AS n FROM executions GROUP BY organization_id`)
      .all() as { organization_id: string; n: number }[];

    // One group, holding every original row: an existing deployment is exactly one
    // tenant, and the upgrade must not drop or duplicate its history.
    expect(rows).toEqual([{ organization_id: "org_default", n: before }]);
  });
});

describe("migration 4 (users and memberships)", () => {
  it("creates both tables with the columns the repository reads", () => {
    runMigrations(driver, MIGRATIONS);

    const columnsOf = (table: string) =>
      (sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(
        (c) => c.name,
      );

    expect(columnsOf("users").sort()).toEqual(
      [
        "created_at",
        "email",
        "id",
        "last_login_at",
        "name",
        "password_hash",
        "password_source",
        "password_updated_at",
        "status",
      ].sort(),
    );
    /*
     * `suspended_at` is NOT migration 4's — it is added by migration 8 (P2
     * identity), and this test runs the whole registry. Listed here rather than
     * asserted away with a filter, so that the day a column appears that no
     * migration explains, this test fails instead of tolerating it.
     */
    expect(columnsOf("memberships").sort()).toEqual(
      ["created_at", "organization_id", "role", "suspended_at", "user_id"].sort(),
    );
  });

  it("makes the e-mail address unique regardless of case", () => {
    /*
     * Two rows differing only in case would be two accounts for one person, and which
     * one a sign-in resolved to would depend on the lookup — the case-insensitive
     * lookup would return an arbitrary one of them. The uniqueness is enforced by the
     * database rather than by the repository, because a raw INSERT from a script or a
     * future code path must not be able to create the pair either.
     */
    runMigrations(driver, MIGRATIONS);

    const insert = sqlite.prepare(
      `INSERT INTO users (id, email, name, password_hash, password_updated_at, password_source,
         status, created_at, last_login_at)
       VALUES (?, ?, 'Person', 'scrypt$16384$8$1$salt$hash', '2026-01-01T00:00:00.000Z', 'user',
         'active', '2026-01-01T00:00:00.000Z', NULL)`,
    );
    insert.run("usr_one", "Person@Example.com");
    expect(() => insert.run("usr_two", "person@example.com")).toThrow(/UNIQUE/i);
  });

  it("keys a membership on the pair, so one person holds one role per organization", () => {
    // A second role in the same organization would make the effective role depend on
    // row order — an operator could hold `viewer` and `admin` at once.
    runMigrations(driver, MIGRATIONS);

    const insert = sqlite.prepare(
      `INSERT INTO memberships (organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    );
    insert.run("org_default", "usr_person", "viewer");
    expect(() => insert.run("org_default", "usr_person", "admin")).toThrow(/UNIQUE|PRIMARY/i);
    // The same person in a different organization is legitimate, and must still work.
    expect(() => insert.run("org_other", "usr_person", "admin")).not.toThrow();
  });

  it("indexes memberships by user, the direction a sign-in reads them", () => {
    // Sign-in asks "which organizations does this person belong to?", which is the
    // non-leading column of the primary key and would otherwise be a table scan.
    runMigrations(driver, MIGRATIONS);
    const indexes = (
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_memberships_user");
    expect(indexes).toContain("idx_users_email_lower");
  });

  it("adds the tables to a database that already holds data, losing nothing", () => {
    // The upgrade path for a live deployment: version 3 with agents in it.
    runMigrations(
      driver,
      MIGRATIONS.filter((m) => m.version <= 3),
    );
    sqlite
      .prepare(
        `INSERT INTO agents (organization_id, id, name, description, provider, model, status,
           owner, created_at, risk_level, mandate, permissions, policy_ids, tags)
         VALUES ('org_default', 'agt_keep', 'Keep', '', 'openai', 'gpt-4o', 'active', 'someone',
           '2026-01-01T00:00:00.000Z', 'low', '{}', '[]', '[]', '[]')`,
      )
      .run();

    runMigrations(driver, MIGRATIONS);

    expect(driver.tableExists("users")).toBe(true);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }).n,
    ).toBe(1);
    // No account is invented by the migration itself: accounts arrive by adoption,
    // from the configuration, on the first boot after the upgrade.
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n).toBe(0);
  });
});

describe("migration 5 (api keys)", () => {
  it("creates the table with the columns the repository reads", () => {
    runMigrations(driver, MIGRATIONS);
    const columns = (
      sqlite.prepare(`SELECT name FROM pragma_table_info('api_keys')`).all() as { name: string }[]
    ).map((c) => c.name);

    expect(columns.sort()).toEqual(
      [
        "created_at",
        "created_by",
        "expires_at",
        "id",
        "last_used_at",
        "name",
        "organization_id",
        "prefix",
        "revoked_at",
        "revoked_by",
        "revoked_reason",
        "role",
        "secret_hash",
        "source",
        /*
         * Added by migration 010, not by migration 5. This block runs the whole
         * chain, so the list is the shape `api_keys` has after every migration —
         * which is the shape the repository actually reads. Kept as one list
         * rather than split per migration because an exhaustive assertion is the
         * point: a column added without editing this line fails here.
         */
        "agent_id",
      ].sort(),
    );

    // The property that matters more than the column list: there is nowhere to put a
    // credential. A `secret`, `key` or `plaintext` column appearing later would be the
    // regression this migration exists to prevent.
    expect(columns).not.toContain("secret");
    expect(columns).not.toContain("key");
    expect(columns).not.toContain("plaintext");
  });

  it("refuses two keys with the same digest", () => {
    /*
     * One credential resolving to two identities — possibly in two different tenants —
     * with the winner decided by row order. Enforced by the engine so that no code path,
     * including a hand-written INSERT, can create the pair.
     */
    runMigrations(driver, MIGRATIONS);
    const insert = sqlite.prepare(
      `INSERT INTO api_keys (id, organization_id, name, role, secret_hash, prefix, source,
         created_at, created_by)
       VALUES (?, ?, 'Bot', 'operator', ?, 'oathrion_ab12cd', 'user', '2026-01-01T00:00:00.000Z', 'test')`,
    );
    insert.run("key_one", "org_default", "sha256$abc");
    expect(() => insert.run("key_two", "org_rival_corp", "sha256$abc")).toThrow(/UNIQUE/i);
  });

  it("indexes keys by organization for the console's list", () => {
    runMigrations(driver, MIGRATIONS);
    const indexes = (
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
        name: string;
      }[]
    ).map((i) => i.name);
    expect(indexes).toContain("idx_api_keys_org");
    expect(indexes).toContain("idx_api_keys_source");
  });

  it("upgrades a version 4 database without inventing or losing a key", () => {
    // The realistic upgrade: an existing deployment whose keys live only in
    // OATHRION_API_KEYS. The migration must add an empty table — adoption happens at boot,
    // in auth.ts, because a migration that read process.env would produce different
    // databases on two hosts running the same build.
    runMigrations(driver, MIGRATIONS.filter((m) => m.version <= 4));
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, password_updated_at, password_source,
           status, created_at, last_login_at)
         VALUES ('usr_keeper', 'keeper@example.com', 'Keeper', 'scrypt$16384$8$1$s$h',
           '2026-01-01T00:00:00.000Z', 'user', 'active', '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run();

    const result = runMigrations(driver, MIGRATIONS);
    expect(result.version).toBe(LATEST_VERSION);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM api_keys`).get() as { n: number }).n,
    ).toBe(0);
    // And the user that existed before is untouched.
    expect(
      (sqlite.prepare(`SELECT email FROM users WHERE id = 'usr_keeper'`).get() as { email: string })
        .email,
    ).toBe("keeper@example.com");
  });
});
