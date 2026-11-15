/**
 * The three reference scenarios, end to end, over real HTTP.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Oathrion's entire claim is one sentence: an ALLOWed action reaches the tool, an
 * action awaiting approval does not reach the tool until a human releases it,
 * and a BLOCKed action never reaches the tool at all. This file is the proof of
 * that sentence, and it is written to be adversarial about it.
 *
 * WHY THE TOOL COUNTER IS THE ONLY EVIDENCE THAT COUNTS
 * -----------------------------------------------------
 * A decision field saying "BLOCK" proves that the engine formed an opinion. It
 * does not prove that nothing happened. The `decision`, `runState` and `toolId`
 * fields are all produced by the same code path that would also be wrong if the
 * chokepoint leaked. `toolExecutionCount` is incremented inside `CountingTool`,
 * on the far side of the boundary, by the tool itself — so it is the one signal
 * that cannot be faked by the layer under test. Every scenario below asserts on
 * a *delta* of that counter, read over the API before and after the action.
 *
 * WHY DELTAS AND NOT ABSOLUTE VALUES
 * ----------------------------------
 * The registry is process-wide and the counters accumulate across the tests in
 * this file. Asserting `count === 1` would make each test depend on the order
 * and success of the ones before it, and a shared-state bug could then hide
 * behind a passing assertion. Deltas make each scenario independent.
 *
 * WHAT WAS TRUE BEFORE THIS FILE EXISTED
 * --------------------------------------
 * All three scenarios were previously unprovable, and two of them were outright
 * failing the requirement:
 *
 *   - `refund` was catalogued but wired to no tool, so an ALLOWed refund
 *     produced `runState: "skipped"` and no execution ever happened. "The tool
 *     was not called" was true for the least interesting possible reason.
 *   - Approving a held refund therefore also executed nothing: the approval
 *     resolved, the Gateway resumed, and there was nothing at the other end.
 *   - `delete_customer` was uncatalogued and fell to the dangerous-name
 *     heuristic, which escalated it to APPROVAL_REQUIRED — an irreversible
 *     deletion placed in a queue rather than denied.
 *
 * `RefundTool`, `CustomerTool`, `pol_refund_approval`, `pol_customer_deletion`
 * and the `agt_billing` seed exist to close exactly those gaps.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../gateway/tool-registry";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const REFUND_TOOL = "refund_tool";
const CUSTOMER_TOOL = "customer_tool";

/** The seeded agent the scenarios act as. See `shared/seed/agents.ts`. */
const AGENT = "agt_billing";

interface ExecuteBody {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  reason: string;
  policyId: string | null;
  policyName: string | null;
  executionId: string | null;
  approvalId: string | null;
  /** Legacy alias of `attempted`. Asserted alongside it, never instead of it. */
  executed: boolean;
  attempted: boolean;
  succeeded: boolean;
  runState: string | null;
  toolId: string | null;
  toolResult: Record<string, unknown> | null;
  execution: {
    id: string;
    status: string;
    runState?: string;
    result?: string | null;
    audit: { at: string; actor: string; event: string; detail: string }[];
  } | null;
}

interface ResolveBody {
  approval: { id: string; status: string; resolvedBy?: string | null };
  execution: ExecuteBody["execution"];
  executed: boolean;
  attempted: boolean;
  succeeded: boolean;
  runState: string | null;
  toolId: string | null;
  toolResult: Record<string, unknown> | null;
}

interface ToolRow {
  id: string;
  toolExecutionCount: number;
}

describe("reference scenarios", () => {
  let api: TestClient;

  /** Live invocation counter for one tool, read back over the API. */
  async function count(toolId: string): Promise<number> {
    const res = await api.get<ToolRow[]>("/api/tools", { auth: ROLE_KEYS.admin });
    expect(res.status).toBe(200);
    const row = res.body.find((t) => t.id === toolId);
    // A missing row would make every "the tool was not called" assertion below
    // vacuously true, so the absence is itself a failure.
    expect(row, `tool "${toolId}" is not registered`).toBeDefined();
    return row!.toolExecutionCount;
  }

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  /* --------------------------------------------------------------------- */
  /* Negative control — the instrument itself                              */
  /* --------------------------------------------------------------------- */

  describe("control · the counters this file relies on actually move", () => {
    /*
     * Scenario C claims "the deletion tool was never called" from the fact that
     * `customer_tool`'s counter stayed at its previous value. That inference is
     * only worth anything if the counter would have moved had the tool run —
     * and because `delete_customer` is blocked on every path through the API,
     * no scenario in this file can demonstrate that. A tool whose counter was
     * broken, or whose `execute` was unreachable, would make scenario C pass
     * for a reason that has nothing to do with Oathrion.
     *
     * So the tools are invoked directly here, on a throwaway registry, with the
     * Gateway entirely out of the picture. This is the only place in the file
     * allowed to do that, and it exists to calibrate the instrument rather than
     * to test a decision.
     */
    it("increments when the deletion tool is invoked directly, off the Oathrion path", async () => {
      const registry = createDefaultRegistry();
      const tool = registry.get(CUSTOMER_TOOL);
      expect(tool).toBeDefined();
      expect(tool!.toolExecutionCount).toBe(0);

      await tool!.execute({
        organizationId: "org_test",
        executionId: "exec_control",
        agentId: AGENT,
        agentName: "Billing Agent",
        action: "delete_customer",
        target: "customer:cus_control",
        metadata: {},
        currency: "EUR",
      });

      // Therefore a zero delta in scenario C is a real negative, not a dead
      // counter.
      expect(tool!.toolExecutionCount).toBe(1);
    });

    it("resolves both scenario tools by their action verb", () => {
      const registry = createDefaultRegistry();
      // If either mapping were missing, an ALLOW would silently become
      // `skipped` and a BLOCK would be holding nothing back.
      expect(registry.resolve("refund")?.id).toBe(REFUND_TOOL);
      expect(registry.resolve("delete_customer")?.id).toBe(CUSTOMER_TOOL);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Scenario A — a refund inside the policy runs, for real                */
  /* --------------------------------------------------------------------- */

  describe("A · €75 refund is allowed and the tool really runs", () => {
    it("executes the refund and increments the tool counter exactly once", async () => {
      const before = await count(REFUND_TOOL);

      const res = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_10428",
          metadata: { amount: 75, currency: "EUR", reference: "ord_88213" },
        },
        { auth: ROLE_KEYS.operator },
      );

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("ALLOW");

      // The side effect actually happened. `succeeded` and not merely
      // `attempted`: a tool that was invoked and threw would satisfy the latter.
      expect(res.body.attempted).toBe(true);
      expect(res.body.succeeded).toBe(true);
      expect(res.body.executed).toBe(res.body.attempted);
      expect(res.body.runState).toBe("succeeded");
      expect(res.body.toolId).toBe(REFUND_TOOL);

      // The evidence from the far side of the boundary.
      expect(await count(REFUND_TOOL)).toBe(before + 1);

      // Exactly once — not "at least once".
      expect(await count(REFUND_TOOL)).toBe(before + 1);
    });

    it("attributes the decision to the named org policy, not to a fallback", async () => {
      const res = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_10429",
          metadata: { amount: 75, currency: "EUR" },
        },
        { auth: ROLE_KEYS.operator },
      );

      expect(res.body.decision).toBe("ALLOW");
      /*
       * Before `pol_refund_approval` existed, this same call returned the
       * reason "No policy constrains this action." — an ALLOW by absence of a
       * rule. An operator cannot audit an absence. The refund is now allowed
       * *because* a rule was evaluated and the amount was inside it.
       */
      expect(res.body.policyId).toBe("pol_refund_approval");
      expect(res.body.reason).toContain("Refund approval threshold");
    });

    it("records the execution and its audit trail", async () => {
      const res = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_10430",
          metadata: { amount: 40, currency: "EUR" },
        },
        { auth: ROLE_KEYS.operator },
      );

      const id = res.body.executionId;
      expect(id).toBeTruthy();

      const stored = await api.get<NonNullable<ExecuteBody["execution"]>>(
        `/api/executions/${id}`,
        { auth: ROLE_KEYS.viewer },
      );
      expect(stored.status).toBe(200);
      expect(stored.body.runState).toBe("succeeded");

      const events = stored.body.audit.map((entry) => entry.event);
      // The trail has to show the decision AND the side effect, in that order.
      expect(events).toContain("Policy evaluated");
      expect(events).toContain("Tool execution started");
      expect(events).toContain("Tool execution completed");
      expect(events.indexOf("Policy evaluated")).toBeLessThan(
        events.indexOf("Tool execution started"),
      );
    });
  });

  /* --------------------------------------------------------------------- */
  /* Scenario B — a refund above the policy waits for a human              */
  /* --------------------------------------------------------------------- */

  describe("B · €750 refund is held, then released by a human", () => {
    it("holds the action, names the €500 threshold, and does not touch the tool", async () => {
      const before = await count(REFUND_TOOL);

      const res = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_20001",
          metadata: { amount: 750, currency: "EUR" },
        },
        { auth: ROLE_KEYS.operator },
      );

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("APPROVAL_REQUIRED");
      expect(res.body.approvalId).toBeTruthy();

      /*
       * The reason must come from the organisation policy, not from the agent's
       * own mandate. `agt_billing` carries a €2,000 ceiling precisely so that it
       * stays silent here and only one rule can be responsible — otherwise the
       * scenario would demonstrate the mandate while appearing to demonstrate
       * the policy.
       */
      expect(res.body.policyId).toBe("pol_refund_approval");
      expect(res.body.reason).toContain("500");
      expect(res.body.reason).toContain("Refund approval threshold");

      // THE CENTRAL ASSERTION OF THE WHOLE PRODUCT.
      expect(await count(REFUND_TOOL)).toBe(before);
      expect(res.body.attempted).toBe(false);
      expect(res.body.succeeded).toBe(false);
      expect(res.body.runState).toBe("pending");
      expect(res.body.toolId).toBeNull();
    });

    it("executes the refund once a human approves, and not before", async () => {
      const beforeRequest = await count(REFUND_TOOL);

      const requested = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_20002",
          metadata: { amount: 750, currency: "EUR" },
        },
        { auth: ROLE_KEYS.operator },
      );
      expect(requested.body.decision).toBe("APPROVAL_REQUIRED");
      const approvalId = requested.body.approvalId!;

      // Still nothing, while the approval sits in the queue.
      expect(await count(REFUND_TOOL)).toBe(beforeRequest);

      const approved = await api.post<ResolveBody>(
        `/api/approvals/${approvalId}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      );

      expect(approved.status).toBe(200);
      expect(approved.body.approval.status).toBe("approved");

      // The approval did not merely change a status — it released the action.
      expect(approved.body.attempted).toBe(true);
      expect(approved.body.succeeded).toBe(true);
      expect(approved.body.runState).toBe("succeeded");
      expect(approved.body.toolId).toBe(REFUND_TOOL);
      expect(await count(REFUND_TOOL)).toBe(beforeRequest + 1);
    });

    it("does not execute a second time when the same approval is replayed", async () => {
      const requested = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_20003",
          metadata: { amount: 750, currency: "EUR" },
        },
        { auth: ROLE_KEYS.operator },
      );
      const approvalId = requested.body.approvalId!;

      const beforeApprove = await count(REFUND_TOOL);
      const first = await api.post<ResolveBody>(
        `/api/approvals/${approvalId}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      );
      expect(first.body.attempted).toBe(true);
      expect(await count(REFUND_TOOL)).toBe(beforeApprove + 1);

      // Replaying an approve is the obvious way to try to get paid twice.
      const second = await api.post<ResolveBody>(
        `/api/approvals/${approvalId}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      );

      expect(second.body.attempted).toBe(false);
      // The run itself still reads as succeeded — it did, once. `attempted`
      // describes this call; `runState` describes reality.
      expect(second.body.runState).toBe("succeeded");
      expect(await count(REFUND_TOOL)).toBe(beforeApprove + 1);
    });

    it("never reaches the tool when the approval is rejected", async () => {
      const requested = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_20004",
          metadata: { amount: 900, currency: "EUR" },
        },
        { auth: ROLE_KEYS.operator },
      );
      const approvalId = requested.body.approvalId!;
      const before = await count(REFUND_TOOL);

      const rejected = await api.post<ResolveBody>(
        `/api/approvals/${approvalId}/reject`,
        {},
        { auth: ROLE_KEYS.approver },
      );

      expect(rejected.body.approval.status).toBe("rejected");
      expect(rejected.body.attempted).toBe(false);
      expect(rejected.body.toolId).toBeNull();
      expect(await count(REFUND_TOOL)).toBe(before);
    });

    it("refuses to release the action to a caller without approve capability", async () => {
      const requested = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_20005",
          metadata: { amount: 750, currency: "EUR" },
        },
        { auth: ROLE_KEYS.operator },
      );
      const approvalId = requested.body.approvalId!;
      const before = await count(REFUND_TOOL);

      // The operator that requested the action must not be able to approve it.
      const res = await api.post(
        `/api/approvals/${approvalId}/approve`,
        {},
        { auth: ROLE_KEYS.operator },
      );

      expect(res.status).toBe(403);
      expect(await count(REFUND_TOOL)).toBe(before);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Scenario C — a customer deletion is denied outright                   */
  /* --------------------------------------------------------------------- */

  describe("C · deleting a customer is blocked and never reaches the tool", () => {
    it("blocks the action and names the policy that denied it", async () => {
      const before = await count(CUSTOMER_TOOL);

      const res = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "delete_customer",
          target: "customer:cus_30001",
          metadata: { reason: "GDPR erasure request" },
        },
        { auth: ROLE_KEYS.operator },
      );

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("BLOCK");

      /*
       * The denial must come from a rule an operator wrote.
       *
       * Two weaker outcomes used to be possible here and both are now excluded:
       * a BLOCK from the permission barrier (which would only prove the agent
       * lacked a scope — `agt_billing` deliberately holds `write:crm`), and an
       * APPROVAL_REQUIRED from the dangerous-name heuristic (which would put an
       * irreversible deletion into a queue).
       */
      expect(res.body.policyId).toBe("pol_customer_deletion");
      expect(res.body.reason).toContain("Customer deletion is never autonomous");

      // Nothing ran, and a working destructive tool sits behind this verb.
      expect(await count(CUSTOMER_TOOL)).toBe(before);
      expect(res.body.attempted).toBe(false);
      expect(res.body.succeeded).toBe(false);
      expect(res.body.toolId).toBeNull();
    });

    it("creates no approval a human could later release", async () => {
      const res = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "delete_customer",
          target: "customer:cus_30002",
          metadata: {},
        },
        { auth: ROLE_KEYS.operator },
      );

      // A BLOCK that quietly opened an approval would be an escalation path:
      // the deletion would become one click away from happening.
      expect(res.body.decision).toBe("BLOCK");
      expect(res.body.approvalId).toBeNull();
    });

    it("records the blocked attempt as a terminal, non-executable run", async () => {
      const res = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "delete_customer",
          target: "customer:cus_30003",
          metadata: {},
        },
        { auth: ROLE_KEYS.operator },
      );

      const id = res.body.executionId;
      expect(id).toBeTruthy();

      const stored = await api.get<NonNullable<ExecuteBody["execution"]>>(
        `/api/executions/${id}`,
        { auth: ROLE_KEYS.viewer },
      );

      expect(stored.status).toBe(200);
      // Born `skipped`: the row never passes through a state from which a tool
      // run could be claimed.
      expect(stored.body.runState).toBe("skipped");

      const events = stored.body.audit.map((entry) => entry.event);
      expect(events).toContain("Action blocked");
      // The proof of the negative, in the durable record and not just in the
      // response: no tool phase was ever entered.
      expect(events).not.toContain("Tool execution started");
      expect(events).not.toContain("Tool execution completed");
    });

    it("cannot be retried into existence", async () => {
      const res = await api.post<ExecuteBody>(
        "/api/execute",
        {
          agentId: AGENT,
          action: "delete_customer",
          target: "customer:cus_30004",
          metadata: {},
        },
        { auth: ROLE_KEYS.operator },
      );
      const before = await count(CUSTOMER_TOOL);

      // `/retry` is the one endpoint that dispatches without a fresh decision,
      // so it is the natural place to look for a way around a BLOCK.
      const retried = await api.post(
        `/api/executions/${res.body.executionId}/retry`,
        {},
        { auth: ROLE_KEYS.operator },
      );

      expect(retried.status).toBeGreaterThanOrEqual(400);
      expect(await count(CUSTOMER_TOOL)).toBe(before);
    });

    it("blocks the deletion on every target, because the verb is what is denied", async () => {
      const before = await count(CUSTOMER_TOOL);

      for (const target of [
        "customer:cus_1",
        "crm://acme/customers/42",
        "staging.customers",
        "",
      ]) {
        const res = await api.post<ExecuteBody>(
          "/api/execute",
          { agentId: AGENT, action: "delete_customer", target, metadata: {} },
          { auth: ROLE_KEYS.operator },
        );

        // An empty target is rejected by validation rather than evaluated; both
        // outcomes are acceptable, reaching the tool is not.
        if (res.status === 200) expect(res.body.decision).toBe("BLOCK");
      }

      expect(await count(CUSTOMER_TOOL)).toBe(before);
    });
  });
});
