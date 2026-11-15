/**
 * P3 — PER-ORGANIZATION QUOTAS
 *
 * WHAT HAS TO BE TRUE, AND WHY EACH CASE EXISTS
 * ---------------------------------------------
 * A quota is a mechanism that REFUSES a paying customer's request. That makes its
 * failure modes asymmetric and both bad in different ways:
 *
 *   - too permissive: one tenant fills the deployment and every other tenant degrades,
 *     which is the noisy-neighbour failure the roadmap entry names;
 *   - too strict: a legitimate customer's automation stops mid-run, which is an outage
 *     they did not cause and cannot diagnose.
 *
 * So the arithmetic is tested as arithmetic — off-by-one at the boundary, calendar
 * roll-over, a garbage environment value — and separately from the HTTP behaviour. The
 * three properties that carry the whole feature:
 *
 *   1. **The ceiling counts the tenant's own rows and nobody else's.** A quota that
 *      counted globally would let one busy tenant lock out a quiet one, which converts
 *      the isolation guarantee into a shared failure. Tested by filling org A to its
 *      ceiling and proving org B is unaffected.
 *   2. **The ceiling is shared inside one organization.** Two different credentials of
 *      the same tenant must see the same counter, otherwise the ceiling is per-key and
 *      a tenant multiplies it by issuing keys.
 *   3. **A refusal leaves nothing behind.** The guard runs inside the transaction that
 *      writes the execution, so a refused request must not leave a half-written row.
 *      Asserted by counting rows after the refusal, not by trusting the status code.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTAS,
  InvalidQuotaOverride,
  LIFETIME_PERIOD,
  QUOTA_COUNTER_NAMES,
  isQuotaCounter,
  limitsFor,
  parseQuotaOverrides,
  periodResetFor,
  periodStartFor,
  quotaKind,
} from "@shared/quotas";
import {
  QuotaExceededError,
  assertWithinQuota,
  configureQuotas,
  currentUsage,
  describeQuotaConfiguration,
  quotaLimitsFor,
  resetQuotaConfig,
  resolveQuotaMode,
  usageReport,
  flushPendingRefusals,
} from "../quotas";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { repositoriesFor } from "../repositories";
import { DEFAULT_ORGANIZATION_ID, organizationId, type OrganizationId } from "@shared/tenancy";
import type { Agent, Execution } from "@shared/types";
import { ERROR_CODES } from "@shared/error-codes";
import { resetRateLimits } from "../rate-limit";
import { rawDb } from "../db";

const ORG_A = DEFAULT_ORGANIZATION_ID;
const ORG_B = organizationId("org_rival_corp");
const AS_A = { auth: ROLE_KEYS.admin };
const AS_B = { auth: OTHER_ORG_KEYS.admin };

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  // Configuration is process-wide, so a test that changes it must hand the process
  // back as it found it or it silently rewrites the expectations of every test after it.
  resetQuotaConfig();
});

/* ========================================================================== *
 * The parser — the part an operator interacts with, and therefore mistypes
 * ========================================================================== */

describe("parseQuotaOverrides", () => {
  it("returns empty overrides for an unset or blank value", () => {
    // Not an error: no configuration means the defaults, which is the normal case.
    for (const raw of [undefined, "", "   ", ","]) {
      const parsed = parseQuotaOverrides(raw);
      expect(parsed.default).toEqual({});
      expect(parsed.byOrganization).toEqual({});
    }
  });

  it("reads a deployment-wide default", () => {
    const parsed = parseQuotaOverrides("default:agents=50");
    expect(parsed.default).toEqual({ agents: 50 });
  });

  it("reads a per-organization override", () => {
    const parsed = parseQuotaOverrides("org_acme:executions=5000");
    expect(parsed.byOrganization.org_acme).toEqual({ executions: 5000 });
  });

  it("accepts several entries, whitespace and mixed scopes", () => {
    const parsed = parseQuotaOverrides(" default:agents=10 , org_acme:agents=99 ,default:policies=3 ");
    expect(parsed.default).toEqual({ agents: 10, policies: 3 });
    expect(parsed.byOrganization.org_acme).toEqual({ agents: 99 });
  });

  it("accepts zero, which is a real configuration and not a mistake", () => {
    // A ceiling of zero is how an operator freezes a suspended tenant's writes without
    // deleting anything. It must not be confused with "unset".
    expect(parseQuotaOverrides("org_frozen:agents=0").byOrganization.org_frozen).toEqual({
      agents: 0,
    });
  });

  /*
   * Every rejection below is a REFUSAL, not a fallback. A silently ignored typo in a
   * quota is the worst outcome available: the operator believes a ceiling is in place,
   * and it is not. `InvalidQuotaOverride` reaches the boot check, which refuses to
   * start — loud, at deploy time, before any traffic.
   */
  it.each([
    ["agents=5", "no scope"],
    ["default:agents", "no value"],
    ["default:unknown=5", "a counter that does not exist"],
    ["default:agents=-1", "a negative ceiling"],
    ["default:agents=5O", "a letter O typed for a zero"],
    ["default:agents=5.5", "a fractional ceiling"],
    ["default:agents=1e3", "scientific notation, which Number() would accept as 1000"],
    ["default:agents= ", "an empty value"],
    ["default:agents=999999999999999999999", "a value beyond a safe integer"],
    [":agents=5", "an empty scope"],
  ])("refuses %j (%s)", (raw) => {
    expect(() => parseQuotaOverrides(raw)).toThrow(InvalidQuotaOverride);
  });

  it("names the offending entry in the message, so the operator can find it", () => {
    // A boot refusal that says only "invalid configuration" costs an operator the
    // outage window. The bad entry has to be quoted back.
    expect(() => parseQuotaOverrides("default:agents=5,default:policies=abc")).toThrow(
      /policies=abc|abc/,
    );
  });
});

describe("limitsFor", () => {
  it("falls back to the shipped defaults when nothing is configured", () => {
    const limits = limitsFor("org_anything", parseQuotaOverrides(undefined));
    for (const counter of QUOTA_COUNTER_NAMES) {
      expect(limits[counter]).toBe(DEFAULT_QUOTAS[counter]);
    }
  });

  it("prefers a per-organization value over the deployment default", () => {
    const overrides = parseQuotaOverrides("default:agents=10,org_acme:agents=99");
    expect(limitsFor("org_acme", overrides).agents).toBe(99);
    expect(limitsFor("org_other", overrides).agents).toBe(10);
  });

  it("leaves counters the override does not mention at their default", () => {
    // Partial overrides are the common case: an operator raises one ceiling for one
    // customer and must not have to restate the other two.
    const overrides = parseQuotaOverrides("org_acme:agents=99");
    expect(limitsFor("org_acme", overrides).executions).toBe(DEFAULT_QUOTAS.executions);
  });
});

/* ========================================================================== *
 * Periods — calendar arithmetic, where the bugs are
 * ========================================================================== */

describe("period arithmetic", () => {
  it("gives count counters a lifetime period, because they measure live rows", () => {
    // An agent that exists does not stop existing when the month turns, so resetting
    // its counter monthly would let a tenant accumulate without bound.
    expect(periodStartFor("agents", new Date("2026-03-15T12:00:00Z"))).toBe(LIFETIME_PERIOD);
    expect(periodResetFor("agents", new Date("2026-03-15T12:00:00Z"))).toBeNull();
  });

  it("gives the executions counter a UTC calendar month", () => {
    /*
     * The period is identified by the first instant of the month as a full ISO
     * timestamp rather than a "2026-03" label. Both identify the month, but this one
     * sorts lexicographically in the same order as chronologically, is unambiguous
     * about the timezone, and can be compared directly against the `resetAt` a refusal
     * hands back — a bare "2026-03" would need parsing rules written down somewhere.
     */
    expect(periodStartFor("executions", new Date("2026-03-15T12:00:00Z"))).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });

  it("uses UTC, not the server's local time", () => {
    /*
     * The month boundary must not depend on where the process runs. A deployment in
     * Africa/Dakar (UTC+0) and one in Asia/Tokyo (UTC+9) have to agree on which month
     * an execution belongs to, or the same customer is billed differently by region and
     * a quota resets twice at the boundary.
     */
    expect(periodStartFor("executions", new Date("2026-03-31T23:30:00Z"))).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    expect(periodStartFor("executions", new Date("2026-04-01T00:30:00Z"))).toBe(
      "2026-04-01T00:00:00.000Z",
    );
  });

  it("rolls over from December to January of the next year", () => {
    // The classic off-by-one: month 12 + 1 must become year+1 month 01, not month 13.
    expect(periodResetFor("executions", new Date("2026-12-20T00:00:00Z"))).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("handles February in a leap year and in a common year", () => {
    expect(periodResetFor("executions", new Date("2028-02-29T23:59:59Z"))).toBe(
      "2028-03-01T00:00:00.000Z",
    );
    expect(periodResetFor("executions", new Date("2026-02-28T23:59:59Z"))).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });

  it("resets at the first instant of the next month, never inside the current one", () => {
    // A reset timestamp in the past would make `Retry-After` negative and tell a client
    // to retry immediately against a wall.
    for (const day of ["2026-01-01T00:00:00Z", "2026-01-15T12:00:00Z", "2026-01-31T23:59:59Z"]) {
      const at = new Date(day);
      const reset = periodResetFor("executions", at);
      expect(reset).not.toBeNull();
      expect(Date.parse(reset as string)).toBeGreaterThan(at.getTime());
    }
  });
});

describe("counter metadata", () => {
  it("knows exactly the three counters the product enforces", () => {
    expect([...QUOTA_COUNTER_NAMES].sort()).toEqual(["agents", "executions", "policies"]);
  });

  it("rejects an unknown counter name", () => {
    for (const value of ["", "Agents", "audit", null, 7, undefined]) {
      expect(isQuotaCounter(value)).toBe(false);
    }
    expect(isQuotaCounter("agents")).toBe(true);
  });

  it("classifies each counter as live rows or events in a period", () => {
    expect(quotaKind("agents")).toBe("count");
    expect(quotaKind("policies")).toBe("count");
    expect(quotaKind("executions")).toBe("period");
  });
});

/* ========================================================================== *
 * Mode resolution
 * ========================================================================== */

describe("resolveQuotaMode", () => {
  it("enforces by default", () => {
    // The safe default. A deployment that forgot to configure a mode must not be the
    // one where ceilings quietly do nothing.
    expect(resolveQuotaMode({})).toBe("enforce");
  });

  it("accepts observe, which measures without refusing", () => {
    expect(resolveQuotaMode({ OATHRION_QUOTA_MODE: "observe" })).toBe("observe");
    expect(resolveQuotaMode({ OATHRION_QUOTA_MODE: " OBSERVE " })).toBe("observe");
  });

  it("observes by default in local mode, where there is no other tenant to protect (§5.75)", () => {
    expect(resolveQuotaMode({}, true)).toBe("observe");
    expect(resolveQuotaMode({ OATHRION_QUOTA_MODE: "enforce" }, true)).toBe("enforce");
    expect(resolveQuotaMode({}, false)).toBe("enforce");
  });

  it("treats a blank value as unset rather than as an error", () => {
    // An exported-but-empty variable is a normal shell artefact, not an operator
    // stating an intention, so it means "unconfigured".
    expect(resolveQuotaMode({ OATHRION_QUOTA_MODE: "" })).toBe("enforce");
    expect(resolveQuotaMode({ OATHRION_QUOTA_MODE: "   " })).toBe("enforce");
  });

  it("refuses an unrecognised value instead of guessing", () => {
    /*
     * Deliberately unlike `OATHRION_MAX_TOOL_ATTEMPTS` in server/limits.ts, which warns and
     * falls back. There, a fallback keeps a safety ceiling in place, so the safe answer
     * is obvious. Here there is none: reading `observ` as `enforce` could start refusing
     * a live customer's traffic in a deployment whose operator meant to observe, and
     * reading it as `observe` would silently remove every ceiling. `runtimeConfigProblems`
     * turns this into a refusal to boot — loud, at deploy time, before any traffic.
     */
    for (const raw of ["observ", "off", "none", "true", "0", "ENFORCE_ALL"]) {
      expect(() => resolveQuotaMode({ OATHRION_QUOTA_MODE: raw })).toThrow(/OATHRION_QUOTA_MODE/);
    }
  });
});

describe("describeQuotaConfiguration", () => {
  it("reports the mode and the effective ceilings", () => {
    configureQuotas({ overrides: parseQuotaOverrides("org_acme:agents=7"), mode: "observe" });
    const described = describeQuotaConfiguration();
    expect(described).toContain("observe");
    expect(described).toContain("org_acme");
    expect(described).toContain("7");
  });

  it("contains no secret", () => {
    // Printed at boot into whatever collects stdout, so it must be safe there.
    configureQuotas({ overrides: parseQuotaOverrides("default:agents=7") });
    const described = describeQuotaConfiguration();
    expect(described).not.toMatch(/secret|token|password|key=/i);
  });
});

/* ========================================================================== *
 * The guard itself
 * ========================================================================== */

describe("assertWithinQuota", () => {
  beforeEach(() => {
    resetQuotaConfig();
  });

  it("allows a write strictly below the ceiling", () => {
    configureQuotas({ overrides: parseQuotaOverrides("default:agents=500") });
    expect(() => assertWithinQuota(ORG_A, "agents")).not.toThrow();
  });

  it("refuses at the ceiling, not one past it", async () => {
    /*
     * The boundary that decides whether a customer sold "500 agents" can create the
     * 500th or the 501st. With `used === limit` the tenant holds exactly the number
     * they were sold and the next create is refused, which is what the number means.
     */
    const org = organizationId("org_quota_boundary");
    const repo = repositoriesFor(org);
    await repo.agents.create(agentFixture("agt_boundary_1"));
    await repo.agents.create(agentFixture("agt_boundary_2"));

    configureQuotas({ overrides: parseQuotaOverrides(`${org}:agents=3`) });
    expect(currentUsage(org, "agents")).toBe(2);
    // Third is allowed: 2 < 3.
    expect(() => assertWithinQuota(org, "agents")).not.toThrow();
    await repo.agents.create(agentFixture("agt_boundary_3"));
    // Fourth is not: 3 is not < 3.
    expect(() => assertWithinQuota(org, "agents")).toThrow(QuotaExceededError);
  });

  it("carries the numbers a caller needs in order to act", () => {
    const org = organizationId("org_quota_numbers");
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:agents=0`) });
    try {
      assertWithinQuota(org, "agents");
      expect.unreachable("the guard must refuse at a ceiling of zero");
    } catch (error) {
      const refusal = error as QuotaExceededError;
      expect(refusal.counter).toBe("agents");
      expect(refusal.limit).toBe(0);
      expect(refusal.used).toBe(0);
      // A ceiling on live rows is not resolved by waiting, so there is no reset time.
      expect(refusal.resetAt).toBeNull();
      expect(refusal.status).toBe(409);
    }
  });

  it("answers 429 with a reset time for a counter that a period resets", () => {
    const org = organizationId("org_quota_period");
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:executions=0`) });
    try {
      assertWithinQuota(org, "executions");
      expect.unreachable("the guard must refuse at a ceiling of zero");
    } catch (error) {
      const refusal = error as QuotaExceededError;
      expect(refusal.status).toBe(429);
      // Waiting genuinely helps here, so the caller is told when.
      expect(refusal.resetAt).not.toBeNull();
      expect(Date.parse(refusal.resetAt as string)).toBeGreaterThan(Date.now());
    }
  });

  it("measures but does not refuse in observe mode", () => {
    /*
     * The migration path the roadmap asks for: an operator turning quotas on for an
     * existing deployment needs to learn who would have been refused BEFORE refusing
     * them. Observe mode is what makes enabling this safe on a live install.
     */
    const org = organizationId("org_quota_observe");
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:agents=0`), mode: "observe" });
    expect(() => assertWithinQuota(org, "agents")).not.toThrow();

    // The breach is still recorded, which is the entire point of observing.
    const report = usageReport(org).find((entry) => entry.counter === "agents");
    expect(report?.refusals).toBeGreaterThan(0);
  });
});

/* ========================================================================== *
 * Property 1 and 2 — the counter belongs to the organization, and to all of it
 * ========================================================================== */

describe("a quota is per organization", () => {
  beforeEach(() => {
    resetRateLimits();
    resetQuotaConfig();
  });

  it("does not let one tenant's usage refuse another tenant", async () => {
    /*
     * The noisy-neighbour property, and the reason a quota belongs in a multi-tenant
     * control plane at all. Org A is filled to a ceiling of 1; org B must still be able
     * to create, because its own counter is at zero.
     */
    const busy = organizationId("org_quota_busy");
    const quiet = organizationId("org_quota_quiet");
    await repositoriesFor(busy).agents.create(agentFixture("agt_busy_1"));

    configureQuotas({ overrides: parseQuotaOverrides(`default:agents=1`) });

    expect(() => assertWithinQuota(busy, "agents")).toThrow(QuotaExceededError);
    expect(() => assertWithinQuota(quiet, "agents")).not.toThrow();
  });

  it("counts only the asking tenant's rows", async () => {
    const alpha = organizationId("org_quota_alpha");
    const beta = organizationId("org_quota_beta");
    await repositoriesFor(alpha).agents.create(agentFixture("agt_shared_id"));
    await repositoriesFor(beta).agents.create(agentFixture("agt_shared_id"));
    await repositoriesFor(beta).agents.create(agentFixture("agt_beta_only"));

    // The same id exists in both tenants — P0-1's namespacing — and each counter sees
    // only its own side of it.
    expect(currentUsage(alpha, "agents")).toBe(1);
    expect(currentUsage(beta, "agents")).toBe(2);
  });

  it("is shared by every credential of the same organization", async () => {
    /*
     * If the counter were keyed by credential instead of by tenant, a customer would
     * raise their own ceiling simply by issuing a second API key. Two distinct
     * credentials of org A are used here and must see one counter.
     */
    const before = await client.get<{ counters: { counter: string; used: number }[] }>(
      "/api/usage",
      AS_A,
    );
    const usedByAdmin =
      before.body.counters.find((entry) => entry.counter === "agents")?.used ?? -1;

    const asViewer = await client.get<{ counters: { counter: string; used: number }[] }>(
      "/api/usage",
      { auth: ROLE_KEYS.viewer },
    );
    const usedByViewer =
      asViewer.body.counters.find((entry) => entry.counter === "agents")?.used ?? -2;

    expect(usedByAdmin).toBe(usedByViewer);
    expect(usedByAdmin).toBeGreaterThanOrEqual(0);
  });
});

/* ========================================================================== *
 * GET /api/usage
 * ========================================================================== */

describe("GET /api/usage", () => {
  beforeEach(() => {
    resetRateLimits();
    resetQuotaConfig();
  });

  it("reports every counter with its ceiling and what remains", async () => {
    const res = await client.get<{
      organizationId: string;
      counters: {
        counter: string;
        kind: string;
        used: number;
        limit: number;
        remaining: number;
        resetAt: string | null;
      }[];
    }>("/api/usage", AS_A);

    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(ORG_A);
    expect(res.body.counters.map((entry) => entry.counter).sort()).toEqual([
      "agents",
      "executions",
      "policies",
    ]);
    for (const entry of res.body.counters) {
      // `remaining` is derived, and a negative value would be nonsense to show a user
      // even when a ceiling was lowered below current usage.
      expect(entry.remaining).toBe(Math.max(entry.limit - entry.used, 0));
      expect(entry.used).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports the caller's own organization and never another", async () => {
    const a = await client.get<{ organizationId: string }>("/api/usage", AS_A);
    const b = await client.get<{ organizationId: string }>("/api/usage", AS_B);
    expect(a.body.organizationId).toBe(ORG_A);
    expect(b.body.organizationId).toBe(ORG_B);
  });

  it("requires a credential", async () => {
    // Usage figures are business information about a customer; they are not public.
    const res = await client.get("/api/usage", { auth: null });
    expect(res.status).toBe(401);
  });

  it("is readable by a viewer, because it is a fact about their own tenant", async () => {
    const res = await client.get("/api/usage", { auth: ROLE_KEYS.viewer });
    expect(res.status).toBe(200);
  });

  it("reflects a lowered ceiling immediately, without a restart", async () => {
    configureQuotas({ overrides: parseQuotaOverrides(`${ORG_A}:agents=3`) });
    const res = await client.get<{ counters: { counter: string; limit: number }[] }>(
      "/api/usage",
      AS_A,
    );
    expect(res.body.counters.find((entry) => entry.counter === "agents")?.limit).toBe(3);
  });
});

/* ========================================================================== *
 * Over HTTP — the refusal a customer actually receives
 * ========================================================================== */

describe("a refused write over HTTP", () => {
  beforeEach(() => {
    resetRateLimits();
    resetQuotaConfig();
  });

  it("answers 409 with quota_exceeded and the numbers, for a ceiling on live rows", async () => {
    configureQuotas({ overrides: parseQuotaOverrides(`${ORG_B}:agents=0`) });
    const res = await client.post<{
      code: string;
      counter: string;
      limit: number;
      used: number;
      resetAt: string | null;
      message: string;
    }>("/api/agents", agentBody("agt_quota_refused"), AS_B);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ERROR_CODES.quotaExceeded);
    expect(res.body.counter).toBe("agents");
    expect(res.body.limit).toBe(0);
    expect(res.body.resetAt).toBeNull();
    // No `Retry-After`: waiting does not free a slot that only a deletion frees.
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("does not create the row it refused", async () => {
    configureQuotas({ overrides: parseQuotaOverrides(`${ORG_B}:agents=0`) });
    await client.post("/api/agents", agentBody("agt_quota_not_created"), AS_B);
    resetQuotaConfig();

    // Asked as the rightful owner, with the quota lifted: the row must be absent. "The
    // response was 409" is not proof that nothing was written.
    const res = await client.get(`/api/agents/agt_quota_not_created`, AS_B);
    expect(res.status).toBe(404);
  });

  it("answers 429 with Retry-After for a ceiling on events in a period", async () => {
    configureQuotas({ overrides: parseQuotaOverrides(`${ORG_B}:executions=0`) });
    const agent = await seedAgent(ORG_B, "agt_quota_exec_source");

    const res = await client.post<{ code: string; counter: string; resetAt: string | null }>(
      "/api/decision",
      { agentId: agent, action: "read_file", target: "notes.txt" },
      AS_B,
    );

    expect(res.status).toBe(429);
    expect(res.body.code).toBe(ERROR_CODES.quotaExceeded);
    expect(res.body.counter).toBe("executions");
    expect(res.body.resetAt).not.toBeNull();
    // Present and positive, because for this counter waiting is the remedy.
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("leaves no execution row behind when it refuses one", async () => {
    /*
     * The guard runs INSIDE the transaction that writes the execution and its approval,
     * so a refusal must roll both back. Counted directly in the database rather than
     * through the API, because a half-written execution is exactly the kind of row a
     * scoped list might not show.
     */
    const org = organizationId("org_quota_rollback");
    const agent = await seedAgent(org, "agt_rollback_source");
    const countRows = () =>
      (
        rawDb
          .prepare(`SELECT COUNT(*) AS n FROM executions WHERE organization_id = ?`)
          .get(org) as { n: number }
      ).n;

    const before = countRows();
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:executions=0`) });

    await expect(
      repositoriesFor(org).executions.create(executionFixture("exec_rolled_back", agent)),
    ).rejects.toThrow(QuotaExceededError);

    expect(countRows()).toBe(before);
  });

  it("still counts the refusal even though the transaction that carried it rolled back", async () => {
    /*
     * The companion to the test above, and a real defect this file shipped with.
     *
     * The guard runs inside `db.transaction(...)`, and refusing means throwing, which
     * rolls the transaction back. The first implementation wrote the refusal measurement
     * inline — so the rollback discarded it, and `refusals` stayed at 0 forever on the
     * executions path no matter how many callers were refused.
     *
     * That is not a cosmetic loss. `refusals` is the number an operator reads during
     * `observe` mode to decide whether switching to `enforce` will break a paying
     * customer. A permanent 0 answers "nobody would be refused" to the only question the
     * mode exists to answer.
     *
     * Found by driving the built bundle with executions=0 and watching the counter stay
     * at 0 after a genuine 429 — no test and no type error had caught it.
     */
    const org = organizationId("org_quota_refusal_survives");
    const agent = await seedAgent(org, "agt_refusal_survives");
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:executions=0`) });

    /*
     * Through `createExecutionWithApproval` and NOT `executions.create`: only the former
     * runs inside `rawDb.transaction(...)`, and the transaction is the whole point of this
     * test. Using the non-transactional method here would make the test pass against the
     * defective implementation, which is how the defect survived the first suite.
     */
    await expect(
      repositoriesFor(org).createExecutionWithApproval(
        executionFixture("exec_refusal_counted", agent),
        null,
      ),
    ).rejects.toThrow(QuotaExceededError);

    flushPendingRefusals();

    const report = usageReport(org).find((entry) => entry.counter === "executions");
    expect(report?.refusals).toBe(1);
    // And the execution itself is still absent: counting the refusal must not have
    // resurrected any part of the rolled-back write.
    expect(report?.used).toBe(0);
  });

  it("collapses a burst of refusals into one row without losing any of them", () => {
    /*
     * Deferring the write means several refusals can be pending at once. They are merged
     * into a single statement per counter, so the merge must ADD the attempts rather than
     * overwrite: a loop that refused five callers and reported one refusal would
     * understate the pressure by the exact factor an operator is trying to measure.
     */
    const org = organizationId("org_quota_burst");
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:policies=0`) });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => assertWithinQuota(org, "policies")).toThrow(QuotaExceededError);
    }
    flushPendingRefusals();
    const report = usageReport(org).find((entry) => entry.counter === "policies");
    expect(report?.refusals).toBe(5);
  });

  it("is safe to flush when nothing is pending", () => {
    // Called on a timer that may fire after the queue has already been drained.
    expect(() => flushPendingRefusals()).not.toThrow();
    expect(() => flushPendingRefusals()).not.toThrow();
  });

  it("still refuses when the same tenant retries, and counts the refusal", async () => {
    // A refusal is not a transient error: repeating the request must not eventually
    // succeed, and each attempt must be visible to an operator.
    const org = organizationId("org_quota_repeat");
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:agents=0`) });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => assertWithinQuota(org, "agents")).toThrow(QuotaExceededError);
    }
    // Refusals are written after the stack unwinds, so that a rollback cannot discard
    // them. Flushed explicitly here rather than waiting on the event loop.
    flushPendingRefusals();
    const report = usageReport(org).find((entry) => entry.counter === "agents");
    expect(report?.refusals).toBeGreaterThanOrEqual(3);
  });

  it("allows the write again once the ceiling is raised", async () => {
    // The remedy has to work. A ceiling that cannot be lifted without a restart is an
    // outage waiting for the operator who lowered it by mistake.
    const org = organizationId("org_quota_raised");
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:agents=0`) });
    expect(() => assertWithinQuota(org, "agents")).toThrow(QuotaExceededError);
    configureQuotas({ overrides: parseQuotaOverrides(`${org}:agents=5`) });
    expect(() => assertWithinQuota(org, "agents")).not.toThrow();
  });
});

describe("quotaLimitsFor", () => {
  it("returns the shipped defaults when the process is unconfigured", () => {
    resetQuotaConfig();
    const limits = quotaLimitsFor(ORG_A);
    expect(limits.agents).toBe(DEFAULT_QUOTAS.agents);
    expect(limits.executions).toBe(DEFAULT_QUOTAS.executions);
  });

  it("ships defaults generous enough for the traffic script/pilot-sim.ts models", () => {
    /*
     * Calibration, not a preference. `script/pilot-sim.ts` ages a database to ninety
     * days of one pilot company's traffic and produces 5 760 executions — roughly 1 900
     * a month. A default that refused that shape of customer would make the product
     * unusable out of the box, so the shipped ceiling is far above it and an operator
     * lowers it deliberately.
     */
    expect(DEFAULT_QUOTAS.executions).toBeGreaterThan(1_900 * 10);
  });
});

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** A complete `Agent`, matching `shared/types.ts` so the repository accepts it. */
function agentFixture(id: string): Agent {
  return {
    id,
    name: "Quota fixture",
    description: "Fixture for the quota suite",
    provider: "openai",
    model: "gpt-4o",
    status: "active",
    currentTask: null,
    owner: "quota-suite",
    createdAt: new Date("2026-02-01T10:00:00.000Z").toISOString(),
    executions24h: 0,
    successRate: 100,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "low",
    permissions: [],
    mandate: {
      maxTransactionAmount: 100,
      currency: "EUR",
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
    policyIds: [],
    tags: [],
  };
}

/** The body `POST /api/agents` accepts, matching `tenant-isolation.test.ts`. */
function agentBody(id: string) {
  return {
    id,
    name: "Quota fixture",
    description: "Fixture for the quota suite",
    provider: "openai" as const,
    model: "gpt-4o",
    status: "active" as const,
    owner: "quota-suite",
    mandate: {
      maxTransactionAmount: 100,
      currency: "EUR" as const,
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
    permissions: [],
    policyIds: [],
    tags: [],
  };
}

async function seedAgent(org: OrganizationId, id: string): Promise<string> {
  await repositoriesFor(org).agents.create(agentFixture(id));
  return id;
}

/** A complete `Execution`, copied in shape from `tenant-isolation.test.ts`. */
function executionFixture(id: string, agentId: string): Execution {
  return {
    id,
    agentId,
    agentName: "Quota fixture",
    action: "purchase",
    target: "supplier.example.com",
    status: "allowed",
    risk: "low",
    durationMs: 10,
    cost: 0,
    timestamp: new Date("2026-02-01T10:00:00.000Z").toISOString(),
    input: {},
    decision: "allow",
    decisionReason: "fixture",
    policyEvaluated: null,
    policyId: null,
    result: "",
    audit: [],
    approvalId: null,
  };
}
