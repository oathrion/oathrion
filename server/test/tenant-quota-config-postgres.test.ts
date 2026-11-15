/**
 * Chantier 1, étape 1 — per-tenant quota ceilings on a real PostgreSQL, across processes.
 *
 * The SQLite suite (`tenant-quota-config.test.ts`) proves the resolution order and the
 * validation. What it cannot prove is the property the chantier exists for: several
 * instances share ONE configuration, and a change made through one of them is seen by
 * the others on their next request, with no restart. That needs separate processes on a
 * shared PostgreSQL, which is what this file runs (same fixture as Phase 12).
 *
 * Skipped — loudly — without OATHRION_TEST_IDENTITY_PG_URL; never replayed on SQLite.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { Pool } from "pg";

import {
  migratePhase12Database,
  parseInstanceOutput,
  PHASE12_IDENTITY_URL as IDENTITY_URL,
  PHASE12_REPO_ROOT,
  phase12Env,
  runInstance,
} from "./helpers/phase12-instance";

const suite = IDENTITY_URL === "" ? describe.skip : describe;

if (IDENTITY_URL === "") {
  console.warn(
    "[tenant-quota-config-postgres] SKIPPED — OATHRION_TEST_IDENTITY_PG_URL n'est pas défini. " +
      "Le partage des plafonds entre instances PostgreSQL n'est PAS testé dans cette exécution.",
  );
}

const FIXTURE = path.join(PHASE12_REPO_ROOT, "server/test/fixtures/phase12-identity-instance.ts");

/** Starts an instance WITHOUT waiting for it, so the test can act while it is alive. */
function startInstance(ops: unknown[], extraEnv: Record<string, string> = {}) {
  const child = spawn("npx", ["tsx", FIXTURE, JSON.stringify({ ops })], {
    cwd: PHASE12_REPO_ROOT,
    env: phase12Env(extraEnv),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<ReturnType<typeof parseInstanceOutput>>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      try {
        resolve(
          parseInstanceOutput({ stdout, stderr, status } as Parameters<typeof parseInstanceOutput>[0]),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
  return { done };
}

suite("Chantier 1 — plafonds par tenant partagés par PostgreSQL", () => {
  const tag = randomBytes(4).toString("hex");
  const orgA = `org_tq_a_${tag}`;
  const orgB = `org_tq_b_${tag}`;

  beforeAll(() => {
    migratePhase12Database();
  }, 130_000);

  it("un plafond changé par l'instance B s'applique à la requête suivante de l'instance A, sans redémarrage", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "placet-tq-"));
    const go = path.join(dir, "go");
    const ready = path.join(dir, "ready");
    try {
      // A is alive for the whole test: reads, waits, reads again — same process.
      const a = startInstance([
        { op: "quotaLimits", organization: orgA },
        { op: "touchFile", path: ready },
        { op: "waitForFile", path: go, timeoutMs: 90_000 },
        { op: "quotaLimits", organization: orgA },
        { op: "quotaLimits", organization: orgB },
      ]);
      // B changes A's ceiling only once A has read it — otherwise the first read could
      // follow the write and the test would prove nothing about staleness.
      const deadline = Date.now() + 90_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(existsSync(ready)).toBe(true);
      const [set] = runInstance([
        { op: "setOrganizationQuota", organization: orgA, counter: "agents", ceiling: 3 },
      ]);
      expect(set).toEqual({ op: "setOrganizationQuota", ok: true });
      writeFileSync(go, "");

      const [before, , waited, after, other] = await a.done;
      expect(waited).toEqual({ op: "waitForFile", seen: true });
      expect((before.limits as { agents: number }).agents).not.toBe(3);
      expect((after.limits as { agents: number }).agents).toBe(3);
      // Only the tenant that was changed.
      expect((other.limits as { agents: number }).agents).toBe(
        (before.limits as { agents: number }).agents,
      );
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }, 200_000);

  it("OATHRION_QUOTAS est synchronisé de façon idempotente entre deux démarrages, et contredire une valeur écrite par l'application refuse le démarrage", () => {
    // The database is shared with earlier runs: a boot with an empty OATHRION_QUOTAS first
    // removes any environment-owned row they left, so the counts below are this test's.
    runInstance([{ op: "importQuotas" }], { OATHRION_QUOTAS: "" });
    const env = { OATHRION_QUOTAS: `${orgB}:executions=777,${orgB}:policies=55` };
    const [first] = runInstance([{ op: "importQuotas" }], env);
    expect(first).toEqual({ op: "importQuotas", imported: 2, updated: 0, removed: 0, unchanged: 0 });
    const [second] = runInstance([{ op: "importQuotas" }], env);
    expect(second).toEqual({ op: "importQuotas", imported: 0, updated: 0, removed: 0, unchanged: 2 });

    // Edited entry → the row it owns follows; removed entry → its row goes.
    const [edited] = runInstance([{ op: "importQuotas" }], { OATHRION_QUOTAS: `${orgB}:executions=778` });
    expect(edited).toEqual({ op: "importQuotas", imported: 0, updated: 1, removed: 1, unchanged: 0 });

    // The application takes the ceiling over; an environment that contradicts it refuses.
    const [taken] = runInstance(
      [{ op: "setOrganizationQuota", organization: orgB, counter: "executions", ceiling: 900 }],
      { OATHRION_QUOTAS: "" },
    );
    expect(taken).toEqual({ op: "setOrganizationQuota", ok: true });
    const [conflict] = runInstance([{ op: "importQuotas" }], { OATHRION_QUOTAS: `${orgB}:executions=778` });
    expect(String(conflict.error)).toContain(orgB);
    expect(String(conflict.error)).toContain("778");
    expect(String(conflict.error)).toContain("900");

    const [limits] = runInstance([{ op: "quotaLimits", organization: orgB }], { OATHRION_QUOTAS: "" });
    expect((limits.limits as { executions: number }).executions).toBe(900);
  }, 200_000);

  it("PostgreSQL refuse lui-même un plafond invalide (contraintes CHECK)", async () => {
    const pool = new Pool({ connectionString: IDENTITY_URL, max: 1 });
    try {
      await expect(
        pool.query(
          `INSERT INTO organization_quotas (organization_id, counter, ceiling, source, updated_at)
           VALUES ($1, 'agents', -1, 'api', now())`,
          [orgA],
        ),
        // 23514 = check_violation. Asserting the code, not merely a rejection: an absent
        // table also rejects, and would make this test pass for the wrong reason.
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO organization_quotas (organization_id, counter, ceiling, source, updated_at)
           VALUES ($1, 'seats', 1, 'api', now())`,
          [orgA],
        ),
        // 23514 = check_violation. Asserting the code, not merely a rejection: an absent
        // table also rejects, and would make this test pass for the wrong reason.
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await pool.end();
    }
  }, 30_000);
});
