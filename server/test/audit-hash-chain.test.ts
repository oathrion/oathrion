/**
 * REGRESSION — the audit trail is cryptographically chained (findings I4 / S3).
 *
 * Before this, the trail could not lose an entry (`appendAudit` is atomic) but it could
 * be edited afterwards without leaving a trace. These tests assert the property that
 * fixes that: every entry is linked to the one before it, and any edit, reorder,
 * insertion or removal is detectable and localisable.
 *
 * They exercise the real repository against a real database, through the same
 * `create`/`appendAudit` doors production uses — not the hashing helpers in isolation,
 * because a chain computed correctly by a pure function and then bypassed by the write
 * path would still be worthless.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain, auditEntryHash, auditGenesisHash } from "../audit-chain";
import { repositoriesFor } from "../repositories";
import { DEFAULT_ORGANIZATION_ID, organizationId } from "@shared/tenancy";
import { startTestServer, type TestClient } from "./harness";
import type { AuditEntry, Execution } from "@shared/types";

const ORG_A = DEFAULT_ORGANIZATION_ID;
/** The second tenant, same one `tenant-isolation.test.ts` uses. */
const ORG_B = organizationId("org_rival_corp");

function entry(n: number): AuditEntry {
  return { at: `2026-01-01T00:00:0${n}.000Z`, actor: "policy-engine", event: `event ${n}` };
}

function execution(id: string, audit: AuditEntry[]): Execution {
  return {
    id,
    agentId: "agt_1",
    agentName: "Agent",
    action: "purchase",
    target: "vendor",
    status: "allowed",
    risk: "low",
    durationMs: 1,
    cost: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    input: {},
    decision: "allow",
    decisionReason: "ok",
    policyEvaluated: null,
    policyId: null,
    result: "done",
    audit,
  };
}

describe("audit trail hash chaining", () => {
  let api: TestClient;

  /* The harness owns the database lifecycle; every test below uses its own execution
   * ids, so no reset between tests is needed. */
  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("chains the opening trail written at creation", async () => {
    const repos = repositoriesFor(ORG_A);
    const created = await repos.executions.create(
      execution("exe_open", [entry(1), entry(2), entry(3)]),
    );

    expect(created.audit).toHaveLength(3);
    // The first entry anchors to the genesis hash, not to nothing.
    expect(created.audit[0].prevHash).toBe(auditGenesisHash(ORG_A, "exe_open"));
    for (const e of created.audit) {
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.prevHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Each entry points at the previous entry's hash.
    expect(created.audit[1].prevHash).toBe(created.audit[0].hash);
    expect(created.audit[2].prevHash).toBe(created.audit[1].hash);
    expect(verifyAuditChain(ORG_A, "exe_open", created.audit).ok).toBe(true);

    // And what was persisted verifies, not merely what was returned.
    const stored = await repos.executions.findById("exe_open");
    expect(verifyAuditChain(ORG_A, "exe_open", stored!.audit).ok).toBe(true);
  });

  it("continues the chain across separate appends", async () => {
    const repos = repositoriesFor(ORG_A);
    await repos.executions.create(execution("exe_app", [entry(1)]));
    await repos.executions.appendAudit("exe_app", [entry(2)]);
    await repos.executions.appendAudit("exe_app", [entry(3), entry(4)]);

    const stored = await repos.executions.findById("exe_app");
    expect(stored!.audit).toHaveLength(4);
    const verdict = verifyAuditChain(ORG_A, "exe_app", stored!.audit);
    expect(verdict.ok, verdict.reason).toBe(true);
    for (let i = 1; i < stored!.audit.length; i++) {
      expect(stored!.audit[i].prevHash).toBe(stored!.audit[i - 1].hash);
    }
  });

  it("stays unbroken under concurrent appends and links every surviving entry", async () => {
    const repos = repositoriesFor(ORG_A);
    await repos.executions.create(execution("exe_race", [entry(0)]));

    await Promise.all(
      Array.from({ length: 40 }, (_, i) => repos.executions.appendAudit("exe_race", [entry(i)])),
    );

    const stored = await repos.executions.findById("exe_race");
    // The atomicity guarantee still holds: nothing was lost.
    expect(stored!.audit).toHaveLength(41);
    // And the chain is single and continuous — no fork from a stale snapshot.
    const verdict = verifyAuditChain(ORG_A, "exe_race", stored!.audit);
    expect(verdict.ok, verdict.reason).toBe(true);
  });

  it("detects a modified entry and names its position", async () => {
    const repos = repositoriesFor(ORG_A);
    await repos.executions.create(execution("exe_tamper", [entry(1), entry(2), entry(3)]));
    const stored = await repos.executions.findById("exe_tamper");

    const tampered = stored!.audit.map((e, i) =>
      i === 1 ? { ...e, detail: "quietly rewritten" } : e,
    );
    const verdict = verifyAuditChain(ORG_A, "exe_tamper", tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
    expect(verdict.reason).toContain("modified");
  });

  it("detects a removed entry", async () => {
    const repos = repositoriesFor(ORG_A);
    await repos.executions.create(execution("exe_cut", [entry(1), entry(2), entry(3)]));
    const stored = await repos.executions.findById("exe_cut");

    const withoutMiddle = [stored!.audit[0], stored!.audit[2]];
    const verdict = verifyAuditChain(ORG_A, "exe_cut", withoutMiddle);
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
  });

  it("detects reordering", async () => {
    const repos = repositoriesFor(ORG_A);
    await repos.executions.create(execution("exe_swap", [entry(1), entry(2), entry(3)]));
    const stored = await repos.executions.findById("exe_swap");

    const swapped = [stored!.audit[0], stored!.audit[2], stored!.audit[1]];
    const verdict = verifyAuditChain(ORG_A, "exe_swap", swapped);
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
  });

  it("detects an entry inserted with a forged link", async () => {
    const repos = repositoriesFor(ORG_A);
    await repos.executions.create(execution("exe_ins", [entry(1), entry(2)]));
    const stored = await repos.executions.findById("exe_ins");

    // An attacker who knows the algorithm can make their own entry self-consistent…
    const forged: AuditEntry = { ...entry(9), prevHash: stored!.audit[0].hash };
    forged.hash = auditEntryHash(stored!.audit[0].hash!, forged);
    // …but the entry that followed still points at the old hash, so the break shows.
    const verdict = verifyAuditChain(ORG_A, "exe_ins", [stored!.audit[0], forged, stored!.audit[1]]);
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(2);
  });

  it("refuses an entry that carries no hash instead of accepting it", async () => {
    const repos = repositoriesFor(ORG_A);
    await repos.executions.create(execution("exe_strip", [entry(1), entry(2)]));
    const stored = await repos.executions.findById("exe_strip");

    const stripped = stored!.audit.map((e, i) =>
      i === 1 ? { at: e.at, actor: e.actor, event: e.event } : e,
    );
    const verdict = verifyAuditChain(ORG_A, "exe_strip", stripped);
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
    expect(verdict.reason).toContain("no hash");
  });

  it("ignores a prevHash supplied by the caller rather than trusting it", async () => {
    const repos = repositoriesFor(ORG_A);
    await repos.executions.create(execution("exe_dictate", [entry(1)]));

    // A caller tries to dictate its own link, which would fork the chain if honoured.
    await repos.executions.appendAudit("exe_dictate", [
      { ...entry(2), prevHash: "f".repeat(64), hash: "e".repeat(64) },
    ]);

    const stored = await repos.executions.findById("exe_dictate");
    expect(stored!.audit[1].prevHash).toBe(stored!.audit[0].hash);
    expect(stored!.audit[1].hash).not.toBe("e".repeat(64));
    expect(verifyAuditChain(ORG_A, "exe_dictate", stored!.audit).ok).toBe(true);
  });

  describe("tenant awareness", () => {
    it("gives two tenants different hashes for an identical trail", async () => {
      const a = repositoriesFor(ORG_A);
      const b = repositoriesFor(ORG_B);
      const trail = [entry(1), entry(2)];

      const inA = await a.executions.create(execution("exe_same", trail));
      const inB = await b.executions.create(execution("exe_same", trail));

      // Same id, same entries, different tenant → different chain.
      expect(inA.audit[0].hash).not.toBe(inB.audit[0].hash);
      expect(verifyAuditChain(ORG_A, "exe_same", inA.audit).ok).toBe(true);
      expect(verifyAuditChain(ORG_B, "exe_same", inB.audit).ok).toBe(true);
    });

    it("refuses a trail transplanted from another tenant", async () => {
      const a = repositoriesFor(ORG_A);
      const inA = await a.executions.create(execution("exe_move", [entry(1), entry(2)]));

      // Lifting A's trail into B's ledger fails at the very first link.
      const verdict = verifyAuditChain(ORG_B, "exe_move", inA.audit);
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAt).toBe(0);
    });

    it("keeps each tenant's chain independent as both are appended to", async () => {
      const a = repositoriesFor(ORG_A);
      const b = repositoriesFor(ORG_B);
      await a.executions.create(execution("exe_par", [entry(1)]));
      await b.executions.create(execution("exe_par", [entry(1)]));

      for (let i = 2; i <= 6; i++) {
        await a.executions.appendAudit("exe_par", [entry(i)]);
        await b.executions.appendAudit("exe_par", [entry(i)]);
      }

      const storedA = await a.executions.findById("exe_par");
      const storedB = await b.executions.findById("exe_par");
      expect(storedA!.audit).toHaveLength(6);
      expect(storedB!.audit).toHaveLength(6);
      expect(verifyAuditChain(ORG_A, "exe_par", storedA!.audit).ok).toBe(true);
      expect(verifyAuditChain(ORG_B, "exe_par", storedB!.audit).ok).toBe(true);
      // Neither tenant's writes leaked into the other's chain.
      expect(storedA!.audit.map((e) => e.hash)).not.toEqual(storedB!.audit.map((e) => e.hash));
    });
  });
});
