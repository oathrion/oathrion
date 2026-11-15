/**
 * Wiring for the action authorization plane, and its engine selection (Phase 10, §9).
 *
 * ENGINE SELECTION, AND WHY IT FAILS CLOSED
 * -----------------------------------------
 * `OATHRION_ACTION_AUTHORITY_DRIVER` chooses where the actions, grants and receipts
 * live: `sqlite` (the default, and what every existing test uses) or `postgres`.
 *
 * When `postgres` is requested and PostgreSQL cannot be reached, or its
 * migrations cannot be applied, this module THROWS. It does not fall back to
 * SQLite. A silent fallback is the single worst failure mode available here: the
 * server would come up, the grants would be written to a local file nobody is
 * watching, single-use enforcement would be scoped to one process instead of the
 * cluster — and two instances would each happily consume "the" grant, executing
 * the same refund twice. The operator asked for the shared store precisely so
 * that could not happen.
 *
 * WHY THIS IS A SEPARATE VARIABLE FROM `DATABASE_DRIVER`
 * -----------------------------------------------------
 * Stated plainly, because the alternative would be an overclaim:
 * `DATABASE_DRIVER=postgres` is still refused at boot by `server/database-config.ts`,
 * because the Phase 9 repositories (agents, policies, executions, approvals) are
 * synchronous better-sqlite3 statements and converting them is not part of this
 * phase. What Phase 10 makes real on PostgreSQL is the action authorization plane
 * — the tables whose correctness is a *distributed* property. Those are exactly
 * the tables that need a shared engine, and the ones this phase adds.
 *
 * Two variables rather than one, so that neither claim is inflated: nothing here
 * implies application data has moved, and nothing in the legacy refusal implies
 * grants cannot be shared across instances.
 */

import { Pool } from "pg";
import { guardPoolClients } from "../sql/pg-client-guard";
import type { OrganizationId } from "@shared/tenancy";
import { requireConnectionString } from "../database-config";
import { rawDb } from "../db";
import { MIGRATIONS, migratePostgres } from "../migrations";
import { postgresExecutor, sqliteExecutor, type SqlExecutor } from "../sql/executor";
import { AuthorizationService } from "./authorization-service";
import { EnforcementPoint } from "./enforcement-point";
import { ActionAuthorityStore } from "./store";

export type AuthorityDriver = "sqlite" | "postgres";

export class AuthorityInitializationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthorityInitializationError";
  }
}

/** Resolves the requested driver. An unrecognised value is refused, not guessed. */
export function resolveAuthorityDriver(env: NodeJS.ProcessEnv = process.env): AuthorityDriver {
  const raw = (env.OATHRION_ACTION_AUTHORITY_DRIVER ?? "").trim().toLowerCase();
  if (raw === "" || raw === "sqlite") return "sqlite";
  if (raw === "postgres" || raw === "postgresql") return "postgres";
  throw new AuthorityInitializationError(
    `OATHRION_ACTION_AUTHORITY_DRIVER="${raw}" is not recognised. Use "sqlite" or "postgres". ` +
      "Oathrion refuses an unrecognised value rather than defaulting, so a typo cannot silently " +
      "move where grants are recorded.",
  );
}

let pool: Pool | null = null;
let executor: SqlExecutor | null = null;
let initializedDriver: AuthorityDriver | null = null;

/**
 * Prepares the plane's storage. Idempotent, and must be awaited before serving.
 *
 * For SQLite there is nothing to do — `server/db.ts` already migrated the file at
 * import time. For PostgreSQL this opens the pool, verifies the connection and
 * applies the ledger-backed migrations through the same runner and the same
 * migration list the SQLite path uses, so the two schemas cannot drift.
 */
export async function initializeActionAuthority(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ driver: AuthorityDriver }> {
  const driver = resolveAuthorityDriver(env);
  if (initializedDriver === driver && executor !== null) return { driver };

  if (driver === "sqlite") {
    executor = sqliteExecutor(rawDb);
    initializedDriver = "sqlite";
    return { driver };
  }

  let connectionString: string;
  try {
    // Reused so the "DATABASE_URL is unreadable / missing" refusals are identical
    // to the ones the legacy configuration already produces.
    connectionString = requireConnectionString(env);
  } catch (error) {
    throw new AuthorityInitializationError(
      "OATHRION_ACTION_AUTHORITY_DRIVER=postgres was requested but the connection string is not " +
        `usable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const created = new Pool({
    connectionString,
    max: Number(env.OATHRION_AUTHORITY_POOL_MAX ?? 10),
    // A hung authorization is a blocked agent, not a queue. Bounded so a
    // connection problem surfaces as an error rather than as a stall.
    connectionTimeoutMillis: 5_000,
  });
  /*
   * An idle-client error would otherwise be an unhandled 'error' event and take
   * the process down. Logged instead: a dropped idle connection is normal
   * operation for a pool, and the next checkout re-establishes it.
   */
  created.on("error", (error) => {
    console.error("[authority] idle PostgreSQL client error:", error.message);
  });
  guardPoolClients(created, "authority");

  try {
    await created.query("SELECT 1");
    /*
     * The same migration list and the same ledger-backed runner the SQLite path
     * uses, so the two schemas cannot drift and a downgrade or a rewritten
     * history is refused here exactly as it is there.
     */
    await migratePostgres(connectionString, MIGRATIONS, {
      // eslint-disable-next-line no-console -- boot-time migration progress, same exemption as server/db.ts
      log: env.NODE_ENV !== "test" ? (message) => console.log(message) : undefined,
    });
  } catch (error) {
    await created.end().catch(() => {});
    // FAIL CLOSED. No SQLite fallback, by design — see the module header.
    throw new AuthorityInitializationError(
      "OATHRION_ACTION_AUTHORITY_DRIVER=postgres was requested and PostgreSQL could not be " +
        "initialized, so the action authorization plane will not start. Oathrion does not fall back " +
        "to SQLite here: single-use grant enforcement would silently become per-process, and two " +
        "instances would each consume the same grant.\n" +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  pool = created;
  executor = postgresExecutor(created);
  initializedDriver = "postgres";
  return { driver };
}

/** The executor, or a clear error if the plane was never initialized. */
export function authorityExecutor(): SqlExecutor {
  if (!executor) {
    throw new AuthorityInitializationError(
      "The action authorization plane was used before initializeActionAuthority() completed. " +
        "Serving requests against an uninitialized store would mean deciding without a place to " +
        "record the decision.",
    );
  }
  return executor;
}

export interface Authority {
  store: ActionAuthorityStore;
  authorization: AuthorizationService;
  enforcement: EnforcementPoint;
}

const cache = new Map<string, Authority>();

/**
 * The plane for one tenant.
 *
 * Cached per organization, mirroring `repositoriesFor`. Every object in it is
 * constructed with that organization id and every query it issues carries it, so
 * a tenant boundary is a property of the object graph rather than of remembering
 * to pass a filter.
 */
export function authorityFor(org: OrganizationId, env: NodeJS.ProcessEnv = process.env): Authority {
  const key = String(org);
  const existing = cache.get(key);
  if (existing) return existing;

  const sql = authorityExecutor();
  const store = new ActionAuthorityStore(sql, org);
  const built: Authority = {
    store,
    authorization: new AuthorizationService(store, org, env),
    enforcement: new EnforcementPoint(store, org, env),
  };
  cache.set(key, built);
  return built;
}

/** Test hook: drops cached per-tenant objects and the engine selection. */
export async function resetActionAuthority(): Promise<void> {
  cache.clear();
  executor = null;
  initializedDriver = null;
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}

export { ActionAuthorityStore } from "./store";
export { AuthorizationService } from "./authorization-service";
export { EnforcementPoint } from "./enforcement-point";
