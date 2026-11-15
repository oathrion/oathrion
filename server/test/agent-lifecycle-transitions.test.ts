/**
 * Phase 7 — the agent lifecycle has no dead end: DRAFT → ACTIVE → PAUSED → ACTIVE.
 *
 * ## Why this file exists when the console rule is already tested
 *
 * `client/src/lib/agent-presentation.test.ts` pins the *console's* rule: a `draft`
 * agent shows an enabled "Activate agent" button. That test asserts a pure function
 * over a status string. It cannot fail if the server refuses the PATCH the button
 * sends, and it cannot fail if the agent activates but is still blocked at decision
 * time. Both would be a deadlock the user experiences as "I created an agent and it
 * can never do anything", with a green suite.
 *
 * `server/test/agent-binding-adversarial.test.ts` covers the other half — a `draft`
 * or `paused` agent is BLOCKed — but it creates its fixtures `active` and patches
 * them *down*. Nothing exercised the direction that matters for a new user: an agent
 * that is born `draft`, activated, and then actually acts.
 *
 * So the transition the product depends on was covered at both ends and untested in
 * the middle. This file drives the whole cycle over HTTP against a real server, and
 * measures each state by the only thing that counts: whether an action reaches the
 * downstream.
 *
 * ## What is asserted, and in what order
 *
 *  1. An agent created as `draft` is refused — fail-closed, and refused for its
 *     status rather than for a missing scope, which is asserted separately below.
 *  2. `PATCH { status: "active" }` from `draft` succeeds. This is the transition
 *     whose absence would be the deadlock.
 *  3. The same action now reaches the real downstream. "Activated" is not accepted
 *     as a status field flipping; it is accepted when the tool runs.
 *  4. `active → paused` refuses again, and reaches nothing.
 *  5. `paused → active` restores it. A one-way pause is the same deadlock wearing a
 *     different status.
 *  6. The console's shared rule and the server agree at every step, compared
 *     directly rather than by inspection, so the two layers cannot drift into
 *     disagreeing about what is activatable.
 *
 * ## What this file does NOT claim
 *
 * It does not claim `review` is reachable or resolvable. `review` has no transition
 * in the product today: the console renders it as unavailable with a reason, and no
 * route sets it. That is pinned below as the current, deliberate shape rather than
 * left ambiguous — an agent parked in `review` by a direct database write is stuck,
 * and this file says so instead of implying a workflow that does not exist.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizationId } from "@shared/tenancy";
import { organizationStore } from "../repositories/organizations";
import { userStore } from "../repositories/users";
import { hashPassword } from "../passwords";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { startTestServer, type RequestOptions, type TestClient } from "./harness";
import {
  agentToggleAffordance,
  agentToggleDisabled,
} from "../../client/src/lib/agent-presentation";
import type { AgentStatus } from "@shared/types";

const ORG = organizationId("org_default");
const ADMIN_EMAIL = "p7-lifecycle@placet.test";
const ADMIN_PASSWORD = "correct horse battery staple 7";

interface LoginBody {
  token: string;
}

interface IssuedKey {
  key: { id: string; agentId: string | null };
  secret: string;
}

interface DecisionBody {
  decision?: string;
  reason?: string;
  executionId?: string | null;
}

interface CallReply {
  result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  error?: { code: number; message: string };
}

describe("Phase 7 — agent lifecycle transitions", () => {
  let api: TestClient;
  let mock: MockDownstream;
  let mcp: LocalMcpServer;
  let previousUrl: string | undefined;
  let adminToken: string;

  /** A complete, schema-valid agent body. `agentCreateSchema` is strict. */
  function agentBody(id: string, name: string, status: AgentStatus) {
    return {
      id,
      name,
      description: "Phase 7 lifecycle fixture",
      provider: "openai" as const,
      model: "gpt-4o",
      status,
      owner: "p7-lifecycle",
      mandate: {
        maxTransactionAmount: 100,
        currency: "EUR" as const,
        allowedCategories: [],
        blockedCategories: [],
        allowedDomains: [],
      },
      permissions: [
        {
          /*
           * Granted deliberately. Without this scope a refusal would come from tool
           * visibility rather than from the status, and the test would keep passing
           * with the status check deleted — the mistake the Phase 6 report records
           * having made and corrected.
           */
          scope: "execute:payments" as const,
          label: "Issue refunds",
          description: "Granted so every refusal below is attributable to status alone",
          granted: true,
          risk: "medium" as const,
        },
      ],
      policyIds: [],
      tags: [],
      currentTask: null,
      createdAt: new Date().toISOString().slice(0, 10),
      executions24h: 0,
      successRate: 0,
      cost24h: 0,
      costMonth: 0,
      riskLevel: "low" as const,
    };
  }

  async function issueKey(name: string, agentId: string): Promise<IssuedKey> {
    const res = await api.post<IssuedKey>(
      "/api/keys",
      { name, role: "operator", agentId },
      { auth: adminToken },
    );
    expect(res.status, `issuing ${name}: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body;
  }

  function asKey(secret: string): RequestOptions {
    return { auth: secret };
  }

  async function decide(secret: string, target: string): Promise<DecisionBody> {
    const res = await api.post<DecisionBody>(
      "/api/evaluate",
      { action: "refund", target, amount: 10, currency: "EUR" },
      asKey(secret),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  /**
   * A `tools/call` through the MCP gateway — the path that can reach the downstream.
   *
   * The tool is named `refund`, the action verb the catalog exposes. The first version
   * of this file sent `stripe_refund` and got `-32602 Unknown tool`, which mattered
   * beyond a typo: the DRAFT step below asserts "the downstream was not reached", and
   * an unknown tool satisfies that for the wrong reason — the test would have gone on
   * passing with the status check deleted. The barrier measured has to be the one
   * under test, which is why step 6 asserts a *successful* call on the same name
   * before any refusal above it is believed.
   */
  async function callRefund(secret: string, agentId: string, target: string) {
    return api.post<CallReply>(
      "/api/mcp",
      {
        jsonrpc: "2.0",
        id: `p7-${target}`,
        method: "tools/call",
        params: {
          name: "refund",
          arguments: { amount: 10, currency: "EUR", target },
          _meta: {
            [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
            [META_KEYS.clientCapabilities]: {},
          },
        },
      },
      {
        auth: secret,
        headers: {
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "refund",
          "X-Oathrion-Agent-Id": agentId,
        },
      },
    );
  }

  async function downstreamCallCount(): Promise<number> {
    const response = await fetch(`${mock.url}/mock/received`);
    const payload = (await response.json()) as { calls: Array<{ path: string }> };
    return payload.calls.length;
  }

  async function setStatus(agentId: string, status: AgentStatus) {
    return api.patch<{ status?: string }>(`/api/agents/${agentId}`, { status }, { auth: adminToken });
  }

  beforeAll(async () => {
    mock = await startMockDownstream();
    mcp = await startLocalMcpServer(mock.url);
    previousUrl = process.env.OATHRION_LOCAL_MCP_URL;
    process.env.OATHRION_LOCAL_MCP_URL = mcp.url;
    api = await startTestServer();

    organizationStore.ensure(ORG, "P7 Lifecycle Org");
    const admin = userStore.ensure({
      email: ADMIN_EMAIL,
      name: "P7 Lifecycle Admin",
      passwordHash: hashPassword(ADMIN_PASSWORD),
      passwordSource: "user",
    });
    userStore.grant(ORG, admin.id, "admin");

    const login = await api.post<LoginBody>(
      "/api/auth/login",
      { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, organization: ORG },
      { auth: null },
    );
    expect(login.status).toBe(200);
    adminToken = login.body.token;
  });

  afterAll(async () => {
    await api.close();
    await mcp.close();
    await mock.close();
    if (previousUrl === undefined) delete process.env.OATHRION_LOCAL_MCP_URL;
    else process.env.OATHRION_LOCAL_MCP_URL = previousUrl;
  });

  describe("the full cycle, on one agent, in order", () => {
    /*
     * Deliberately ONE agent driven through every state in sequence, rather than
     * four agents each created in a target state. A per-state fixture would pass on
     * a server that accepts every status at creation and refuses every transition —
     * which is exactly the deadlock. The order is the assertion.
     */
    const agentId = "agt_p7_cycle";
    let secret: string;

    it("1. is created in DRAFT, and the server stores DRAFT rather than promoting it", async () => {
      const created = await api.post(
        "/api/agents",
        agentBody(agentId, "P7 lifecycle cycle", "draft"),
        { auth: adminToken },
      );
      expect([200, 201], JSON.stringify(created.body)).toContain(created.status);

      // A server that quietly created it `active` would make every assertion below
      // pass for the wrong reason.
      const read = await api.get<{ status: string }>(`/api/agents/${agentId}`, {
        auth: adminToken,
      });
      expect(read.status).toBe(200);
      expect(read.body.status).toBe("draft");

      secret = (await issueKey("P7 cycle key", agentId)).secret;
    });

    it("2. is BLOCKed while DRAFT, and the refusal names the status", async () => {
      const body = await decide(secret, "cus_p7_draft");
      expect(body.decision).toBe("BLOCK");
      // Attribution: the scope is granted, so `draft` is the only thing left to
      // refuse on, and the reason has to say so.
      expect(body.reason ?? "").toContain("draft");
    });

    it("3. reaches no downstream while DRAFT, measured at the mock", async () => {
      const before = await downstreamCallCount();
      const reply = await callRefund(secret, agentId, "cus_p7_draft_tool");
      // Refused somewhere — status code or JSON-RPC error, both acceptable. What is
      // not acceptable is the downstream having moved.
      const refused = reply.status >= 400 || reply.body.error !== undefined || reply.body.result?.isError === true;
      expect(refused, JSON.stringify(reply.body)).toBe(true);
      expect(await downstreamCallCount()).toBe(before);
    });

    it("4. accepts DRAFT → ACTIVE — the transition whose absence is the deadlock", async () => {
      const patched = await setStatus(agentId, "active");
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);

      const read = await api.get<{ status: string }>(`/api/agents/${agentId}`, {
        auth: adminToken,
      });
      expect(read.body.status).toBe("active");
    });

    it("5. is ALLOWed once ACTIVE", async () => {
      const body = await decide(secret, "cus_p7_active");
      expect(body.decision).toBe("ALLOW");
    });

    it("6. really reaches the downstream once ACTIVE", async () => {
      /*
       * The assertion that makes the four above mean something. A status field that
       * flips while the action still never runs is not an activated agent.
       */
      const before = await downstreamCallCount();
      const reply = await callRefund(secret, agentId, "cus_p7_active_tool");
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body.error).toBeUndefined();
      expect(reply.body.result?.isError ?? false).toBe(false);
      expect(await downstreamCallCount()).toBe(before + 1);
    });

    it("7. accepts ACTIVE → PAUSED and refuses again, reaching nothing", async () => {
      expect((await setStatus(agentId, "paused")).status).toBe(200);

      const body = await decide(secret, "cus_p7_paused");
      expect(body.decision).toBe("BLOCK");
      expect(body.reason ?? "").toContain("paused");

      const before = await downstreamCallCount();
      await callRefund(secret, agentId, "cus_p7_paused_tool");
      expect(await downstreamCallCount()).toBe(before);
    });

    it("8. accepts PAUSED → ACTIVE, and the agent acts again", async () => {
      /*
       * A pause that cannot be undone is the same product failure as a draft that
       * cannot be activated, so it is asserted with the same strength: the decision
       * AND the downstream.
       */
      expect((await setStatus(agentId, "active")).status).toBe(200);

      const body = await decide(secret, "cus_p7_resumed");
      expect(body.decision).toBe("ALLOW");

      const before = await downstreamCallCount();
      const reply = await callRefund(secret, agentId, "cus_p7_resumed_tool");
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(await downstreamCallCount()).toBe(before + 1);
    });

    it("9. survives a second full lap, so no transition is one-shot", async () => {
      // A state machine that allows each edge exactly once is a deadlock with a
      // delay. Cheap to assert, and it would not have been noticed otherwise.
      for (const lap of [1, 2]) {
        expect((await setStatus(agentId, "paused")).status, `lap ${lap} pause`).toBe(200);
        expect((await decide(secret, `cus_p7_lap${lap}_paused`)).decision).toBe("BLOCK");
        expect((await setStatus(agentId, "active")).status, `lap ${lap} resume`).toBe(200);
        expect((await decide(secret, `cus_p7_lap${lap}_active`)).decision).toBe("ALLOW");
      }
    });
  });

  describe("the console and the server agree about what is activatable", () => {
    /*
     * The console's rule is a pure function; the server's rule is a route. Nothing
     * previously compared them, so they were free to drift — and the deadlock this
     * phase checks for was originally a drift of exactly this kind (the console
     * disabled a button the server would have honoured).
     */
    const cases: { from: AgentStatus; to: AgentStatus }[] = [
      { from: "draft", to: "active" },
      { from: "paused", to: "active" },
      { from: "active", to: "paused" },
    ];

    for (const { from, to } of cases) {
      it(`offers ${from} → ${to} in the console, and the server performs it`, async () => {
        const affordance = agentToggleAffordance(from);
        expect(affordance.next, `console's next state for ${from}`).toBe(to);
        expect(affordance.unavailable, `console must offer ${from} → ${to}`).toBe(false);
        expect(agentToggleDisabled(from, true)).toBe(false);

        const id = `agt_p7_pair_${from}`;
        const created = await api.post("/api/agents", agentBody(id, `P7 pair ${from}`, from), {
          auth: adminToken,
        });
        expect([200, 201], JSON.stringify(created.body)).toContain(created.status);

        const patched = await setStatus(id, to);
        expect(patched.status, `server refused ${from} → ${to}: ${JSON.stringify(patched.body)}`).toBe(200);

        const read = await api.get<{ status: string }>(`/api/agents/${id}`, { auth: adminToken });
        expect(read.body.status).toBe(to);
      });
    }

    it("pins `review` as the one status the console offers no transition for", () => {
      /*
       * Not a bug being tested as a feature — a documented absence. `review` has no
       * workflow in the product: no route sets it, and the console says why it is
       * unavailable instead of showing a button that would do nothing. If a review
       * workflow is added later, this test fails and forces the console, the server
       * and this pin to be updated together.
       */
      const affordance = agentToggleAffordance("review");
      expect(affordance.unavailable).toBe(true);
      expect(affordance.unavailableReason ?? "").not.toBe("");
      expect(agentToggleDisabled("review", true)).toBe(true);
    });

    it("refuses a transition to a status outside the enum", async () => {
      // Fail-closed on the write path: an unknown status must be a 400, never a
      // stored value that no rule in the product knows how to interpret.
      const res = await api.patch(
        `/api/agents/agt_p7_cycle`,
        { status: "retired" },
        { auth: adminToken },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("lifecycle writes stay inside the tenant", () => {
    it("reports 404, never 403, when activating an agent of another organization", async () => {
      /*
       * `agt_rival_ops` belongs to `org_rival_corp`. A 403 would confirm the id
       * exists; 404 is the answer that leaks nothing, and it is the answer the rest
       * of the product already gives — asserted here so the lifecycle route is not
       * the one place that differs.
       */
      const res = await api.patch(
        "/api/agents/agt_rival_ops",
        { status: "active" },
        { auth: adminToken },
      );
      expect(res.status).toBe(404);
    });

    it("refuses a lifecycle change from a role without agent administration", async () => {
      const res = await api.patch(
        "/api/agents/agt_p7_cycle",
        { status: "paused" },
        { auth: "test-viewer-key-123456" },
      );
      expect(res.status).toBe(403);
    });
  });
});
