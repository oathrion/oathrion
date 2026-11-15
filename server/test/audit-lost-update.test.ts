/**
 * The audit trail must not silently lose entries under concurrency.
 *
 * THE PROBLEM
 * -----------
 * `SqliteExecutionRepository.update()` is a read-modify-write of the whole row:
 *
 *     const current = await this.findById(id);
 *     const next = { ...current, ...patch, id };
 *     db.update(...).set(fromExecution(next))...
 *
 * and every caller appends to the audit trail by building the new array from its
 * own in-memory snapshot (`audit: [...execution.audit, entry]`). Two operations
 * touching the same execution therefore race on the `audit` column: the second
 * write serialises last and carries a list built from a snapshot taken *before*
 * the first write, so the first entry is overwritten and disappears.
 *
 * The lost row is not a cache or a counter that can be recomputed. It is the audit
 * trail — the artefact whose entire purpose is to be the record of what happened
 * to a governed action. An audit log that drops entries under load is worse than
 * no audit log, because it is trusted.
 *
 * SQLite serialising writers does not help here: both writers are correct
 * individually, and the loss happens because the second one's *input* was stale.
 *
 * THE FIX
 * -------
 * A dedicated `appendAudit(id, entries)` that performs the read and the append
 * inside one SQLite transaction, reading the stored array rather than trusting the
 * caller's copy. Callers that append now use it. `update()` keeps its `audit` patch
 * for the (legitimate) case of replacing the trail wholesale, but no append path
 * goes through it any more.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import type { AuditEntry } from "@shared/types";


/*
 * These tests exercise behaviour *within* one tenant, so they take the default
 * organization's repositories. Cross-tenant behaviour is not asserted here — it has
 * its own suite in `tenant-isolation.test.ts`, with two real organizations.
 */
const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

/** Creates a real execution through the API and returns it. */
async function createExecution(api: TestClient): Promise<string> {
  const res = await api.post<{ executionId: string | null }>("/api/executions", {
    agentId: "agt_procurement",
    action: "purchase",
    target: "supplier-x.com",
    amount: 10,
    category: "Software",
  });
  expect(res.status).toBe(201);
  expect(res.body.executionId).toBeTruthy();
  return res.body.executionId as string;
}

function entry(n: number): AuditEntry {
  return { at: new Date().toISOString(), actor: `Writer ${n}`, event: `Event ${n}`, detail: "test" };
}

describe("concurrent audit appends", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("keeps every entry when many writers append at once", async () => {
    const id = await createExecution(api);
    const before = (await repositories.executions.findById(id))?.audit.length ?? 0;

    const WRITERS = 24;
    await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        repositories.executions.appendAudit(id, [entry(i)]),
      ),
    );

    const after = await repositories.executions.findById(id);
    expect(after?.audit.length).toBe(before + WRITERS);

    // Every writer is present exactly once — not merely the right count.
    for (let i = 0; i < WRITERS; i += 1) {
      const matches = (after?.audit ?? []).filter((e) => e.actor === `Writer ${i}`);
      expect(matches.length).toBe(1);
    }
  });

  it("is not defeated by a stale snapshot held by the caller", async () => {
    /*
     * The exact shape of the original bug: a caller reads the execution, something
     * else appends, and then the caller appends from its now-stale copy.
     */
    const id = await createExecution(api);
    const stale = await repositories.executions.findById(id);
    expect(stale).toBeTruthy();

    await repositories.executions.appendAudit(id, [entry(101)]);
    // The stale snapshot does not contain entry 101. Appending must not erase it.
    await repositories.executions.appendAudit(id, [entry(102)]);

    const after = await repositories.executions.findById(id);
    const actors = (after?.audit ?? []).map((e) => e.actor);
    expect(actors).toContain("Writer 101");
    expect(actors).toContain("Writer 102");
    expect(after?.audit.length).toBe((stale?.audit.length ?? 0) + 2);
  });

  it("preserves order, so the trail stays readable as a sequence", async () => {
    const id = await createExecution(api);
    await repositories.executions.appendAudit(id, [entry(1)]);
    await repositories.executions.appendAudit(id, [entry(2)]);
    await repositories.executions.appendAudit(id, [entry(3)]);

    const after = await repositories.executions.findById(id);
    const indexes = ["Writer 1", "Writer 2", "Writer 3"].map((a) =>
      (after?.audit ?? []).findIndex((e) => e.actor === a),
    );
    expect(indexes[0]).toBeLessThan(indexes[1]);
    expect(indexes[1]).toBeLessThan(indexes[2]);
  });

  it("appends several entries atomically as one group", async () => {
    const id = await createExecution(api);
    const before = (await repositories.executions.findById(id))?.audit.length ?? 0;
    await repositories.executions.appendAudit(id, [entry(7), entry(8)]);
    const after = await repositories.executions.findById(id);
    expect(after?.audit.length).toBe(before + 2);
  });

  it("returns undefined for an execution that does not exist, without creating one", async () => {
    const missing = await repositories.executions.appendAudit("exec_does_not_exist", [entry(0)]);
    expect(missing).toBeUndefined();
    expect(await repositories.executions.findById("exec_does_not_exist")).toBeUndefined();
  });

  it("does not lose the gateway's own entries when an approval resolves concurrently", async () => {
    /*
     * End-to-end version, through the real HTTP surface: an action held for
     * approval accumulates entries from the decision path, the approver and the
     * gateway's dispatch. Previously the dispatch entries were built from the
     * snapshot the approval handler had already replaced, so "Tool execution
     * started" and "Tool execution completed" could vanish — the two lines that
     * prove the action actually reached a tool.
     */
    const created = await api.post<{ approvalId: string | null; executionId: string | null }>(
      "/api/executions",
      {
        agentId: "agt_procurement",
        action: "purchase",
        target: "supplier-x.com",
        amount: 900,
        category: "Software",
      },
    );
    expect(created.body.approvalId).toBeTruthy();

    const resolved = await api.post(`/api/approvals/${created.body.approvalId}/approve`, {}, {
      auth: ROLE_KEYS.approver,
    });
    expect(resolved.status).toBe(200);

    const execution = await repositories.executions.findById(created.body.executionId as string);
    const events = (execution?.audit ?? []).map((e) => e.event);

    // The approval itself.
    expect(events).toContain("Approval granted");
    // And the proof the tool ran, which is what used to be at risk.
    expect(events).toContain("Tool execution started");
    expect(events).toContain("Tool execution completed");
  });
});
