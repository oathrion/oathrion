/**
 * `Origin` and `Accept` validation on the MCP endpoint.
 *
 * The MCP transport specification puts a MUST on the server for `Origin`
 * ("Servers MUST validate the Origin header on all incoming connections to
 * prevent DNS rebinding attacks") and a MUST on the client for `Accept`.
 *
 * These tests are written to fail if the validation is cosmetic. Two of them in
 * particular would pass against a naive implementation and are the reason this
 * file exists in its current form:
 *
 *   - `Origin: https://localhost.evil.com` is accepted by any check written as
 *     `origin.includes("localhost")`, and it is an origin an attacker owns
 *     outright.
 *   - `Accept: application/json;q=0` is accepted by any check written as
 *     `accept.includes("application/json")`, and RFC 9110 defines it as an
 *     explicit statement that JSON is NOT acceptable.
 *
 * A check that passes the six obvious cases and fails those two is worse than
 * no check, because it reports compliance it does not have.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { OATHRION_RPC_ERRORS, META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";

interface RpcReply {
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe("MCP HTTP envelope validation", () => {
  let api: TestClient;

  /** A request that is valid in every respect except what a test overrides. */
  function baseline(headers: Record<string, string> = {}) {
    return {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
            [META_KEYS.clientCapabilities]: {},
          },
        },
      },
      headers: {
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "tools/list",
        "X-Oathrion-Agent-Id": "agt_billing",
        ...headers,
      },
    };
  }

  async function send(headers: Record<string, string> = {}) {
    const built = baseline(headers);
    return api.post<RpcReply>("/api/mcp", built.body, {
      auth: ROLE_KEYS.operator,
      headers: built.headers,
    });
  }

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(() => {
    // The allowlist is read per request, so a test that sets it must clear it
    // or it leaks into every test that follows.
    delete process.env.OATHRION_MCP_ALLOWED_ORIGINS;
  });

  /* --------------------------------------------------------------------- */
  /* Origin                                                               */
  /* --------------------------------------------------------------------- */

  describe("Origin", () => {
    it("1. accepts a valid loopback Origin", async () => {
      const res = await send({ Origin: "http://localhost:5173" });
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });

    it("accepts 127.0.0.1 on any port", async () => {
      const res = await send({ Origin: "http://127.0.0.1:3000" });
      expect(res.status).toBe(200);
    });

    it("2. rejects an invalid Origin with 403", async () => {
      const res = await send({ Origin: "https://evil.example.com" });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.originRejected);
      // The id cannot be known: the frame is rejected before it is parsed.
      expect(res.body.id).toBeNull();
    });

    it("rejects an origin that merely contains 'localhost' as a substring", async () => {
      /*
       * `https://localhost.evil.com` is a domain an attacker registers and
       * controls. Any check written as a substring test on the raw header
       * accepts it. This is the assertion that separates a parsed check from a
       * cosmetic one.
       */
      const res = await send({ Origin: "https://localhost.evil.com" });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.originRejected);
    });

    it("rejects an origin using localhost as a userinfo trick", async () => {
      const res = await send({ Origin: "https://localhost@evil.example.com" });
      expect(res.status).toBe(403);
    });

    it("3. allows an absent Origin, because only a browser is bound to send it truthfully", async () => {
      /*
       * The deliberate decision, stated in `http-validation.ts`: agent
       * runtimes, CLIs and SDKs do not send Origin. Requiring it would reject
       * every legitimate MCP client while stopping nothing, since a non-browser
       * attacker simply omits or forges the header.
       */
      const res = await send();
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });

    it('rejects the literal Origin "null" rather than treating it as absent', async () => {
      // Browsers send this from sandboxed iframes and file:// documents. It is
      // a browser context that cannot be attributed, not the absence of one.
      const res = await send({ Origin: "null" });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.originRejected);
    });

    it("honours OATHRION_MCP_ALLOWED_ORIGINS for a deployed console", async () => {
      process.env.OATHRION_MCP_ALLOWED_ORIGINS = "https://console.placet.example";
      const allowed = await send({ Origin: "https://console.placet.example" });
      expect(allowed.status).toBe(200);

      // And an explicit allowlist REPLACES the loopback default rather than
      // extending it, so a production deployment is not silently also
      // accepting localhost.
      const loopback = await send({ Origin: "http://localhost:5173" });
      expect(loopback.status).toBe(403);
    });

    it("rejects a malformed Origin", async () => {
      const res = await send({ Origin: "not-a-url" });
      expect(res.status).toBe(403);
    });

    it("rejects before the body is parsed, so a hostile page cannot probe behaviour", async () => {
      /*
       * The body here is nonsense. If the response is an Origin rejection
       * rather than a parse error, the ordering is right: validation happens on
       * the HTTP envelope first.
       */
      const res = await api.post<RpcReply>(
        "/api/mcp",
        { total: "garbage" },
        { auth: ROLE_KEYS.operator, headers: { Origin: "https://evil.example.com" } },
      );
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.originRejected);
    });
  });

  /* --------------------------------------------------------------------- */
  /* Accept                                                               */
  /* --------------------------------------------------------------------- */

  describe("Accept", () => {
    it("4. accepts the Accept header the specification asks clients to send", async () => {
      const res = await send({ Accept: "application/json, text/event-stream" });
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });

    it("accepts a wildcard", async () => {
      const res = await send({ Accept: "*/*" });
      expect(res.status).toBe(200);
    });

    it("accepts a type wildcard", async () => {
      const res = await send({ Accept: "application/*" });
      expect(res.status).toBe(200);
    });

    it("5. rejects an Accept that cannot take JSON, with 406", async () => {
      const res = await send({ Accept: "text/html" });
      expect(res.status).toBe(406);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.notAcceptable);
    });

    it("rejects application/json;q=0, which states JSON is NOT acceptable", async () => {
      /*
       * RFC 9110: "a value of 0 means not acceptable". A substring check reads
       * this as acceptance. This is the second assertion that a cosmetic
       * implementation fails.
       */
      const res = await send({ Accept: "application/json;q=0" });
      expect(res.status).toBe(406);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.notAcceptable);
    });

    it("respects q-values when JSON is one of several types", async () => {
      const res = await send({ Accept: "text/html;q=0.9, application/json;q=0.1" });
      // Low preference is still acceptance.
      expect(res.status).toBe(200);
    });

    it("allows an absent Accept, which RFC 9110 defines as accepting anything", async () => {
      // Node's fetch supplies `*/*`, so this asserts the same permissive path.
      const res = await send();
      expect(res.status).toBe(200);
    });

    it("does not reject a client for omitting text/event-stream", async () => {
      /*
       * A deliberate non-enforcement, documented in `http-validation.ts`: this
       * gateway never opens an SSE stream, so refusing a caller for failing to
       * advertise a transport that will never be used would enforce nothing
       * about this server's behaviour.
       */
      const res = await send({ Accept: "application/json" });
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });
  });

  /* --------------------------------------------------------------------- */
  /* Combinations                                                         */
  /* --------------------------------------------------------------------- */

  describe("Origin and Accept combined", () => {
    it("6. accepts a valid combination", async () => {
      const res = await send({
        Origin: "http://localhost:5173",
        Accept: "application/json, text/event-stream",
      });
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.result?.tools).toBeDefined();
    });

    it("7. rejects an invalid combination", async () => {
      const res = await send({ Origin: "https://evil.example.com", Accept: "text/html" });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.originRejected);
    });

    it("reports the Origin failure first when both are invalid, deterministically", async () => {
      /*
       * Determinism matters more than which one wins: an endpoint that reports
       * a different error depending on header iteration order cannot be
       * asserted against, and an operator reading logs cannot tell two
       * incidents apart. Origin is checked first because it is the
       * security-relevant one.
       */
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await send({ Origin: "https://evil.example.com", Accept: "text/html" });
        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.originRejected);
      }
    });

    it("rejects a valid Origin with an invalid Accept", async () => {
      const res = await send({ Origin: "http://localhost:5173", Accept: "text/plain" });
      expect(res.status).toBe(406);
      expect(res.body.error?.code).toBe(OATHRION_RPC_ERRORS.notAcceptable);
    });

    it("returns a well-formed JSON-RPC error frame for every rejection", async () => {
      // Deterministic and correctly formatted, as the brief requires: an MCP
      // client must be able to parse the refusal with the same code path it
      // uses for any other error.
      const rejections = [
        await send({ Origin: "https://evil.example.com" }),
        await send({ Accept: "text/html" }),
        await send({ Origin: "null" }),
      ];
      for (const res of rejections) {
        expect(res.body).toMatchObject({
          jsonrpc: "2.0",
          id: null,
          error: { code: expect.any(Number), message: expect.any(String) },
        });
        expect(res.body.result).toBeUndefined();
      }
    });
  });
});
