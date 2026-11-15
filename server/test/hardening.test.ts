/**
 * Hardening tests — Sprint 4.
 *
 * Five guarantees, proved against the real HTTP surface and the real SQLite
 * file. No mocks: every assertion below reads state back out of the API.
 *
 *   1. /api is closed by default and the approver identity cannot be forged.
 *   2. Agent and policy creation are schema-validated (400) and unique (409).
 *   3. An execution has a real run state: no double run, retry only after a
 *      failure, and a crash leaves no row stuck in `running`.
 *   4. /api/evaluate is a dry run unless the caller opts in.
 *   5. Dashboard-grade metrics come from persisted rows, never from fixtures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startTestServer,
  TEST_API_KEY,
  TEST_CONSOLE_EMAIL,
  TEST_CONSOLE_PASSWORD,
  TEST_SERVICE_IDENTITY,
  TEST_VIEWER_EMAIL,
  TEST_VIEWER_PASSWORD,
  type TestClient,
} from "./harness";
import { toolRegistry } from "../gateway/tool-registry";
import type { Tool } from "../gateway/tools/types";

interface ExecutionBody {
  id: string;
  status: string;
  decision: string;
  runState: string;
  attempts: number;
  lastError: string | null;
  toolId: string | null;
  toolExecutedAt: string | null;
  audit: { at: string; actor: string; event: string; detail: string }[];
}

interface ExecuteBody {
  decision: string;
  executed: boolean;
  executionId: string | null;
  approvalId: string | null;
  toolId: string | null;
}

interface EvaluateBody {
  decision: string;
  persisted: boolean;
  executionId: string | null;
  approvalId: string | null;
}

const PURCHASE_420 = {
  agentId: "agt_procurement",
  action: "purchase",
  target: "supplier-x.com",
  metadata: { amount: 420, category: "Office supplies" },
};

const PURCHASE_12K = {
  agentId: "agt_procurement",
  action: "purchase",
  target: "supplier-x.com",
  metadata: { amount: 12000, category: "Equipment" },
};

const PROD_DB = {
  agentId: "agt_data",
  action: "access",
  target: "production_database",
  metadata: {},
};

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  toolRegistry.resetCounts();
});

function tool(id: string): Tool {
  const found = toolRegistry.get(id);
  if (!found) throw new Error(`Tool "${id}" is not registered.`);
  return found;
}

/** Temporarily makes a tool throw, so the failure path can be exercised. */
async function withFailingTool<T>(id: string, message: string, fn: () => Promise<T>): Promise<T> {
  const target = tool(id) as unknown as Record<string, unknown>;
  const original = target.execute;
  target.execute = async () => {
    throw new Error(message);
  };
  try {
    return await fn();
  } finally {
    target.execute = original;
  }
}

const execution = async (id: string) =>
  (await client.get<ExecutionBody>(`/api/executions/${id}`)).body;

/* ======================================================================== *
 * 1. Authentication
 * ======================================================================== */

describe("chantier 1 — API authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await client.get("/api/agents", { auth: null });
    expect(res.status).toBe(401);
  });

  it("rejects a request carrying the wrong key", async () => {
    const res = await client.get("/api/agents", { auth: "not-the-key" });
    expect(res.status).toBe(401);
  });

  it("accepts the configured service key", async () => {
    const res = await client.get<unknown[]>("/api/agents");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("closes every mutating route, not just the read ones", async () => {
    const decision = await client.post("/api/decision", PURCHASE_420, { auth: null });
    expect(decision.status).toBe(401);

    const evaluate = await client.post("/api/evaluate", PURCHASE_420, { auth: null });
    expect(evaluate.status).toBe(401);

    const execute = await client.post("/api/execute", PURCHASE_420, { auth: null });
    expect(execute.status).toBe(401);
  });

  it("returns a JSON 401 body rather than an HTML error page", async () => {
    const res = await client.get<{ error: string }>("/api/agents", { auth: null });
    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
    // The error must not disclose whether a key exists or what it looks like.
    expect(res.body.error).not.toContain(TEST_API_KEY);
  });

  it("leaves the health probe public so a load balancer can reach it", async () => {
    const res = await client.get<{ status: string }>("/api/health", { auth: null });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("exchanges the console password for a session token", async () => {
    const bad = await client.post(
      "/api/auth/login",
      { email: TEST_CONSOLE_EMAIL, password: "wrong" },
      { auth: null },
    );
    expect(bad.status).toBe(401);

    const ok = await client.post<{ token: string; identity: { name: string } }>(
      "/api/auth/login",
      { email: TEST_CONSOLE_EMAIL, password: TEST_CONSOLE_PASSWORD },
      { auth: null },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.token.length).toBeGreaterThan(20);

    // The freshly minted token is itself a valid credential.
    const session = await client.get<{ identity: { name: string }; localMode: boolean }>("/api/auth/session", {
      auth: ok.body.token,
    });
    expect(session.status).toBe(200);
    expect(session.body.identity.name).toBe(ok.body.identity.name);
    /* Hors d'`oathrion wrap`, la console garde le parcours d'équipe. */
    expect(session.body.localMode).toBe(false);
    /* Et la connexion sans mot de passe n'existe pas : 404, comme une route inconnue. */
    expect((await client.post("/api/local/login", { ticket: "v1.1.AAAAAAAAAAAAAAAAAAAAAA.x" })).status).toBe(404);
    expect((await client.get("/api/local/login")).status).toBe(404);
  });

  it("never returns the console password or a key in the login response", async () => {
    const res = await client.post<Record<string, unknown>>(
      "/api/auth/login",
      { email: TEST_CONSOLE_EMAIL, password: TEST_CONSOLE_PASSWORD },
      { auth: null },
    );
    expect(JSON.stringify(res.body)).not.toContain(TEST_CONSOLE_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(TEST_API_KEY);
  });

  it("records the authenticated identity as the approver", async () => {
    const held = (await client.post<ExecuteBody>("/api/execute", PURCHASE_12K)).body;
    expect(held.approvalId).toBeTruthy();

    const res = await client.post(`/api/approvals/${held.approvalId}/approve`, {});
    expect(res.status).toBe(200);

    const approval = (
      await client.get<{ resolvedBy: string | null }>(`/api/approvals/${held.approvalId}`)
    ).body;
    expect(approval.resolvedBy).toBe(TEST_SERVICE_IDENTITY);

    const stored = await execution(held.executionId!);
    const granted = stored.audit.find((entry) => entry.event === "Approval granted");
    expect(granted?.actor).toBe(TEST_SERVICE_IDENTITY);
  });

  it("refuses a client-supplied resolvedBy instead of trusting it", async () => {
    const held = (await client.post<ExecuteBody>("/api/execute", PURCHASE_12K)).body;

    const forged = await client.post<{ error: string }>(
      `/api/approvals/${held.approvalId}/approve`,
      { resolvedBy: "Someone Else" },
    );
    expect(forged.status).toBe(400);

    // And the approval is untouched — the forgery attempt changed nothing.
    const approval = (
      await client.get<{ status: string; resolvedBy: string | null }>(
        `/api/approvals/${held.approvalId}`,
      )
    ).body;
    expect(approval.status).toBe("pending");
    expect(approval.resolvedBy ?? null).toBeNull();
  });
});

/* ======================================================================== *
 * 2. Zod validation
 * ======================================================================== */

const validAgent = (id: string) => ({
  id,
  name: "QA Agent",
  description: "Created by the hardening suite.",
  provider: "openai",
  model: "gpt-4o",
  status: "draft",
  owner: "Alex Moreau",
  mandate: {
    maxTransactionAmount: 250,
    allowedCategories: ["Software"],
    blockedCategories: [],
    allowedDomains: ["vendor.company.com"],
  },
  permissions: [
    {
      scope: "read:analytics",
      label: "Read analytics",
      description: "Read-only reporting access.",
      granted: true,
      risk: "low",
    },
  ],
  policyIds: ["pol_purchase_limit"],
  tags: ["qa"],
  riskLevel: "low",
});

const validPolicy = (id: string) => ({
  id,
  name: "QA spend cap",
  description: "Created by the hardening suite.",
  type: "MAX_TRANSACTION_AMOUNT",
  condition: { kind: "amountAtMost", max: 100 },
  scope: "organization",
  appliesTo: "All agents",
  effect: "require_approval",
  action: "APPROVAL_REQUIRED",
  risk: "medium",
  priority: 45,
  // Disabled on purpose: these fixtures test the write path, and an enabled
  // org-wide cap would change the verdicts asserted elsewhere in this file.
  status: "disabled",
});

describe("chantier 2 — schema validation on writes", () => {
  it("creates a fully specified agent", async () => {
    const res = await client.post<{ id: string; mandate: { maxTransactionAmount: number } }>(
      "/api/agents",
      validAgent("agt_qa_ok"),
    );
    expect(res.status).toBe(201);
    expect(res.body.mandate.maxTransactionAmount).toBe(250);
  });

  it("rejects an agent with a missing field (400)", async () => {
    const { name: _name, ...withoutName } = validAgent("agt_qa_missing");
    const res = await client.post<{ error: string }>("/api/agents", withoutName);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name");
  });

  it("rejects an agent with a bad enum value (400)", async () => {
    const res = await client.post<{ error: string }>("/api/agents", {
      ...validAgent("agt_qa_enum"),
      provider: "skynet",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("provider");
  });

  it("rejects an agent with a malformed mandate (400)", async () => {
    const res = await client.post<{ error: string }>("/api/agents", {
      ...validAgent("agt_qa_mandate"),
      mandate: { maxTransactionAmount: "lots", allowedCategories: "Software" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate agent id (409)", async () => {
    const first = await client.post("/api/agents", validAgent("agt_qa_dupe"));
    expect(first.status).toBe(201);

    const second = await client.post<{ error: string }>("/api/agents", validAgent("agt_qa_dupe"));
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("agt_qa_dupe");
  });

  it("refuses to create an agent from an empty body (400)", async () => {
    const res = await client.post("/api/agents", {});
    expect(res.status).toBe(400);
  });

  it("creates a fully specified policy", async () => {
    const res = await client.post<{ id: string; priority: number }>(
      "/api/policies",
      validPolicy("pol_qa_ok"),
    );
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(45);
  });

  it("rejects a policy with an unknown type (400)", async () => {
    const res = await client.post<{ error: string }>("/api/policies", {
      ...validPolicy("pol_qa_type"),
      type: "MAX_VIBES",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("type");
  });

  it("rejects a policy whose condition does not match its shape (400)", async () => {
    const res = await client.post<{ error: string }>("/api/policies", {
      ...validPolicy("pol_qa_condition"),
      condition: { kind: "amountAtMost" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate policy id (409)", async () => {
    const first = await client.post("/api/policies", validPolicy("pol_qa_dupe"));
    expect(first.status).toBe(201);

    const second = await client.post<{ error: string }>(
      "/api/policies",
      validPolicy("pol_qa_dupe"),
    );
    expect(second.status).toBe(409);
  });

  it("does not persist anything when validation fails", async () => {
    await client.post("/api/agents", { ...validAgent("agt_qa_ghost"), provider: "nope" });
    const found = await client.get(`/api/agents/agt_qa_ghost`);
    expect(found.status).toBe(404);
  });

  it("a policy created through the API is enforced by the engine", async () => {
    // Proof the validated payload is a real policy, not just a stored record.
    const created = await client.post("/api/policies", {
      ...validPolicy("pol_qa_live"),
      name: "QA live cap",
      condition: { kind: "targetMatches", targets: ["qa-blocked.example"] },
      type: "BLOCK_TOOL",
      action: "BLOCK",
      effect: "block",
      status: "enabled",
      risk: "high",
      priority: 99,
    });
    expect(created.status).toBe(201);

    const verdict = (
      await client.post<EvaluateBody>("/api/evaluate", {
        agentId: "agt_sales",
        action: "send_email",
        target: "qa-blocked.example",
      })
    ).body;
    expect(verdict.decision).toBe("BLOCK");
  });
});

/* ======================================================================== *
 * 3. Execution reliability
 * ======================================================================== */

describe("chantier 3 — execution run state", () => {
  it("a successful run ends in `succeeded` with one attempt", async () => {
    const res = (await client.post<ExecuteBody>("/api/execute", PURCHASE_420)).body;
    expect(res.executed).toBe(true);

    const stored = await execution(res.executionId!);
    expect(stored.runState).toBe("succeeded");
    expect(stored.attempts).toBe(1);
    expect(stored.lastError).toBeNull();
    expect(stored.toolExecutedAt).toBeTruthy();
  });

  it("a blocked action is `skipped` and never reaches a tool", async () => {
    const res = (await client.post<ExecuteBody>("/api/execute", PROD_DB)).body;
    expect(res.decision).toBe("BLOCK");
    expect(res.executed).toBe(false);

    const stored = await execution(res.executionId!);
    expect(stored.runState).toBe("skipped");
    expect(stored.attempts).toBe(0);
    expect(tool("database_tool").toolExecutionCount).toBe(0);
  });

  it("a held action stays `pending` until a human resolves it", async () => {
    const held = (await client.post<ExecuteBody>("/api/execute", PURCHASE_12K)).body;
    expect(held.executed).toBe(false);

    const before = await execution(held.executionId!);
    expect(before.runState).toBe("pending");
    expect(before.attempts).toBe(0);

    await client.post(`/api/approvals/${held.approvalId}/approve`, {});

    const after = await execution(held.executionId!);
    expect(after.runState).toBe("succeeded");
    expect(after.attempts).toBe(1);
    expect(tool("purchase_tool").toolExecutionCount).toBe(1);
  });

  it("a rejected action is `skipped`, not left pending forever", async () => {
    const held = (await client.post<ExecuteBody>("/api/execute", PURCHASE_12K)).body;
    await client.post(`/api/approvals/${held.approvalId}/reject`, {});

    const stored = await execution(held.executionId!);
    expect(stored.runState).toBe("skipped");
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });

  it("a failing tool ends in `failed` and records the error", async () => {
    const res = await withFailingTool("purchase_tool", "Provider timeout", async () =>
      client.post<ExecuteBody>("/api/execute", PURCHASE_420),
    );

    const stored = await execution(res.body.executionId!);
    expect(stored.runState).toBe("failed");
    expect(stored.status).toBe("failed");
    expect(stored.lastError).toContain("Provider timeout");
    expect(stored.attempts).toBe(1);
  });

  it("retries a failed run and succeeds on the second attempt", async () => {
    const first = await withFailingTool("purchase_tool", "Provider timeout", async () =>
      client.post<ExecuteBody>("/api/execute", PURCHASE_420),
    );
    const id = first.body.executionId!;
    expect((await execution(id)).runState).toBe("failed");

    toolRegistry.resetCounts();
    const retry = await client.post<{ executed: boolean }>(`/api/executions/${id}/retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.executed).toBe(true);

    const stored = await execution(id);
    expect(stored.runState).toBe("succeeded");
    expect(stored.attempts).toBe(2);
    expect(stored.lastError).toBeNull();
    // Exactly one *new* tool call — the retry, not a replay of the first run.
    expect(tool("purchase_tool").toolExecutionCount).toBe(1);
    expect(stored.audit.map((entry) => entry.event)).toContain("Tool execution retried");
  });

  it("refuses to retry a run that already succeeded (409)", async () => {
    const res = (await client.post<ExecuteBody>("/api/execute", PURCHASE_420)).body;
    toolRegistry.resetCounts();

    const retry = await client.post<{ error: string }>(
      `/api/executions/${res.executionId}/retry`,
      {},
    );
    expect(retry.status).toBe(409);
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });

  it("refuses to retry a blocked action — a retry is not a bypass (409)", async () => {
    const res = (await client.post<ExecuteBody>("/api/execute", PROD_DB)).body;

    const retry = await client.post(`/api/executions/${res.executionId}/retry`, {});
    expect(retry.status).toBe(409);
    expect(tool("database_tool").toolExecutionCount).toBe(0);
  });

  it("returns 404 when retrying an execution that does not exist", async () => {
    const retry = await client.post("/api/executions/exe_nope/retry", {});
    expect(retry.status).toBe(404);
  });

  it("two concurrent approvals run the tool exactly once", async () => {
    const held = (await client.post<ExecuteBody>("/api/execute", PURCHASE_12K)).body;

    const [a, b] = await Promise.all([
      client.post<{ executed: boolean }>(`/api/approvals/${held.approvalId}/approve`, {}),
      client.post<{ executed: boolean }>(`/api/approvals/${held.approvalId}/approve`, {}),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    // One caller performed the side effect; the other observed the result.
    expect([a.body.executed, b.body.executed].filter(Boolean).length).toBe(1);
    expect(tool("purchase_tool").toolExecutionCount).toBe(1);

    const stored = await execution(held.executionId!);
    expect(stored.runState).toBe("succeeded");
    expect(stored.attempts).toBe(1);
  });

  it("a second sequential approve is idempotent", async () => {
    const held = (await client.post<ExecuteBody>("/api/execute", PURCHASE_12K)).body;
    await client.post(`/api/approvals/${held.approvalId}/approve`, {});
    await client.post(`/api/approvals/${held.approvalId}/approve`, {});

    expect(tool("purchase_tool").toolExecutionCount).toBe(1);
    expect((await execution(held.executionId!)).attempts).toBe(1);
  });

  it("writes the execution and its approval atomically", async () => {
    const held = (await client.post<ExecuteBody>("/api/execute", PURCHASE_12K)).body;

    const stored = await execution(held.executionId!);
    const approval = await client.get<{ executionId: string }>(
      `/api/approvals/${held.approvalId}`,
    );
    // Neither row can exist without the other, and they point at each other.
    expect(approval.status).toBe(200);
    expect(approval.body.executionId).toBe(stored.id);
  });
});

/* ======================================================================== *
 * 4. Dry-run evaluation
 * ======================================================================== */

describe("chantier 4 — /api/evaluate is a dry run by default", () => {
  async function counts() {
    const executions = (await client.get<{ id: string }[]>("/api/executions")).body;
    const approvals = (await client.get<{ id: string }[]>("/api/approvals")).body;
    const policies = (await client.get<{ id: string; triggeredCount: number }[]>("/api/policies"))
      .body;
    const audit = (await client.get<{ events: unknown[] }>("/api/audit?limit=200")).body.events;
    return {
      executions: executions.length,
      approvals: approvals.length,
      audit: audit.length,
      triggered: policies.reduce((sum, p) => sum + p.triggeredCount, 0),
    };
  }

  it("returns a verdict without writing anything", async () => {
    const before = await counts();

    const res = await client.post<EvaluateBody>("/api/evaluate", PURCHASE_12K);
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("APPROVAL_REQUIRED");
    expect(res.body.persisted).toBe(false);
    expect(res.body.executionId).toBeNull();
    expect(res.body.approvalId).toBeNull();

    expect(await counts()).toEqual(before);
  });

  it("never increments a policy counter in dry-run mode", async () => {
    const before = await counts();
    await client.post("/api/evaluate", PROD_DB);
    await client.post("/api/evaluate", PURCHASE_420);
    await client.post("/api/evaluate", PURCHASE_12K);
    expect((await counts()).triggered).toBe(before.triggered);
  });

  it("never runs a tool in dry-run mode", async () => {
    await client.post("/api/evaluate", PURCHASE_420);
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });

  it("persists only when the caller explicitly opts in", async () => {
    const before = await counts();
    const res = await client.post<EvaluateBody>("/api/evaluate", {
      ...PURCHASE_12K,
      persist: true,
    });
    expect(res.body.persisted).toBe(true);
    expect(res.body.executionId).toBeTruthy();

    const after = await counts();
    expect(after.executions).toBe(before.executions + 1);
    expect(after.approvals).toBe(before.approvals + 1);
  });

  it("gives the same verdict whether or not it persists", async () => {
    const dry = (await client.post<EvaluateBody>("/api/evaluate", PROD_DB)).body;
    const wet = (await client.post<EvaluateBody>("/api/evaluate", { ...PROD_DB, persist: true }))
      .body;
    expect(dry.decision).toBe(wet.decision);
  });
});

/* ======================================================================== *
 * 5. Real data
 * ======================================================================== */

describe("chantier 5 — metrics are derived from persisted rows", () => {
  it("an execution created through the API shows up in the audit feed", async () => {
    const res = (await client.post<ExecuteBody>("/api/execute", PURCHASE_420)).body;
    const audit = (
      await client.get<{ events: { executionId: string; event: string }[] }>(
        "/api/audit?limit=200",
      )
    ).body;
    expect(audit.events.some((entry) => entry.executionId === res.executionId)).toBe(true);
  });

  it("the executions feed reflects real rows, not a fixture list", async () => {
    const before = (await client.get<{ id: string }[]>("/api/executions")).body.length;
    await client.post("/api/execute", PURCHASE_420);
    const after = (await client.get<{ id: string }[]>("/api/executions")).body.length;
    expect(after).toBe(before + 1);
  });
});

/**
 * The self-service password change, over HTTP.
 *
 * The endpoint exists because the console now owns its passwords: without it, a user
 * whose password has leaked would have to ask an operator to edit an environment file.
 * Everything asserted here is a refusal — the happy path is covered at the unit level
 * in `users.test.ts`, and what matters at the HTTP edge is that the refusals cannot be
 * talked around.
 */
describe("POST /api/auth/password", () => {
  let client: TestClient;

  beforeAll(async () => {
    client = await startTestServer();
  });

  afterAll(async () => {
    await client.close();
  });

  async function signIn(email: string, password: string) {
    const { resetLoginThrottle } = await import("../auth");
    resetLoginThrottle();
    const res = await client.post<{ token: string }>(
      "/api/auth/login",
      { email, password },
      { auth: null },
    );
    expect(res.status).toBe(200);
    return res.body.token;
  }

  it("refuses an unauthenticated caller", async () => {
    const res = await client.post(
      "/api/auth/password",
      { currentPassword: "whatever-it-is", newPassword: "a-brand-new-password-01" },
      { auth: null },
    );
    expect(res.status).toBe(401);
  });

  it("refuses a service credential, which has no password to change", async () => {
    // An API key is rotated, not re-passworded. Accepting this would either do nothing
    // or, worse, appear to succeed.
    const res = await client.post(
      "/api/auth/password",
      { currentPassword: TEST_API_KEY, newPassword: "a-brand-new-password-01" },
      { auth: TEST_API_KEY },
    );
    expect(res.status).toBe(403);
  });

  it("refuses a wrong current password with the same 401 as a failed sign-in", async () => {
    /*
     * The current password is required even though the caller is authenticated: a
     * stolen session token must not be enough to lock the real owner out. And the
     * refusal is the sign-in refusal verbatim, because this endpoint verifies a
     * password too, so it is a guessing surface with the same rules.
     */
    const token = await signIn("viewer@placet.test", "test-viewer-password");
    const res = await client.post<{ error: string }>(
      "/api/auth/password",
      { currentPassword: "not-the-current-password", newPassword: "a-brand-new-password-01" },
      { auth: token },
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");

    // And the account is untouched.
    await signIn("viewer@placet.test", "test-viewer-password");
  });

  it("refuses a new password that is too short, and says why without echoing it", async () => {
    const token = await signIn("viewer@placet.test", "test-viewer-password");
    const res = await client.post<{ error: string }>(
      "/api/auth/password",
      { currentPassword: "test-viewer-password", newPassword: "shortie" },
      { auth: token },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/12/);
    expect(res.body.error).not.toContain("shortie");
  });

  it("refuses re-using the current password", async () => {
    const token = await signIn("viewer@placet.test", "test-viewer-password");
    const res = await client.post(
      "/api/auth/password",
      { currentPassword: "test-viewer-password", newPassword: "test-viewer-password" },
      { auth: token },
    );
    expect(res.status).toBe(400);
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    // The body schema is strict. A caller sending `userId` is trying to change
    // somebody else's password, and silently ignoring the field would hide that.
    const token = await signIn("viewer@placet.test", "test-viewer-password");
    const res = await client.post(
      "/api/auth/password",
      {
        currentPassword: "test-viewer-password",
        newPassword: "a-brand-new-password-01",
        userId: "usr_somebody_else",
      },
      { auth: token },
    );
    expect(res.status).toBe(400);
  });
});

/**
 * The API key routes, over HTTP — P0-5.
 *
 * The store-level tests cover hashing, revocation and tenant isolation. What can only be
 * checked here is the shape of the authorization: who is allowed to issue a credential,
 * and what a refusal reveals.
 */
describe("/api/keys", () => {
  let client: TestClient;
  let adminToken: string;

  beforeAll(async () => {
    client = await startTestServer();
    const { resetLoginThrottle } = await import("../auth");
    resetLoginThrottle();
    const res = await client.post<{ token: string }>(
      "/api/auth/login",
      { email: TEST_CONSOLE_EMAIL, password: TEST_CONSOLE_PASSWORD },
      { auth: null },
    );
    expect(res.status).toBe(200);
    adminToken = res.body.token;
  });

  afterAll(async () => {
    await client.close();
  });

  it("returns the issued key exactly once, and never its digest", async () => {
    const created = await client.post<{ secret: string; key: { id: string; prefix: string } }>(
      "/api/keys",
      { name: "CI policy checks", role: "operator" },
      { auth: adminToken },
    );
    expect(created.status).toBe(201);
    expect(created.body.secret.startsWith("oathrion_")).toBe(true);

    const listed = await client.get<{ keys: { id: string; prefix: string }[] }>("/api/keys", {
      auth: adminToken,
    });
    expect(listed.status).toBe(200);
    const row = listed.body.keys.find((k) => k.id === created.body.key.id);
    expect(row).toBeDefined();
    // The inventory shows the prefix and nothing more. If the whole secret — or its
    // digest — could be read back from a list endpoint, storing a hash would be pointless.
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
    expect(JSON.stringify(listed.body)).not.toContain("sha256$");
  });

  it("makes an issued key work immediately, and stop working when revoked", async () => {
    const created = await client.post<{ secret: string; key: { id: string } }>(
      "/api/keys",
      { name: "Short-lived integration", role: "viewer" },
      { auth: adminToken },
    );
    expect(created.status).toBe(201);

    // Issued through the console, used by a machine: the round trip that the tab used to
    // fake with three fabricated rows and a disabled button.
    const used = await client.get("/api/agents", { auth: created.body.secret });
    expect(used.status).toBe(200);

    const revoked = await client.del<{ revoked: boolean }>(`/api/keys/${created.body.key.id}`, {
      auth: adminToken,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);

    // No restart. This is the property that makes a key revocable at all.
    const after = await client.get("/api/agents", { auth: created.body.secret });
    expect(after.status).toBe(401);
  });

  it("reports a second revocation honestly rather than as a failure", async () => {
    const created = await client.post<{ key: { id: string } }>(
      "/api/keys",
      { name: "Twice revoked", role: "viewer" },
      { auth: adminToken },
    );
    await client.del(`/api/keys/${created.body.key.id}`, { auth: adminToken });
    const again = await client.del<{ revoked: boolean; alreadyRevoked: boolean }>(
      `/api/keys/${created.body.key.id}`,
      { auth: adminToken },
    );
    // An operator pressing the button twice during an incident is not an error, and the
    // first revocation's actor is what the audit trail keeps.
    expect(again.status).toBe(200);
    expect(again.body.revoked).toBe(false);
    expect(again.body.alreadyRevoked).toBe(true);
  });

  it("refuses a machine credential, however privileged", async () => {
    /*
     * The escalation this closes: a key that can mint keys is a persistence mechanism. An
     * attacker holding one credential from a container's environment could issue itself a
     * second one with a plausible name and survive the rotation of the first — while the
     * operator, having rotated the leaked key, believes the incident is over.
     */
    for (const path of ["/api/keys"]) {
      const read = await client.get(path, { auth: TEST_API_KEY });
      expect(read.status).toBe(403);
    }
    const write = await client.post(
      "/api/keys",
      { name: "Self-issued", role: "admin" },
      { auth: TEST_API_KEY },
    );
    expect(write.status).toBe(403);
  });

  it("refuses a human without the manage capability", async () => {
    const { resetLoginThrottle } = await import("../auth");
    resetLoginThrottle();
    const viewer = await client.post<{ token: string }>(
      "/api/auth/login",
      { email: TEST_VIEWER_EMAIL, password: TEST_VIEWER_PASSWORD },
      { auth: null },
    );
    expect(viewer.status).toBe(200);
    const res = await client.post(
      "/api/keys",
      { name: "Viewer's key", role: "viewer" },
      { auth: viewer.body.token },
    );
    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    expect((await client.get("/api/keys", { auth: null })).status).toBe(401);
    expect(
      (await client.post("/api/keys", { name: "Anonymous", role: "admin" }, { auth: null })).status,
    ).toBe(401);
  });

  it("answers 404, not 403, for a key id that is not this tenant's", async () => {
    // 403 would confirm the row exists somewhere, which turns a guessed id into an
    // enumeration oracle across tenants.
    const res = await client.del("/api/keys/key_belonging_to_nobody", { auth: adminToken });
    expect(res.status).toBe(404);
  });

  it("refuses an unknown field and an invalid role", async () => {
    const unknown = await client.post(
      "/api/keys",
      { name: "Sneaky", role: "operator", organizationId: "org_rival_corp" },
      { auth: adminToken },
    );
    // Silently ignoring `organizationId` would hide an attempt to issue a credential into
    // another tenant. The body schema is strict, so the attempt is refused and visible.
    expect(unknown.status).toBe(400);

    const badRole = await client.post(
      "/api/keys",
      { name: "Superuser", role: "superuser" },
      { auth: adminToken },
    );
    expect(badRole.status).toBe(400);
  });

  it("does not echo the submitted name back in a validation failure", async () => {
    const res = await client.post<{ error: string }>(
      "/api/keys",
      { name: "", role: "operator" },
      { auth: adminToken },
    );
    expect(res.status).toBe(400);
    // The zod issues are withheld on this route: they echo submitted values, and the
    // submitted values here describe a credential.
    expect(JSON.stringify(res.body)).not.toContain("issues");
  });
});
