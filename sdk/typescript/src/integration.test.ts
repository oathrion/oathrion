/**
 * Integration test: the SDK against a REAL Oathrion server.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS
 * ----------------------------------------
 * `client.test.ts` proves the SDK behaves correctly given a response. It cannot
 * prove the SDK and the server agree on what a response *is*, because it writes
 * both sides of that conversation. Every field name, the alias handling, the
 * shape of an error body, the status codes — all of it is asserted there against
 * a fixture the SDK author wrote, so all of it would keep passing after the
 * server changed underneath.
 *
 * Here the server is the real Express app with the real decision engine, the
 * real database, the real authentication and the real fail-closed posture, over
 * real HTTP on a real port. Nothing about the decision is simulated.
 *
 * It also carries the five end-to-end scenarios this phase is required to
 * demonstrate, exercised through the public SDK surface rather than through
 * hand-built requests — because the SDK is what an integrator will actually
 * hold, and a scenario that only passes via curl has not been shown to work.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OathrionClient } from "./client";
import { OathrionHttpError, OathrionNotAllowedError } from "./errors";
import {
  ROLE_KEYS,
  startTestServer,
  TEST_CONSOLE_EMAIL,
  TEST_CONSOLE_PASSWORD,
  type TestClient,
} from "../../../server/test/harness";

const AGENT = "agt_billing";

/**
 * A policy naming `stripe.refund` explicitly.
 *
 * This is the load-bearing part of the whole phase and it deserves the space.
 * Oathrion is fail-closed: `stripe.refund` is NOT in the built-in verb catalogue,
 * so with no policy naming it the decision is BLOCK by `sys_undeclared_action`
 * — which is the correct and intended behaviour for an action nobody declared.
 *
 * The documented way to govern a verb Oathrion has never heard of is therefore to
 * DECLARE it, by writing a policy whose `condition.actions` names it. Creating
 * this policy is exactly what the quickstart tells an integrator to do, and
 * running the scenarios through it proves the escape hatch works end to end
 * rather than being asserted in prose.
 *
 * The alternative — relaxing the posture so an unknown verb is allowed through
 * to be judged on its amount — would have made these scenarios pass while
 * destroying the property the phase exists to establish.
 */
const STRIPE_REFUND_POLICY = {
  id: "pol_stripe_refund_sdk",
  name: "Stripe refund threshold",
  description: "Refunds up to 500 EUR are automatic; above that a human decides.",
  // MAX_TRANSACTION_AMOUNT, not REQUIRE_HUMAN_APPROVAL: the type selects the
  // rule evaluator, and only this one reads an `amountAtMost` condition. Oathrion
  // rejects the mismatched pairing at the contract boundary rather than storing
  // a policy that would be listed as enabled and never fire.
  type: "MAX_TRANSACTION_AMOUNT",
  condition: {
    kind: "amountAtMost",
    field: "amount",
    max: 500,
    currency: "EUR",
    actions: ["stripe.refund"],
  },
  scope: "organization",
  appliesTo: "All agents",
  effect: "require_approval",
  status: "enabled",
  action: "APPROVAL_REQUIRED",
  risk: "high",
  rule: "stripe.refund.amount > €500 → require_approval",
  priority: 80,
} as const;

describe("Oathrion TypeScript SDK against a live server", () => {
  let api: TestClient;
  let placet: OathrionClient;

  beforeAll(async () => {
    api = await startTestServer();
    placet = new OathrionClient({ baseUrl: api.baseUrl, apiKey: ROLE_KEYS.operator, timeoutMs: 15_000 });

    // Declaring `stripe.refund` requires the `manage` capability, which the
    // console session has and an operator key does not — deliberately: the
    // credential that submits actions should not be able to widen the rules it
    // is judged by.
    const login = await api.post<{ token: string }>(
      "/api/auth/login",
      {
        email: TEST_CONSOLE_EMAIL,
        password: TEST_CONSOLE_PASSWORD,
        organization: "org_default",
      },
      { auth: null },
    );
    expect(login.status).toBe(200);

    const created = await api.post("/api/policies", STRIPE_REFUND_POLICY, {
      auth: login.body.token,
    });
    expect([201, 409], JSON.stringify(created.body)).toContain(created.status);
  });

  afterAll(async () => {
    await api?.close();
  });

  /* ===================================================================== */

  it("reaches the server's health endpoint", async () => {
    const health = await placet.health();
    expect(health.ok).toBe(true);
  });

  /* ===================== The five required scenarios ===================== */

  describe("scenario A — a refund within the limit is allowed", () => {
    it("returns ALLOW from the real engine, naming the real policy", async () => {
      const decision = await placet.evaluate({
        agentId: AGENT,
        action: "stripe.refund",
        target: "customer_123",
        input: { amount: 75, currency: "EUR" },
      });

      expect(decision.decision).toBe("ALLOW");
      expect(decision.allowed).toBe(true);
      // Not `sys_undeclared_action`: the policy really did declare the verb.
      expect(decision.policyId).not.toBe("sys_undeclared_action");
      expect(decision.reason).toBeTruthy();
      expect(decision.requestId).toBeTruthy();
    });
  });

  describe("scenario B — a refund over the limit is held for a human", () => {
    it("returns APPROVAL_REQUIRED, and the SDK does not read it as permission", async () => {
      const decision = await placet.evaluate({
        agentId: AGENT,
        action: "stripe.refund",
        target: "customer_123",
        input: { amount: 750, currency: "EUR" },
      });

      expect(decision.decision).toBe("APPROVAL_REQUIRED");
      // The assertion that matters: a held action is NOT authorised.
      expect(decision.allowed).toBe(false);
      expect(decision.pendingApproval).toBe(true);
    });

    it("makes requireAllow throw on a hold exactly as it throws on a block", async () => {
      const error = (await placet
        .requireAllow({
          agentId: AGENT,
          action: "stripe.refund",
          target: "customer_123",
          input: { amount: 750, currency: "EUR" },
        })
        .catch((e: unknown) => e)) as OathrionNotAllowedError;

      expect(error).toBeInstanceOf(OathrionNotAllowedError);
      expect(error.decision).toBe("APPROVAL_REQUIRED");
    });
  });

  describe("scenario C — a governed destructive action is blocked", () => {
    it("returns BLOCK from a real policy", async () => {
      const decision = await placet.evaluate({
        agentId: AGENT,
        action: "delete_customer",
        target: "customer_123",
      });

      expect(decision.decision).toBe("BLOCK");
      expect(decision.blocked).toBe(true);
      expect(decision.allowed).toBe(false);
    });
  });

  describe("scenarios D and E — undeclared actions are blocked", () => {
    it.each([
      ["unknown.internal_action", "the scenario D verb"],
      ["custom.company.operation", "the scenario E verb"],
      ["stripe.transfer", "a plausible sibling of a declared verb"],
      ["refund_everything", "a verb that merely looks like a governed one"],
    ])("blocks %s (%s)", async (action) => {
      const decision = await placet.evaluate({
        agentId: AGENT,
        action,
        target: "customer_123",
        input: { amount: 1, currency: "EUR" },
      });

      /*
       * The core property of the phase, asserted through the SDK: a verb nobody
       * declared is refused. Note the amount is 1 EUR — trivially under every
       * threshold in the system. It is refused for being undeclared, not for
       * being large, which is what makes this fail-closed rather than merely
       * strict.
       */
      expect(decision.decision).toBe("BLOCK");
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBeTruthy();
    });
  });

  /* ===================== The client cannot be bypassed ==================== */

  describe("no client-side bypass exists", () => {
    it("refuses a bad credential without producing a decision", async () => {
      const rogue = new OathrionClient({ baseUrl: api.baseUrl, apiKey: "not-a-real-key-000000" });
      const error = (await rogue
        .evaluate({ agentId: AGENT, action: "stripe.refund", target: "c1", input: { amount: 1 } })
        .catch((e: unknown) => e)) as OathrionHttpError;

      expect(error).toBeInstanceOf(OathrionHttpError);
      expect(error.isAuthFailure).toBe(true);
      expect((error as unknown as { decision?: unknown }).decision).toBeUndefined();
    });

    it("cannot reach a decision at all when the server is unreachable", async () => {
      // Port 1 is reserved and nothing listens there.
      const offline = new OathrionClient({
        baseUrl: "http://127.0.0.1:1",
        apiKey: ROLE_KEYS.operator,
        timeoutMs: 2_000,
      });
      const error = await offline
        .evaluate({ agentId: AGENT, action: "stripe.refund", target: "c1", input: { amount: 1 } })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      // An outage does not become an ALLOW, and does not become a BLOCK either.
      expect((error as unknown as { decision?: unknown }).decision).toBeUndefined();
    });

    it("still blocks an undeclared verb when the SDK sends the alias spelling", async () => {
      /*
       * The alias path is a second entry into the same route. If it skipped the
       * posture, `agent`/`resource` would be a documented bypass of the phase's
       * central rule.
       */
      const res = await api.post<{ decision: string }>(
        "/api/evaluate",
        { agent: AGENT, action: "unknown.internal_action", resource: "customer_123" },
        { auth: ROLE_KEYS.operator },
      );
      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("BLOCK");
    });
  });
  /**
   * The dry-run / persisted distinction, kept identical to the Python SDK's
   * `test_a_dry_run_files_no_approval_and_a_persisted_one_does`.
   *
   * Surfaced while writing the Python integration test, which asserted that an
   * APPROVAL_REQUIRED always carries an `approvalId`. It does not, and the
   * server is right: `/api/evaluate` defaults to `persist: false`, a dry run
   * that records nothing. So there is no approval to act on and `approvalId` is
   * null.
   *
   * The failure mode is quiet: an integrator on the default sees
   * APPROVAL_REQUIRED, reports "waiting for approval", and waits forever
   * because nothing was ever filed. Asserted in both SDKs so the two cannot
   * drift on it.
   */
  it("files no approval on a dry run, and a real one when persisted", async () => {
    const dry = await placet.evaluate({
      agentId: AGENT,
      action: "stripe.refund",
      target: "customer_123",
      input: { amount: 750, currency: "EUR" },
    });
    expect(dry.decision).toBe("APPROVAL_REQUIRED");
    expect(dry.approvalId ?? null).toBeNull();
    expect(dry.persisted).toBe(false);
    expect(dry.executionId ?? null).toBeNull();

    const real = await placet.evaluate({
      agentId: AGENT,
      action: "stripe.refund",
      target: "customer_123",
      input: { amount: 750, currency: "EUR" },
      persist: true,
    });
    expect(real.decision).toBe("APPROVAL_REQUIRED");
    expect(real.persisted).toBe(true);
    expect(real.approvalId).toBeTruthy();
    expect(real.executionId).toBeTruthy();

    // Present in the queue a human actually reads, read back over the API
    // rather than inferred from the id being non-null.
    const queue = await api.get<{ id: string }[] | { items: { id: string }[] }>("/api/approvals", {
      auth: ROLE_KEYS.admin,
    });
    const items = Array.isArray(queue.body) ? queue.body : queue.body.items;
    expect(items.map((item) => item.id)).toContain(real.approvalId);
  });
});
