/**
 * P2 — API versioning: `/api/v1/...` must be the same API as `/api/...`, not a copy of it.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Adding a version prefix is the kind of change that looks finished the moment one
 * endpoint answers under the new path. The failures that matter are the ones that only
 * show up on the *other* endpoints:
 *
 *  - a probe that answers under `/api/live` but 401s under `/api/v1/live`, so a
 *    Kubernetes liveness probe pointed at the versioned path restarts healthy replicas;
 *  - a route reachable under one prefix and not the other, so an integration migrates and
 *    silently loses a capability;
 *  - a capability or tenancy check that applies under `/api` and not under `/api/v1`,
 *    which is a privilege-escalation and a cross-tenant leak respectively;
 *  - two rate-limit budgets instead of one, so a caller doubles its allowance by
 *    alternating prefixes;
 *  - the login response body reaching the log because a `startsWith("/api/auth")` check
 *    stopped matching the versioned form.
 *
 * Each of those has a test below. The parity tests iterate a list of real paths rather
 * than asserting on one, because a per-endpoint bug is exactly what a single-endpoint test
 * cannot see.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_VERSION_PREFIX,
  CURRENT_API_VERSION,
  SUPPORTED_API_VERSIONS,
  apiVersionOf,
  isSupportedApiVersion,
  unversionedPath,
  versionedPath,
} from "@shared/api-version";
import { ERROR_CODES } from "@shared/error-codes";
import { resetRateLimits } from "../rate-limit";
import { ROLE_KEYS, OTHER_ORG_KEYS, TEST_CONSOLE_EMAIL, TEST_CONSOLE_PASSWORD, startTestServer, type TestClient } from "./harness";

interface Body {
  error?: string;
  message?: string;
  code?: string;
  requestId?: string;
  status?: string;
  requestedVersion?: number;
  supportedVersions?: number[];
  [key: string]: unknown;
}

/* ------------------------------ path arithmetic ----------------------------- */

describe("shared/api-version — path arithmetic", () => {
  it("reads the version out of a versioned path", () => {
    expect(apiVersionOf("/api/v1/agents")).toBe(1);
    expect(apiVersionOf("/api/v1")).toBe(1);
  });

  it("reports no version for an unversioned API path, rather than defaulting", () => {
    /*
     * `undefined`, not `CURRENT_API_VERSION`. "Asked for nothing" identifies the callers a
     * future version bump will silently affect; back-filling the current version would
     * erase exactly the fact an operator needs before contemplating a v2.
     */
    expect(apiVersionOf("/api/agents")).toBeUndefined();
    expect(apiVersionOf("/dashboard")).toBeUndefined();
  });

  it("does not mistake a version-looking string for a version segment", () => {
    // Not a segment boundary: this is a path that does not exist, not v1 of `agents`.
    expect(apiVersionOf("/api/v1agents")).toBeUndefined();
    expect(unversionedPath("/api/v1agents")).toBe("/api/v1agents");
    // A version-shaped string deeper in the path is data, not routing.
    expect(apiVersionOf("/api/agents/v1")).toBeUndefined();
    expect(unversionedPath("/api/agents/v1")).toBe("/api/agents/v1");
  });

  it("strips exactly one version segment", () => {
    /*
     * `/api/v1/v1/agents` must become `/api/v1/agents` — a path that does not exist —
     * and not `/api/agents`. Stripping repeatedly would give one resource infinitely
     * many working URLs, which breaks caching and makes any audit or metric keyed on a
     * path unreliable.
     */
    expect(unversionedPath("/api/v1/v1/agents")).toBe("/api/v1/agents");
  });

  it("recognises a multi-digit version as a version, not as an unversioned path", () => {
    // `/api/v10/...` must be refused as an unknown version rather than served as `/api`.
    expect(apiVersionOf("/api/v10/agents")).toBe(10);
    expect(isSupportedApiVersion(10)).toBe(false);
    expect(isSupportedApiVersion(CURRENT_API_VERSION)).toBe(true);
  });

  it("adds the prefix idempotently and leaves non-API paths alone", () => {
    expect(versionedPath("/api/agents")).toBe(`${API_VERSION_PREFIX}/agents`);
    expect(versionedPath(`${API_VERSION_PREFIX}/agents`)).toBe(`${API_VERSION_PREFIX}/agents`);
    expect(versionedPath("/api/v9/agents")).toBe("/api/v9/agents");
    expect(versionedPath("/dashboard")).toBe("/dashboard");
    expect(versionedPath("/apifoo")).toBe("/apifoo");
  });

  it("keeps the credential-suppression check in the request logger correct for every prefix", () => {
    /*
     * THE REGRESSION GUARD FOR THE ONE REAL DEFECT THIS PHASE INTRODUCED.
     *
     * `server/index.ts` suppresses response bodies for auth routes with
     * `startsWith("/api/auth")`. Applied to the raw path, that test does not match
     * `/api/v1/auth/login`, and the login response — which carries the session token —
     * would be logged. The middleware now derives its comparison from
     * `unversionedPath`; this asserts the property that fix depends on.
     *
     * Honest limit: this checks the predicate, not the middleware, because importing
     * `server/index.ts` starts the process. The end-to-end proof that no token reaches
     * the log is captured as a live run against a packaged build.
     */
    for (const path of ["/api/auth/login", "/api/v1/auth/login", "/api/v1/auth/sessions"]) {
      expect(unversionedPath(path).startsWith("/api/auth")).toBe(true);
    }
  });
});

/* --------------------------------- parity ---------------------------------- */

/**
 * Public paths: reachable with no credential at all under either prefix.
 *
 * `/api/live` is the one that matters most. It is the liveness probe, so if the versioned
 * form answered 401 an orchestrator configured with it would read every replica as dead.
 */
const PUBLIC_PATHS = ["/api/live", "/api/ready", "/api/health"] as const;

/** Authenticated read paths, one per route family the console actually uses. */
const READ_PATHS = [
  "/api/agents",
  "/api/executions",
  "/api/policies",
  "/api/approvals",
  "/api/integrations",
  "/api/tools",
  "/api/audit",
  "/api/keys",
  "/api/members",
  "/api/organization",
  "/api/notifications",
  "/api/auth/sessions",
] as const;

/**
 * Fields whose value legitimately changes between two otherwise identical requests, and
 * which are therefore normalised before the two payloads are compared.
 *
 * `lastSeenAt` is the only one, and it is on this list because it was MEASURED to differ
 * by one millisecond between the two calls, not because it was assumed to be a problem:
 * `/api/auth/sessions` reports the session's own last-seen instant, which the act of
 * making the second request updates. Comparing it would assert that time does not pass.
 *
 * The list is a named constant, and short, so that weakening it later is a visible edit
 * rather than a quietly looser comparison. Every other field — including any added in the
 * future — is still compared exactly.
 */
const VOLATILE_FIELDS = new Set(["lastSeenAt"]);

function comparable(body: unknown): string {
  return JSON.stringify(body, (key, value) => (VOLATILE_FIELDS.has(key) ? "<volatile>" : value));
}

describe("versioned prefix parity", () => {
  let api: TestClient;
  /**
   * A console session token, not the API key.
   *
   * Measured, not assumed: `/api/keys` and `/api/auth/sessions` refuse a machine
   * credential outright (`identity.kind !== "user"` → 403) because reading or issuing keys
   * is an act a human administrator performs. Driving the parity tests with an API key
   * would have compared two 403s and called it parity — technically true and worth
   * nothing, since it never reaches the handler at all. A user session exercises the real
   * handler on every path in the list.
   */
  let session: string;

  beforeAll(async () => {
    api = await startTestServer();
    const signIn = await api.post<{ token: string }>(
      "/api/auth/login",
      { email: TEST_CONSOLE_EMAIL, password: TEST_CONSOLE_PASSWORD },
      { auth: null },
    );
    expect(signIn.status).toBe(200);
    session = signIn.body.token;
  });

  afterAll(async () => {
    await api.close();
  });

  it.each(PUBLIC_PATHS)("%s stays public under both prefixes", async (path) => {
    const plain = await api.get<Body>(path, { auth: null });
    const versioned = await api.get<Body>(versionedPath(path), { auth: null });
    expect(plain.status).toBe(versioned.status);
    expect(versioned.status).toBeLessThan(400);
    expect(versioned.body.status).toBe(plain.body.status);
  });

  it.each(READ_PATHS)("%s returns the same status and payload under both prefixes", async (path) => {
    const plain = await api.get<Body>(path, { auth: session });
    const versioned = await api.get<Body>(versionedPath(path), { auth: session });
    expect(versioned.status).toBe(plain.status);
    expect(versioned.status).toBe(200);
    /*
     * Compared as JSON rather than field by field: the point is that the versioned prefix
     * reaches the *same handler*, so anything that differs is a divergence — including a
     * field somebody adds later that this test does not know about.
     *
     * `/api/audit` and `/api/notifications` can legitimately change between two calls if
     * a delivery lands in between; the suite has no traffic other than this test, so a
     * strict comparison is sound here. If it ever becomes flaky the right fix is to
     * compare shape, not to loosen it into asserting nothing.
     */
    expect(comparable(versioned.body)).toBe(comparable(plain.body));
  });

  it.each(READ_PATHS)("%s is closed to an anonymous caller under both prefixes", async (path) => {
    /*
     * The gate was NOT made version-aware in this phase — the rewrite runs before it. This
     * is the test that would fail if the rewrite were ever moved after `authenticate()`,
     * or if a future route were registered under `/api/v1` directly and so bypassed it.
     */
    const plain = await api.get<Body>(path, { auth: null });
    const versioned = await api.get<Body>(versionedPath(path), { auth: null });
    expect(plain.status).toBe(401);
    expect(versioned.status).toBe(401);
    expect(versioned.body.code).toBe(ERROR_CODES.unauthenticated);
  });

  it("enforces capabilities identically under the versioned prefix", async () => {
    /*
     * A viewer may read and may not write. If the capability middleware were skipped for
     * the versioned prefix this is a privilege escalation, not a routing bug.
     */
    const plain = await api.post<Body>("/api/agents", { id: "agent_x", name: "X" }, { auth: ROLE_KEYS.viewer });
    const versioned = await api.post<Body>(
      versionedPath("/api/agents"),
      { id: "agent_x", name: "X" },
      { auth: ROLE_KEYS.viewer },
    );
    expect(plain.status).toBe(403);
    expect(versioned.status).toBe(403);
    expect(versioned.body.code).toBe(plain.body.code);
  });

  it("keeps tenants separated under the versioned prefix", async () => {
    /*
     * §14: an organization must never reach another's data. Scoping is derived from the
     * credential in the same handler, so this asserts the rewrite did not introduce a path
     * that reaches a handler with a different scope.
     */
    const mine = await api.get<Body>(versionedPath("/api/agents"));

    const rival = await api.get<Body>(versionedPath("/api/agents"), { auth: OTHER_ORG_KEYS.admin });
    expect(mine.status).toBe(200);
    expect(rival.status).toBe(200);
    expect(JSON.stringify(rival.body)).not.toBe(JSON.stringify(mine.body));
  });

  it("signs in under the versioned prefix and issues a usable token", async () => {
    const reply = await api.post<{ token?: string; identity?: { role?: string } }>(
      versionedPath("/api/auth/login"),
      { email: TEST_CONSOLE_EMAIL, password: TEST_CONSOLE_PASSWORD },
      { auth: null },
    );
    expect(reply.status).toBe(200);
    expect(typeof reply.body.token).toBe("string");

    // The token minted through the versioned path must work on both prefixes.
    const viaVersioned = await api.get<Body>(versionedPath("/api/agents"), { auth: reply.body.token });
    const viaPlain = await api.get<Body>("/api/agents", { auth: reply.body.token });
    expect(viaVersioned.status).toBe(200);
    expect(viaPlain.status).toBe(200);
  });

  it("preserves the query string through the rewrite", async () => {
    /*
     * The rewrite replaces a path prefix inside `req.url`, which also carries the query.
     * `/api/audit` takes its bounds that way, so losing the query would silently ignore
     * pagination instead of failing.
     */
    const plain = await api.get<Body>("/api/audit?limit=1", { auth: session });
    const versioned = await api.get<Body>(`${versionedPath("/api/audit")}?limit=1`, { auth: session });
    expect(versioned.status).toBe(200);
    expect(JSON.stringify(versioned.body)).toBe(JSON.stringify(plain.body));
  });
});

/* ---------------------------- unknown versions ----------------------------- */

describe("unsupported and unknown paths", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("refuses an unserved version with a distinct code, not a bare 404", async () => {
    const reply = await api.get<Body>("/api/v2/agents");
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe(ERROR_CODES.unsupportedApiVersion);
    expect(reply.body.requestedVersion).toBe(2);
    expect(reply.body.supportedVersions).toEqual([...SUPPORTED_API_VERSIONS]);
    expect(reply.body.requestId).toBeTruthy();
  });

  it("says the same thing about an unserved version whether or not the path exists", async () => {
    /*
     * This answer is given before authentication, so it must not become a way to map the
     * API. Identical bodies for a real and a nonexistent path is what makes that true.
     */
    const real = await api.get<Body>("/api/v9/agents", { auth: null });
    const fake = await api.get<Body>("/api/v9/there-is-no-such-thing", { auth: null });
    expect(real.status).toBe(fake.status);
    expect(real.body.code).toBe(ERROR_CODES.unsupportedApiVersion);
    expect(real.body.message).toBe(fake.body.message);
  });

  it("treats a doubled version segment as a nonexistent path, not as a valid route", async () => {
    // Only one segment is stripped, so this is `/api/v1/agents` — which is not a route.
    const reply = await api.get<Body>("/api/v1/v1/agents");
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe(ERROR_CODES.notFound);
  });

  it("answers an unknown path under the versioned prefix with the normal JSON 404", async () => {
    const plain = await api.get<Body>("/api/no-such-route");
    const versioned = await api.get<Body>(versionedPath("/api/no-such-route"));
    expect(versioned.status).toBe(404);
    expect(versioned.body.code).toBe(ERROR_CODES.notFound);
    expect(versioned.body.error).toBe(plain.body.error);
  });

  it("does not touch a path that merely starts with the same letters", async () => {
    const reply = await api.get<Body>("/api/v1agents");
    expect(reply.status).toBe(404);
    expect(reply.body.code).toBe(ERROR_CODES.notFound);
  });
});

/* ------------------------------- rate limits ------------------------------- */

describe("rate-limit budgets are shared across prefixes", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
    /*
     * The counters live in a module-level store, so anything this file did earlier would
     * otherwise be counted against the budget measured below and make the exhaustion
     * point arrive early. Reset here rather than loosening the assertion.
     */
    resetRateLimits();
  });

  afterAll(async () => {
    await api.close();
  });

  it("exhausts one shared budget rather than one budget per prefix", async () => {
    /*
     * WHY THIS MATTERS. If the limiter keyed on the request path, `/api/v1/agents` and
     * `/api/agents` would be two buckets, and a caller could double its allowance simply by
     * alternating prefixes. A rate limit that can be doubled by a spelling change is not a
     * rate limit — and unlike a routing bug, nothing about it looks broken.
     *
     * HOW THIS IS PROVEN. The write budget is 30 requests per minute per credential
     * (`rateLimit("write", 30, 60_000)` in routes.ts). The 30 calls below are sent to the
     * UNVERSIONED path with a deliberately invalid body: the limiter is mounted before the
     * handler, so each one consumes budget and is then refused with 400 by validation —
     * the budget is exhausted without creating 30 agents or depending on any repository
     * state. The 31st call goes to the VERSIONED path. If the budgets were separate it
     * would be accepted; a 429 is only possible if both prefixes share one counter.
     *
     * The limiter exposes no remaining-quota header, so this is the only way to observe
     * the property from outside rather than asserting the implementation back to itself.
     */
    const WRITE_BUDGET = 30;
    const statuses: number[] = [];
    for (let i = 0; i < WRITE_BUDGET; i += 1) {
      const reply = await api.post<Body>("/api/agents", { nonsense: i }, { auth: ROLE_KEYS.admin });
      statuses.push(reply.status);
    }

    // Every one of them reached the limiter and was then refused by validation, not by it.
    expect(statuses.every((status) => status === 400)).toBe(true);

    const overBudget = await api.post<Body>(
      versionedPath("/api/agents"),
      { nonsense: "one too many" },
      { auth: ROLE_KEYS.admin },
    );
    expect(overBudget.status).toBe(429);
    expect(overBudget.body.code).toBe(ERROR_CODES.rateLimited);

    // And the refusal is the caller's budget, not the prefix: the unversioned path is
    // equally spent.
    const alsoSpent = await api.post<Body>("/api/agents", { nonsense: "same" }, { auth: ROLE_KEYS.admin });
    expect(alsoSpent.status).toBe(429);
  });
});
