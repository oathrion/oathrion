/**
 * P1-3 — every error carries a stable machine-readable code, and one shape.
 *
 * THE PROBLEM
 * -----------
 * 1. Error bodies were built in five unrelated places and did not agree. Four sent
 *    `{ error }`; the unmatched-path 404 and the last-resort 500 sent `{ message }`.
 *    A client had to read two keys depending on which layer refused it.
 * 2. `client/src/lib/queryClient.ts` reads `parsed.message` — so for every 400, 401,
 *    403 and 404 the console fell through to its raw-text fallback and displayed the
 *    literal string `{"error":"Authentication required"}` to the user. The only error
 *    it rendered properly was the generic 500.
 * 3. No error carried a code. A client that must behave differently for an expired
 *    credential than for an insufficient role had to match English prose that a
 *    copy-edit could change.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * The additive contract. `error` must keep working (existing integrations), `message`
 * must be present (the console), `code` must be stable (new integrations). A future
 * edit that "tidies up" by dropping one of the three has to fail here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBody } from "../api-error";
import { ERROR_CODES, STATUS_ERROR_CODES, codeForStatus } from "@shared/error-codes";
import { withRequestId } from "../request-context";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

interface ErrorBody {
  error?: string;
  message?: string;
  code?: string;
  requestId?: string;
  role?: string;
}

describe("codeForStatus", () => {
  it("maps every status the API actually returns", () => {
    expect(codeForStatus(400)).toBe("bad_request");
    expect(codeForStatus(401)).toBe("unauthenticated");
    expect(codeForStatus(403)).toBe("forbidden");
    expect(codeForStatus(404)).toBe("not_found");
    expect(codeForStatus(409)).toBe("conflict");
    expect(codeForStatus(429)).toBe("rate_limited");
    expect(codeForStatus(500)).toBe("internal_error");
    expect(codeForStatus(503)).toBe("unavailable");
  });

  it("falls back by class, not to a single catch-all", () => {
    /*
     * A future 402 or 451 must not be reported as `internal_error`: that would be a
     * false statement about whose fault the failure is, and a client would retry or
     * escalate wrongly.
     */
    expect(codeForStatus(402)).toBe("bad_request");
    expect(codeForStatus(451)).toBe("bad_request");
    expect(codeForStatus(504)).toBe("internal_error");
  });

  it("never returns an empty code", () => {
    for (const status of [200, 301, 418, 599, 0, -1]) {
      expect(codeForStatus(status).length).toBeGreaterThan(0);
    }
  });

  it("keeps every registered code snake_case and stable-looking", () => {
    // A code is a contract. Mixed conventions invite a rename, and a rename breaks
    // clients silently — they simply stop matching.
    for (const code of [...Object.values(STATUS_ERROR_CODES), ...Object.values(ERROR_CODES)]) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("apiErrorBody", () => {
  it("carries the same sentence under both keys", () => {
    const body = apiErrorBody(404, "Agent not found");
    expect(body.error).toBe("Agent not found");
    expect(body.message).toBe("Agent not found");
  });

  it("derives a code when the caller gives none", () => {
    expect(apiErrorBody(409, "Already exists").code).toBe("conflict");
  });

  it("prefers an explicit code over the status default", () => {
    expect(apiErrorBody(401, "Invalid credentials", ERROR_CODES.invalidCredentials).code).toBe(
      "invalid_credentials",
    );
  });

  it("omits requestId outside a request rather than sending null", () => {
    /*
     * `"requestId": null` would invite a client to render an empty field, or a user to
     * quote the word "null" in a support ticket.
     */
    expect(apiErrorBody(500, "boom")).not.toHaveProperty("requestId");
  });

  it("includes requestId inside a request", () => {
    withRequestId("req-abc-12345678", () => {
      expect(apiErrorBody(500, "boom").requestId).toBe("req-abc-12345678");
    });
  });
});

describe("the error contract over real HTTP", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("401 from the gate: no credential", async () => {
    const reply = await api.get<ErrorBody>("/api/agents", { auth: null });
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("unauthenticated");
    expect(reply.body.error).toBe("Authentication required");
    // The key the console reads. Without it the user saw raw JSON in the UI.
    expect(reply.body.message).toBe("Authentication required");
  });

  it("401 from the gate: a credential that is not valid, distinguished by code", async () => {
    /*
     * Both are 401 and a client must react differently: re-authenticate for the first,
     * stop retrying this credential for the second. That distinction existed in the
     * server and was unreachable by a client.
     */
    const reply = await api.get<ErrorBody>("/api/agents", { auth: "not-a-real-key-000" });
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("invalid_credentials");
  });

  it("403 keeps `role` alongside the standard fields", async () => {
    /*
     * The console shows the caller their own role in the refusal. The shared builder
     * must not have quietly dropped it — that would remove a working explanation from
     * the UI while every test still passed.
     */
    const reply = await api.post<ErrorBody>("/api/agents", {}, { auth: ROLE_KEYS.viewer });
    expect(reply.status).toBe(403);
    expect(reply.body.code).toBe("forbidden_capability");
    expect(reply.body.role).toBe("viewer");
    expect(reply.body.message).toContain("manage");
  });

  it("404 for an unmatched API path answers `error` as well as `message`", async () => {
    /*
     * This handler was the one place that sent `message` without `error`. An
     * integration reading `error` got `undefined` from exactly the response that means
     * "you called a path that does not exist" — the case where a clear message matters
     * most.
     *
     * Reached only with a valid credential: the authentication gate is mounted before
     * every route, so an anonymous request to an unknown path is answered 401 by the
     * gate and never arrives here.
     */
    const reply = await api.get<ErrorBody>("/api/definitely-not-a-route");
    expect(reply.status).toBe(404);
    expect(reply.body.error).toBe("Not found");
    expect(reply.body.message).toBe("Not found");
    expect(reply.body.code).toBe("not_found");
  });

  it("404 from a route: a resource that does not exist", async () => {
    const reply = await api.get<ErrorBody>("/api/agents/agent-that-does-not-exist");
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe("not_found");
  });

  it("400 from validation carries a code a client can branch on", async () => {
    const reply = await api.post<ErrorBody>("/api/auth/login", { email: "x" }, { auth: null });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("bad_request");
    expect(reply.body.message).toBeTruthy();
  });

  it("401 from login is `invalid_credentials`, and still says nothing more", async () => {
    /*
     * The code is transport-level and identical for every kind of sign-in failure, so
     * it discloses no more than the message did: it cannot be used to answer "does
     * this account exist here?".
     */
    const reply = await api.post<ErrorBody>(
      "/api/auth/login",
      { email: "nobody@placet.test", password: "wrong-password-here" },
      { auth: null },
    );
    expect(reply.status).toBe(401);
    expect(reply.body.code).toBe("invalid_credentials");
    expect(reply.body.message).toBe("Invalid credentials");
  });

  it("never leaks a code that describes the deployment", async () => {
    /*
     * A code is machine-readable, which makes it tempting to make it precise. It must
     * still not become a disclosure channel: nothing here may name a file, a table, a
     * driver or a host.
     */
    const replies = await Promise.all([
      api.get<ErrorBody>("/api/agents", { auth: null }),
      api.get<ErrorBody>("/api/nope"),
      api.post<ErrorBody>("/api/agents", {}, { auth: ROLE_KEYS.viewer }),
    ]);
    for (const reply of replies) {
      expect(reply.body.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(reply.body.code).not.toMatch(/sqlite|postgres|data\.db|\/|\\/i);
    }
  });

  it("every error body has all three fields, on every status observed", async () => {
    // The regression this blocks: a future refusal added with `res.status().json()`
    // instead of the shared builder, reintroducing a second shape.
    const replies = await Promise.all([
      api.get<ErrorBody>("/api/agents", { auth: null }),
      api.get<ErrorBody>("/api/agents", { auth: "bad-credential-value" }),
      api.post<ErrorBody>("/api/agents", {}, { auth: ROLE_KEYS.viewer }),
      api.get<ErrorBody>("/api/agents/missing"),
      api.get<ErrorBody>("/api/unmatched-path"),
    ]);
    for (const reply of replies) {
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(typeof reply.body.error).toBe("string");
      expect(typeof reply.body.message).toBe("string");
      expect(typeof reply.body.code).toBe("string");
      expect(reply.body.error).toBe(reply.body.message);
      expect(typeof reply.body.requestId).toBe("string");
    }
  });
});
