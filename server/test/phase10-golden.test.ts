/**
 * THE GOLDEN KILL DEMO (Phase 10, §29).
 *
 * WHAT MAKES THIS SUITE DIFFERENT FROM AN API TEST
 * ------------------------------------------------
 * Every assertion here is about the DOWNSTREAM, not about Oathrion's response body.
 * Oathrion answering `403` is not evidence that a refund did not happen; the evidence
 * is that the mock downstream — a separate HTTP server, reached over a socket
 * through a real MCP server — recorded zero requests. A system whose promise is
 * "no action reaches a real tool unless authorized" can only be tested by
 * counting what arrived at the tool.
 *
 * THE CHAIN UNDER TEST IS REAL
 * ----------------------------
 *   test → HTTP → Oathrion (Express, policy, grant store)
 *        → MCP 2026-07-28 `tools/call` → local MCP server (separate process-less
 *          HTTP server, no governance of its own)
 *        → HTTP → mock downstream (records every call)
 *
 * The local MCP server refuses nothing: it will refund ten million euros and
 * delete any customer. That is deliberate — if the downstream also had safety
 * checks, a zero count would be ambiguous. Here the only possible explanation for
 * a `customer.delete` that never arrives is that Oathrion did not forward it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, ROLE_KEYS, type TestClient } from "./harness";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";

const AGENT = "agt_refund_bot";
const OTHER_AGENT = "agt_other_bot";
const DEST = "local-fixture";

interface AuthorizeBody {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  reason: string;
  actionId: string;
  actionHash: string;
  grantId: string | null;
  grantState: string | null;
  expiresAt: string | null;
  approvalId: string | null;
  executable: boolean;
}

interface ExecuteBody {
  executed?: boolean;
  receiptId?: string;
  outcome?: string;
  error?: string;
  code?: string;
}

describe("Phase 10 — golden kill demo", () => {
  let api: TestClient;
  let mock: MockDownstream;
  let mcp: LocalMcpServer;
  let previousUrl: string | undefined;

  /** Refunds actually delivered to the downstream, by path. */
  function refundsDelivered(): number {
    return mock.receivedOn("/mock/refund").length;
  }
  function deletionsDelivered(): number {
    return mock.receivedOn("/mock/customer/delete").length;
  }

  async function authorize(body: Record<string, unknown>, auth: string = ROLE_KEYS.operator) {
    return api.post<AuthorizeBody>("/api/v1/actions/authorize", body, { auth });
  }
  async function execute(body: Record<string, unknown>, auth: string = ROLE_KEYS.operator) {
    return api.post<ExecuteBody>("/api/v1/actions/execute", body, { auth });
  }

  function refund(amount: number, extra: Record<string, unknown> = {}) {
    return {
      action: "stripe.refund",
      destinationId: DEST,
      agentId: AGENT,
      arguments: { customer: "cus_123", amount, currency: "EUR" },
      ...extra,
    };
  }

  beforeAll(async () => {
    mock = await startMockDownstream();
    mcp = await startLocalMcpServer(mock.url);
    previousUrl = process.env.OATHRION_LOCAL_MCP_URL;
    process.env.OATHRION_LOCAL_MCP_URL = mcp.url;
    api = await startTestServer();

    /*
     * The rule set for the demo, written through the real API by a real admin.
     * Three rules, and their ORDER is the policy:
     *
     *   priority 300  customer.delete            → BLOCK             (never, at all)
     *   priority 200  stripe.refund amount > 100 → APPROVAL_REQUIRED (a human decides)
     *   priority 100  stripe.refund amount <= 100 → ALLOW            (routine)
     *
     * Nothing else is written, so every other verb falls through to the
     * fail-closed default and is BLOCKed with no grant.
     */
    const rules = [
      {
        id: "apol_delete_block",
        name: "Customer deletion is never authorized",
        action: "customer.delete",
        destinationId: null,
        effect: "BLOCK",
        constraints: [],
        priority: 300,
      },
      {
        id: "apol_refund_large",
        name: "Refunds above 100 need a human",
        action: "stripe.refund",
        destinationId: DEST,
        effect: "APPROVAL_REQUIRED",
        constraints: [{ field: "amount", op: "gt", value: 100 }],
        priority: 200,
      },
      {
        id: "apol_refund_small",
        name: "Small EUR refunds are routine",
        action: "stripe.refund",
        destinationId: DEST,
        effect: "ALLOW",
        constraints: [
          { field: "amount", op: "lte", value: 100 },
          { field: "currency", op: "eq", value: "EUR" },
        ],
        priority: 100,
      },
    ];
    for (const rule of rules) {
      /*
       * PUT through raw fetch: the Phase 9 harness exposes post/get/patch/del and
       * nothing else, and adding a method to a shared harness for one suite's
       * convenience is a change to code every other test depends on. The URL is the
       * harness's own origin, so this is still the real HTTP surface.
       */
      const saved = await fetch(`${api.baseUrl}/api/v1/action-policies`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ROLE_KEYS.admin}` },
        body: JSON.stringify(rule),
      });
      expect(saved.status, await saved.clone().text()).toBe(200);
    }
    mock.reset();
  });

  afterAll(async () => {
    await api.close();
    await mcp.close();
    await mock.close();
    if (previousUrl === undefined) delete process.env.OATHRION_LOCAL_MCP_URL;
    else process.env.OATHRION_LOCAL_MCP_URL = previousUrl;
    delete process.env.OATHRION_GRANT_TTL_MS;
  });

  /* ------------------------------- A ------------------------------------- */

  it("A — an allowed refund of 75 EUR reaches the downstream exactly once", async () => {
    const before = refundsDelivered();
    const decision = await authorize(refund(75));
    expect(decision.status).toBe(200);
    expect(decision.body.decision).toBe("ALLOW");
    expect(decision.body.grantId).toBeTruthy();
    expect(decision.body.executable).toBe(true);

    const run = await execute({ grantId: decision.body.grantId!, ...refund(75) });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.executed).toBe(true);
    expect(run.body.outcome).toBe("succeeded");

    // The only assertion that matters: the tool was actually called, once.
    expect(refundsDelivered()).toBe(before + 1);
  });

  /* ------------------------------- B ------------------------------------- */

  it("B — 750 EUR requires approval: nothing before, exactly one after", async () => {
    const before = refundsDelivered();
    const decision = await authorize(refund(750));
    expect(decision.body.decision).toBe("APPROVAL_REQUIRED");
    expect(decision.body.grantState).toBe("pending_approval");
    expect(decision.body.executable).toBe(false);

    // Presenting an unapproved grant must not reach the tool.
    const premature = await execute({ grantId: decision.body.grantId!, ...refund(750) });
    expect(premature.status).toBe(403);
    expect(premature.body.code).toBe("grant_not_issued");
    expect(refundsDelivered()).toBe(before);

    const approved = await api.post(
      `/api/v1/actions/grants/${decision.body.grantId}/approve`,
      { actionHash: decision.body.actionHash },
      { auth: ROLE_KEYS.approver },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // Approval alone dispatches nothing.
    expect(refundsDelivered()).toBe(before);

    const run = await execute({ grantId: decision.body.grantId!, ...refund(750) });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(refundsDelivered()).toBe(before + 1);
  });

  /* ------------------------------- C ------------------------------------- */

  it("C — customer.delete is BLOCKed, issues no grant, and deletes nothing", async () => {
    const before = deletionsDelivered();
    const decision = await authorize({
      action: "customer.delete",
      destinationId: DEST,
      agentId: AGENT,
      arguments: { customer: "cus_123" },
    });
    expect(decision.body.decision).toBe("BLOCK");
    // No grant at all. There is nothing to present, so no execution path exists.
    expect(decision.body.grantId).toBeNull();
    expect(deletionsDelivered()).toBe(before);
  });

  /* ------------------------------- D ------------------------------------- */

  it("D — an action no rule mentions is BLOCKed by default", async () => {
    const decision = await authorize({
      action: "stripe.payout",
      destinationId: DEST,
      agentId: AGENT,
      arguments: { amount: 1 },
    });
    expect(decision.body.decision).toBe("BLOCK");
    expect(decision.body.grantId).toBeNull();
    expect(decision.body.reason).toMatch(/blocks by default/i);
  });

  /* ------------------------------- E ------------------------------------- */

  it("E — a grant for 75 cannot execute 750: the mutation changes the hash", async () => {
    const before = refundsDelivered();
    const decision = await authorize(refund(75, { idempotencyKey: `mutate-${Date.now()}` }));
    expect(decision.body.decision).toBe("ALLOW");

    /*
     * The attack: hold a legitimate grant, change the amount at execution time.
     * Oathrion re-canonicalises and re-hashes what was actually presented, so the
     * hashes differ and the grant does not authorize this action.
     */
    const mutated = await execute({ grantId: decision.body.grantId!, ...refund(750) });
    expect(mutated.status).toBe(403);
    expect(mutated.body.code).toBe("action_mismatch");
    expect(refundsDelivered()).toBe(before);

    // And the grant survives unconsumed, so the legitimate action still works.
    const honest = await execute({ grantId: decision.body.grantId!, ...refund(75) });
    expect(honest.status).toBe(200);
    expect(refundsDelivered()).toBe(before + 1);
  });

  /* ------------------------------- F ------------------------------------- */

  it("F — replaying a consumed grant is refused and dispatches nothing", async () => {
    const decision = await authorize(refund(50));
    const first = await execute({ grantId: decision.body.grantId!, ...refund(50) });
    expect(first.status).toBe(200);

    const after = refundsDelivered();
    const replay = await execute({ grantId: decision.body.grantId!, ...refund(50) });
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe("grant_already_consumed");
    expect(refundsDelivered()).toBe(after);
  });

  /* ------------------------------- G ------------------------------------- */

  it("G — a grant issued to one agent cannot be presented by another", async () => {
    const decision = await authorize(refund(60));
    const before = refundsDelivered();

    const stolen = await execute({
      grantId: decision.body.grantId!,
      ...refund(60),
      agentId: OTHER_AGENT,
    });
    expect(stolen.status).toBe(403);
    /*
     * The hash covers the agent id, so the recomputed action differs and
     * ACTION_MISMATCH fires before the agent comparison. Either code is a
     * refusal; the assertion that matters is that nothing was delivered.
     */
    expect(["action_mismatch", "agent_mismatch"]).toContain(stolen.body.code);
    expect(refundsDelivered()).toBe(before);
  });

  /* ------------------------------- H ------------------------------------- */

  it("H — another tenant cannot see or present the grant", async () => {
    const decision = await authorize(refund(65));
    const before = refundsDelivered();

    // A fully privileged admin of a DIFFERENT organization. The interesting
    // attacker: every permission, wrong tenant.
    const crossTenant = await execute({ grantId: decision.body.grantId!, ...refund(65) }, "test-rival-admin-key-0001");
    expect(crossTenant.status).toBe(403);
    expect(crossTenant.body.code).toBe("grant_not_found");
    expect(refundsDelivered()).toBe(before);

    const peek = await api.get(`/api/v1/actions/grants/${decision.body.grantId}`, {
      auth: "test-rival-admin-key-0001",
    });
    expect(peek.status).toBe(404);
  });

  /* ------------------------------- I ------------------------------------- */

  it("I — a grant is bound to its destination", async () => {
    const decision = await authorize(refund(70));
    const before = refundsDelivered();

    const redirected = await execute({
      grantId: decision.body.grantId!,
      ...refund(70),
      destinationId: "not-registered-dest",
    });
    expect(redirected.status).toBe(403);
    expect(refundsDelivered()).toBe(before);
  });

  /* ------------------------------- J ------------------------------------- */

  it("J — an expired grant executes nothing", async () => {
    /*
     * A real expiry, not a mocked clock: the TTL is lowered to its floor (1s) for
     * this one authorization and the test then genuinely waits past it. Mocking
     * `Date.now()` would test the mock, and the expiry that matters is the one the
     * database evaluates in its own `UPDATE ... WHERE expires_at > $now`.
     */
    process.env.OATHRION_GRANT_TTL_MS = "1000";
    const decision = await authorize(refund(80));
    expect(decision.body.decision).toBe("ALLOW");
    delete process.env.OATHRION_GRANT_TTL_MS;
    await new Promise((resolve) => setTimeout(resolve, 1_300));

    const before = refundsDelivered();
    const late = await execute({ grantId: decision.body.grantId!, ...refund(80) });
    expect(late.status).toBe(403);
    expect(late.body.code).toBe("grant_expired");
    expect(refundsDelivered()).toBe(before);
  });

  /* ------------------------------- K ------------------------------------- */

  it("K — two concurrent presenters of one grant produce exactly one execution", async () => {
    const decision = await authorize(refund(90));
    const before = refundsDelivered();

    /*
     * Genuinely concurrent: both requests are in flight before either resolves.
     * A sequential loop would prove nothing about the race — it would only prove
     * the second call sees the first call's committed state, which is scenario F.
     */
    const [a, b] = await Promise.all([
      execute({ grantId: decision.body.grantId!, ...refund(90) }),
      execute({ grantId: decision.body.grantId!, ...refund(90) }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 403]);
    // The number that matters. One authorization, one delivery.
    expect(refundsDelivered()).toBe(before + 1);
  });

  /* ------------------------- approval replay (§15) ------------------------ */

  it("approval cannot be replayed, and cannot be moved to a different amount", async () => {
    const small = await authorize(refund(750, { idempotencyKey: `appr-${Date.now()}` }));
    expect(small.body.decision).toBe("APPROVAL_REQUIRED");

    // An approval naming the wrong action is refused outright.
    const wrongSubject = await api.post(
      `/api/v1/actions/grants/${small.body.grantId}/approve`,
      { actionHash: "0".repeat(64) },
      { auth: ROLE_KEYS.approver },
    );
    expect(wrongSubject.status).toBe(409);

    const first = await api.post(
      `/api/v1/actions/grants/${small.body.grantId}/approve`,
      { actionHash: small.body.actionHash },
      { auth: ROLE_KEYS.approver },
    );
    expect(first.status).toBe(200);

    // Replaying the same approval finds no pending row and claims nothing.
    const replay = await api.post(
      `/api/v1/actions/grants/${small.body.grantId}/approve`,
      { actionHash: small.body.actionHash },
      { auth: ROLE_KEYS.approver },
    );
    expect(replay.status).toBe(409);
  });

  /* ------------------------------ receipts ------------------------------- */

  it("every execution leaves a receipt naming the exact action and destination", async () => {
    const decision = await authorize(refund(95));
    const run = await execute({ grantId: decision.body.grantId!, ...refund(95) });
    expect(run.status).toBe(200);

    const receipt = await api.get<{ receipt: Record<string, unknown> }>(
      `/api/v1/actions/receipts/${run.body.receiptId}`,
      { auth: ROLE_KEYS.admin },
    );
    expect(receipt.status).toBe(200);
    expect(receipt.body.receipt.actionHash).toBe(decision.body.actionHash);
    expect(receipt.body.receipt.grantId).toBe(decision.body.grantId);
    expect(receipt.body.receipt.destinationId).toBe(DEST);
    expect(receipt.body.receipt.outcome).toBe("succeeded");
    // Chained onto the tenant's previous receipt.
    expect(String(receipt.body.receipt.entryHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  /* ------------- the path to the tool is a real MCP call ------------------ */

  it("dispatch is a real MCP tools/call, and a BLOCK produces none", async () => {
    /*
     * `toolCallCount()` is the upstream MCP server's own counter, incremented
     * inside its `tools/call` handler. Counting there rather than at the HTTP mock
     * proves the protocol layer was actually exercised: Oathrion reached the tool by
     * speaking MCP 2026-07-28 to a separate server, not by calling a function.
     */
    const before = mcp.toolCallCount();

    const blocked = await authorize({
      action: "customer.delete",
      destinationId: DEST,
      agentId: AGENT,
      arguments: { customer: "cus_block" },
    });
    expect(blocked.body.decision).toBe("BLOCK");
    expect(mcp.toolCallCount()).toBe(before);

    const allowed = await authorize(refund(40));
    // A decision on its own still calls nothing: Oathrion decides, then dispatches.
    expect(mcp.toolCallCount()).toBe(before);

    const run = await execute({ grantId: allowed.body.grantId!, ...refund(40) });
    expect(run.status).toBe(200);
    expect(mcp.toolCallCount()).toBe(before + 1);
  });

  /* --------------------- forged inputs are refused ------------------------ */

  it("a client-supplied action hash or decision is refused, not ignored", async () => {
    for (const forged of [{ actionHash: "0".repeat(64) }, { decision: "ALLOW" }, { tenantId: "org_other" }]) {
      const reply = await authorize({ ...refund(10), ...forged });
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ code: "authoritative_field_supplied" });
    }
  });
});
