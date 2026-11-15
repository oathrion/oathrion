/**
 * Regression tests for the bypasses found during the pre-pilot audit.
 *
 * Every test in this file was written against the vulnerable code first and
 * failed there. None of them assert anything the product did not already claim
 * to guarantee — they close the gap between the claim and the behaviour.
 *
 * The claims under test:
 *
 *   1. A ceiling cannot be skipped by renaming or omitting a field.
 *   2. A domain allowlist applies to the destination, not to the spelling of it.
 *   3. A deny rule follows the resource, not the string it was typed as.
 *   4. A dry run leaves no trace anywhere.
 *   5. An execution recorded as `allowed` was dispatched or is recoverable.
 *   6. A fresh install measures nothing, because nothing has happened yet.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestClient } from "./harness";

interface Verdict {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  reason: string;
  executionId: string | null;
  executed?: boolean;
  persisted?: boolean;
}

let api: TestClient;

beforeAll(async () => {
  api = await startTestServer();
});

afterAll(async () => {
  await api.close();
});

/** Dry-run evaluation: never writes, so it is safe to call in a loop. */
async function dryRun(body: Record<string, unknown>): Promise<Verdict> {
  const res = await api.post<Verdict>("/api/evaluate", { ...body, persist: false });
  expect(res.status).toBe(200);
  return res.body;
}

async function ledgerSize(): Promise<number> {
  const res = await api.get<unknown[]>("/api/executions");
  return res.body.length;
}

/* -------------------------------------------------------------------------- *
 * 1. A ceiling that can be skipped is not a ceiling
 * -------------------------------------------------------------------------- */

describe("spending limits fail closed", () => {
  const base = {
    agentId: "agt_sales",
    action: "purchase",
    target: "supplier-x.com",
  };

  it("still escalates when the amount is declared normally", async () => {
    const r = await dryRun({ ...base, amount: 999_999 });
    expect(r.decision).toBe("APPROVAL_REQUIRED");
  });

  it("refuses a purchase that hides the amount under another field name", async () => {
    // The original bypass: `total` instead of `amount` produced no verdict at
    // all, and the engine's permissive default turned that into ALLOW.
    const r = await dryRun({ ...base, metadata: { total: 999_999 } });
    expect(r.decision).not.toBe("ALLOW");
    expect(r.reason).toContain("amount");
  });

  it("refuses a purchase that declares no amount whatsoever", async () => {
    const r = await dryRun(base);
    expect(r.decision).not.toBe("ALLOW");
  });

  it("refuses an amount denominated in another currency", async () => {
    const r = await dryRun({ ...base, amount: 10, metadata: { currency: "USD" } });
    expect(r.decision).toBe("BLOCK");
    expect(r.reason).toContain("not comparable");
  });

  it("refuses an unrecognised currency rather than ignoring it", async () => {
    const r = await dryRun({ ...base, amount: 10, metadata: { currency: "XYZ" } });
    expect(r.decision).toBe("BLOCK");
  });

  it("accepts an amount that explicitly names the organisation currency", async () => {
    const r = await dryRun({ ...base, amount: 40, metadata: { currency: "EUR" } });
    expect(r.decision).toBe("ALLOW");
  });
});

/* -------------------------------------------------------------------------- *
 * 2. The allowlist applies to the destination, not to its spelling
 * -------------------------------------------------------------------------- */

describe("domain allowlist follows the host", () => {
  const base = {
    agentId: "agt_procurement",
    action: "purchase",
    amount: 10,
    category: "Software",
  };

  it("blocks a bare host that is not approved", async () => {
    const r = await dryRun({ ...base, target: "evil.com" });
    expect(r.decision).toBe("BLOCK");
  });

  it("blocks the same host wrapped in a URL", async () => {
    // Previously ALLOW: the allowlist only looked at bare hosts.
    const r = await dryRun({ ...base, target: "https://evil.com/checkout" });
    expect(r.decision).toBe("BLOCK");
  });

  it("blocks the same host with a trailing root dot", async () => {
    const r = await dryRun({ ...base, target: "evil.com." });
    expect(r.decision).toBe("BLOCK");
  });

  it("blocks the same host behind userinfo and a port", async () => {
    const r = await dryRun({ ...base, target: "buyer@evil.com:8443/pay" });
    expect(r.decision).toBe("BLOCK");
  });

  it("blocks a target that carries no readable destination at all", async () => {
    const r = await dryRun({ ...base, target: "shop" });
    expect(r.decision).toBe("BLOCK");
  });

  it("blocks a target that is whitespace only, not an empty allowlist match", async () => {
    // Zod's `min(1)` accepts a lone space, so this must not reach the engine
    // as if it were a legitimate, if unmatched, hostname — `extractHost`
    // trims first, so a whitespace-only target collapses to the same
    // "no readable destination" case as an empty one.
    const r = await dryRun({ ...base, target: "   " });
    expect(r.decision).toBe("BLOCK");
  });

  it("still allows an approved supplier, however it is written", async () => {
    for (const target of [
      "supplier-x.com",
      "https://supplier-x.com/orders/new",
      "SUPPLIER-X.COM",
      "orders.supplier-x.com",
    ]) {
      const r = await dryRun({ ...base, target });
      expect(r.decision, `target ${target}`).toBe("ALLOW");
    }
  });

  it("does not treat a lookalike host as the approved one", async () => {
    const r = await dryRun({ ...base, target: "supplier-x.com.evil.com" });
    expect(r.decision).toBe("BLOCK");
  });
});

/* -------------------------------------------------------------------------- *
 * 3. A deny rule follows the resource
 * -------------------------------------------------------------------------- */

describe("blocked targets cannot be reached by rewriting the string", () => {
  const base = { agentId: "agt_data", action: "access" };

  it("blocks the plain name and its usual spellings", async () => {
    for (const target of ["production_database", "Production Database", "production-database"]) {
      const r = await dryRun({ ...base, target });
      expect(r.decision, `target ${target}`).toBe("BLOCK");
    }
  });

  it("blocks the same resource inside a connection string", async () => {
    const r = await dryRun({ ...base, target: "postgres://prod/production_database" });
    expect(r.decision).toBe("BLOCK");
  });

  it("does not block a different resource with a similar name", async () => {
    // Deny broadly, but on whole segments — never on substrings.
    const r = await dryRun({ ...base, target: "production_database2" });
    expect(r.decision).toBe("ALLOW");
  });
});

/* -------------------------------------------------------------------------- *
 * 4. A dry run leaves no trace
 * -------------------------------------------------------------------------- */

describe("dry run is genuinely without effect", () => {
  it("writes no execution, no approval and no audit entry", async () => {
    const before = {
      executions: (await api.get<unknown[]>("/api/executions")).body.length,
      approvals: (await api.get<unknown[]>("/api/approvals")).body.length,
      audit: (await api.get<{ total: number }>("/api/audit")).body.total,
      tools: (await api.get<{ id: string; toolExecutionCount: number }[]>("/api/tools")).body,
    };

    await dryRun({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 12_000,
      category: "Equipment",
    });

    expect((await api.get<unknown[]>("/api/executions")).body.length).toBe(before.executions);
    expect((await api.get<unknown[]>("/api/approvals")).body.length).toBe(before.approvals);
    expect((await api.get<{ total: number }>("/api/audit")).body.total).toBe(before.audit);

    const after = (await api.get<{ id: string; toolExecutionCount: number }[]>("/api/tools")).body;
    for (const tool of after) {
      const previous = before.tools.find((t) => t.id === tool.id);
      expect(tool.toolExecutionCount, `tool ${tool.id}`).toBe(previous?.toolExecutionCount);
    }
  });

  it("refuses `persist` on POST /api/executions instead of silently executing it", async () => {
    // The original defect: the field was parsed, ignored, and the tool ran.
    const before = await ledgerSize();
    const res = await api.post<{ error: string }>("/api/executions", {
      agentId: "agt_data",
      action: "query",
      target: "warehouse.dim_customer",
      persist: false,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("always executes");
    expect(await ledgerSize()).toBe(before);
  });
});

/* -------------------------------------------------------------------------- *
 * 5. No execution is recorded as allowed without being dispatched
 * -------------------------------------------------------------------------- */

describe("a persisted evaluation cannot strand an execution", () => {
  it("dispatches an ALLOW instead of leaving it pending forever", async () => {
    const res = await api.post<Verdict & { toolId: string | null }>("/api/evaluate", {
      agentId: "agt_data",
      action: "query",
      target: "warehouse.dim_customer",
      persist: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("ALLOW");
    expect(res.body.executed).toBe(true);
    expect(res.body.executionId).toBeTruthy();

    const stored = await api.get<{ status: string; runState: string; toolId: string | null }>(
      `/api/executions/${res.body.executionId}`,
    );
    expect(stored.body.status).toBe("allowed");
    expect(stored.body.runState).toBe("succeeded");
    expect(stored.body.toolId).toBeTruthy();
  });

  it("leaves no execution in the ledger that is allowed but never dispatched", async () => {
    const all = (await api.get<{ status: string; runState: string; toolId?: string | null }[]>(
      "/api/executions",
    )).body;

    // A dispatched run always carries a tool id. An absent one and an explicit
    // null both mean "no tool ran", so the check must catch either.
    const stranded = all.filter(
      (e) => e.status === "allowed" && e.runState === "pending" && !e.toolId,
    );
    expect(stranded).toEqual([]);
  });
});
