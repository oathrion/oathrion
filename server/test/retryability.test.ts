/**
 * §8 — the frontend must reflect exactly the backend truth about retryability.
 *
 * THE PROBLEM
 * -----------
 * The console offered "Retry tool run" for any execution whose `runState` was
 * `failed`. The backend has three separate reasons to refuse a retry — the decision
 * was not `allow`, the run is not `failed`, or the attempt ceiling is spent — and the
 * console knew about exactly one of them. So an operator was shown an enabled button
 * on an execution that had exhausted its attempts, clicked it, and got a generic
 * "The server refused this retry" with no number and no reason.
 *
 * The tempting fix is to reimplement the rule in the client: read `attempts`, compare
 * against a constant, hide the button. That constant is configurable per deployment
 * (`OATHRION_MAX_TOOL_ATTEMPTS`), so the client's copy would be wrong on any install
 * that changes it — and a rule written twice is a rule that will disagree with itself.
 *
 * THE FIX
 * -------
 * The server states the conclusion. Every execution the API returns carries a
 * `retry` block computed by one function, the same one the retry endpoint's refusals
 * are worded from. The client renders it and decides nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { MAX_TOOL_ATTEMPTS } from "../limits";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import type { Execution } from "@shared/types";


/*
 * These tests exercise behaviour *within* one tenant, so they take the default
 * organization's repositories. Cross-tenant behaviour is not asserted here — it has
 * its own suite in `tenant-isolation.test.ts`, with two real organizations.
 */
const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

interface Retryability {
  retryable: boolean;
  attempts: number;
  maxAttempts: number;
  attemptsRemaining: number;
  reason: string | null;
}

type ExecutionDto = Execution & { retry: Retryability };

async function anExecution(api: TestClient): Promise<string> {
  const res = await api.post<{ executionId: string | null }>("/api/executions", {
    agentId: "agt_procurement",
    action: "purchase",
    target: "supplier-x.com",
    amount: 10,
    category: "Software",
  });
  expect(res.status).toBe(201);
  return res.body.executionId as string;
}

describe("server-stated retryability", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("is present on the execution detail response", async () => {
    const id = await anExecution(api);
    const res = await api.get<ExecutionDto>(`/api/executions/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.retry).toBeDefined();
    expect(res.body.retry.maxAttempts).toBe(MAX_TOOL_ATTEMPTS);
  });

  it("is present on every row of the list response", async () => {
    await anExecution(api);
    const res = await api.get<ExecutionDto[]>("/api/executions");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    // A list row that omits it would make the console fall back to guessing.
    expect(res.body.every((e) => typeof e.retry?.retryable === "boolean")).toBe(true);
  });

  it("refuses a succeeded run, and says why", async () => {
    const id = await anExecution(api);
    const res = await api.get<ExecutionDto>(`/api/executions/${id}`);
    expect(res.body.runState).toBe("succeeded");
    expect(res.body.retry.retryable).toBe(false);
    expect(res.body.retry.reason).toMatch(/succeeded/i);
  });

  it("allows a failed run that has attempts left", async () => {
    const id = await anExecution(api);
    await repositories.executions.update(id, { runState: "failed", attempts: 1 });

    const res = await api.get<ExecutionDto>(`/api/executions/${id}`);
    expect(res.body.retry.retryable).toBe(true);
    expect(res.body.retry.reason).toBeNull();
    expect(res.body.retry.attemptsRemaining).toBe(MAX_TOOL_ATTEMPTS - 1);
  });

  it("refuses an exhausted run and names the ceiling", async () => {
    /*
     * The case the console got wrong. It must be visible BEFORE the click, with the
     * number, not discovered by pressing a button and reading a generic failure.
     */
    const id = await anExecution(api);
    await repositories.executions.update(id, {
      runState: "failed",
      attempts: MAX_TOOL_ATTEMPTS,
    });

    const res = await api.get<ExecutionDto>(`/api/executions/${id}`);
    expect(res.body.retry.retryable).toBe(false);
    expect(res.body.retry.attemptsRemaining).toBe(0);
    expect(res.body.retry.reason).toContain(String(MAX_TOOL_ATTEMPTS));
  });

  it("never reports negative remaining attempts", async () => {
    // `attempts` can exceed the ceiling if the limit is lowered on an existing
    // database. "-2 attempts remaining" in the console would be nonsense.
    const id = await anExecution(api);
    await repositories.executions.update(id, {
      runState: "failed",
      attempts: MAX_TOOL_ATTEMPTS + 3,
    });

    const res = await api.get<ExecutionDto>(`/api/executions/${id}`);
    expect(res.body.retry.attemptsRemaining).toBe(0);
    expect(res.body.retry.retryable).toBe(false);
  });

  it("agrees with what the retry endpoint actually does when exhausted", async () => {
    /*
     * The whole point: the advertised conclusion and the enforced one must be the
     * same rule. A `retryable: false` that the endpoint would have accepted, or the
     * reverse, is worse than no field at all.
     */
    const id = await anExecution(api);
    await repositories.executions.update(id, {
      runState: "failed",
      attempts: MAX_TOOL_ATTEMPTS,
    });

    const advertised = await api.get<ExecutionDto>(`/api/executions/${id}`);
    expect(advertised.body.retry.retryable).toBe(false);

    const attempted = await api.post(`/api/executions/${id}/retry`, {});
    expect(attempted.status).toBe(409);
  });

  it("agrees with the endpoint when it says a retry is possible", async () => {
    const id = await anExecution(api);
    await repositories.executions.update(id, { runState: "failed", attempts: 1 });

    const advertised = await api.get<ExecutionDto>(`/api/executions/${id}`);
    expect(advertised.body.retry.retryable).toBe(true);

    const attempted = await api.post(`/api/executions/${id}/retry`, {});
    // Not 409: the server does not refuse what it just advertised as possible.
    expect(attempted.status).not.toBe(409);
  });

  it("refuses a blocked decision, whatever the run state says", async () => {
    const held = await api.post<{ executionId: string | null }>("/api/executions", {
      agentId: "agt_procurement",
      action: "purchase",
      target: "supplier-x.com",
      amount: 900,
      category: "Software",
    });
    const id = held.body.executionId as string;
    await repositories.executions.update(id, { decision: "block", runState: "failed" });

    const res = await api.get<ExecutionDto>(`/api/executions/${id}`);
    expect(res.body.retry.retryable).toBe(false);
    expect(res.body.retry.reason).toMatch(/block/i);
  });

  it("does not present retryability as a permission", async () => {
    /*
     * `retryable` describes the EXECUTION, not the caller. A viewer must see the same
     * `retryable: true` an operator sees — the console gates the button on the
     * caller's capability separately. Conflating the two would make a viewer's screen
     * claim the run itself is finished when it merely is not theirs to retry.
     */
    const id = await anExecution(api);
    await repositories.executions.update(id, { runState: "failed", attempts: 1 });

    const asOperator = await api.get<ExecutionDto>(`/api/executions/${id}`, {
      auth: ROLE_KEYS.operator,
    });
    const asViewer = await api.get<ExecutionDto>(`/api/executions/${id}`, {
      auth: ROLE_KEYS.viewer,
    });

    expect(asViewer.status).toBe(200);
    expect(asViewer.body.retry.retryable).toBe(asOperator.body.retry.retryable);
    expect(asViewer.body.retry.retryable).toBe(true);
  });

  it("leaks nothing an execution row did not already expose", async () => {
    const id = await anExecution(api);
    const res = await api.get<ExecutionDto>(`/api/executions/${id}`);
    const serialized = JSON.stringify(res.body.retry);
    expect(serialized).not.toMatch(/secret|token|password|OATHRION_/i);
  });
});
