/**
 * Measures the daily-spend query against the index layouts that actually exist.
 *
 * `dailySpend` runs inside the decision transaction, so it is on the critical path of
 * every single governed action, while the write lock is held. This script reports the
 * plan and the timing on a realistic table, so the index choice is justified by numbers
 * rather than by the shape of the WHERE clause.
 *
 * WHY THIS SCRIPT WAS WRONG (audit finding I7)
 * -------------------------------------------
 * It measured `(agent_id, timestamp)` against `(agent_id, status, timestamp, cost)` and
 * declared the second one the winner. Migration `003-tenancy` DROPs both of those
 * indexes and the real query is now tenant-led — `organization_id` first in the WHERE
 * clause and first in `idx_executions_org_spend`. So the benchmark kept reporting a
 * convincing speed-up for a layout production no longer has, on a query production no
 * longer runs. It was measuring history.
 *
 * The correction keeps the method and repoints the subject: the same three-way
 * comparison, but between the pre-tenancy covering index (kept deliberately, as the
 * control that shows what tenancy costs an index that ignores it) and the two indexes
 * `003-tenancy` actually creates.
 *
 * The seed now spreads rows across several tenants. On a single-tenant table the
 * `organization_id` predicate is free and the measurement would flatter the tenant-led
 * layout for the wrong reason: the column only earns its place when there are other
 * tenants' rows to skip. `ORGS`, `AGENTS` and the status cycle are pairwise coprime
 * (7, 12, 5) so that every combination occurs — with a shared factor, the measured
 * agent would appear under one tenant only, and the isolation check below would pass
 * without proving anything.
 *
 * Run: npx tsx script/bench-daily-spend.ts
 */

import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const path = join(tmpdir(), `placet-bench-${Date.now()}.db`);
const db = new Database(path);
db.pragma("journal_mode = WAL");

/*
 * Mirrors the post-003 shape of the real table: `organization_id NOT NULL` and a
 * composite primary key `(organization_id, id)`. The synthetic table is deliberate —
 * this script benchmarks index layouts, so it must be able to create and drop them
 * one at a time, which it cannot do on a migrated database without editing migrations.
 * What matters is that the columns, the key and the query match production.
 */
db.exec(`
  CREATE TABLE executions (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (organization_id, id)
  );
`);

const ROWS = 200_000;
const AGENTS = 12;
const ORGS = 7;
// Most executions are not `allowed`: blocked and failed rows are exactly the ones a
// non-covering index cannot skip.
const STATUSES = ["allowed", "blocked", "failed", "blocked", "failed"] as const;

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const ORG = "org_0";
const AGENT = "agt_3";
const SINCE = new Date(BASE + ROWS * 30_000).toISOString();

const insert = db.prepare(
  `INSERT INTO executions (organization_id, id, agent_id, status, timestamp, cost)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

/*
 * The two reference totals are accumulated while seeding rather than read back with a
 * second SQL query: a reference computed by the same engine, on the same indexes, would
 * be wrong in exactly the cases this check exists to catch.
 *
 * `expectedScoped` is the answer the tenant-led query must return. `expectedAcrossOrgs`
 * is what the same query returns if the `organization_id` predicate is dropped or an
 * index makes it ineffective — the leak. They must differ, otherwise the isolation
 * assertion below would hold trivially and prove nothing.
 */
let expectedScoped = 0;
let expectedAcrossOrgs = 0;

const seed = db.transaction(() => {
  for (let i = 0; i < ROWS; i += 1) {
    const org = `org_${i % ORGS}`;
    const agent = `agt_${i % AGENTS}`;
    const status = STATUSES[i % STATUSES.length];
    const timestamp = new Date(BASE + i * 60_000).toISOString();
    const cost = (i % 97) + 1;
    insert.run(org, `exec_${i}`, agent, status, timestamp, cost);

    if (agent === AGENT && status === "allowed" && timestamp >= SINCE) {
      expectedAcrossOrgs += cost;
      if (org === ORG) expectedScoped += cost;
    }
  }
});
seed();

/*
 * Column order and predicate order copied from `dailySpendQuery` in
 * `server/repositories/sqlite.ts`: organization_id, agent_id, status, timestamp.
 */
const SQL = `
  SELECT coalesce(sum(cost), 0) AS total
  FROM executions
  WHERE organization_id = ? AND agent_id = ? AND status = 'allowed' AND timestamp >= ?
`;

let leaked = false;

function measure(label: string): void {
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${SQL}`)
    .all(ORG, AGENT, SINCE) as { detail: string }[];
  const stmt = db.prepare(SQL);

  // Warm the cache so the comparison is about the plan, not about page faults.
  for (let i = 0; i < 50; i += 1) stmt.get(ORG, AGENT, SINCE);

  const ITERATIONS = 500;
  const started = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) stmt.get(ORG, AGENT, SINCE);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const result = stmt.get(ORG, AGENT, SINCE) as { total: number };

  console.log(`\n### ${label}`);
  for (const step of plan) console.log(`  plan: ${step.detail}`);
  console.log(`  total: ${result.total}`);
  console.log(`  ${ITERATIONS} queries in ${elapsedMs.toFixed(1)}ms`);
  console.log(`  mean: ${((elapsedMs / ITERATIONS) * 1000).toFixed(1)}µs/query`);

  /*
   * Checked under EVERY layout, not once at the end. An index cannot legally change a
   * result, but that is precisely the assumption worth testing here: a benchmark that
   * only reports timings would happily declare a layout the winner while it answered
   * the wrong question, which is how this script came to endorse a pre-tenancy index
   * in the first place.
   */
  if (result.total !== expectedScoped) {
    leaked = true;
    console.log(
      `  !! TENANT ISOLATION BROKEN under this layout: got ${result.total}, ` +
        `expected ${expectedScoped} for ${ORG} alone ` +
        `(${expectedAcrossOrgs} is the all-tenant total).`,
    );
  } else {
    console.log(
      `  isolation OK: ${ORG} only (${expectedScoped}), not all ${ORGS} tenants (${expectedAcrossOrgs}).`,
    );
  }
}

if (expectedScoped === expectedAcrossOrgs) {
  console.error(
    "Seed is degenerate: the measured agent has rows in one tenant only, so the " +
      "isolation check cannot fail. Fix ORGS/AGENTS/STATUSES so they stay coprime.",
  );
  process.exit(2);
}

/*
 * One candidate index at a time, dropped between measurements, rather than creating
 * them cumulatively and trusting the planner to prefer the newest. SQLite picks what it
 * judges cheapest, so a cumulative script silently measures the same index twice.
 */
db.exec(`CREATE INDEX idx_executions_spend ON executions (agent_id, status, timestamp, cost)`);
measure("LEGACY (dropped by 003-tenancy) — idx_executions_spend (agent_id, status, timestamp, cost)");
db.exec(`DROP INDEX idx_executions_spend`);

db.exec(
  `CREATE INDEX idx_executions_org_agent_ts ON executions (organization_id, agent_id, timestamp)`,
);
measure("TENANT-LED, NOT COVERING — idx_executions_org_agent_ts (organization_id, agent_id, timestamp)");
db.exec(`DROP INDEX idx_executions_org_agent_ts`);

db.exec(
  `CREATE INDEX idx_executions_org_spend ON executions (organization_id, agent_id, status, timestamp, cost)`,
);
measure("PRODUCTION — idx_executions_org_spend (organization_id, agent_id, status, timestamp, cost)");

db.close();
rmSync(path, { force: true });
rmSync(`${path}-wal`, { force: true });
rmSync(`${path}-shm`, { force: true });

/*
 * Non-zero on a wrong total. A benchmark is allowed to be slow; it is not allowed to be
 * wrong, and a spend total that crosses tenants would both leak and mis-govern.
 */
if (leaked) {
  console.error("\nFAIL: at least one layout returned a spend total that was not tenant-scoped.");
  process.exit(1);
}
console.log("\nAll layouts returned the tenant-scoped total.");
