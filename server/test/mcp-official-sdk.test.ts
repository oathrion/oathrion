/**
 * The MCP gateway, driven by the OFFICIAL Model Context Protocol client SDK.
 *
 * WHY THIS FILE EXISTS, WHEN FIVE MCP TEST FILES ALREADY DID
 * ----------------------------------------------------------
 * `mcp-gateway`, `mcp-http-validation`, `mcp-single-path`, `mcp-origin-hardening`
 * and `mcp-e2e-downstream` all speak to this server with a hand-rolled client
 * written from the same reading of the specification as the server itself. That
 * makes them excellent tests of Oathrion's *intent* and blind, by construction, to
 * any place where that reading is wrong: a shared misunderstanding satisfies
 * both halves of a test it also wrote.
 *
 * It was blind to one. Revision 2026-07-28 requires every result to carry a
 * `resultType` field; Oathrion emitted none, and all five suites passed. Pointing
 * `@modelcontextprotocol/client` at the same server surfaced it immediately:
 *
 *     Invalid result for tools/list: missing required resultType —
 *     servers implementing protocol revision 2026-07-28 MUST include it
 *
 * That defect (P8-1) is fixed in `server/mcp/protocol.ts`. This file is the
 * regression test, and it is deliberately NOT another assertion of our own
 * making: the thing doing the checking is the third-party implementation, so it
 * will keep catching conformance drift that we do not know to look for.
 *
 * WHAT IT ALSO PROVES
 * -------------------
 * The four mandated Phase 8 scenarios, executed through the real client rather
 * than through `fetch`, with the downstream tool counter read back over the API
 * as evidence from the far side of the security boundary. A decision is only
 * worth what the execution boundary honours, so every scenario asserts the
 * counter, not merely the verdict text.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const PROTOCOL_VERSION = "2026-07-28";

/** Seeded in the reference fixtures; owns `refund` and `delete_customer`. */
const AGENT = "agt_billing";
const REFUND_TOOL = "refund_tool";
const CUSTOMER_TOOL = "customer_tool";

interface ToolRow {
  id: string;
  toolExecutionCount: number;
}

interface ApprovalRow {
  id: string;
  status: string;
}

describe("MCP gateway · official @modelcontextprotocol/client", () => {
  let api: TestClient;
  let client: Client;

  /**
   * Live invocation counter for one tool, read over the REST API rather than
   * from the MCP response, so the evidence does not come from the same payload
   * whose truthfulness is under test.
   */
  async function count(toolId: string): Promise<number> {
    const res = await api.get<ToolRow[]>("/api/tools", { auth: ROLE_KEYS.admin });
    expect(res.status).toBe(200);
    const row = res.body.find((t) => t.id === toolId);
    // A missing row would make every "the tool was not called" assertion below
    // vacuously true, so its absence is itself a failure.
    expect(row, `tool "${toolId}" is not registered`).toBeDefined();
    return row!.toolExecutionCount;
  }

  beforeAll(async () => {
    api = await startTestServer();

    client = new Client(
      { name: "placet-conformance-probe", version: "1.0.0" },
      {
        /*
         * The SDK still defaults to `'legacy'` version negotiation, whose list
         * tops out at 2025-11-25. Oathrion implements 2026-07-28 and nothing older
         * — the handshake, `Mcp-Session-Id` and `notifications/initialized`
         * were removed in that revision (SEP-2575, SEP-2567) and the gateway
         * does not carry the removed surface just to look compatible. Pinning
         * is therefore how a current client talks to it.
         */
        versionNegotiation: { mode: { pin: PROTOCOL_VERSION } },
      },
    );

    await client.connect(
      new StreamableHTTPClientTransport(new URL("/api/mcp", api.baseUrl), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${ROLE_KEYS.operator}`,
            "X-Oathrion-Agent-Id": AGENT,
          },
        },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    await api.close();
  });

  /* --------------------------------------------------------------------- */
  /* Conformance                                                            */
  /* --------------------------------------------------------------------- */

  describe("protocol conformance", () => {
    it("completes tools/list, which is what P8-1 broke", async () => {
      /*
       * The SDK validates the response envelope before returning it, so a
       * missing `resultType` throws here rather than producing a wrong value.
       * Reaching the assertions at all is most of the point of this test.
       */
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);

      expect(names).toContain("refund");
      expect(names.length).toBeGreaterThan(0);
    });
  });

  /* --------------------------------------------------------------------- */
  /* SCENARIO 1 — allowed, executed, audited                                */
  /* --------------------------------------------------------------------- */

  it("SCENARIO 1 · refund 75 EUR is allowed, runs downstream, and is audited", async () => {
    const before = await count(REFUND_TOOL);

    const result = await client.callTool({
      name: "refund",
      arguments: { target: "customer:cus_sdk_0001", amount: 75, currency: "EUR" },
    });

    const governance = result.structuredContent as Record<string, unknown>;
    expect(governance.decision).toBe("ALLOW");
    expect(governance.attempted).toBe(true);
    expect(governance.succeeded).toBe(true);
    expect(result.isError).toBeFalsy();

    // Evidence from the far side of the boundary: the tool really ran, once.
    expect(await count(REFUND_TOOL)).toBe(before + 1);

    // And the decision is on the record, attributable to a named rule.
    const executionId = governance.executionId as string;
    expect(executionId).toBeTruthy();
    const stored = await api.get<{ audit: { event: string }[] }>(
      `/api/executions/${executionId}`,
      { auth: ROLE_KEYS.viewer },
    );
    expect(stored.status).toBe(200);
    const events = stored.body.audit.map((e) => e.event);
    expect(events).toContain("Policy evaluated");
    expect(events).toContain("Tool execution completed");
  });

  /* --------------------------------------------------------------------- */
  /* SCENARIO 2 — held, NOT executed, then released                         */
  /* --------------------------------------------------------------------- */

  it("SCENARIO 2 · refund 750 EUR is held, touches nothing, then runs once approved", async () => {
    const before = await count(REFUND_TOOL);

    const held = await client.callTool({
      name: "refund",
      arguments: { target: "customer:cus_sdk_0002", amount: 750, currency: "EUR" },
    });

    const governance = held.structuredContent as Record<string, unknown>;
    expect(governance.decision).toBe("APPROVAL_REQUIRED");
    expect(governance.approvalId).toBeTruthy();

    /*
     * THE CENTRAL ASSERTION. A held action must not reach the downstream, and
     * the client must not be told it succeeded — `isError` is true for a hold
     * precisely so a model does not report a refund that has not happened.
     */
    expect(await count(REFUND_TOOL)).toBe(before);
    expect(governance.attempted).toBe(false);
    expect(governance.succeeded).toBe(false);
    expect(held.isError).toBe(true);

    // A human releases it. Only now may the side effect occur.
    const approvalId = governance.approvalId as string;
    const approved = await api.post<{ approval: ApprovalRow; attempted: boolean }>(
      `/api/approvals/${approvalId}/approve`,
      {},
      { auth: ROLE_KEYS.approver },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.approval.status).toBe("approved");
    expect(approved.body.attempted).toBe(true);
    expect(await count(REFUND_TOOL)).toBe(before + 1);
  });

  /* --------------------------------------------------------------------- */
  /* SCENARIO 3 — blocked, never dispatched                                 */
  /* --------------------------------------------------------------------- */

  it("SCENARIO 3 · delete_customer is blocked and never reaches the tool", async () => {
    const before = await count(CUSTOMER_TOOL);

    const result = await client.callTool({
      name: "delete_customer",
      arguments: { target: "customer:cus_sdk_0003" },
    });

    const governance = result.structuredContent as Record<string, unknown>;
    expect(governance.decision).toBe("BLOCK");
    expect(governance.attempted).toBe(false);
    expect(governance.succeeded).toBe(false);
    expect(result.isError).toBe(true);
    expect(await count(CUSTOMER_TOOL)).toBe(before);
  });

  /* --------------------------------------------------------------------- */
  /* SCENARIO 4 — unknown action must never reach downstream                */
  /* --------------------------------------------------------------------- */

  describe("SCENARIO 4 · an unknown action never reaches the downstream", () => {
    /*
     * WHERE THE MCP SURFACE STOPS IT, AND WHY THAT IS NOT `BLOCK`
     * -----------------------------------------------------------
     * On the HTTP surface an undeclared verb is refused by the policy engine
     * and the answer is the decision BLOCK (Phase 8A). On MCP it is refused one
     * layer earlier: `unknown.internal_action` is not in the listing this agent
     * was shown, and the specification is explicit that failing to FIND a tool
     * is a protocol error, not a tool result. So the honest description is that
     * the two surfaces refuse it at different layers, and this test asserts the
     * MCP-correct behaviour rather than pretending the payloads match.
     *
     * The requirement the brief actually states — UNKNOWN ACTION MUST NEVER
     * REACH DOWNSTREAM — is satisfied either way, and is what the counters
     * below verify. `mcp-transport-equivalence.test.ts` states the relationship
     * between the two surfaces in one place rather than leaving it implied.
     */
    it("is refused as a protocol error, not answered as a tool result", async () => {
      const beforeRefund = await count(REFUND_TOOL);
      const beforeCustomer = await count(CUSTOMER_TOOL);

      await expect(
        client.callTool({
          name: "unknown.internal_action",
          arguments: { target: "internal:thing" },
        }),
      ).rejects.toThrow();

      // Nothing moved anywhere.
      expect(await count(REFUND_TOOL)).toBe(beforeRefund);
      expect(await count(CUSTOMER_TOOL)).toBe(beforeCustomer);
    });

    it("is not silently listed as callable", async () => {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(names).not.toContain("unknown.internal_action");
    });
  });
});
