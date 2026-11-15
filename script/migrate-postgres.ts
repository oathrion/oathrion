/**
 * Applies every migration to the PostgreSQL database named by DATABASE_URL.
 *
 * A separate command rather than something that happens at boot, and that is a
 * deliberate difference from the SQLite path (which migrates at import time). With
 * more than one instance, boot-time migration means every replica races to apply the
 * same DDL during a rolling deploy; the loser gets an error, and whether that is
 * harmless depends on which statement it lost on. One explicit command, run once, is
 * the operation an operator can put in a deploy pipeline and read the output of.
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/placet npm run migrate:postgres
 *
 * Exits non-zero on any failure, so a pipeline stops instead of deploying a build
 * against a schema it cannot use.
 */

import { LATEST_VERSION, MIGRATIONS, migratePostgres } from "../server/migrations";
import { resolveDatabaseConfig } from "../server/database-config";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (url === undefined || url === "") {
    console.error(
      "DATABASE_URL is not set.\n" +
        "  DATABASE_URL=postgres://user:password@host:5432/placet npm run migrate:postgres",
    );
    process.exit(1);
  }

  /*
   * Validated through the same resolver the server uses, with the driver forced, so
   * a malformed connection string is rejected by the same rule in both places. The
   * URL is never printed: it contains a password.
   */
  const config = resolveDatabaseConfig({ ...process.env, DATABASE_DRIVER: "postgres" });

  console.log(`[oathrion:migrate] target: PostgreSQL (connection string not shown)`);
  const result = await migratePostgres(config.connectionString ?? url, MIGRATIONS, {
    log: (message) => console.log(message),
  });

  if (result.applied.length === 0) {
    console.log(`[oathrion:migrate] already at version ${result.version}; nothing to apply.`);
  } else {
    console.log(
      `[oathrion:migrate] applied ${result.applied.length} migration(s); the database is at version ${result.version}.`,
    );
  }

  if (result.version !== LATEST_VERSION) {
    console.error(
      `[oathrion:migrate] the database is at version ${result.version} but this build expects ${LATEST_VERSION}.`,
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`[oathrion:migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.cause !== undefined) console.error("Underlying error:", error.cause);
  process.exit(1);
});
