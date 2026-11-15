/**
 * Explicit persistence-backend selection (P0-4).
 *
 * ## Why this is a module and not two `process.env` reads
 *
 * The engine a deployment runs on decides where every byte of customer data lives.
 * Inferring it — "a DATABASE_URL is set, so they probably meant PostgreSQL" — means
 * a stray variable in a platform's default environment silently redirects
 * persistence. The rule here is the opposite and has no exceptions: the driver is
 * whatever `DATABASE_DRIVER` says, and an unrecognised value is a refusal to start,
 * never a fallback.
 *
 * ## What is honestly supported today
 *
 * PostgreSQL is a **pilot**, not the production path yet, and this module is where
 * that is enforced rather than described. The schema, the migrations and the shared
 * rate-limit store are real and run against a real PostgreSQL server. The
 * repositories are not: `server/repositories/sqlite.ts` is built on
 * synchronous better-sqlite3 prepared statements, and porting them is an
 * asynchronous conversion of the whole data layer.
 *
 * So `DATABASE_DRIVER=postgres` **refuses to boot** with an explanation of exactly
 * what is missing. It does not start on SQLite while reporting PostgreSQL, and it
 * does not start on a PostgreSQL database the repositories cannot read. Either
 * would be the "feature that is displayed as available but does not work" that the
 * brief forbids; a refusal with a reason is the only answer that is not a lie.
 *
 * `RATE_LIMIT_STORE=postgres` is independent and *is* supported: the rate-limit
 * store is a small, asynchronous, self-contained consumer, which is why it is the
 * component the PostgreSQL pilot proves itself on.
 */

import "./env-compat";
import { isLocalMode } from "./local-mode";

export type DatabaseDriver = "sqlite" | "postgres";

export const DATABASE_DRIVERS: readonly DatabaseDriver[] = ["sqlite", "postgres"];

export interface DatabaseConfig {
  driver: DatabaseDriver;
  /** SQLite file path. Present only for the sqlite driver. */
  file?: string;
  /** libpq connection string. Present only for the postgres driver. */
  connectionString?: string;
}

export class DatabaseConfigError extends Error {}

/**
 * Two refusals that used to be silent acceptances.
 *
 * Both exist because "Oathrion is running" was compatible with "Oathrion is not running on the
 * database you configured", and a persistence backend that is not the one the operator
 * asked for is not a detail they can be left to discover in production.
 *
 * ## 1. A DATABASE_URL that nothing reads
 *
 * Setting `DATABASE_URL` and forgetting `DATABASE_DRIVER=postgres` produced a server
 * that booted happily on the local `data.db` file. Nothing was wrong from the process's
 * point of view, and nothing said otherwise: the connection string simply sat in the
 * environment, unused, while writes went to a file that no other instance can see and
 * that a container restart discards.
 *
 * Inferring `postgres` from the URL's presence is still refused — a stray variable in a
 * platform's default environment must not redirect persistence. But silently *ignoring*
 * it is the mirror-image failure, and the one that actually bites: the operator did
 * express an intent. So an unread `DATABASE_URL` is now a refusal, and the operator has
 * to say which of the two they meant.
 *
 * `RATE_LIMIT_STORE=postgres` is a legitimate reader, so that combination is allowed.
 * `OATHRION_IGNORE_DATABASE_URL=true` is the deliberate escape hatch for the one case that
 * is genuinely intentional — a test that runs the in-memory limiter while a connection
 * string happens to be exported. It has to be written down, which is the point.
 *
 * ## 2. SQLite in production
 *
 * `NODE_ENV=production` on synchronous better-sqlite3 means one file, one process, no
 * shared state, and no second instance. That is a demo, not a deployment, and it is now
 * refused outright.
 *
 * Phase 11 made it an acknowledgement rather than a refusal: `OATHRION_ALLOW_SQLITE_IN_PRODUCTION=true`
 * let an operator ship on a file as long as they wrote the decision down. That was the
 * honest answer while PostgreSQL repositories did not exist. They do now, so the
 * acknowledgement has become the thing it was protecting against — a one-variable route
 * to a single-process deployment — and Phase 12.2 removed it. The variable is inert:
 * nothing reads it, and `database-config.test.ts` asserts that every spelling of it still
 * refuses. Production requires `DATABASE_DRIVER`, `OATHRION_IDENTITY_PLANE`,
 * `OATHRION_ACTION_AUTHORITY_DRIVER` and `RATE_LIMIT_STORE` to all name postgres; see
 * `validateProductionConfiguration` at the bottom of this file.
 *
 * SQLite remains fully supported outside production, which is where the development
 * workflow and most of the test suite live.
 */
function sqliteConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  const rateLimitStore = env.RATE_LIMIT_STORE?.trim().toLowerCase();
  const urlIsRead = rateLimitStore === "postgres";
  const urlIgnoredOnPurpose = env.OATHRION_IGNORE_DATABASE_URL?.trim() === "true";

  if (url !== undefined && url !== "" && !urlIsRead && !urlIgnoredOnPurpose) {
    throw new DatabaseConfigError(
      `DATABASE_URL is set but nothing reads it, so Oathrion would store every row in a local ` +
        `SQLite file while a PostgreSQL connection string sits unused.\n` +
        `  That combination is refused rather than resolved, because both readings are plausible:\n` +
        `    - you meant PostgreSQL          → set DATABASE_DRIVER=postgres\n` +
        `    - you meant the shared limiter  → set RATE_LIMIT_STORE=postgres\n` +
        `    - you meant to ignore the URL   → set OATHRION_IGNORE_DATABASE_URL=true\n` +
        `  Oathrion does not infer the driver from DATABASE_URL, and no longer ignores it either. ` +
        `The value is not repeated here because it contains a password.`,
    );
  }

  /*
   * Le mode local (`oathrion wrap`) est la seule exception, et elle ne s'ouvre pas par
   * l'environnement : seul le point d'entrée `server/local-entry.ts` l'active, et il n'est
   * pas dans le paquet serveur (`server/local-mode.ts`). La phrase ci-dessous reste vraie.
   */
  if (env.NODE_ENV?.trim() === "production" && !isLocalMode()) {
    throw new DatabaseConfigError(
      `NODE_ENV=production with the SQLite driver is refused.\n` +
        `  SQLite here is synchronous better-sqlite3 on one local file: no second instance can ` +
        `read it, and a container restart on ephemeral storage discards it.\n` +
        `  Production requires DATABASE_DRIVER=postgres, OATHRION_IDENTITY_PLANE=postgres, ` +
        `OATHRION_ACTION_AUTHORITY_DRIVER=postgres, and RATE_LIMIT_STORE=postgres.\n` +
        `  No environment variable can opt SQLite into production.`,
    );
  }

  return { driver: "sqlite", file: env.OATHRION_DB?.trim() || "data.db" };
}

/**
 * A connection string is never assembled from parts here, and no host, user,
 * password, port or database name has a default. Every credential arrives whole,
 * in one variable, from the environment — so there is no code path in which a
 * default password is tried, and nothing to leak by reading this file.
 */
/*
 * Phase 10: exported. The action authorization plane has its own driver variable
 * (`OATHRION_ACTION_AUTHORITY_DRIVER`) and needs the same connection string handling
 * with the same refusals — a second copy would be a second place where a
 * password could be echoed into an error message.
 */
export function requireConnectionString(env: NodeJS.ProcessEnv): string {
  /*
   * Reads the environment it was *given*, not `process.env`. It read the ambient
   * environment until a test passed an explicit one and got an error about a variable
   * it had just set — a small bug with a real consequence: `resolveDatabaseConfig(env)`
   * silently ignored half of its own argument, so the migration script's validation was
   * checking the process environment rather than the one it had assembled.
   */
  const raw = env.DATABASE_URL?.trim();
  if (raw === undefined || raw === "") {
    throw new DatabaseConfigError(
      `DATABASE_DRIVER is "postgres" but DATABASE_URL is not set.\n` +
        `  Set the full connection string, for example:\n` +
        `    DATABASE_URL=postgres://user:password@host:5432/placet\n` +
        `  Oathrion never assembles a connection from separate host/user/password variables and has no defaults for them.`,
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(raw)) {
    throw new DatabaseConfigError(
      `DATABASE_URL does not look like a PostgreSQL connection string (it must start with ` +
        `"postgres://" or "postgresql://"). The value is not repeated here because it contains a password.`,
    );
  }
  return raw;
}

/**
 * Resolves the configured backend, or throws with something an operator can act on.
 *
 * Does not connect and does not read the filesystem: this is pure configuration
 * resolution, so it can be called from a boot-time check before anything is opened,
 * and asserted in tests without a database.
 */
export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const raw = env.DATABASE_DRIVER?.trim().toLowerCase();

  /*
   * Absent means sqlite, which is the only value that can be a default: every
   * existing deployment and every test predates this variable and runs on SQLite.
   * Making the variable mandatory would break all of them at once for no gain in
   * safety — the unsafe direction is silently choosing *postgres*, and that is what
   * cannot happen.
   */
  if (raw === undefined || raw === "") {
    return sqliteConfig(env);
  }

  if (raw === "sqlite") {
    return sqliteConfig(env);
  }

  if (raw === "postgres" || raw === "postgresql") {
    return { driver: "postgres", connectionString: requireConnectionString(env) };
  }

  throw new DatabaseConfigError(
    `DATABASE_DRIVER is "${raw}", which is not a database Oathrion supports. ` +
      `Valid values: ${DATABASE_DRIVERS.join(", ")}. ` +
      `The variable is never guessed at — an unrecognised value stops the server rather than ` +
      `falling back to a backend you did not choose.`,
  );
}

/**
 * The message printed when someone selects PostgreSQL for application persistence
 * without saying where identity lives.
 *
 * Exported so `server/db.ts` and the tests assert on the same text, and so the
 * description of the choice lives in exactly one place.
 *
 * PHASE 12. The identity plane now has a real PostgreSQL implementation, so this is no
 * longer a refusal with one acceptable answer — it is a refusal to leave the question
 * implicit. Both answers are valid, and they mean very different deployments.
 */
export const POSTGRES_IDENTITY_PLANE_NOT_ACKNOWLEDGED =
  `DATABASE_DRIVER=postgres does not say where the IDENTITY PLANE lives, and Oathrion will not guess.\n\n` +
  `  Always on PostgreSQL when DATABASE_DRIVER=postgres:\n` +
  `    - agents, policies, executions, approvals, integrations, usage counters\n` +
  `    - the action-authorization plane (actions, grants, receipts) with\n` +
  `      OATHRION_ACTION_AUTHORITY_DRIVER=postgres\n` +
  `    - the shared rate-limit store with RATE_LIMIT_STORE=postgres\n` +
  `    - the full versioned schema and every migration (npm run migrate:postgres)\n\n` +
  `  The identity plane — users, organizations, memberships, sessions, API keys and identity\n` +
  `  tokens — is the one you have to choose:\n\n` +
  `    OATHRION_IDENTITY_PLANE=postgres   the production path (Phase 12). Sessions, API keys and\n` +
  `                                   credentials are shared, so a revocation on one instance\n` +
  `                                   is a revocation on every instance.\n` +
  `    OATHRION_IDENTITY_PLANE=sqlite     DEVELOPMENT AND TEST ONLY, and refused when\n` +
  `                                   NODE_ENV=production. Each instance then has its own\n` +
  `                                   sessions, its own API keys and its own user list:\n` +
  `                                   revoking a key on one instance leaves it live on the\n` +
  `                                   others.\n\n` +
  `  Oathrion refuses to infer this: an operator who believes identity is in PostgreSQL when it is\n` +
  `  not would revoke an API key on one instance and leave it live on the others.`;

/** Where the identity plane (users, sessions, API keys, credentials, tokens) actually lives. */
export type IdentityPlane = "sqlite" | "postgres";

export const SQLITE_IDENTITY_IN_PRODUCTION_REFUSED =
  `OATHRION_IDENTITY_PLANE=sqlite is refused when NODE_ENV=production.\n` +
  `  A SQLite identity plane is per-process: sessions, API keys and credential revocation are\n` +
  `  not shared, so a second instance authenticates against a different truth and a revoked\n` +
  `  credential stays usable somewhere. It is a development and test mode, not a deployment.\n` +
  `  Set OATHRION_IDENTITY_PLANE=postgres (with DATABASE_DRIVER=postgres) for production.`;

export const SQLITE_DRIVER_WITH_POSTGRES_IDENTITY_REFUSED =
  `OATHRION_IDENTITY_PLANE=postgres requires DATABASE_DRIVER=postgres.\n` +
  `  Asking for a PostgreSQL identity plane on the SQLite driver describes a deployment that\n` +
  `  does not exist: authorization data would be in a local file while sessions and API keys\n` +
  `  are in a shared database. Oathrion refuses the combination rather than picking one half.`;

export const POSTGRES_IDENTITY_REQUIRES_POSTGRES_AUTHORITY =
  `OATHRION_IDENTITY_PLANE=postgres requires OATHRION_ACTION_AUTHORITY_DRIVER=postgres.\n` +
  `  The action authority (grants, single-use consumption) defaults to the SQLite driver, which\n` +
  `  executes SQLite-dialect statements against whatever handle server/db.ts exported. With the\n` +
  `  identity plane on PostgreSQL there is no SQLite file to write to, so that default would\n` +
  `  either fail at the first grant or run authorization SQL through a path nobody tested.\n` +
  `  Oathrion refuses at startup instead: identity and authorization must name the same engine.`;

/**
 * Refuses a PostgreSQL identity plane paired with a non-PostgreSQL action authority.
 *
 * This is not a style rule. The two planes answer halves of one question — "who is this"
 * and "may they do it" — and a deployment that keeps them on different engines has a
 * window where one half is shared between instances and the other is not. Phase 12 found
 * the combination reachable and silent; it is now neither.
 */
export function assertAuthorityMatchesIdentityPlane(
  plane: IdentityPlane,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (plane !== "postgres") return;
  const requested = env.OATHRION_ACTION_AUTHORITY_DRIVER?.trim().toLowerCase() ?? "";
  if (requested !== "postgres") {
    throw new DatabaseConfigError(POSTGRES_IDENTITY_REQUIRES_POSTGRES_AUTHORITY);
  }
}

/**
 * Resolves where identity lives, or refuses with something an operator can act on.
 *
 * Pure: does not connect, does not read the filesystem. Four rules, and no fifth state:
 *
 *   - sqlite driver, identity unset or `sqlite`  → sqlite (every existing test and demo)
 *   - sqlite driver, identity `postgres`         → refused (incoherent)
 *   - postgres driver, identity `postgres`       → postgres (the Phase 12 production path)
 *   - postgres driver, identity `sqlite`         → allowed outside production, refused in it
 *   - postgres driver, identity unset            → refused, with both options spelled out
 */
export function resolveIdentityPlane(
  config: DatabaseConfig,
  env: NodeJS.ProcessEnv = process.env,
): IdentityPlane {
  const requested = env.OATHRION_IDENTITY_PLANE?.trim().toLowerCase();

  if (requested !== undefined && requested !== "" && requested !== "sqlite" && requested !== "postgres") {
    throw new DatabaseConfigError(
      `OATHRION_IDENTITY_PLANE is "${requested}", which is not a value Oathrion understands. ` +
        `Valid values: sqlite, postgres. An unrecognised value stops the server rather than ` +
        `selecting an identity store you did not choose.`,
    );
  }

  if (config.driver === "sqlite") {
    if (requested === "postgres") {
      throw new DatabaseConfigError(SQLITE_DRIVER_WITH_POSTGRES_IDENTITY_REFUSED);
    }
    return "sqlite";
  }

  if (requested === "postgres") return "postgres";

  if (requested === "sqlite") {
    if (env.NODE_ENV?.trim() === "production") {
      throw new DatabaseConfigError(SQLITE_IDENTITY_IN_PRODUCTION_REFUSED);
    }
    return "sqlite";
  }

  throw new DatabaseConfigError(POSTGRES_IDENTITY_PLANE_NOT_ACKNOWLEDGED);
}


/** Central fail-closed production persistence gate. */
export function validateProductionConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): { database: DatabaseConfig; identityPlane: IdentityPlane } {
  const database = resolveDatabaseConfig(env);
  const identityPlane = resolveIdentityPlane(database, env);
  if (env.NODE_ENV?.trim() !== "production") return { database, identityPlane };
  /*
   * Le mode local : un seul fichier SQLite pour tout, et rien d'autre. Un mode local qui
   * viserait PostgreSQL ne serait plus local, et mélanger les deux est refusé.
   */
  if (isLocalMode()) {
    if (database.driver !== "sqlite" || identityPlane !== "sqlite") {
      throw new DatabaseConfigError("Oathrion's local mode only uses SQLite, for data as well as identity.");
    }
    return { database, identityPlane };
  }
  if (database.driver !== "postgres") {
    throw new DatabaseConfigError("NODE_ENV=production requires DATABASE_DRIVER=postgres; SQLite is development/test only.");
  }
  if (identityPlane !== "postgres") {
    throw new DatabaseConfigError("NODE_ENV=production requires OATHRION_IDENTITY_PLANE=postgres.");
  }
  assertAuthorityMatchesIdentityPlane(identityPlane, env);
  if (env.RATE_LIMIT_STORE?.trim().toLowerCase() !== "postgres") {
    throw new DatabaseConfigError("NODE_ENV=production requires RATE_LIMIT_STORE=postgres; per-process rate limiting is not a production mode.");
  }
  return { database, identityPlane };
}
