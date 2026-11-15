/**
 * POST /api/evaluate — the generic HTTP authorization surface.
 *
 * This is the endpoint any agent can reach, on any stack, without MCP and
 * without a framework. The contract it implements is defined once in
 * `shared/api/evaluate-contract.ts` and reused by the server, both SDKs, the
 * CLI, the examples and the documentation, so this file is also the test that
 * pins that shared definition.
 *
 * WHAT IS BEING PROVED HERE
 * -------------------------
 * Not "the endpoint returns 200". The chain the product claims is
 *
 *     Agent -> Identity -> Policy -> Decision -> Approval -> Execution -> Audit
 *
 * and each link is asserted separately, because a break in any one of them
 * produces a response that still looks correct from the outside. In particular
 * the fail-closed rule is checked at this boundary and not only in the engine:
 * an undeclared action must be BLOCKed *by the HTTP surface a real integrator
 * calls*, and it must never reach a downstream tool.
 *
 * A NOTE ON WHY EVERY DECISION IS HTTP 200
 * ----------------------------------------
 * BLOCK is Oathrion working. It is not a client error and it is not a server error.
 * The tests below assert the status explicitly, because the day someone
 * "improves" BLOCK into a 403 is the day every client's retry-on-non-2xx path
 * starts hammering a rule that will never change its mind, and the day a
 * `try/catch` around the call starts swallowing refusals.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OTHER_ORG_KEYS,
  ROLE_KEYS,
  startTestServer,
  TEST_CONSOLE_EMAIL,
  TEST_CONSOLE_PASSWORD,
  type TestClient,
} from "./harness";
import type { ApiErrorResponse, DecisionResponse } from "@shared/api/evaluate-contract";

/** Seeded, active, and owns both `refund` and `delete_customer`. */
const AGENT = "agt_billing";

/** Seeded with status `paused` — a real non-active agent, not a fabricated one. */
const PAUSED_AGENT = "agt_recruiting";

/** Seeded with status `draft`. */
const DRAFT_AGENT = "agt_infra";

const REFUND_TOOL = "refund_tool";
const CUSTOMER_TOOL = "customer_tool";

interface ToolRow {
  id: string;
  toolExecutionCount: number;
}

describe("POST /api/evaluate — generic HTTP authorization contract", () => {
  let api: TestClient;
  /**
   * A console session, not an API key. Issuing a credential is deliberately not
   * something a credential can do: `POST /api/keys` refuses any identity that
   * is not a signed-in user, so a stolen operator key cannot mint itself more.
   */
  let adminToken: string;

  /** Live downstream invocation counter, read over the API. */
  async function count(toolId: string): Promise<number> {
    const res = await api.get<ToolRow[]>("/api/tools", { auth: ROLE_KEYS.admin });
    expect(res.status).toBe(200);
    const row = res.body.find((t) => t.id === toolId);
    // Absence would make every "the tool was not called" assertion vacuous.
    expect(row, `tool "${toolId}" is not registered`).toBeDefined();
    return row!.toolExecutionCount;
  }

  function evaluate(body: unknown, auth: string = ROLE_KEYS.operator) {
    return api.post<DecisionResponse>("/api/evaluate", body, { auth });
  }

  beforeAll(async () => {
    api = await startTestServer();
    const login = await api.post<{ token: string }>(
      "/api/auth/login",
      { email: TEST_CONSOLE_EMAIL, password: TEST_CONSOLE_PASSWORD, organization: "org_default" },
      { auth: null },
    );
    expect(login.status).toBe(200);
    adminToken = login.body.token;
  });

  afterAll(async () => {
    await api.close();
  });

  /* ===================================================================== */
  /* 1. Declared action, policy allows                                     */
  /* ===================================================================== */

  describe("declared action within policy", () => {
    it("returns ALLOW, attributed to a named rule rather than to an absence", async () => {
      const res = await evaluate({
        agentId: AGENT,
        action: "refund",
        target: "customer:cus_http_0001",
        amount: 75,
        currency: "EUR",
      });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("ALLOW");
      /*
       * An ALLOW that says "no policy constrains this action" is an allow by
       * absence of a rule, which an operator cannot audit. This one has to name
       * the rule that was evaluated and satisfied.
       */
      expect(res.body.policyId).toBe("pol_refund_approval");
      expect(res.body.reason).toContain("Refund approval threshold");
    });

    it("writes nothing when persist is not requested", async () => {
      const before = await count(REFUND_TOOL);
      const res = await evaluate({
        agentId: AGENT,
        action: "refund",
        target: "customer:cus_http_0002",
        amount: 75,
        currency: "EUR",
      });

      expect(res.body.decision).toBe("ALLOW");
      // A dry run is a question, not an act: no execution, no audit, no tool.
      expect(res.body.persisted).toBe(false);
      expect(res.body.executionId).toBeNull();
      expect(res.body.attempted).toBe(false);
      expect(res.body.succeeded).toBe(false);
      expect(await count(REFUND_TOOL)).toBe(before);
    });
  });

  /* ===================================================================== */
  /* 2. Declared action, policy blocks                                     */
  /* ===================================================================== */

  it("returns BLOCK — as HTTP 200 — for a declared action a policy denies", async () => {
    const before = await count(CUSTOMER_TOOL);

    const res = await evaluate({
      agentId: AGENT,
      action: "delete_customer",
      target: "customer:cus_http_0003",
    });

    // 200, not 403. See the file header.
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("BLOCK");
    expect(res.body.policyId).toBe("pol_customer_deletion");
    expect(await count(CUSTOMER_TOOL)).toBe(before);
  });

  /* ===================================================================== */
  /* 3. Declared action, policy requires approval                          */
  /* ===================================================================== */

  it("returns APPROVAL_REQUIRED and names the threshold that was crossed", async () => {
    const res = await evaluate({
      agentId: AGENT,
      action: "refund",
      target: "customer:cus_http_0004",
      amount: 750,
      currency: "EUR",
    });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("APPROVAL_REQUIRED");
    expect(res.body.policyId).toBe("pol_refund_approval");
    expect(res.body.reason).toContain("500");
  });

  /* ===================================================================== */
  /* 4. Unknown action -> BLOCK, and never downstream                      */
  /* ===================================================================== */

  describe("undeclared actions are refused, fail-closed", () => {
    /*
     * The verbs below are the point of the whole posture. None is in the action
     * catalog, none is named by a policy, and none contains a word the
     * dangerous-name heuristic recognises. Before Phase 8 every one of them
     * came back ALLOW with the reason "No policy constrains this action."
     */
    const UNDECLARED = [
      "unknown.internal_action",
      "custom.company.operation",
      "my.internal.operation",
      "stripe.refund",
      "crm.update_record",
      "k8s.scale_down",
    ];

    it.each(UNDECLARED)("BLOCKs %s", async (action) => {
      const res = await evaluate({
        agentId: AGENT,
        action,
        target: "customer:cus_http_unknown",
      });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("BLOCK");
      // The refusal has to be legible: an operator must be able to tell this
      // apart from "a rule denied it" without reading the source.
      expect(res.body.reason).toContain("not a declared action");
    });

    it("never reaches a downstream tool, even when asked to persist", async () => {
      const beforeRefund = await count(REFUND_TOOL);
      const beforeCustomer = await count(CUSTOMER_TOOL);

      for (const action of UNDECLARED) {
        const res = await evaluate({
          agentId: AGENT,
          action,
          target: "customer:cus_http_unknown",
          // `persist: true` is the acting path, not the dry run. If anything
          // were going to dispatch, it would be this.
          persist: true,
        });
        expect(res.body.decision).toBe("BLOCK");
        expect(res.body.attempted).toBe(false);
        expect(res.body.succeeded).toBe(false);
        expect(res.body.toolId).toBeNull();
      }

      expect(await count(REFUND_TOOL)).toBe(beforeRefund);
      expect(await count(CUSTOMER_TOOL)).toBe(beforeCustomer);
    });

    it("is refused for the undeclared-action reason, not by accident", async () => {
      const res = await evaluate({
        agentId: AGENT,
        action: "custom.company.operation",
        target: "customer:cus_http_unknown",
        persist: true,
      });

      /*
       * Guards against a false green. A BLOCK here could also come from a
       * missing permission or a denying policy, and if the posture silently
       * stopped working those other barriers might keep this test passing while
       * the actual gap reopened for verbs they do not cover.
       */
      expect(res.body.decision).toBe("BLOCK");
      expect(res.body.policyId).toBe("sys_undeclared_action");
    });
  });

  /* ===================================================================== */
  /* 5. Authentication                                                     */
  /* ===================================================================== */

  describe("authentication", () => {
    it("refuses an absent credential without deciding", async () => {
      // `auth: null` and not an omitted option: the harness defaults a missing
      // `auth` to the admin key, so omitting it would test the opposite thing
      // and pass while proving nothing.
      const res = await api.post<DecisionResponse>(
        "/api/evaluate",
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_http_auth",
        },
        { auth: null },
      );

      expect(res.status).toBe(401);
      // The invariant every SDK depends on: a non-200 carries no decision.
      expect(res.body.decision).toBeUndefined();
    });

    it("refuses a wrong credential without deciding", async () => {
      const res = await evaluate(
        { agentId: AGENT, action: "refund", target: "customer:cus_http_auth" },
        "not-a-real-key-000000",
      );

      expect(res.status).toBe(401);
      expect(res.body.decision).toBeUndefined();
    });

    it("refuses to persist for a read-only credential", async () => {
      // A dry run needs `read`; asking the control plane to act needs `execute`.
      const dry = await evaluate(
        { agentId: AGENT, action: "refund", target: "customer:cus_http_ro", amount: 10, currency: "EUR" },
        ROLE_KEYS.viewer,
      );
      expect(dry.status).toBe(200);

      const acting = await evaluate(
        {
          agentId: AGENT,
          action: "refund",
          target: "customer:cus_http_ro",
          amount: 10,
          currency: "EUR",
          persist: true,
        },
        ROLE_KEYS.viewer,
      );
      expect(acting.status).toBe(403);
      expect(acting.body.decision).toBeUndefined();
    });
  });

  /* ===================================================================== */
  /* 6. Tenant isolation                                                   */
  /* ===================================================================== */

  it("does not let one organization evaluate against another's agent", async () => {
    /*
     * `agt_billing` belongs to org_default. A rival organization's admin key is
     * a perfectly valid credential — it just must not reach this agent. The
     * refusal must not be a decision, and it must not leak whether the agent
     * exists elsewhere by answering differently than it would for a name that
     * exists nowhere.
     */
    const foreign = await evaluate(
      { agentId: AGENT, action: "refund", target: "customer:cus_http_tenant", amount: 10, currency: "EUR" },
      OTHER_ORG_KEYS.admin,
    );

    const nonexistent = await evaluate(
      { agentId: "agt_does_not_exist_anywhere", action: "refund", target: "x", amount: 10, currency: "EUR" },
      OTHER_ORG_KEYS.admin,
    );

    expect(foreign.body.decision).toBeUndefined();
    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
  });

  /* ===================================================================== */
  /* 7. Credential bound to a different agent                              */
  /* ===================================================================== */

  it("refuses a credential bound to one agent when it names another", async () => {
    const created = await api.post<{ secret: string }>(
      "/api/keys",
      {
        name: "phase8-bound-to-billing",
        role: "operator",
        agentId: AGENT,
      },
      { auth: adminToken },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const boundKey = created.body.secret;
    expect(boundKey).toBeTruthy();

    // Its own agent: fine.
    const own = await evaluate(
      { agentId: AGENT, action: "refund", target: "customer:cus_http_bound", amount: 10, currency: "EUR" },
      boundKey,
    );
    expect(own.status).toBe(200);
    expect(own.body.decision).toBe("ALLOW");

    // Someone else's: refused, and refused without producing a decision.
    const other = await evaluate(
      { agentId: "agt_support", action: "refund", target: "customer:cus_http_bound", amount: 10, currency: "EUR" },
      boundKey,
    );
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(other.body.decision).toBeUndefined();
  });

  /* ===================================================================== */
  /* 8. Non-active agents                                                  */
  /* ===================================================================== */

  describe("agent lifecycle", () => {
    it.each([
      ["paused", PAUSED_AGENT],
      ["draft", DRAFT_AGENT],
    ])("does not ALLOW an action for a %s agent", async (_status, agentId) => {
      const res = await evaluate({
        agentId,
        action: "refund",
        target: "customer:cus_http_lifecycle",
        amount: 10,
        currency: "EUR",
        persist: true,
      });

      /*
       * Asserted as "not ALLOW" rather than as one exact code, because the
       * lifecycle rules are owned by `agent-lifecycle-transitions.test.ts` and
       * duplicating its exact expectations here would make this file fail for
       * reasons that have nothing to do with the HTTP contract. What this
       * endpoint must guarantee is narrower and non-negotiable: a non-active
       * agent does not get permission through it.
       */
      if (res.status === 200) {
        expect(res.body.decision).not.toBe("ALLOW");
        expect(res.body.attempted).toBe(false);
      } else {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.body.decision).toBeUndefined();
      }
    });
  });

  /* ===================================================================== */
  /* 9. Payload validation                                                 */
  /* ===================================================================== */

  describe("payload validation", () => {
    it.each([
      ["a missing action", { agentId: AGENT, target: "x" }],
      ["an empty action", { agentId: AGENT, action: "", target: "x" }],
      ["a missing target", { agentId: AGENT, action: "refund" }],
      ["an empty target", { agentId: AGENT, action: "refund", target: "" }],
      ["a misspelled field", { agentId: AGENT, action: "refund", target: "x", amont: 75 }],
      ["a non-object body", "refund everything"],
      ["an array body", [{ action: "refund" }]],
    ])("rejects %s with 400 and no decision", async (_label, body) => {
      const res = await evaluate(body);
      expect(res.status).toBe(400);
      expect(res.body.decision).toBeUndefined();
    });

    /*
     * Phase 8 defect P8-2. `express.json()` rejects an unreadable body before
     * any route runs, and used to answer with Express's built-in HTML page. The
     * status was already right, so nothing unsafe happened — but an SDK parsing
     * that response gets `SyntaxError: Unexpected token '<'` instead of a typed
     * error, and loses the request id. Asserted with raw `fetch` because the
     * harness's own client assumes JSON, which is precisely the assumption that
     * broke.
     */
    it.each([
      ["a bare JSON string", '"refund everything"'],
      ["a bare number", "123"],
      ["JSON null", "null"],
      ["syntactically invalid JSON", "{not json at all"],
    ])("answers %s with Oathrion's JSON error envelope, not an HTML page", async (_label, raw) => {
      const res = await fetch(new URL("/api/evaluate", api.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ROLE_KEYS.operator}`,
        },
        body: raw,
      });

      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");

      const body = (await res.json()) as ApiErrorResponse & { decision?: string };
      expect(body.message).toBeTruthy();
      expect(body.code).toBeTruthy();
      // Still fail-closed: an unreadable body produces no decision at all.
      expect(body.decision).toBeUndefined();
    });

    it("rejects an unknown key rather than silently dropping it", async () => {
      /*
       * The specific danger: `amont: 750` dropped in silence evaluates a €750
       * refund as an amount-less action, against a rule written to bound the
       * amount. Strictness here is a security property, not tidiness.
       */
      const res = await evaluate({
        agentId: AGENT,
        action: "refund",
        target: "customer:cus_http_typo",
        amont: 750,
        currency: "EUR",
      });
      expect(res.status).toBe(400);
      expect(res.body.decision).toBeUndefined();
    });
  });

  /* ===================================================================== */
  /* 10. Documented aliases and the `input` bag                            */
  /* ===================================================================== */

  describe("developer-facing field names", () => {
    it("accepts `agent` and `resource` as documented aliases", async () => {
      const res = await evaluate({
        agent: AGENT,
        action: "refund",
        resource: "customer:cus_http_alias",
        amount: 75,
        currency: "EUR",
      });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("ALLOW");
    });

    it("reads policy-relevant parameters out of `input`", async () => {
      // Proof that `input` is really the metadata bag the engine reads, not a
      // field that is accepted and then ignored: the amount inside it has to
      // cross the €500 threshold.
      const res = await evaluate({
        agentId: AGENT,
        action: "refund",
        target: "customer:cus_http_input",
        input: { amount: 750, currency: "EUR" },
      });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("APPROVAL_REQUIRED");
      expect(res.body.policyId).toBe("pol_refund_approval");
    });

    it.each([
      ["agent and agentId", { agent: AGENT, agentId: AGENT, action: "refund", target: "x" }],
      ["resource and target", { agent: AGENT, action: "refund", resource: "x", target: "x" }],
      [
        "input and metadata",
        { agentId: AGENT, action: "refund", target: "x", input: { a: 1 }, metadata: { b: 2 } },
      ],
    ])("refuses %s together instead of choosing one", async (_label, body) => {
      const res = await evaluate(body);
      expect(res.status).toBe(400);
      expect(res.body.decision).toBeUndefined();
      expect(String((res.body as unknown as ApiErrorResponse).message ?? "")).toContain("not both");
    });
  });

  /* ===================================================================== */
  /* 11. Audit                                                             */
  /* ===================================================================== */

  describe("audit", () => {
    it("records a persisted ALLOW with its decision and its side effect, in order", async () => {
      const res = await evaluate({
        agentId: AGENT,
        action: "refund",
        target: "customer:cus_http_audit",
        amount: 40,
        currency: "EUR",
        persist: true,
      });

      expect(res.body.decision).toBe("ALLOW");
      const executionId = res.body.executionId;
      expect(executionId).toBeTruthy();

      const stored = await api.get<{ audit: { event: string }[]; runState: string }>(
        `/api/executions/${executionId}`,
        { auth: ROLE_KEYS.viewer },
      );
      expect(stored.status).toBe(200);
      expect(stored.body.runState).toBe("succeeded");

      const events = stored.body.audit.map((e) => e.event);
      expect(events).toContain("Policy evaluated");
      expect(events).toContain("Tool execution started");
      expect(events).toContain("Tool execution completed");
      // The decision must precede the side effect, not merely coexist with it.
      expect(events.indexOf("Policy evaluated")).toBeLessThan(
        events.indexOf("Tool execution started"),
      );
    });

    it("records a persisted BLOCK, so a refusal is auditable too", async () => {
      const res = await evaluate({
        agentId: AGENT,
        action: "delete_customer",
        target: "customer:cus_http_audit_block",
        persist: true,
      });

      expect(res.body.decision).toBe("BLOCK");
      expect(res.body.executionId).toBeTruthy();

      const stored = await api.get<{ audit: { event: string }[] }>(
        `/api/executions/${res.body.executionId}`,
        { auth: ROLE_KEYS.viewer },
      );
      expect(stored.status).toBe(200);
      const events = stored.body.audit.map((e) => e.event);
      expect(events).toContain("Policy evaluated");
      // A blocked action must show no dispatch, not merely a failed one.
      expect(events).not.toContain("Tool execution started");
    });
  });
  /**
   * P8-4 — the agent id grammar is enforced at the authorization entry point.
   *
   * Found by the Python SDK's integration test, which sent a deliberately
   * malformed id expecting a 400 and got a 404. The endpoint was validating
   * `agentId` as any non-empty string, so an id that could never name a real
   * agent went through to a registry lookup and came back "not found".
   *
   * Not a fail-open — nothing was authorised either way — but a contract the
   * docs described one way and the code applied another, and a client that
   * could not distinguish "my id is malformed" from "my id is unknown here".
   */
  describe("agent id grammar (P8-4)", () => {
    it("refuses a syntactically impossible agent id with 400, before any lookup", async () => {
      for (const bad of ["!!not-valid!!", "has space", "ab", "a".repeat(65), "semi;colon"]) {
        const res = await api.post<{ message?: string }>("/api/evaluate", {
          agentId: bad,
          action: "refund",
          target: "customer:cus_1",
        });
        expect(res.status, `agentId ${JSON.stringify(bad)} must be a 400`).toBe(400);
        // And never a decision, whatever else it is.
        expect(res.body).not.toHaveProperty("decision");
      }
    });

    it("still answers 404 for a well-formed id that names no agent", async () => {
      // The distinction that matters: this id is spelled correctly, so the
      // problem is configuration, not the client. Collapsing both onto one
      // status would have made that undiagnosable.
      const res = await api.post("/api/evaluate", {
        agentId: "agt_does_not_exist",
        action: "refund",
        target: "customer:cus_1",
      });
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty("decision");
    });

    it("accepts the ids real agents actually use", async () => {
      const res = await api.post<{ decision: string }>("/api/evaluate", {
        agentId: "agt_billing",
        action: "refund",
        target: "customer:cus_1",
        amount: 75,
        currency: "EUR",
      });
      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("ALLOW");
    });
  });
});
