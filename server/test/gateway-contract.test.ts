/**
 * §7 — the Gateway result must not be ambiguous about what actually happened.
 *
 * THE PROBLEM
 * -----------
 * `GatewayResult.executed` was documented as "True only when a tool actually ran
 * during this call", and `dispatch()` returned `executed: true` on the failure
 * path too. Both readings are defensible — the tool *was* invoked — but the field
 * was the only signal the API exposed, and a caller cannot tell these apart:
 *
 *   - the tool ran and the side effect happened;
 *   - the tool was invoked, threw, and nothing happened;
 *   - the tool reported `ok: false` and nothing happened;
 *   - another caller had already run it and this call did nothing.
 *
 * A payment integration reading `executed: true` as "the money moved" is a
 * financial bug, not a cosmetic one.
 *
 * A second, worse defect surfaced while writing these tests: a tool that returns
 * `{ ok: false }` *without throwing* went down the success path. The run was
 * recorded as `succeeded`, the execution as `allowed`, and — because `succeeded`
 * is terminal — the failure was **not retryable**. A failure the operator could
 * neither see nor retry.
 *
 * THE CONTRACT
 * ------------
 * `executed` is KEPT, for compatibility with existing clients and with
 * `server/test/gateway.test.ts`, and is explicitly redefined as *attempted*.
 * Three unambiguous fields are added next to it:
 *
 *   `attempted`  — a tool was invoked during THIS call (=== `executed`).
 *   `succeeded`  — the tool ran during this call AND reported success.
 *   `runState`   — the persisted run state, the actual source of truth.
 *
 * `runState` is the field a client should branch on, because it is the value
 * stored in the database rather than a property of one call.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentGateway } from "../gateway/agent-gateway";
import { ToolRegistry } from "../gateway/tool-registry";
import { CountingTool, type ToolContext, type ToolResult } from "../gateway/tools/types";
import { DecisionService } from "../services/decision-service";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { repositoriesFor, seedIfEmpty } from "../repositories";
import { startTestServer, type TestClient } from "./harness";


/*
 * These tests exercise behaviour *within* one tenant, so they take the default
 * organization's repositories. Cross-tenant behaviour is not asserted here — it has
 * its own suite in `tenant-isolation.test.ts`, with two real organizations.
 */
const repositories = repositoriesFor(DEFAULT_ORGANIZATION_ID);

/** Throws, like a network error or an unhandled exception inside an SDK. */
class ThrowingTool extends CountingTool {
  readonly id = "throwing_tool";
  readonly name = "Throwing Tool";
  readonly description = "Always throws.";
  protected async run(): Promise<ToolResult> {
    throw new Error("upstream refused the charge");
  }
}

/** Returns `ok: false` politely, which is what a well-behaved SDK does. */
class RefusingTool extends CountingTool {
  readonly id = "refusing_tool";
  readonly name = "Refusing Tool";
  readonly description = "Always reports failure without throwing.";
  protected async run(context: ToolContext): Promise<ToolResult> {
    return {
      ok: false,
      summary: `Provider declined the ${context.action}.`,
      data: { ok: false, error: "card_declined" },
    };
  }
}

class SucceedingTool extends CountingTool {
  readonly id = "succeeding_tool";
  readonly name = "Succeeding Tool";
  readonly description = "Always succeeds.";
  protected async run(context: ToolContext): Promise<ToolResult> {
    return { ok: true, summary: `Purchased from ${context.target}.`, data: { ok: true } };
  }
}

/**
 * A gateway wired to a chosen tool. `purchase` is used because it is catalogued
 * with a permission scope in `shared/policy/actions.ts`, which `ToolRegistry`
 * requires — the tests do not get to bypass that barrier.
 */
function gatewayWith(tool: CountingTool): AgentGateway {
  const registry = new ToolRegistry([tool], { purchase: tool.id });
  return new AgentGateway(new DecisionService(repositories), repositories, registry);
}

/** Small enough to stay under every seeded ceiling, so the verdict is ALLOW. */
const REQUEST = {
  agentId: "agt_procurement",
  action: "purchase",
  target: "supplier-x.com",
  metadata: { amount: 10, currency: "EUR", category: "Software" },
};

describe("the Gateway reports what actually happened", () => {
  let api: TestClient;

  beforeAll(async () => {
    // Boots the harness so the database file, schema and seed exist. The direct
    // gateway instances below share the same singleton repositories.
    api = await startTestServer();
    await seedIfEmpty();
  });

  afterAll(async () => {
    await api.close();
  });

  describe("a tool that throws", () => {
    it("is reported as attempted but not succeeded", async () => {
      const tool = new ThrowingTool();
      const result = await gatewayWith(tool).execute(REQUEST);

      expect(result.decision).toBe("ALLOW");
      expect(tool.toolExecutionCount).toBe(1);

      expect(result.attempted).toBe(true);
      expect(result.succeeded).toBe(false);
      expect(result.runState).toBe("failed");

      // The retained legacy field means "attempted". Documented, not silently
      // repurposed.
      expect(result.executed).toBe(result.attempted);

      // And the persisted record agrees, which is what the console reads.
      expect(result.execution?.status).toBe("failed");
    });
  });

  describe("a tool that returns ok:false without throwing", () => {
    it("is not recorded as a success", async () => {
      const tool = new RefusingTool();
      const result = await gatewayWith(tool).execute(REQUEST);

      expect(tool.toolExecutionCount).toBe(1);
      expect(result.attempted).toBe(true);
      expect(result.succeeded).toBe(false);

      // Previously this was `succeeded` / `allowed`: a declined payment filed as a
      // completed one.
      expect(result.runState).toBe("failed");
      expect(result.execution?.status).toBe("failed");
    });

    it("stays retryable, because failed is not a terminal success", async () => {
      const tool = new RefusingTool();
      const result = await gatewayWith(tool).execute(REQUEST);
      const id = result.executionId;
      expect(id).toBeTruthy();

      const retried = await api.post<{ runState: string; succeeded: boolean }>(
        `/api/executions/${id}/retry`,
        {},
      );
      // 200 proves the run was in a retryable state. The retry itself uses the
      // real registry, which has no tool for a second attempt to succeed with
      // here, so only the reachability of the retry path is asserted.
      expect(retried.status).toBe(200);
    });
  });

  describe("a tool that succeeds", () => {
    it("is reported as attempted and succeeded", async () => {
      const tool = new SucceedingTool();
      const result = await gatewayWith(tool).execute(REQUEST);

      expect(result.attempted).toBe(true);
      expect(result.succeeded).toBe(true);
      expect(result.runState).toBe("succeeded");
      expect(result.execution?.status).toBe("allowed");
    });
  });

  describe("a decision that never reaches a tool", () => {
    it("reports neither attempted nor succeeded when the action is held for approval", async () => {
      const tool = new SucceedingTool();
      const result = await gatewayWith(tool).execute({
        ...REQUEST,
        // Above `agt_procurement`'s 500 EUR mandate ceiling.
        metadata: { amount: 900, currency: "EUR", category: "Software" },
      });

      expect(result.decision).toBe("APPROVAL_REQUIRED");
      expect(tool.toolExecutionCount).toBe(0);
      expect(result.attempted).toBe(false);
      expect(result.succeeded).toBe(false);
      // Not `failed`: nothing failed. The run is waiting.
      expect(result.runState).toBe("pending");
    });
  });

  describe("a second caller arriving after the run finished", () => {
    it("does not claim to have attempted anything, but still reports the true run state", async () => {
      /*
       * The idempotence branch returned `executed: false` with no way to tell "I
       * did not run it because someone else already did, successfully" from "I did
       * not run it because it was blocked". `runState` closes that gap: it is read
       * from the stored row, not inferred from this call.
       */
      const tool = new SucceedingTool();
      const gateway = gatewayWith(tool);
      const first = await gateway.execute(REQUEST);
      expect(first.succeeded).toBe(true);

      const stored = await repositories.executions.findById(first.executionId as string);
      expect(stored?.runState).toBe("succeeded");

      const again = await gateway.retry(first.executionId as string, "Test");
      // A succeeded run is not retryable, which is the pre-existing (correct)
      // behaviour and must not regress.
      expect(again.ok).toBe(false);
      expect(tool.toolExecutionCount).toBe(1);
    });
  });

  describe("the HTTP surface exposes the same truth", () => {
    beforeEach(() => {
      // The HTTP routes use the real registry; only shape is asserted here.
    });

    it("returns attempted, succeeded and runState from POST /api/executions", async () => {
      const res = await api.post<{
        attempted: boolean;
        succeeded: boolean;
        runState: string | null;
        executed: boolean;
      }>("/api/executions", {
        agentId: "agt_procurement",
        action: "purchase",
        target: "supplier-x.com",
        amount: 10,
        category: "Software",
      });

      expect(res.status).toBe(201);
      expect(typeof res.body.attempted).toBe("boolean");
      expect(typeof res.body.succeeded).toBe("boolean");
      expect(res.body.runState).toBeTruthy();
      // A real tool is wired for `purchase`, so this really did run.
      expect(res.body.succeeded).toBe(true);
      expect(res.body.runState).toBe("succeeded");
      expect(res.body.executed).toBe(res.body.attempted);
    });

    it("returns them from POST /api/execute too", async () => {
      const res = await api.post<{ attempted: boolean; succeeded: boolean; runState: string }>(
        "/api/execute",
        { agentId: "agt_procurement", action: "purchase", target: "supplier-x.com" },
      );
      expect(res.status).toBe(200);
      expect(typeof res.body.attempted).toBe("boolean");
      expect(typeof res.body.succeeded).toBe("boolean");
      expect(res.body.runState).toBeTruthy();
    });

    it("returns them from a blocked action, without pretending anything ran", async () => {
      const res = await api.post<{
        decision: string;
        attempted: boolean;
        succeeded: boolean;
        runState: string;
      }>("/api/executions", {
        agentId: "agt_procurement",
        action: "purchase",
        target: "supplier-x.com",
        amount: 900,
        category: "Software",
      });

      expect(res.status).toBe(201);
      expect(res.body.decision).toBe("APPROVAL_REQUIRED");
      expect(res.body.attempted).toBe(false);
      expect(res.body.succeeded).toBe(false);
      expect(res.body.runState).toBe("pending");
    });
  });
});
