/**
 * Unit tests for the Oathrion TypeScript SDK, against an injected `fetch`.
 *
 * Every test here is about ONE question: can a client of this SDK end up
 * believing it was permitted when Oathrion did not permit it?
 *
 * So the fixtures are hostile rather than representative. They include a
 * server that returns HTML for a 502, a 200 with no decision at all, a 200
 * whose decision is a string nobody has ever defined, a body carrying
 * `allowed: true` next to `decision: "BLOCK"`, and a timeout. Those are the
 * shapes that produce a fail-open in a client written to the happy path, and
 * a suite built only from well-formed responses would pass against a client
 * that fails open on every one of them.
 *
 * The real-server integration test lives in `sdk/typescript/src/integration.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { OathrionClient } from "./client";
import {
  OathrionConnectionError,
  OathrionHttpError,
  OathrionNotAllowedError,
  OathrionProtocolError,
  OathrionTimeoutError,
} from "./errors";
import type { DecisionResponse } from "./types";

const BASE_URL = "https://placet.test";
const API_KEY = "test-key-abcdef";

const ACTION = {
  agentId: "agt_billing",
  action: "refund",
  target: "customer:cus_1",
  input: { amount: 75, currency: "EUR" },
} as const;

function decisionBody(overrides: Partial<DecisionResponse> = {}): DecisionResponse {
  return {
    decision: "ALLOW",
    reason: "within limit",
    policyId: "pol_refund_approval",
    policyName: "Refund approval threshold",
    riskLevel: "LOW",
    approvalId: null,
    requestId: "req_1",
    ...overrides,
  } as DecisionResponse;
}

/** A `fetch` double that records what it was called with. */
function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof globalThis.fetch, options = {}) {
  return new OathrionClient({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: fetchImpl, ...options });
}

describe("OathrionClient", () => {
  describe("construction", () => {
    it("refuses to be built without a baseUrl or an apiKey", () => {
      // A client silently constructed with no credential would send anonymous
      // requests and surface as a puzzling 401 far from the real mistake.
      expect(() => new OathrionClient({ baseUrl: "", apiKey: API_KEY })).toThrow(TypeError);
      expect(() => new OathrionClient({ baseUrl: BASE_URL, apiKey: "" })).toThrow(TypeError);
    });

    it("tolerates a trailing slash on the baseUrl", async () => {
      const { impl, calls } = stubFetch(() => jsonResponse(decisionBody()));
      const placet = new OathrionClient({ baseUrl: `${BASE_URL}/`, apiKey: API_KEY, fetch: impl });
      await placet.evaluate(ACTION);
      expect(calls[0]?.url).toBe(`${BASE_URL}/api/evaluate`);
    });
  });

  describe("the request it sends", () => {
    it("POSTs the action to /api/evaluate with a bearer credential", async () => {
      const { impl, calls } = stubFetch(() => jsonResponse(decisionBody()));
      await client(impl).evaluate(ACTION);

      const call = calls[0];
      expect(call?.url).toBe(`${BASE_URL}/api/evaluate`);
      expect(call?.init.method).toBe("POST");
      expect((call?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
      expect(JSON.parse(String(call?.init.body))).toEqual(ACTION);
    });

    it("uses the client's default agentId only when the call omits one", async () => {
      const { impl, calls } = stubFetch(() => jsonResponse(decisionBody()));
      const placet = client(impl, { agentId: "agt_default" });

      await placet.evaluate({ action: "refund", target: "customer:cus_1" });
      expect(JSON.parse(String(calls[0]?.init.body)).agentId).toBe("agt_default");

      await placet.evaluate({ agentId: "agt_explicit", action: "refund", target: "customer:cus_1" });
      expect(JSON.parse(String(calls[1]?.init.body)).agentId).toBe("agt_explicit");
    });

    it("requires a target, because an absent one matches no target-scoped rule", async () => {
      const { impl, calls } = stubFetch(() => jsonResponse(decisionBody()));
      await expect(
        // @ts-expect-error deliberately omitting a required field
        client(impl).evaluate({ agentId: "agt_billing", action: "refund" }),
      ).rejects.toThrow(TypeError);
      // And it never reached the wire, so no half-specified action was evaluated.
      expect(calls).toHaveLength(0);
    });
  });

  describe("decisions are reported exactly as Oathrion gave them", () => {
    it.each([
      ["ALLOW", { allowed: true, blocked: false, pendingApproval: false }],
      ["BLOCK", { allowed: false, blocked: true, pendingApproval: false }],
      ["APPROVAL_REQUIRED", { allowed: false, blocked: false, pendingApproval: true }],
    ] as const)("maps %s to exactly one flag", async (decision, expected) => {
      const { impl } = stubFetch(() => jsonResponse(decisionBody({ decision })));
      const result = await client(impl).evaluate(ACTION);
      expect(result.decision).toBe(decision);
      expect({
        allowed: result.allowed,
        blocked: result.blocked,
        pendingApproval: result.pendingApproval,
      }).toEqual(expected);
    });

    it("never reads APPROVAL_REQUIRED as permission", async () => {
      /*
       * The single most likely misuse of this client. A held action is waiting
       * for a human and has NOT been authorised; a client that treated it as a
       * soft yes would defeat the entire approval mechanism.
       */
      const { impl } = stubFetch(() =>
        jsonResponse(decisionBody({ decision: "APPROVAL_REQUIRED", approvalId: "apr_1" })),
      );
      const result = await client(impl).evaluate(ACTION);
      expect(result.allowed).toBe(false);
      expect(result.approvalId).toBe("apr_1");
    });

    it("ignores a body that claims permission the decision does not grant", async () => {
      /*
       * A compromised or buggy intermediary appends `allowed: true` to a BLOCK.
       * The SDK must derive its flags from `decision` alone and never trust a
       * server-supplied convenience field, or the flag becomes the soft spot
       * that an attacker targets instead of the decision.
       */
      const { impl } = stubFetch(() =>
        jsonResponse({ ...decisionBody({ decision: "BLOCK" }), allowed: true, blocked: false }),
      );
      const result = await client(impl).evaluate(ACTION);
      expect(result.decision).toBe("BLOCK");
      expect(result.allowed).toBe(false);
      expect(result.blocked).toBe(true);
    });
  });

  describe("a failure is never a decision", () => {
    it.each([
      ["401 unauthenticated", 401],
      ["403 forbidden", 403],
      ["400 invalid payload", 400],
      ["429 rate limited", 429],
      ["500 server error", 500],
    ])("throws on %s instead of returning a decision", async (_label, status) => {
      const { impl } = stubFetch(() =>
        jsonResponse({ error: "nope", message: "refused", code: "bad_request" }, status),
      );
      const error = await client(impl)
        .evaluate(ACTION)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OathrionHttpError);
      expect((error as OathrionHttpError).status).toBe(status);
      // The invariant: no error object in this SDK carries a decision field.
      expect((error as unknown as { decision?: unknown }).decision).toBeUndefined();
    });

    it("throws a typed error carrying Oathrion's own code and requestId", async () => {
      const { impl } = stubFetch(() =>
        jsonResponse(
          {
            error: "Forbidden",
            message: "credential is bound to another agent",
            code: "agent_binding_violation",
            requestId: "req_binding",
          },
          403,
        ),
      );
      const error = (await client(impl)
        .evaluate(ACTION)
        .catch((e: unknown) => e)) as OathrionHttpError;

      expect(error.code).toBe("agent_binding_violation");
      expect(error.requestId).toBe("req_binding");
      expect(error.isAuthFailure).toBe(true);
      expect(error.isRequestInvalid).toBe(false);
    });

    it("throws rather than guessing when a network call fails outright", async () => {
      const { impl } = stubFetch(() => {
        throw new Error("ECONNREFUSED");
      });
      const error = await client(impl)
        .evaluate(ACTION)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OathrionConnectionError);
      // No decision was received, so no decision is reported. Not even BLOCK:
      // synthesising one here is how a client acquires its own opinion.
      expect((error as unknown as { decision?: unknown }).decision).toBeUndefined();
    });

    it("aborts and throws on timeout", async () => {
      const impl = (async (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof globalThis.fetch;

      const error = await client(impl, { timeoutMs: 20 })
        .evaluate(ACTION)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OathrionTimeoutError);
      expect((error as OathrionTimeoutError).timeoutMs).toBe(20);
    });

    it("does not choke on a non-JSON error body from a proxy", async () => {
      // A gateway in front of Oathrion returns an HTML 502. `response.json()` would
      // throw a bare SyntaxError telling the caller nothing.
      const { impl } = stubFetch(
        () =>
          new Response("<html><body>502 Bad Gateway</body></html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
      );
      const error = await client(impl)
        .evaluate(ACTION)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OathrionHttpError);
      expect((error as OathrionHttpError).status).toBe(502);
      expect((error as OathrionHttpError).message).toContain("502");
    });
  });

  describe("an uninterpretable 200 is refused, not guessed", () => {
    it.each([
      ["no decision field", { reason: "ok" }],
      ["a decision nobody defined", { decision: "PROBABLY_FINE", reason: "ok" }],
      ["a lowercase decision", { decision: "allow", reason: "ok" }],
      ["a null decision", { decision: null, reason: "ok" }],
      ["an empty body", ""],
    ])("throws on %s", async (_label, body) => {
      const { impl } = stubFetch(
        () =>
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const error = await client(impl)
        .evaluate(ACTION)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OathrionProtocolError);
    });
  });

  describe("requireAllow", () => {
    it("returns the decision when Oathrion allowed it", async () => {
      const { impl } = stubFetch(() => jsonResponse(decisionBody()));
      const result = await client(impl).requireAllow(ACTION);
      expect(result.decision).toBe("ALLOW");
    });

    it.each(["BLOCK", "APPROVAL_REQUIRED"] as const)("throws on %s", async (decision) => {
      const { impl } = stubFetch(() =>
        jsonResponse(
          decisionBody({
            decision,
            reason: "over the limit",
            approvalId: decision === "APPROVAL_REQUIRED" ? "apr_9" : null,
          }),
        ),
      );
      const error = (await client(impl)
        .requireAllow(ACTION)
        .catch((e: unknown) => e)) as OathrionNotAllowedError;

      expect(error).toBeInstanceOf(OathrionNotAllowedError);
      expect(error.decision).toBe(decision);
      expect(error.reason).toBe("over the limit");
    });
  });

  describe("the client holds no opinion of its own", () => {
    it("calls Oathrion every single time, with no caching of a previous ALLOW", async () => {
      /*
       * A cached yes is a decision taken under conditions that may no longer
       * hold: daily spend counters move, policies are edited, agents are
       * paused, mandates expire. The second call here returns BLOCK, and the
       * SDK must report BLOCK — which it can only do if it actually asked.
       */
      let call = 0;
      const { impl, calls } = stubFetch(() => {
        call += 1;
        return jsonResponse(decisionBody({ decision: call === 1 ? "ALLOW" : "BLOCK" }));
      });
      const placet = client(impl);

      expect((await placet.evaluate(ACTION)).decision).toBe("ALLOW");
      expect((await placet.evaluate(ACTION)).decision).toBe("BLOCK");
      expect(calls).toHaveLength(2);
    });

    it("sends an undeclared action to the server rather than deciding locally", async () => {
      /*
       * Fail-closed is the SERVER's rule, and this test states where it is
       * enforced. If the SDK filtered unknown verbs itself, it would be a second
       * policy engine — one that could be relaxed independently of Oathrion, and
       * whose "unknown" list would drift from the real catalogue.
       */
      const { impl, calls } = stubFetch(() =>
        jsonResponse(
          decisionBody({
            decision: "BLOCK",
            policyId: "sys_undeclared_action",
            reason: "is not a declared action and no policy names it",
          }),
        ),
      );
      const result = await client(impl).evaluate({
        agentId: "agt_billing",
        action: "unknown.internal_action",
        target: "customer:cus_1",
      });

      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0]?.init.body)).action).toBe("unknown.internal_action");
      expect(result.decision).toBe("BLOCK");
      expect(result.allowed).toBe(false);
    });
  });
});
