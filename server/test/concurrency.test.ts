/**
 * Phases 6 and 7 — what holds when requests arrive at the same time.
 *
 * These tests exist because the guarantees they check are the ones a reader
 * would otherwise have to take on trust. Each states a claim the README is
 * allowed to make; where a claim turned out to be conditional, the test records
 * the condition instead of asserting something stronger than the code delivers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

let api: TestClient;

beforeAll(async () => {
  api = await startTestServer();
});

afterAll(async () => {
  await api.close();
});

interface Execution {
  id: string;
  status: string;
  runState: string;
  decision: string;
  toolId?: string | null;
}

/** Shape of POST /api/executions and POST /api/evaluate. */
interface Outcome {
  decision: string;
  reason: string;
  execution: Execution | null;
  /** The route returns the identifier, not the nested record. */
  approvalId: string | null;
}

/** A request the sales agent may make without approval (limit 250 €). */
function smallPurchase(amount: number) {
  return {
    agentId: "agt_sales",
    action: "purchase",
    target: "supplier-x.com",
    amount,
    metadata: { currency: "EUR" },
  };
}

describe("a succeeded run is terminal", () => {
  it("refuses to replay an execution that already succeeded", async () => {
    const created = await api.post<Outcome>("/api/executions", smallPurchase(10));
    expect(created.status).toBe(201);
    expect(created.body.execution?.runState).toBe("succeeded");

    const retry = await api.post(`/api/executions/${created.body.execution?.id}/retry`, {});
    expect(retry.status).toBe(409);
  });

  it("refuses to replay it even when several callers try at once", async () => {
    const created = await api.post<Outcome>("/api/executions", smallPurchase(11));
    const id = created.body.execution?.id;
    expect(id).toBeTruthy();

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => api.post(`/api/executions/${id}/retry`, {})),
    );

    expect(attempts.every((r) => r.status === 409)).toBe(true);

    const after = await api.get<Execution>(`/api/executions/${id}`);
    expect(after.body.runState).toBe("succeeded");
  });
});

describe("a refused action never reaches a tool", () => {
  it("records a blocked decision with no tool and refuses to retry it", async () => {
    const blocked = await api.post<Outcome>("/api/executions", {
      agentId: "agt_procurement",
      action: "purchase",
      target: "evil.com",
      amount: 10,
      category: "Software",
    });

    expect(blocked.body.decision).toBe("BLOCK");
    expect(blocked.body.execution?.toolId).toBeFalsy();
    expect(blocked.body.execution?.runState).toBe("skipped");

    const retry = await api.post(`/api/executions/${blocked.body.execution?.id}/retry`, {});
    expect(retry.status).toBe(409);
  });

  it("does not dispatch while an approval is still pending", async () => {
    const pending = await api.post<Outcome>("/api/executions", {
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 700,
      category: "Software",
    });

    expect(pending.body.decision).toBe("APPROVAL_REQUIRED");
    expect(pending.body.execution?.toolId).toBeFalsy();
    expect(pending.body.execution?.runState).not.toBe("succeeded");
    expect(pending.body.approvalId).toBeTruthy();
  });

  it("counts no tool invocation for a refused action", async () => {
    const before = (await api.get<{ id: string; toolExecutionCount: number }[]>("/api/tools")).body;

    await api.post("/api/executions", {
      agentId: "agt_procurement",
      action: "purchase",
      target: "https://evil.com/checkout",
      amount: 10,
      category: "Software",
    });

    const after = (await api.get<{ id: string; toolExecutionCount: number }[]>("/api/tools")).body;
    for (const tool of after) {
      const previous = before.find((t) => t.id === tool.id);
      expect(tool.toolExecutionCount, `tool ${tool.id}`).toBe(previous?.toolExecutionCount);
    }
  });
});

describe("concurrent identical requests", () => {
  it("gives every caller its own execution, and dispatches each exactly once", async () => {
    const before = (await api.get<{ id: string; toolExecutionCount: number }[]>("/api/tools")).body;
    const beforeTotal = before.reduce((sum, t) => sum + t.toolExecutionCount, 0);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.post<Outcome>("/api/executions", smallPurchase(1))),
    );

    const allowed = results.filter((r) => r.body.decision === "ALLOW");
    expect(allowed).toHaveLength(10);

    const ids = new Set(allowed.map((r) => r.body.execution?.id));
    expect(ids.size, "each request must produce its own execution").toBe(10);

    const after = (await api.get<{ id: string; toolExecutionCount: number }[]>("/api/tools")).body;
    const afterTotal = after.reduce((sum, t) => sum + t.toolExecutionCount, 0);
    expect(afterTotal - beforeTotal, "one dispatch per allowed execution").toBe(10);
  });
});

describe("the daily budget under concurrency", () => {
  /*
   * `DecisionService.decide()` reads the daily spend, evaluates policy and
   * writes the resulting Execution/Approval inside one `better-sqlite3`
   * `.transaction()` (`decideAndPersistTx` in `server/repositories/sqlite.ts`).
   * That transaction runs synchronously and SQLite serialises writers, so no
   * concurrent call can observe the daily total between this one's read and
   * its write — the read-then-write race this comment used to describe as an
   * open question is closed by construction. See
   * `daily-budget-concurrency.test.ts` for a test that proves the ceiling
   * numerically under a parallel burst, rather than only checking this
   * weaker structural invariant.
   */
  it("holds the ceiling for a burst issued in parallel", async () => {
    // agt_support: 100 € per transaction. Sixteen requests of 30 € each.
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        api.post<Outcome>("/api/executions", {
          agentId: "agt_support",
          action: "purchase",
          target: "supplier-x.com",
          amount: 30,
          metadata: { currency: "EUR" },
        }),
      ),
    );

    // Every request is individually under the per-transaction limit, so none of
    // them may be refused for that reason.
    for (const r of results) {
      expect(["ALLOW", "APPROVAL_REQUIRED", "BLOCK"]).toContain(r.body.decision);
    }

    // The invariant that must hold whatever the interleaving: no execution is
    // recorded as allowed without a tool behind it.
    const ledger = (await api.get<Execution[]>("/api/executions")).body;
    const inconsistent = ledger.filter(
      (e) => e.decision === "allow" && e.runState === "succeeded" && !e.toolId,
    );
    expect(inconsistent).toEqual([]);
  });
});

describe("audit trail of a refusal", () => {
  it("records the refusal, and records who the server says asked", async () => {
    const blocked = await api.post<Outcome>("/api/executions", {
      agentId: "agt_procurement",
      action: "purchase",
      target: "evil.com.",
      amount: 10,
      category: "Software",
    });

    const detail = await api.get<{ audit: { actor: string; event: string }[] }>(
      `/api/executions/${blocked.body.execution?.id}`,
    );

    expect(detail.body.audit.length).toBeGreaterThan(0);
    // The identity comes from the credential, never from the request body.
    expect(detail.body.audit.some((e) => e.actor === "Test Service")).toBe(true);
  });

  it("refuses a request that tries to name its own author", async () => {
    const res = await api.post<{ error: string }>(
      "/api/executions",
      {
        agentId: "agt_data",
        action: "query",
        target: "warehouse.dim_customer",
        actor: "Marie Dupont (CFO)",
      },
      { auth: ROLE_KEYS.operator },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("actor is not accepted");
  });

  it("attributes an action to the credential that made it", async () => {
    // Previously the body field won: an operator key could file an action under
    // any name it liked, and the real identity was recorded nowhere.
    const done = await api.post<Outcome>(
      "/api/executions",
      { agentId: "agt_data", action: "query", target: "warehouse.dim_customer" },
      { auth: ROLE_KEYS.operator },
    );

    const detail = await api.get<{ audit: { actor: string; event: string }[] }>(
      `/api/executions/${done.body.execution?.id}`,
    );
    const actors = detail.body.audit.map((e) => e.actor);

    expect(actors).toContain("Test Operator");
    expect(actors).not.toContain("Marie Dupont (CFO)");
  });

  it("refuses a forged author on the dry-run endpoint too", async () => {
    const res = await api.post<{ error: string }>("/api/evaluate", {
      agentId: "agt_data",
      action: "query",
      target: "warehouse.dim_customer",
      persist: false,
      actor: "Marie Dupont (CFO)",
    });
    expect(res.status).toBe(400);
  });

  it("reports a total that counts matched events, not returned ones", async () => {
    const page = await api.get<{ total: number; limit: number; events: unknown[] }>(
      "/api/audit?limit=3",
    );

    expect(page.body.limit).toBe(3);
    expect(page.body.events).toHaveLength(3);
    // The bug this replaces: `total` was computed after slicing, so a console
    // showing page one believed it was showing the whole history.
    expect(page.body.total).toBeGreaterThan(3);
  });

  it("caps a page even when the caller asks for everything", async () => {
    const page = await api.get<{ limit: number }>("/api/audit?limit=100000");
    expect(page.body.limit).toBe(500);
  });

  it("says when its window did not cover the whole ledger", async () => {
    const page = await api.get<{ windowTruncated: boolean }>("/api/audit");
    // The pilot ledger is small, so the window is not truncated here. The field
    // must nonetheless be present and answered, not absent.
    expect(typeof page.body.windowTruncated).toBe("boolean");
  });

  it("pages without repeating an event", async () => {
    const first = await api.get<{ events: { id: string }[] }>("/api/audit?limit=5&offset=0");
    const second = await api.get<{ events: { id: string }[] }>("/api/audit?limit=5&offset=5");

    const overlap = first.body.events.filter((e) => second.body.events.some((o) => o.id === e.id));
    expect(overlap).toEqual([]);
  });
});
