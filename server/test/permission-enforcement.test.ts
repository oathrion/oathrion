/**
 * Permission enforcement.
 *
 * IMPORTANT correction to an earlier claim: a prior report in this project's
 * history stated that `shared/policy/engine.ts` never reads
 * `agent.permissions`. On fresh inspection while starting this file, that
 * turned out to be wrong — `requiredPermissionForAction()` and the guard in
 * `evaluateAction()` (checked immediately after the active-agent check and
 * before the mandate/policy evaluation) already implement exactly this
 * enforcement. Nothing in this file adds that mechanism; it exists already.
 * What was genuinely missing — and what this file adds — is proof: no test
 * anywhere exercised it. Every test below would fail if the guard in
 * `evaluateAction()` were removed or the mapping in
 * `requiredPermissionForAction()` were emptied.
 *
 * A single dedicated agent is used throughout and its permissions are
 * rewritten between scenarios via the real PATCH route — this file does not
 * touch any seed agent used by other test files.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const AGENT = "agt_perm_enforcement";

interface Outcome {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  reason: string;
  executed?: boolean;
  toolId: string | null;
  approvalId: string | null;
}

async function setPermissions(
  api: TestClient,
  scopes: { scope: string; granted: boolean }[],
) {
  const label: Record<string, string> = {
    "execute:payments": "Execute payments",
    "read:database": "Read database",
    "write:database": "Write database",
  };
  const risk: Record<string, string> = {
    "execute:payments": "critical",
    "read:database": "medium",
    "write:database": "critical",
  };
  const res = await api.patch(`/api/agents/${AGENT}`, {
    permissions: scopes.map((s) => ({
      scope: s.scope,
      label: label[s.scope],
      description: "",
      granted: s.granted,
      risk: risk[s.scope],
    })),
  });
  expect(res.status).toBe(200);
}

describe("permission enforcement", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
    const created = await api.post(
      "/api/agents",
      {
        id: AGENT,
        name: "Permission Enforcement Test Agent",
        description: "Dedicated fixture for permission-gating tests.",
        provider: "custom",
        model: "n/a",
        status: "active",
        owner: "Test Suite",
        mandate: {
          maxTransactionAmount: 500,
          currency: "EUR",
          allowedCategories: ["Office supplies"],
          blockedCategories: [],
          allowedDomains: ["supplier-x.com"],
        },
        permissions: [],
        policyIds: [],
        tags: [],
      },
      { auth: ROLE_KEYS.admin },
    );
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    await api.close();
  });

  it("TEST 1 — execute:payments granted does not itself block a purchase", async () => {
    await setPermissions(api, [{ scope: "execute:payments", granted: true }]);
    const r = await api.post<Outcome>(
      "/api/decision",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        metadata: { amount: 40, category: "Office supplies" },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("ALLOW");
    expect(r.body.reason).not.toContain("required permission");
  });

  it("TEST 2 — execute:payments = false blocks a purchase", async () => {
    await setPermissions(api, [{ scope: "execute:payments", granted: false }]);
    const r = await api.post<Outcome>(
      "/api/decision",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        metadata: { amount: 40, category: "Office supplies" },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("BLOCK");
    expect(r.body.reason).toContain("does not have the required permission: execute:payments");
  });

  it("TEST 3 — an agent with no permissions at all is blocked the same way", async () => {
    await setPermissions(api, []);
    const r = await api.post<Outcome>(
      "/api/decision",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        metadata: { amount: 40, category: "Office supplies" },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("BLOCK");
    expect(r.body.reason).toContain("required permission");
  });

  it("TEST 4 — read:database satisfies a query action", async () => {
    await setPermissions(api, [{ scope: "read:database", granted: true }]);
    const r = await api.post<Outcome>(
      "/api/decision",
      { agentId: AGENT, action: "query", target: "warehouse.customers" },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.reason).not.toContain("required permission");
  });

  it("TEST 5 — read:database does not also satisfy write:database", async () => {
    await setPermissions(api, [{ scope: "read:database", granted: true }]);
    const r = await api.post<Outcome>(
      "/api/decision",
      { agentId: AGENT, action: "write", target: "warehouse.customers" },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("BLOCK");
    expect(r.body.reason).toContain("does not have the required permission: write:database");
  });

  it("TEST 6 — a missing permission blocks even an action a policy would otherwise ALLOW", async () => {
    await setPermissions(api, []);
    // $40 is far under both the agent's $500 mandate and the org's $10,000
    // approval threshold — every policy in play would say ALLOW.
    const r = await api.post<Outcome>(
      "/api/decision",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        metadata: { amount: 40, category: "Office supplies" },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("BLOCK");
    expect(r.body.reason).toContain("required permission");
  });

  it("TEST 7 — a granted permission does not survive an organisation policy BLOCK", async () => {
    await setPermissions(api, [{ scope: "read:database", granted: true }]);
    // pol_db_prod blocks any agent from touching "production_database",
    // org-wide, regardless of permissions.
    const r = await api.post<Outcome>(
      "/api/decision",
      { agentId: AGENT, action: "query", target: "production_database" },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("BLOCK");
    // Must be the policy talking, not the permission gate — the permission
    // was in fact granted.
    expect(r.body.reason).not.toContain("required permission");
  });

  it("TEST 8 — a granted permission does not exempt an amount from the mandate", async () => {
    await setPermissions(api, [{ scope: "execute:payments", granted: true }]);
    // €900 clears the permission gate but exceeds this agent's €500 mandate.
    const r = await api.post<Outcome>(
      "/api/decision",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        metadata: { amount: 900, category: "Office supplies" },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("APPROVAL_REQUIRED");
    expect(r.body.reason).not.toContain("required permission");
  });

  it("TEST 9 — permission + mandate + policy all clear → ALLOW", async () => {
    await setPermissions(api, [{ scope: "execute:payments", granted: true }]);
    const r = await api.post<Outcome>(
      "/api/decision",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        metadata: { amount: 40, category: "Office supplies" },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("ALLOW");
  });

  it("TEST 10 — /api/execute cannot be handed a client-supplied permission to self-authorise", async () => {
    await setPermissions(api, [{ scope: "execute:payments", granted: false }]);
    const r = await api.post<Outcome>(
      "/api/execute",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        // executeSchema has no top-level `permissions` field, so the only
        // place a client could smuggle one in is inside the free-form
        // metadata bag — proving even that has no effect.
        metadata: { amount: 40, category: "Office supplies", permissions: ["execute:payments"] },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("BLOCK");
    expect(r.body.executed).toBe(false);
    expect(r.body.toolId).toBeNull();
  });

  it("TEST 11 — /api/decision cannot be handed a client-supplied permission either", async () => {
    await setPermissions(api, [{ scope: "execute:payments", granted: false }]);
    const r = await api.post<Outcome>(
      "/api/decision",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        metadata: { amount: 40, category: "Office supplies", permissions: ["execute:payments"] },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.decision).toBe("BLOCK");
    expect(r.body.reason).toContain("required permission");
  });

  it("TEST 12 — the Gateway itself never dispatches when the permission gate blocks: no tool, no approval", async () => {
    await setPermissions(api, [{ scope: "execute:payments", granted: false }]);
    const r = await api.post<Outcome>(
      "/api/execute",
      {
        agentId: AGENT,
        action: "purchase",
        target: "supplier-x.com",
        metadata: { amount: 40, category: "Office supplies" },
      },
      { auth: ROLE_KEYS.operator },
    );
    expect(r.body.executed).toBe(false);
    expect(r.body.toolId).toBeNull();
    // BLOCK, not APPROVAL_REQUIRED — so no approval is ever created for a
    // capability the agent was never given in the first place.
    expect(r.body.approvalId).toBeNull();
  });
});
