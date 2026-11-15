/**
 * A throwaway, migrated PostgreSQL database for the local harness scripts.
 *
 * ## Why this exists
 *
 * Phase 12.2 closed the last way to run the shipped bundle on SQLite in production
 * mode: `NODE_ENV=production` now requires the driver, the identity plane, the action
 * authority and the rate-limit store to all name PostgreSQL, and no environment
 * variable opts out. Four harness scripts — smoke, e2e-enterprise, chaos and
 * pilot-sim — used to boot the production bundle against a temporary SQLite file.
 * They cannot any more, and the honest fix is to give them the engine production
 * actually uses rather than to weaken the gate for them.
 *
 * Each of those scripts needs the same three things, which is why this is shared
 * rather than copied four times: a database nothing else is using, the schema applied
 * to it, and a reliable way to remove it afterwards.
 *
 * ## One database per run, not one shared scratch database
 *
 * These scripts assert on absolute state — "a new operator starts Oathrion and there are
 * no agents yet", "this is the only receipt". A reused database makes those assertions
 * depend on what ran before, which is how a suite starts passing for the wrong reason.
 */
import { Pool } from "pg";

import { MIGRATIONS, migratePostgres } from "../../server/migrations";

export interface ThrowawayDatabase {
  /** Connection string for the database created for this run. */
  url: string;
  /** Its name, for logging. Contains no credentials. */
  name: string;
  /** Drops the database. Never throws: cleanup must not mask a real failure. */
  dispose: () => Promise<void>;
}

/** The base connection string, pointing at a database the caller may connect to. */
export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL?.trim() || env.OATHRION_TEST_PG_URL?.trim() || "";
}

/** Replaces the database component of a connection string, keeping credentials. */
function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Strips the password so a connection string can be printed. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//***@${url.host}${url.pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
}

/**
 * Creates a migrated database for this run.
 *
 * Throws if no base URL is configured or the server is unreachable. That is
 * deliberate: a harness that quietly skips because it found no database reports a
 * pass it never earned.
 */
export async function createThrowawayDatabase(
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { migrate?: boolean } = {},
): Promise<ThrowawayDatabase> {
  const base = baseUrl(env);
  if (base === "") {
    throw new Error(
      "No DATABASE_URL. Since Phase 12.2 the production bundle runs only on PostgreSQL, so " +
        "this script needs a reachable server and refuses to pass without one.\n" +
        "  DATABASE_URL=postgres://user:password@host:5432/postgres npm run <script>",
    );
  }

  // The name must be unique per run and a legal identifier: it is interpolated into
  // DDL, which cannot take a bound parameter.
  const name = `${prefix}_${process.pid}_${Date.now().toString(36)}`;
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to build DDL from an unsafe database name: ${name}`);
  }

  const admin = new Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5_000 });
  /*
   * `DROP DATABASE ... WITH (FORCE)` terminates the connections to that database, and
   * node-postgres raises that as an `error` event on a pool nobody is awaiting — an
   * uncaught exception that would kill the script during cleanup, after a successful
   * run.
   */
  admin.on("error", () => undefined);

  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw new Error(
      `could not create a throwaway database on ${redactUrl(base)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const url = urlFor(base, name);
  try {
    // `migrate: false` gives an EMPTY database — the target of a pg_restore drill.
    if (options.migrate !== false) await migratePostgres(url, MIGRATIONS);
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw new Error(
      `the schema could not be applied to ${name}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return {
    url,
    name,
    dispose: async () => {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } catch {
        // Left behind rather than hiding the failure that brought us here.
      } finally {
        await admin.end().catch(() => undefined);
      }
    },
  };
}

/**
 * La même URL, vue DEPUIS un conteneur PostgreSQL.
 *
 * Les clients `pg_dump` / `pg_restore` ne sont pas installés sur toutes les machines, et
 * `deploy/scripts/pg-run.sh` sait les exécuter dans un conteneur. Mais alors l'URL doit
 * être joignable depuis CE conteneur : `127.0.0.1:5432` désigne le serveur lui-même, et
 * le port publié sur l'hôte — souvent 55432 — n'existe pas dans son espace réseau.
 *
 * Ici et non recopié dans chaque banc : `verify-backup.ts` portait cette fonction, et
 * `verify-disaster-recovery.ts` l'a d'abord oubliée — `backup.sh` a échoué sur
 * « Connection refused » depuis l'intérieur du conteneur, avec un message qui ne dit rien
 * de la cause. Une subtilité qu'un second banc oublie est une subtilité qui appartient à
 * la bibliothèque.
 */
export function containerUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = "127.0.0.1";
  parsed.port = "5432";
  return parsed.toString();
}

/**
 * The environment a harness must pass to the production bundle so every plane is on
 * PostgreSQL. Spread this over the script's own variables.
 */
export function productionPostgresEnv(url: string): Record<string, string> {
  return {
    NODE_ENV: "production",
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: url,
    OATHRION_IDENTITY_PLANE: "postgres",
    OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
    RATE_LIMIT_STORE: "postgres",
  };
}
