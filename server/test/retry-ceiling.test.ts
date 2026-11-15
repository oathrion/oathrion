/**
 * A failing tool must not be retryable forever.
 *
 * THE PROBLEM
 * -----------
 * `claimToolRun` accepts any row in state `failed`, and `attempts` is only ever
 * incremented — nothing reads it. So `POST /api/executions/:id/retry` could be
 * called without limit against the same execution, and each call really does
 * invoke the tool again.
 *
 * That matters because the tools in this system are the side-effecting edge:
 * `purchase`, `payment`, `refund`, `transfer`. A tool that fails *after* the
 * upstream provider accepted the request — a timeout on a charge is the textbook
 * case — leaves a side effect behind on every attempt. Unbounded retry on a
 * financial verb is a way to spend money N times while the audit trail shows N
 * failures, and it is also a trivially available amplification vector for anyone
 * holding an `execute` credential: one execution, unlimited outbound calls, and
 * the per-identity rate limiter does not help because each retry is a legitimate
 * separate request.
 *
 * THE CEILING
 * -----------
 * Attempts are capped (`OATHRION_MAX_TOOL_ATTEMPTS`, default 5). The cap is enforced
 * in the SQL claim, not only in the service layer, so it holds for every path that
 * can reach a tool — retry, a re-approval, a stale-run recovery — and cannot be
 * bypassed by calling the repository directly.
 *
 * An exhausted execution stays `failed` and stays visible. It is not deleted,
 * not silently marked succeeded, and the verdict is not re-evaluated: exhaustion
 * is an operational fact, not a policy decision.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentGateway, MAX_TOOL_ATTEMPTS } from "../gateway/agent-gateway";
import { ToolRegistry } from "../gateway/tool-registry";
import { CountingTool, type ToolResult } from "../gateway/tools/types";
import { DecisionService } from "../services/decision-service";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { startTestServer, type TestClient } from "./harness";


/*
 * These tests exercise behaviour *within* one tenant, so they take the default
 * organization's repositories. Cross-tenant behaviour is not asserted here — it has
 * its own suite in `tenant-isolation.test.ts`, with two real organizations.
 */
const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

class AlwaysFailingTool extends CountingTool {
  readonly id = "always_failing_tool";
  readonly name = "Always Failing Tool";
  readonly description = "Fails every time, like a provider that is down.";
  protected async run(): Promise<ToolResult> {
    throw new Error("provider unavailable");
  }
}

function gatewayWith(tool: CountingTool): AgentGateway {
  return new AgentGateway(
    new DecisionService(repositories),
    repositories,
    new ToolRegistry([tool], { purchase: tool.id }),
  );
}

const REQUEST = {
  agentId: "agt_procurement",
  action: "purchase",
  target: "supplier-x.com",
  metadata: { amount: 10, currency: "EUR", category: "Software" },
};

describe("tool attempts are bounded", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("exposes a ceiling that is small enough to be a real limit", () => {
    // A "ceiling" of 10_000 would not be one. Sanity-checked so a future change
    // cannot neutralise the protection while keeping the constant.
    expect(MAX_TOOL_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(MAX_TOOL_ATTEMPTS).toBeLessThanOrEqual(20);
  });

  it("stops invoking the tool once the ceiling is reached", async () => {
    const tool = new AlwaysFailingTool();
    const gateway = gatewayWith(tool);

    const first = await gateway.execute(REQUEST);
    expect(first.attempted).toBe(true);
    expect(first.succeeded).toBe(false);
    const id = first.executionId as string;
    expect(id).toBeTruthy();

    // Retry far beyond the ceiling. Each call is a legitimate, authenticated
    // request; only the ceiling stops it.
    for (let i = 0; i < MAX_TOOL_ATTEMPTS + 10; i += 1) {
      await gateway.retry(id, "Test Operator");
    }

    // The first execute counted as attempt 1, so the tool ran at most
    // MAX_TOOL_ATTEMPTS times in total across every path.
    expect(tool.toolExecutionCount).toBe(MAX_TOOL_ATTEMPTS);

    const stored = await repositories.executions.findById(id);
    expect(stored?.attempts).toBe(MAX_TOOL_ATTEMPTS);
    // Still failed, still visible, verdict untouched.
    expect(stored?.runState).toBe("failed");
    expect(stored?.status).toBe("failed");
    expect(stored?.decision).toBe("allow");
  });

  it("refuses the retry with a 409 and an explanation naming the ceiling", async () => {
    const tool = new AlwaysFailingTool();
    const gateway = gatewayWith(tool);
    const first = await gateway.execute(REQUEST);
    const id = first.executionId as string;

    for (let i = 0; i < MAX_TOOL_ATTEMPTS; i += 1) {
      await gateway.retry(id, "Test Operator");
    }

    const refused = await api.post<{ error: string }>(`/api/executions/${id}/retry`, {});
    expect(refused.status).toBe(409);
    // The operator has to be able to tell "exhausted" from "not retryable because
    // it succeeded" — otherwise the only remaining move is guessing.
    expect(refused.body.error).toMatch(/attempt/i);
    expect(refused.body.error).toContain(String(MAX_TOOL_ATTEMPTS));
  });

  it("does not report an exhausted retry as an attempt or a success", async () => {
    const tool = new AlwaysFailingTool();
    const gateway = gatewayWith(tool);
    const first = await gateway.execute(REQUEST);
    const id = first.executionId as string;

    for (let i = 0; i < MAX_TOOL_ATTEMPTS; i += 1) {
      await gateway.retry(id, "Test Operator");
    }

    const outcome = await gateway.retry(id, "Test Operator");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
  });

  it("enforces the ceiling in the repository, not only in the service layer", async () => {
    /*
     * The claim is the single door to a tool. If the cap lived only in
     * `AgentGateway.retry`, any other caller — a future queue worker, a batch
     * script, a re-approval path — would reopen the hole. This proves the SQL
     * refuses the claim directly.
     */
    const tool = new AlwaysFailingTool();
    const gateway = gatewayWith(tool);
    const first = await gateway.execute(REQUEST);
    const id = first.executionId as string;

    for (let i = 0; i < MAX_TOOL_ATTEMPTS; i += 1) {
      await gateway.retry(id, "Test Operator");
    }

    const claimed = await repositories.executions.claimToolRun(
      id,
      tool.id,
      new Date().toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
    );
    expect(claimed).toBe(false);

    // And the refused claim did not consume another attempt.
    const stored = await repositories.executions.findById(id);
    expect(stored?.attempts).toBe(MAX_TOOL_ATTEMPTS);
  });

  it("does not penalise an execution that succeeds on a later attempt", async () => {
    /*
     * The ceiling must bound damage, not break legitimate recovery. A tool that
     * fails once and then works must reach `succeeded` normally.
     */
    let calls = 0;
    class FlakyTool extends CountingTool {
      readonly id = "flaky_tool";
      readonly name = "Flaky Tool";
      readonly description = "Fails once, then succeeds.";
      protected async run(): Promise<ToolResult> {
        calls += 1;
        if (calls === 1) throw new Error("transient network blip");
        return { ok: true, summary: "Purchased on the second attempt.", data: { ok: true } };
      }
    }

    const tool = new FlakyTool();
    const gateway = gatewayWith(tool);
    const first = await gateway.execute(REQUEST);
    expect(first.succeeded).toBe(false);

    const retried = await gateway.retry(first.executionId as string, "Test Operator");
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.succeeded).toBe(true);
      expect(retried.runState).toBe("succeeded");
    }
  });

  it("still refuses to retry a run that succeeded, ceiling or not", async () => {
    // Pre-existing behaviour that must not regress: the ceiling is an extra
    // barrier, not a replacement for terminal-state protection.
    class OkTool extends CountingTool {
      readonly id = "ok_tool";
      readonly name = "Ok Tool";
      readonly description = "Succeeds.";
      protected async run(): Promise<ToolResult> {
        return { ok: true, summary: "Done.", data: { ok: true } };
      }
    }
    const tool = new OkTool();
    const gateway = gatewayWith(tool);
    const first = await gateway.execute(REQUEST);
    expect(first.succeeded).toBe(true);

    const again = await gateway.retry(first.executionId as string, "Test Operator");
    expect(again.ok).toBe(false);
    expect(tool.toolExecutionCount).toBe(1);
  });
});
