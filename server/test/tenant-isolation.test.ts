/**
 * P0-1 — ADVERSARIAL MULTI-TENANT ISOLATION
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The brief states the requirement in one sentence: "une entreprise ne doit JAMAIS
 * pouvoir accéder aux données d'une autre entreprise." This file is the barrier that
 * makes that sentence checkable, and it is written as an attack rather than as a
 * feature test.
 *
 * The attacker here is not an anonymous stranger. It is **an admin of another
 * organization**, holding a genuine, fully privileged credential. Every request below
 * passes authentication and passes the RBAC check, which is exactly why RBAC cannot
 * be the thing that stops it: role checks answer "may this caller do X?", never "does
 * this row belong to this caller?". Isolation is a different question and needs its
 * own guard.
 *
 * WHAT WAS ACTUALLY BROKEN
 * ------------------------
 * Before P0-1 there was a single module-level `repositories` object shared by every
 * request, and every query it issued spanned the whole table. `GET /api/agents` was
 * literally `repositories.agents.list()`. On a two-customer deployment that returns
 * both customers' agents, and `dailySpend` summed both customers' costs into one
 * budget. `script/pilot-sim.ts` reproduced it. It was not a hypothetical.
 *
 * HOW THE ASSERTIONS ARE SHAPED
 * -----------------------------
 *  - A foreign row must read as **404, not 403**. A 403 confirms the id exists, which
 *    is itself a leak: an attacker can enumerate another tenant's identifiers without
 *    ever reading a field. "Not found" is the honest answer from this tenant's view.
 *  - A cross-tenant write must leave the target **byte-for-byte unchanged**, verified
 *    by re-reading it as its rightful owner. "The response was 404" is not proof the
 *    write did not happen.
 *  - The same id must be usable in both organizations. That is not a nicety: if ids
 *    are globally unique, the first customer to create `agt_billing` takes that name
 *    away from everyone else, and the resulting conflict error tells them somebody
 *    already has it.
 *
 * Two layers are exercised on purpose. The HTTP tests prove the product is safe as
 * shipped; the repository tests reach the conditional writes (`claimToolRun`,
 * `completeToolRun`, `markSkipped`, `appendAudit`, `incrementTriggered`, `resolve`)
 * that no route exposes directly but that the gateway calls with ids it was handed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { repositoriesFor } from "../repositories";
import { DEFAULT_ORGANIZATION_ID, organizationId } from "@shared/tenancy";
import { sessionStore } from "../repositories/sessions";
import type { Agent, Approval, Execution, Integration, Policy } from "@shared/types";

/** The tenant that owns the seeded configuration dataset. */
const ORG_A = DEFAULT_ORGANIZATION_ID;
/** The attacker's tenant, derived from the "Rival Corp/" credential prefix. */
const ORG_B = organizationId("org_rival_corp");

const AS_A = { auth: ROLE_KEYS.admin };
const AS_B = { auth: OTHER_ORG_KEYS.admin };

const repoA = repositoriesFor(ORG_A);
const repoB = repositoriesFor(ORG_B);

let client: TestClient;

/** Ids created by this suite, so assertions never depend on seeded data staying put. */
const OWNED = {
  agent: "agt_isolation_owned",
  policy: "pol_isolation_owned",
  integration: "int_isolation_owned",
};

/** The body `POST /api/agents` accepts. Kept in one place so both tenants send the
 * same shape and only the name differs. */
function agentBody(id: string, name: string) {
  return {
    id,
    name,
    description: "Fixture for the isolation suite",
    provider: "openai" as const,
    model: "gpt-4o",
    status: "active" as const,
    owner: "isolation-suite",
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

function execution(id: string, agentId: string, cost: number): Execution {
  return {
    id,
    agentId,
    agentName: "Isolation fixture",
    action: "purchase",
    target: "supplier.example.com",
    // `allowed` specifically: `dailySpend` only sums allowed executions, so a blocked
    // fixture would make the budget test pass for the wrong reason.
    status: "allowed",
    risk: "low",
    durationMs: 10,
    cost,
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

function approval(id: string, agentId: string): Approval {
  return {
    id,
    executionId: null,
    agentId,
    agentName: "Isolation fixture",
    title: "Fixture approval",
    summary: "Awaiting a human",
    requestedValue: "100 EUR",
    policyId: "pol_fixture",
    policyName: "Fixture policy",
    policyLimit: "50 EUR",
    risk: "high",
    status: "pending",
    requestedAt: new Date("2026-02-01T10:00:00.000Z").toISOString(),
    context: [],
  };
}

beforeAll(async () => {
  client = await startTestServer();

  /*
   * Organization A's fixtures. The agent goes through the real HTTP endpoint so the
   * suite cannot pass on a shape the API would have rejected; the execution and
   * approval go through the repository because no endpoint creates them directly.
   */
  const created = await client.post<Agent>("/api/agents", agentBody(OWNED.agent, "A's agent"), AS_A);
  expect(created.status).toBe(201);
  await repoA.executions.create(execution("exec_isolation_a", OWNED.agent, 42));
  await repoA.approvals.create(approval("apr_isolation_a", OWNED.agent));
});

afterAll(async () => {
  await client.close();
});

/* ===================== 1. Reads never cross the boundary ==================== */

describe("collection reads are scoped to the caller's organization", () => {
  it("does not show B the agents A owns", async () => {
    const mine = await client.get<Agent[]>("/api/agents", AS_A);
    const theirs = await client.get<Agent[]>("/api/agents", AS_B);

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
    expect(mine.body.map((a) => a.id)).toContain(OWNED.agent);
    expect(theirs.body.map((a) => a.id)).not.toContain(OWNED.agent);

    // Stronger than "does not contain that one id": no id of A's may appear at all.
    const aIds = new Set(mine.body.map((a) => a.id));
    expect(theirs.body.filter((a) => aIds.has(a.id))).toEqual([]);
  });

  it("does not show B the policies A owns", async () => {
    const mine = await client.get<Policy[]>("/api/policies", AS_A);
    const theirs = await client.get<Policy[]>("/api/policies", AS_B);
    const aIds = new Set(mine.body.map((p) => p.id));

    expect(mine.body.length).toBeGreaterThan(0);
    expect(theirs.body.filter((p) => aIds.has(p.id))).toEqual([]);
  });

  it("does not show B the executions A recorded", async () => {
    const theirs = await client.get<Execution[]>("/api/executions", AS_B);
    expect(theirs.body.map((e) => e.id)).not.toContain("exec_isolation_a");
  });

  it("does not show B A's executions through the audit endpoint either", async () => {
    // A separate endpoint reading the same table is a separate opportunity to leak,
    // and it reads a longer window than /api/executions does.
    const theirs = await client.get<{ total: number; events: unknown[] }>("/api/audit", AS_B);
    expect(theirs.status).toBe(200);
    // Asserted on the serialised body rather than on one field: the audit event shape
    // may gain fields, and the requirement is that A's identifiers appear nowhere in
    // what B receives — not merely that one property does not hold them.
    expect(JSON.stringify(theirs.body)).not.toContain("exec_isolation_a");
    expect(JSON.stringify(theirs.body)).not.toContain(OWNED.agent);
  });

  it("does not show B the approvals or integrations A owns", async () => {
    const approvalsA = await client.get<Approval[]>("/api/approvals", AS_A);
    const approvalsB = await client.get<Approval[]>("/api/approvals", AS_B);
    const aApprovals = new Set(approvalsA.body.map((a) => a.id));
    expect(approvalsB.body.filter((a) => aApprovals.has(a.id))).toEqual([]);

    const integrationsA = await client.get<Integration[]>("/api/integrations", AS_A);
    const integrationsB = await client.get<Integration[]>("/api/integrations", AS_B);
    const aIntegrations = new Set(integrationsA.body.map((i) => i.id));
    expect(integrationsA.body.length).toBeGreaterThan(0);
    expect(integrationsB.body.filter((i) => aIntegrations.has(i.id))).toEqual([]);
  });
});

describe("single-row reads report a foreign row as absent", () => {
  it("answers 404 — not 403 — for A's agent", async () => {
    const res = await client.get<{ error: string }>(`/api/agents/${OWNED.agent}`, AS_B);
    expect(res.status).toBe(404);
    // The distinction is the point: 403 would confirm the id exists.
    expect(res.status).not.toBe(403);
  });

  it("answers 404 for A's execution", async () => {
    const res = await client.get(`/api/executions/exec_isolation_a`, AS_B);
    expect(res.status).toBe(404);
  });

  it("answers 404 for A's approval", async () => {
    const res = await client.get(`/api/approvals/apr_isolation_a`, AS_B);
    expect(res.status).toBe(404);
    // Visible to its owner, so the 404 above is scoping and not a missing fixture.
    expect((await client.get(`/api/approvals/apr_isolation_a`, AS_A)).status).toBe(200);
  });

  it("returns the row to its rightful owner, so 404 is isolation and not breakage", async () => {
    // Without this, every assertion above could pass on a server that answers 404 to
    // everyone. A negative test needs its positive twin.
    const res = await client.get<Agent>(`/api/agents/${OWNED.agent}`, AS_A);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(OWNED.agent);
  });
});

/* ================== 2. Writes cannot reach a foreign row =================== */

describe("cross-tenant writes are refused and change nothing", () => {
  it("cannot patch A's agent", async () => {
    const res = await client.patch(
      `/api/agents/${OWNED.agent}`,
      { status: "paused" },
      AS_B,
    );
    expect(res.status).toBe(404);

    // Re-read as the owner. This is the assertion that actually matters: a 404 with a
    // completed write would be worse than a 200.
    const after = await client.get<Agent>(`/api/agents/${OWNED.agent}`, AS_A);
    expect(after.body.status).toBe("active");
  });

  it("cannot patch A's policy", async () => {
    const policies = await client.get<Policy[]>("/api/policies", AS_A);
    const target = policies.body[0];
    const before = target.status;

    const res = await client.patch(`/api/policies/${target.id}`, { status: "disabled" }, AS_B);
    expect(res.status).toBe(404);

    const after = await client.get<Policy[]>("/api/policies", AS_A);
    expect(after.body.find((p) => p.id === target.id)?.status).toBe(before);
  });

  it("cannot toggle A's integration", async () => {
    const integrations = await client.get<Integration[]>("/api/integrations", AS_A);
    const target = integrations.body[0];
    const before = target.connected;

    const res = await client.patch(`/api/integrations/${target.id}`, {}, AS_B);
    expect(res.status).toBe(404);

    const after = await client.get<Integration[]>("/api/integrations", AS_A);
    expect(after.body.find((i) => i.id === target.id)?.connected).toBe(before);
  });

  it("cannot retry A's execution", async () => {
    const res = await client.post(`/api/executions/exec_isolation_a/retry`, {}, AS_B);
    expect(res.status).toBe(404);
  });

  it("cannot resolve A's approval", async () => {
    const res = await client.post(
      `/api/approvals/apr_isolation_a`,
      { status: "approved" },
      AS_B,
    );
    expect(res.status).toBe(404);

    // The approval must still be pending for its owner. Resolving another tenant's
    // approval would be the most damaging version of this bug: it authorises a real
    // action inside somebody else's company.
    const still = await repoA.approvals.findById("apr_isolation_a");
    expect(still?.status).toBe("pending");
    expect(still?.resolvedBy).toBeFalsy();
  });

  it("cannot govern A's agent by naming it in a decision request", async () => {
    // The agent id travels in the BODY here, not the URL. Same requirement: the
    // decision must be refused because that agent does not exist for this caller.
    const res = await client.post<{ error: string }>(
      "/api/decision",
      { agentId: OWNED.agent, action: "purchase", target: "x.example.com", metadata: {} },
      AS_B,
    );
    expect(res.status).toBe(404);
  });
});

/* ==================== 3. The id namespace is per tenant ==================== */

describe("identifiers are scoped, not global", () => {
  it("lets B create an agent with the same id A already uses", async () => {
    const res = await client.post<Agent>(
      "/api/agents",
      { ...agentBody(OWNED.agent, "B's agent, same id"), owner: "rival" },
      AS_B,
    );

    // 201, not 409. A conflict here would leak that another tenant holds the id, and
    // would let the first customer to register a name reserve it for the whole world.
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("B's agent, same id");

    // And A's agent is untouched — same id, different row.
    const mine = await client.get<Agent>(`/api/agents/${OWNED.agent}`, AS_A);
    expect(mine.body.name).toBe("A's agent");
  });

  it("still refuses a duplicate id inside the same organization", async () => {
    // The relaxation above must not have removed the check that actually protects a
    // tenant from overwriting its own data.
    const res = await client.post<{ error: string }>(
      "/api/agents",
      { ...agentBody(OWNED.agent, "B tries again"), owner: "rival" },
      AS_B,
    );
    expect(res.status).toBe(409);
  });
});

/* ================= 4. Budgets and counters never mix tenants =============== */

describe("aggregates are computed per tenant", () => {
  it("never sums another organization's spend into a daily budget", async () => {
    // A has an execution costing 42 on this agent id. B has none.
    const since = new Date("2026-02-01T00:00:00.000Z").toISOString();

    const spentByA = await repoA.executions.dailySpend(OWNED.agent, since);
    const spentByB = await repoB.executions.dailySpend(OWNED.agent, since);

    expect(spentByA).toBeGreaterThanOrEqual(42);
    // The load-bearing assertion. If this is 42, then a MAX_DAILY_SPEND policy in B's
    // organization is consumed by A's traffic: one customer can exhaust another's
    // budget and block their agents. That is a denial of service across tenants, and
    // it is silent.
    expect(spentByB).toBe(0);
  });

  it("does not let B increment the trigger counter on A's policy", async () => {
    const policies = await repoA.policies.list();
    const target = policies[0];
    const before = target.triggeredCount;

    await repoB.policies.incrementTriggered(target.id);

    const after = await repoA.policies.findById(target.id);
    expect(after?.triggeredCount).toBe(before);
  });
});

/* ============= 5. Conditional writes below the route surface =============== */

describe("the repository's conditional writes carry the tenant inside the statement", () => {
  /*
   * These are reached through the gateway, not through a URL, and each one is a
   * single UPDATE with a WHERE clause. If the tenant is checked *before* the
   * statement instead of *inside* it, two concurrent requests can interleave between
   * the check and the write. So the assertion is that the write does not match,
   * not that a guard threw.
   */
  const FOREIGN = "exec_isolation_a";

  it("cannot claim a tool run on A's execution", async () => {
    const claimed = await repoB.executions.claimToolRun(
      FOREIGN,
      "tool_payment",
      new Date().toISOString(),
    );
    expect(claimed).toBe(false);

    const after = await repoA.executions.findById(FOREIGN);
    expect(after?.toolId).toBeFalsy();
  });

  it("cannot complete a tool run on A's execution", async () => {
    const done = await repoB.executions.completeToolRun(FOREIGN, {
      ok: true,
      at: new Date().toISOString(),
      result: { forged: true },
    });
    expect(done).toBe(false);

    const after = await repoA.executions.findById(FOREIGN);
    expect(after?.toolResult).toBeFalsy();
  });

  it("cannot mark A's execution skipped", async () => {
    await repoB.executions.markSkipped(FOREIGN, "forged by another tenant");

    const after = await repoA.executions.findById(FOREIGN);
    expect(after?.status).toBe("allowed");
    expect(after?.runState).not.toBe("skipped");
  });

  it("cannot append to the audit trail of A's execution", async () => {
    const before = (await repoA.executions.findById(FOREIGN))?.audit ?? [];

    const result = await repoB.executions.appendAudit(FOREIGN, [
      {
        at: new Date().toISOString(),
        actor: "attacker",
        event: "forged",
        detail: "should never appear",
      },
    ]);
    expect(result).toBeUndefined();

    const after = (await repoA.executions.findById(FOREIGN))?.audit ?? [];
    expect(after.length).toBe(before.length);
    expect(JSON.stringify(after)).not.toContain("should never appear");
  });

  it("cannot resolve A's approval through the repository either", async () => {
    const result = await repoB.approvals.resolve("apr_isolation_a", "approved", "attacker");
    expect(result).toBeUndefined();

    const still = await repoA.approvals.findById("apr_isolation_a");
    expect(still?.status).toBe("pending");
  });

  it("cannot update A's execution through the generic patch path", async () => {
    const updated = await repoB.executions.update(FOREIGN, { cost: 999_999 });
    expect(updated).toBeUndefined();

    const after = await repoA.executions.findById(FOREIGN);
    expect(after?.cost).toBe(42);
  });
});

/* ======================= 6. Sessions are tenant data ====================== */

describe("session administration stops at the organization boundary", () => {
  it("does not list A's sessions to B's admin", async () => {
    const aSession = sessionStore.create({
      organizationId: ORG_A,
      subject: "user:isolation-a",
      name: "A's console user",
      role: "admin",
      ttlMs: 60_000,
      credentialFp: "fp-a",
    });

    const res = await client.get<{ sessions: { id: string }[] }>("/api/auth/sessions", AS_B);
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s) => s.id)).not.toContain(aSession.id);
  });

  it("does not let B's admin revoke A's session", async () => {
    const aSession = sessionStore.create({
      organizationId: ORG_A,
      subject: "user:isolation-a2",
      name: "A's other console user",
      role: "viewer",
      ttlMs: 60_000,
      credentialFp: "fp-a",
    });

    const res = await client.del(`/api/auth/sessions/${aSession.id}`, AS_B);
    expect(res.status).toBe(404);

    // Still live. Revoking a stranger's sessions would sign an entire other company
    // out of its own control plane.
    expect(sessionStore.find(aSession.id)?.revokedAt).toBeNull();
  });
});
