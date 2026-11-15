/**
 * PHASE 11 — a worker that tries to consume one action grant, in its OWN process.
 *
 * WHY A SEPARATE PROCESS AND NOT `Promise.all`
 * -------------------------------------------
 * `Promise.all` inside one process shares one module registry, one connection pool and
 * one event loop. Anything that happens to be a JavaScript-level lock — a promise the
 * callers await, a module-scoped `Set`, a single-connection pool — makes the race
 * disappear, and the test passes while proving nothing about a deployment with several
 * replicas behind a load balancer. That deployment is the whole point of moving the core
 * to PostgreSQL: two or more Node processes, no shared memory, one database.
 *
 * So this file is spawned N times. The only thing the copies share is PostgreSQL, and
 * the only thing that can keep them from double-spending a grant is the database.
 *
 * PROTOCOL
 * --------
 * Input, all via environment:
 *   OATHRION_TEST_POSTGRES_URL  connection string
 *   OATHRION_WORKER_ORG         tenant
 *   OATHRION_WORKER_GRANT       grant id to consume
 *   OATHRION_WORKER_AGENT       agent id bound to the grant
 *   OATHRION_WORKER_HASH        action hash bound to the grant
 *   OATHRION_WORKER_DEST        destination id bound to the grant
 *   OATHRION_WORKER_LABEL       identifies this worker in the downstream table
 *   OATHRION_WORKER_START_AT    epoch ms; the worker sleeps until then before consuming
 *
 * Output: exactly one line of JSON on stdout, `{"label":…,"claimed":true|false}`,
 * and exit code 0 even when refused — a refusal is a correct outcome, not a crash.
 * Only an unexpected error exits non-zero, so the test can tell "refused" from "broke".
 *
 * The downstream effect is recorded by the worker itself, inside the same transaction
 * as the consumption, into `phase11_downstream`. That table stands in for the real
 * side effect (the money moving). Counting its rows answers the only question that
 * matters: did the action happen more than once?
 */

import { Pool } from "pg";
import { ActionAuthorityStore } from "../../authority/store";
import { postgresExecutor } from "../../sql/executor";
import type { OrganizationId } from "@shared/tenancy";

async function main(): Promise<void> {
  const connectionString = process.env.OATHRION_TEST_POSTGRES_URL;
  const org = process.env.OATHRION_WORKER_ORG;
  const grantId = process.env.OATHRION_WORKER_GRANT;
  const agentId = process.env.OATHRION_WORKER_AGENT;
  const actionHash = process.env.OATHRION_WORKER_HASH;
  const destinationId = process.env.OATHRION_WORKER_DEST;
  const label = process.env.OATHRION_WORKER_LABEL ?? "worker";
  const startAt = Number(process.env.OATHRION_WORKER_START_AT ?? "0");

  if (!connectionString || !org || !grantId || !agentId || !actionHash || !destinationId) {
    throw new Error("worker misconfigured: missing environment");
  }

  const pool = new Pool({ connectionString, max: 2 });
  try {
    const sql = postgresExecutor(pool);
    const store = new ActionAuthorityStore(sql, org as unknown as OrganizationId);

    // Warm the connection BEFORE the barrier. Otherwise the first worker to finish its
    // TCP handshake wins by a wide margin and the processes never actually contend.
    await pool.query("SELECT 1");

    const waitMs = startAt - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

    /*
     * Consumption and downstream effect in ONE transaction. If they were separate, a
     * crash between them would either lose the effect (grant burned, nothing happened)
     * or duplicate it (effect recorded, grant still issued). Both are the failure this
     * suite exists to rule out.
     */
    const claimed = await sql.transaction(async (tx) => {
      const scoped = new ActionAuthorityStore(tx, org as unknown as OrganizationId);
      const result = await scoped.consumeGrant({
        id: grantId,
        agentId,
        actionHash,
        destinationId,
        at: new Date().toISOString(),
        consumedBy: label,
      });
      if (!result.claimed) return false;
      await tx.run(
        `INSERT INTO phase11_downstream (grant_id, worker_label, at) VALUES (?, ?, ?)`,
        [grantId, label, new Date().toISOString()],
      );
      return true;
    });

    process.stdout.write(`${JSON.stringify({ label, claimed })}\n`);
    void store;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
