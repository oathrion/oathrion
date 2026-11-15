/**
 * PostgreSQL driver and asynchronous migration runner (P0-4).
 *
 * ## Why there are two runners and not one
 *
 * `runMigrations` in `runner.ts` is synchronous, and that is not an oversight: it
 * runs at import time in `server/db.ts`, the production build is a CommonJS bundle
 * that cannot express a top-level await, and every existing suite imports that
 * module expecting a usable schema. better-sqlite3 is synchronous, so that works.
 *
 * node-postgres is not, and no amount of interface design makes an asynchronous
 * client satisfy a synchronous contract. The options were: block the event loop
 * with a hand-rolled synchronous socket client (a serious amount of code to
 * reimplement a wire protocol), shell out to `psql` (an external binary in the
 * runtime path, and no transaction control), or accept a second orchestration.
 *
 * The second orchestration is the honest choice, but duplicated orchestration is
 * how two engines quietly come to disagree about what "already applied" means. So
 * everything that constitutes a *rule* is imported from `runner.ts` and exists
 * exactly once:
 *
 *   - `assertRegistryIsSound`  — the registry is well-formed
 *   - `assertHistoryMatches`   — downgrade and rewritten-history refusal
 *   - `ledgerDdl`              — the ledger table
 *   - `LEDGER_SELECT_SQL` / `shapeLedgerRows` / `ledgerInsertSql` — reading and
 *                                writing the ledger
 *   - `BASELINE_MARKER_TABLES` — adoption of a pre-ledger database
 *
 * What is duplicated is the loop: read metadata, ask the migration for statements,
 * run them in a transaction, record the ledger row. `server/test/postgres.test.ts`
 * asserts that both runners produce the same ledger, in the same order, with the
 * same statement counts, and refuse the same two tampering cases — so the drift
 * risk is pinned by a test rather than by good intentions.
 */

import { Pool, type PoolClient } from "pg";
import { guardPoolClients } from "../sql/pg-client-guard";
import {
  assertHistoryMatches,
  assertRegistryIsSound,
  BASELINE_MARKER_TABLES,
  ledgerDdl,
  ledgerInsertSql,
  LEDGER_SELECT_SQL,
  LEDGER_TABLE,
  shapeLedgerRows,
  type LedgerRow,
  type MigrationResult,
} from "./runner";
import { ORGANIZATION_QUOTAS_TABLE } from "./017-organization-quotas";
import { TENANT_ERASURES_TABLE } from "./020-tenant-erasure";
import { SSO_IDENTITIES_TABLE } from "./023-sso-identities";
import { CONNECTOR_CREDENTIALS_TABLE } from "./021-connector-credentials";
import { PENDING_INTERCEPTIONS_TABLE } from "./022-pending-interceptions";
import { AGENT_DOORS_TABLE } from "./025-agent-doors";
import { RECONCILE_FINDINGS_TABLE, RECONCILE_RUNS_TABLE } from "./026-reconcile";
import { MANDATE_GRANTS_TABLE, MANDATE_KEYS_TABLE, MANDATES_TABLE } from "./030-mandates";
import { MANDATE_RECEIPTS_TABLE } from "./031-mandate-receipts";
import { QUOTA_PERIOD_COUNTS_TABLE } from "./028-quota-period-counts";
import { RECEIPT_CHAIN_CHECKPOINTS_TABLE } from "./029-receipt-chain-checkpoints";
import { MigrationError, type AppliedMigration, type Migration, type SchemaInspect } from "./types";

/**
 * The asynchronous counterpart of `MigrationDriver`. Deliberately the same five
 * operations: a driver that needed a sixth would mean the runner had grown engine
 * knowledge, which is what the interface exists to prevent.
 */
export interface AsyncMigrationDriver {
  readonly dialect: "postgres";
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction(fn: () => Promise<void>): Promise<void>;
  tableExists(table: string): Promise<boolean>;
  columns(table: string): Promise<Set<string>>;
}

/**
 * Builds a driver over a single pooled connection.
 *
 * One connection, not the pool, for one reason that matters: a transaction spans
 * several statements, and a pool hands out an arbitrary connection per query. A
 * `BEGIN` issued on one connection and DDL issued on another is not a transaction
 * — it is a `BEGIN` that never commits and DDL that is never rolled back. This is
 * the failure that makes "the migration was atomic" a false claim, so the client
 * is pinned explicitly.
 */
export function createPostgresMigrationDriver(client: PoolClient): AsyncMigrationDriver {
  return {
    dialect: "postgres",

    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await client.query(sql, params);
      return result.rows as T[];
    },

    async transaction(fn: () => Promise<void>): Promise<void> {
      /*
       * Hand-written BEGIN/COMMIT/ROLLBACK, unlike the SQLite driver which delegates
       * to better-sqlite3's wrapper. The original error is re-thrown after the
       * rollback — the runner relies on receiving it to name the migration that
       * failed, and swallowing it would turn a precise failure into "something went
       * wrong during startup".
       *
       * The ROLLBACK is itself wrapped: if the connection has already died, the
       * rollback attempt throws, and letting that replace the real error would hide
       * the actual cause behind a symptom.
       */
      await client.query("BEGIN");
      try {
        await fn();
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* The connection is gone; PostgreSQL has already discarded the transaction. */
        }
        throw error;
      }
    },

    async tableExists(table: string): Promise<boolean> {
      /*
       * `to_regclass` would be shorter but resolves against the whole search_path
       * including `pg_catalog`, so a table named `sessions` in another schema — or a
       * system relation — would answer yes. `information_schema` restricted to the
       * current schema answers the question actually being asked: "is this table in
       * the database this deployment owns?"
       */
      const result = await client.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = $1`,
        [table],
      );
      return result.rowCount === 1;
    },

    async columns(table: string): Promise<Set<string>> {
      // Lower-cased to match the SQLite driver's contract. PostgreSQL already folds
      // unquoted identifiers to lower case, so this is a no-op there — kept so the
      // two drivers cannot answer differently for a quoted mixed-case column.
      const result = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        [table],
      );
      return new Set(result.rows.map((row) => row.column_name.toLowerCase()));
    },
  };
}

/** A synchronous view over metadata already fetched, so `statements()` stays pure. */
async function snapshot(driver: AsyncMigrationDriver, tables: readonly string[]): Promise<SchemaInspect> {
  const columns = new Map<string, Set<string>>();
  const exists = new Map<string, boolean>();
  for (const table of tables) {
    columns.set(table, await driver.columns(table));
    exists.set(table, await driver.tableExists(table));
  }
  return {
    dialect: "postgres",
    columns: (table) => columns.get(table) ?? new Set<string>(),
    tableExists: (table) => exists.get(table) ?? false,
  };
}

/**
 * Every table any migration inspects, plus every table it creates.
 *
 * Gathered up front because `statements()` is synchronous by contract — the runner
 * collects metadata before calling it, which is the design decision in `types.ts`
 * that lets one migration definition serve both a synchronous and an asynchronous
 * driver. A table absent from this list reads as "does not exist", so a migration
 * that inspected one would take the wrong branch.
 *
 * ## Two tables were missing from this list, and the guard did not catch it (P7)
 *
 * `usage_counters` (migration 7) and `identity_tokens` (migration 8) were absent, and
 * both migrations branch on `schema.tableExists()` for exactly those names. On
 * PostgreSQL both therefore always read "does not exist" and always re-emitted their
 * `CREATE TABLE` — which did no damage only because both statements say
 * `IF NOT EXISTS`. That is a latent defect surviving on an accident of phrasing: the
 * moment a later migration adds a column-level branch on either table, or drops the
 * `IF NOT EXISTS`, the wrong branch is taken on an upgrade and never on a fresh
 * database, which is the hardest shape of schema bug to reproduce.
 *
 * It went unnoticed because the guard that asserts this list lived in
 * `server/test/postgres.test.ts`, which **skips when no PostgreSQL server is
 * reachable**. No run before Phase 7 had one, so the guard had never executed. It
 * failed on its first real run.
 *
 * The list is now (a) exported and (b) additionally guarded by
 * `server/test/migration-inspection-coverage.test.ts`, which derives the required
 * names from the migration sources themselves and needs no database — so the next
 * omission fails in every run rather than only in a run that happens to have a
 * server. The live-database assertion in `postgres.test.ts` is kept as well: it
 * catches a table created by a migration that never names it in a branch.
 */
export const INSPECTED_TABLES = [
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
  "rate_limit_buckets",
  // P7: both were inspected by a migration while absent from this list.
  "usage_counters",
  "identity_tokens",
  /*
   * Phase 11: the four action-authority tables from migration 012. Migration 013
   * inspects `action_receipts` before adding `entry_seq`; absent from this list the
   * inspection would answer "no such table" on a PostgreSQL database where the table
   * plainly exists, and the migration would emit its ALTER unconditionally. The other
   * three are added with it rather than one at a time: the defect is a table being
   * absent from the list at all, and `server/test/postgres.test.ts` asserts that every
   * table in the database is inspected precisely so the next migration to inspect one
   * of them does not have to rediscover this.
   *
   * They were missing since Phase 10, which could not observe it: the test that pins
   * the rule needs a real server, and Phase 10's run had none for that file.
   */
  "actions",
  "action_grants",
  "action_policies",
  // Chantier 2 : la migration 019 inspecte sa propre table avant de la créer.
  "product_feedback",
  "action_receipts",
  /*
   * Chantier 1: migration 17 inspects its own table before creating it. Named through
   * the migration's constant so the table's literal name stays in one file
   * (`tenant-config-single-path.test.ts`).
   */
  ORGANIZATION_QUOTAS_TABLE,
  /*
   * Chantier 2 : la migration 020 inspecte sa propre table avant de la créer. Nommée
   * par la constante de la migration, pour que le littéral reste dans un seul fichier.
   */
  TENANT_ERASURES_TABLE,
  /*
   * Chantier 3 : la migration 021 inspecte sa propre table avant de la créer. Même
   * raison — le littéral du nom de table reste dans le fichier de la migration.
   */
  CONNECTOR_CREDENTIALS_TABLE,
  /*
   * Le mandat vérifiable : la migration 030 inspecte sa première table avant de créer les
   * trois. Les deux autres manquaient : le test sur une vraie base l'a vu à son premier
   * passage dans la CI de GitHub (15 novembre).
   */
  MANDATES_TABLE,
  MANDATE_KEYS_TABLE,
  MANDATE_GRANTS_TABLE,
  /* Les reçus contresignés : la migration 031 inspecte sa propre table. */
  MANDATE_RECEIPTS_TABLE,
  /* La migration 022 inspecte sa propre table avant de la créer. */
  PENDING_INTERCEPTIONS_TABLE,
  /*
   * La migration 023 inspecte sa propre table avant de la créer. Le commentaire du
   * chantier 10 ci-dessus dit pourquoi cette ligne n'est pas une formalité : absente,
   * l'inspection répond « table absente » sur une base PostgreSQL où elle existe.
   */
  SSO_IDENTITIES_TABLE,
  /* La migration 025 inspecte sa propre table avant de la créer. */
  AGENT_DOORS_TABLE,
  /* La migration 026 inspecte ses deux tables avant de les créer. */
  RECONCILE_RUNS_TABLE,
  RECONCILE_FINDINGS_TABLE,
  /* La migration 028 inspecte sa propre table avant de la créer. */
  QUOTA_PERIOD_COUNTS_TABLE,
  /* La migration 029 inspecte sa propre table avant de la créer. */
  RECEIPT_CHAIN_CHECKPOINTS_TABLE,
] as const;

/**
 * Brings a PostgreSQL database up to the latest known version.
 *
 * Mirrors `runMigrations` statement for statement, including the ledger-adoption
 * path and the exit conditions. A failure throws `MigrationError` naming the
 * migration; the caller decides whether that is fatal.
 */
export async function runMigrationsAsync(
  driver: AsyncMigrationDriver,
  migrations: readonly Migration[],
  options: { now?: () => Date; log?: (message: string) => void } = {},
): Promise<MigrationResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  assertRegistryIsSound(migrations);

  const ledgerExisted = await driver.tableExists(LEDGER_TABLE);
  await driver.exec(ledgerDdl(driver.dialect));

  let baselined = false;

  // Adoption of a pre-ledger database. No PostgreSQL database created by this
  // product can be in that state — PostgreSQL support and the ledger arrive
  // together — but a database restored from another tool's dump could be, and the
  // rule is imported rather than re-decided so both engines answer identically.
  if (!ledgerExisted) {
    let allPresent = true;
    for (const table of BASELINE_MARKER_TABLES) {
      if (!(await driver.tableExists(table))) allPresent = false;
    }
    if (allPresent) {
      const baseline = migrations[0];
      if (baseline === undefined) {
        throw new MigrationError("No migrations are registered, so an existing database cannot be adopted.");
      }
      await driver.transaction(async () => {
        await driver.exec(ledgerInsertSql(baseline.version, baseline.name, now().toISOString(), 0));
      });
      baselined = true;
      log(
        `[oathrion:migrations] adopted an existing pre-migration database at baseline version ` +
          `${baseline.version} ("${baseline.name}"). No baseline DDL was run.`,
      );
    }
  }

  const applied = shapeLedgerRows(await driver.query<LedgerRow>(LEDGER_SELECT_SQL));
  assertHistoryMatches(applied, migrations);

  const appliedVersions = new Set(applied.map((row) => row.version));
  const results: AppliedMigration[] = [];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    // Re-read per migration: migration N-1 changes the schema migration N inspects.
    const statements = migration.statements(await snapshot(driver, INSPECTED_TABLES));
    const appliedAt = now().toISOString();

    try {
      await driver.transaction(async () => {
        for (const statement of statements) {
          const trimmed = statement.trim();
          if (trimmed === "") continue;
          await driver.exec(trimmed);
        }
        // Same transaction as the DDL, so the ledger can never claim a migration
        // that did not commit, nor omit one that did. PostgreSQL is transactional
        // for DDL, so unlike many engines this is a real guarantee here.
        await driver.exec(ledgerInsertSql(migration.version, migration.name, appliedAt, statements.length));
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
    log(`[oathrion:migrations] applied ${migration.version} ("${migration.name}") — ${statements.length} statement(s)`);
  }

  const version = results.at(-1)?.version ?? applied.at(-1)?.version ?? 0;
  return { applied: results, baselined, version };
}

/**
 * Applies every migration to the database named by a connection string, then
 * closes the pool.
 *
 * Opens its own pool of exactly one connection and closes it before returning:
 * migrating is a bounded operation with a beginning and an end, and leaving a pool
 * open would keep the process alive after the work is done — which is how a
 * migration command hangs in CI instead of exiting.
 */
export async function migratePostgres(
  connectionString: string,
  migrations: readonly Migration[],
  options: { now?: () => Date; log?: (message: string) => void } = {},
): Promise<MigrationResult> {
  const pool = new Pool({ connectionString, max: 1 });
  /*
   * Une base coupée pendant la migration doit faire échouer la migration avec son
   * erreur, pas arrêter le processus par une exception non attrapée (voir
   * `postgresExecutor().transaction`).
   */
  pool.on("error", () => undefined);
  guardPoolClients(pool, "migrate");
  let client: PoolClient | undefined;
  let broken: Error | undefined;
  const onError = (error: Error): void => {
    broken = error;
  };
  try {
    client = await pool.connect();
    client.on("error", onError);
    return await runMigrationsAsync(createPostgresMigrationDriver(client), migrations, options);
  } finally {
    client?.off("error", onError);
    client?.release(broken);
    await pool.end();
  }
}
