/**
 * Engine selection (P0-4).
 *
 * The rule the brief asked for is "no ambiguous logic based on assumptions", and the
 * only way to keep that true over time is to pin the ambiguous cases: an empty
 * variable, a typo, a driver named without a connection string. Each of these is a
 * decision that could plausibly have gone the other way, and each one going the other
 * way silently is how a deployment ends up writing to a database nobody chose.
 */

import { describe, expect, it } from "vitest";
import {
  DatabaseConfigError,
  POSTGRES_IDENTITY_PLANE_NOT_ACKNOWLEDGED,
  resolveDatabaseConfig,
  validateProductionConfiguration,
} from "../database-config";

describe("resolveDatabaseConfig", () => {
  it("defaults to sqlite when nothing is set", () => {
    const config = resolveDatabaseConfig({});
    expect(config.driver).toBe("sqlite");
    // The historical default file, unchanged: an existing deployment that upgrades to
    // this build must keep reading the same database.
    expect(config.file).toBe("data.db");
  });

  it("treats an empty value as absent rather than as an error", () => {
    // `DATABASE_DRIVER=` in a .env file is how a variable looks when someone commented
    // out its value. Refusing to boot on that would be pedantry; guessing `postgres`
    // would be dangerous. Both resolve to the default.
    expect(resolveDatabaseConfig({ DATABASE_DRIVER: "" }).driver).toBe("sqlite");
    expect(resolveDatabaseConfig({ DATABASE_DRIVER: "   " }).driver).toBe("sqlite");
  });

  it("honours OATHRION_DB as the sqlite location", () => {
    expect(resolveDatabaseConfig({ OATHRION_DB: "/srv/placet/records.db" }).file).toBe(
      "/srv/placet/records.db",
    );
  });

  it("accepts postgres and postgresql as the same driver", () => {
    const url = "postgres://user:pw@db.internal:5432/placet";
    for (const spelling of ["postgres", "postgresql", "POSTGRES", " Postgres "]) {
      const config = resolveDatabaseConfig({ DATABASE_DRIVER: spelling, DATABASE_URL: url });
      expect(config.driver, spelling).toBe("postgres");
      expect(config.connectionString, spelling).toBe(url);
    }
  });

  it("refuses an unrecognised driver instead of falling back", () => {
    // The failure this prevents: `DATABASE_DRIVER=mysql` quietly starting on SQLite and
    // looking like it worked.
    expect(() => resolveDatabaseConfig({ DATABASE_DRIVER: "mysql" })).toThrow(DatabaseConfigError);
    expect(() => resolveDatabaseConfig({ DATABASE_DRIVER: "postgre" })).toThrow(/sqlite/);
  });

  it("refuses postgres with no connection string", () => {
    expect(() => resolveDatabaseConfig({ DATABASE_DRIVER: "postgres" })).toThrow(/DATABASE_URL/);
  });

  it("refuses a connection string that is not a postgres URL", () => {
    // A path or a MySQL URL in DATABASE_URL is a configuration mistake that would
    // otherwise surface as an obscure driver error several seconds into boot.
    expect(() =>
      resolveDatabaseConfig({ DATABASE_DRIVER: "postgres", DATABASE_URL: "/var/lib/placet.db" }),
    ).toThrow(/postgres/i);
    expect(() =>
      resolveDatabaseConfig({
        DATABASE_DRIVER: "postgres",
        DATABASE_URL: "mysql://user@host/placet",
      }),
    ).toThrow(/postgres/i);
  });

  it("never puts a credential in its error messages", () => {
    // An error thrown at boot ends up in a log aggregator. A connection string contains
    // a password, so the message must describe the problem without quoting the value.
    const secret = "s3cret-p4ssw0rd";
    try {
      resolveDatabaseConfig({
        DATABASE_DRIVER: "postgres",
        DATABASE_URL: `mysql://user:${secret}@host/placet`,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("names the plane that is still SQLite, and what it costs, before letting postgres boot", () => {
    /*
     * PHASE 11 replaces the message this test used to assert. `postgres` is now a real
     * repository backend, so a refusal saying "not yet a repository backend" would be
     * false. What remains true — and is now what the message has to carry — is that the
     * identity plane is still SQLite, and that this has an operational consequence for
     * anyone running more than one instance. The assertion is not weakened: it still
     * pins that the refusal names the limitation, names the acknowledgement variable,
     * and lists what genuinely does run on PostgreSQL, so the text cannot decay into
     * "PostgreSQL is unsupported" or into a reassuring nothing.
     */
    expect(POSTGRES_IDENTITY_PLANE_NOT_ACKNOWLEDGED).toMatch(/identity plane/i);
    expect(POSTGRES_IDENTITY_PLANE_NOT_ACKNOWLEDGED).toMatch(/sessions/i);
    expect(POSTGRES_IDENTITY_PLANE_NOT_ACKNOWLEDGED).toMatch(/OATHRION_IDENTITY_PLANE=sqlite/);
    expect(POSTGRES_IDENTITY_PLANE_NOT_ACKNOWLEDGED).toMatch(/executions/i);
  });
});

/**
 * REGRESSION — the two silent acceptances that made "Oathrion is running" compatible with
 * "Oathrion is not running on the database you configured".
 *
 * Neither of these was a crash, which is why neither was noticed: the server booted, the
 * console worked, and every row went to a local file.
 */
describe("refusing a PostgreSQL configuration that nothing applies", () => {
  const PG = "postgres://user:secret@db:5432/placet";

  it("refuses a DATABASE_URL that nothing reads instead of booting on a file", () => {
    expect(() => resolveDatabaseConfig({ DATABASE_URL: PG } as NodeJS.ProcessEnv)).toThrow(
      DatabaseConfigError,
    );
  });

  it("names the three intents rather than picking one", () => {
    try {
      resolveDatabaseConfig({ DATABASE_URL: PG } as NodeJS.ProcessEnv);
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("DATABASE_DRIVER=postgres");
      expect(message).toContain("RATE_LIMIT_STORE=postgres");
      expect(message).toContain("OATHRION_IGNORE_DATABASE_URL=true");
      // The connection string carries a password and must not be echoed.
      expect(message).not.toContain("secret");
    }
  });

  it("allows the URL when the shared limiter is the reader", () => {
    const config = resolveDatabaseConfig({
      DATABASE_URL: PG,
      RATE_LIMIT_STORE: "postgres",
    } as NodeJS.ProcessEnv);
    expect(config.driver).toBe("sqlite");
  });

  it("allows the URL when it is ignored on purpose", () => {
    const config = resolveDatabaseConfig({
      DATABASE_URL: PG,
      OATHRION_IGNORE_DATABASE_URL: "true",
    } as NodeJS.ProcessEnv);
    expect(config.driver).toBe("sqlite");
  });

  it("still refuses to infer postgres from the URL, even now", () => {
    const config = resolveDatabaseConfig({
      DATABASE_URL: PG,
      OATHRION_IGNORE_DATABASE_URL: "true",
    } as NodeJS.ProcessEnv);
    // The point of the refusal is to force a decision, NOT to start guessing.
    expect(config.driver).not.toBe("postgres");
  });
});

describe("production configuration gate", () => {
  const production = {
    NODE_ENV: "production",
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: "postgres://user:pw@db:5432/placet",
    OATHRION_IDENTITY_PLANE: "postgres",
    OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
    RATE_LIMIT_STORE: "postgres",
  } as NodeJS.ProcessEnv;

  it("accepts the complete PostgreSQL production configuration", () => {
    expect(validateProductionConfiguration(production).identityPlane).toBe("postgres");
  });

  it("refuses every legacy SQLite production override", () => {
    for (const value of [undefined, "true", "1", "yes", "on", "TRUE", "garbage"]) {
      expect(() => validateProductionConfiguration({ NODE_ENV: "production", OATHRION_ALLOW_SQLITE_IN_PRODUCTION: value } as NodeJS.ProcessEnv)).toThrow(DatabaseConfigError);
    }
  });

  it("fails closed for each required production setting", () => {
    for (const invalid of [
      { ...production, DATABASE_URL: "" },
      { ...production, DATABASE_DRIVER: "sqlite" },
      { ...production, OATHRION_IDENTITY_PLANE: "sqlite" },
      { ...production, OATHRION_ACTION_AUTHORITY_DRIVER: "sqlite" },
      { ...production, RATE_LIMIT_STORE: "memory" },
      { ...production, OATHRION_IDENTITY_PLANE: "unknown" },
    ]) {
      expect(() => validateProductionConfiguration(invalid)).toThrow(DatabaseConfigError);
    }
  });

  it("leaves development and test SQLite compatibility untouched", () => {
    expect(validateProductionConfiguration({ NODE_ENV: "test" } as NodeJS.ProcessEnv).database.driver).toBe("sqlite");
  });
});
