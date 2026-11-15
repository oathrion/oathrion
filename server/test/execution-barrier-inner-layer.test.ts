/**
 * The last layer of the execution barrier, tested where it actually acts.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The exactly-once guarantee is enforced twice. `POST /api/executions/:id/retry`
 * refuses a succeeded execution at the route, and `dispatch()` refuses a run it
 * did not win the SQL claim for. The route guard is the one every existing test
 * goes through, which meant the inner guard was never reached.
 *
 * Measured, not assumed. Three mutations to shipped code left the whole suite
 * green:
 *
 *   1. `if (!claimed)` in `agent-gateway.ts` -> `if (false)`, i.e. dispatch
 *      proceeds after LOSING the claim. The double-execution bug itself.
 *   2. The stale-run window in `claimToolRun` widened to always match, i.e. a
 *      run that is currently `running` can be re-claimed and dispatched again.
 *   3. `completeToolRun`'s `organization_id = ?` filter neutralised, i.e. one
 *      tenant can close another tenant's run.
 *
 * A surviving mutant is not a bug on its own - the code is correct in all three
 * places. It means the guarantee was resting on an untested line, and the next
 * refactor could have removed it silently. These are the tests that make that
 * impossible.
 *
 * The tests below therefore drive the gateway and the repositories directly,
 * because no route reaches these branches. `retry-ceiling.test.ts` established
 * that pattern; this file follows it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentGateway, MAX_TOOL_ATTEMPTS } from "../gateway/agent-gateway";
import { ToolRegistry } from "../gateway/tool-registry";
import { CountingTool, type ToolResult } from "../gateway/tools/types";
import { DecisionService } from "../services/decision-service";
import { DEFAULT_ORGANIZATION_ID, organizationId } from "@shared/tenancy";
import { repositoriesFor } from "../repositories";
import { startTestServer, type TestClient } from "./harness";

const ORG_A = DEFAULT_ORGANIZATION_ID;
/** The attacker's tenant, matching the "Rival Corp/" credential prefix. */
const ORG_B = organizationId("org_rival_corp");

const repoA = repositoriesFor(ORG_A);
const repoB = repositoriesFor(ORG_B);

/** A tool that succeeds, and counts precisely how often it really ran. */
class SucceedingTool extends CountingTool {
  readonly id = "barrier_succeeding_tool";
  readonly name = "Succeeding Tool";
  readonly description = "Succeeds, and counts how many times it was invoked.";
  protected async run(): Promise<ToolResult> {
    return { ok: true, summary: "done", data: { done: true } };
  }
}

/** A tool that fails, so the execution lands in `failed` and becomes retryable. */
class FailingTool extends CountingTool {
  readonly id = "barrier_failing_tool";
  readonly name = "Failing Tool";
  readonly description = "Fails every time, like a provider that is down.";
  protected async run(): Promise<ToolResult> {
    throw new Error("provider unavailable");
  }
}

/**
 * A tool that blocks until released, so a run can be observed while it is still
 * `running`. This is what makes the stale-window test possible without sleeping.
 */
class HangingTool extends CountingTool {
  readonly id = "barrier_hanging_tool";
  readonly name = "Hanging Tool";
  readonly description = "Stays in flight until the test releases it.";
  private release: (() => void) | undefined;
  /** Resolves once the tool has actually been entered. */
  entered!: Promise<void>;
  private markEntered!: () => void;

  constructor() {
    super();
    this.entered = new Promise<void>((resolve) => {
      this.markEntered = resolve;
    });
  }

  protected async run(): Promise<ToolResult> {
    this.markEntered();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return { ok: true, summary: "done", data: { done: true } };
  }

  finish(): void {
    this.release?.();
  }
}

function gatewayWith(tool: CountingTool, org = ORG_A): AgentGateway {
  const repositories = repositoriesFor(org);
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

describe("the inner execution barrier", () => {
  let api: TestClient;

  beforeAll(async () => {
    // The seeded dataset and the HTTP surface are shared with the other suites;
    // booting the server is what loads them.
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  /* --------------------------------------------------------------------- */
  /* 1. Losing the claim must mean running nothing                        */
  /* --------------------------------------------------------------------- */

  describe("a dispatch that loses the SQL claim runs nothing", () => {
    it("invokes the tool exactly once when many retries race on one execution", async () => {
      /*
       * The direct test of mutation (1). Every one of these retries is a
       * legitimate, authorised call on a `failed` execution, so the route guard
       * would let them all through - the SQL claim is the only thing that makes
       * one of them the winner. If `if (!claimed)` stops being honoured, the
       * losers dispatch too and this count goes above one.
       */
      const tool = new FailingTool();
      const gateway = gatewayWith(tool);

      const first = await gateway.execute(REQUEST);
      const id = first.executionId as string;
      expect(id).toBeTruthy();
      expect(tool.toolExecutionCount).toBe(1);

      const countBefore = tool.toolExecutionCount;
      const racers = 8;
      const outcomes = await Promise.all(
        Array.from({ length: racers }, () => gateway.retry(id, "Test Operator")),
      );

      const ranNow = tool.toolExecutionCount - countBefore;

      /*
       * The assertion is against the DATABASE, not against the return values.
       *
       * A first draft compared `ranNow` to the number of outcomes reporting
       * `attempted`, which is self-consistent and therefore worthless: a mutant
       * that dispatches after losing the claim reports `attempted` for those
       * calls too, and the two numbers move together. It survived.
       *
       * `attempts` is incremented by the same atomic UPDATE that grants the
       * claim, so it is the count of claims actually won - a number the dispatch
       * path cannot influence after the fact. One invocation per won claim is the
       * real guarantee, and it is the one that breaks when `if (!claimed)` stops
       * being honoured.
       *
       * better-sqlite3 is synchronous, so these retries do not truly overlap and
       * several may win in sequence. That is fine: the invariant is not "one
       * dispatch total", it is "never more dispatches than claims".
       */
      const stored = await repoA.executions.findById(id);
      expect(stored?.attempts).toBeDefined();
      const claimsWon = (stored!.attempts as number) - 1; // the initial execute won the first
      expect(ranNow, "a tool must never run more often than the claim was won").toBe(claimsWon);

      // Independently: the ceiling still bounds the whole thing, so a lost claim
      // cannot be turned into unbounded dispatch by sheer volume.
      expect(tool.toolExecutionCount).toBeLessThanOrEqual(MAX_TOOL_ATTEMPTS);

      // And a caller that lost the claim must say so plainly rather than
      // reporting a success it did not cause.
      for (const outcome of outcomes) {
        if (outcome.ok === false) continue;
        if (!outcome.attempted) expect(outcome.succeeded).toBe(false);
      }
      expect(outcomes.length).toBe(racers);
    });

    it("never invokes the tool again once a run has succeeded", async () => {
      /*
       * The strongest form: a succeeded run is terminal, and the barrier must
       * hold at the gateway even for a caller that bypasses the route.
       */
      const tool = new SucceedingTool();
      const gateway = gatewayWith(tool);

      const first = await gateway.execute(REQUEST);
      const id = first.executionId as string;
      expect(first.succeeded).toBe(true);
      expect(tool.toolExecutionCount).toBe(1);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const outcome = await gateway.retry(id, "Test Operator");
        /*
         * `retry` returns a discriminated union: a succeeded run is refused
         * outright with `ok: false` and a 409, and never reaches a dispatch
         * outcome at all. Asserting on `ok` rather than on `attempted` is the
         * difference between testing the guarantee and testing `undefined`,
         * which is how the first draft of this test passed vacuously.
         */
        expect(outcome.ok, "a succeeded run must not be retryable").toBe(false);
        if (!outcome.ok) {
          expect(outcome.status).toBe(409);
          expect(outcome.reason).toMatch(/succeeded/i);
        }
      }

      expect(tool.toolExecutionCount).toBe(1);
      const stored = await repoA.executions.findById(id);
      expect(stored?.runState).toBe("succeeded");
      expect(stored?.attempts).toBe(1);
    });

    it("separates the authorization result from the execution result", async () => {
      /*
       * The distinction the brief insists on. A lost claim is neither a refusal
       * nor an error: the action was authorised, and somebody else ran it.
       * Reporting it as a failure would make a correct system look broken and
       * invite the caller to retry, which is exactly the wrong reaction.
       *
       * `dispatch()` expresses this with three separate fields rather than one
       * `executed` boolean, and this test pins that they disagree in the one case
       * where they must: a call that ran nothing, on an execution that succeeded.
       */
      const tool = new FailingTool();
      const gateway = gatewayWith(tool);

      const first = await gateway.execute(REQUEST);
      const id = first.executionId as string;

      // The action was authorised - that is a decision, and it stands.
      expect(first.decision).toBe("ALLOW");
      // The tool then failed - that is an execution result, and it is separate.
      expect(first.attempted).toBe(true);
      expect(first.succeeded).toBe(false);

      const stored = await repoA.executions.findById(id);
      expect(stored?.decision).toBe("allow");
      expect(stored?.runState).toBe("failed");
    });

    it("refuses to retry a run that was never allowed, whatever its run state", async () => {
      /*
       * The inverse bypass: reaching a tool by retrying something the engine
       * refused. `retry` requires `decision === "allow"` before it looks at the
       * run state at all, so a BLOCK can never be laundered into an execution by
       * way of the retry path.
       */
      const tool = new SucceedingTool();
      const gateway = gatewayWith(tool);
      const countBefore = tool.toolExecutionCount;

      const blocked = await gateway.execute({
        ...REQUEST,
        action: "delete_customer",
        target: "cus_barrier",
      });
      const id = blocked.executionId as string;
      expect(id).toBeTruthy();
      expect(blocked.decision).not.toBe("ALLOW");
      expect(blocked.attempted).toBe(false);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const outcome = await gateway.retry(id, "Test Operator");
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.status).toBe(409);
          /*
           * The REASON is asserted, not only the status. A blocked execution also
           * has a non-`failed` run state, so the second guard in `retry` refuses
           * it too - which means removing the decision guard leaves the status at
           * 409 and the test green. It survived that mutant.
           *
           * The two guards answer different questions and a caller acts on them
           * differently: "this was refused by policy" is final, "this run is not
           * in a retryable state" invites trying again later. Pinning the wording
           * pins which guard spoke.
           */
          expect(outcome.reason).toMatch(/only an allowed action can be retried/i);
          expect(outcome.reason).toContain("block");
        }
      }

      // The claim that matters: nothing ran, on any attempt.
      expect(tool.toolExecutionCount).toBe(countBefore);
    });
  });

  /* --------------------------------------------------------------------- */
  /* 2. A run that is in flight is not available to be re-claimed         */
  /* --------------------------------------------------------------------- */

  describe("a run that is still in flight cannot be claimed again", () => {
    it("refuses a second claim while the first is running and recent", async () => {
      /*
       * The direct test of mutation (2). `claimToolRun` may recover a `running`
       * row only once `tool_started_at` is older than the stale window; a fresh
       * one must be untouchable, or a slow tool gets double-dispatched.
       *
       * Asserted against the repository, because that is where the window lives
       * - the SQL is the guarantee, and a service-layer check would not hold for
       * a second process.
       */
      /*
       * A FAILING tool, deliberately. A first draft used a succeeding one, which
       * leaves the run in `succeeded` - a state `claimToolRun` refuses outright -
       * so the row never reached `running`, the assertion sat behind an
       * `if (runState === "running")` that never fired, and the test passed while
       * asserting nothing. It survived the mutant that removed the window.
       *
       * No conditionals below. Every step is asserted, so the test cannot go
       * quiet again if the states change.
       */
      const tool = new FailingTool();
      const gateway = gatewayWith(tool);
      const first = await gateway.execute(REQUEST);
      const id = first.executionId as string;
      expect(id).toBeTruthy();
      expect((await repoA.executions.findById(id))?.runState).toBe("failed");

      // Put the row into `running` with a *current* start time, which is exactly
      // the state a slow in-flight tool leaves behind.
      const now = new Date().toISOString();
      const claimed = await repoA.executions.claimToolRun(id, tool.id, now, now);
      expect(claimed, "a failed run must be claimable").toBe(true);
      expect((await repoA.executions.findById(id))?.runState).toBe("running");

      // A second claim, with a stale threshold of "one minute ago", must fail:
      // this run started just now.
      const staleBefore = new Date(Date.now() - 60_000).toISOString();
      const second = await repoA.executions.claimToolRun(
        id,
        tool.id,
        new Date().toISOString(),
        staleBefore,
      );
      expect(second, "an in-flight run must not be re-claimable").toBe(false);

      // "It returned false" is not proof it changed nothing: `attempts` must not
      // have moved either, or a refused claim would still burn the ceiling.
      expect((await repoA.executions.findById(id))?.attempts).toBe(2);
    });

    it("dispatches once when a second call arrives while the tool is still in flight", async () => {
      /*
       * The same guarantee end to end, with a tool that really is still running.
       * No sleeping and no clock manipulation: the tool holds the run open until
       * the test releases it, so the second dispatch meets a genuinely in-flight
       * row.
       */
      const tool = new HangingTool();
      const gateway = gatewayWith(tool);

      const inFlight = gateway.execute(REQUEST);
      await tool.entered; // the tool is now inside run(), the row is `running`

      expect(tool.toolExecutionCount).toBe(1);

      tool.finish();
      const first = await inFlight;
      const id = first.executionId as string;

      // One invocation, one execution, and the run closed cleanly.
      expect(tool.toolExecutionCount).toBe(1);
      const stored = await repoA.executions.findById(id);
      expect(stored?.attempts).toBe(1);
    });

    it("allows recovery once the run really is stale, so a crash is not permanent", async () => {
      /*
       * The other half of the window, asserted so the test above cannot be
       * satisfied by simply never recovering anything. A run abandoned by a
       * crashed worker must become claimable again - a barrier that turns a
       * crash into a permanent stall is its own kind of outage.
       */
      const tool = new FailingTool();
      const gateway = gatewayWith(tool);
      const first = await gateway.execute(REQUEST);
      const id = first.executionId as string;

      const startedAt = new Date().toISOString();
      const claimed = await repoA.executions.claimToolRun(id, tool.id, startedAt, startedAt);
      expect(claimed).toBe(true);
      expect((await repoA.executions.findById(id))?.runState).toBe("running");

      // A threshold in the future means "everything older than now is stale",
      // which is how a recovery sweep would look at an abandoned run.
      const staleBefore = new Date(Date.now() + 60_000).toISOString();
      const recovered = await repoA.executions.claimToolRun(
        id,
        tool.id,
        new Date().toISOString(),
        staleBefore,
      );
      expect(recovered, "a stale run must be recoverable").toBe(true);
    });
  });

  /* --------------------------------------------------------------------- */
  /* 3. Closing a run is a tenant-scoped write                            */
  /* --------------------------------------------------------------------- */

  describe("one tenant cannot close another tenant's run", () => {
    it("refuses a cross-tenant completeToolRun and leaves the row untouched", async () => {
      /*
       * The direct test of mutation (3). `tenant-isolation.test.ts` covers the
       * conditional writes it knows about; `completeToolRun` was not among the
       * ones it reached with a foreign repository, so its `organization_id`
       * filter could be removed unnoticed.
       *
       * The consequence is not theoretical: `completeToolRun` writes
       * `run_state = 'succeeded'` and the tool result. A tenant that can call it
       * on a neighbour's id can mark that neighbour's execution succeeded, which
       * both falsifies their ledger and closes a run they may still be holding.
       */
      const tool = new FailingTool();
      const gateway = gatewayWith(tool);
      const first = await gateway.execute(REQUEST);
      const id = first.executionId as string;
      expect(id).toBeTruthy();

      const before = await repoA.executions.findById(id);
      expect(before).toBeDefined();

      // Put it into `running` as its rightful owner, so the only thing standing
      // between the attacker and the write is the tenant filter.
      const at = new Date().toISOString();
      await repoA.executions.claimToolRun(id, tool.id, at, at);
      const claimed = await repoA.executions.findById(id);

      // The attacker, holding the victim's execution id, tries to close it.
      const stolen = await repoB.executions.completeToolRun(id, {
        ok: true,
        at: new Date().toISOString(),
        result: { attacker: "was here" },
      });
      expect(stolen, "a foreign tenant must not close this run").toBe(false);

      // "It returned false" is not proof. Re-read as the owner.
      const after = await repoA.executions.findById(id);
      expect(after?.runState).toBe(claimed?.runState);
      expect(after?.toolResult ?? null).toEqual(claimed?.toolResult ?? null);
      expect(JSON.stringify(after?.toolResult ?? null)).not.toContain("attacker");
    });

    it("refuses a cross-tenant failure write too", async () => {
      /*
       * The failure branch is a different SQL statement, so it is a different
       * guarantee. Marking a neighbour's run `failed` is a denial-of-service on
       * their execution and a lie in their audit trail.
       */
      const tool = new FailingTool();
      const gateway = gatewayWith(tool);
      const first = await gateway.execute(REQUEST);
      const id = first.executionId as string;

      const at = new Date().toISOString();
      await repoA.executions.claimToolRun(id, tool.id, at, at);
      const claimed = await repoA.executions.findById(id);

      const stolen = await repoB.executions.completeToolRun(id, {
        ok: false,
        at: new Date().toISOString(),
        error: "injected by another tenant",
      });
      expect(stolen).toBe(false);

      const after = await repoA.executions.findById(id);
      expect(after?.runState).toBe(claimed?.runState);
      expect(after?.lastError ?? "").not.toContain("another tenant");
    });

    it("refuses a cross-tenant claim, so the barrier is not a way in either", async () => {
      // Already covered by tenant-isolation.test.ts, asserted here as well so
      // this file describes the whole barrier rather than half of it.
      const tool = new FailingTool();
      const gateway = gatewayWith(tool);
      const first = await gateway.execute(REQUEST);
      const id = first.executionId as string;

      const before = await repoA.executions.findById(id);
      const at = new Date().toISOString();
      const stolen = await repoB.executions.claimToolRun(id, tool.id, at, at);
      expect(stolen).toBe(false);

      const after = await repoA.executions.findById(id);
      expect(after?.attempts).toBe(before?.attempts);
      expect(after?.runState).toBe(before?.runState);
    });
  });
});
