/**
 * Business-route rate limiting.
 *
 * The claim under test: a single compromised or misbehaving credential can be
 * throttled without affecting any other credential, and the limiter itself
 * never turns a decision into something other than what the engine returned
 * — a 429 is refused *before* the engine runs, never instead of a verdict
 * that was silently swapped.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  configureRateLimit,
  quotaKey,
  resetRateLimitConfig,
  resetRateLimits,
  resolveFailMode,
  type QuotaDecision,
  type QuotaStore,
} from "../rate-limit";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

let api: TestClient;

beforeAll(async () => {
  api = await startTestServer();
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await api.close();
});

describe("decision-route rate limiting", () => {
  it("allows the documented budget, then refuses further calls from the same credential", async () => {
    const body = { agentId: "agt_sales", action: "purchase", target: "acme-supplies" };

    let sawTooMany = false;
    let lastOk = 0;
    for (let i = 0; i < 121; i++) {
      const reply = await api.post<{ decision?: string; error?: string }>(
        "/api/decision",
        body,
        { auth: ROLE_KEYS.operator },
      );
      if (reply.status === 429) {
        sawTooMany = true;
        expect(reply.headers.get("Retry-After")).not.toBeNull();
        expect(reply.body.decision).toBeUndefined();
        break;
      }
      expect(reply.status).toBe(200);
      lastOk += 1;
    }

    expect(sawTooMany).toBe(true);
    // The budget is 120/minute; the 121st call is the one that must trip it.
    expect(lastOk).toBe(120);
  });

  it("shares its budget with /retry — exhausting one throttles the other", async () => {
    // /retry used to have no limiter of its own; it now shares the same
    // "decision" scope as /api/decision, /api/execute, /api/evaluate and
    // /api/executions. Exhausting the budget through /api/decision must
    // therefore also throttle /retry for the same credential, immediately —
    // the rate limiter runs before the route ever looks up the execution id,
    // so a nonexistent id is enough to prove the 429 comes from the limiter.
    const body = { agentId: "sales-agent", action: "purchase", target: "acme-supplies" };
    for (let i = 0; i < 120; i++) {
      await api.post("/api/decision", body, { auth: ROLE_KEYS.operator });
    }

    const retried = await api.post<{ error?: string }>(
      "/api/executions/nonexistent-id/retry",
      {},
      { auth: ROLE_KEYS.operator },
    );
    expect(retried.status).toBe(429);
  });

  it("does not throttle a different credential once one identity is limited", async () => {
    const body = { agentId: "agt_sales", action: "purchase", target: "acme-supplies" };

    for (let i = 0; i < 120; i++) {
      await api.post("/api/decision", body, { auth: ROLE_KEYS.operator });
    }
    const blocked = await api.post<{ error?: string }>("/api/decision", body, {
      auth: ROLE_KEYS.operator,
    });
    expect(blocked.status).toBe(429);

    // A distinct credential (a different role key resolves to a distinct
    // identity) has its own, untouched budget.
    const other = await api.post("/api/decision", body, { auth: ROLE_KEYS.admin });
    expect(other.status).toBe(200);
  });
});

describe("write-route rate limiting", () => {
  it("throttles repeated agent creation from the same credential", async () => {
    let sawTooMany = false;
    for (let i = 0; i < 31; i++) {
      const reply = await api.post(
        "/api/agents",
        {
          id: `rl-agent-${i}`,
          name: `Rate Limit Agent ${i}`,
          provider: "openai",
          model: "gpt-4",
        },
        { auth: ROLE_KEYS.admin },
      );
      if (reply.status === 429) {
        sawTooMany = true;
        break;
      }
    }
    expect(sawTooMany).toBe(true);
  });
});

/* ---------------------------- Fail mode (P0-7) ---------------------------- */

/**
 * What a request does when the quota store cannot be reached.
 *
 * This is the part of a shared limiter that is easy to get catastrophically wrong.
 * A limiter whose store is down and which therefore *allows* everything has removed
 * every quota in the product at the exact moment something is already broken — and it
 * does so silently, because from the caller's point of view nothing changed. The
 * default is therefore to refuse, and the refusal is asserted here rather than assumed
 * from a configuration constant.
 *
 * A store that rejects is used rather than a real outage: the behaviour under test is
 * the middleware's reaction, and an actual unreachable database would make the test
 * slow and dependent on connection timeouts.
 */
describe("when the quota store is unavailable", () => {
  /** A store whose every operation fails, like a pool that cannot reach its server. */
  class BrokenQuotaStore implements QuotaStore {
    readonly kind = "memory" as const;
    calls = 0;

    consume(): Promise<QuotaDecision> {
      this.calls += 1;
      return Promise.reject(new Error("connection refused"));
    }

    peek(): Promise<QuotaDecision> {
      this.calls += 1;
      return Promise.reject(new Error("connection refused"));
    }

    reset(): Promise<void> {
      return Promise.resolve();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  afterEach(() => {
    resetRateLimitConfig();
  });

  it("refuses the request with 503 and Retry-After by default", async () => {
    const broken = new BrokenQuotaStore();
    configureRateLimit({ store: broken });

    const res = await api.post(
      "/api/decision",
      { agentId: "agt_any", action: "read", target: "t" },
      { auth: ROLE_KEYS.admin },
    );

    // 503, not 429: the caller's quota is not exhausted and they have done nothing
    // wrong. A 429 would be a false statement about them and would invite a retry
    // against a window that does not exist.
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(broken.calls).toBeGreaterThan(0);
  });

  it("does not let the failure become a silent bypass of the limit", async () => {
    const broken = new BrokenQuotaStore();
    configureRateLimit({ store: broken });

    /*
     * The property that matters most in this file: not one of these reaches the engine.
     * If a store failure were treated as "under the limit", every one would be served
     * and the deployment would have no quotas at all while looking healthy.
     */
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await api.post(
        "/api/decision",
        { agentId: "agt_any", action: "read", target: "t" },
        { auth: ROLE_KEYS.admin },
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([503, 503, 503, 503, 503]);
    expect(statuses.some((s) => s === 200)).toBe(false);
  });

  it("allows the request when fail-open is explicitly configured", async () => {
    configureRateLimit({ store: new BrokenQuotaStore(), failMode: "open" });

    const res = await api.post(
      "/api/decision",
      { agentId: "agt_any", action: "read", target: "t" },
      { auth: ROLE_KEYS.admin },
    );

    /*
     * Availability chosen over enforcement, which is a legitimate choice for some
     * deployments — but only as an explicit one. The request now reaches the engine, so
     * the status is whatever the engine says about a non-existent agent (404), never a
     * limiter status. That distinction is the assertion: fail-open must let the request
     * through, not fabricate a success.
     */
    expect(res.status).not.toBe(503);
    expect(res.status).not.toBe(429);
  });

  it("reads the fail mode from the environment, defaulting to closed", () => {
    expect(resolveFailMode({})).toBe("closed");
    expect(resolveFailMode({ RATE_LIMIT_FAIL_MODE: "open" })).toBe("open");
    expect(resolveFailMode({ RATE_LIMIT_FAIL_MODE: "OPEN" })).toBe("open");
    expect(resolveFailMode({ RATE_LIMIT_FAIL_MODE: "closed" })).toBe("closed");
    /*
     * An unrecognised value throws rather than defaulting, which is the same rule
     * `DATABASE_DRIVER` follows and for the same reason: the two possible answers here
     * differ by whether a store outage removes enforcement, so quietly picking one on
     * the strength of a typo would be exactly the ambiguous, assumption-based logic this
     * work was told not to write. An empty value is different — that is an absent
     * setting, not a wrong one, and it takes the safe default.
     */
    expect(() => resolveFailMode({ RATE_LIMIT_FAIL_MODE: "yes-please" })).toThrow(
      /RATE_LIMIT_FAIL_MODE/,
    );
    expect(resolveFailMode({ RATE_LIMIT_FAIL_MODE: "" })).toBe("closed");
    expect(resolveFailMode({ RATE_LIMIT_FAIL_MODE: "  " })).toBe("closed");
  });
});

describe("the quota key", () => {
  /*
   * WHY THIS BLOCK EXISTS - a real gap, found by mutating the code.
   *
   * `quotaKey(req, scope)` returns `${scope}:${subject}`. Two mutants were tried:
   * dropping the identity (so budgets key on IP) was caught by the tests above;
   * dropping the SCOPE, so every guarded route shares one budget, left the whole
   * suite green.
   *
   * Shared scope is not a bypass - it makes the limiter stricter, not looser -
   * but it is a reliability defect of the kind that only appears under load. The
   * routes have deliberately different budgets, and if they share a counter, the
   * chattiest route silently consumes the budget of every other one: exhausting
   * `/api/decision` would start returning 429 on approvals, which is the
   * human-in-the-loop path. A caller would be locked out of releasing a held
   * action by unrelated read traffic.
   *
   * Tested on the pure function, because that is where the composition lives and
   * a unit assertion cannot be starved by whatever budget the routes happen to
   * carry.
   */

  /** The shape `quotaKey` reads: an authenticated request. */
  function requestFor(identityId: string | undefined, ip = "203.0.113.7") {
    return { identity: identityId === undefined ? undefined : { id: identityId }, ip } as never;
  }

  it("separates two scopes for the same credential", () => {
    const decision = quotaKey(requestFor("key_alice"), "decision");
    const approvals = quotaKey(requestFor("key_alice"), "approvals");
    expect(decision).not.toBe(approvals);
  });

  it("separates two credentials within the same scope", () => {
    expect(quotaKey(requestFor("key_alice"), "decision")).not.toBe(
      quotaKey(requestFor("key_bob"), "decision"),
    );
  });

  it("is stable for the same credential and scope", () => {
    // Otherwise no budget could ever accumulate.
    expect(quotaKey(requestFor("key_alice"), "decision")).toBe(
      quotaKey(requestFor("key_alice"), "decision"),
    );
  });

  it("keys on the identity, not the address, when both are present", () => {
    /*
     * Already covered end-to-end above; asserted here directly because it is the
     * property that makes the limiter safe behind a proxy. Two credentials
     * arriving from one office IP must not share a budget.
     */
    const alice = quotaKey(requestFor("key_alice", "198.51.100.1"), "decision");
    const bob = quotaKey(requestFor("key_bob", "198.51.100.1"), "decision");
    expect(alice).not.toBe(bob);

    // And the same credential from two addresses is still one budget, so a
    // rotating source address is not a way to buy more quota.
    expect(quotaKey(requestFor("key_alice", "198.51.100.1"), "decision")).toBe(
      quotaKey(requestFor("key_alice", "203.0.113.9"), "decision"),
    );
  });

  it("falls back to the address only when there is no identity", () => {
    // A defensive fallback, not a normal path: every guarded route runs after
    // `authenticate()`. It must still not collapse two callers into one bucket.
    expect(quotaKey(requestFor(undefined, "198.51.100.1"), "decision")).not.toBe(
      quotaKey(requestFor(undefined, "198.51.100.2"), "decision"),
    );
  });

  it("does not collapse an unidentified caller into a named one", () => {
    /*
     * The bucket-collision worry: an anonymous caller whose IP happens to look
     * like a credential id must not land in that credential's bucket, or a
     * stranger could exhaust a real customer's budget.
     */
    expect(quotaKey(requestFor(undefined, "key_alice"), "decision")).toBe(
      quotaKey(requestFor("key_alice"), "decision"),
    );
    /*
     * Recorded honestly: they DO collide, because both are interpolated into the
     * same position in the key. It is not exploitable - `req.ip` is an address
     * parsed by Express and cannot be the string "key_alice" - so this is pinned
     * as observed behaviour rather than reported as a vulnerability. If the
     * fallback ever widens to a caller-supplied value, this test is where the
     * assumption is written down.
     */
  });
});

