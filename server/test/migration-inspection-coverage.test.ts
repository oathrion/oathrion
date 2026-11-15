/**
 * The PostgreSQL runner's `INSPECTED_TABLES` is complete — asserted WITHOUT a database (P7).
 *
 * ## Why this file exists, when a test for the same property already existed
 *
 * `server/test/postgres.test.ts` already asserts that every table the migrations
 * produce appears in `INSPECTED_TABLES`. That assertion is strictly better than this
 * one in what it can see — it reads the real schema of a real server. It has one
 * disqualifying property: **it skips when no PostgreSQL server is reachable.**
 *
 * No CI run and no developer run before Phase 7 had one. So the guard had never
 * executed, and two tables — `usage_counters` (migration 7) and `identity_tokens`
 * (migration 8) — sat outside the list while both migrations branched on
 * `schema.tableExists()` for exactly those names. On PostgreSQL both branches always
 * read "does not exist". Nothing broke, because both statements happen to say
 * `CREATE TABLE IF NOT EXISTS`; the defect was surviving on phrasing, not on design.
 *
 * A guard that only runs where the bug is least likely to be introduced is not a
 * guard. This file therefore re-establishes the same property from the migration
 * **sources**, with no server, no driver and no I/O beyond reading files, so it runs
 * in every `npm test` on every machine. It is deliberately a duplicate: the
 * PostgreSQL version stays, because it can see a table that was created but never
 * named in a branch, which source text cannot.
 *
 * ## Why it reads source text, which is not free of cost
 *
 * The honest alternative would be to have each `Migration` declare the tables it
 * touches, and to derive the list from the registry. That is better, and it is a
 * change to the shape of every migration — including ten applied ones — to fix a
 * two-line omission. The cost of the approach taken here is stated plainly: a
 * migration that computes a table name instead of writing it as a literal is
 * invisible to this test. That is why the assertion below on the *form* of the
 * arguments exists — a non-literal argument fails rather than passing quietly.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { INSPECTED_TABLES, MIGRATIONS, LATEST_VERSION } from "../migrations";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

/** Only the numbered migration files. The runner and the drivers are not migrations. */
function migrationSources(): { file: string; text: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}-.*\.ts$/.test(f))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(MIGRATIONS_DIR, file), "utf8") }));
}

/**
 * Strips comments before scanning.
 *
 * Without this, every `tableExists` written *in prose* inside the long explanatory
 * headers this codebase favours would be read as a call site, and the test would
 * demand tables that no code inspects. The comments are the reason the codebase is
 * legible; they must not be the reason a test lies.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const CALL = /schema\.(?:tableExists|columns)\(\s*([^)]*?)\s*\)/g;

/** Resolves the literal identifier constants a migration passes instead of a string. */
const CONSTANTS: Record<string, string> = {
  USAGE_COUNTERS_TABLE: "usage_counters",
  IDENTITY_TOKENS_TABLE: "identity_tokens",
  RATE_LIMIT_TABLE: "rate_limit_buckets",
  // Phase 11: migration 013 inspects it before adding `entry_seq`.
  ACTION_RECEIPTS_TABLE: "action_receipts",
  /*
   * The other three action-authority tables of migration 012. They are created under
   * an interpolated constant, so without these entries this file reads them as "no
   * migration creates this table" and reports the driver's list as stale — which is
   * how the missing entries were found in the first place.
   */
  ACTIONS_TABLE: "actions",
  ACTION_GRANTS_TABLE: "action_grants",
  ACTION_POLICIES_TABLE: "action_policies",
  // Phase 12.3: migration 015 inspects it before adding the per-tenant `currency` column.
  ORGANIZATIONS_TABLE: "organizations",
  // Chantier 1: migration 017 inspects its own table before creating it.
  ORGANIZATION_QUOTAS_TABLE: "organization_quotas",
  // Chantier 3: migration 021 inspects its own table before creating it.
  CONNECTOR_CREDENTIALS_TABLE: "connector_credentials",
  // Migration 025 inspecte sa propre table (les portes des agents) avant de la créer.
  AGENT_DOORS_TABLE: "agent_doors",
  // Migration 026 : la mémoire de la réconciliation.
  RECONCILE_RUNS_TABLE: "reconcile_runs",
  RECONCILE_FINDINGS_TABLE: "reconcile_findings",
  // Migration 028 : le compteur d'exécutions du mois.
  QUOTA_PERIOD_COUNTS_TABLE: "quota_period_counts",
  // Migration 029 : le point de reprise de la vérification des chaînes.
  RECEIPT_CHAIN_CHECKPOINTS_TABLE: "receipt_chain_checkpoints",
  MANDATES_TABLE: "mandates",
  MANDATE_KEYS_TABLE: "mandate_keys",
  MANDATE_GRANTS_TABLE: "mandate_grants",
  MANDATE_RECEIPTS_TABLE: "mandate_receipts",
  // Migration 022 — le sas des requêtes en attente d'approbation.
  PENDING_INTERCEPTIONS_TABLE: "pending_interceptions",
  // Migration 023 — la liaison (émetteur, sujet) → compte de console.
  SSO_IDENTITIES_TABLE: "sso_identities",
  // Chantier 2: migration 019 does the same for product feedback.
  FEEDBACK_TABLE: "product_feedback",
  // Chantier 2: migration 020 does the same for the erasure ledger.
  TENANT_ERASURES_TABLE: "tenant_erasures",
};

interface Site {
  file: string;
  raw: string;
  table: string | undefined;
}

/** Every `["a", "b"]` literal in the file, indexed by the const it is bound to. */
function stringArrayConsts(code: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const match of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]/g)) {
    const names = [...(match[2] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
    if (names.length > 0) out.set(match[1]!, names);
  }
  return out;
}

/**
 * Resolves a `for (const table of …)` loop variable to the names it takes.
 *
 * Migration 3 inspects five tables through one loop variable, which the first
 * version of this test reported as unresolvable — correctly, and usefully: an
 * unresolved argument is refused rather than skipped, so the test told the truth
 * about its own blind spot instead of passing. Rather than weaken that refusal, the
 * two shapes the migrations actually use are resolved here: an inline array literal,
 * and a const holding one. Anything else is still unresolvable and still fails.
 */
function loopVariables(code: string): Map<string, string[]> {
  const consts = stringArrayConsts(code);
  const out = new Map<string, string[]>();
  for (const match of code.matchAll(/for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]+?)\s*\)\s*\{/g)) {
    const variable = match[1]!;
    const source = (match[2] ?? "").replace(/\s*as\s+const\s*$/, "").trim();
    const inline = source.startsWith("[")
      ? [...source.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!)
      : consts.get(source);
    if (inline && inline.length > 0) {
      // A variable reused across two loops takes the union of both.
      out.set(variable, [...new Set([...(out.get(variable) ?? []), ...inline])]);
    }
  }
  return out;
}

function inspectionSites(): Site[] {
  const sites: Site[] = [];
  for (const { file, text } of migrationSources()) {
    const code = stripComments(text);
    const loops = loopVariables(code);
    for (const match of code.matchAll(CALL)) {
      const raw = (match[1] ?? "").trim();
      const quoted = /^"([^"]+)"$|^'([^']+)'$/.exec(raw);
      if (quoted) {
        sites.push({ file, raw, table: quoted[1] ?? quoted[2] });
        continue;
      }
      const constant = CONSTANTS[raw];
      if (constant !== undefined) {
        sites.push({ file, raw, table: constant });
        continue;
      }
      const loop = loops.get(raw);
      if (loop !== undefined) {
        for (const table of loop) sites.push({ file, raw, table });
        continue;
      }
      sites.push({ file, raw, table: undefined });
    }
  }
  return sites;
}

describe("PostgreSQL INSPECTED_TABLES covers every table a migration inspects", () => {
  const sites = inspectionSites();
  const inspected = new Set<string>(INSPECTED_TABLES);

  it("finds inspection sites at all, so a silent regex failure cannot pass this file", () => {
    /*
     * The failure mode of a source-scanning test is finding nothing and reporting
     * success. Migrations 2, 3, 7, 8, 9 and 10 all branch on the schema, so the
     * floor is comfortably above zero and is asserted rather than assumed.
     */
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it("resolves every inspected table name to a literal", () => {
    // A computed argument is invisible to this test, so it is refused outright
    // rather than skipped — see the header on the cost of scanning source text.
    const unresolved = sites.filter((s) => s.table === undefined);
    expect(
      unresolved.map((s) => `${s.file}: schema.…(${s.raw})`),
      "a migration inspects a table under a name this test cannot resolve; add the " +
        "constant to CONSTANTS in this file, or pass a string literal",
    ).toEqual([]);
  });

  it("lists every inspected table, so no migration takes a blind branch", () => {
    const missing = [
      ...new Set(
        sites
          .filter((s) => s.table !== undefined && !inspected.has(s.table))
          .map((s) => `${s.table} (inspected by ${s.file})`),
      ),
    ].sort();
    expect(
      missing,
      "these tables are inspected by a migration but absent from INSPECTED_TABLES in " +
        "server/migrations/postgres-driver.ts, so on PostgreSQL the inspection reads " +
        "\"does not exist\" and the migration takes the wrong branch",
    ).toEqual([]);
  });

  it("keeps the two tables this phase added, so the fix cannot be silently reverted", () => {
    // Named individually: these are the two that were actually missing, and a
    // regression on either is the exact defect P7 closed rather than a new one.
    expect(inspected.has("usage_counters")).toBe(true);
    expect(inspected.has("identity_tokens")).toBe(true);
  });

  it("lists no table that no migration creates or inspects", () => {
    /*
     * The opposite direction, and a weaker claim on purpose. A stale name costs one
     * pointless metadata query, not a wrong branch, so this asserts against the
     * union of inspected names and names appearing in a CREATE TABLE — not against
     * a live schema, which is `postgres.test.ts`'s job.
     */
    const created = new Set<string>();
    for (const { text } of migrationSources()) {
      const code = stripComments(text);
      for (const match of code.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)) {
        if (match[1]) created.add(match[1].toLowerCase());
      }
      for (const [name, table] of Object.entries(CONSTANTS)) {
        if (code.includes(`CREATE TABLE IF NOT EXISTS \${${name}}`)) created.add(table);
      }
    }
    const known = new Set([...created, ...sites.flatMap((s) => (s.table ? [s.table] : []))]);
    const stale = [...inspected].filter((t) => !known.has(t)).sort();
    expect(stale, "INSPECTED_TABLES names a table no migration creates or inspects").toEqual([]);
  });
});

describe("the registry after P7", () => {
  it("is at version 31, with each migration appended rather than an old one edited", () => {
    /*
     * Pinned deliberately. The defect that migration 11 corrects lives in migration
     * 7, and the tempting fix is to edit migration 7's PostgreSQL branch. That would
     * make `assertHistoryMatches` refuse every database that already recorded version
     * 7 under its current shape, and would leave already-migrated deployments with a
     * text column. This pin makes the append-only rule fail loudly if someone
     * "simplifies" it later.
     */
    expect(LATEST_VERSION).toBe(31);
    /* Version 31 : les reçus contresignés des mandats. 30 et avant intactes. */
    expect(MIGRATIONS.find((m) => m.version === 31)?.name).toBe("mandate-receipts");
    /* Version 30 : le mandat vérifiable. 29 et avant intactes. */
    expect(MIGRATIONS.find((m) => m.version === 30)?.name).toBe("mandates");
    /* Version 29 : le point de reprise de la vérification des chaînes. 28 et avant intactes. */
    expect(MIGRATIONS.find((m) => m.version === 29)?.name).toBe("receipt-chain-checkpoints");
    /* Version 28 : le compteur d'exécutions du mois (quota en temps constant). 27 et avant intactes. */
    expect(MIGRATIONS.find((m) => m.version === 28)?.name).toBe("quota-period-counts");
    /* Version 27 : l'index des autorisations consommées (quota sous concurrence). 26 et avant intactes. */
    expect(MIGRATIONS.find((m) => m.version === 27)?.name).toBe("grant-consumption-index");
    /* Version 26 : la mémoire de la réconciliation. 25 et avant intactes. */
    expect(MIGRATIONS.find((m) => m.version === 26)?.name).toBe("reconcile-memory");
    /* Version 25 : les portes de chaque agent, dans leur propre table. 24 et avant intactes. */
    expect(MIGRATIONS.find((m) => m.version === 25)?.name).toBe("agent-doors");
    const eleven = MIGRATIONS.find((m) => m.version === 11);
    expect(eleven?.name).toBe("usage-counter-timestamp");
    /*
     * Phase 12.3 appended version 15, which gives each organization its own currency.
     * Same rule, same reason: the deployment-wide `ORG_CURRENCY` constant it replaces was
     * introduced long before, and correcting it by editing an earlier migration would
     * lock out every database that already recorded that version.
     */
    expect(MIGRATIONS.find((m) => m.version === 15)?.name).toBe("organization-currency");
    /*
     * Phase 13 appended version 16: action_policies keyed per tenant. Migration 12,
     * which created the table with a global key, is untouched.
     */
    expect(MIGRATIONS.find((m) => m.version === 16)?.name).toBe("action-policy-tenant-key");
    /*
     * Chantier 1 appended version 17: per-tenant quota ceilings. 16 and earlier untouched.
     */
    expect(MIGRATIONS.find((m) => m.version === 17)?.name).toBe("organization-quotas");
    /*
     * Chantier 1 appended version 18: the organization name becomes unique, so a tenant
     * identifier can stop being derived from it. Migration 3, which created the
     * `organizations` table, is untouched — and the identifiers it produced are
     * deliberately NOT rewritten: they are referenced by the audit chain.
     */
    expect(MIGRATIONS.find((m) => m.version === 18)?.name).toBe("organization-name-key");
    expect(MIGRATIONS.find((m) => m.version === 7)?.name).toBe("usage-counters");
    /*
     * Phase 10 added version 12 the same way: appended, never by editing an earlier
     * migration. The pin moves forward with each phase precisely so that a *silent*
     * rewrite of history — the failure `assertHistoryMatches` cannot forgive at
     * runtime — is a failing test at build time.
     */
    expect(MIGRATIONS.find((m) => m.version === 12)?.name).toBe("action-authority");
    /*
     * Phase 11 appended 13 (receipt-ordering) and did NOT touch 12, which is the
     * migration that created `action_receipts`. Adding `entry_seq` there instead would
     * have been the shorter diff and would have made `assertHistoryMatches` reject every
     * database already at version 12 — including the ones this phase migrated.
     */
    expect(MIGRATIONS.find((m) => m.version === 13)?.name).toBe("receipt-ordering");
  });

  it("emits nothing on SQLite, which has no timestamp type to convert to", () => {
    const eleven = MIGRATIONS.find((m) => m.version === 11)!;
    const statements = eleven.statements({
      dialect: "sqlite",
      columns: () => new Set(["updated_at"]),
      tableExists: () => true,
    });
    expect(statements).toEqual([]);
  });

  it("emits one explicit cast on PostgreSQL", () => {
    const eleven = MIGRATIONS.find((m) => m.version === 11)!;
    const statements = eleven.statements({
      dialect: "postgres",
      columns: () => new Set(["updated_at"]),
      tableExists: () => true,
    });
    expect(statements).toHaveLength(1);
    // The `USING` is the substance: PostgreSQL refuses the implicit text→timestamptz
    // change, and an implicit cast is the statement that works on an empty table and
    // fails on a populated one.
    expect(statements[0]).toMatch(/ALTER COLUMN updated_at TYPE timestamptz/);
    expect(statements[0]).toMatch(/USING updated_at::timestamptz/);
  });

  it("emits nothing on PostgreSQL when the table is absent", () => {
    const eleven = MIGRATIONS.find((m) => m.version === 11)!;
    expect(
      eleven.statements({
        dialect: "postgres",
        columns: () => new Set(),
        tableExists: () => false,
      }),
    ).toEqual([]);
  });
});
