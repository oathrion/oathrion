/**
 * The three reference scenarios, end to end, across four processes' worth of
 * boundaries.
 *
 *   test (MCP client) ──▶ Oathrion gateway ──▶ local MCP server ──▶ mock HTTP downstream
 *
 * WHAT MAKES THESE DIFFERENT FROM THE PHASE 2 SCENARIO TESTS
 * ----------------------------------------------------------
 * `reference-scenarios.test.ts` proves a decision by reading an in-process
 * counter on a simulated tool. Good evidence, but the counter lives in the same
 * process as the code under test.
 *
 * These tests prove the same decisions by asking a *separate HTTP server* what
 * requests it received. The assertion for a BLOCK is no longer "a variable did
 * not increment" but "no HTTP request ever arrived at the downstream". For that
 * to be wrong, a socket connection would have to have been made and then
 * forgotten by the server that accepted it.
 *
 * The downstream applies no safety checks of its own (see its module comment),
 * so when a `customer.delete` fails to arrive the only available explanation is
 * that Oathrion refused to forward it.
 *
 * Amounts follow the brief: 75 EUR ALLOW, 750 EUR APPROVAL_REQUIRED against the
 * 500 EUR org threshold in `pol_refund_approval`; `delete_customer` BLOCK from
 * `pol_customer_deletion`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";

const REFUND_PATH = "/mock/refund";
const DELETE_PATH = "/mock/customer/delete";

interface CallReply {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** `GET /api/audit` returns a page of flattened audit events. */
interface AuditReply {
  total: number;
  events: Array<Record<string, unknown>>;
}

/** `GET /api/approvals` returns a bare array. */
interface ApprovalRecord {
  id: string;
  status: string;
  executionId?: string;
}

describe("MCP end-to-end through a real downstream", () => {
  let api: TestClient;
  let mock: MockDownstream;
  let mcp: LocalMcpServer;
  let previousUrl: string | undefined;

  /** Invokes a tool through Oathrion's MCP gateway, as a conformant MCP client. */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    auth: string = ROLE_KEYS.operator,
  ) {
    return api.post<CallReply>(
      "/api/mcp",
      {
        jsonrpc: "2.0",
        id: `t-${name}-${Date.now()}`,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
            [META_KEYS.clientCapabilities]: {},
          },
        },
      },
      {
        auth,
        headers: {
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
          "X-Oathrion-Agent-Id": "agt_billing",
        },
      },
    );
  }

  /** Reads the downstream's record back over HTTP, not from the local object. */
  async function receivedOverHttp(): Promise<Array<{ path: string; executionId: string | null }>> {
    const response = await fetch(`${mock.url}/mock/received`);
    const payload = (await response.json()) as {
      calls: Array<{ path: string; executionId: string | null }>;
    };
    return payload.calls;
  }

  beforeAll(async () => {
    mock = await startMockDownstream();
    mcp = await startLocalMcpServer(mock.url);
    /*
     * Set before the server boots so the tools resolve it. It is read per call
     * rather than cached, but setting it first keeps the ordering obvious.
     */
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

  beforeEach(() => {
    mock.reset();
    mcp.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  /* --------------------------------------------------------------------- */
  /* Fixture integrity                                                    */
  /* --------------------------------------------------------------------- */

  describe("the fixture itself", () => {
    it("has a downstream that really executes what it is asked, with no checks", async () => {
      /*
       * The negative control, and the most important test in this file. It
       * calls the downstream DIRECTLY, bypassing Oathrion entirely, with the most
       * dangerous request in the system.
       *
       * If this failed, every BLOCK assertion below would be worthless — the
       * action would have been impossible rather than prevented. This proves
       * the chain is live and the danger is real, so that "it did not happen"
       * means "Oathrion stopped it".
       */
      const direct = await fetch(`${mock.url}${DELETE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer: "cus_control" }),
      });
      expect(direct.status).toBe(200);
      expect((await direct.json()) as Record<string, unknown>).toMatchObject({
        ok: true,
        deletedRecords: 1,
      });
      expect(await receivedOverHttp()).toHaveLength(1);
    });

    it("does not record diagnostic reads as calls", async () => {
      // Otherwise asserting "nothing arrived" would itself create an arrival.
      await receivedOverHttp();
      await receivedOverHttp();
      expect(await receivedOverHttp()).toHaveLength(0);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Scenario A — ALLOW reaches the downstream                            */
  /* --------------------------------------------------------------------- */

  describe("scenario A: refund of 75 EUR is ALLOWed and reaches the downstream", () => {
    it("dispatches a real HTTP request to the downstream", async () => {
      const reply = await callTool("refund", { target: "cus_alice", amount: 75, currency: "EUR" });

      expect(reply.status).toBe(200);
      expect(reply.body.error).toBeUndefined();
      expect(reply.body.result?.isError).toBe(false);

      const calls = await receivedOverHttp();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe(REFUND_PATH);
    });

    it("reports LOCAL_MCP rather than claiming a simulation", async () => {
      /*
       * The truth rule made machine-checkable. The governance payload used to
       * hard-code `simulated: true`, which became a false statement the moment
       * a tool could dispatch for real. It is now derived from what the tool
       * reports, and this test is what holds it honest.
       */
      const reply = await callTool("refund", { target: "cus_alice", amount: 75, currency: "EUR" });
      expect(reply.body.result?.structuredContent).toMatchObject({
        decision: "ALLOW",
        mode: "LOCAL_MCP",
        simulated: false,
        attempted: true,
        succeeded: true,
      });
    });

    it("reports SIMULATED for a tool that has no downstream wired", async () => {
      // The same run, on a tool with no MCP downstream, must NOT inherit the
      // real-dispatch label from its neighbour.
      const reply = await callTool("purchase", { target: "vendor_acme", amount: 10 });
      expect(reply.body.result?.structuredContent).toMatchObject({
        mode: "SIMULATED",
        simulated: true,
      });
      // And it certainly must not have reached the refund downstream.
      expect(await receivedOverHttp()).toHaveLength(0);
    });

    it("carries the amount through every hop unchanged", async () => {
      await callTool("refund", { target: "cus_alice", amount: 75, currency: "EUR" });
      const calls = await receivedOverHttp();
      expect(mock.receivedOn(REFUND_PATH)[0]?.body).toMatchObject({
        customer: "cus_alice",
        amount: 75,
      });
      expect(calls).toHaveLength(1);
    });

    it("correlates the downstream request with the Oathrion execution that caused it", async () => {
      await callTool("refund", { target: "cus_alice", amount: 75, currency: "EUR" });
      const [call] = await receivedOverHttp();
      // Without this the audit trail is only checkable against itself.
      expect(call!.executionId).toMatch(/^exe_/);
    });

    it("records an audit entry for the allowed action", async () => {
      await callTool("refund", { target: "cus_audit_allow", amount: 75, currency: "EUR" });
      const audit = await api.get<AuditReply>("/api/audit", { auth: ROLE_KEYS.admin });
      expect(audit.status).toBe(200);
      const entry = audit.body.events.find((event) => event.target === "cus_audit_allow");
      expect(entry).toBeDefined();
      /*
       * Lower-case `"allow"` is the stored form. The MCP governance payload
       * uses `"ALLOW"`, so the same decision is spelled two ways in two
       * representations. Asserted as-is rather than normalised, because a test
       * that papered over it would hide the discrepancy; recorded as a known
       * inconsistency in PHASE-4-REPORT.md instead of being changed here,
       * since the persisted audit format is not Phase 4's to rewrite.
       */
      expect(entry).toMatchObject({ action: "refund", decision: "allow" });
    });
  });

  /* --------------------------------------------------------------------- */
  /* Scenario B — BLOCK never reaches the downstream                      */
  /* --------------------------------------------------------------------- */

  describe("scenario B: delete_customer is BLOCKed and never reaches the downstream", () => {
    it("makes no HTTP request to the downstream at all", async () => {
      const reply = await callTool("delete_customer", { target: "cus_bob" });

      // 200 because Oathrion evaluated the call: a BLOCK is a decision, not a
      // transport failure. The refusal is carried in isError.
      expect(reply.status).toBe(200);
      expect(reply.body.result?.isError).toBe(true);

      // The claim that matters, asserted across a socket.
      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mock.receivedOn(DELETE_PATH)).toHaveLength(0);
    });

    it("does not even reach the local MCP server", async () => {
      /*
       * Stronger than the downstream assertion: the action stops at Oathrion, so
       * the intermediate MCP server is never asked either. A BLOCK that reached
       * the MCP server and was refused there would be someone else's guarantee.
       */
      await callTool("delete_customer", { target: "cus_bob" });
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("stays blocked when attempted repeatedly", async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await callTool("delete_customer", { target: `cus_retry_${attempt}` });
      }
      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("records an audit entry for the blocked action", async () => {
      await callTool("delete_customer", { target: "cus_audit_block" });
      const audit = await api.get<AuditReply>("/api/audit", { auth: ROLE_KEYS.admin });
      // A refusal that leaves no trace is not governance. The audit must record
      // the action that did NOT happen, and record it as blocked.
      const entry = audit.body.events.find((event) => event.target === "cus_audit_block");
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({ action: "delete_customer", decision: "block" });
    });
  });

  /* --------------------------------------------------------------------- */
  /* Scenario C — APPROVAL_REQUIRED holds, then releases                  */
  /* --------------------------------------------------------------------- */

  describe("scenario C: refund of 750 EUR waits for a human", () => {
    async function pendingApproval(target: string): Promise<ApprovalRecord> {
      const list = await api.get<ApprovalRecord[]>("/api/approvals", {
        auth: ROLE_KEYS.approver,
      });
      expect(list.status).toBe(200);
      /*
       * Matched to the execution for THIS target rather than "the most recent
       * pending one". Picking by recency would make the test order-dependent
       * and could approve a different scenario's request, which is exactly the
       * confusion an approval queue must never have.
       */
      const audit = await api.get<AuditReply>("/api/audit", { auth: ROLE_KEYS.admin });
      const executionIds = new Set(
        audit.body.events
          .filter((event) => event.target === target)
          .map((event) => event.executionId as string),
      );
      const pending = list.body.filter(
        (approval) =>
          approval.status === "pending" &&
          approval.executionId !== undefined &&
          executionIds.has(approval.executionId),
      );
      expect(pending).toHaveLength(1);
      return pending[0]!;
    }

    it("reaches nothing before approval", async () => {
      const reply = await callTool("refund", { target: "cus_big", amount: 750, currency: "EUR" });

      expect(reply.status).toBe(200);
      expect(reply.body.result?.isError).toBe(true);

      // The central claim of the product: held, not executed-and-reversed.
      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("reaches the downstream only after a human approves", async () => {
      await callTool("refund", { target: "cus_big_two", amount: 750, currency: "EUR" });
      expect(await receivedOverHttp()).toHaveLength(0);

      const approval = await pendingApproval("cus_big_two");
      const approved = await api.post(`/api/approvals/${approval.id}/approve`, undefined, {
        auth: ROLE_KEYS.approver,
      });
      expect(approved.status).toBe(200);

      // Now, and only now, the request exists.
      const calls = await receivedOverHttp();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe(REFUND_PATH);
      expect(mock.receivedOn(REFUND_PATH)[0]?.body).toMatchObject({ amount: 750 });
    });

    it("reaches nothing when the human rejects instead", async () => {
      await callTool("refund", { target: "cus_big_three", amount: 750, currency: "EUR" });
      const approval = await pendingApproval("cus_big_three");

      const rejected = await api.post(`/api/approvals/${approval.id}/reject`, undefined, {
        auth: ROLE_KEYS.approver,
      });
      expect(rejected.status).toBe(200);
      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("cannot be released by an operator who lacks the approve capability", async () => {
      // Otherwise the human in the loop is decorative.
      await callTool("refund", { target: "cus_big_four", amount: 750, currency: "EUR" });
      const approval = await pendingApproval("cus_big_four");

      const attempt = await api.post(`/api/approvals/${approval.id}/approve`, undefined, {
        auth: ROLE_KEYS.operator,
      });
      expect(attempt.status).toBe(403);
      expect(await receivedOverHttp()).toHaveLength(0);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Scenario D — an action nobody declared reaches nothing               */
  /* --------------------------------------------------------------------- */

  describe("scenario D: an undeclared action fails closed and reaches nothing", () => {
    /*
     * The other three scenarios all exercise actions the system knows about:
     * one allowed, one blocked, one held for a human. This one is the case
     * where Oathrion has no opinion to apply, and it is the most important of the
     * four, because it is the only one whose correct answer cannot be looked up.
     *
     * A control plane that forwards what it does not recognise is not a control
     * plane. The refusal must therefore come from the absence of a policy, not
     * from a policy that happens to say no — and it must be observable at the
     * far end of a socket, not merely in a return value.
     *
     * `evaluate-contract.test.ts` proves the decision on the HTTP surface. This
     * proves the consequence on the path that actually dispatches.
     */

    /** Invokes a name the catalog does not contain, over the same transport. */
    async function callUndeclared(name: string, args: Record<string, unknown> = {}) {
      return callTool(name, args);
    }

    it("makes no HTTP request to the downstream for an unknown verb", async () => {
      const reply = await callUndeclared("unknown.internal_action", { target: "cus_ghost" });

      // Refused one way or another — as a decision carried in isError, or as a
      // protocol error for a tool that is not in the catalog. Both are correct
      // refusals; what is NOT acceptable is a success.
      const refused = reply.body.error !== undefined || reply.body.result?.isError === true;
      expect(refused).toBe(true);

      // The claim that matters, asserted across a socket.
      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("reaches nothing for a spread of undeclared shapes", async () => {
      /*
       * One unknown name could be refused by a single hard-coded check. A family
       * of them, including names built to look plausible next to the real tools,
       * has to be refused by the absence of a declaration.
       */
      const undeclared = [
        "unknown.internal_action",
        "internal.admin_override",
        "refund_all",
        "refund.v2",
        "REFUND",
        "refund ",
        "customer.delete",
        "stripe.refund.force",
        "../refund",
        "system.exec",
      ];

      for (const name of undeclared) {
        await callUndeclared(name, { target: "cus_ghost", amount: 75, currency: "EUR" });
      }

      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("does not let a plausible-looking undeclared name inherit the refund tool", async () => {
      /*
       * The specific failure this guards against is prefix or fuzzy matching:
       * `refund.v2` resolving to `refund` because someone made lookup
       * forgiving. A forgiving lookup on a control plane is a bypass.
       */
      await callUndeclared("refund.v2", { target: "cus_lookalike", amount: 75, currency: "EUR" });

      expect(mock.receivedOn(REFUND_PATH)).toHaveLength(0);
      expect(await receivedOverHttp()).toHaveLength(0);
    });

    it("stays closed when the same undeclared action is retried", async () => {
      // Fail-closed must not be a first-attempt-only property, and repetition
      // must not warm any cache into an allow.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await callUndeclared("unknown.internal_action", { target: `cus_ghost_${attempt}` });
      }
      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("still reaches nothing when the caller is an admin", async () => {
      /*
       * Role is authorization, not declaration. The most privileged credential
       * in the fixture must not be able to invoke something no policy covers,
       * because the missing thing is a policy, and no role supplies one.
       */
      const reply = await callTool(
        "unknown.internal_action",
        { target: "cus_ghost_admin" },
        ROLE_KEYS.admin,
      );
      const refused = reply.body.error !== undefined || reply.body.result?.isError === true;
      expect(refused).toBe(true);
      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("creates no approval that a human could later release", async () => {
      /*
       * The subtle wrong answer: treat "unrecognised" as "needs review" and
       * park it. That converts a fail-closed refusal into a pending action that
       * one click turns into an execution — and it would let an attacker have
       * an undeclared action executed by asking politely.
       */
      const before = await api.get<ApprovalRecord[]>("/api/approvals", {
        auth: ROLE_KEYS.approver,
      });
      await callUndeclared("unknown.internal_action", { target: "cus_ghost_appr" });
      const after = await api.get<ApprovalRecord[]>("/api/approvals", {
        auth: ROLE_KEYS.approver,
      });

      expect(after.body.length).toBe(before.body.length);
      expect(after.body.some((record) => record.status === "pending")).toBe(
        before.body.some((record) => record.status === "pending"),
      );
    });

    it("does not report an undeclared action as allowed anywhere in the audit", async () => {
      // A refusal that the record remembers as a success is worse than no
      // record. Whatever the audit says about this action, it is not "allow".
      await callUndeclared("unknown.internal_action", { target: "cus_ghost_audit" });
      const audit = await api.get<AuditReply>("/api/audit", { auth: ROLE_KEYS.admin });
      const entries = audit.body.events.filter(
        (event) => event.target === "cus_ghost_audit",
      );
      for (const entry of entries) {
        expect(entry.decision).not.toBe("allow");
      }
    });
  });

  /* --------------------------------------------------------------------- */
  /* Agent status and tenant isolation, over MCP                          */
  /* --------------------------------------------------------------------- */

  describe("preconditions still hold on the MCP path", () => {
    async function setStatus(status: string): Promise<void> {
      const patched = await api.patch(
        "/api/agents/agt_billing",
        { status },
        { auth: ROLE_KEYS.admin },
      );
      expect(patched.status).toBe(200);
    }

    afterEach(async () => {
      await setStatus("active");
    });

    it("a paused agent reaches nothing, even for an otherwise allowed refund", async () => {
      await setStatus("paused");
      const reply = await callTool("refund", { target: "cus_paused", amount: 75, currency: "EUR" });

      expect(reply.body.result?.isError).toBe(true);
      expect(await receivedOverHttp()).toHaveLength(0);
      expect(mcp.toolCallCount()).toBe(0);
    });

    it("an agent from another tenant cannot be driven through this credential", async () => {
      const reply = await callTool("refund", { target: "cus_x", amount: 75, currency: "EUR" });
      expect(reply.status).toBe(200);

      // Same agent id, a credential belonging to a different organization.
      const foreign = await api.post<CallReply>(
        "/api/mcp",
        {
          jsonrpc: "2.0",
          id: "cross-tenant",
          method: "tools/call",
          params: {
            name: "refund",
            arguments: { target: "cus_x", amount: 75, currency: "EUR" },
            _meta: {
              [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
              [META_KEYS.clientCapabilities]: {},
            },
          },
        },
        {
          auth: "test-rival-admin-key-0001",
          headers: {
            "MCP-Protocol-Version": PROTOCOL_VERSION,
            "Mcp-Method": "tools/call",
            "Mcp-Name": "refund",
            "X-Oathrion-Agent-Id": "agt_billing",
          },
        },
      );

      expect(foreign.body.error).toBeDefined();
      // Exactly one downstream request: the legitimate one.
      expect(await receivedOverHttp()).toHaveLength(1);
    });
  });
});
