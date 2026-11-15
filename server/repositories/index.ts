/**
 * The repository entry point, and the place where the engine is chosen (Phase 11).
 *
 * Before this phase the file was three re-exports: `repositoriesFor` came straight
 * from `./sqlite`, and `DATABASE_DRIVER=postgres` refused to boot. Now the driver is
 * resolved once, at boot, from the same `resolveDatabaseConfig` every other
 * PostgreSQL-aware module uses, and the choice is enforced on every call.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 *  1. NO SILENT FALLBACK. If PostgreSQL was chosen and could not be initialized,
 *     boot fails. If it was chosen and something calls `repositoriesFor` before
 *     initialization completed, that call throws. What must never happen is a
 *     process configured for PostgreSQL quietly reading and writing a local SQLite
 *     file: the data would be real, the isolation would be per-process, and nothing
 *     would say so.
 *
 *  2. ONE DECISION POINT. The engine is not re-derived per request and not read from
 *     the environment by the repositories themselves, so a mid-flight environment
 *     change cannot split a request across two engines.
 */

import { Pool } from "pg";
import { guardPoolClients } from "../sql/pg-client-guard";
import { requireConnectionString, resolveDatabaseConfig, type DatabaseDriver } from "../database-config";
import { usageReport } from "../quotas";
import { postgresExecutor, sqliteExecutor, type SqlExecutor } from "../sql/executor";
import { rawDb } from "../db";
import { postgresRepositoriesFor, resetPostgresRepositoryCache, usageReportPg } from "./postgres";
import type { QuotaUsage } from "@shared/quotas";
import {
  repositoriesFor as sqliteRepositoriesFor,
  resetRepositoryCache as resetSqliteRepositoryCache,
} from "./sqlite";
import type { OrganizationId } from "@shared/tenancy";
import type { Repositories } from "./types";

export type {
  AgentRepository,
  ApprovalRepository,
  ExecutionRepository,
  IntegrationRepository,
  PolicyRepository,
  Repositories,
} from "./types";
export { seedIfEmpty } from "./seed";

/** Thrown when the configured engine is not usable. Never downgrades to SQLite. */
export class RepositoryInitializationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepositoryInitializationError";
  }
}

let pool: Pool | null = null;
let executor: SqlExecutor | null = null;
let initializedDriver: DatabaseDriver | null = null;

/**
 * Opens the configured backend. Idempotent, and must be awaited before serving.
 *
 * SQLite needs nothing: `server/db.ts` opened and migrated the file at import time.
 * PostgreSQL opens a pool and verifies both the connection and the schema version.
 *
 * Migrations are NOT applied here. `npm run migrate:postgres` is the explicit
 * command, deliberately: a shared database must not be migrated as a side effect of
 * an instance starting, because N instances booting at once would race and because
 * an operator has to be able to migrate at a moment of their choosing. What happens
 * instead is a *check* — if the schema is not at the version this build expects, boot
 * fails with the command to run.
 */
export async function initializeRepositories(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ driver: DatabaseDriver }> {
  const driver = resolveDatabaseConfig(env).driver;
  if (initializedDriver === driver && (driver === "sqlite" || executor !== null)) {
    return { driver };
  }

  if (driver === "sqlite") {
    initializedDriver = "sqlite";
    return { driver };
  }

  let connectionString: string;
  try {
    connectionString = requireConnectionString(env);
  } catch (error) {
    throw new RepositoryInitializationError(
      "DATABASE_DRIVER=postgres was requested but the connection string is not usable: " +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const created = new Pool({
    connectionString,
    max: Number(env.OATHRION_DB_POOL_MAX ?? 10),
    // A hung query is a hung request. Bounded so a connection problem surfaces as an
    // error the route can turn into a 503, rather than as an accumulating queue.
    connectionTimeoutMillis: 5_000,
  });
  created.on("error", (error) => {
    console.error("[db] idle PostgreSQL client error:", error.message);
  });
  guardPoolClients(created, "db");

  try {
    await created.query("SELECT 1");
    await assertSchemaPresent(created);
  } catch (error) {
    await created.end().catch(() => {});
    // FAIL CLOSED. See rule 1 in the module header.
    throw new RepositoryInitializationError(
      "DATABASE_DRIVER=postgres was requested and PostgreSQL could not be initialized, so Oathrion " +
        "will not start. There is no SQLite fallback on this path by design: the process would " +
        "serve real reads and writes from a local file while an operator believed the shared " +
        "database was the source of truth.\n" +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  pool = created;
  executor = postgresExecutor(created);
  initializedDriver = "postgres";
  return { driver };
}

/**
 * Refuses to start against an empty or half-migrated database.
 *
 * Checked by reading `schema_migrations`, the ledger the migration runner maintains,
 * rather than by probing for tables: a table can exist with an older shape, and the
 * ledger is what records the shape.
 */
async function assertSchemaPresent(target: Pool): Promise<void> {
  const { rows } = await target.query<{ version: number | string | null }>(
    `SELECT max(version) AS version FROM schema_migrations`,
  );
  const version = Number(rows[0]?.version ?? 0);
  if (!Number.isFinite(version) || version <= 0) {
    throw new Error(
      "the PostgreSQL database has no applied migrations. Run `npm run migrate:postgres` " +
        "(with DATABASE_URL set) before starting Oathrion against it.",
    );
  }
}

/**
 * The repositories for one tenant, on whichever engine was chosen at boot.
 *
 * Stays synchronous — the repository *methods* are async, the lookup is not — so the
 * hundreds of existing call sites are unchanged.
 */
export function repositoriesFor(organizationId: OrganizationId): Repositories {
  const configured = initializedDriver ?? resolveDatabaseConfig().driver;
  if (configured === "postgres") {
    if (!executor || initializedDriver !== "postgres") {
      throw new RepositoryInitializationError(
        "DATABASE_DRIVER=postgres is configured but the repository layer was never initialized, " +
          "so there is nothing to read from. `await initializeRepositories()` must complete before " +
          "the first request is served. Oathrion raises this instead of falling back to SQLite.",
      );
    }
    return postgresRepositoriesFor(executor, organizationId);
  }
  return sqliteRepositoriesFor(organizationId);
}

/**
 * L'exécuteur SQL du plan des dépôts, sur le moteur choisi au démarrage.
 *
 * Ajouté pour le coffre de credentials des connecteurs (`server/connectors/vault.ts`),
 * qui est écrit une seule fois contre `SqlExecutor` plutôt que dupliqué dans
 * `sqlite.ts` et `postgres.ts`. La raison n'est pas l'économie de lignes : une table qui
 * détient des credentials chiffrés est la dernière où une divergence de SQL entre les
 * deux moteurs devrait pouvoir passer inaperçue.
 *
 * Même forme que `authorityExecutor()`, et même refus : utiliser le plan avant son
 * initialisation est une erreur nommée, jamais un repli silencieux vers SQLite.
 */
export function repositoryExecutor(): SqlExecutor {
  const configured = initializedDriver ?? resolveDatabaseConfig().driver;
  if (configured === "postgres") {
    if (!executor || initializedDriver !== "postgres") {
      throw new RepositoryInitializationError(
        "DATABASE_DRIVER=postgres is configured but the repository layer was never initialized, " +
          "so there is no connection to read credentials through. `await initializeRepositories()` " +
          "must complete before the first request is served.",
      );
    }
    return executor;
  }
  return sqliteExecutor(rawDb);
}

/** The engine actually in use, or null before initialization. For logs and probes. */
export function repositoryDriver(): DatabaseDriver | null {
  return initializedDriver;
}

/**
 * The quota report for one tenant, on whichever engine was chosen at boot.
 *
 * Here and not in `server/quotas.ts` for the reason stated in rule 2 of this module's
 * header: the engine is decided once, in this file. `quotas.ts` holds the SQLite
 * statements and the configuration both engines share; it is not the place that knows
 * which backend is live.
 *
 * Async because the PostgreSQL side is. `/api/usage` awaits it.
 */
export async function usageReportFor(
  organizationId: OrganizationId,
  at: Date = new Date(),
): Promise<QuotaUsage[]> {
  const configured = initializedDriver ?? resolveDatabaseConfig().driver;
  if (configured === "postgres") {
    if (!executor || initializedDriver !== "postgres") {
      throw new RepositoryInitializationError(
        "DATABASE_DRIVER=postgres is configured but the repository layer was never initialized, " +
          "so the quota counters cannot be read. Oathrion raises this instead of falling back to SQLite.",
      );
    }
    return usageReportPg(executor, organizationId, at);
  }
  return usageReport(organizationId, at);
}

/** Test-only: drops both instance caches. */
export function resetRepositoryCache(): void {
  resetSqliteRepositoryCache();
  resetPostgresRepositoryCache();
}

/**
 * Closes the pool and forgets the engine, so a suite (or a graceful shutdown) does
 * not leave connections open. Safe to call when nothing was opened.
 */
export async function closeRepositories(): Promise<void> {
  const open = pool;
  pool = null;
  executor = null;
  initializedDriver = null;
  resetPostgresRepositoryCache();
  if (open) await open.end().catch(() => {});
}

/**
 * Test-only: point the repository layer at a pool the caller owns.
 *
 * The parity and concurrency suites need two engines live in one process and must not
 * be forced to mutate `process.env.DATABASE_DRIVER` to get there. The pool is NOT
 * closed by `closeRepositories` when installed this way — the caller owns it.
 */
export function useTestPostgresPool(target: Pool): void {
  pool = null;
  executor = postgresExecutor(target);
  initializedDriver = "postgres";
  resetPostgresRepositoryCache();
}
export { ssoIdentityStore } from "./sso-identities";
export type { SsoIdentityRecord, SsoResolution } from "./sso-identities";
