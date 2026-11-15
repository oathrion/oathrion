/**
 * §9 — the Drizzle schema and the live SQLite schema must describe the same database.
 *
 * THE PROBLEM
 * -----------
 * The database is created by raw `CREATE TABLE` statements in `server/db.ts`, while
 * `shared/schema.ts` declares the same tables for Drizzle. Two definitions of one
 * thing drift, and this pair already had: the `sessions` table existed only in the
 * raw SQL and was missing from `shared/schema.ts` entirely.
 *
 * That is not cosmetic. `npm run db:push` derives the schema from `shared/schema.ts`,
 * so a Drizzle-driven migration did not know `sessions` existed and could drop it —
 * logging every console user out — or recreate it without `revoked_at`, which would
 * silently revive revoked sessions. A revoked session that comes back is an
 * authentication bug, reachable from a routine migration.
 *
 * THE BARRIER
 * -----------
 * These tests compare the two definitions column by column, in both directions. A
 * column added to one side and not the other fails here rather than in production.
 * They read the live schema via `pragma table_info`, so they check what SQLite
 * actually built, not what the SQL string appears to say.
 */

import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  ACTIONS_TABLE,
  ACTION_POLICIES_TABLE,
  ACTION_GRANTS_TABLE,
  ACTION_RECEIPTS_TABLE,
  TENANT_ERASURES_TABLE,
  MANDATES_TABLE,
  MANDATE_KEYS_TABLE,
  MANDATE_GRANTS_TABLE,
  MANDATE_RECEIPTS_TABLE,
} from "../migrations";
import { rawDb } from "../db";
import {
  agentRows,
  approvalRows,
  executionRows,
  integrationRows,
  organizationRows,
  userRows,
  membershipRows,
  policyRows,
  sessionRows,
  apiKeyRows,
  identityTokenRows,
  usageCounterRows,
  organizationQuotaRows,
  productFeedbackRows,
  connectorCredentialRows,
  pendingInterceptionRows,
  ssoIdentityRows,
  agentDoorRows,
  reconcileRunRows,
  reconcileFindingRows,
  quotaPeriodCountRows,
  receiptChainCheckpointRows,
} from "@shared/schema";

interface ColumnInfo {
  name: string;
  notnull: number;
  pk: number;
}

function liveColumns(table: string): ColumnInfo[] {
  return rawDb.prepare(`SELECT name, "notnull", pk FROM pragma_table_info(?)`).all(table) as
    | ColumnInfo[];
}

/** Drizzle column names as stored in SQLite (snake_case), not the TS property names. */
function declaredColumns(table: SQLiteTable): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

/**
 * The declared primary key, from BOTH places Drizzle can hold one.
 *
 * A single-column key sets `column.primary`; a composite key declared in the table's
 * extra config lives in `getTableConfig(...).primaryKeys` and leaves every column's
 * `primary` flag false. Reading only the first source made this test report "id" for
 * a table whose real key is `(organization_id, id)` — it would have gone green on a
 * declaration that `db:push` renders as a single-column key, which is precisely the
 * drift the file exists to catch, and would have re-opened the global id namespace.
 */
function declaredPrimaryKey(table: SQLiteTable): string[] {
  const single = Object.values(getTableColumns(table))
    .filter((c) => c.primary)
    .map((c) => c.name);
  const composite = getTableConfig(table).primaryKeys.flatMap((pk) =>
    pk.columns.map((c) => c.name),
  );
  return [...single, ...composite];
}

const TABLES: { name: string; table: SQLiteTable }[] = [
  { name: "agents", table: agentRows },
  { name: "policies", table: policyRows },
  { name: "executions", table: executionRows },
  { name: "approvals", table: approvalRows },
  { name: "integrations", table: integrationRows },
  { name: "sessions", table: sessionRows },
  { name: "organizations", table: organizationRows },
  { name: "users", table: userRows },
  { name: "memberships", table: membershipRows },
  { name: "api_keys", table: apiKeyRows },
  // P3. This list is enumerated by hand, so a new table is unchecked until it is added
  // here — see the guard below, which fails when the two drift apart.
  { name: "usage_counters", table: usageCounterRows },
  // P2 identity.
  { name: "identity_tokens", table: identityTokenRows },
  // Chantier 1 — per-tenant quota ceilings (migration 17).
  { name: "organization_quotas", table: organizationQuotaRows },
  { name: "product_feedback", table: productFeedbackRows },
  /* Chantier 3 — le coffre de credentials des connecteurs (migration 21). */
  { name: "connector_credentials", table: connectorCredentialRows },
  /* Migration 022 — le sas des requêtes en attente d'approbation. */
  { name: "pending_interceptions", table: pendingInterceptionRows },
  /* Migration 023 — la liaison (émetteur, sujet) → compte de console. */
  { name: "sso_identities", table: ssoIdentityRows },
  /* Migration 025 — les portes de chaque agent. */
  { name: "agent_doors", table: agentDoorRows },
  /* Migration 026 — la mémoire de la réconciliation. */
  { name: "reconcile_runs", table: reconcileRunRows },
  { name: "reconcile_findings", table: reconcileFindingRows },
  /* Migration 028 — le compteur d'exécutions du mois. */
  { name: "quota_period_counts", table: quotaPeriodCountRows },
  /* Migration 029 — le point de reprise de la vérification des chaînes. */
  { name: "receipt_chain_checkpoints", table: receiptChainCheckpointRows },
];

describe("schema parity", () => {
  for (const { name, table } of TABLES) {
    describe(name, () => {
      it("exists in the live database", () => {
        expect(liveColumns(name).length).toBeGreaterThan(0);
      });

      it("declares every column the live table has", () => {
        // Direction that catches the original bug's mirror image: a column added by
        // a raw migration and never declared, so `db:push` would drop it.
        const live = liveColumns(name).map((c) => c.name);
        const declared = declaredColumns(table);
        const missing = live.filter((c) => !declared.includes(c));
        expect(missing).toEqual([]);
      });

      it("declares no column the live table lacks", () => {
        // The other direction: a declared column with no migration behind it means
        // every query touching it fails at runtime, not at build time.
        const live = liveColumns(name).map((c) => c.name);
        const declared = declaredColumns(table);
        const extra = declared.filter((c) => !live.includes(c));
        expect(extra).toEqual([]);
      });

      it("agrees on the primary key", () => {
        const livePk = liveColumns(name)
          .filter((c) => c.pk > 0)
          .map((c) => c.name);
        expect(declaredPrimaryKey(table).sort()).toEqual(livePk.sort());
      });
    });
  }

  it("keeps revoked_at on sessions, without which revoked sessions come back", () => {
    /*
     * Named explicitly rather than left to the generic parity check above. This is
     * the column whose loss would be an authentication failure rather than a broken
     * query: session resolution treats a non-null `revoked_at` as "refuse this
     * token". A recreated table without it makes every revoked session valid again,
     * and nothing would raise an error.
     */
    const columns = liveColumns("sessions").map((c) => c.name);
    expect(columns).toContain("revoked_at");
    expect(declaredColumns(sessionRows)).toContain("revoked_at");
  });

  it("has no live table that nothing declares", () => {
    /*
     * A table created by raw SQL and declared nowhere is invisible to the ORM layer.
     * SQLite's internal tables are excluded, as is `schema_migrations`: the migration
     * ledger is infrastructure that describes the schema rather than part of it, and
     * declaring it in `shared/schema.ts` would let application queries reach it. It is
     * asserted separately below so it still cannot vanish unnoticed.
     */
    const INFRASTRUCTURE_TABLES = ["schema_migrations"];
    /*
     * The Phase 10 action authorization plane, added by migration 12.
     *
     * Excluded from the ORM parity check for a stated reason rather than by
     * accident: these four tables are never read through Drizzle. The plane runs
     * the SAME statements on SQLite and on PostgreSQL through `server/sql/executor.ts`
     * so that its security predicates — `state = 'issued'`, `expires_at > $now`,
     * the agent/action/destination equality tests — cannot diverge between engines,
     * and a Drizzle model would create a second, engine-specific way to read the
     * same rows. Listed explicitly and asserted to exist below, so the exclusion
     * cannot hide a table that quietly disappeared.
     */
    const ACTION_AUTHORITY_TABLES = [
      ACTIONS_TABLE,
      ACTION_POLICIES_TABLE,
      ACTION_GRANTS_TABLE,
      ACTION_RECEIPTS_TABLE,
    ];
    /*
     * Le registre d'effacement (migration 20), exclu pour une raison énoncée.
     *
     * Il n'est écrit que par `script/lib/tenant-purge.ts`, en SQL brut, DANS la même
     * transaction que la suppression qu'il décrit — c'est tout son intérêt : il n'existe
     * aucun instant où des lignes ont disparu sans que le registre le dise. Un modèle
     * Drizzle ouvrirait une seconde façon de l'écrire, hors de cette transaction.
     *
     * Et surtout : aucune requête du chemin applicatif ne doit pouvoir l'atteindre. Le
     * déclarer dans `shared/schema.ts` le rendrait joignable depuis une route, c'est-à-dire
     * depuis une requête de locataire — alors qu'il recense les effacements de TOUS les
     * locataires. L'absence de modèle est la clôture.
     */
    const ERASURE_LEDGER_TABLES = [TENANT_ERASURES_TABLE];
    /*
     * Le mandat vérifiable (migration 30), exclu pour la MÊME raison que le plan d'autorité : ses
     * trois tables ne sont lues que par `server/mandates.ts`, avec les mêmes requêtes sur SQLite et
     * PostgreSQL (`server/sql/executor.ts`). Un modèle Drizzle ouvrirait une seconde façon, propre
     * à un moteur, de lire des mandats et la clé scellée d'une organisation.
     */
    const MANDATE_TABLES = [MANDATES_TABLE, MANDATE_KEYS_TABLE, MANDATE_GRANTS_TABLE, MANDATE_RECEIPTS_TABLE];
    const live = (
      rawDb
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    const declared = [
      ...TABLES.map((t) => t.name),
      ...INFRASTRUCTURE_TABLES,
      ...ACTION_AUTHORITY_TABLES,
      ...ERASURE_LEDGER_TABLES,
      ...MANDATE_TABLES,
    ];
    expect(live.filter((t) => !declared.includes(t)).sort()).toEqual([]);

    // The counterpart to the exclusion: every excluded table must actually be there.
    for (const table of [...ACTION_AUTHORITY_TABLES, ...ERASURE_LEDGER_TABLES, ...MANDATE_TABLES]) {
      expect(live, `${table} is declared as excluded but does not exist`).toContain(table);
    }
  });

  it("has a migration ledger, so the schema version is knowable", () => {
    /*
     * The counterpart to the exclusion above. A database without this table has an
     * unknown schema version, which is exactly the situation versioned migrations
     * exist to remove — so its absence has to fail a test somewhere.
     */
    const row = rawDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe("schema_migrations");

    const versions = (
      rawDb.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as { version: number }[]
    ).map((r) => r.version);
    expect(versions.length).toBeGreaterThan(0);
  });
});
