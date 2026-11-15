/**
 * Phase 6.6 — the eleven adversarial cases the brief names, A through K.
 *
 * Every case here is exercised over HTTP against a real server with real
 * credentials issued through `POST /api/keys`, and — for the cases where it is
 * the point — against a real local MCP server and a real mock downstream, so
 * "the tool was not reached" is measured at the downstream rather than inferred
 * from a status code.
 *
 * WHAT "BOUND" MEANS, AND THE GAP THAT REMAINS
 * -------------------------------------------
 * A credential issued with an `agentId` is CONFINED to it: the agent id supplied
 * by the caller is never used, only compared. Cases B and C are the two ways to
 * supply one — the `X-Oathrion-Agent-Id` header and a body field — and both are
 * refused rather than honoured.
 *
 * A credential issued WITHOUT an `agentId` can still name any agent in its own
 * organisation. That is a real residual gap and it is tested as such at the
 * bottom of this file, not hidden: `OATHRION_REQUIRE_AGENT_BINDING=true` closes it,
 * and it is OFF by default because turning it on would refuse every key every
 * existing deployment holds the moment they upgrade. Both positions are
 * asserted. Nothing in this file should be read as "binding is mandatory".
 *
 * WHERE EACH CASE IS ENFORCED, WHICH IS NOT ALL ONE PLACE
 * ------------------------------------------------------
 * Cases A–D and the tenant half of E are the Phase 6 chokepoint,
 * `server/identity/agent-binding.ts`. Cases G and H were ALREADY enforced before
 * Phase 6 — `shared/policy/engine.ts` blocks any agent whose status is not
 * `active` — so those two add tests, not code, and say so rather than claiming
 * new work. Case F is the credential layer. Cases I–K are the policy engine and
 * the gateway, and exist here as the non-regression floor: the point of an
 * identity phase is that the decisions still land the same way afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizationId } from "@shared/tenancy";
import { organizationStore } from "../repositories/organizations";
import { userStore } from "../repositories/users";
import { hashPassword } from "../passwords";
import { repositoriesFor } from "../repositories";
import { ERROR_CODES } from "@shared/error-codes";
import { META_KEYS, PROTOCOL_VERSION, OATHRION_RPC_ERRORS } from "../mcp/protocol";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { ROLE_KEYS, startTestServer, type RequestOptions, type TestClient } from "./harness";

const ORG = organizationId("org_default");
const ADMIN_EMAIL = "p6-adversarial@placet.test";
const ADMIN_PASSWORD = "correct horse battery staple 6";

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
  approvalId?: string | null;
  error?: { code?: string; message?: string } | string;
}

interface CallReply {
  result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  error?: { code: number; message: string };
}

describe("Phase 6 adversarial cases A–K", () => {
  let api: TestClient;
  let mock: MockDownstream;
  let mcp: LocalMcpServer;
  let previousUrl: string | undefined;
  let adminToken: string;

  /** A key bound to `agentId`, or unbound when it is null. Returns the plaintext. */
  async function issueKey(name: string, agentId: string | null): Promise<IssuedKey> {
    const res = await api.post<IssuedKey>(
      "/api/keys",
      {
        name,
        role: "operator",
        ...(agentId === null ? {} : { agentId }),
      },
      { auth: adminToken },
    );
    expect(res.status, `issuing ${name}: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.secret, "no plaintext returned").toBeTruthy();
    return res.body;
  }

  function asKey(secret: string): RequestOptions {
    return { auth: secret };
  }

  /** A `tools/call` through the MCP gateway, with the agent id the test chooses. */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    auth: string,
    declaredAgent: string,
  ) {
    return api.post<CallReply>(
      "/api/mcp",
      {
        jsonrpc: "2.0",
        id: `adv-${name}-${Date.now()}`,
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
          "X-Oathrion-Agent-Id": declaredAgent,
        },
      },
    );
  }

  /** A complete, schema-valid agent body. `agentCreateSchema` is strict. */
  function agentBody(id: string, name: string) {
    return {
      id,
      name,
      description: "Phase 6 adversarial fixture",
      provider: "openai" as const,
      model: "gpt-4o",
      status: "active" as const,
      owner: "p6-adversarial",
      mandate: {
        maxTransactionAmount: 100,
        currency: "EUR" as const,
        allowedCategories: [],
        blockedCategories: [],
        allowedDomains: [],
      },
      permissions: [
        {
          scope: "execute:payments" as const,
          label: "Issue refunds",
          description: "Granted so the BLOCK below is attributable to status, not scope",
          granted: true,
          risk: "medium" as const,
        },
      ],
      policyIds: [],
      tags: [],
      /*
       * Fields `agentCreateSchema` supplies by default. Written out because
       * `ensureRivalAgent` writes through the repository rather than the API,
       * and the repository does not run zod — the first version omitted them and
       * hit a NOT NULL constraint on `created_at`.
       */
      currentTask: null,
      createdAt: new Date().toISOString().slice(0, 10),
      executions24h: 0,
      successRate: 0,
      cost24h: 0,
      costMonth: 0,
      riskLevel: "low" as const,
    };
  }

  /**
   * An agent that genuinely exists inside `org_rival_corp`, created there
   * directly through that tenant's repositories.
   *
   * Case E must not be satisfied by an id that nothing owns: refusing an unknown
   * id proves only that a lookup missed. The agent has to be real and owned by
   * someone else for the refusal to mean isolation. The rival tenant's seed does
   * not create agents, so this creates one — and the test asserts it is
   * invisible from `org_default` before drawing any conclusion from a refusal.
   */
  async function ensureRivalAgent(): Promise<string> {
    const id = "agt_rival_ops";
    const rival = repositoriesFor(organizationId("org_rival_corp"));
    const existing = await rival.agents.findById(id);
    if (!existing) await rival.agents.create(agentBody(id, "Rival Ops") as never);
    const confirmed = await rival.agents.findById(id);
    expect(confirmed, "the rival agent was not created").toBeDefined();
    return id;
  }

  async function downstreamCalls(): Promise<Array<{ path: string }>> {
    const response = await fetch(`${mock.url}/mock/received`);
    const payload = (await response.json()) as { calls: Array<{ path: string }> };
    return payload.calls;
  }

  beforeAll(async () => {
    mock = await startMockDownstream();
    mcp = await startLocalMcpServer(mock.url);
    previousUrl = process.env.OATHRION_LOCAL_MCP_URL;
    process.env.OATHRION_LOCAL_MCP_URL = mcp.url;
    api = await startTestServer();

    organizationStore.ensure(ORG, "P6 Adversarial Org");
    const admin = userStore.ensure({
      email: ADMIN_EMAIL,
      name: "P6 Adversarial Admin",
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

  /* ----------------------------- A ---------------------------------------- */

  describe("A — a bound credential acting as its own agent succeeds", () => {
    it("is accepted, and the execution is attributed to the bound agent", async () => {
      /*
       * The case that must not be broken by any of the refusals below. A
       * confinement that also blocks the legitimate path is not a security
       * control, it is an outage.
       */
      const bound = await issueKey("A bound to billing", "agt_billing");

      const res = await api.post<DecisionBody & { execution?: { agentId: string } }>(
        "/api/executions",
        { action: "refund", target: "cus_case_a", amount: 75, currency: "EUR" },
        asKey(bound.secret),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      // Attribution is asserted, not assumed: "it worked" is not the claim.
      const executionId = (res.body.executionId ?? res.body.execution?.agentId) as string;
      expect(executionId).toBeTruthy();
      const detail = await api.get<{ agentId: string; decision: string }>(
        `/api/executions/${res.body.executionId}`,
        asKey(bound.secret),
      );
      expect(detail.status).toBe(200);
      expect(detail.body.agentId).toBe("agt_billing");
      expect(detail.body.decision).toBe("allow");
    });

    it("works without naming the agent at all — the credential already says it", async () => {
      /*
       * The body field is optional as of Phase 6 precisely so a bound credential
       * need not repeat itself. If this failed, every bound caller would be
       * forced to send a value that is then ignored, which is how a field that
       * looks load-bearing but is not gets reintroduced.
       */
      const bound = await issueKey("A bound implicit", "agt_billing");
      const res = await api.post<DecisionBody>(
        "/api/evaluate",
        { action: "refund", target: "cus_case_a2", amount: 75, currency: "EUR" },
        asKey(bound.secret),
      );
      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("ALLOW");
    });

    it("is accepted over MCP when the header names its own agent", async () => {
      const bound = await issueKey("A bound mcp", "agt_billing");
      const reply = await callTool(
        "refund",
        { target: "cus_case_a3", amount: 75, currency: "EUR" },
        bound.secret,
        "agt_billing",
      );
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body.error).toBeUndefined();
    });
  });

  /* ----------------------------- B ---------------------------------------- */

  describe("B — a bound credential naming ANOTHER agent in the header is refused", () => {
    it("is refused over MCP with a forbidden RPC error, not silently reassigned", async () => {
      /*
       * The most important refusal in this file. Silently substituting the bound
       * agent would be worse than accepting the header: the caller would believe
       * it acted as `agt_sales`, the audit trail would say `agt_billing`, and
       * nobody would learn the two disagreed.
       */
      const bound = await issueKey("B bound billing", "agt_billing");
      const reply = await callTool(
        "refund",
        { target: "cus_case_b", amount: 75, currency: "EUR" },
        bound.secret,
        "agt_sales",
      );
      expect(reply.status).toBe(403);
      expect(reply.body.error?.code).toBe(OATHRION_RPC_ERRORS.forbidden);
    });

    it("reaches no tool at the downstream", async () => {
      const before = (await downstreamCalls()).length;
      const bound = await issueKey("B bound no downstream", "agt_billing");
      await callTool(
        "refund",
        { target: "cus_case_b2", amount: 75, currency: "EUR" },
        bound.secret,
        "agt_sales",
      );
      // Measured at the mock downstream over HTTP, not inferred from the status.
      expect((await downstreamCalls()).length).toBe(before);
    });
  });

  describe("B (continued) — a padded agent header, and what it does NOT prove", () => {
    /*
     * These two came out of a mutation that survived, and the honest account of
     * what they establish is narrower than the story they were written for.
     *
     * The original mutation G rerouted the MCP agent lookup through the raw
     * header. It survived, because it could not do otherwise: by the time that
     * lookup runs the chokepoint has already refused any id differing from the
     * binding, so the header there is either null or the identical string.
     *
     * These tests were then added on the theory that the chokepoint's `trim()`
     * was the one real difference, and that a padded header would 404 under the
     * mutation. THAT WAS ALSO WRONG, and the mutation surviving a second time is
     * what said so: HTTP strips optional leading and trailing whitespace from a
     * field value before Express sees it, so `"  agt_billing  "` and
     * `"agt_billing"` are already the same string at every code path below.
     *
     * They are kept because the behaviour is worth pinning — an operator whose
     * configuration emits a trailing space gets a working call, not an
     * unexplainable "unknown agent" — but they prove a property of the HTTP
     * layer plus a defensive trim, NOT resistance to spoofing. Mutation G was
     * reformulated to express that threat properly; see
     * `script/phase6-mutations.sh`.
     */

    it("honours a whitespace-padded header naming the credential's own agent", async () => {
      const bound = await issueKey("B padded own agent", "agt_billing");
      const reply = await callTool(
        "refund",
        { target: "cus_case_b_padded", amount: 75, currency: "EUR" },
        bound.secret,
        "  agt_billing  ",
      );
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body.error).toBeUndefined();
    });

    it("still refuses a whitespace-padded header naming a DIFFERENT agent", async () => {
      /*
       * The half that does carry security weight. Normalising before comparing
       * must not become a way to slip a foreign id past a `===`, whichever layer
       * does the normalising.
       */
      const bound = await issueKey("B padded foreign agent", "agt_billing");
      const reply = await callTool(
        "refund",
        { target: "cus_case_b_padded_foreign", amount: 75, currency: "EUR" },
        bound.secret,
        "  agt_sales  ",
      );
      expect(reply.status).toBe(403);
      expect(reply.body.error?.code).toBe(OATHRION_RPC_ERRORS.forbidden);
    });
  });

  /* ----------------------------- C ---------------------------------------- */

  describe("C — a bound credential naming ANOTHER agent in the body is refused", () => {
    /*
     * The same attack through the other door. Two doors were the reason Phase 6
     * routes all six entry points through one function instead of adding a check
     * per route: a per-route check is one route away from being forgotten.
     */
    /*
     * The four bodies are NOT interchangeable, and the difference is not
     * cosmetic. `/api/evaluate` and `/api/executions` take `amount` and
     * `currency` as top-level fields; `/api/decision` and `/api/execute` take
     * them inside `metadata`, and their schemas are `z.strictObject`, so a
     * top-level `amount` is a 400 before any identity check is reached.
     *
     * Written out per route rather than shared, because a shared body that
     * happened to 400 on two of them would have produced two tests that pass
     * without ever exercising the binding refusal — the failure mode this whole
     * file exists to avoid. The first version of this test did exactly that and
     * was caught by asserting the status was 403 rather than merely "not 2xx".
     */
    const routes = [
      {
        path: "/api/evaluate",
        body: { action: "refund", target: "cus_case_c1", amount: 75, currency: "EUR" },
      },
      {
        path: "/api/decision",
        body: {
          action: "refund",
          target: "cus_case_c2",
          metadata: { amount: 75, currency: "EUR" },
        },
      },
      {
        path: "/api/execute",
        body: {
          action: "refund",
          target: "cus_case_c3",
          metadata: { amount: 75, currency: "EUR" },
        },
      },
      {
        path: "/api/executions",
        body: { action: "refund", target: "cus_case_c4", amount: 75, currency: "EUR" },
      },
    ];

    for (const route of routes) {
      it(`refuses a foreign agentId on ${route.path}`, async () => {
        const bound = await issueKey(`C bound ${route.path}`, "agt_billing");
        const res = await api.post<DecisionBody>(
          route.path,
          { ...route.body, agentId: "agt_sales" },
          asKey(bound.secret),
        );
        expect(res.status, `${route.path} returned ${res.status}`).toBe(403);
        expect(JSON.stringify(res.body)).toContain(ERROR_CODES.agentBindingViolation);
      });
    }

    it("does not act as the bound agent instead — the request is refused, not rewritten", async () => {
      /*
       * Asserted by counting: if the refusal were a silent substitution, an
       * execution would exist for `agt_billing` with this target.
       */
      const bound = await issueKey("C no substitution", "agt_billing");
      const target = "cus_case_c_no_substitution";
      const res = await api.post(
        "/api/executions",
        { agentId: "agt_sales", action: "refund", target, amount: 75, currency: "EUR" },
        asKey(bound.secret),
      );
      expect(res.status).toBe(403);

      const executions = await repositoriesFor(ORG).executions.list(300);
      expect(executions.some((e) => e.target === target)).toBe(false);
    });
  });

  /* ----------------------------- D ---------------------------------------- */

  describe("D — a credential bound to A cannot act on an execution of B", () => {
    it("refuses to retry another agent's execution", async () => {
      /*
       * `POST /api/executions/:id/retry` names no agent anywhere. Before Phase 6
       * that made it the one entry point where a bound credential's confinement
       * was simply absent: any operator credential could re-dispatch any failed
       * execution in its tenant, including one belonging to an agent it had no
       * relationship with. It is now the sixth caller of the chokepoint, through
       * `mayActOnExecution` and a pre-read of the row.
       */
      const billing = await issueKey("D bound billing", "agt_billing");
      const sales = await issueKey("D bound sales", "agt_sales");

      const created = await api.post<DecisionBody>(
        "/api/executions",
        { action: "refund", target: "cus_case_d", amount: 75, currency: "EUR" },
        asKey(billing.secret),
      );
      expect(created.status).toBe(201);
      const executionId = created.body.executionId as string;

      // Force it into the one state a retry is permitted from, so the refusal
      // can only come from the identity check.
      await repositoriesFor(ORG).executions.update(executionId, {
        runState: "failed",
        attempts: 1,
      });

      // The owner may.
      const own = await api.post(`/api/executions/${executionId}/retry`, {}, asKey(billing.secret));
      expect(own.status, JSON.stringify(own.body)).toBe(200);

      // Reset for the foreign attempt.
      await repositoriesFor(ORG).executions.update(executionId, {
        runState: "failed",
        attempts: 1,
      });

      const foreign = await api.post(
        `/api/executions/${executionId}/retry`,
        {},
        asKey(sales.secret),
      );
      expect(foreign.status).toBe(403);
      expect(JSON.stringify(foreign.body)).toContain(ERROR_CODES.agentBindingViolation);
    });

    it("refuses even when the execution is otherwise perfectly retryable", async () => {
      // Guards against a future refactor that reorders the retry checks so the
      // identity one lands after a cheaper refusal and stops being reached.
      const billing = await issueKey("D retryable billing", "agt_billing");
      const sales = await issueKey("D retryable sales", "agt_sales");

      const created = await api.post<DecisionBody>(
        "/api/executions",
        { action: "refund", target: "cus_case_d2", amount: 75, currency: "EUR" },
        asKey(billing.secret),
      );
      const executionId = created.body.executionId as string;
      await repositoriesFor(ORG).executions.update(executionId, {
        runState: "failed",
        attempts: 0,
      });

      const advertised = await api.get<{ retry: { retryable: boolean } }>(
        `/api/executions/${executionId}`,
        asKey(billing.secret),
      );
      // `retry` describes the EXECUTION, not the caller — so it says retryable
      // even to a credential that may not press the button. That separation is
      // deliberate and is asserted in `retryability.test.ts`.
      expect(advertised.body.retry.retryable).toBe(true);

      const foreign = await api.post(
        `/api/executions/${executionId}/retry`,
        {},
        asKey(sales.secret),
      );
      expect(foreign.status).toBe(403);
    });
  });

  /* ----------------------------- E ---------------------------------------- */

  describe("E — an agent in another tenant is refused", () => {
    it("refuses a key that names an agent belonging to another organisation", async () => {
      /*
       * `agt_rival_ops` exists, in `org_rival_corp`. The refusal must not depend
       * on the id being unknown — that would be a lookup failure, not isolation
       * — so this test asserts the agent is real and owned elsewhere first.
       */
      const foreignAgentId = await ensureRivalAgent();

      // It genuinely is not visible from this tenant.
      expect(await repositoriesFor(ORG).agents.findById(foreignAgentId)).toBeUndefined();

      // Issue time refuses it: a key bound to an agent this tenant cannot see
      // would be a credential nobody could ever use, stored as if valid.
      const issued = await api.post(
        "/api/keys",
        { name: "E foreign agent", role: "operator", agentId: foreignAgentId },
        { auth: adminToken },
      );
      expect(issued.status).toBe(400);
    });

    it("refuses an unbound key that names a foreign agent at request time", async () => {
      const foreignAgentId = await ensureRivalAgent();

      const unbound = await issueKey("E unbound", null);
      const res = await api.post<DecisionBody>(
        "/api/evaluate",
        { agentId: foreignAgentId, action: "refund", target: "cus_case_e", amount: 75, currency: "EUR" },
        asKey(unbound.secret),
      );
      /*
       * NOT a 403 from the binding chokepoint — an unbound key is allowed to
       * name an agent, so this refusal comes from the tenant-scoped lookup
       * failing to find it. Either way the action does not happen, and the
       * distinction is recorded because reading this as binding enforcement
       * would overstate what the chokepoint does.
       */
      expect([400, 404]).toContain(res.status);
    });
  });

  /* ----------------------------- F ---------------------------------------- */

  describe("F — a revoked credential is refused", () => {
    it("stops working the moment it is revoked, bound or not", async () => {
      const bound = await issueKey("F to be revoked", "agt_billing");

      const before = await api.post<DecisionBody>(
        "/api/evaluate",
        { action: "refund", target: "cus_case_f", amount: 75, currency: "EUR" },
        asKey(bound.secret),
      );
      expect(before.status).toBe(200);

      const revoked = await api.del(`/api/keys/${bound.key.id}`, { auth: adminToken });
      expect([200, 204]).toContain(revoked.status);

      const after = await api.post(
        "/api/evaluate",
        { action: "refund", target: "cus_case_f2", amount: 75, currency: "EUR" },
        asKey(bound.secret),
      );
      expect(after.status).toBe(401);
    });

    it("refuses it on the MCP path too, before any agent resolution happens", async () => {
      const bound = await issueKey("F revoked mcp", "agt_billing");
      await api.del(`/api/keys/${bound.key.id}`, { auth: adminToken });

      const reply = await callTool(
        "refund",
        { target: "cus_case_f3", amount: 75, currency: "EUR" },
        bound.secret,
        "agt_billing",
      );
      expect(reply.status).toBe(401);
    });
  });

  /* --------------------------- G and H ------------------------------------ */

  describe("G and H — a paused or draft agent is refused", () => {
    /*
     * ALREADY ENFORCED BEFORE PHASE 6. `shared/policy/engine.ts` blocks any
     * agent whose `status` is not `active`, which covers `paused`, `draft` and
     * `review` in one rule. These tests add coverage, not code, and are written
     * against a BOUND credential because that combination — a key confined to an
     * agent that is then paused — is the one Phase 6 introduced and nothing
     * previously exercised.
     */
    for (const status of ["paused", "draft"] as const) {
      it(`blocks a bound credential whose agent is ${status}`, async () => {
        const agentId = `agt_p6_${status}`;
        const created = await api.post("/api/agents", agentBody(agentId, `P6 ${status} agent`), {
          auth: adminToken,
        });
        expect([200, 201], JSON.stringify(created.body)).toContain(created.status);

        const bound = await issueKey(`GH bound ${status}`, agentId);

        // Active: the action is permitted, so the later refusal is attributable
        // to the status change and nothing else.
        const active = await api.post<DecisionBody>(
          "/api/evaluate",
          { action: "refund", target: `cus_case_${status}_a`, amount: 10, currency: "EUR" },
          asKey(bound.secret),
        );
        expect(active.status).toBe(200);
        expect(active.body.decision).toBe("ALLOW");

        const patched = await api.patch(`/api/agents/${agentId}`, { status }, { auth: adminToken });
        expect(patched.status).toBe(200);

        const refused = await api.post<DecisionBody>(
          "/api/evaluate",
          { action: "refund", target: `cus_case_${status}_b`, amount: 10, currency: "EUR" },
          asKey(bound.secret),
        );
        expect(refused.status).toBe(200);
        expect(refused.body.decision).toBe("BLOCK");
        expect(refused.body.reason).toContain(status);
      });
    }

    it("reaches no downstream tool for a paused agent, measured at the mock", async () => {
      /*
       * The paused agent here is created and paused BY this test rather than
       * reusing the seeded `agt_recruiting`, and the reason is a correction.
       *
       * The first version of this test used `agt_recruiting` and asserted the
       * call was refused. It was — with a 404 from `toolsForAgent`, because
       * `agt_recruiting` holds no `execute:payments` scope and so `refund` is
       * not in its tool listing at all. The refusal was real but it came from
       * tool visibility, not from the paused status, and the test would have
       * gone on passing if the status check were deleted entirely. That is a
       * test that measures the wrong barrier.
       *
       * This agent is granted `execute:payments` and proven to work while
       * active, so when it is paused the only thing that changed is the status.
       */
      const agentId = "agt_p6_paused_downstream";
      const created = await api.post("/api/agents", agentBody(agentId, "P6 paused downstream"), {
        auth: adminToken,
      });
      expect([200, 201], JSON.stringify(created.body)).toContain(created.status);
      const bound = await issueKey("GH paused downstream", agentId);

      const before = (await downstreamCalls()).length;
      const active = await callTool(
        "refund",
        { target: "cus_case_g_active", amount: 10, currency: "EUR" },
        bound.secret,
        agentId,
      );
      expect(active.status, JSON.stringify(active.body)).toBe(200);
      expect(active.body.error, "the active baseline must actually reach the tool").toBeUndefined();
      const afterActive = (await downstreamCalls()).length;
      expect(afterActive).toBeGreaterThan(before);

      const patched = await api.patch(`/api/agents/${agentId}`, { status: "paused" }, {
        auth: adminToken,
      });
      expect(patched.status).toBe(200);

      const paused = await callTool(
        "refund",
        { target: "cus_case_g_paused", amount: 10, currency: "EUR" },
        bound.secret,
        agentId,
      );
      expect(paused.status).toBe(200);
      expect(paused.body.result?.isError).toBe(true);
      // The measurement that matters: the downstream count did not move.
      expect((await downstreamCalls()).length).toBe(afterActive);
    });

    it("a paused agent lacking the scope is refused earlier, by tool visibility", async () => {
      /*
       * The finding above, kept as its own assertion instead of discarded. Two
       * independent barriers stop this call, and they are worth distinguishing:
       * `agt_recruiting` never sees `refund` in `tools/list`, so it is refused
       * with `invalidParams`/404 before the policy engine's status rule is ever
       * consulted. Defence in depth is only demonstrable if each layer is
       * measured on its own.
       */
      const before = (await downstreamCalls()).length;
      const bound = await issueKey("GH recruiting visibility", "agt_recruiting");
      const reply = await callTool(
        "refund",
        { target: "cus_case_g_invisible", amount: 10, currency: "EUR" },
        bound.secret,
        "agt_recruiting",
      );
      expect(reply.status).toBe(404);
      expect(reply.body.error?.message).toContain("Unknown tool");
      expect((await downstreamCalls()).length).toBe(before);
    });
  });

  /* --------------------------- I, J, K ------------------------------------ */

  describe("I, J, K — the three verdicts still land correctly for a bound credential", () => {
    /*
     * The non-regression floor for the whole phase. An identity change that
     * quietly altered which actions are permitted would be a far worse outcome
     * than the gap it closed, and a green test suite about identity would not
     * have noticed.
     *
     * §1 of the governing brief: BLOCK never reaches the tool;
     * APPROVAL_REQUIRED never reaches it before a human decision; ALLOW does.
     */

    it("I — BLOCK: delete_customer is refused and no tool is reached", async () => {
      const before = (await downstreamCalls()).length;
      const bound = await issueKey("I bound block", "agt_billing");

      const reply = await callTool(
        "delete_customer",
        { target: "cus_case_i" },
        bound.secret,
        "agt_billing",
      );
      expect(reply.status).toBe(200);
      expect(reply.body.result?.isError).toBe(true);
      // Measured at the mock downstream. The §1 guarantee is about the tool, and
      // the tool is the thing on the other side of the network.
      expect((await downstreamCalls()).length).toBe(before);
    });

    it("J — APPROVAL_REQUIRED: held, no tool reached, then released by an approver", async () => {
      const before = (await downstreamCalls()).length;
      const bound = await issueKey("J bound approval", "agt_billing");
      const target = "cus_case_j";

      // 750 EUR is over the org threshold of 500 (`pol_refund_approval`).
      const held = await callTool(
        "refund",
        { target, amount: 750, currency: "EUR" },
        bound.secret,
        "agt_billing",
      );
      expect(held.status).toBe(200);
      // Nothing reached the downstream while the decision was pending. This is
      // the §1 guarantee, and the only assertion here that a status code cannot
      // substitute for.
      expect((await downstreamCalls()).length).toBe(before);

      const approvals = await api.get<Array<{ id: string; executionId: string | null }>>(
        "/api/approvals",
        { auth: ROLE_KEYS.approver },
      );
      expect(approvals.status).toBe(200);
      const executions = await repositoriesFor(ORG).executions.list(300);
      const execution = executions.find((e) => e.target === target);
      expect(execution, "no execution recorded for the held action").toBeDefined();
      const approval = approvals.body.find((a) => a.executionId === execution!.id);
      expect(approval, "no approval raised for the held action").toBeDefined();

      // A bound OPERATOR credential must not be able to approve its own action.
      const selfApproval = await api.post(
        `/api/approvals/${approval!.id}/approve`,
        {},
        asKey(bound.secret),
      );
      expect(selfApproval.status).toBe(403);

      const released = await api.post(
        `/api/approvals/${approval!.id}/approve`,
        {},
        { auth: ROLE_KEYS.approver },
      );
      expect(released.status, JSON.stringify(released.body)).toBe(200);
      // Only now may the tool have been reached.
      expect((await downstreamCalls()).length).toBeGreaterThan(before);
    });

    it("K — ALLOW: the tool is reached and the downstream records it", async () => {
      const before = (await downstreamCalls()).length;
      const bound = await issueKey("K bound allow", "agt_billing");

      const reply = await callTool(
        "refund",
        { target: "cus_case_k", amount: 75, currency: "EUR" },
        bound.secret,
        "agt_billing",
      );
      expect(reply.status).toBe(200);
      expect(reply.body.error).toBeUndefined();
      expect(reply.body.result?.isError).not.toBe(true);

      const calls = await downstreamCalls();
      expect(calls.length).toBeGreaterThan(before);
      expect(calls.some((call) => call.path.includes("refund"))).toBe(true);
    });
  });

  /* ------------------- the residual gap, stated as a test ----------------- */

  describe("the residual gap: an UNBOUND credential can still choose its agent", () => {
    it("is permitted by default — this is the honest limitation, not a passing grade", async () => {
      /*
       * Deliberately asserted as PERMITTED. Writing this test the other way
       * round would make the suite claim a confinement the product does not
       * have. It is here so the gap is measured and visible, and so the day the
       * default changes, this test fails and the report stops being wrong.
       */
      const unbound = await issueKey("gap unbound", null);
      expect(unbound.key.agentId).toBeNull();

      for (const agentId of ["agt_billing", "agt_sales", "agt_procurement"]) {
        const res = await api.post<DecisionBody>(
          "/api/evaluate",
          { agentId, action: "access", target: "warehouse.dim_customer" },
          asKey(unbound.secret),
        );
        expect(res.status, `unbound key refused ${agentId}`).toBe(200);
      }
    });

    it("is closed by OATHRION_REQUIRE_AGENT_BINDING=true, which is off by default", async () => {
      /*
       * The switch exists and works; it ships off because turning it on refuses
       * every credential every existing deployment holds, at the moment they
       * upgrade. That is a migration decision, not a security one, and the
       * priority order in the brief puts security first — so the switch is
       * documented, tested, and left to the operator rather than defaulted on
       * behind their back.
       */
      const unbound = await issueKey("gap switchable", null);
      const previous = process.env.OATHRION_REQUIRE_AGENT_BINDING;
      process.env.OATHRION_REQUIRE_AGENT_BINDING = "true";
      try {
        const res = await api.post(
          "/api/evaluate",
          { agentId: "agt_billing", action: "access", target: "warehouse.dim_customer" },
          asKey(unbound.secret),
        );
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).toContain(ERROR_CODES.agentBindingRequired);

        // A BOUND key keeps working with the switch on — otherwise the switch
        // would be an off-switch for the whole API rather than a hardening.
        const bound = await issueKey("gap bound under switch", "agt_billing");
        const ok = await api.post(
          "/api/evaluate",
          { action: "access", target: "warehouse.dim_customer" },
          asKey(bound.secret),
        );
        expect(ok.status).toBe(200);
      } finally {
        if (previous === undefined) delete process.env.OATHRION_REQUIRE_AGENT_BINDING;
        else process.env.OATHRION_REQUIRE_AGENT_BINDING = previous;
      }
    });

    it("only accepts the exact string \"true\" for that switch", async () => {
      /*
       * `"1"`, `"yes"`, `"TRUE"` do not enable it. That is a deliberate
       * narrowness: an operator who half-enables a security control and is told
       * nothing has the worst of both outcomes. Pinned so a well-meaning
       * "be permissive about booleans" change has to argue with a test.
       */
      const unbound = await issueKey("gap switch strictness", null);
      const previous = process.env.OATHRION_REQUIRE_AGENT_BINDING;
      try {
        for (const value of ["1", "yes", "TRUE", "True", " true"]) {
          process.env.OATHRION_REQUIRE_AGENT_BINDING = value;
          const res = await api.post(
            "/api/evaluate",
            { agentId: "agt_billing", action: "access", target: "warehouse.dim_customer" },
            asKey(unbound.secret),
          );
          expect(res.status, `${JSON.stringify(value)} enabled the switch`).toBe(200);
        }
      } finally {
        if (previous === undefined) delete process.env.OATHRION_REQUIRE_AGENT_BINDING;
        else process.env.OATHRION_REQUIRE_AGENT_BINDING = previous;
      }
    });
  });
});
