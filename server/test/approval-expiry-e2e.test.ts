/**
 * An expired authorisation, end to end, against a real downstream.
 *
 *   test (MCP client) ──▶ Oathrion gateway ──▶ local MCP server ──▶ mock HTTP downstream
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT TESTS
 * --------------------------------------------------
 * `approval-ttl.test.ts` proves the conditional UPDATE refuses to claim a
 * past-deadline row. That is the barrier, but it is a claim about a database
 * statement. It does not by itself prove that the *system* declines to act: the
 * gateway could refuse the write and dispatch anyway, and every assertion in
 * that file would still pass.
 *
 * So the assertions here are about a separate HTTP server's recollection. "The
 * action was not released" becomes "no request ever arrived at the downstream",
 * and for that to be wrong a socket would have to have been opened, served and
 * then forgotten by the process that served it.
 *
 * The downstream applies no checks of its own — it refunds any amount and
 * deletes any customer (see its module comment) — so when nothing arrives the
 * only available explanation is that Oathrion refused to forward it.
 *
 * HOW TIME IS ADVANCED, AND WHY IT IS NOT A FAKE CLOCK
 * ---------------------------------------------------
 * These tests move the *deadline* into the past with one raw `UPDATE`, instead
 * of faking `Date`. The guard compares a stored deadline against the current
 * instant, so a deadline in the past and a clock in the future are the same
 * comparison; the row ends up in exactly the state the passage of an hour would
 * have produced.
 *
 * The alternative was rejected on purpose. Faking the process clock forward by an
 * hour also moves session and API-key expiry, so a test that failed would leave
 * two candidate explanations — the approval expired, or the credential did — and
 * a test with two explanations proves neither.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { rawDb } from "../db";
import { repositoriesFor } from "../repositories";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";

const REFUND_PATH = "/mock/refund";

/** Over the 500 EUR threshold in `pol_refund_approval`, so the engine holds it. */
const HELD_AMOUNT = 750;

/** Direct repository access, used only to assert preconditions the API does not expose. */
const repos = repositoriesFor(DEFAULT_ORGANIZATION_ID);

interface CallReply {
  result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
  error?: { code: number; message: string };
}

/** `GET /api/audit` returns a page of flattened audit events. */
interface AuditReply {
  total: number;
  events: Array<Record<string, unknown>>;
}

interface ApprovalRecord {
  id: string;
  status: string;
  executionId?: string | null;
  expiresAt?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string;
}

interface ExecutionRecord {
  id: string;
  decision: string;
  status: string;
  runState: string | null;
  audit?: Array<{ actor: string; event: string; detail?: string }>;
}

describe("an approval that outlived its window cannot release its action", () => {
  let api: TestClient;
  let mock: MockDownstream;
  let mcp: LocalMcpServer;
  let previousUrl: string | undefined;

  async function callRefund(target: string, amount: number = HELD_AMOUNT) {
    return api.post<CallReply>(
      "/api/mcp",
      {
        jsonrpc: "2.0",
        id: `expiry-${target}-${Date.now()}`,
        method: "tools/call",
        params: {
          name: "refund",
          arguments: { target, amount, currency: "EUR" },
          _meta: {
            [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
            [META_KEYS.clientCapabilities]: {},
          },
        },
      },
      {
        auth: ROLE_KEYS.operator,
        headers: {
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "refund",
          "X-Oathrion-Agent-Id": "agt_billing",
        },
      },
    );
  }

  /** Read the downstream's own record back over HTTP, not from the in-process object. */
  async function receivedOverHttp(): Promise<Array<{ path: string }>> {
    const response = await fetch(`${mock.url}/mock/received`);
    const payload = (await response.json()) as { calls: Array<{ path: string }> };
    return payload.calls;
  }

  /**
   * The pending approval raised for THIS target, resolved through the audit
   * trail rather than by recency. Picking "the most recent pending one" would
   * make these tests order-dependent and could expire or approve a different
   * scenario's request — precisely the confusion an approval queue must never
   * have, and one that would silently invalidate the downstream assertions.
   */
  async function approvalFor(target: string): Promise<ApprovalRecord> {
    const list = await api.get<ApprovalRecord[]>("/api/approvals", { auth: ROLE_KEYS.approver });
    expect(list.status).toBe(200);
    const audit = await api.get<AuditReply>("/api/audit", { auth: ROLE_KEYS.admin });
    const executionIds = new Set(
      audit.body.events
        .filter((event) => event.target === target)
        .map((event) => event.executionId as string),
    );
    const matched = list.body.filter(
      (approval) =>
        approval.status === "pending" &&
        approval.executionId != null &&
        executionIds.has(approval.executionId),
    );
    expect(matched).toHaveLength(1);
    return matched[0]!;
  }

  /** The execution id Oathrion recorded for a given target, read from the audit trail. */
  async function executionIdFor(target: string): Promise<string> {
    const audit = await api.get<AuditReply>("/api/audit", { auth: ROLE_KEYS.admin });
    const entry = audit.body.events.find((event) => event.target === target);
    expect(entry).toBeDefined();
    return entry!.executionId as string;
  }

  /** Move a stored deadline into the past — see the file note on why not a fake clock. */
  function closeTheWindow(approvalId: string): void {
    const past = new Date(Date.now() - 60_000).toISOString();
    const info = rawDb
      .prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
      .run(past, approvalId);
    // Asserted rather than assumed: a fixture that silently updated no rows
    // would make every assertion below pass for the wrong reason.
    expect(info.changes).toBe(1);
  }

  /** Raise a held refund and close its window. Returns the approval and its execution id. */
  async function heldThenExpired(
    target: string,
  ): Promise<{ approval: ApprovalRecord; executionId: string }> {
    const call = await callRefund(target);
    expect(call.status).toBe(200);
    const approval = await approvalFor(target);
    closeTheWindow(approval.id);
    return { approval, executionId: approval.executionId as string };
  }

  beforeAll(async () => {
    mock = await startMockDownstream();
    mcp = await startLocalMcpServer(mock.url);
    previousUrl = process.env.OATHRION_LOCAL_MCP_URL;
    process.env.OATHRION_LOCAL_MCP_URL = mcp.url;
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
    await mcp.close();
    await mock.close();
    if (previousUrl === undefined) delete process.env.OATHRION_LOCAL_MCP_URL;
    else process.env.OATHRION_LOCAL_MCP_URL = previousUrl;
  });

  beforeEach(async () => {
    mock.reset();
    mcp.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe("the approve path", () => {
    it("holds the action before any deadline is involved", async () => {
      // The precondition every later assertion depends on. If the engine were not
      // holding this refund, "nothing reached the downstream" would prove nothing
      // about expiry.
      const call = await callRefund("cus_held");
      expect(call.status).toBe(200);
      expect(call.body.result?.structuredContent?.decision).toBe("APPROVAL_REQUIRED");
      expect(await receivedOverHttp()).toHaveLength(0);
    });

    it("refuses a late approve with 409 and an explanation", async () => {
      const { approval } = await heldThenExpired("cus_late_409");

      const resolve = await api.post<{ error: string }>(
        `/api/approvals/${approval.id}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      );

      // 409, not 200-with-a-flag: a client that only reads the status code must
      // not be able to conclude the action was approved.
      expect(resolve.status).toBe(409);
      expect(resolve.body.error).toMatch(/window has closed/i);
    });

    it("sends nothing to the downstream when the approve arrives late", async () => {
      // The assertion this whole file is built around.
      const { approval } = await heldThenExpired("cus_late_nothing");

      await api.post(`/api/approvals/${approval.id}/approve`, {}, { auth: ROLE_KEYS.approver });

      expect(await receivedOverHttp()).toHaveLength(0);
      // The local MCP server was never even asked, so the refusal happened at
      // Oathrion and not at some later hop that might have had its own reasons.
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("refuses a late reject too, without naming a human", async () => {
      // A rejection after expiry changes no outcome, but recording it would put an
      // approver's name against a request the clock had already settled.
      const { approval } = await heldThenExpired("cus_late_reject");

      const resolve = await api.post(
        `/api/approvals/${approval.id}/reject`,
        {},
        { auth: ROLE_KEYS.approver },
      );
      expect(resolve.status).toBe(409);

      const stored = await api.get<ApprovalRecord>(`/api/approvals/${approval.id}`, {
        auth: ROLE_KEYS.approver,
      });
      expect(stored.body.status).toBe("expired");
      expect(stored.body.resolvedBy).toBeFalsy();
    });

    it("records the request as expired, with a timestamp and no approver", async () => {
      const { approval } = await heldThenExpired("cus_late_record");
      await api.post(`/api/approvals/${approval.id}/approve`, {}, { auth: ROLE_KEYS.approver });

      const stored = await api.get<ApprovalRecord>(`/api/approvals/${approval.id}`, {
        auth: ROLE_KEYS.approver,
      });
      expect(stored.body.status).toBe("expired");
      expect(stored.body.resolvedAt).toBeTruthy();
      // Nobody decided this. A name here would be the trail claiming a human
      // refused something no human looked at.
      expect(stored.body.resolvedBy).toBeFalsy();
    });

    it("closes the execution so no later claim can pick the action up", async () => {
      // The part that makes expiry a barrier rather than a label. An expired
      // approval whose execution stayed in a claimable run state would still be
      // dispatchable by anything that claims work.
      const { approval, executionId } = await heldThenExpired("cus_late_closed");
      await api.post(`/api/approvals/${approval.id}/approve`, {}, { auth: ROLE_KEYS.approver });

      const execution = await api.get<ExecutionRecord>(`/api/executions/${executionId}`, {
        auth: ROLE_KEYS.operator,
      });
      expect(execution.body.decision).toBe("block");
      expect(execution.body.runState).toBe("skipped");
    });

    it("writes an audit entry attributed to the system, not to the late approver", async () => {
      const { approval, executionId } = await heldThenExpired("cus_late_audit");
      await api.post(`/api/approvals/${approval.id}/approve`, {}, { auth: ROLE_KEYS.approver });

      const execution = await api.get<ExecutionRecord>(`/api/executions/${executionId}`, {
        auth: ROLE_KEYS.operator,
      });
      const entry = (execution.body.audit ?? []).find((e) => e.event === "Approval expired");
      expect(entry).toBeDefined();
      expect(entry?.actor).toBe("Oathrion");
      // The trail must not contain "Approval granted" for a request that was
      // never granted.
      expect((execution.body.audit ?? []).some((e) => e.event === "Approval granted")).toBe(false);
    });

    it("does not double-record when two late approvers arrive", async () => {
      const { approval, executionId } = await heldThenExpired("cus_late_twice");

      await api.post(`/api/approvals/${approval.id}/approve`, {}, { auth: ROLE_KEYS.approver });
      await api.post(`/api/approvals/${approval.id}/approve`, {}, { auth: ROLE_KEYS.approver });

      const execution = await api.get<ExecutionRecord>(`/api/executions/${executionId}`, {
        auth: ROLE_KEYS.operator,
      });
      const entries = (execution.body.audit ?? []).filter((e) => e.event === "Approval expired");
      expect(entries).toHaveLength(1);
      expect(await receivedOverHttp()).toHaveLength(0);
    });

    it("still releases an action approved inside its window", async () => {
      // The control. Without it, every assertion above would also pass if expiry
      // had simply broken approvals altogether.
      const call = await callRefund("cus_in_window");
      expect(call.status).toBe(200);
      const approval = await approvalFor("cus_in_window");

      const resolve = await api.post(
        `/api/approvals/${approval.id}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      );
      expect(resolve.status).toBe(200);

      const calls = await receivedOverHttp();
      expect(calls).toHaveLength(1);
      expect(calls[0].path).toBe(REFUND_PATH);
    });
  });

  describe("the retry path", () => {
    it("refuses to retry an action whose authorisation has lapsed", async () => {
      /*
       * The replay window this phase closes. Approving rewrites the execution's
       * decision to "allow", which is exactly what retry requires, and the retry
       * endpoint asks only for `execute` — not `approve`. So a failed high-value
       * action was re-dispatchable indefinitely, by a caller with no approval
       * rights, on the strength of a decision made in a context that no longer
       * existed.
       *
       * Approve inside the window (so the execution really is "allow"), then close
       * the window and attempt the replay.
       */
      const call = await callRefund("cus_replay");
      expect(call.status).toBe(200);
      const approval = await approvalFor("cus_replay");
      const executionId = approval.executionId as string;

      const resolve = await api.post(
        `/api/approvals/${approval.id}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      );
      expect(resolve.status).toBe(200);
      // The legitimate release happened, so the downstream has exactly one call.
      expect(await receivedOverHttp()).toHaveLength(1);

      closeTheWindow(approval.id);
      mock.reset();

      const retry = await api.post<{ error: string }>(
        `/api/executions/${executionId}/retry`,
        {},
        { auth: ROLE_KEYS.operator },
      );

      // 409 whatever the run state: the authorisation is gone, so there is nothing
      // left to retry against.
      expect(retry.status).toBe(409);
      // And, the part that matters, no second real-world side effect.
      expect(await receivedOverHttp()).toHaveLength(0);
    });

    it("names the lapsed authorisation as the reason when the run had failed", async () => {
      // Distinguishes the new refusal from the pre-existing ones. An operator who
      // cannot tell "not retryable" from "authorisation expired" has nothing to
      // act on.
      const call = await callRefund("cus_replay_failed");
      const approval = await approvalFor("cus_replay_failed");
      const executionId = approval.executionId as string;
      expect(call.status).toBe(200);

      await api.post(`/api/approvals/${approval.id}/approve`, {}, { auth: ROLE_KEYS.approver });
      closeTheWindow(approval.id);
      // Force the run into `failed`, the one state a retry is otherwise allowed
      // from, so the expiry guard is the only thing that can refuse this call.
      rawDb
        .prepare("UPDATE executions SET run_state = 'failed', last_error = 'transient' WHERE id = ?")
        .run(executionId);
      mock.reset();

      const retry = await api.post<{ error: string }>(
        `/api/executions/${executionId}/retry`,
        {},
        { auth: ROLE_KEYS.operator },
      );

      expect(retry.status).toBe(409);
      expect(retry.body.error).toMatch(/expired/i);
      expect(await receivedOverHttp()).toHaveLength(0);
    });

    it("leaves retries of never-gated actions alone", async () => {
      /*
       * The scope control. An action the engine cleared outright never had an
       * approval window, so there is nothing to have closed and the new guard must
       * not touch it. Without this test the guard could be refusing every retry in
       * the system and the assertions above would not notice.
       */
      const allowed = await callRefund("cus_never_gated", 75);
      expect(allowed.status).toBe(200);
      expect(allowed.body.result?.structuredContent?.decision).toBe("ALLOW");
      const calls = await receivedOverHttp();
      expect(calls).toHaveLength(1);

      // Located through the audit trail, the same way the gated approvals are, so
      // this test does not depend on the shape of the executions listing.
      const executionId = await executionIdFor("cus_never_gated");
      // Nothing gated it, which is the precondition under test.
      expect(await repos.approvals.findByExecutionId(executionId)).toBeUndefined();

      // `failed` is the one run state a retry is otherwise permitted from, so the
      // new guard is the only thing that could refuse this call.
      rawDb
        .prepare("UPDATE executions SET run_state = 'failed', last_error = 'transient' WHERE id = ?")
        .run(executionId);
      mock.reset();

      const retry = await api.post(
        `/api/executions/${executionId}/retry`,
        {},
        { auth: ROLE_KEYS.operator },
      );
      // Not refused with 409 by the expiry guard — this action was never gated.
      expect(retry.status).toBe(200);
    });
  });

  describe("the sweep", () => {
    it("expires past-deadline requests and reports how many", async () => {
      const { approval, executionId } = await heldThenExpired("cus_sweep");

      const sweep = await api.post<{ expired: string[]; count: number }>(
        "/api/approvals/expire",
        {},
        { auth: ROLE_KEYS.admin },
      );

      expect(sweep.status).toBe(200);
      expect(sweep.body.expired).toContain(approval.id);
      expect(sweep.body.count).toBeGreaterThanOrEqual(1);

      const execution = await api.get<ExecutionRecord>(`/api/executions/${executionId}`, {
        auth: ROLE_KEYS.operator,
      });
      // The sweep closes the execution exactly as the late-approve path does.
      expect(execution.body.runState).toBe("skipped");
      expect(execution.body.decision).toBe("block");
    });

    it("sends nothing downstream while sweeping", async () => {
      await heldThenExpired("cus_sweep_quiet");
      await api.post("/api/approvals/expire", {}, { auth: ROLE_KEYS.admin });
      expect(await receivedOverHttp()).toHaveLength(0);
    });

    it("leaves a live request pending", async () => {
      const call = await callRefund("cus_sweep_live");
      expect(call.status).toBe(200);
      const live = await approvalFor("cus_sweep_live");

      await api.post("/api/approvals/expire", {}, { auth: ROLE_KEYS.admin });

      const stored = await api.get<ApprovalRecord>(`/api/approvals/${live.id}`, {
        auth: ROLE_KEYS.approver,
      });
      expect(stored.body.status).toBe("pending");
    });

    it("is refused to a caller without the manage capability", async () => {
      // Sweeping is housekeeping, so it takes `manage`. It must not be reachable
      // by an operator, and it must not require `approve` either — the capability
      // that authorises real-world actions has no business in a cleanup path.
      const asOperator = await api.post("/api/approvals/expire", {}, { auth: ROLE_KEYS.operator });
      expect(asOperator.status).toBe(403);

      const asApprover = await api.post("/api/approvals/expire", {}, { auth: ROLE_KEYS.approver });
      expect(asApprover.status).toBe(403);
    });

    it("is refused without a credential", async () => {
      const anonymous = await api.post("/api/approvals/expire", {}, { auth: null });
      expect(anonymous.status).toBe(401);
    });
  });

  describe("what the API now reports", () => {
    it("publishes the deadline so a client need not guess it", async () => {
      const call = await callRefund("cus_deadline");
      expect(call.status).toBe(200);
      const approval = await approvalFor("cus_deadline");

      expect(approval.expiresAt).toBeTruthy();
      expect(Date.parse(approval.expiresAt as string)).toBeGreaterThan(Date.now());
    });
  });
});
