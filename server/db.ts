/**
 * Database connection, schema migration, and boot-time maintenance.
 *
 * The schema is no longer created here. It is owned by the versioned migrations in
 * `server/migrations/`, applied through the ledger-backed runner, so a database
 * carries a known version and a downgrade or a rewritten history is refused
 * instead of guessed at (P0-3). What remains in this file is the connection and
 * the two boot-time maintenance sweeps, which are *not* migrations: they must run
 * on every start, not once.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describeDatabaseOpenFailure } from "./config-check";
import {
  DatabaseConfigError,
  validateProductionConfiguration,
  type IdentityPlane,
} from "./database-config";
import {
  createSyncPostgresDatabase,
  type SyncPostgresDatabase,
} from "./identity/sync-postgres";
import { createSqliteMigrationDriver, LATEST_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import "./env-compat";

/*
 * Opened here, at import time, which is why this cannot be validated from
 * `server/index.ts`: the import runs first. better-sqlite3 reports a missing
 * directory, an unwritable directory and a path that is a directory with the single
 * message "unable to open database file", and never mentions the path or the
 * variable that supplied it — so the failure is re-described before it propagates.
 * The original error is kept as `cause` so nothing is hidden.
 */
/*
 * The backend is resolved explicitly (P0-4) rather than assumed. Two failures are
 * possible before a single byte is read, and both exit instead of degrading:
 *
 *   - an unrecognised or incomplete configuration (`DATABASE_DRIVER=mysql`,
 *     `postgres` with no `DATABASE_URL`);
 *   - `postgres`, which is a real and tested backend for the schema and for the
 *     shared rate-limit store, but not yet for the repositories.
 *
 * Starting on SQLite while the operator asked for PostgreSQL would be the most
 * expensive kind of silent fallback: it would look like it worked, and the data
 * would be in the wrong place.
 */
let resolved;
let identityPlane: IdentityPlane;
try {
  const configuration = validateProductionConfiguration(process.env);
  resolved = configuration.database;
  identityPlane = configuration.identityPlane;
} catch (error) {
  console.error(
    `\n[oathrion] ${error instanceof DatabaseConfigError ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

/*
 * One of the two is opened, never both. In postgres identity mode NO SQLite file is
 * opened at all: there is no handle to fall back to, which is the only way to make
 * "no silent fallback" a property of the process rather than a promise in a comment.
 */
let identityHandle: Database.Database;
let drizzleHandle: ReturnType<typeof drizzle>;
let closeHandles: () => void;

if (identityPlane === "postgres") {
  const connectionString = resolved.connectionString;
  if (connectionString === undefined || connectionString === "") {
    // Unreachable: resolveDatabaseConfig already refuses postgres without a URL. Kept
    // because an unreachable branch that exits is cheaper than one that dereferences.
    console.error(
      `\n[oathrion] the identity plane is configured on PostgreSQL but no connection string was resolved.\n`,
    );
    process.exit(1);
  }

  let identity: SyncPostgresDatabase;
  try {
    identity = createSyncPostgresDatabase(connectionString);
  } catch (error) {
    console.error(
      `\n[oathrion] the identity plane is configured on PostgreSQL but it could not be opened, so the ` +
        `server will not start. There is no SQLite fallback for identity: starting on a local file ` +
        `would mean sessions, API keys and credential revocation are not shared between instances.\n` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  /*
   * Migrations are NOT applied here, for the same reason as the data plane in Phase 11:
   * several instances starting at once would race on DDL. The schema is applied by
   * `npm run migrate:postgres`, and a process that finds it absent or behind refuses to
   * start rather than accept writes the schema cannot honour.
   */
  try {
    const row = identity
      .prepare(`SELECT max(version) AS version FROM schema_migrations`)
      .get() as { version: number | null } | undefined;
    const applied = Number(row?.version ?? 0);
    if (applied < LATEST_VERSION) {
      throw new Error(
        `the identity plane's PostgreSQL schema is at version ${applied}, and this build needs ` +
          `${LATEST_VERSION}. Run: npm run migrate:postgres`,
      );
    }
  } catch (error) {
    console.error(
      `\n[oathrion] the identity plane's PostgreSQL schema is not usable, so the server will not start.\n` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  /*
   * The same two boot sweeps as the SQLite path, against PostgreSQL. They are not
   * migrations — they must run on every start — and they are idempotent, which is what
   * makes them safe to run from several instances at once.
   */
  identity
    .prepare(
      `UPDATE executions
          SET run_state = 'failed',
              last_error = coalesce(last_error, ?)
        WHERE run_state = 'running'`,
    )
    .run("Interrupted: the server restarted while the tool was running.");
  identity
    .prepare(
      `UPDATE sessions
          SET revoked_at = expires_at, revoked_by = 'system:expiry'
        WHERE revoked_at IS NULL AND expires_at < ?`,
    )
    .run(new Date().toISOString());

  /*
   * The cast, stated plainly: the PostgreSQL handle implements the subset of the
   * better-sqlite3 surface that the identity stores actually use (prepare/get/all/run,
   * exec, transaction). Anything outside that subset throws instead of pretending —
   * `pragma` is the one deliberate no-op, because its only production caller asks for
   * WAL mode, which has no meaning here.
   */
  identityHandle = identity as unknown as Database.Database;
  /*
   * The Drizzle handle is SQLite-specific and has exactly two consumers, both on the
   * SQLite data path (server/quotas.ts, server/repositories/sqlite.ts). In postgres mode
   * those paths are already unreachable — `repositoriesFor` throws rather than return
   * SQLite repositories — so this is a proxy that throws rather than a second engine
   * quietly available to whatever finds it.
   */
  drizzleHandle = new Proxy({} as ReturnType<typeof drizzle>, {
    get(_target, property) {
      throw new Error(
        `[oathrion] the Drizzle SQLite handle is not available when the identity plane runs on ` +
          `PostgreSQL (attempted: ${String(property)}). This is not a fallback path.`,
      );
    },
  });
  closeHandles = () => identity.close();

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.log("[oathrion] identity plane: postgres (sessions, API keys and credentials are shared)");
  }
} else {
  /*
   * In `postgres` driver mode with a SQLite identity plane — development and tests only —
   * this file opens a SQLite database for the identity plane ONLY. It is not a fallback
   * for the repositories: `repositoriesFor` throws rather than return SQLite repositories
   * when the driver is postgres (see server/repositories/index.ts), so there is no path by
   * which an agent, a policy, an execution, an approval or a receipt can be read from or
   * written to this file while PostgreSQL is configured.
   *
   * The path comes from OATHRION_DB when set. `resolved.file` is null in postgres mode, so
   * the default is named `identity.db` rather than `data.db`.
   */
  const databasePath = resolved.file ?? process.env.OATHRION_DB?.trim() ?? "identity.db";
  let sqlite: Database.Database;
  try {
    sqlite = new Database(databasePath);
  } catch (error) {
    /*
     * Printed and exited rather than re-thrown. Throwing from module scope in the
     * bundled build makes Node print three lines of minified bundle as a code frame
     * *above* the message, then a stack and a `[cause]` below it, so the one paragraph
     * that tells the operator what to fix is buried in noise they cannot act on.
     */
    console.error(`\n${describeDatabaseOpenFailure(databasePath, error)}\n`);
    process.exit(1);
  }
  sqlite.pragma("journal_mode = WAL");

  /*
   * Schema migrations run at import time, synchronously, before any repository can
   * issue a query. A failure here exits the process: a server that is up but on an
   * unknown schema version is more dangerous than one that refused to start.
   */
  try {
    // Quiet under the test runner: forty suites each creating a fresh database would
    // otherwise bury real assertions under migration chatter.
    const verbose = process.env.NODE_ENV !== "test";
    runMigrations(createSqliteMigrationDriver(sqlite), MIGRATIONS, {
      // eslint-disable-next-line no-console
      log: verbose ? (message) => console.log(message) : undefined,
    });
  } catch (error) {
    console.error(
      `\n[oathrion] the database schema could not be migrated, so the server will not start.\n` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (error instanceof Error && error.cause !== undefined) {
      console.error("Underlying error:", error.cause);
    }
    process.exit(1);
  }

  /**
   * Crash recovery. A row left `running` by a process that died can never finish,
   * so at boot it is demoted back to `failed` — retryable, and never silently
   * counted as a successful tool call.
   */
  sqlite.exec(
    `UPDATE executions
        SET run_state = 'failed',
            last_error = coalesce(last_error, 'Interrupted: the server restarted while the tool was running.')
      WHERE run_state = 'running'`,
  );

  /**
   * Sessions outlive the process, so a restart must not resurrect one that had
   * already expired. Expired rows are marked revoked at boot rather than deleted,
   * keeping the list auditable.
   */
  // `expires_at` is written by the application as a JavaScript ISO-8601 string
  // (`2026-08-19T00:45:00.000Z`), while SQLite's `datetime('now')` yields
  // `2026-08-19 00:45:00`. The comparison is lexicographic, and at index 10 the
  // ISO `'T'` (0x54) sorts after the space (0x20) — so an expired session from
  // the current day always compared as *greater* than "now" and was never swept.
  sqlite
    .prepare(
      `UPDATE sessions
          SET revoked_at = expires_at, revoked_by = 'system:expiry'
        WHERE revoked_at IS NULL AND expires_at < ?`,
    )
    .run(new Date().toISOString());

  identityHandle = sqlite;
  drizzleHandle = drizzle(sqlite);
  closeHandles = () => {
    if (sqlite.open) sqlite.close();
  };
}

export const db = drizzleHandle;
export const rawDb = identityHandle;

/** Where the identity plane of this process actually lives. Read by tests and by /api diagnostics. */
export const IDENTITY_PLANE: IdentityPlane = identityPlane;

/**
 * Closes the SQLite handle.
 *
 * Called from the graceful-shutdown path. WAL mode leaves a `-wal` and `-shm`
 * alongside the database; closing cleanly checkpoints them back into the main file
 * so the next process — or the next container mounting the same volume — does not
 * inherit a hot journal it has to recover.
 *
 * Never throws: a shutdown must not be blocked by a handle that refuses to close,
 * and by this point the process is on its way out regardless.
 */
export function closeDatabase(): void {
  try {
    closeHandles();
  } catch (error) {
    console.error("[db] error while closing the database:", error);
  }
}
