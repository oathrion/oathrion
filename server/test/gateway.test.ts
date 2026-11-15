/**
 * Gateway end-to-end tests — Sprint 2.
 *
 * These prove a negative as much as a positive: that a BLOCKED or held action
 * never reaches its tool. Every assertion reads the real tool counters from the
 * process registry and the real Execution rows back out of SQLite. Nothing is
 * mocked; the frontend is not involved at any point.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestClient } from "./harness";
import { toolRegistry } from "../gateway/tool-registry";
import type { Tool } from "../gateway/tools/types";

interface ExecuteBody {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  executed: boolean;
  reason: string;
  policyId: string | null;
  policyName: string | null;
  riskLevel: string;
  executionId: string | null;
  approvalId: string | null;
  toolId: string | null;
  toolResult: Record<string, unknown> | null;
}

interface ExecutionBody {
  id: string;
  status: string;
  decision: string;
  result: string;
  toolId: string | null;
  toolExecutedAt: string | null;
  toolResult: Record<string, unknown> | null;
  audit: { at: string; actor: string; event: string; detail: string }[];
}

interface ResolveBody {
  approval: { id: string; status: string };
  execution: ExecutionBody | null;
  executed: boolean;
  toolId: string | null;
}

/** Inside the Procurement Agent's $500 autonomous mandate → must reach the tool. */
const PURCHASE_5K = {
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

function tool(id: string): Tool {
  const found = toolRegistry.get(id);
  if (!found) throw new Error(`Tool "${id}" is not registered.`);
  return found;
}

const events = (execution: ExecutionBody) => execution.audit.map((a) => a.event);

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  // Each test starts from zero so a counter assertion means "during this test".
  toolRegistry.resetCounts();
});

/* ------------------------------ Tool registry ----------------------------- */

describe("tool registry", () => {
  it("registers exactly the tools the MVP wires up", () => {
    // `refund_tool` and `customer_tool` joined the original three so that the
    // reference scenarios have a real side effect to permit and a real side
    // effect to withhold. The list is pinned rather than counted: a tool
    // appearing here without anyone noticing is exactly the change that should
    // break a test, because every entry is a reachable side effect.
    expect(toolRegistry.list().map((t) => t.id).sort()).toEqual([
      "customer_tool",
      "database_tool",
      "purchase_tool",
      "refund_tool",
      "send_email_tool",
    ]);
  });

  it("routes each action to its tool", () => {
    expect(toolRegistry.resolve("purchase")?.id).toBe("purchase_tool");
    expect(toolRegistry.resolve("send_email")?.id).toBe("send_email_tool");
    expect(toolRegistry.resolve("access")?.id).toBe("database_tool");
    expect(toolRegistry.resolve("refund")?.id).toBe("refund_tool");
    expect(toolRegistry.resolve("delete_customer")?.id).toBe("customer_tool");
    expect(toolRegistry.resolve("teleport")).toBeUndefined();
  });

  it("starts every counter at zero after a reset", () => {
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
    expect(tool("send_email_tool").toolExecutionCount).toBe(0);
    expect(tool("database_tool").toolExecutionCount).toBe(0);
    expect(tool("refund_tool").toolExecutionCount).toBe(0);
    expect(tool("customer_tool").toolExecutionCount).toBe(0);
  });
});

/* --------------------------------- TEST A --------------------------------- */

describe("TEST A — ALLOW reaches the tool", () => {
  it("purchase $420 → ALLOW, executed, purchase_tool count = 1", async () => {
    const { status, body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_5K);

    expect(status).toBe(200);
    expect(body.decision).toBe("ALLOW");
    expect(body.executed).toBe(true);
    expect(body.toolId).toBe("purchase_tool");
    expect(tool("purchase_tool").toolExecutionCount).toBe(1);
  });

  it("returns the tool payload to the caller", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_5K);
    expect(body.toolResult).toMatchObject({ amount: 420, vendor: "supplier-x.com" });
    expect(tool("purchase_tool").toolExecutionCount).toBe(1);
  });

  it("persists the tool run on the Execution", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_5K);
    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);

    expect(stored.body.status).toBe("allowed");
    expect(stored.body.toolId).toBe("purchase_tool");
    expect(stored.body.toolExecutedAt).toBeTruthy();
    expect(stored.body.result).toContain("Purchase order placed");
  });

  it("does not touch the other tools", async () => {
    await client.post<ExecuteBody>("/api/execute", PURCHASE_5K);
    expect(tool("send_email_tool").toolExecutionCount).toBe(0);
    expect(tool("database_tool").toolExecutionCount).toBe(0);
  });
});

/* --------------------------------- TEST B --------------------------------- */

describe("TEST B — APPROVAL_REQUIRED never reaches the tool", () => {
  it("purchase $12,000 → APPROVAL_REQUIRED, not executed, purchase_tool count = 0", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);

    expect(body.decision).toBe("APPROVAL_REQUIRED");
    expect(body.executed).toBe(false);
    expect(body.toolId).toBeNull();
    expect(body.toolResult).toBeNull();
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });

  it("creates a pending approval bound to the execution", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    expect(body.approvalId).toBeTruthy();

    const approval = await client.get<{ id: string; status: string; executionId: string }>(
      `/api/approvals/${body.approvalId}`,
    );
    expect(approval.body.status).toBe("pending");
    expect(approval.body.executionId).toBe(body.executionId);
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });

  it("leaves the execution pending with no tool recorded", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);

    expect(stored.body.status).toBe("pending");
    expect(stored.body.toolId).toBeNull();
    expect(stored.body.toolExecutedAt).toBeNull();
  });
});

/* --------------------------------- TEST C --------------------------------- */

describe("TEST C — BLOCK never reaches the tool", () => {
  it("production_database → BLOCK, not executed, database_tool count = 0", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PROD_DB);

    expect(body.decision).toBe("BLOCK");
    expect(body.executed).toBe(false);
    expect(body.toolId).toBeNull();
    expect(tool("database_tool").toolExecutionCount).toBe(0);
  });

  it("creates no approval and records the block", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PROD_DB);
    expect(body.approvalId).toBeNull();

    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);
    expect(stored.body.status).toBe("blocked");
    expect(stored.body.toolExecutedAt).toBeNull();
  });

  it("blocks even though the tool itself would happily run", async () => {
    // Proof the tool has no opinion: called directly it works fine. Only the
    // Gateway stands between the agent and this behaviour.
    const direct = await tool("database_tool").execute({
      organizationId: "org_test",
      executionId: "exe_direct",
      agentId: "agt_data",
      agentName: "Data Analyst",
      action: "access",
      target: "production_database",
      metadata: {},
      currency: "EUR",
    });
    expect(direct.ok).toBe(true);
    expect(tool("database_tool").toolExecutionCount).toBe(1);

    toolRegistry.resetCounts();
    await client.post<ExecuteBody>("/api/execute", PROD_DB);
    expect(tool("database_tool").toolExecutionCount).toBe(0);
  });
});

/* --------------------------------- TEST D --------------------------------- */

describe("TEST D — approve releases the action to the tool once", () => {
  it("purchase $12,000 → approve → purchase_tool count = 1", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);

    const resolved = await client.post<ResolveBody>(
      `/api/approvals/${body.approvalId}/approve`,
      {},
    );

    expect(resolved.status).toBe(200);
    expect(resolved.body.approval.status).toBe("approved");
    expect(resolved.body.executed).toBe(true);
    expect(resolved.body.toolId).toBe("purchase_tool");
    expect(tool("purchase_tool").toolExecutionCount).toBe(1);
  });

  it("flips the execution to allowed and stores the tool payload", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    await client.post(`/api/approvals/${body.approvalId}/approve`, {});

    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);
    expect(stored.body.status).toBe("allowed");
    expect(stored.body.decision).toBe("allow");
    expect(stored.body.toolId).toBe("purchase_tool");
    expect(stored.body.toolResult).toMatchObject({ amount: 12000 });
  });
});

/* --------------------------------- TEST E --------------------------------- */

describe("TEST E — reject never reaches the tool", () => {
  it("purchase $12,000 → reject → purchase_tool count = 0", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);

    const resolved = await client.post<ResolveBody>(
      `/api/approvals/${body.approvalId}/reject`,
      {},
    );

    expect(resolved.body.approval.status).toBe("rejected");
    expect(resolved.body.executed).toBe(false);
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });

  it("marks the execution blocked with no tool recorded", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    await client.post(`/api/approvals/${body.approvalId}/reject`, {});

    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);
    expect(stored.body.status).toBe("blocked");
    expect(stored.body.toolId).toBeNull();
    expect(stored.body.toolExecutedAt).toBeNull();
  });

  it("a later approve on a rejected approval still runs nothing", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    await client.post(`/api/approvals/${body.approvalId}/reject`, {});
    toolRegistry.resetCounts();

    const second = await client.post<ResolveBody>(`/api/approvals/${body.approvalId}/approve`, {});
    expect(second.body.approval.status).toBe("rejected");
    expect(second.body.executed).toBe(false);
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });

  it("H1 hardening — a later reject on an already-approved approval never flips it back", async () => {
    // The symmetric case: resolve() must refuse to move a row out of a
    // terminal state in either direction, not just approved→approved.
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    await client.post(`/api/approvals/${body.approvalId}/approve`, {});
    toolRegistry.resetCounts();

    const second = await client.post<ResolveBody>(`/api/approvals/${body.approvalId}/reject`, {});
    expect(second.body.approval.status).toBe("approved");
    expect(second.body.executed).toBe(false);
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });

  it("H1 hardening — resolving a non-existent approval returns 404, not a fabricated state", async () => {
    const res = await client.post<{ error: string }>("/api/approvals/apr_does_not_exist/approve", {});
    expect(res.status).toBe(404);
  });
});

/* --------------------------------- TEST F --------------------------------- */

describe("TEST F — idempotence", () => {
  it("approving the same approval twice runs the tool once", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);

    const first = await client.post<ResolveBody>(`/api/approvals/${body.approvalId}/approve`, {});
    const second = await client.post<ResolveBody>(`/api/approvals/${body.approvalId}/approve`, {});

    expect(first.body.executed).toBe(true);
    expect(second.body.executed).toBe(false);
    expect(second.body.approval.status).toBe("approved");
    expect(tool("purchase_tool").toolExecutionCount).toBe(1);
  });

  it("survives five concurrent approvals of the same approval", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.post<ResolveBody>(`/api/approvals/${body.approvalId}/approve`, {}),
      ),
    );

    expect(results.filter((r) => r.body.executed)).toHaveLength(1);
    expect(tool("purchase_tool").toolExecutionCount).toBe(1);
  });

  it("does not append a second approval event to the audit trail", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    await client.post(`/api/approvals/${body.approvalId}/approve`, {});
    await client.post(`/api/approvals/${body.approvalId}/approve`, {});

    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);
    const granted = events(stored.body).filter((e) => e === "Approval granted");
    const started = events(stored.body).filter((e) => e === "Tool execution started");
    expect(granted).toHaveLength(1);
    expect(started).toHaveLength(1);
  });
});

/* --------------------------------- Audit ---------------------------------- */

describe("audit trail", () => {
  it("ALLOW records request → policy → decision → tool start → tool completed", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_5K);
    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);

    expect(events(stored.body)).toEqual([
      "Action requested",
      "Policy evaluated",
      "Decision made",
      "Tool execution started",
      "Tool execution completed",
    ]);
  });

  it("BLOCK records request → policy → blocked, and nothing more", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PROD_DB);
    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);

    expect(events(stored.body)).toEqual(["Action requested", "Policy evaluated", "Action blocked"]);
  });

  it("APPROVAL_REQUIRED records request → policy → approval requested", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);

    expect(events(stored.body)).toEqual([
      "Action requested",
      "Policy evaluated",
      "Approval requested",
    ]);
  });

  it("APPROVED extends the trail with grant and tool events", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    await client.post(`/api/approvals/${body.approvalId}/approve`, {});
    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);

    expect(events(stored.body)).toEqual([
      "Action requested",
      "Policy evaluated",
      "Approval requested",
      "Approval granted",
      "Tool execution started",
      "Tool execution completed",
    ]);
  });

  it("REJECTED stops at the rejection", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_12K);
    await client.post(`/api/approvals/${body.approvalId}/reject`, {});
    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);

    expect(events(stored.body)).toEqual([
      "Action requested",
      "Policy evaluated",
      "Approval requested",
      "Approval rejected",
    ]);
  });

  it("audit timestamps are ordered", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_5K);
    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);
    const times = stored.body.audit.map((a) => Date.parse(a.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

/* ------------------------------ API contract ------------------------------ */

describe("POST /api/execute contract", () => {
  it("rejects a malformed body with 400", async () => {
    const { status } = await client.post("/api/execute", { action: "purchase" });
    expect(status).toBe(400);
  });

  it("returns 404 for an unknown agent", async () => {
    const { status } = await client.post("/api/execute", { ...PURCHASE_5K, agentId: "agt_ghost" });
    expect(status).toBe(404);
  });

  it("does not execute an action with no registered tool", async () => {
    const { body } = await client.post<ExecuteBody>("/api/execute", {
      agentId: "agt_sales",
      action: "call_api",
      target: "openai",
      metadata: { cost: 1 },
    });

    expect(body.decision).toBe("ALLOW");
    expect(body.executed).toBe(false);
    expect(body.toolId).toBeNull();

    const stored = await client.get<ExecutionBody>(`/api/executions/${body.executionId}`);
    expect(events(stored.body)).toContain("Tool execution skipped");
  });

  it("exposes live counters on GET /api/tools", async () => {
    await client.post("/api/execute", PURCHASE_5K);
    const { body } = await client.get<
      { id: string; name: string; toolExecutionCount: number }[]
    >("/api/tools");

    const purchase = body.find((t) => t.id === "purchase_tool");
    expect(purchase?.toolExecutionCount).toBe(1);
    expect(body.find((t) => t.id === "database_tool")?.toolExecutionCount).toBe(0);
  });
});

/* ------------------------- Gateway is the chokepoint ---------------------- */

describe("security principle", () => {
  it("a paused agent is stopped before any tool", async () => {
    await client.patch("/api/agents/agt_procurement", { status: "paused" });
    try {
      const { body } = await client.post<ExecuteBody>("/api/execute", PURCHASE_5K);
      expect(body.decision).toBe("BLOCK");
      expect(body.executed).toBe(false);
      expect(tool("purchase_tool").toolExecutionCount).toBe(0);
    } finally {
      await client.patch("/api/agents/agt_procurement", { status: "active" });
    }
  });

  it("disabling the policy changes the outcome without touching the Gateway", async () => {
    await client.patch("/api/policies/pol_db_prod", { status: "disabled" });
    try {
      const { body } = await client.post<ExecuteBody>("/api/execute", PROD_DB);
      expect(body.decision).toBe("ALLOW");
      expect(body.executed).toBe(true);
      expect(tool("database_tool").toolExecutionCount).toBe(1);
    } finally {
      await client.patch("/api/policies/pol_db_prod", { status: "enabled" });
    }
  });

  it("/api/decision still evaluates without ever running a tool", async () => {
    const { body } = await client.post<{ decision: string }>("/api/decision", PURCHASE_5K);
    expect(body.decision).toBe("ALLOW");
    expect(tool("purchase_tool").toolExecutionCount).toBe(0);
  });
});
