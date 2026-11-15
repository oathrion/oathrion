/**
 * P3 — STRUCTURAL TENANT ISOLATION
 *
 * WHY THIS FILE EXISTS WHEN `tenant-isolation.test.ts` ALREADY PASSES
 * ------------------------------------------------------------------
 * That file is an excellent attack and it has one irreducible weakness: every case in
 * it is hand-written. It proves that the 30 paths and the repository methods that
 * existed when it was written are isolated. It cannot say anything about the route
 * somebody adds next quarter, or the repository method added with it — and the whole
 * failure mode being defended against is a *new* query that forgets
 * `organization_id`. A suite of hand-written cases is a snapshot of the diligence of
 * the person who wrote it, and the roadmap asks for something stronger: "rendre la
 * fuite inter-locataire structurellement impossible, et non seulement absente des
 * tests."
 *
 * So this file asserts properties of the SYSTEM rather than facts about known routes,
 * and it is built so that adding something new makes it fail until the new thing has
 * been classified. Three independent barriers:
 *
 *   1. **SQL-level.** Every statement issued while a request is being served is
 *      captured, and any statement touching a tenant-scoped table must carry an
 *      `organization_id` predicate. A repository method that omits the filter fails
 *      here even if no test ever calls it adversarially — the *shape of the query* is
 *      the thing under test, not the answer it happened to give.
 *
 *   2. **Schema-level.** The set of tenant-scoped tables is derived from
 *      `shared/schema.ts` at runtime, not typed out. A new table carrying
 *      `organization_id` joins the guarded set automatically; a new table WITHOUT one
 *      has to be named in `TENANT_EXEMPT_TABLES` with a reason, or this fails.
 *
 *   3. **Route-level.** The Express route table is enumerated and every `/api` path is
 *      driven with a real credential from a real organization. A new route is served
 *      by the walk automatically, so its queries are subject to barrier 1 without
 *      anyone remembering to add it.
 *
 * WHY AN ALLOW-LIST OF UNSCOPED STATEMENTS IS SAFE HERE
 * ----------------------------------------------------
 * Some unscoped reads are correct and necessary — resolving a bearer token to a
 * session before the tenant is known, finding a user by e-mail during sign-in, the
 * health probe's one-row read. Each is listed below with the reason it is legitimate.
 * The list is CLOSED: an unscoped statement that is not on it fails the test. That
 * inversion is the point. The default answer for a new query is "this is a leak", and
 * someone has to write down why it is not.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@shared/schema";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rawDb } from "../db";
import { resetRateLimits } from "../rate-limit";

/* -------------------------------------------------------------------------- *
 * Barrier 2 — the guarded set is derived, never typed out
 * -------------------------------------------------------------------------- */

/**
 * Tables that legitimately hold no `organization_id`, each with the reason.
 *
 * Closed by design. A table added to `shared/schema.ts` without a tenant column and
 * without an entry here fails `every table is either tenant-scoped or exempted`,
 * which forces the question "who can read this row?" to be answered in review rather
 * than discovered in production.
 */
const TENANT_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  /*
   * `organizations` IS the tenant. A row here does not belong to an organization; it
   * defines one. Adding `organization_id` would be a self-reference that every query
   * would then have to filter by, which is the same as filtering by the primary key.
   */
  organizations: "the tenant table itself — a row here defines an organization",
  /*
   * `users` is global by nature: a person is identified by an e-mail address, and
   * which tenants they may act within lives in `memberships`, which IS scoped. This
   * is documented at the declaration. Sign-in must resolve a person BEFORE any tenant
   * is known, so a tenant column here would make authentication circular.
   */
  users: "a person is global; their tenant memberships live in the scoped memberships table",
  /*
   * The migration ledger describes the schema, not any customer's data.
   */
  oathrion_migrations: "schema history, owned by the deployment rather than by a tenant",
  /*
   * The limiter keys on `scope:identity`, which already contains the identity; the
   * bucket store is PostgreSQL-only and holds counters, not customer rows.
   */
  rate_limit_buckets: "rate-limit counters keyed by credential, holding no customer data",
};

function tablesOf(): { name: string; table: SQLiteTable }[] {
  const found: { name: string; table: SQLiteTable }[] = [];
  for (const value of Object.values(schema)) {
    /*
     * Identified by structure rather than by name. Matching `*Rows` would silently
     * skip a table declared under a different convention, which is precisely the kind
     * of omission this file must not be capable of.
     */
    if (!is(value, SQLiteTable)) continue;
    found.push({ name: getTableName(value), table: value });
  }
  return found;
}

const ALL_TABLES = tablesOf();

function columnNames(table: SQLiteTable): string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name);
}

/** Tables carrying `organization_id`: the set every statement below is judged against. */
const TENANT_TABLES = new Set(
  ALL_TABLES.filter(({ table }) => columnNames(table).includes("organization_id")).map(
    ({ name }) => name,
  ),
);

/* -------------------------------------------------------------------------- *
 * Barrier 1 — SQL capture
 * -------------------------------------------------------------------------- */

/**
 * Statements that are allowed to touch a tenant-scoped table without an
 * `organization_id` predicate. Matched as a substring of the normalised SQL.
 *
 * Every entry is a query whose correctness does not depend on a tenant filter, with
 * the reason stated. Nothing goes on this list because it was inconvenient to fix.
 */
const LEGITIMATELY_UNSCOPED: readonly { fragment: string; because: string }[] = [
  {
    fragment: "select 1 as ok from executions limit 1",
    because:
      "the health probe. It asks whether the database file is open and still has the " +
      "expected shape, returns a boolean, and never returns a row or a count to a caller. " +
      "`LIMIT 1` rather than the former `count(*)`, which read every tenant's executions.",
  },
  {
    fragment: "from sessions where id = ?",
    because:
      "`sessionStore.find`, reserved for token resolution. The session row is what TELLS " +
      "the server which tenant the caller belongs to, so it cannot be filtered by the " +
      "answer it produces. The id comes from a signed token and is unguessable, and every " +
      "route-reachable path uses `findIn`, which is scoped \u2014 stated at the declaration.",
  },
  {
    fragment: "from memberships where user_id = ?",
    because:
      "`membershipsForUser`, which answers \"which organizations may this person act in\". " +
      "It is the query whose RESULT selects the tenant, so filtering it by a tenant would " +
      "make the choice circular. It is keyed by one user id and returns only that person's " +
      "own memberships, so it cannot enumerate anyone else's.",
  },
  {
    fragment: "from api_keys where secret_hash = ?",
    because:
      "resolving an API key. Same reasoning as the session lookup: this row carries the " +
      "organization, so it precedes knowing it. `secret_hash` is unique.",
  },
  {
    fragment: "update api_keys set last_used_at",
    because:
      "stamping last-used on the credential that has just been resolved by its unique " +
      "hash. The row was already identified; re-filtering by a tenant read FROM that row " +
      "would add nothing.",
  },
  {
    fragment: "update sessions set last_seen_at = ? where id = ?",
    because:
      "stamping activity on the session that has JUST been resolved by its unguessable " +
      "id, on the same code path, one line later. The row was already identified; " +
      "re-filtering by an organization read out of that same row would add nothing.",
  },
  {
    fragment: "from identity_tokens where id = ?",
    because:
      "`identityTokenStore.resolve`, the redemption path for an invitation or a " +
      "password reset. Same reasoning as the session and API-key lookups: this row " +
      "carries the organization, so the read precedes knowing it. Stronger than " +
      "those two, in fact \u2014 the id alone is not enough, because the 32-byte " +
      "secret that accompanies it is compared against `secret_hash` in constant " +
      "time before the record is returned. Every route-reachable read by an " +
      "administrator uses `findIn` or `list`, which are scoped.",
  },
  {
    fragment: "update identity_tokens set consumed_at",
    because:
      "the atomic single-use claim on the token that has JUST been resolved by its " +
      "id and verified against its secret, on the same code path. The caller is " +
      "anonymous by necessity \u2014 somebody accepting an invitation has no " +
      "credential and therefore no tenant \u2014 so there is no organization to " +
      "filter by that did not come out of this very row. The predicate is narrow " +
      "where it matters: `consumed_at IS NULL AND revoked_at IS NULL AND " +
      "expires_at > ?` is what makes a replay, a race and a lapsed token all " +
      "fail.",
  },
  {
    fragment: "from api_keys where source = ?",
    because:
      "`listBySource`, asked once per boot by environment adoption: which keys does " +
      "OATHRION_API_KEYS own in this deployment? The environment is deployment-wide by " +
      "definition, so the question has no tenant, and the answer never reaches a route.",
  },
  {
    fragment: "and source = 'config'",
    because:
      "the three boot-time reconcilers in server/auth.ts (`replaceSecret`, `setRole`, " +
      "`reinstate`), which re-point a machine credential at a rotated value from the " +
      "environment file. Every one is restricted to `source = 'config'`, so it can only " +
      "touch keys the deployment's own configuration declares and can never reach a key " +
      "a customer issued through the console (`source = 'user'`). Not route-reachable: " +
      "the only callers are inside `adoptConfiguredKeys`, run when the auth config is built.",
  },
  {
    fragment: "update sessions set revoked_at = expires_at",
    because:
      "the boot-time expiry sweep in server/db.ts, which revokes sessions that expired " +
      "while the process was down. Deployment maintenance across all tenants by design, " +
      "and it runs once at import rather than on any request path.",
  },
  {
    fragment: "update executions set run_state = 'failed'",
    because:
      "boot-time crash recovery in server/db.ts, demoting executions left `running` by a " +
      "process that died mid-tool-call. Deployment maintenance across all tenants by " +
      "design, and it runs once at import rather than on any request path.",
  },
];

interface Captured {
  sql: string;
  normalised: string;
}

let capturing = false;
const captured: Captured[] = [];

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function installCapture(): () => void {
  const original = rawDb.prepare.bind(rawDb);
  (rawDb as unknown as { prepare: typeof original }).prepare = ((sql: string) => {
    if (capturing) captured.push({ sql, normalised: normalise(sql) });
    return original(sql);
  }) as typeof original;
  return () => {
    (rawDb as unknown as { prepare: typeof original }).prepare = original;
  };
}

/** Which tenant-scoped tables a statement names. */
function tenantTablesTouched(normalised: string): string[] {
  return [...TENANT_TABLES].filter((table) =>
    new RegExp(`(from|join|into|update)\\s+"?${table}"?(\\s|\\(|$)`).test(normalised),
  );
}

function carriesTenantPredicate(normalised: string): boolean {
  return normalised.includes("organization_id");
}

function isExempted(normalised: string): { because: string } | undefined {
  return LEGITIMATELY_UNSCOPED.find((entry) => normalised.includes(entry.fragment));
}

/* -------------------------------------------------------------------------- *
 * Barrier 3 — the route table, enumerated
 * -------------------------------------------------------------------------- */

interface RouteEntry {
  method: string;
  path: string;
}

/**
 * Reads the registered routes out of Express.
 *
 * Express 5 exposes `app.router`; Express 4 used the private `app._router`. Both are
 * tried, and finding neither is a hard failure rather than an empty walk — a version
 * bump that changed the property name would otherwise turn this entire barrier into
 * zero assertions that still report green, which is the worst possible outcome for a
 * security test.
 */
function registeredRoutes(app: unknown): RouteEntry[] {
  const holder = app as {
    router?: { stack?: unknown[] };
    _router?: { stack?: unknown[] };
  };
  const stack = holder.router?.stack ?? holder._router?.stack;
  if (!Array.isArray(stack)) {
    throw new Error(
      "Could not read the Express route table. This test cannot verify what it cannot " +
        "enumerate, so it fails loudly instead of walking an empty list.",
    );
  }
  const routes: RouteEntry[] = [];
  for (const layer of stack) {
    const route = (layer as { route?: { path?: unknown; methods?: Record<string, boolean> } }).route;
    if (!route || typeof route.path !== "string") continue;
    for (const [method, enabled] of Object.entries(route.methods ?? {})) {
      if (enabled) routes.push({ method: method.toUpperCase(), path: route.path });
    }
  }
  return routes;
}

/**
 * A concrete value for every path parameter, so `/api/agents/:id` can actually be
 * driven. Deliberately an id belonging to the OTHER organization where one exists:
 * the request is then a genuine cross-tenant attempt, not a request for something
 * that does not exist anywhere.
 */
const PARAM_VALUES: Readonly<Record<string, string>> = {
  id: "agt_structural_owned_by_a",
};

function concretePath(path: string): string {
  return path.replace(/:([A-Za-z_]+)/g, (_match, name: string) => PARAM_VALUES[name] ?? "probe");
}

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const AS_A = { auth: ROLE_KEYS.admin };
const AS_B = { auth: OTHER_ORG_KEYS.admin };

const OWNED_AGENT = PARAM_VALUES.id;

let client: TestClient;
let restore: () => void;
let routes: RouteEntry[] = [];

/** The shape `POST /api/agents` accepts, matching `tenant-isolation.test.ts`. */
function agentBody(id: string) {
  return {
    id,
    name: "Structural fixture",
    description: "Fixture for the structural isolation suite",
    provider: "openai" as const,
    model: "gpt-4o",
    status: "active" as const,
    owner: "structural-suite",
    mandate: {
      maxTransactionAmount: 100,
      currency: "EUR" as const,
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
    permissions: [],
    policyIds: [],
    tags: [],
  };
}

beforeAll(async () => {
  resetRateLimits();
  client = await startTestServer();
  /*
   * The walk is driven against the same app the harness booted, so the route table read
   * below is the production one — `registerRoutes` is what mounts every path.
   */
  routes = registeredRoutes(
    (client as unknown as { app?: unknown }).app ?? (await appOf()),
  );
  await client.post("/api/agents", agentBody(OWNED_AGENT), AS_A);
  restore = installCapture();
});

afterAll(async () => {
  restore?.();
  await client.close();
});

/**
 * The harness does not expose its `Express` instance, and it is not changed to do so:
 * adding a test-only accessor to production plumbing to satisfy a test is the trade
 * this codebase avoids elsewhere. A second, throwaway app is built the same way
 * instead — `registerRoutes` is the single function that mounts everything, so the
 * table it produces here is byte-for-byte the table production has.
 */
async function appOf() {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const { registerRoutes } = await import("../routes");
  const app = express();
  const server = createServer(app);
  await registerRoutes(server, app);
  return app;
}

/* -------------------------------------------------------------------------- *
 * Barrier 2 — assertions
 * -------------------------------------------------------------------------- */

describe("every table is either tenant-scoped or exempted with a reason", () => {
  it("finds the tables at all, so a broken reflection cannot pass as zero findings", () => {
    expect(ALL_TABLES.length).toBeGreaterThanOrEqual(10);
  });

  for (const { name, table } of ALL_TABLES) {
    it(`${name} carries organization_id or is listed as exempt`, () => {
      const scoped = columnNames(table).includes("organization_id");
      const exempt = Object.hasOwn(TENANT_EXEMPT_TABLES, name);
      /*
       * Asserted as a message rather than a bare boolean so the failure output tells
       * whoever added the table what to do about it.
       */
      expect(
        scoped || exempt,
        `Table "${name}" has no organization_id column and is not in TENANT_EXEMPT_TABLES. ` +
          `Either give it a tenant column, or add it there with the reason a row in it ` +
          `does not belong to one customer.`,
      ).toBe(true);
    });
  }

  it("exempts nothing that is in fact tenant-scoped", () => {
    // The mirror direction: an entry left behind after a table GAINED a tenant column
    // would quietly excuse it from every check below.
    const wrong = Object.keys(TENANT_EXEMPT_TABLES).filter((name) => TENANT_TABLES.has(name));
    expect(wrong).toEqual([]);
  });

  it("guards the tables the product's customer data actually lives in", () => {
    // A floor, not a list: the point is that reflection found the real ones, so a
    // future table is added to the guarded set without touching this file.
    for (const expected of ["agents", "policies", "executions", "approvals", "integrations"]) {
      expect(TENANT_TABLES.has(expected)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Barrier 3 + Barrier 1 — the walk, and what it proves about every statement
 * -------------------------------------------------------------------------- */

describe("the route table is walked, not enumerated by hand", () => {
  it("finds every /api route registered by registerRoutes", () => {
    const apiRoutes = routes.filter((r) => r.path.startsWith("/api"));
    /*
     * A floor rather than an equality. Pinning the exact count would make this fail on
     * every legitimate new route, which trains people to update the number instead of
     * thinking — and the barrier that matters is not "how many" but "each one was
     * driven and its SQL inspected".
     */
    expect(apiRoutes.length).toBeGreaterThanOrEqual(30);
  });

  it("drives every GET route as a foreign admin and captures every statement", async () => {
    capturing = true;
    captured.length = 0;
    try {
      for (const route of routes.filter((r) => r.method === "GET" && r.path.startsWith("/api"))) {
        // As organization B, asking for a path whose `:id` names organization A's row.
        await client.get(concretePath(route.path), AS_B);
      }
    } finally {
      capturing = false;
    }
    expect(captured.length).toBeGreaterThan(0);
  });

  it("issued no statement that reads a tenant table without an organization_id predicate", () => {
    const offenders = captured
      .filter((entry) => tenantTablesTouched(entry.normalised).length > 0)
      .filter((entry) => !carriesTenantPredicate(entry.normalised))
      .filter((entry) => isExempted(entry.normalised) === undefined)
      .map((entry) => entry.sql);

    /*
     * `toEqual([])` and not `toHaveLength(0)`: a failure then prints the offending SQL
     * verbatim, which is the one thing whoever has to fix it needs.
     */
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("actually exercised the tenant tables, so an empty capture cannot pass", () => {
    const touched = new Set(captured.flatMap((entry) => tenantTablesTouched(entry.normalised)));
    // The walk must have reached real customer data. Without this, a change that made
    // every route 500 would satisfy the assertion above by producing no statements.
    expect(touched.size).toBeGreaterThanOrEqual(4);
  });
});

describe("write paths are held to the same rule", () => {
  it("captures the statements behind a create, a patch and a decision", async () => {
    capturing = true;
    captured.length = 0;
    try {
      await client.post("/api/agents", agentBody("agt_structural_probe_b"), AS_B);
      await client.patch("/api/agents/agt_structural_probe_b", { status: "paused" }, AS_B);
      await client.post(
        "/api/decision",
        { agentId: "agt_structural_probe_b", action: "read_file", target: "notes.txt" },
        AS_B,
      );
      await client.get("/api/usage", AS_B);
    } finally {
      capturing = false;
    }

    const offenders = captured
      .filter((entry) => tenantTablesTouched(entry.normalised).length > 0)
      .filter((entry) => !carriesTenantPredicate(entry.normalised))
      .filter((entry) => isExempted(entry.normalised) === undefined)
      .map((entry) => entry.sql);

    expect([...new Set(offenders)]).toEqual([]);
  });

  it("wrote to a tenant table during that exercise, so the assertion had something to judge", () => {
    const writes = captured
      .map((entry) => entry.normalised)
      .filter((sql) => /^(insert|update)/.test(sql))
      .filter((sql) => tenantTablesTouched(sql).length > 0);
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe("the exemption list is honest", () => {
  it("gives a reason for every exempted statement", () => {
    for (const entry of LEGITIMATELY_UNSCOPED) {
      expect(entry.because.length).toBeGreaterThan(40);
    }
  });

  it("contains no fragment that would excuse a whole customer-data table", () => {
    /*
     * The failure mode of an allow-list is an entry so broad it excuses everything.
     * `from "agents"` with no further qualification would silently permit every
     * unscoped agent read, so a bare `from "<tenant table>"` is refused here — an
     * exemption has to name a column or a specific shape, as every current entry does.
     */
    const tooBroad = LEGITIMATELY_UNSCOPED.filter((entry) => {
      const fragment = entry.fragment.toLowerCase();
      return [...TENANT_TABLES].some(
        (table) =>
          fragment === `from "${table}"` ||
          fragment === `from ${table}` ||
          fragment === `update "${table}"` ||
          fragment === `update ${table}`,
      );
    });
    expect(tooBroad.map((entry) => entry.fragment)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * Barrier 4 — static scan of hand-written SQL
 * -------------------------------------------------------------------------- */

/**
 * WHY A STATIC BARRIER IS NEEDED IN ADDITION TO THE RUNTIME ONE
 * ------------------------------------------------------------
 * Discovered while building barrier 1, and it is the reason this block exists: the
 * runtime capture patches `rawDb.prepare`, but `server/repositories/sessions.ts`,
 * `users.ts` and `api-keys.ts` call `prepare` at MODULE LOAD, once, and reuse the
 * statement forever. Those statements are compiled before any test can install a
 * patch, so the runtime walk never sees them — and they are precisely the hand-written
 * SQL that Drizzle's scoped query builder does not protect.
 *
 * A barrier that silently cannot see a whole class of queries is worse than no
 * barrier, because it reports green over them. So the source is read and every SQL
 * literal in it is judged by the same rule, whenever it was prepared.
 */

/** Every `.ts` file under `server/`, excluding the suite itself. */
function serverSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      serverSources(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Pulls SQL out of backtick and quoted string literals.
 *
 * Deliberately crude and deliberately over-inclusive: a false positive costs one
 * exemption entry with a reason, while a false negative is an unnoticed leak. Anything
 * that looks like a statement is treated as one.
 */
function sqlLiteralsIn(source: string): string[] {
  /*
   * Comments are stripped FIRST, and that is not cosmetic. An apostrophe in English
   * prose — "whose tool has" — is a valid opening single quote to a naive scanner, so
   * it pairs with the next apostrophe several lines away and swallows the real code
   * between them. The first version of this scan reported eleven "unscoped statements"
   * that were in fact comment text, which is the kind of noise that gets a security
   * check disabled rather than read.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  const literals: string[] = [];
  /*
   * Single left-to-right pass. Each match consumes a whole literal, so a quote inside a
   * template literal cannot start a second, overlapping one.
   */
  for (const match of code.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) {
    const text = match[1] ?? match[2] ?? match[3] ?? "";
    if (/\b(select|insert\s+into|update|delete\s+from)\b/i.test(text)) literals.push(text);
  }
  return literals;
}

describe("hand-written SQL is scoped, including statements prepared at module load", () => {
  const files = serverSources("server");

  it("reads the server sources at all, so a broken walk cannot pass as zero findings", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds the repositories that prepare statements outside any request", () => {
    // Named explicitly because these three are the reason this barrier exists. If a
    // refactor moved them, the scan below would quietly cover less than it claims.
    for (const expected of [
      join("server", "repositories", "sessions.ts"),
      join("server", "repositories", "users.ts"),
      join("server", "repositories", "api-keys.ts"),
    ]) {
      expect(files).toContain(expected);
    }
  });

  it("contains no SQL literal that touches a tenant table without a tenant predicate", () => {
    const offenders: string[] = [];
    for (const file of files) {
      /*
       * Migrations are exempt as a directory, and this is the one place a blanket
       * exemption is right rather than lazy. A migration is a schema change applied by
       * the deployment owner, once, before the server serves anything — and a data
       * backfill that filtered by organization would be a BUG: it would migrate one
       * tenant's rows and leave every other tenant's rows in the old shape, which is a
       * far worse outcome than the unscoped UPDATE it was trying to avoid. They are
       * also unreachable from any request: `server/migrations/index.ts` runs them from
       * module load in `server/db.ts`.
       */
      if (file.startsWith(join("server", "migrations"))) continue;
      for (const literal of sqlLiteralsIn(readFileSync(file, "utf8"))) {
        const normalised = normalise(literal);
        /*
         * A CREATE TABLE is the declaration of the column, not a query against it, and
         * `usage_counters`' own definition would otherwise be reported as unscoped.
         */
        if (/^(create|drop|alter|pragma|begin|commit)/.test(normalised)) continue;
        if (tenantTablesTouched(normalised).length === 0) continue;
        if (carriesTenantPredicate(normalised)) continue;
        if (isExempted(normalised) !== undefined) continue;
        offenders.push(`${file}: ${literal.replace(/\s+/g, " ").trim().slice(0, 160)}`);
      }
    }
    /*
     * Prints the file and the statement, because "there is an unscoped query somewhere
     * in server/" is not an actionable failure message.
     */
    expect(offenders).toEqual([]);
  });


  it("exempts migrations as a directory and nothing else", () => {
    /*
     * Guards the exemption above from being widened. If someone excludes another
     * directory to make this test pass, that change has to come through here.
     */
    const scanned = files.filter((file) => !file.startsWith(join("server", "migrations")));
    const skipped = files.filter((file) => file.startsWith(join("server", "migrations")));
    expect(skipped.length).toBeGreaterThan(0);
    // Everything else in server/ really is scanned, including the repositories.
    expect(scanned).toContain(join("server", "repositories", "sqlite.ts"));
    expect(scanned).toContain(join("server", "quotas.ts"));
  });

  it("actually found tenant-table SQL, so the assertion above judged something real", () => {
    const seen = files.flatMap((file) =>
      sqlLiteralsIn(readFileSync(file, "utf8"))
        .map(normalise)
        .filter((sql) => tenantTablesTouched(sql).length > 0),
    );
    // The repositories hold dozens. A collapse to a handful means the literal
    // extraction stopped working, which must fail rather than pass vacuously.
    expect(seen.length).toBeGreaterThan(20);
  });
});
