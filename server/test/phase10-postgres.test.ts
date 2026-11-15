/**
 * The action authorization plane on REAL PostgreSQL (Phase 10, §9).
 *
 * WHY THIS SUITE HAS TO EXIST SEPARATELY
 * -------------------------------------
 * Single-use is not a property of the application, it is a property of the store.
 * On SQLite the whole file is one writer, so "exactly one consumer wins" is nearly
 * free and proves very little about a deployment where two Oathrion instances share a
 * database. The claim that matters — two processes, one grant, one execution — can
 * only be tested against the engine that will actually arbitrate it.
 *
 * It runs against a real server: a real connection, the real migration runner, the
 * real `UPDATE ... WHERE state = 'issued'` arbitration, over a pool with several
 * connections so the racing statements genuinely arrive on different sessions.
 *
 * HOW IT BEHAVES WITHOUT A DATABASE
 * ---------------------------------
 * It SKIPS, loudly, and it never silently degrades to SQLite. A skipped test is
 * honest ("this was not verified here"); a test that quietly re-runs the SQLite
 * path while reporting a PostgreSQL name is a false claim in the test report.
 * `OATHRION_TEST_POSTGRES_URL` (or `DATABASE_URL`) selects the server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { OrganizationId } from "@shared/tenancy";
import { ActionAuthorityStore, type GrantRecord } from "../authority/store";
import { postgresExecutor } from "../sql/executor";
import { AuthorityInitializationError, initializeActionAuthority, resetActionAuthority } from "../authority";
import { MIGRATIONS, migratePostgres, ACTION_GRANTS_TABLE } from "../migrations";

const CONNECTION = process.env.OATHRION_TEST_POSTGRES_URL ?? process.env.DATABASE_URL ?? "";

/** Is a server actually reachable? Decided once, before the suite is defined. */
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
  describe.skip("Phase 10 — PostgreSQL action authority (SKIPPED: no server reachable)", () => {
    it("was not verified", () => {
      expect(true).toBe(true);
    });
  });
}

describe.runIf(available)("Phase 10 — action authority on real PostgreSQL", () => {
  const ORG = "org_pg_phase10" as unknown as OrganizationId;
  let pool: Pool;
  let store: ActionAuthorityStore;

  const now = () => new Date().toISOString();

  async function seedIssuedGrant(overrides: Partial<GrantRecord> = {}): Promise<GrantRecord> {
    const actionId = `act_${randomUUID().replace(/-/g, "")}`;
    const hash = randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);
    await store.createAction({
      id: actionId,
      agentId: "agt_pg",
      action: "stripe.refund",
      arguments: { amount: 75, currency: "EUR" },
      destinationId: "local-fixture",
      canonical: `{"v":"placet.action.v1","amount":75,"id":"${actionId}"}`,
      actionHash: hash,
      requestId: null,
      idempotencyKey: null,
      decision: "ALLOW",
      reason: "seeded",
      policyId: null,
      createdAt: now(),
    });
    return store.createGrant({
      id: `grt_${randomUUID().replace(/-/g, "")}`,
      actionId,
      agentId: "agt_pg",
      action: "stripe.refund",
      actionHash: hash,
      destinationId: "local-fixture",
      decision: "ALLOW",
      state: "issued",
      requestId: null,
      idempotencyKey: null,
      policyId: null,
      createdAt: now(),
      issuedAt: now(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      consumedAt: null,
      consumedBy: null,
      approvalId: null,
      approvedAt: null,
      approvedBy: null,
      revokedAt: null,
      revokedReason: null,
      ...overrides,
    });
  }

  beforeAll(async () => {
    // The same migration list the SQLite path applies, through the same runner.
    await migratePostgres(CONNECTION, MIGRATIONS);
    // Several connections on purpose: with max=1 the "race" would be serialised by
    // the pool rather than arbitrated by PostgreSQL, and the test would pass for
    // the wrong reason.
    pool = new Pool({ connectionString: CONNECTION, max: 8 });
    store = new ActionAuthorityStore(postgresExecutor(pool), ORG);
    await pool.query(`DELETE FROM ${ACTION_GRANTS_TABLE} WHERE organization_id = $1`, [String(ORG)]);
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await resetActionAuthority();
  });

  it("writes and reads a grant through the PostgreSQL executor", async () => {
    const grant = await seedIssuedGrant();
    const found = await store.findGrant(grant.id);
    expect(found?.state).toBe("issued");
    expect(found?.expiresAt).toBeTruthy();
    // Proof of engine: ask the server, not the abstraction.
    const raw = await pool.query(`SELECT state FROM ${ACTION_GRANTS_TABLE} WHERE id = $1`, [grant.id]);
    expect(raw.rows[0]).toEqual({ state: "issued" });
  });

  it("EIGHT concurrent consumers of one grant: exactly one wins", async () => {
    const grant = await seedIssuedGrant();
    const at = now();

    /*
     * All eight statements are in flight before any resolves, on eight different
     * connections. This is the assertion the whole phase rests on, and it is the
     * one a sequential loop cannot make: a loop only shows that the second attempt
     * sees the first attempt's committed row.
     */
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        store.consumeGrant({
          id: grant.id,
          agentId: "agt_pg",
          actionHash: grant.actionHash,
          destinationId: "local-fixture",
          at,
          consumedBy: `consumer-${index}`,
        }),
      ),
    );

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    const final = await store.findGrant(grant.id);
    expect(final?.state).toBe("consumed");
    // And the winner is recorded, so the receipt can name who actually consumed it.
    expect(final?.consumedBy).toMatch(/^consumer-\d$/);
  });

  it("refuses to consume for a different agent, action, or destination", async () => {
    const grant = await seedIssuedGrant();
    const base = {
      id: grant.id,
      agentId: "agt_pg",
      actionHash: grant.actionHash,
      destinationId: "local-fixture",
      at: now(),
      consumedBy: "tester",
    };
    for (const mutation of [
      { agentId: "agt_someone_else" },
      { actionHash: "f".repeat(64) },
      { destinationId: "other-fixture" },
    ]) {
      const attempt = await store.consumeGrant({ ...base, ...mutation });
      expect(attempt.claimed, JSON.stringify(mutation)).toBe(false);
    }
    // Untouched, so the honest consumer can still use it.
    expect((await store.findGrant(grant.id))?.state).toBe("issued");
    expect((await store.consumeGrant(base)).claimed).toBe(true);
  });

  it("refuses an expired grant in the database, not in application code", async () => {
    const expired = await seedIssuedGrant({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const attempt = await store.consumeGrant({
      id: expired.id,
      agentId: "agt_pg",
      actionHash: expired.actionHash,
      destinationId: "local-fixture",
      at: now(),
      consumedBy: "late",
    });
    expect(attempt.claimed).toBe(false);
  });

  it("scopes every row to its tenant, so another organization sees nothing", async () => {
    const grant = await seedIssuedGrant();
    const rival = new ActionAuthorityStore(postgresExecutor(pool), "org_rival_pg" as unknown as OrganizationId);
    expect(await rival.findGrant(grant.id)).toBeUndefined();
    const stolen = await rival.consumeGrant({
      id: grant.id,
      agentId: "agt_pg",
      actionHash: grant.actionHash,
      destinationId: "local-fixture",
      at: now(),
      consumedBy: "rival",
    });
    expect(stolen.claimed).toBe(false);
    expect((await store.findGrant(grant.id))?.state).toBe("issued");
  });

  it("only one approval of a pending grant can succeed", async () => {
    const pending = await seedIssuedGrant({
      state: "pending_approval",
      issuedAt: null,
      decision: "APPROVAL_REQUIRED",
      approvalId: `apr_${randomUUID().replace(/-/g, "")}`,
    });
    const attempts = await Promise.all(
      Array.from({ length: 4 }, (_unused, index) =>
        store.approveGrant({
          id: pending.id,
          expectedActionHash: pending.actionHash,
          approvedBy: `approver-${index}`,
          at: now(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          notBefore: now(),
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.claimed)).toHaveLength(1);
    expect((await store.findGrant(pending.id))?.state).toBe("issued");
  });

  it("an approval naming a different action cannot move the approval to it", async () => {
    const pending = await seedIssuedGrant({ state: "pending_approval", issuedAt: null, decision: "APPROVAL_REQUIRED" });
    const wrong = await store.approveGrant({
      id: pending.id,
      // The approver reviewed a different action than this row describes.
      expectedActionHash: "a".repeat(64),
      approvedBy: "approver",
      at: now(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      notBefore: now(),
    });
    expect(wrong.claimed).toBe(false);
    expect((await store.findGrant(pending.id))?.state).toBe("pending_approval");
  });

  it("selecting postgres and failing to reach it FAILS CLOSED, never falls back", async () => {
    await resetActionAuthority();
    await expect(
      initializeActionAuthority({
        ...process.env,
        OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
        // A port nothing listens on. The point is what Oathrion does about it.
        DATABASE_URL: "postgres://postgres:wrong@127.0.0.1:1/nonexistent",
      }),
    ).rejects.toThrow(AuthorityInitializationError);
    await resetActionAuthority();
  });

  it("initializes for real when postgres IS reachable", async () => {
    await resetActionAuthority();
    const { driver } = await initializeActionAuthority({
      ...process.env,
      OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
      DATABASE_URL: CONNECTION,
    });
    expect(driver).toBe("postgres");
    await resetActionAuthority();
  });
});
