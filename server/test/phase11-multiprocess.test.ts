/**
 * PHASE 11 — golden scenario O: SEVERAL REAL PROCESSES, ONE GRANT.
 *
 * The claim under test is the one that matters for a production deployment with more
 * than one replica: an action grant is consumed EXACTLY ONCE, cluster-wide, and the
 * downstream effect happens exactly once with it. Nothing in JavaScript can establish
 * that — no mutex, no in-process `Set`, no awaited promise — because the replicas share
 * no memory. Only the database can.
 *
 * So this suite spawns actual `node`/`tsx` child processes (see
 * server/test/fixtures/phase11-consume-worker.ts), releases them on a common clock
 * barrier, and counts rows in a downstream table that stands in for the real side
 * effect. The rule from the brief, applied literally: if Oathrion refuses, downstream = 0;
 * if Oathrion authorises, downstream = exactly 1.
 *
 * Skips loudly with no PostgreSQL server. It cannot be emulated on SQLite: a second
 * process opening the same file is a different concurrency story (file locks, SQLITE_BUSY),
 * and pretending otherwise would be exactly the kind of false PASS this phase forbids.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { OrganizationId } from "@shared/tenancy";
import { ActionAuthorityStore } from "../authority/store";
import { postgresExecutor } from "../sql/executor";
import { MIGRATIONS, migratePostgres } from "../migrations";

const CONNECTION = process.env.OATHRION_TEST_POSTGRES_URL ?? process.env.DATABASE_URL ?? "";
const WORKER = path.resolve(import.meta.dirname, "fixtures/phase11-consume-worker.ts");
// The TypeScript runner already in devDependencies. Spawned as a script under the same
// node binary rather than through `npx`, so the test does not depend on PATH or network.
const TSX_CLI = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const ORG = "org_pg_phase11_mp" as unknown as OrganizationId;

async function reachable(): Promise<boolean> {
  if (!CONNECTION) return false;
  const probe = new Pool({ connectionString: CONNECTION, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const available = await reachable();

if (!available) {
  describe.skip("Phase 11 — multi-process grant consumption (SKIPPED: no server reachable)", () => {
    it("was not verified", () => {
      expect(true).toBe(true);
    });
  });
}

interface WorkerOutcome {
  label: string;
  claimed: boolean;
  exitCode: number | null;
  stderr: string;
}

/** Runs one worker process to completion and reports what it decided. */
function runWorker(env: Record<string, string>): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, WORKER], {
      env: { ...process.env, ...env, OATHRION_TEST_POSTGRES_URL: CONNECTION },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const line = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{"))
        .pop();
      if (!line) {
        resolve({ label: env.OATHRION_WORKER_LABEL ?? "?", claimed: false, exitCode, stderr: err });
        return;
      }
      const parsed = JSON.parse(line) as { label: string; claimed: boolean };
      resolve({ ...parsed, exitCode, stderr: err });
    });
  });
}

describe.runIf(available)("Phase 11 — one grant, several real processes", () => {
  let pool: Pool;
  let store: ActionAuthorityStore;

  const now = () => new Date().toISOString();

  async function seedGrant(overrides: { state?: string; expiresAt?: string } = {}) {
    const actionId = `act_${randomUUID().replace(/-/g, "")}`;
    const actionHash = randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);
    const agentId = "agt_mp";
    const destinationId = "local-fixture";
    await store.createAction({
      id: actionId,
      agentId,
      action: "stripe.refund",
      arguments: { amount: 500, currency: "EUR" },
      destinationId,
      canonical: `{"v":"placet.action.v1","id":"${actionId}"}`,
      actionHash,
      requestId: null,
      idempotencyKey: null,
      decision: "ALLOW",
      reason: "multiprocess fixture",
      policyId: null,
      createdAt: now(),
    });
    const grant = await store.createGrant({
      id: `grt_${randomUUID().replace(/-/g, "")}`,
      actionId,
      agentId,
      action: "stripe.refund",
      actionHash,
      destinationId,
      decision: "ALLOW",
      state: (overrides.state ?? "issued") as never,
      requestId: null,
      idempotencyKey: null,
      policyId: null,
      createdAt: now(),
      issuedAt: now(),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 300_000).toISOString(),
      consumedAt: null,
      consumedBy: null,
      approvalId: null,
      approvedAt: null,
      approvedBy: null,
      revokedAt: null,
      revokedReason: null,
    });
    return { grant, agentId, actionHash, destinationId };
  }

  /** Downstream effects recorded for a grant — the count that must never exceed 1. */
  async function downstreamCount(grantId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM phase11_downstream WHERE grant_id = $1`,
      [grantId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  beforeAll(async () => {
    await migratePostgres(CONNECTION, MIGRATIONS);
    pool = new Pool({ connectionString: CONNECTION, max: 5 });
    /*
     * The downstream table is a test fixture, not part of the product schema, so it is
     * created here rather than in a migration. It carries no tenant column on purpose:
     * it represents an external system that has no idea Oathrion is multi-tenant, and would
     * happily move the money twice if asked twice.
     */
    await pool.query(`CREATE TABLE IF NOT EXISTS phase11_downstream (
      id SERIAL PRIMARY KEY,
      grant_id TEXT NOT NULL,
      worker_label TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL
    )`);
    store = new ActionAuthorityStore(postgresExecutor(pool), ORG);
  });

  afterEach(async () => {
    await pool.query(`TRUNCATE phase11_downstream`);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS phase11_downstream`);
    await pool.end().catch(() => {});
  });

  it(
    "O — 4 independent processes race for one issued grant: exactly one consumes, downstream = exactly 1",
    async () => {
      const { grant, agentId, actionHash, destinationId } = await seedGrant();
      // A barrier far enough out that every child has spawned, compiled and connected.
      const startAt = String(Date.now() + 4_000);

      const outcomes = await Promise.all(
        ["w1", "w2", "w3", "w4"].map((label) =>
          runWorker({
            OATHRION_WORKER_ORG: String(ORG),
            OATHRION_WORKER_GRANT: grant.id,
            OATHRION_WORKER_AGENT: agentId,
            OATHRION_WORKER_HASH: actionHash,
            OATHRION_WORKER_DEST: destinationId,
            OATHRION_WORKER_LABEL: label,
            OATHRION_WORKER_START_AT: startAt,
          }),
        ),
      );

      // No worker may crash: a crash would make "only one claimed" true for the wrong
      // reason (three processes died rather than were refused).
      for (const outcome of outcomes) {
        expect(outcome.exitCode, `worker ${outcome.label} stderr: ${outcome.stderr}`).toBe(0);
      }

      const winners = outcomes.filter((o) => o.claimed);
      expect(winners).toHaveLength(1);
      expect(await downstreamCount(grant.id)).toBe(1);

      // The grant itself is terminal and attributed to the winner.
      const stored = await store.findGrant(grant.id);
      expect(stored?.state).toBe("consumed");
      expect(stored?.consumedBy).toBe(winners[0]?.label);
    },
    60_000,
  );

  it(
    "O — when Oathrion refuses (grant already consumed), every process is refused and downstream = 0",
    async () => {
      const { grant, agentId, actionHash, destinationId } = await seedGrant({ state: "consumed" });
      const startAt = String(Date.now() + 3_000);

      const outcomes = await Promise.all(
        ["r1", "r2", "r3"].map((label) =>
          runWorker({
            OATHRION_WORKER_ORG: String(ORG),
            OATHRION_WORKER_GRANT: grant.id,
            OATHRION_WORKER_AGENT: agentId,
            OATHRION_WORKER_HASH: actionHash,
            OATHRION_WORKER_DEST: destinationId,
            OATHRION_WORKER_LABEL: label,
            OATHRION_WORKER_START_AT: startAt,
          }),
        ),
      );

      for (const outcome of outcomes) {
        expect(outcome.exitCode, outcome.stderr).toBe(0);
        expect(outcome.claimed).toBe(false);
      }
      expect(await downstreamCount(grant.id)).toBe(0);
    },
    60_000,
  );

  it(
    "O — an expired grant is refused by every process, and expiry is judged by the database",
    async () => {
      const { grant, agentId, actionHash, destinationId } = await seedGrant({
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      const startAt = String(Date.now() + 3_000);

      const outcomes = await Promise.all(
        ["e1", "e2"].map((label) =>
          runWorker({
            OATHRION_WORKER_ORG: String(ORG),
            OATHRION_WORKER_GRANT: grant.id,
            OATHRION_WORKER_AGENT: agentId,
            OATHRION_WORKER_HASH: actionHash,
            OATHRION_WORKER_DEST: destinationId,
            OATHRION_WORKER_LABEL: label,
            OATHRION_WORKER_START_AT: startAt,
          }),
        ),
      );

      for (const outcome of outcomes) {
        expect(outcome.exitCode, outcome.stderr).toBe(0);
        expect(outcome.claimed).toBe(false);
      }
      expect(await downstreamCount(grant.id)).toBe(0);
      expect((await store.findGrant(grant.id))?.state).toBe("issued");
    },
    60_000,
  );

  it(
    "O — a process from another tenant cannot consume this tenant's grant",
    async () => {
      const { grant, agentId, actionHash, destinationId } = await seedGrant();
      const outcome = await runWorker({
        OATHRION_WORKER_ORG: "org_pg_phase11_intruder",
        OATHRION_WORKER_GRANT: grant.id,
        OATHRION_WORKER_AGENT: agentId,
        OATHRION_WORKER_HASH: actionHash,
        OATHRION_WORKER_DEST: destinationId,
        OATHRION_WORKER_LABEL: "intruder",
        OATHRION_WORKER_START_AT: String(Date.now()),
      });

      expect(outcome.exitCode, outcome.stderr).toBe(0);
      expect(outcome.claimed).toBe(false);
      expect(await downstreamCount(grant.id)).toBe(0);
      // Still consumable by its rightful tenant afterwards: the refusal did not damage it.
      expect((await store.findGrant(grant.id))?.state).toBe("issued");
    },
    60_000,
  );

  it(
    "O — a process presenting a different action hash for a valid grant is refused",
    async () => {
      // The grant is bound to one canonical action. A worker that consumes it while
      // presenting different arguments is the substitution attack, across processes.
      const { grant, agentId, destinationId } = await seedGrant();
      const outcome = await runWorker({
        OATHRION_WORKER_ORG: String(ORG),
        OATHRION_WORKER_GRANT: grant.id,
        OATHRION_WORKER_AGENT: agentId,
        OATHRION_WORKER_HASH: "f".repeat(64),
        OATHRION_WORKER_DEST: destinationId,
        OATHRION_WORKER_LABEL: "substituter",
        OATHRION_WORKER_START_AT: String(Date.now()),
      });

      expect(outcome.exitCode, outcome.stderr).toBe(0);
      expect(outcome.claimed).toBe(false);
      expect(await downstreamCount(grant.id)).toBe(0);
      expect((await store.findGrant(grant.id))?.state).toBe("issued");
    },
    60_000,
  );
});
