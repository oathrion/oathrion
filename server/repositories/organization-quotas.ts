/**
 * Per-tenant quota ceilings (chantier 1, migration 17).
 *
 * A store and nothing more: it does not decide what a ceiling means, how it combines
 * with the deployment default, or whether a write is allowed — `server/quotas.ts` does,
 * and is the only importer of this file (`tenant-config-single-path.test.ts`). Keeping
 * the rule out of here is what lets the identity plane be rewritten as async in
 * chantier 2 by changing this layer alone.
 *
 * Prepared statements on `rawDb`, like `organizations.ts`, because `ceilingsFor` runs on
 * every quota-guarded write and, on SQLite, inside the caller's transaction (the guard
 * in `server/quotas.ts` must be synchronous to be race-free). On PostgreSQL `rawDb` is
 * the synchronous identity bridge, so the row is read from the shared database on every
 * call — that is the property that makes a change visible to every replica on its next
 * request. There is deliberately NO cache here: a per-process cache is exactly the
 * "changed on one instance, stale on the others until restart" defect this table
 * exists to remove. Its cost — one primary-key read per guarded write — is written in
 * docs/limitations.md.
 */

import { rawDb } from "../db";
import { InvalidQuotaOverride, quotaCeilingProblem, type QuotaCounter } from "@shared/quotas";
import type { OrganizationId } from "@shared/tenancy";

export type QuotaCeilingSource = "environment" | "api";

export interface StoredQuotaCeiling {
  ceiling: number;
  source: QuotaCeilingSource;
}

interface Row {
  counter: string;
  ceiling: number | string;
  source: string;
}

/*
 * Prepared on first use, not at import — unlike `organizations.ts`. This module is
 * reached through `server/quotas.ts`, which `server/config-check.ts` imports for the
 * boot validation, and `config-check` is itself in the import graph of `server/db.ts`.
 * A top-level `rawDb.prepare(...)` therefore ran while `db.ts` was still being
 * evaluated, with `rawDb` undefined (found by schema-parity.test.ts). Deferring the
 * prepare breaks that cycle without reordering anyone else's imports; each statement is
 * still prepared exactly once.
 */
type Statement = ReturnType<typeof rawDb.prepare<unknown[]>>;
function lazy(sql: string): () => Statement {
  let prepared: Statement | undefined;
  return () => (prepared ??= rawDb.prepare<unknown[]>(sql));
}

const forOrgStmt = lazy(
  `SELECT counter, ceiling, source FROM organization_quotas WHERE organization_id = ?`,
);
const oneStmt = lazy(
  `SELECT counter, ceiling, source FROM organization_quotas WHERE organization_id = ? AND counter = ?`,
);
const upsertStmt = lazy(
  `INSERT INTO organization_quotas (organization_id, counter, ceiling, source, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (organization_id, counter)
   DO UPDATE SET ceiling = excluded.ceiling, source = excluded.source, updated_at = excluded.updated_at`,
);
const insertIfAbsentStmt = lazy(
  `INSERT OR IGNORE INTO organization_quotas (organization_id, counter, ceiling, source, updated_at)
   VALUES (?, ?, ?, ?, ?)`,
);
/*
 * The two statements below act ONLY on rows the environment owns (`source =
 * 'environment'`). The condition is in the SQL, not checked before it, so a row that
 * the application took over (`api`) between a read and the write cannot be overwritten
 * or deleted by a replica that is booting with an older OATHRION_QUOTAS.
 */
const updateEnvOwnedStmt = lazy(
  `UPDATE organization_quotas SET ceiling = ?, updated_at = ?
    WHERE organization_id = ? AND counter = ? AND source = 'environment'`,
);
const deleteEnvOwnedStmt = lazy(
  `DELETE FROM organization_quotas
    WHERE organization_id = ? AND counter = ? AND source = 'environment'`,
);
/*
 * Per organization, never across tenants: `tenant-isolation-structural.test.ts` requires
 * an `organization_id` predicate on every statement touching a tenant table, and a
 * cross-tenant "every row the environment owns" scan was exactly such a statement.
 */
const envOwnedStmt = lazy(
  `SELECT counter FROM organization_quotas WHERE organization_id = ? AND source = 'environment'`,
);

/**
 * Converts a stored row, refusing anything the CHECK constraints should have made
 * impossible.
 *
 * PostgreSQL returns BIGINT as a string (node-postgres does not guess at precision),
 * hence `Number`. A value that is still not a valid ceiling after that — only reachable
 * by a write that bypassed the constraints, e.g. a restore into a table created by hand
 * — THROWS rather than being skipped. Skipping would silently hand the tenant the
 * deployment default, which may be far higher than what the operator set: the failure
 * would be a ceiling quietly lifted. Throwing refuses that tenant's guarded writes with
 * an error naming the row, which is the fail-closed direction.
 */
function toStored(organization: OrganizationId, row: Row): [QuotaCounter, StoredQuotaCeiling] {
  const ceiling = typeof row.ceiling === "string" ? Number(row.ceiling) : row.ceiling;
  const problem = quotaCeilingProblem(row.counter, ceiling);
  if (problem !== null || (row.source !== "environment" && row.source !== "api")) {
    throw new InvalidQuotaOverride(
      `organization_quotas row for "${organization}" / "${row.counter}" is unreadable ` +
        `(${problem ?? `source "${row.source}"`}). Correct the row; the tenant's guarded ` +
        `writes are refused until then.`,
    );
  }
  return [row.counter as QuotaCounter, { ceiling, source: row.source }];
}

export const organizationQuotaStore = {
  /** Every ceiling this tenant has of its own. Counters without a row are absent. */
  ceilingsFor(organization: OrganizationId): Partial<Record<QuotaCounter, number>> {
    const out: Partial<Record<QuotaCounter, number>> = {};
    for (const row of forOrgStmt().all(organization) as Row[]) {
      const [counter, stored] = toStored(organization, row);
      out[counter] = stored.ceiling;
    }
    return out;
  },

  find(organization: OrganizationId, counter: QuotaCounter): StoredQuotaCeiling | null {
    const row = oneStmt().get(organization, counter) as Row | undefined;
    return row ? toStored(organization, row)[1] : null;
  },

  /**
   * Writes a ceiling. Validated here as well as by the caller: this is the last code
   * before the database, and the CHECK constraints would otherwise be the only thing
   * between a bad value and the table — with an engine-specific error message.
   */
  set(
    organization: OrganizationId,
    counter: QuotaCounter,
    ceiling: number,
    source: QuotaCeilingSource,
  ): void {
    const problem = quotaCeilingProblem(counter, ceiling);
    if (problem !== null) throw new InvalidQuotaOverride(problem);
    upsertStmt().run(organization, counter, ceiling, source, new Date().toISOString());
  },

  /**
   * Inserts only when the tenant has no row for this counter; returns what is stored
   * afterwards. `INSERT OR IGNORE` then a read, not read-then-write, so two replicas
   * booting together cannot both insert, and the loser reads the winner's value.
   */
  insertIfAbsent(
    organization: OrganizationId,
    counter: QuotaCounter,
    ceiling: number,
    source: QuotaCeilingSource,
  ): { inserted: boolean; stored: StoredQuotaCeiling } {
    const problem = quotaCeilingProblem(counter, ceiling);
    if (problem !== null) throw new InvalidQuotaOverride(problem);
    const changes = insertIfAbsentStmt().run(
      organization,
      counter,
      ceiling,
      source,
      new Date().toISOString(),
    ).changes;
    const stored = this.find(organization, counter);
    if (stored === null) {
      // Unreachable unless the insert silently failed. Same reasoning as
      // `organizationStore.ensure`: fail loudly rather than report a ceiling that is not there.
      throw new Error(`quota ceiling "${organization}" / "${counter}" could not be stored or read back`);
    }
    return { inserted: changes > 0, stored };
  },

  /** Changes a row the environment owns. Returns false when no such row exists. */
  updateEnvironmentOwned(organization: OrganizationId, counter: QuotaCounter, ceiling: number): boolean {
    const problem = quotaCeilingProblem(counter, ceiling);
    if (problem !== null) throw new InvalidQuotaOverride(problem);
    return (
      updateEnvOwnedStmt().run(ceiling, new Date().toISOString(), organization, counter).changes > 0
    );
  },

  /** Deletes a row the environment owns. A row written by the application is kept. */
  deleteEnvironmentOwned(organization: OrganizationId, counter: QuotaCounter): boolean {
    return deleteEnvOwnedStmt().run(organization, counter).changes > 0;
  },

  /** The counters of this tenant whose row came from OATHRION_QUOTAS. */
  environmentOwnedFor(organization: OrganizationId): string[] {
    return (envOwnedStmt().all(organization) as { counter: string }[]).map((r) => r.counter);
  },
};
