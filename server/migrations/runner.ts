/**
 * The migration runner and its ledger.
 *
 * Guarantees, each covered by a test in `server/test/migrations.test.ts`:
 *
 *  - **Ordered.** Migrations run in ascending version order, never concurrently.
 *  - **Once.** An applied version is never re-run.
 *  - **Atomic per migration.** Every statement of one migration commits or none
 *    of them do, so a failure never leaves a half-migrated schema behind. The
 *    ledger row is written inside the same transaction as the DDL it records,
 *    which is the only way the ledger cannot disagree with the schema.
 *  - **Fail-closed on a tampered history.** A version recorded under a different
 *    name, or a database at a version this build does not know about (a
 *    downgrade), stops the process instead of guessing. Silently "fixing" either
 *    of those is how a production schema gets destroyed.
 *  - **Baseline-aware.** A database created by a pre-migration build already has
 *    the baseline tables but no ledger. It is adopted at version 1 rather than
 *    having `CREATE TABLE` run against it.
 *
 * Deliberately NOT here: crash recovery and session expiry sweeps. Those run on
 * every boot and are runtime maintenance, not schema evolution. Mixing them into
 * migrations would mean they run exactly once and then never again.
 */

import { MigrationError, type AppliedMigration, type Dialect, type Migration, type SchemaInspect } from "./types";

/**
 * The minimum a driver must provide. Synchronous by design: better-sqlite3 is
 * synchronous, and a synchronous contract is what allows the schema bootstrap to
 * stay at import time without a top-level await (which the CJS production bundle
 * cannot express). The PostgreSQL driver satisfies this by pre-loading schema
 * metadata and buffering statements — see `postgres.ts` when it lands (P0-4).
 */
export interface MigrationDriver {
  readonly dialect: Dialect;
  exec(sql: string): void;
  /** Rows as plain objects. Used for the ledger and schema introspection. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  /** Runs `fn` in a transaction, rolling back if it throws. */
  transaction(fn: () => void): void;
  tableExists(table: string): boolean;
  columns(table: string): Set<string>;
}

const LEDGER_TABLE = "schema_migrations";

/** Tables that prove a database predates the ledger and must be adopted, not created. */
export const BASELINE_MARKER_TABLES = ["agents", "policies", "executions"];

export interface MigrationResult {
  /** Versions applied by this call, in order. Empty when already up to date. */
  applied: AppliedMigration[];
  /** True when an existing pre-ledger database was adopted at the baseline. */
  baselined: boolean;
  /** Schema version after the call. */
  version: number;
}

export function ledgerDdl(dialect: Dialect): string {
  // `applied_at` is a text ISO-8601 timestamp on both engines so the ledger reads
  // identically whichever driver produced it, and so comparisons stay lexicographic.
  const integer = dialect === "postgres" ? "integer" : "INTEGER";
  const text = dialect === "postgres" ? "text" : "TEXT";
  return `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  version ${integer} PRIMARY KEY,
  name ${text} NOT NULL,
  applied_at ${text} NOT NULL,
  statement_count ${integer} NOT NULL DEFAULT 0
)`;
}

/**
 * The one SELECT that reads the ledger, and the one function that shapes its rows.
 *
 * Both are exported because the asynchronous PostgreSQL runner must read the ledger
 * with exactly the same query and interpret it in exactly the same way. Two copies
 * of this — one per runner — is how the two engines would eventually come to
 * disagree about what "already applied" means.
 */
export const LEDGER_SELECT_SQL =
  `SELECT version, name, applied_at, statement_count FROM ${LEDGER_TABLE} ORDER BY version ASC`;

export interface LedgerRow {
  version: number | string;
  name: string;
  applied_at: string;
  statement_count: number | string;
}

export function shapeLedgerRows(rows: LedgerRow[]): AppliedMigration[] {
  return rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    appliedAt: row.applied_at,
    statementCount: Number(row.statement_count),
  }));
}

/**
 * The ledger INSERT, shared for the same reason as the SELECT. Values are inlined
 * rather than bound because the runner's `exec` takes no parameters on either
 * driver; `name` comes from the migration registry (a literal in this repository,
 * never user input) and its quotes are doubled regardless.
 */
export function ledgerInsertSql(version: number, name: string, appliedAt: string, statementCount: number): string {
  return (
    `INSERT INTO ${LEDGER_TABLE} (version, name, applied_at, statement_count) VALUES (` +
    `${version}, '${name.replace(/'/g, "''")}', '${appliedAt}', ${statementCount})`
  );
}

function readLedger(driver: MigrationDriver): AppliedMigration[] {
  const rows = driver.query<LedgerRow>(LEDGER_SELECT_SQL);

  return shapeLedgerRows(rows.map((row) => ({
    version: row.version,
    name: row.name,
    applied_at: row.applied_at,
    statement_count: row.statement_count,
  })));
}

/**
 * Validates the registry itself. A duplicated or out-of-order version is a
 * programming mistake that would corrupt the ledger, so it is caught before any
 * statement runs rather than halfway through a deployment.
 */
export function assertRegistryIsSound(migrations: readonly Migration[]): void {
  const seen = new Map<number, string>();
  let previous = 0;

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new MigrationError(
        `Migration "${migration.name}" has an invalid version (${migration.version}). Versions are integers starting at 1.`,
      );
    }
    const duplicate = seen.get(migration.version);
    if (duplicate !== undefined) {
      throw new MigrationError(
        `Two migrations share version ${migration.version}: "${duplicate}" and "${migration.name}". ` +
          `Versions identify rows in the ledger and cannot be reused.`,
      );
    }
    if (migration.version <= previous) {
      throw new MigrationError(
        `Migration "${migration.name}" (version ${migration.version}) is registered after version ${previous}. ` +
          `The registry must be in ascending version order.`,
      );
    }
    if (migration.name.trim() === "") {
      throw new MigrationError(`Migration version ${migration.version} has an empty name.`);
    }
    seen.set(migration.version, migration.name);
    previous = migration.version;
  }
}

/**
 * Compares the ledger against the registry.
 *
 * Refuses two situations outright:
 *   - a version applied under a different name (history was edited or reordered);
 *   - a version in the database that this build does not know (a downgrade —
 *     running old code against a newer schema, which would then write rows the
 *     new schema's constraints forbid).
 */
export function assertHistoryMatches(applied: AppliedMigration[], migrations: readonly Migration[]): void {
  const known = new Map(migrations.map((m) => [m.version, m.name]));

  for (const row of applied) {
    const expected = known.get(row.version);
    if (expected === undefined) {
      throw new MigrationError(
        `The database is at schema version ${row.version} ("${row.name}"), which this build of Oathrion does not ` +
          `contain. This is a downgrade: an older server must not run against a newer schema. ` +
          `Deploy a build that includes migration ${row.version}, or restore the database from before the upgrade.`,
      );
    }
    if (expected !== row.name) {
      throw new MigrationError(
        `Migration ${row.version} was applied as "${row.name}" but this build declares it as "${expected}". ` +
          `Migration history must never be rewritten — add a new migration instead of editing an applied one.`,
      );
    }
  }
}

function inspectFor(driver: MigrationDriver): SchemaInspect {
  return {
    dialect: driver.dialect,
    columns: (table) => driver.columns(table),
    tableExists: (table) => driver.tableExists(table),
  };
}

/**
 * Brings the database up to the latest known version.
 *
 * @param now injectable clock, so a test can assert on the recorded timestamp
 *            without sleeping. The server passes nothing.
 */
export function runMigrations(
  driver: MigrationDriver,
  migrations: readonly Migration[],
  options: { now?: () => Date; log?: (message: string) => void } = {},
): MigrationResult {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  assertRegistryIsSound(migrations);

  const ledgerExisted = driver.tableExists(LEDGER_TABLE);
  driver.exec(ledgerDdl(driver.dialect));

  let baselined = false;

  /*
   * Adoption of a pre-ledger database.
   *
   * Without this, the first migration would be re-run against a database that
   * already has every baseline table. Migration 1 is written to be idempotent so
   * that would *happen* to work today — but relying on that means every future
   * reader has to keep it idempotent forever, and the first person who writes a
   * plain `CREATE TABLE` breaks every existing deployment. Recording the fact
   * explicitly is the honest version.
   */
  if (!ledgerExisted && BASELINE_MARKER_TABLES.every((table) => driver.tableExists(table))) {
    const baseline = migrations[0];
    if (baseline === undefined) {
      throw new MigrationError("No migrations are registered, so an existing database cannot be adopted.");
    }
    driver.transaction(() => {
      driver.exec(ledgerInsertSql(baseline.version, baseline.name, now().toISOString(), 0));
    });
    baselined = true;
    log(
      `[oathrion:migrations] adopted an existing pre-migration database at baseline version ` +
        `${baseline.version} ("${baseline.name}"). No baseline DDL was run.`,
    );
  }

  const applied = readLedger(driver);
  assertHistoryMatches(applied, migrations);

  const appliedVersions = new Set(applied.map((row) => row.version));
  const results: AppliedMigration[] = [];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    // Metadata is re-read per migration: migration N-1 changes the schema that
    // migration N inspects.
    const statements = migration.statements(inspectFor(driver));
    const appliedAt = now().toISOString();

    try {
      driver.transaction(() => {
        for (const statement of statements) {
          const trimmed = statement.trim();
          if (trimmed === "") continue;
          driver.exec(trimmed);
        }
        // Same transaction as the DDL above, so the ledger can never claim a
        // migration that did not commit, nor omit one that did.
        driver.exec(ledgerInsertSql(migration.version, migration.name, appliedAt, statements.length));
      });
    } catch (error) {
      throw new MigrationError(
        `Migration ${migration.version} ("${migration.name}") failed and was rolled back. ` +
          `The schema is unchanged and the database is still at version ` +
          `${results.at(-1)?.version ?? applied.at(-1)?.version ?? 0}.`,
        { cause: error },
      );
    }

    results.push({
      version: migration.version,
      name: migration.name,
      appliedAt,
      statementCount: statements.length,
    });
    log(
      `[oathrion:migrations] applied ${migration.version} "${migration.name}" ` +
        `(${statements.length} statement${statements.length === 1 ? "" : "s"})`,
    );
  }

  const version = Math.max(0, ...readLedger(driver).map((row) => row.version));
  return { applied: results, baselined, version };
}

/** Current schema version, or 0 when the ledger does not exist yet. */
export function schemaVersion(driver: MigrationDriver): number {
  if (!driver.tableExists(LEDGER_TABLE)) return 0;
  return Math.max(0, ...readLedger(driver).map((row) => row.version));
}

/** The full applied history, oldest first. Surfaced by the health endpoint. */
export function migrationHistory(driver: MigrationDriver): AppliedMigration[] {
  if (!driver.tableExists(LEDGER_TABLE)) return [];
  return readLedger(driver);
}

export { LEDGER_TABLE };
