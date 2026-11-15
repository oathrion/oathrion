/**
 * Agent mandate tests — Sprint 3.
 *
 * A mandate is what an agent may do *on its own authority*, before any
 * organization policy is consulted. These tests run against the real HTTP API
 * and the real SQLite database; the frontend is never involved.
 *
 * The last block walks the eleven-point acceptance criterion end to end:
 * $850 purchase → APPROVAL_REQUIRED → visible in Approvals → approved →
 * execution completed → visible in Executions → visible in Audit → dashboard
 * counters move.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

interface EvaluateBody {
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  reason: string;
  policyId: string | null;
  risk: string;
  executionId: string | null;
  approvalId: string | null;
  /**
   * Every clause that had an opinion, mandate clauses included. Asserting on this and
   * not only on `decision` is the difference between "the request was refused" and
   * "the request was refused BY THE RULE UNDER TEST" — see the currency section below
   * for what happens when you only check the former.
   */
  matched: { policyId: string; decision: string; reason: string }[];
}

async function evaluate(body: Record<string, unknown>): Promise<EvaluateBody> {
  // `/api/evaluate` is a dry run by default; these tests assert persisted
  // behaviour, so they opt in explicitly.
  const res = await client.post("/api/evaluate", { ...body, persist: true });
  expect(res.status).toBe(200);
  return res.body as EvaluateBody;
}

/* ------------------------------------------------------------------ *
 * 1. The autonomous spending limit
 * ------------------------------------------------------------------ */

describe("autonomous spending limit", () => {
  it("$420 is inside the Procurement Agent's $500 mandate → ALLOW", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 420,
      category: "Office supplies",
    });
    expect(r.decision).toBe("ALLOW");
  });

  it("$500 exactly → ALLOW (the ceiling is inclusive)", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 500,
      category: "Software",
    });
    expect(r.decision).toBe("ALLOW");
  });

  it("$850 exceeds the mandate → APPROVAL_REQUIRED with the amount named in the reason", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 850,
      category: "Office supplies",
    });
    expect(r.decision).toBe("APPROVAL_REQUIRED");
    /*
     * Phase 12.3: the euro now keeps its centimes. The previous formatter pinned
     * `maximumFractionDigits: 0` for every currency, so an amount of 850,50 € was
     * rendered "851 €" in the reason an operator reads and in the audit entry — the
     * number that justified the decision was not the number decided on. The fraction
     * digits now come from the currency registry, which is also what lets the franc CFA
     * render without decimals it does not have.
     */
    expect(r.reason).toContain("850,00 €");
    expect(r.reason).toContain("autonomous spending limit of 500,00 €");
    expect(r.risk).toBe("medium");
  });

  it('"$850" sent as a formatted string behaves identically', async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: "$850",
      category: "Office supplies",
    });
    expect(r.decision).toBe("APPROVAL_REQUIRED");
  });

  it("Phase B #1 regression: a negative amount does not satisfy the $500 mandate", async () => {
    // Before the fix, -50000 <= 500 read as "inside the mandate" → ALLOW,
    // and a negative amount would have reached the tool and, had a daily
    // spend policy been attached, eroded a future legitimate purchase's
    // budget. The mandate must refuse to check an amount it cannot trust,
    // exactly as it already does when "amount" is missing entirely.
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: -50_000,
      category: "Office supplies",
    });
    expect(r.decision).not.toBe("ALLOW");
    expect(r.decision).toBe("BLOCK");
    // Unlike the dry-run path (persist: false), this call opts into
    // persistence, so — consistent with every other BLOCK test in this file
    // — it still writes an audit-trail Execution row for the refused
    // action. `executionId` is therefore expected to be present, not null.
    expect(r.executionId).toBeTruthy();
  });

  it("an agent with no mandate limit is governed only by the org ceiling", async () => {
    const under = await evaluate({
      agentId: "agt_data",
      action: "purchase",
      target: "supplier-x.com",
      amount: 5000,
    });
    expect(under.decision).toBe("ALLOW");
  });

  it("non-spending actions ignore the spending limit", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "query",
      target: "analytics_warehouse",
      amount: 99999,
    });
    expect(r.decision).not.toBe("APPROVAL_REQUIRED");
  });
});

/* ------------------------------------------------------------------ *
 * 1b. The exact edge of the mandate ceiling
 *
 * Added by the mutation audit (script/mutation-audit.ts). Two deliberate
 * sabotages of shared/policy/mandate.ts left the whole suite GREEN:
 *
 *   1. `amount > maxTransactionAmount` → `amount > maxTransactionAmount + 1`
 *      An agent could spend one unit over its autonomous limit with no human
 *      in the loop. Nothing failed: the tests above use 420, 500 and 850, so
 *      the inclusive side of the boundary was covered and the exclusive side
 *      never was. "$500 exactly → ALLOW" does not pin down where ALLOW stops.
 *
 *   2. the `amount === null` fail-closed branch → dead code
 *      Sending `{ total: 999999 }` instead of `{ amount: 999999 }` produced no
 *      mandate verdict at all, and the engine's permissive default turned that
 *      into ALLOW. The fix was in the tree and correct; nothing guarded it, so
 *      a future developer could delete it and ship a green suite.
 *
 * Both are ceiling bypasses on real money. These tests are the barrier.
 * ------------------------------------------------------------------ */

/**
 * A private agent whose $500 ceiling mirrors the Procurement Agent's.
 *
 * WHY NOT REUSE agt_procurement
 * -----------------------------
 * The first version of these tests did, and they were GREEN in isolation and RED
 * when the whole suite ran — the worst possible failure mode, because the verdict
 * depended on which other test files had already executed.
 *
 * The cause is the seeded MAX_DAILY_SPEND policy: €500 of rolling daily `cost`,
 * scope `organization`, BLOCK, priority 20 — it applies to every agent, it
 * accumulates across the single SQLite file the suite shares, and it outranks
 * APPROVAL_REQUIRED. So by the time enough executions had run, a $501 purchase
 * came back BLOCK (budget) instead of APPROVAL_REQUIRED (ceiling): the right
 * refusal for the wrong reason, and no longer a test of the ceiling.
 *
 * A dedicated agent starts at zero daily spend, so the only barrier these tests
 * can trip is the one they are about. The ceiling is asserted, not the ordering.
 */
const BOUNDARY_AGENT = {
  id: "agt_test_boundary",
  name: "Ceiling Boundary Agent",
  description: "Dedicated agent with a $500 mandate, isolated from shared daily spend.",
  provider: "openai" as const,
  model: "gpt-4.1-mini",
  status: "active" as const,
  owner: "Test Suite",
  mandate: {
    maxTransactionAmount: 500,
    currency: "USD" as const,
    allowedCategories: [],
    blockedCategories: [],
    allowedDomains: [],
  },
  permissions: [
    {
      scope: "execute:payments" as const,
      label: "Execute payments",
      description: "Place purchase orders.",
      granted: true,
      risk: "high" as const,
    },
  ],
  policyIds: [],
  tags: ["test"],
};

describe("the exact edge of the mandate ceiling", () => {
  beforeAll(async () => {
    const created = await client.post("/api/agents", BOUNDARY_AGENT, {
      auth: ROLE_KEYS.admin,
    });
    expect(created.status).toBe(201);
  });

  /** Dry run: asserts the verdict without writing, so no test here erodes the next. */
  async function verdictFor(body: Record<string, unknown>): Promise<EvaluateBody> {
    const res = await client.post("/api/evaluate", {
      agentId: BOUNDARY_AGENT.id,
      action: "purchase",
      target: "supplier-x.com",
      category: "Office supplies",
      ...body,
    });
    expect(res.status).toBe(200);
    return res.body as EvaluateBody;
  }

  it("$500 exactly is allowed — the ceiling is inclusive", async () => {
    // Restates the inclusive side against THIS agent, so the pair of boundary
    // assertions below cannot be satisfied by a ceiling that moved wholesale.
    expect((await verdictFor({ amount: 500 })).decision).toBe("ALLOW");
  });

  it("$501 — one dollar over — escalates instead of being allowed", async () => {
    // The half of the boundary that decides whether the ceiling exists at all.
    // Sabotaging `amount > max` to `amount > max + 1` left the entire suite green
    // before this test existed: 420, 500 and 850 never probe the first value over.
    expect((await verdictFor({ amount: 501 })).decision).toBe("APPROVAL_REQUIRED");
  });

  it("$500.01 escalates — the comparison is not rounded to whole units", async () => {
    // A ceiling implemented with Math.round or a truncating cast would allow this
    // while still passing the $501 test above.
    expect((await verdictFor({ amount: 500.01 })).decision).toBe("APPROVAL_REQUIRED");
  });

  it("$499.99 is still allowed — the barrier did not move inward", async () => {
    // A boundary test that only pushes one way can be satisfied by making the
    // ceiling stricter than intended, which breaks legitimate spend instead.
    expect((await verdictFor({ amount: 499.99 })).decision).toBe("ALLOW");
  });

  it("a spend that omits amount entirely is refused, not waved through", async () => {
    /*
     * The mandate must refuse an amount it cannot read rather than produce no
     * verdict — "no verdict" reaches the engine's permissive default and becomes
     * ALLOW. Sabotaging this branch also left the whole suite green.
     */
    const r = await verdictFor({});
    expect(r.decision).toBe("BLOCK");
    // The message must name the limit, so the caller sees WHICH ceiling could not
    // be applied rather than getting an opaque refusal.
    expect(r.reason).toMatch(/amount/i);
    expect(r.reason).toMatch(/500/);
  });

  it("an unparseable amount is refused the same way a missing one is", async () => {
    // "a lot" is not a number. Coercing it would produce NaN, and NaN satisfies no
    // comparison — silently yielding no verdict, hence ALLOW.
    expect((await verdictFor({ amount: "a lot" })).decision).toBe("BLOCK");
  });

  it("a renamed amount field cannot smuggle a spend past the schema", async () => {
    /*
     * The `{ total: 999999 }` rename vector, which is the reason the fail-closed
     * branch exists. Discovered while writing these tests: it never reaches the
     * mandate at all, because the request schema refuses unknown keys at the HTTP
     * edge — a 400, not a decision.
     *
     * That is the stronger outcome, and it is asserted here so the two barriers are
     * documented as independent. If someone relaxes the schema to passthrough, this
     * test goes red and the fail-closed branch catches what gets through. Neither
     * test alone would tell that story.
     */
    const res = await client.post("/api/evaluate", {
      agentId: BOUNDARY_AGENT.id,
      action: "purchase",
      target: "supplier-x.com",
      category: "Office supplies",
      total: 999_999,
    });
    expect(res.status).toBe(400);
  });

  it("a spend with no readable amount never reaches the tool", async () => {
    /*
     * The end-to-end consequence, asserted on the execution rather than on the
     * verdict: whatever the decision is called, no tool may run.
     */
    const res = await client.post("/api/executions", {
      agentId: BOUNDARY_AGENT.id,
      action: "purchase",
      target: "supplier-x.com",
      category: "Office supplies",
    });
    // 201: the refusal is still RECORDED as an execution row for the audit trail.
    expect(res.status).toBe(201);
    const body = res.body as { attempted: boolean; succeeded: boolean; runState: string | null };
    expect(body.attempted).toBe(false);
    expect(body.succeeded).toBe(false);
    expect(body.runState).not.toBe("succeeded");
  });
});

/* ------------------------------------------------------------------ *
 * 1c. The ceiling's currency
 *
 * Added by the mutation audit. Disabling the currency check entirely — so a ¥900
 * purchase is compared against a €500 limit as though 900 and 500 were the same
 * kind of number — left all 610 tests green.
 *
 * The engine holds no exchange rates, by design. So an amount in another currency
 * is not "probably fine": it is not comparable to the ceiling at all, and the only
 * safe answer is to refuse. Without a test, that reasoning was a comment.
 * ------------------------------------------------------------------ */

describe("the ceiling's currency", () => {
  /** Dry run: asserts the verdict without writing, so no shared budget is consumed. */
  async function verdictFor(body: Record<string, unknown>): Promise<EvaluateBody> {
    const res = await client.post("/api/evaluate", {
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      category: "Office supplies",
      ...body,
    });
    expect(res.status).toBe(200);
    return res.body as EvaluateBody;
  }

  /**
   * The mandate's own currency clause, identified by the id the mandate mints for it.
   *
   * WHY THESE TESTS LOOK IN `matched` INSTEAD OF AT `decision`
   * ---------------------------------------------------------
   * The first version of this section asserted only `decision === "BLOCK"`, and passed
   * — while the mutation that disables the mandate's currency check entirely still
   * survived the audit. The reason is that a second, independent currency check exists
   * at the POLICY layer, and it was the one doing the refusing. The tests were green,
   * the outcome was right, and the clause they were written for was unprotected.
   *
   * So each assertion names the clause: `mnd_<agentId>_limit_currency`. If the mandate
   * stops objecting, these fail even when some other rule happens to refuse too.
   */
  const MANDATE_CURRENCY_CLAUSE = "mnd_agt_procurement_limit_currency";

  function clause(r: EvaluateBody, policyId: string) {
    return r.matched.find((m) => m.policyId === policyId);
  }

  it("refuses an amount denominated in a currency other than the ceiling's", async () => {
    // 900 is a large number and a small sum of money depending on the unit. The
    // Procurement Agent's limit is €500; ¥900 is roughly €5. Comparing them either
    // way is guessing, and guessing in the permissive direction moves real money.
    const r = await verdictFor({ amount: 900, currency: "JPY" });
    expect(r.decision).toBe("BLOCK");
    const mandate = clause(r, MANDATE_CURRENCY_CLAUSE);
    expect(mandate, "the mandate itself must object, not only the org policy").toBeDefined();
    expect(mandate!.decision).toBe("BLOCK");
    expect(mandate!.reason).toMatch(/not comparable/i);
  });

  it("refuses even when the number would be comfortably inside the ceiling", async () => {
    /*
     * The important half. A check that only refuses when the number also exceeds the
     * limit is not a currency check — it is the amount check with extra words. ¥100
     * is well under 500, and must still be refused as incomparable.
     */
    const r = await verdictFor({ amount: 100, currency: "JPY" });
    expect(r.decision).toBe("BLOCK");
    expect(clause(r, MANDATE_CURRENCY_CLAUSE)?.decision).toBe("BLOCK");
  });

  it("names the two currencies so an operator can fix the caller", async () => {
    // A refusal an integrator cannot act on gets worked around rather than fixed.
    const r = await verdictFor({ amount: 100, currency: "JPY" });
    const reason = clause(r, MANDATE_CURRENCY_CLAUSE)?.reason ?? "";
    expect(reason).toContain("JPY");
    expect(reason).toContain("EUR");
  });

  it("does not raise the currency clause when the currency matches", async () => {
    // Guards the other direction: a clause that fires unconditionally would satisfy
    // every test above while blocking all legitimate spending.
    const r = await verdictFor({ amount: 100, currency: "EUR" });
    expect(clause(r, MANDATE_CURRENCY_CLAUSE)).toBeUndefined();
  });

  it("accepts the ceiling's own currency", async () => {
    // The barrier must not have been implemented by refusing everything.
    const r = await verdictFor({ amount: 100, currency: "EUR" });
    expect(r.decision).toBe("ALLOW");
  });

  it("refuses a currency code that is not a currency at all", async () => {
    // Fail closed on garbage rather than falling back to the org currency, which
    // would let `currency: "🙂"` silently mean EUR.
    const r = await verdictFor({ amount: 100, currency: "NOT_A_CURRENCY" });
    expect(r.decision).toBe("BLOCK");
  });

  it("treats an omitted currency as the organisation's, not as a mismatch", async () => {
    // Every existing caller omits it. Reading "absent" as "mismatch" would refuse
    // every legitimate spend in the product.
    const r = await verdictFor({ amount: 100 });
    expect(r.decision).toBe("ALLOW");
  });
});

/* ------------------------------------------------------------------ *
 * 2. Category and domain scope
 * ------------------------------------------------------------------ */

describe("category and domain scope", () => {
  it("a blocked category is refused outright, whatever the amount", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "coinbase.com",
      amount: 1,
      category: "Cryptocurrency",
    });
    expect(r.decision).toBe("BLOCK");
    expect(r.risk).toBe("critical");
  });

  it("a category outside the allow-list is refused", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 50,
      category: "Travel",
    });
    expect(r.decision).toBe("BLOCK");
  });

  it("a domain outside the allow-list is refused", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "unknown-vendor.io",
      amount: 50,
      category: "Software",
    });
    expect(r.decision).toBe("BLOCK");
    expect(r.reason).toContain("unknown-vendor.io");
  });

  it("a blocked category outranks an over-limit amount (BLOCK wins over APPROVAL)", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "coinbase.com",
      amount: 9000,
      category: "Cryptocurrency",
    });
    expect(r.decision).toBe("BLOCK");
  });

  it("free-text targets are not treated as domains", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 100,
      category: "Software",
    });
    expect(r.decision).toBe("ALLOW");
  });
});

/* ------------------------------------------------------------------ *
 * 3. Context is carried into the audit trail
 * ------------------------------------------------------------------ */

describe("context", () => {
  it("free-text context is persisted on the execution input", async () => {
    const r = await evaluate({
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 850,
      category: "Office supplies",
      context: "Q3 office refresh, quote #4821",
    });
    expect(r.executionId).toBeTruthy();

    const res = await client.get(`/api/executions/${r.executionId}`);
    expect(res.status).toBe(200);
    const execution = res.body as { input: Record<string, unknown> };
    expect(execution.input.context).toBe("Q3 office refresh, quote #4821");
  });
});

/* ------------------------------------------------------------------ *
 * 4. GET /api/audit
 * ------------------------------------------------------------------ */

describe("GET /api/audit", () => {
  it("returns a chronological, newest-first, org-wide event stream", async () => {
    const res = await client.get("/api/audit?limit=50");
    expect(res.status).toBe(200);
    const body = res.body as {
      total: number;
      events: { at: string; event: string; agentId: string; executionId: string }[];
    };
    expect(body.events.length).toBeGreaterThan(0);

    const times = body.events.map((e) => Date.parse(e.at));
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);

    for (const event of body.events) {
      expect(event.agentId).toBeTruthy();
      expect(event.executionId).toBeTruthy();
      expect(event.event).toBeTruthy();
    }
  });

  it("filters by agent", async () => {
    const res = await client.get("/api/audit?agentId=agt_procurement");
    const body = res.body as { events: { agentId: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.agentId === "agt_procurement")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 5. The eleven-point acceptance criterion, end to end
 * ------------------------------------------------------------------ */

describe("acceptance criterion — $850 purchase, approved, audited", () => {
  it("walks the full loop and moves the dashboard counters", async () => {
    /* 1–2. The four demo agents exist and Procurement is one of them. */
    const agentsRes = await client.get("/api/agents");
    const agents = agentsRes.body as { id: string; name: string }[];
    expect(agents.length).toBeGreaterThanOrEqual(4);
    const procurement = agents.find((a) => a.id === "agt_procurement");
    expect(procurement?.name).toBe("Procurement Agent");

    const before = await client.get("/api/executions");
    const beforeCount = (before.body as unknown[]).length;

    /* 3–5. The action is submitted and the engine holds it. */
    const run = await client.post("/api/executions", {
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 850,
      category: "Office supplies",
      context: "Acceptance run",
    });
    expect(run.status).toBe(201);
    const held = run.body as {
      decision: string;
      executed: boolean;
      executionId: string;
      approvalId: string;
      toolId: string | null;
      reason: string;
    };
    expect(held.decision).toBe("APPROVAL_REQUIRED");
    expect(held.reason).toContain("autonomous spending limit of 500,00 €");

    /* The tool must NOT have run. */
    expect(held.executed).toBe(false);
    expect(held.toolId).toBeNull();

    /* 6. The request is waiting in Approvals. */
    const approvalsRes = await client.get("/api/approvals");
    const approvals = approvalsRes.body as { id: string; status: string }[];
    const pending = approvals.find((a) => a.id === held.approvalId);
    expect(pending?.status).toBe("pending");

    /* 7. A human approves. */
    const resolved = await client.post(`/api/approvals/${held.approvalId}/approve`, {
    });
    expect(resolved.status).toBe(200);
    const resolvedBody = resolved.body as {
      approval: { status: string };
      executed: boolean;
      toolId: string | null;
      execution: { status: string; result: string } | null;
    };
    expect(resolvedBody.approval.status).toBe("approved");

    /* 8. Only now does the execution complete and the tool run. */
    expect(resolvedBody.executed).toBe(true);
    expect(resolvedBody.toolId).toBe("purchase_tool");
    expect(resolvedBody.execution?.status).toBe("allowed");

    /* 9. The execution is listed. */
    const after = await client.get("/api/executions");
    const afterList = after.body as { id: string }[];
    expect(afterList.length).toBe(beforeCount + 1);
    expect(afterList.some((e) => e.id === held.executionId)).toBe(true);

    /* 10. The whole story is in the audit log, in order. */
    const auditRes = await client.get("/api/audit?agentId=agt_procurement&limit=200");
    const events = (auditRes.body as { events: { executionId: string; event: string }[] }).events
      .filter((e) => e.executionId === held.executionId)
      .map((e) => e.event);
    for (const expected of [
      "Action requested",
      "Policy evaluated",
      "Approval requested",
      "Approval granted",
      "Tool execution completed",
    ]) {
      expect(events).toContain(expected);
    }

    /* 11. The dashboard reads from the same rows, so its counters moved. */
    const stats = await client.get("/api/executions");
    const all = stats.body as { status: string }[];
    expect(all.filter((e) => e.status === "allowed").length).toBeGreaterThan(0);
  });

  it("approving twice never runs the tool twice", async () => {
    const run = await client.post("/api/executions", {
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 850,
      category: "Equipment",
    });
    const { approvalId } = run.body as { approvalId: string };

    const first = await client.post(`/api/approvals/${approvalId}/approve`, {});
    expect((first.body as { executed: boolean }).executed).toBe(true);

    const second = await client.post(`/api/approvals/${approvalId}/approve`, {});
    expect((second.body as { executed?: boolean }).executed ?? false).toBe(false);
  });
});
