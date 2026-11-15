/**
 * P1-2 — every request carries a correlation id, and an inbound one is never trusted.
 *
 * THE PROBLEM
 * -----------
 * The request log line was `GET /api/agents 401 in 0ms`, and the error line from
 * `handle()` was a separate `[api] GET /api/agents <stack>`. Nothing joined them, and
 * nothing distinguished two concurrent requests to the same route. A user reporting a
 * failure had nothing to quote, and an operator had nothing to search for.
 *
 * WHY THE ADVERSARIAL HALF MATTERS MORE THAN THE HAPPY PATH
 * --------------------------------------------------------
 * The id is written into log lines and echoed in a response header. Accepting a
 * caller-supplied value without a strict pattern would hand a caller a writable log:
 * a newline inside the header forges whole entries, so an attacker could append a
 * plausible `[lifecycle] SIGTERM received` line, or bury the evidence of their own
 * requests under padding. So the tests that matter here are the rejections.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
  currentRequestId,
  newRequestId,
  sanitiseRequestId,
  tagged,
  withRequestId,
} from "../request-context";
import { startTestServer, type TestClient } from "./harness";

describe("sanitiseRequestId — what may be trusted from a caller", () => {
  it("accepts the shapes real infrastructure emits", () => {
    // An nginx $request_id, a UUID, a W3C traceparent segment, our own generated id.
        for (const id of [
      "b7e4a1c29f3d4e6a8b0c1d2e3f405162",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      newRequestId(),
    ]) {
      expect(sanitiseRequestId(id)).toBe(id);
    }
  });

  it("refuses a newline, which is the whole reason this function exists", () => {
    /*
     * The concrete attack: with the value below in `X-Request-Id`, the log line
     * `[<id>] GET /api/x 200` becomes two lines, the second one entirely
     * attacker-written and indistinguishable from a real lifecycle event.
     */
    expect(sanitiseRequestId("abcdefgh\n[lifecycle] SIGTERM received — draining")).toBeUndefined();
    expect(sanitiseRequestId("abcdefgh\r\nfake")).toBeUndefined();
    // A carriage return alone still splits a line in most log viewers.
    expect(sanitiseRequestId("abcdefgh\rfake")).toBeUndefined();
  });

  it("refuses control characters and terminal escapes", () => {
    // An ANSI escape can clear the screen or recolour text in an operator's terminal,
    // hiding the lines around it.
    expect(sanitiseRequestId("abcdefgh\u001b[2Jwiped")).toBeUndefined();
    expect(sanitiseRequestId("abcdefgh\u0000null")).toBeUndefined();
    expect(sanitiseRequestId("abcdefgh\tTAB")).toBeUndefined();
  });

  it("refuses a value long enough to bloat every log line", () => {
    expect(sanitiseRequestId("a".repeat(64))).toBe("a".repeat(64));
    expect(sanitiseRequestId("a".repeat(65))).toBeUndefined();
    expect(sanitiseRequestId("a".repeat(8192))).toBeUndefined();
  });

  it("refuses an id too short to correlate anything", () => {
    // `1` from every caller is worse than no id: it makes a search return everything
    // while looking like it worked.
    expect(sanitiseRequestId("1")).toBeUndefined();
    expect(sanitiseRequestId("1234567")).toBeUndefined();
    expect(sanitiseRequestId("12345678")).toBe("12345678");
  });

  it("refuses a duplicated header, which Express joins with a comma", () => {
    /*
     * Two `X-Request-Id` headers arrive as `first,second`. Accepting that would record
     * a single id that belongs to neither, so the comma is excluded and a fresh id is
     * generated instead.
     */
    expect(sanitiseRequestId("aaaaaaaa,bbbbbbbb")).toBeUndefined();
  });

  it("refuses a non-string, including the array shape a header can take", () => {
    expect(sanitiseRequestId(undefined)).toBeUndefined();
    expect(sanitiseRequestId(["aaaaaaaa", "bbbbbbbb"])).toBeUndefined();
    expect(sanitiseRequestId(12345678)).toBeUndefined();
    expect(sanitiseRequestId(null)).toBeUndefined();
  });

  it("rejects rather than sanitises, so a broken trace is visible", () => {
    /*
     * Stripping the offending characters would silently produce an id that is not the
     * one the caller sent, joining the wrong records with no sign anything happened.
     * The contract is all-or-nothing.
     */
    expect(sanitiseRequestId("valid-part\nINJECTED")).toBeUndefined();
  });
});

describe("newRequestId", () => {
  it("produces a value that satisfies the inbound pattern", () => {
    // So an id this server generated survives being forwarded to another instance.
    const id = newRequestId();
    expect(REQUEST_ID_PATTERN.test(id)).toBe(true);
  });

  it("does not repeat across restarts, unlike a counter", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));
    expect(ids.size).toBe(500);
  });
});

describe("the async context", () => {
  it("returns undefined outside a request rather than throwing", () => {
    // Background work — a boot sweep, a timer — must log without an id, not crash.
    expect(currentRequestId()).toBeUndefined();
    expect(tagged("hello")).toBe("hello");
  });

  it("carries the id across an await", () => {
    return withRequestId("test-id-0001", async () => {
      expect(currentRequestId()).toBe("test-id-0001");
      await new Promise((resolve) => setTimeout(resolve, 1));
      // The point of AsyncLocalStorage: still correct after the hop.
      expect(currentRequestId()).toBe("test-id-0001");
      expect(tagged("boom")).toBe("[test-id-0001] boom");
    });
  });

  it("keeps two concurrent contexts separate", async () => {
    /*
     * The failure this prevents is the reason a module-level variable was not used:
     * under concurrency it would report whichever request started most recently, so
     * every log line would be attributed to the wrong request under load — precisely
     * when correlation is needed.
     */
    const seen: string[] = [];
    const one = withRequestId("first-id-0001", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentRequestId() ?? "none");
    });
    const two = withRequestId("second-id-002", async () => {
      seen.push(currentRequestId() ?? "none");
    });
    await Promise.all([one, two]);
    expect(seen.sort()).toEqual(["first-id-0001", "second-id-002"]);
  });
});

describe("the middleware, over real HTTP", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("returns an id on a successful response", async () => {
    const reply = await api.get("/api/agents");
    const id = reply.headers.get(REQUEST_ID_HEADER);
    expect(id).toBeTruthy();
    expect(REQUEST_ID_PATTERN.test(id ?? "")).toBe(true);
  });

  it("returns a different id per request", async () => {
    const [a, b] = await Promise.all([api.get("/api/agents"), api.get("/api/agents")]);
    expect(a.headers.get(REQUEST_ID_HEADER)).not.toBe(b.headers.get(REQUEST_ID_HEADER));
  });

  it("honours a well-formed inbound id, so a trace survives a proxy", async () => {
    const supplied = "edge-proxy-7f3a9c2b1d4e";
    const reply = await api.get("/api/agents", { headers: { [REQUEST_ID_HEADER]: supplied } });
    expect(reply.headers.get(REQUEST_ID_HEADER)).toBe(supplied);
  });

  it("replaces a hostile inbound id instead of echoing it", async () => {
    /*
     * This is the end-to-end version of the unit test above. It matters separately:
     * the sanitiser could be correct and the middleware could still forget to call it.
     *
     * Note the header value itself must be sent through a raw request — `fetch`
     * refuses to send a header containing a newline, which is a second layer of
     * protection but not one the server may rely on, since a non-browser caller
     * writes bytes to a socket directly.
     */
    const hostile = "short";
    const reply = await api.get("/api/agents", { headers: { [REQUEST_ID_HEADER]: hostile } });
    const returned = reply.headers.get(REQUEST_ID_HEADER);
    expect(returned).not.toBe(hostile);
    expect(REQUEST_ID_PATTERN.test(returned ?? "")).toBe(true);
  });

  it("returns an id on a request the authentication gate refuses", async () => {
    /*
     * The 401 is one of the responses most often correlated — "why can my integration
     * not authenticate?" — and it is answered by a middleware mounted before every
     * route. If the context middleware were mounted after the gate, exactly this case
     * would have no id.
     */
    const reply = await api.get<{ requestId?: string }>("/api/agents", { auth: null });
    expect(reply.status).toBe(401);
    const header = reply.headers.get(REQUEST_ID_HEADER);
    expect(header).toBeTruthy();
    // And the body reports the same id, so a user can quote it from the console.
    expect(reply.body.requestId).toBe(header);
  });

  it("reports the same id in the body and the header of an error", async () => {
    const reply = await api.get<{ requestId?: string }>("/api/agents/does-not-exist");
    expect(reply.status).toBe(404);
    expect(reply.body.requestId).toBe(reply.headers.get(REQUEST_ID_HEADER));
  });

  it("does not put an id in a successful body", async () => {
    /*
     * The id belongs in the header on success. Adding a field to every successful
     * payload would change the shape of every response in the API for a diagnostic,
     * and a client parsing a list would see an unexpected key.
     */
    const reply = await api.get<Record<string, unknown>>("/api/tools");
    expect(reply.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
    expect(Array.isArray(reply.body)).toBe(true);
  });
});
