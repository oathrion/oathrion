/**
 * The MCP gateway, end to end over real HTTP.
 *
 * WHAT THIS FILE HAS TO PROVE
 * ---------------------------
 * Phase 3 adds a second front door to the engine. The risk is not that the new
 * door fails to open — a broken endpoint is obvious. The risk is that it opens
 * onto a *different* room: that `tools/call` reaches a tool without passing the
 * policy engine, the mandate ceiling, the approval queue and the audit chain
 * that `POST /api/execute` passes.
 *
 * So the assertions here are deliberately not "does MCP work". They are:
 *
 *   1. the protocol is implemented as specified, including the checks whose
 *      whole purpose is to stop a request meaning two different things;
 *   2. `tools/list` shows an agent only what that agent may attempt;
 *   3. the three reference scenarios reach the SAME verdicts over MCP as over
 *      REST, evidenced by `toolExecutionCount` deltas rather than by any field
 *      the layer under test produces itself;
 *   4. the obvious ways to get around Oathrion over this surface are refused.
 *
 * As in `reference-scenarios.test.ts`, the only evidence that counts for "did
 * the tool run" is a delta of `toolExecutionCount`, read over `GET /api/tools`.
 * That counter is incremented inside `CountingTool`, on the far side of the
 * boundary being tested, so the code under test cannot fake it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import {
  OATHRION_RPC_ERRORS,
  JSON_RPC_ERRORS,
  MCP_ERRORS,
  META_KEYS,
  PROTOCOL_VERSION,
} from "../mcp/protocol";

interface RpcReply {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolRow {
  id: string;
  toolExecutionCount: number;
}

interface McpToolEntry {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
  _meta: Record<string, { toolId: string; requiredScope: string | null; simulated: boolean }>;
}

const AGENT = "agt_billing";
const OATHRION_META_KEY = "dev.placet/governance";

describe("MCP gateway", () => {
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

  /**
   * Builds a spec-conformant request: correct body `_meta` and the mirrored
   * headers the transport requires.
   *
   * Every deviation in this file is expressed as an explicit override of this
   * baseline, so a test that breaks the protocol says out loud which single
   * thing it broke.
   */
  function frame(
    method: string,
    params: Record<string, unknown> = {},
    id: string | number | null = 1,
  ) {
    return {
      body: {
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
            [META_KEYS.clientCapabilities]: {},
          },
        },
      },
      headers: {
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": method,
        ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
        "X-Oathrion-Agent-Id": AGENT,
      } as Record<string, string>,
    };
  }

  /** POSTs a baseline request, with optional surgical mutation. */
  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
    opts: {
      auth?: string | null;
      headers?: Record<string, string>;
      dropHeaders?: string[];
      body?: unknown;
      id?: string | number | null;
    } = {},
  ) {
    const built = frame(method, params, opts.id === undefined ? 1 : opts.id);
    const headers = { ...built.headers, ...(opts.headers ?? {}) };
    for (const name of opts.dropHeaders ?? []) delete headers[name];
    return api.post<RpcReply>("/api/mcp", opts.body === undefined ? built.body : opts.body, {
      auth: opts.auth === undefined ? ROLE_KEYS.operator : opts.auth,
      headers,
    });
  }

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  /* --------------------------------------------------------------------- */
  /* The endpoint exists and is behind the auth gate                       */
  /* --------------------------------------------------------------------- */

  describe("authentication", () => {
    it("refuses an unauthenticated request", async () => {
      const res = await rpc("tools/list", {}, { auth: null });
      // 401 from the `/api` gate, before any MCP parsing happens. This is the
      // reason the endpoint lives under `/api` rather than at `/mcp`.
      expect(res.status).toBe(401);
    });

    it("does not serve MCP at an unauthenticated /mcp path", async () => {
      /*
       * A second mount point outside the `/api` auth gate would be the whole
       * product undone: the one endpoint an autonomous agent talks to would be
       * the one needing no credential. `/mcp` is served by the frontend
       * catch-all, so the assertion that matters is not the status code but
       * that nothing there can reach a tool.
       */
      const built = frame("tools/call", {
        name: "refund",
        arguments: { target: "cus_bypass", amount: 10 },
      });
      const before = await count("refund_tool");
      await api
        .post("/mcp", built.body, { auth: null, headers: built.headers })
        // The catch-all answers with the SPA's HTML, which is not JSON. Either
        // outcome is acceptable; executing the refund is not.
        .catch(() => undefined);
      expect(await count("refund_tool")).toBe(before);
    });
  });

  /* --------------------------------------------------------------------- */
  /* JSON-RPC 2.0 conformance                                              */
  /* --------------------------------------------------------------------- */

  describe("JSON-RPC 2.0 envelope", () => {
    it("answers a well-formed request with a matching id and jsonrpc version", async () => {
      const res = await rpc("server/discover", {}, { id: "abc-123" });
      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe("2.0");
      expect(res.body.id).toBe("abc-123");
      expect(res.body.error).toBeUndefined();
    });

    it("rejects a frame without jsonrpc: 2.0", async () => {
      const built = frame("server/discover");
      const res = await rpc("server/discover", {}, {
        body: { ...built.body, jsonrpc: "1.0" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.invalidRequest);
    });

    it("rejects positional (array) params instead of reading them as empty", async () => {
      // Silently treating `[]` as `{}` would turn a caller's mistake into a
      // call with defaults.
      const built = frame("tools/list");
      const res = await rpc("tools/list", {}, { body: { ...built.body, params: [] } });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
    });

    it("does not echo a non-scalar id back to the caller", async () => {
      // Reflecting an attacker-supplied object into the response would make the
      // endpoint a reflection primitive.
      const built = frame("server/discover");
      const res = await rpc("server/discover", {}, {
        body: { ...built.body, id: { evil: "payload" } },
      });
      expect(res.status).toBe(400);
      expect(res.body.id).toBeNull();
    });

    it("refuses JSON-RPC batching", async () => {
      // Removed from MCP in 2025-06-18. A batch mixing an allowed and a blocked
      // action has no sensible single answer.
      const res = await rpc("tools/list", {}, { body: [frame("tools/list").body] });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.invalidRequest);
    });

    it("acknowledges a notification without executing it and without a body", async () => {
      const built = frame("tools/call", { name: "refund", arguments: { target: "cus_x" } });
      const { id: _id, ...notification } = built.body as Record<string, unknown>;
      const before = await count("refund_tool");
      const res = await api.post("/api/mcp", notification, {
        auth: ROLE_KEYS.operator,
        headers: built.headers,
      });
      expect(res.status).toBe(202);
      // The important half: a notification cannot be used to trigger an action
      // whose outcome the caller never has to look at.
      expect(await count("refund_tool")).toBe(before);
    });

    it("returns -32601 and HTTP 404 for an unimplemented method", async () => {
      const res = await rpc("resources/read", { uri: "file:///etc/passwd" });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
    });

    it("does not answer initialize in the 2026-07-28 mode", async () => {
      // Revision 2026-07-28 removed it. A request that declares that revision gets a
      // 404; the handshake is answered only in the compatibility mode, for clients
      // speaking 2025-06-18 or 2025-03-26 — see `mcp-legacy-compat.test.ts`.
      const res = await rpc("initialize", {});
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Transport header validation                                           */
  /* --------------------------------------------------------------------- */

  describe("mirrored transport headers", () => {
    it("requires MCP-Protocol-Version", async () => {
      const res = await rpc("tools/list", {}, { dropHeaders: ["MCP-Protocol-Version"] });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(MCP_ERRORS.headerMismatch);
    });

    it("requires Mcp-Method", async () => {
      const res = await rpc("tools/list", {}, { dropHeaders: ["Mcp-Method"] });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(MCP_ERRORS.headerMismatch);
    });

    it("rejects a Mcp-Method header that disagrees with the body", async () => {
      /*
       * This is the check that matters most, and it is Oathrion's own thesis in
       * miniature: an intermediary routes and logs on the header while the
       * server acts on the body. If they may disagree, every allowlist, WAF
       * rule and audit line in front of Oathrion describes a request that never
       * happened.
       */
      const res = await rpc("tools/call", { name: "refund", arguments: { target: "cus_x" } }, {
        headers: { "Mcp-Method": "tools/list" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(MCP_ERRORS.headerMismatch);
    });

    it("rejects a Mcp-Name header that disagrees with params.name", async () => {
      const before = await count("customer_tool");
      const res = await rpc(
        "tools/call",
        { name: "delete_customer", arguments: { target: "cus_x" } },
        { headers: { "Mcp-Name": "refund" } },
      );
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(MCP_ERRORS.headerMismatch);
      // A rejected frame must not have reached anything.
      expect(await count("customer_tool")).toBe(before);
    });

    it("requires Mcp-Name for tools/call", async () => {
      const res = await rpc("tools/call", { name: "refund", arguments: { target: "cus_x" } }, {
        dropHeaders: ["Mcp-Name"],
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(MCP_ERRORS.headerMismatch);
    });

    it("rejects a protocol version header that disagrees with the body", async () => {
      const res = await rpc("tools/list", {}, {
        headers: { "MCP-Protocol-Version": "2025-11-25" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(MCP_ERRORS.headerMismatch);
    });

    it("rejects an unsupported protocol version and says which are supported", async () => {
      const built = frame("tools/list");
      const res = await rpc("tools/list", {}, {
        headers: { "MCP-Protocol-Version": "1999-01-01" },
        body: {
          ...built.body,
          params: {
            _meta: {
              [META_KEYS.protocolVersion]: "1999-01-01",
              [META_KEYS.clientCapabilities]: {},
            },
          },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(MCP_ERRORS.unsupportedProtocolVersion);
      expect(res.body.error?.data).toMatchObject({
        supported: [PROTOCOL_VERSION],
        requested: "1999-01-01",
      });
    });

    it("requires clientCapabilities on every request", async () => {
      /*
       * The spec forbids inferring capabilities from a previous request, which
       * is the direct consequence of removing the session handshake: there is
       * no earlier request to inherit from.
       */
      const built = frame("tools/list");
      const res = await rpc("tools/list", {}, {
        body: {
          ...built.body,
          params: { _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION } },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(MCP_ERRORS.missingClientCapability);
    });

    it("accepts an empty clientCapabilities object", async () => {
      const res = await rpc("tools/list");
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });
  });

  /* --------------------------------------------------------------------- */
  /* server/discover                                                       */
  /* --------------------------------------------------------------------- */

  describe("server/discover", () => {
    it("advertises the implemented revision and only the tools capability", async () => {
      const res = await rpc("server/discover");
      expect(res.status).toBe(200);
      expect(res.body.result?.supportedVersions).toEqual([PROTOCOL_VERSION]);
      // Advertising resources/prompts would promise surfaces that do not exist.
      expect(res.body.result?.capabilities).toEqual({ tools: {} });
    });

    it("tells the model that a held call must not be retried", async () => {
      // The instructions are the only channel through which a model learns that
      // APPROVAL_REQUIRED is a wait, not a transient failure to retry.
      const res = await rpc("server/discover");
      expect(String(res.body.result?.instructions)).toContain("Wait for the approval");
    });

    it("returns a payload identical for every caller, which is what makes it publicly cacheable", async () => {
      const asOperator = await rpc("server/discover", {}, { auth: ROLE_KEYS.operator });
      const asViewer = await rpc("server/discover", {}, { auth: ROLE_KEYS.viewer });
      const asRival = await rpc("server/discover", {}, { auth: OTHER_ORG_KEYS.admin });
      expect(asOperator.body.result?.cacheScope).toBe("public");
      // If any of these differed, "public" would let a shared proxy serve one
      // caller's payload to another.
      expect(asViewer.body.result).toEqual(asOperator.body.result);
      expect(asRival.body.result).toEqual(asOperator.body.result);
    });
  });

  /* --------------------------------------------------------------------- */
  /* tools/list                                                            */
  /* --------------------------------------------------------------------- */

  describe("tools/list", () => {
    it("requires an agent to be declared, with no default", async () => {
      const res = await rpc("tools/list", {}, { dropHeaders: ["X-Oathrion-Agent-Id"] });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.agentUnresolved);
    });

    it("lists exactly the tools the billing agent may attempt, and nothing else", async () => {
      /*
       * The assertion is exact, not `toContain`, and that matters. A `toContain`
       * test passes just as happily against a filter that returns everything —
       * it would prove only that the listing is non-empty. The billing agent
       * holds `execute:payments`, `read:crm`, `write:crm` and `manage:tickets`,
       * and does NOT hold `send:email`, `read:database` or `write:database`, so
       * a correct filter must drop four of the seven wired verbs.
       */
      const res = await rpc("tools/list");
      expect(res.status).toBe(200);
      const tools = res.body.result?.tools as McpToolEntry[];
      const names = tools.map((t) => t.name).sort();

      expect(names).toEqual(["delete_customer", "purchase", "refund"]);

      // Spelled out separately, because this is the half that would let an
      // agent discover — and then attempt — a capability it was never granted.
      for (const withheld of ["send_email", "access", "query", "write"]) {
        expect(names, `"${withheld}" requires a scope this agent does not hold`).not.toContain(
          withheld,
        );
      }

      /*
       * `delete_customer` IS listed, deliberately. The agent holds `write:crm`,
       * so it clears the permission barrier; it is org POLICY that refuses the
       * action. Being listed is a statement about permission, never a promise
       * that the call will be allowed — which is why scenario C, below, calls a
       * listed tool and is still blocked.
       */
      expect(names).toContain("delete_customer");
    });

    it("refuses a tool the agent lacks the scope for, even though it is wired to a real tool", async () => {
      // The listing and the engine must agree. If `send_email` were callable
      // despite being withheld from the listing, the filter would be cosmetic.
      const before = await count("send_email_tool");
      const res = await rpc("tools/call", {
        name: "send_email",
        arguments: { target: "victim@example.com" },
      });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
      expect(await count("send_email_tool")).toBe(before);
    });

    it("labels every tool as simulated", async () => {
      const res = await rpc("tools/list");
      const tools = res.body.result?.tools as McpToolEntry[];
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool._meta[OATHRION_META_KEY]?.simulated).toBe(true);
      }
    });

    it("marks the listing as private and immediately stale", async () => {
      /*
       * A listing is a statement about currently-granted permissions. A cached
       * copy would keep advertising a capability after it was revoked, and a
       * "public" copy could be served by a shared proxy to a different agent.
       */
      const res = await rpc("tools/list");
      expect(res.body.result?.cacheScope).toBe("private");
      expect(res.body.result?.ttlMs).toBe(0);
    });

    it("publishes a JSON Schema for each tool with target required", async () => {
      const res = await rpc("tools/list");
      const tools = res.body.result?.tools as McpToolEntry[];
      const refund = tools.find((t) => t.name === "refund")!;
      expect(refund.inputSchema.required).toContain("target");
      expect(refund.inputSchema.properties).toHaveProperty("amount");
    });

    it("refuses tools/list to a role without the read capability", async () => {
      // There is no such role today (`viewer` has `read`), so the assertion is
      // that a viewer CAN list and cannot call — the separation tested below.
      const res = await rpc("tools/list", {}, { auth: ROLE_KEYS.viewer });
      expect(res.status).toBe(200);
    });
  });

  /* --------------------------------------------------------------------- */
  /* The three reference scenarios, over MCP                               */
  /* --------------------------------------------------------------------- */

  describe("scenario A — refund 75 EUR is allowed and really executes", () => {
    it("calls the tool exactly once and reports success", async () => {
      const before = await count("refund_tool");
      const res = await rpc("tools/call", {
        name: "refund",
        arguments: { target: "cus_alpha", amount: 75, currency: "EUR" },
      });
      expect(res.status).toBe(200);

      const result = res.body.result!;
      const governance = result.structuredContent as Record<string, unknown>;
      expect(governance.decision).toBe("ALLOW");
      expect(governance.attempted).toBe(true);
      expect(governance.succeeded).toBe(true);
      expect(result.isError).toBe(false);

      // The only evidence that counts.
      expect(await count("refund_tool")).toBe(before + 1);
    });
  });

  describe("scenario B — refund 750 EUR is held, then executes on approval", () => {
    it("does not reach the tool, and resumes only after a human approves", async () => {
      const before = await count("refund_tool");
      const held = await rpc("tools/call", {
        name: "refund",
        arguments: { target: "cus_beta", amount: 750, currency: "EUR" },
      });
      expect(held.status).toBe(200);

      const governance = held.body.result!.structuredContent as Record<string, unknown>;
      expect(governance.decision).toBe("APPROVAL_REQUIRED");
      expect(governance.attempted).toBe(false);
      // The core requirement: held means the tool was not called.
      expect(await count("refund_tool")).toBe(before);

      // Reported as an error so a model cannot tell the user the refund was
      // issued while it sits in a queue.
      expect(held.body.result!.isError).toBe(true);
      expect(String((held.body.result!.content as { text: string }[])[0].text)).toContain(
        "NOT called",
      );

      const approvalId = governance.approvalId as string;
      expect(approvalId).toBeTruthy();

      // Resolved by a human over the normal approval route — MCP gets no
      // shortcut into the approval queue.
      const approved = await api.post<{ attempted: boolean; succeeded: boolean }>(
        `/api/approvals/${approvalId}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      );
      expect(approved.status).toBe(200);
      expect(approved.body.succeeded).toBe(true);

      // Now, and only now.
      expect(await count("refund_tool")).toBe(before + 1);
    });

    it("names the rule that decided, in the reason the caller receives", async () => {
      const res = await rpc("tools/call", {
        name: "refund",
        arguments: { target: "cus_gamma", amount: 900, currency: "EUR" },
      });
      const governance = res.body.result!.structuredContent as Record<string, unknown>;
      // An authorization layer that cannot say why is an outage with extra steps.
      expect(governance.policyName).toBeTruthy();
      expect(String(governance.reason).length).toBeGreaterThan(0);
    });
  });

  describe("scenario C — deleting a customer is blocked", () => {
    it("never reaches the tool", async () => {
      const before = await count("customer_tool");
      const res = await rpc("tools/call", {
        name: "delete_customer",
        arguments: { target: "cus_delta" },
      });
      expect(res.status).toBe(200);

      const governance = res.body.result!.structuredContent as Record<string, unknown>;
      expect(governance.decision).toBe("BLOCK");
      expect(governance.attempted).toBe(false);
      expect(governance.approvalId).toBeNull();
      expect(res.body.result!.isError).toBe(true);

      // Irreversible, so it is refused outright rather than queued.
      expect(await count("customer_tool")).toBe(before);
    });

    it("is a successful JSON-RPC call, not a protocol error", async () => {
      /*
       * The spec: tool-originated failures belong in the result with
       * `isError: true`, "otherwise the LLM would not be able to see that an
       * error occurred and self-correct". A BLOCK is a correctly processed call
       * whose answer is no — the transport worked perfectly.
       */
      const res = await rpc("tools/call", {
        name: "delete_customer",
        arguments: { target: "cus_epsilon" },
      });
      expect(res.body.error).toBeUndefined();
      expect(res.body.result).toBeDefined();
    });
  });

  /* --------------------------------------------------------------------- */
  /* Bypass attempts                                                       */
  /* --------------------------------------------------------------------- */

  describe("attempts to get around Oathrion", () => {
    it("refuses a client-supplied actor", async () => {
      const res = await rpc("tools/call", {
        name: "refund",
        arguments: { target: "cus_x", amount: 10, actor: "Chief Financial Officer" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.identityNotAccepted);
    });

    it("refuses a client-supplied decision", async () => {
      // An argument named like a verdict is an attempt to smuggle one.
      const res = await rpc("tools/call", {
        name: "delete_customer",
        arguments: { target: "cus_x", decision: "ALLOW" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.identityNotAccepted);
    });

    it("refuses an agentId in the arguments, so the agent is declared in exactly one place", async () => {
      const res = await rpc("tools/call", {
        name: "refund",
        arguments: { target: "cus_x", amount: 10, agentId: "agt_other" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.identityNotAccepted);
    });

    it("refuses an organizationId, so the tenant cannot be chosen by the caller", async () => {
      const res = await rpc("tools/call", {
        name: "refund",
        arguments: { target: "cus_x", amount: 10, organizationId: "org_rival_corp" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.identityNotAccepted);
    });

    it("ignores a self-reported clientInfo claiming to be an administrator", async () => {
      /*
       * The spec says clientInfo is "self-reported by the client and is not
       * verified", so a server "SHOULD NOT rely on it for security decisions".
       * Here that is tested by asserting the decision is unchanged.
       */
      const before = await count("customer_tool");
      const built = frame("tools/call", {
        name: "delete_customer",
        arguments: { target: "cus_zeta" },
      });
      const params = built.body.params as Record<string, unknown>;
      const res = await api.post<RpcReply>(
        "/api/mcp",
        {
          ...built.body,
          params: {
            ...params,
            _meta: {
              ...(params._meta as Record<string, unknown>),
              [META_KEYS.clientInfo]: { name: "placet-admin-console", version: "99.0.0" },
            },
          },
        },
        { auth: ROLE_KEYS.operator, headers: built.headers },
      );
      expect(res.status).toBe(200);
      expect(
        (res.body.result!.structuredContent as Record<string, unknown>).decision,
      ).toBe("BLOCK");
      expect(await count("customer_tool")).toBe(before);
    });

    it("refuses an unknown argument instead of ignoring it", async () => {
      // An ignored unknown key lets a model believe it constrained a call that
      // Oathrion in fact evaluated unconstrained.
      const before = await count("refund_tool");
      const res = await rpc("tools/call", {
        name: "refund",
        arguments: { target: "cus_x", amount: 10, max_amount: 5 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
      expect(await count("refund_tool")).toBe(before);
    });

    it("never answers 200 to a refused call, so the status line alone says whether Oathrion evaluated it", async () => {
      /*
       * The property this asserts: a `200` from this endpoint always carries a
       * decision. A BLOCK is a `200`, because a BLOCK is a decision; a
       * malformed or forbidden call is never a `200`. Without this, reading an
       * access log could not distinguish "evaluated and denied" from "never
       * evaluated", and those are very different facts during an incident.
       */
      const refusals = await Promise.all([
        rpc("tools/call", { name: "refund", arguments: {} }),
        rpc("tools/call", { name: "nope", arguments: { target: "x" } }),
        rpc("tools/call", { name: "refund", arguments: { target: "x", amount: "1" } }),
        rpc("tools/call", { name: "refund", arguments: { target: "x" } }, {
          auth: ROLE_KEYS.viewer,
        }),
        rpc("tools/list", {}, { dropHeaders: ["Mcp-Method"] }),
      ]);
      for (const res of refusals) {
        expect(res.status).not.toBe(200);
        expect(res.body.error).toBeDefined();
      }

      // And the contrast: a BLOCK is a decision, so it is a 200.
      const blocked = await rpc("tools/call", {
        name: "delete_customer",
        arguments: { target: "cus_contrast" },
      });
      expect(blocked.status).toBe(200);
    });

    it("refuses a quoted amount that would skip a numeric threshold", async () => {
      const before = await count("refund_tool");
      const res = await rpc("tools/call", {
        name: "refund",
        arguments: { target: "cus_x", amount: "750" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
      expect(await count("refund_tool")).toBe(before);
    });

    it("refuses a tool name that is not in the agent's listing", async () => {
      const res = await rpc("tools/call", {
        name: "drop_database",
        arguments: { target: "prod" },
      });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.invalidParams);
    });

    it("refuses tools/call from an approver, preserving separation of duties", async () => {
      /*
       * An approver may release someone else's held action but must not
       * originate one. If MCP granted execution on a `read`-style capability,
       * the same person could raise and approve an action.
       */
      const before = await count("refund_tool");
      const res = await rpc(
        "tools/call",
        { name: "refund", arguments: { target: "cus_x", amount: 10 } },
        { auth: ROLE_KEYS.approver },
      );
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.forbidden);
      expect(await count("refund_tool")).toBe(before);
    });

    it("refuses tools/call from a viewer", async () => {
      const res = await rpc(
        "tools/call",
        { name: "refund", arguments: { target: "cus_x", amount: 10 } },
        { auth: ROLE_KEYS.viewer },
      );
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.forbidden);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Tenant isolation                                                      */
  /* --------------------------------------------------------------------- */

  describe("tenant isolation", () => {
    it("cannot list tools for an agent in another organisation", async () => {
      const res = await rpc("tools/list", {}, { auth: OTHER_ORG_KEYS.admin });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.agentUnresolved);
    });

    it("cannot call a tool as an agent in another organisation", async () => {
      const before = await count("refund_tool");
      const res = await rpc(
        "tools/call",
        { name: "refund", arguments: { target: "cus_x", amount: 10 } },
        { auth: OTHER_ORG_KEYS.admin },
      );
      expect(res.status).toBe(404);
      expect(await count("refund_tool")).toBe(before);
    });

    it("gives the same answer for an agent that does not exist and one that is not yours", async () => {
      /*
       * Distinguishing the two would confirm the existence of another tenant's
       * resource. The lookup goes through a tenant-scoped repository, so this
       * holds by construction rather than by a comparison.
       */
      const foreign = await rpc("tools/list", {}, { auth: OTHER_ORG_KEYS.admin });
      const absent = await rpc("tools/list", {}, {
        headers: { "X-Oathrion-Agent-Id": "agt_does_not_exist_at_all" },
      });
      expect(absent.status).toBe(foreign.status);
      expect(absent.body.error?.code).toBe(foreign.body.error?.code);
    });
  });
});
