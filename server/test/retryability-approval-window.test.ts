/**
 * Phase 6.5 — the advertised retryability and the enforced retryability must
 * agree about a LAPSED APPROVAL, not just about attempts.
 *
 * THE DEFECT
 * ----------
 * `server/gateway/retryability.ts` exists for one reason, stated in its own
 * header: the backend has several reasons to refuse a retry, and the console must
 * not re-derive them, because a rule written in two places eventually disagrees
 * with itself. `server/test/retryability.test.ts` pins that agreement for three
 * of them.
 *
 * Phase 5 added a fourth. `AgentGateway.retry()` began refusing an execution
 * whose gating approval had expired — a real replay window, since approving
 * rewrites `decision` to `"allow"` and the retry endpoint asks only for
 * `execute`. That guard went into the gateway alone. `retryabilityOf()` did not
 * know approvals existed.
 *
 * So the invariant broke in exactly the way it was built to prevent:
 * `GET /api/executions/:id` answered `retryable: true, reason: null` for a run
 * the endpoint met with a 409. The console showed an enabled button, the operator
 * clicked it, and got a refusal they had just been told would not happen. Every
 * existing test passed, because every existing test asked about attempts.
 *
 * WHY THE FIX IS A REQUIRED PARAMETER
 * -----------------------------------
 * `retryabilityOf(execution, gating)` — second argument mandatory. An optional
 * one would have let all five call sites keep compiling and keep being wrong,
 * which is how the drift happened in the first place. Making it required turned
 * the defect into five compiler errors.
 *
 * The tests below assert the agreement in BOTH directions, and separately assert
 * that the optimisation which skips the approval lookup cannot quietly produce a
 * wrong answer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { rawDb } from "../db";
import { MAX_TOOL_ATTEMPTS } from "../limits";
import {
  mayDependOnGatingApproval,
  NOT_LOOKED_UP,
  retryabilityOf,
} from "../gateway/retryability";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import type { Execution } from "@shared/types";

const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

interface Retryability {
  retryable: boolean;
  attempts: number;
  maxAttempts: number;
  attemptsRemaining: number;
  reason: string | null;
}

type ExecutionDto = Execution & { retry: Retryability };

interface AuditReply {
  events: { executionId: string | null; target: string | null }[];
}

interface ApprovalRecord {
  id: string;
  executionId: string | null;
  expiresAt?: string | null;
}

describe("retryability and the approval window", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  /** A refund over the org threshold: held, so it gets a real approval row. */
  async function heldRefund(target: string): Promise<{ executionId: string; approvalId: string }> {
    const res = await api.post("/api/executions", {
      agentId: "agt_billing",
      action: "refund",
      target,
      amount: 750,
      currency: "EUR",
    });
    expect(res.status).toBe(201);

    const audit = await api.get<AuditReply>("/api/audit", { auth: ROLE_KEYS.admin });
    const entry = audit.body.events.find((event) => event.target === target);
    expect(entry, `no audit entry for ${target}`).toBeDefined();
    const executionId = entry!.executionId as string;

    const approvals = await api.get<ApprovalRecord[]>("/api/approvals", {
      auth: ROLE_KEYS.approver,
    });
    const approval = approvals.body.find((a) => a.executionId === executionId);
    expect(approval, `no approval for ${executionId}`).toBeDefined();

    return { executionId, approvalId: approval!.id };
  }

  /**
   * Move a stored deadline into the past.
   *
   * Written straight to SQLite rather than through a fake clock, matching
   * `approval-expiry-e2e.test.ts`: the deadline is a stored string and the
   * production code reads it with `Date.parse`, so moving the string is the
   * honest simulation of time passing. `changes` is asserted because a fixture
   * that updated no rows would make every assertion below pass for the wrong
   * reason.
   */
  function closeTheWindow(approvalId: string): void {
    const past = new Date(Date.now() - 60_000).toISOString();
    const info = rawDb.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(past, approvalId);
    expect(info.changes).toBe(1);
  }

  /**
   * Approve, then force the run into `failed` with attempts left.
   *
   * That state is what makes the case interesting: on attempts alone the run is
   * plainly retryable, so `retryable: false` can only come from the window.
   */
  async function approvedThenFailed(target: string): Promise<{ executionId: string; approvalId: string }> {
    const { executionId, approvalId } = await heldRefund(target);
    // The approver identity comes from the credential, not the body — the route
    // refuses a supplied `approver` outright.
    const decision = await api.post(
      `/api/approvals/${approvalId}/approve`,
      {},
      { auth: ROLE_KEYS.approver },
    );
    expect(decision.status).toBe(200);

    await repositories.executions.update(executionId, { runState: "failed", attempts: 1 });
    return { executionId, approvalId };
  }

  it("advertises a lapsed approval as NOT retryable on the detail response", async () => {
    const { executionId, approvalId } = await approvedThenFailed("cus_window_detail");

    // Before the window closes: retryable, so the assertion after it closes is
    // measuring the window and not some unrelated refusal.
    const before = await api.get<ExecutionDto>(`/api/executions/${executionId}`);
    expect(before.status).toBe(200);
    expect(before.body.decision).toBe("allow");
    expect(before.body.runState).toBe("failed");
    expect(before.body.retry.retryable).toBe(true);
    expect(before.body.retry.reason).toBeNull();

    closeTheWindow(approvalId);

    const after = await api.get<ExecutionDto>(`/api/executions/${executionId}`);
    expect(after.body.retry.retryable).toBe(false);
    expect(after.body.retry.reason).toMatch(/expired/i);
    // Attempts are untouched: the refusal is about the authorisation, not the budget.
    expect(after.body.retry.attemptsRemaining).toBe(MAX_TOOL_ATTEMPTS - 1);
  });

  it("advertises it on the LIST response too, which is what the console renders", async () => {
    /*
     * Asserted separately from the detail response because they are now
     * different code paths: the list batches its approval lookups into one query
     * to avoid 300 round trips, and a batch that mapped an execution to the
     * wrong approval — or to none — would be invisible in the detail test.
     */
    const { executionId, approvalId } = await approvedThenFailed("cus_window_list");
    closeTheWindow(approvalId);

    const list = await api.get<ExecutionDto[]>("/api/executions");
    expect(list.status).toBe(200);
    const row = list.body.find((e) => e.id === executionId);
    expect(row, "execution missing from list").toBeDefined();
    expect(row!.retry.retryable).toBe(false);
    expect(row!.retry.reason).toMatch(/expired/i);
  });

  it("agrees with what the retry endpoint actually enforces, word for word", async () => {
    /*
     * The whole point. Not "both refuse" but "both refuse with the same
     * sentence", because an operator who reads one wording before clicking and a
     * different one after has been told the two layers are different systems.
     */
    const { executionId, approvalId } = await approvedThenFailed("cus_window_parity");
    closeTheWindow(approvalId);

    const advertised = await api.get<ExecutionDto>(`/api/executions/${executionId}`);
    expect(advertised.body.retry.retryable).toBe(false);

    const enforced = await api.post<{ error?: { message?: string } | string }>(
      `/api/executions/${executionId}/retry`,
      {},
      { auth: ROLE_KEYS.operator },
    );
    expect(enforced.status).toBe(409);

    const enforcedMessage = JSON.stringify(enforced.body);
    expect(enforcedMessage).toContain(advertised.body.retry.reason as string);
  });

  it("leaves an UNGATED failed run retryable — absence of an approval is not expiry", async () => {
    /*
     * The mirror case, and the one a careless fix breaks. `isExpired(null)` is
     * TRUE by design: an approval whose deadline cannot be read is treated as
     * closed. So collapsing "never gated" into "gated with no deadline" would
     * make every ALLOW execution in the product permanently un-retryable.
     *
     * A 75 EUR refund is under the threshold, so the engine clears it outright
     * and no approval row exists.
     */
    const res = await api.post<{ executionId: string | null }>("/api/executions", {
      agentId: "agt_billing",
      action: "refund",
      target: "cus_window_ungated",
      amount: 75,
      currency: "EUR",
    });
    expect(res.status).toBe(201);
    const executionId = res.body.executionId as string;

    const stored = await repositories.approvals.findByExecutionId(executionId);
    expect(stored, "this execution was supposed to be ungated").toBeUndefined();

    await repositories.executions.update(executionId, { runState: "failed", attempts: 1 });

    const detail = await api.get<ExecutionDto>(`/api/executions/${executionId}`);
    expect(detail.body.retry.retryable).toBe(true);
    expect(detail.body.retry.reason).toBeNull();

    const list = await api.get<ExecutionDto[]>("/api/executions");
    const row = list.body.find((e) => e.id === executionId);
    expect(row!.retry.retryable).toBe(true);
  });

  it("keeps the attempt ceiling ahead of the window, in both layers", async () => {
    /*
     * An execution can be both out of attempts and past its deadline. The two
     * layers must pick the SAME reason to report, or the console and the
     * endpoint print different sentences about one run. `retryabilityOf` orders
     * the window before the ceiling because `AgentGateway.retry()` does; this
     * pins the consequence rather than the ordering, so it survives a
     * refactor that keeps the behaviour.
     */
    const { executionId, approvalId } = await approvedThenFailed("cus_window_and_ceiling");
    await repositories.executions.update(executionId, {
      runState: "failed",
      attempts: MAX_TOOL_ATTEMPTS,
    });
    closeTheWindow(approvalId);

    const advertised = await api.get<ExecutionDto>(`/api/executions/${executionId}`);
    expect(advertised.body.retry.retryable).toBe(false);

    const enforced = await api.post(`/api/executions/${executionId}/retry`, {}, {
      auth: ROLE_KEYS.operator,
    });
    expect(enforced.status).toBe(409);
    expect(JSON.stringify(enforced.body)).toContain(advertised.body.retry.reason as string);
  });

  describe("the lookup-skipping optimisation cannot answer wrongly in silence", () => {
    /*
     * A list read does not query an approval for every row: only rows that can
     * actually reach the window check are looked up. That is sound, but it is
     * sound BECAUSE of the order of the checks inside `retryabilityOf` — an
     * optimisation whose correctness depends on statement order in another file.
     *
     * So the sentinel is loud. These are unit tests on the function, because the
     * behaviour being pinned is a programming error, not an HTTP response.
     */
    const base: Execution = {
      id: "exe_unit",
      agentId: "agt_billing",
      agentName: "Billing",
      action: "refund",
      target: "cus_unit",
      status: "completed",
      decision: "allow",
      reason: "unit",
      riskLevel: "low",
      requestedAt: new Date().toISOString(),
      audit: [],
      input: {},
      runState: "failed",
      attempts: 1,
    } as unknown as Execution;

    it("throws rather than guessing when the check is reached with NOT_LOOKED_UP", () => {
      expect(() => retryabilityOf(base, NOT_LOOKED_UP)).toThrow(/NOT_LOOKED_UP/);
    });

    it("returns an answer without the lookup when the check cannot be reached", () => {
      // A succeeded run is refused before the window is consulted, so the
      // sentinel is legitimate here and must NOT throw.
      const succeeded = { ...base, runState: "succeeded" } as Execution;
      expect(mayDependOnGatingApproval(succeeded)).toBe(false);
      const verdict = retryabilityOf(succeeded, NOT_LOOKED_UP);
      expect(verdict.retryable).toBe(false);
      expect(verdict.reason).toMatch(/succeeded/i);

      const blocked = { ...base, decision: "block" } as Execution;
      expect(mayDependOnGatingApproval(blocked)).toBe(false);
      expect(retryabilityOf(blocked, NOT_LOOKED_UP).reason).toMatch(/block/i);
    });

    it("agrees with the callers about which executions need a lookup", () => {
      /*
       * The predicate and the check order are two statements of one rule. If
       * `mayDependOnGatingApproval` says no but the function reaches the check,
       * the sentinel throws in production. This asserts they cannot diverge, for
       * every combination of the two fields that decide it.
       */
      const decisions = ["allow", "block", "approval_required"] as const;
      const runStates = ["pending", "succeeded", "failed", "skipped"] as const;

      for (const decision of decisions) {
        for (const runState of runStates) {
          const execution = { ...base, decision, runState } as unknown as Execution;
          const predicted = mayDependOnGatingApproval(execution);
          let reached = false;
          try {
            retryabilityOf(execution, NOT_LOOKED_UP);
          } catch {
            reached = true;
          }
          expect(reached, `decision=${decision} runState=${runState}`).toBe(predicted);
        }
      }
    });
  });

  describe("batch expiry lookup", () => {
    it("distinguishes 'never gated' from 'gated with no deadline'", async () => {
      /*
       * The map omits an execution with no approval and includes one whose
       * `expires_at` is NULL with the value `null`. Those are different facts
       * and `isExpired` treats them oppositely, so a Map<string, string> with a
       * default would be a security-relevant bug rather than a style choice.
       */
      const { executionId, approvalId } = await heldRefund("cus_batch_semantics");
      const info = rawDb.prepare("UPDATE approvals SET expires_at = NULL WHERE id = ?").run(approvalId);
      expect(info.changes).toBe(1);

      const map = await repositories.approvals.findGatingExpiries([executionId, "exe_does_not_exist"]);
      expect(map.has(executionId)).toBe(true);
      expect(map.get(executionId)).toBeNull();
      expect(map.has("exe_does_not_exist")).toBe(false);
    });

    it("returns the same deadline the single-row read does", async () => {
      // Two implementations of one question; they are only useful if they agree.
      const { executionId, approvalId } = await heldRefund("cus_batch_parity");
      closeTheWindow(approvalId);

      const single = await repositories.approvals.findByExecutionId(executionId);
      const batch = await repositories.approvals.findGatingExpiries([executionId]);
      expect(batch.get(executionId)).toBe(single?.expiresAt ?? null);
    });

    it("is empty for an empty request and does not query", async () => {
      const map = await repositories.approvals.findGatingExpiries([]);
      expect(map.size).toBe(0);
    });

    it("does not leak another tenant's approvals", async () => {
      /*
       * A batch read takes a list of ids from the caller, which is the shape
       * that invites an unscoped `WHERE id IN (...)`. Asked for an execution it
       * does not own, the default tenant's repository must answer with nothing.
       */
      const rival = repositoriesFor(
        (await import("@shared/tenancy")).organizationId("org_rival_corp"),
      );
      const { executionId } = await heldRefund("cus_batch_isolation");

      const leaked = await rival.approvals.findGatingExpiries([executionId]);
      expect(leaked.has(executionId)).toBe(false);
    });
  });
});
