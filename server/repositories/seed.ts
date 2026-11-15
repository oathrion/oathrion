/**
 * First-boot seeding.
 *
 * Two datasets, and the distinction matters:
 *
 *  - **Configuration** (`agents`, `policies`, `integrations`) describes how the
 *    control plane is set up. Seeding it gives a fresh install something to
 *    govern. It is still a starting point an operator is expected to replace,
 *    so it is opt-in too, but it measures nothing.
 *
 *  - **Ledger** (`executions`, `approvals` and their audit trails) records what
 *    actually happened. Seeding it is never acceptable in a pilot: fabricated
 *    rows would count as real executions, feed the dashboard KPIs, consume real
 *    daily budgets through `dailySpend`, and place phantom items in the
 *    approval queue. A metric derived from a fixture is a lie.
 *
 * Both are therefore off by default. Set `OATHRION_SEED=config` to load the
 * configuration dataset, or `OATHRION_SEED=demo` to additionally load the
 * illustrative ledger — the latter only for sales demos, never for a pilot.
 */

import { rawDb } from "../db";
import { resolveDatabaseConfig } from "../database-config";
import { DEFAULT_ORGANIZATION_ID, type OrganizationId } from "@shared/tenancy";
import { repositoriesFor } from "./sqlite";
import { agents } from "@shared/seed/agents";
import { policies } from "@shared/seed/policies";
import { executions } from "@shared/seed/executions";
import { approvals } from "@shared/seed/approvals";
import { integrations } from "@shared/seed/integrations";

export type SeedMode = "none" | "config" | "demo";

/** Reads the seeding mode. Anything unrecognised — including unset — means "none". */
export function seedMode(env: NodeJS.ProcessEnv = process.env): SeedMode {
  const raw = env.OATHRION_SEED?.trim().toLowerCase();
  if (raw === "config") return "config";
  if (raw === "demo") return "demo";
  return "none";
}

/**
 * Emptiness is asked per organization, not globally.
 *
 * A global check would mean the second organization to be created never gets its
 * starter configuration, because the first one's rows already made the table
 * non-empty. That is the kind of bug that only appears with a second customer.
 */
function isEmpty(table: string, org: OrganizationId): boolean {
  const row = rawDb
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ?`)
    .get(org) as { n: number };
  return row.n === 0;
}

/** Idempotent: only writes to a table that is empty *for this organization*. */
export async function seedIfEmpty(
  mode: SeedMode = seedMode(),
  org: OrganizationId = DEFAULT_ORGANIZATION_ID,
): Promise<SeedMode> {
  if (mode === "none") return "none";

  /*
   * PHASE 11. This module reaches for `rawDb` (the SQLite handle) for its emptiness
   * checks and for the integrations insert, and it imports the SQLite repositories
   * directly. On `DATABASE_DRIVER=postgres` that combination would write starter rows
   * into a file nothing else reads while reporting success — the exact silent-wrong-place
   * write this phase exists to remove. So it refuses instead of guessing, and says which
   * engine it can seed. Seeding is opt-in and never required to boot, so refusing it
   * costs a fresh PostgreSQL install nothing but two API calls.
   */
  if (resolveDatabaseConfig().driver === "postgres") {
    console.warn(
      `[seed] OATHRION_SEED=${mode} was requested, but first-boot seeding is implemented against ` +
        `SQLite only in this build. NOTHING was seeded: writing these rows to the SQLite file ` +
        `while DATABASE_DRIVER=postgres is configured would put them where no request reads ` +
        `them. Create the starter agents and policies through the API instead.`,
    );
    return "none";
  }

  const repositories = repositoriesFor(org);

  if (isEmpty("agents", org)) {
    for (const agent of agents) await repositories.agents.create(agent);
  }
  if (isEmpty("policies", org)) {
    for (const policy of policies) await repositories.policies.create(policy);
  }
  if (isEmpty("integrations", org)) {
    const stmt = rawDb.prepare(
      `INSERT INTO integrations (organization_id, id, name, category, description, connected, scopes, connected_at, agents_using)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const i of integrations) {
      stmt.run(
        org,
        i.id,
        i.name,
        i.category,
        i.description,
        i.connected ? 1 : 0,
        JSON.stringify(i.scopes),
        i.connectedAt ?? null,
        i.agentsUsing,
      );
    }
  }

  if (mode !== "demo") return mode;

  // Demo mode only. Never enable this on a deployment whose numbers anyone reads.
  if (isEmpty("executions", org)) {
    for (const execution of executions) await repositories.executions.create(execution);
  }
  if (isEmpty("approvals", org)) {
    for (const approval of approvals) await repositories.approvals.create(approval);
  }

  return mode;
}
