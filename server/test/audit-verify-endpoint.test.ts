/**
 * P6 — `GET /api/executions/:id/audit/verify`, exercised through HTTP.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `audit-hash-chain.test.ts`
 * --------------------------------------------------------
 * That file already proves the chaining rule: `verifyAuditChain` localises an edit,
 * a deletion, an insertion and a reorder. It proves it by calling the function.
 *
 * A verifier nobody can reach is not a control. What is unproven until here is the
 * route: that it is authenticated, that it is tenant-scoped, that it reads the trail
 * as actually stored rather than a copy the test built, and that its verdict survives
 * the trip through JSON. So every case below tampers with the DATABASE and then asks
 * the HTTP endpoint, which is the only path an operator or an auditor has.
 *
 * ONE CASE HERE ASSERTS A WEAKNESS ON PURPOSE
 * -------------------------------------------
 * "tail truncation is not detected" is a passing test that the chain does NOT catch
 * something. It is here because the route's own documentation makes that claim, and a
 * documented limitation that is never executed is just a sentence — it could be wrong
 * in either direction, and the flattering direction is the one nobody checks. If a
 * later phase adds tail anchoring, this test fails and the claim gets corrected
 * instead of quietly outliving the code.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "../db";
import {
  OTHER_ORG_KEYS,
  ROLE_KEYS,
  startTestServer,
  type TestClient,
} from "./harness";
import { auditEntryHash } from "../audit-chain";
import type { AuditEntry } from "@shared/types";

interface VerifyBody {
  executionId: string;
  ok: boolean;
  brokenAt: number | null;
  reason: string;
  entries: number;
  headHash: string;
  scope: string;
}

/** Reads the trail exactly as SQLite holds it, so a test tampers with the real bytes. */
function storedAudit(executionId: string): AuditEntry[] {
  const row = rawDb
    .prepare(`SELECT audit FROM executions WHERE id = ?`)
    .get(executionId) as { audit: string | null } | undefined;
  return JSON.parse(row?.audit ?? "[]") as AuditEntry[];
}

function writeAudit(executionId: string, entries: AuditEntry[]): void {
  rawDb
    .prepare(`UPDATE executions SET audit = ? WHERE id = ?`)
    .run(JSON.stringify(entries), executionId);
}

describe("P6 — GET /api/executions/:id/audit/verify", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  /**
   * Creates a real execution through the real route, so its trail is written by the
   * production write path and not by this file. `target` is unique per case because
   * the suite shares one database.
   */
  async function realExecution(target: string): Promise<string> {
    const created = await api.post<{ executionId?: string; execution?: { id: string } }>(
      "/api/executions",
      { agentId: "agt_billing", action: "refund", target, amount: 75, currency: "EUR" },
    );
    expect(created.status).toBe(201);
    const id = created.body.executionId ?? created.body.execution?.id;
    expect(typeof id).toBe("string");
    return id as string;
  }

  it("verifies an untouched trail written by the production path", async () => {
    const id = await realExecution("cus_verify_clean");

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.brokenAt).toBeNull();
    expect(res.body.executionId).toBe(id);
    /*
     * Asserted as "more than zero" rather than an exact count. The number of audit
     * entries a decision writes is the gateway's business and changes when the state
     * machine gains a step; pinning it here would turn this file into a tripwire for
     * unrelated work. What matters is that a real run produces a real trail and it
     * verifies.
     */
    expect(res.body.entries).toBeGreaterThan(0);
    // sha256, hex. A shorter or non-hex value means the chain is not what it claims.
    expect(res.body.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.scope).toContain("not externally anchored");
  });

  it("reports the head as the hash of the last stored entry, not a recomputation", async () => {
    /*
     * The point of returning `headHash` is that an operator can record it off-box.
     * That is only useful if it is the value the NEXT entry will point at — i.e. the
     * stored hash of the current last entry. If the route recomputed it from content
     * it would still look like a hash and would diverge silently from the writer.
     */
    const id = await realExecution("cus_verify_head");
    const entries = storedAudit(id);
    expect(entries.length).toBeGreaterThan(0);

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.body.headHash).toBe(entries[entries.length - 1]?.hash);
  });

  it("detects an entry edited in place, and says which one", async () => {
    const id = await realExecution("cus_verify_edited");
    const entries = storedAudit(id);
    expect(entries.length).toBeGreaterThan(0);

    // The kind of edit somebody makes to hide what happened: rewrite the detail,
    // leave the hashes alone.
    const target = entries.length - 1;
    entries[target] = { ...entries[target]!, detail: "nothing to see here" };
    writeAudit(id, entries);

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAt).toBe(target);
    expect(res.body.reason).toContain("modified");
  });

  it("detects a rewritten prevHash even when the entry re-hashes consistently", async () => {
    /*
     * The case that separates a chain from a checksum, and the one an attacker
     * with database access would actually attempt.
     *
     * The naive tamper — edit the content, leave the hashes — is caught by
     * recomputing the entry's own hash, and is already covered above. This one is
     * harder: the entry's `prevHash` is repointed at a DIFFERENT real hash from
     * the same trail, and then the entry's own `hash` is RECOMPUTED so it is
     * perfectly self-consistent. Every entry now hashes to exactly what it claims
     * to hash to. A verifier that only asked "does each entry's hash match its
     * own content?" would return ok:true on a trail whose order has been
     * rewritten.
     *
     * What must catch it is the link check: entry i's `prevHash` has to equal
     * entry i-1's stored `hash`, and repointing breaks that regardless of how
     * consistently the entry re-hashes itself.
     */
    const id = await realExecution("cus_verify_prevhash");
    const entries = storedAudit(id);
    // Needs at least three entries so there is a wrong-but-real hash to point at.
    expect(entries.length).toBeGreaterThanOrEqual(3);

    const victim = entries.length - 1;
    const wrongButReal = entries[victim - 2]!.hash;
    // Narrowed rather than asserted with `!`: an unhashed entry here would mean
    // the fixture is not what this test needs, and should fail loudly.
    expect(wrongButReal).toMatch(/^[0-9a-f]{64}$/);
    if (wrongButReal === undefined) throw new Error("fixture entry carries no hash");
    expect(wrongButReal).not.toBe(entries[victim - 1]!.hash);

    const repointed: AuditEntry = { ...entries[victim]!, prevHash: wrongButReal };
    // Re-hash so the forgery is internally consistent. This is the whole point:
    // if this test passed without this line it would prove much less.
    repointed.hash = auditEntryHash(wrongButReal, repointed);
    expect(repointed.hash).not.toBe(entries[victim]!.hash);
    entries[victim] = repointed;
    writeAudit(id, entries);

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAt).toBe(victim);
    // The reason must name the link, not the content: the content is untouched.
    expect(res.body.reason).toContain("points at");
  });

  it("detects a rewritten prevHash that points at a hash from nowhere", async () => {
    /*
     * The same attack without the courtesy of a plausible source hash. Kept
     * separate because a verifier could conceivably special-case "prevHash is a
     * hash I have seen in this trail" and still be wrong; this one pins the
     * simpler half so both are covered explicitly rather than assumed.
     */
    const id = await realExecution("cus_verify_prevhash_alien");
    const entries = storedAudit(id);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const victim = entries.length - 1;
    const alien = "f".repeat(64);
    const repointed: AuditEntry = { ...entries[victim]!, prevHash: alien };
    repointed.hash = auditEntryHash(alien, repointed);
    entries[victim] = repointed;
    writeAudit(id, entries);

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAt).toBe(victim);
    expect(res.body.reason).toContain("points at");
  });

  it("detects an entry removed from the middle of the trail", async () => {
    const id = await realExecution("cus_verify_deleted");
    const entries = storedAudit(id);
    if (entries.length < 3) {
      /*
       * Not silently skipped, and not made to pass by shortening the assertion: if a
       * single decision stops writing three entries, the deletion case has to be
       * built differently and somebody should have to look at it.
       */
      throw new Error(
        `this case needs a trail of at least 3 entries; the run produced ${entries.length}`,
      );
    }

    const removed = 1;
    writeAudit(id, entries.filter((_, i) => i !== removed));

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.body.ok).toBe(false);
    // The break surfaces at the entry that now follows a hash the chain never reached.
    expect(res.body.brokenAt).toBe(removed);
    expect(res.body.reason).toContain("points at");
  });

  it("detects a reordered trail", async () => {
    const id = await realExecution("cus_verify_reordered");
    const entries = storedAudit(id);
    if (entries.length < 2) {
      throw new Error(`this case needs at least 2 entries; the run produced ${entries.length}`);
    }

    const swapped = [...entries];
    const first = swapped[0]!;
    swapped[0] = swapped[1]!;
    swapped[1] = first;
    writeAudit(id, swapped);

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAt).toBe(0);
  });

  it("detects an entry inserted in the middle", async () => {
    const id = await realExecution("cus_verify_inserted");
    const entries = storedAudit(id);
    expect(entries.length).toBeGreaterThan(0);

    // A forged approval, hashed to nothing in particular — an attacker who does not
    // hold the previous hash cannot produce one that links.
    const forged: AuditEntry = {
      at: "2026-01-01T00:00:00.000Z",
      actor: "someone",
      event: "Approval granted",
      detail: "forged",
      prevHash: "0".repeat(64),
      hash: "1".repeat(64),
    };
    writeAudit(id, [entries[0]!, forged, ...entries.slice(1)]);

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAt).toBe(1);
  });

  it("reports an unhashed entry as broken rather than accepting it", async () => {
    /*
     * The failure mode that makes a hash chain decorative: an entry with no hash at
     * all, which is what stripping the columns leaves behind. Treating it as valid
     * would mean an attacker's cheapest move is to delete the evidence of chaining
     * rather than forge it.
     */
    const id = await realExecution("cus_verify_unhashed");
    const entries = storedAudit(id);
    const stripped = entries.map((e) => ({ at: e.at, actor: e.actor, event: e.event }));
    writeAudit(id, stripped as AuditEntry[]);

    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAt).toBe(0);
    expect(res.body.reason).toContain("no hash");
  });

  it("does NOT detect truncation of the trail's tail — the documented limitation, measured", async () => {
    /*
     * A passing test for something the control does not do. See the file header.
     * Dropping the last entries leaves a prefix that verifies perfectly, because a
     * chain only links backwards and there is nothing left to point at the missing
     * part. The endpoint therefore answers `ok: true` on a trail that lost its
     * ending, and the response's own `scope` field says so.
     */
    const id = await realExecution("cus_verify_truncated");
    const entries = storedAudit(id);
    if (entries.length < 2) {
      throw new Error(`this case needs at least 2 entries; the run produced ${entries.length}`);
    }

    const before = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    const headBefore = before.body.headHash;

    writeAudit(id, entries.slice(0, -1));

    const after = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
    expect(after.body.ok).toBe(true);
    expect(after.body.entries).toBe(entries.length - 1);
    // The one signal that survives: the head moved. That is why it is returned.
    expect(after.body.headHash).not.toBe(headBefore);
    expect(after.body.scope).toContain("Tail truncation is not detectable");
  });

  it("answers 404 for an execution belonging to another organisation", async () => {
    /*
     * Not 403. A foreign id must read as absent, or the status itself confirms that
     * the other tenant holds that execution — the rule the rest of the API follows
     * for cross-tenant reads.
     */
    const id = await realExecution("cus_verify_tenant");

    const res = await api.get<{ error: string }>(`/api/executions/${id}/audit/verify`, {
      auth: OTHER_ORG_KEYS.admin,
    });
    expect(res.status).toBe(404);
  });

  it("answers 404 for an execution that does not exist, with the same body", async () => {
    const res = await api.get<{ error: string }>(
      "/api/executions/exe_definitely_not_real/audit/verify",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("requires a credential", async () => {
    const id = await realExecution("cus_verify_anon");
    const res = await api.get(`/api/executions/${id}/audit/verify`, { auth: null });
    expect(res.status).toBe(401);
  });

  it("REGRESSION — every insert path chains from entry 0, not just the one create() uses", async () => {
    /*
     * The defect this endpoint found on its first run, pinned per write path.
     *
     * Three code paths insert an execution and only `create()` chained the audit
     * entries it was handed; the other two — `insertExecutionAndApproval` and
     * `decideAndPersistTx` — are the ones the DecisionService and the Gateway use,
     * so every real decision was stored with "Action requested", "Policy evaluated"
     * and "Decision made" unhashed. `appendAudit` then linked the first tool entry
     * to the GENESIS hash, because `headHash` falls back to genesis when the last
     * stored entry has none — so the chain restarted and verified cleanly from
     * there. A trail missing hashes on its verdict looked healthy.
     *
     * Measured evidence of the original trail is in
     * `notes/P6-FINDING-audit-chain-gap.md`.
     *
     * Asserted per route rather than once, because the paths are genuinely
     * different code and fixing one would leave the other silent. `entry 0 has a
     * hash` is checked directly against the database, not through the verifier:
     * `ok: true` alone could not distinguish "chained" from "the verifier grew
     * lenient".
     */
    const cases: { label: string; run: () => Promise<string> }[] = [
      {
        label: "POST /api/executions (ALLOW — decideAndPersist)",
        run: () => realExecution("cus_chain_allow"),
      },
      {
        label: "POST /api/execute (ALLOW — gateway)",
        run: async () => {
          const res = await api.post<{ executionId?: string; execution?: { id: string } }>(
            "/api/execute",
            { agentId: "agt_billing", action: "refund", target: "cus_chain_exec" },
          );
          expect(res.status).toBe(200);
          return (res.body.executionId ?? res.body.execution?.id) as string;
        },
      },
      {
        label: "POST /api/executions (APPROVAL_REQUIRED — insertExecutionAndApproval)",
        run: async () => {
          // Over the 500 threshold, so this run creates an Approval alongside the
          // Execution and therefore travels the atomic two-row insert.
          const res = await api.post<{ executionId?: string; execution?: { id: string } }>(
            "/api/executions",
            {
              agentId: "agt_billing",
              action: "refund",
              target: "cus_chain_approval",
              amount: 750,
              currency: "EUR",
            },
          );
          expect(res.status).toBe(201);
          return (res.body.executionId ?? res.body.execution?.id) as string;
        },
      },
    ];

    for (const { label, run } of cases) {
      const id = await run();
      expect(typeof id, label).toBe("string");

      const entries = storedAudit(id);
      expect(entries.length, label).toBeGreaterThan(0);
      // The assertion the original defect fails: entry 0 is hashed at all.
      expect(entries[0]?.hash, label).toMatch(/^[0-9a-f]{64}$/);
      expect(entries[0]?.prevHash, label).toMatch(/^[0-9a-f]{64}$/);
      // And no later entry is unhashed either, which is what let the gap hide.
      for (const [i, e] of entries.entries()) {
        expect(e.hash, `${label} entry ${i}`).toMatch(/^[0-9a-f]{64}$/);
      }

      const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`);
      expect(res.body.ok, label).toBe(true);
      expect(res.body.entries, label).toBe(entries.length);
    }
  });

  it("is readable by a viewer — verifying is a read, not an action", async () => {
    /*
     * Deliberately available to the narrowest role. An auditor whose job is to check
     * the trail should not need a credential that can also execute; requiring
     * `manage` here would push reviewers towards admin keys, which is worse for
     * security than the read it protects.
     */
    const id = await realExecution("cus_verify_viewer");
    const res = await api.get<VerifyBody>(`/api/executions/${id}/audit/verify`, {
      auth: ROLE_KEYS.viewer,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
