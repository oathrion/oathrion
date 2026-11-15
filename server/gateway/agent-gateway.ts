/**
 * Oathrion Gateway — the single chokepoint between an agent and a tool.
 *
 *   AI Agent → AgentGateway → DecisionService → Policy Engine
 *                                   ↓
 *                        ALLOW / BLOCK / APPROVAL_REQUIRED
 *                                   ↓
 *                          Tool Adapter → Tool
 *
 * Security invariants enforced here, and nowhere else:
 *
 *  1. A tool is only ever reached through `dispatch()`, which is private and is
 *     called on exactly two paths: an ALLOW verdict, or an approval that just
 *     transitioned to `approved`.
 *  2. BLOCK and APPROVAL_REQUIRED return before `dispatch()` is reachable, so a
 *     denied action cannot touch a tool even by accident.
 *  3. Each Execution may run its tool at most once. The claim is an atomic
 *     conditional UPDATE in SQLite, not an in-memory flag — so a double approve,
 *     a concurrent approve, or a process restart cannot produce a second call.
 *  4. Tools never authorize anything. The Policy Engine is the source of truth.
 */

import type { AuditEntry, Execution, RunState } from "@shared/types";
import type { Decision } from "@shared/policy/types";
import type { Repositories } from "../repositories/types";
import type { DecisionOutput, DecisionService } from "../services/decision-service";
import type { ToolRegistry } from "./tool-registry";
import type { ToolResult } from "./tools/types";
import { MAX_TOOL_ATTEMPTS } from "../limits";
import type { GrantRecord } from "../authority/store";
import type { GatewayLedger } from "./gateway-ledger";
import { isExpired } from "@shared/approvals/ttl";
import { boundStoredResult } from "./stored-result";
import {
  effectUnknown,
  exhaustedReason,
  lapsedApprovalReason,
  replaySafe,
  unknownEffectReason,
} from "./retryability";
import { approvalSettled } from "../approval-events";

/**
 * Re-exported so a client of the gateway can report the ceiling without reaching
 * into the storage layer. Declared once, in `server/limits.ts`.
 */
export { MAX_TOOL_ATTEMPTS };

/**
 * How long a claimed-but-unfinished run stays untouchable before another worker
 * may recover it. Short enough that a crash is not a permanent stall, long
 * enough that a slow tool is never double-dispatched.
 */
const STALE_RUN_MS = Number(process.env.OATHRION_TOOL_STALE_MS) > 0
  ? Number(process.env.OATHRION_TOOL_STALE_MS)
  : 60_000;

export interface GatewayRequest {
  agentId: string;
  action: string;
  target: string;
  metadata?: Record<string, unknown>;
  actor?: string;
}

/**
 * What a dispatch attempt actually did.
 *
 * `executed` used to be the only signal, and it was ambiguous: `dispatch()`
 * returned `executed: true` both when the tool completed its side effect and when
 * the tool was merely invoked and then threw. A payment client reading
 * `executed: true` as "the money moved" is a financial bug, so the three fields
 * below split the two questions that were conflated.
 */
export interface DispatchOutcome {
  /** A tool was invoked during THIS call. Says nothing about the result. */
  attempted: boolean;
  /** The tool was invoked during this call AND reported success. */
  succeeded: boolean;
  /**
   * The persisted run state — read from the row, not inferred from this call.
   * This is the field a client should branch on, because it stays correct for a
   * caller that arrived after somebody else finished the run.
   */
  runState: RunState | null;
  toolId: string | null;
  toolResult: Record<string, unknown> | null;
  execution: Execution | null;
}

export interface GatewayResult extends DispatchOutcome {
  decision: Decision;
  /**
   * RETAINED FOR COMPATIBILITY, AND IT MEANS `attempted`.
   *
   * It is deliberately not removed: existing API clients and `gateway.test.ts`
   * depend on it. Its semantics are pinned here rather than left to the reader:
   * `executed === attempted`, so it is TRUE for a tool that was invoked and
   * failed. Anything asking "did the side effect happen?" must read `succeeded`
   * or `runState`. Enforced by `server/test/gateway-contract.test.ts`.
   */
  executed: boolean;
  reason: string;
  policyId: string | null;
  policyName: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  matched: DecisionOutput["matched"];
  executionId: string | null;
  approvalId: string | null;
}

import { DEFAULT_CURRENCY, type CurrencyCode } from "@shared/money";
import { timed } from "../observability/timing";

/** L'action approuvée n'a aucun outil joignable : rien n'est décidé, la demande reste en attente. */
export class ToolUnreachableError extends Error {
  constructor(readonly action: string) {
    super(
      `No tool can run "${action}" right now, so this approval was not recorded and the request is still pending. ` +
        `With oathrion wrap, the wrapped server runs only while your client (or "oathrion console") is open.`,
    );
    this.name = "ToolUnreachableError";
  }
}

export class AgentGateway {
  constructor(
    private readonly decisions: DecisionService,
    private readonly repos: Repositories,
    private readonly tools: ToolRegistry,
    /**
     * The tenant's unit of account, resolved once per tenant scope in `routes.ts`.
     *
     * Passed to every tool so a connector transmits the currency it was given rather than
     * assuming one. Changing a tenant's currency therefore takes effect when the tenant
     * scope is rebuilt (process restart) — acceptable because `organizationStore.setCurrency`
     * is a correction made before any amount exists, not a routine operation.
     */
    private readonly currency: CurrencyCode = DEFAULT_CURRENCY,
    /*
     * Le locataire de cette passerelle. `routes.ts` en construit une PAR organisation —
     * la valeur est donc connue à la construction et n'a pas à être redécouverte au
     * moment du branchement, où elle pourrait l'être à partir d'une entrée de requête.
     */
    private readonly organizationId: string = "",
    /*
     * Le registre d'autorité (`gateway-ledger.ts`) : chaque outil exécuté ici laisse un reçu
     * dans la chaîne du locataire, comme sur le chemin `/api/actions/*`. `routes.ts` le passe
     * toujours ; `null` ne sert qu'aux tests qui construisent une passerelle nue.
     */
    private readonly ledger: GatewayLedger | null = null,
  ) {}

  /** Le reçu, après l'outil. Un échec est déjà journalisé par le registre et signalé par `receipt.gap`. */
  private async closeLedger(
    grant: GrantRecord | null,
    execution: Execution,
    outcome: "succeeded" | "failed",
    data: Record<string, unknown>,
    summary: string,
  ): Promise<void> {
    if (!this.ledger || !grant) return;
    await this.ledger.close({ grant, execution, outcome, data, summary, at: new Date().toISOString() }).catch(() => undefined);
  }

  /**
   * Run one agent action through the control plane.
   * The tool is invoked if — and only if — the engine returns ALLOW.
   */
  async execute(request: GatewayRequest): Promise<GatewayResult> {
    const outcome = await this.decisions.decide({
      agentId: request.agentId,
      action: request.action,
      target: request.target,
      metadata: request.metadata ?? {},
      actor: request.actor,
    });

    const execution = outcome.execution;
    const base: GatewayResult = {
      decision: outcome.decision,
      executed: false,
      attempted: false,
      succeeded: false,
      // Not `failed`: nothing failed. A held or blocked action has simply not run.
      runState: execution?.runState ?? null,
      reason: outcome.reason,
      policyId: outcome.policyId,
      policyName: outcome.policyName,
      riskLevel: outcome.riskLevel,
      matched: outcome.matched,
      executionId: execution?.id ?? null,
      approvalId: outcome.approval?.id ?? null,
      toolId: null,
      toolResult: null,
      execution,
    };

    // BLOCK and APPROVAL_REQUIRED stop here. No tool call is even reachable.
    if (outcome.decision !== "ALLOW" || !execution) return base;

    /* L'agent reçoit la réponse dans CET appel : la base n'en garde qu'une version bornée. */
    const dispatched = await timed("dispatch", () =>
      this.dispatch(execution, request.metadata ?? {}, "bounded"),
    );
    // `executed` is the legacy alias of `attempted`; kept in exactly one place so
    // the two can never drift apart.
    return { ...base, ...dispatched, executed: dispatched.attempted };
  }

  /**
   * Resolve a pending approval, then release the held action to its tool when
   * the human approved it. Rejection never reaches a tool.
   */
  async resolveApproval(
    approvalId: string,
    status: "approved" | "rejected",
    resolvedBy: string,
  ): Promise<
    | ({
        approval: Awaited<ReturnType<DecisionService["resolveApproval"]>>;
        /** Legacy alias of `attempted`; see `GatewayResult.executed`. */
        executed: boolean;
      } & DispatchOutcome)
    | null
  > {
    /*
     * Approuver une action dont l'outil n'est joignable par personne la consommerait pour
     * rien : l'exécution serait marquée « sautée », définitivement, et la personne croirait
     * avoir relâché l'action. C'est le cas ordinaire d'`oathrion wrap` quand le serveur
     * enveloppé ne tourne pas (le client fermé, la console ouverte seule). La demande reste
     * en attente, et la personne l'apprend AVANT de décider.
     */
    if (status === "approved") {
      const pending = await this.repos.approvals.findById(approvalId);
      if (pending?.status === "pending" && pending.executionId) {
        const held = await this.repos.executions.findById(pending.executionId);
        const tool = held ? this.tools.resolve(held.action) : undefined;
        if (held && (!tool || tool.reachable === false)) throw new ToolUnreachableError(held.action);
      }
    }

    const resolution = await this.decisions.resolveApproval(approvalId, status, resolvedBy);
    if (!resolution) return null;

    const { execution, changed, expired } = resolution;

    /*
     * Only a fresh approval releases the action. A repeated approve, any
     * rejection, or an approve that arrived after the window closed returns the
     * stored state without touching a tool.
     *
     * `expired` has to be tested explicitly and must come first. An expiry *is* a
     * state change, so it returns `changed: true`, and the caller asked for
     * `"approved"` against a non-null execution — so every other condition in
     * this guard is satisfied on the late-approve path. Without this term the
     * call falls straight through to `dispatch()`.
     *
     * Measured, not assumed: removing this term alone does NOT release the
     * action. `dispatch()` is reached, but the claim is refused, because expiry
     * has already marked the execution `skipped` and `claimToolRun` will not
     * claim a skipped row. Removing this term AND that `markSkipped` does
     * release it — the refund arrives at the downstream. So this is the first of
     * two independent barriers, not the only one, and the honest claim is that
     * both are load-bearing rather than that either is sufficient.
     * `script/phase5-mutations.sh` checks all three cases.
     */
    if (expired || status !== "approved" || !execution || !changed) {
      if (changed) approvalSettled(this.organizationId, approvalId);
      return {
        approval: resolution,
        execution,
        executed: false,
        attempted: false,
        succeeded: false,
        // A rejection, or a repeated approve of an already-resolved request. The
        // stored state is the answer; this call changed nothing.
        runState: execution?.runState ?? null,
        toolId: execution?.toolId ?? null,
        toolResult: execution?.toolResult ?? null,
      };
    }

    const dispatched = await this.dispatch(execution, execution.input as Record<string, unknown>);
    /* L'issue est connue (exécutée, échouée) : ceux qui l'attendent sont réveillés. */
    approvalSettled(this.organizationId, approvalId);
    return { approval: resolution, ...dispatched, executed: dispatched.attempted };
  }

  /**
   * Retry a tool run that previously failed.
   *
   * Only an execution the engine already cleared (`decision: allow`) and whose
   * run ended in `failed` is retryable. Everything else — a blocked action, a
   * pending approval, an already-succeeded run — is refused, so a retry can
   * never be used to bypass a verdict or to run a tool twice.
   */
  async retry(
    executionId: string,
    actor: string,
    /**
     * `confirmedNotApplied`: the caller has checked the external service and states that
     * the earlier attempt left no effect. Only meaningful for an execution whose effect is
     * unknown; the ROUTE requires the `approve` capability to pass it.
     */
    options: { confirmedNotApplied?: boolean } = {},
  ): Promise<
    | ({ ok: true; execution: Execution; executed: boolean } & Omit<DispatchOutcome, "execution">)
    | { ok: false; status: 404 | 409; reason: string }
  > {
    const execution = await this.repos.executions.findById(executionId);
    if (!execution) return { ok: false, status: 404, reason: "Execution not found" };

    if (execution.decision !== "allow") {
      return {
        ok: false,
        status: 409,
        reason: `Execution is "${execution.decision}" — only an allowed action can be retried.`,
      };
    }
    if (execution.runState !== "failed") {
      return {
        ok: false,
        status: 409,
        reason: `Run state is "${execution.runState ?? "pending"}" — only a failed run can be retried.`,
      };
    }

    /*
     * A retry is a fresh real-world side effect, so the authorisation that
     * released the action has to still be open for it.
     *
     * This closes a genuine replay window. Approving an execution rewrites its
     * `decision` to `"allow"`, which is exactly what this method requires; and
     * this endpoint asks only for `execute`, not `approve`. So before this guard,
     * an operator with no approval rights could re-dispatch a failed high-value
     * action indefinitely — a week later, a month later — on the strength of a
     * human decision made in a context that no longer existed. The attempt
     * ceiling bounded how *many* times, never how *long*.
     *
     * Only executions that were actually gated are affected: an action the engine
     * cleared outright never had a window, so there is nothing to have closed.
     * Retrying inside the window still works, which is the case that matters
     * operationally — a transient downstream failure retried minutes later.
     */
    const gating = await this.repos.approvals.findByExecutionId(execution.id);
    if (gating && isExpired(gating.expiresAt)) {
      return {
        ok: false,
        status: 409,
        reason:
          lapsedApprovalReason(),
      };
    }

    /*
     * The attempt ceiling, reported here as well as enforced in the SQL claim.
     *
     * The claim is the real barrier — it holds for every path, including ones that
     * do not go through this method. But a refused claim is indistinguishable, from
     * the outside, from the idempotence case ("someone else already ran it"), and an
     * operator who cannot tell "exhausted" from "already succeeded" has nothing left
     * to do but guess. So the exhausted case is named explicitly, with the number,
     * before dispatch is even reached.
     */
    const attempts = execution.attempts ?? 0;
    if (attempts >= MAX_TOOL_ATTEMPTS) {
      return {
        ok: false,
        status: 409,
        // The same sentence `retryabilityOf` advertises, so an operator reads one
        // wording whether they saw it before clicking or after.
        reason: exhaustedReason(MAX_TOOL_ATTEMPTS),
      };
    }

    /* Last, as in `retryabilityOf`: every final refusal above has already been given. */
    const unknown = effectUnknown(execution) && !replaySafe(execution.action);
    if (unknown && options.confirmedNotApplied !== true) {
      return { ok: false, status: 409, reason: unknownEffectReason() };
    }

    const at = new Date().toISOString();
    const withAudit = await this.appendAudit(execution, [
      ...(unknown
        ? [
            {
              at,
              actor,
              /*
               * Une ATTESTATION HUMAINE, et l'audit le dit. Oathrion n'a aucune preuve venue
               * du service que la tentative précédente n'a rien fait : il consigne qui
               * l'affirme, et quand.
               */
              event: "Human attestation: unknown effect reported absent",
              detail:
                "The previous attempt reached the service without an answer. " +
                `${actor} attests, after checking the service, that it left no effect. ` +
                "This is a human attestation: Oathrion holds no evidence from the service.",
            },
          ]
        : []),
      {
        at,
        actor,
        event: "Tool execution retried",
        detail: execution.lastError ?? "Manual retry",
      },
    ]);

    const dispatched = await this.dispatch(withAudit, withAudit.input as Record<string, unknown>);
    return {
      ok: true,
      ...dispatched,
      executed: dispatched.attempted,
      execution: dispatched.execution ?? withAudit,
    };
  }

  /**
   * The one and only path to a tool.
   *
   * Claims the execution first: if the claim fails, another caller already ran
   * this action and we return the persisted result instead of running again.
   */
  private async dispatch(
    execution: Execution,
    metadata: Record<string, unknown>,
    /*
     * `bounded` : l'exécution immédiate, dont l'agent a déjà la réponse complète. `full` : après
     * une approbation ou une nouvelle tentative, la réponse est remise plus tard depuis la base
     * (`stored-result.ts`).
     */
    storage: "bounded" | "full" = "full",
  ): Promise<DispatchOutcome> {
    const tool = this.tools.resolve(execution.action);

    if (!tool) {
      await this.repos.executions.markSkipped(
        execution.id,
        `No tool is registered for action "${execution.action}".`,
      );
      // The persisted `result` still read "Action forwarded to the tool." — the
      // sentence written when the decision was recorded, before anyone knew
      // whether a tool existed. Nothing was forwarded, so the record has to say
      // so: an audit trail that overstates what happened is worse than none.
      // The policy verdict itself (`status`) is untouched: the action really was
      // allowed; it simply had nowhere to go.
      const updated = await this.appendAudit(
        execution,
        [
          {
            at: new Date().toISOString(),
            actor: "Gateway",
            event: "Tool execution skipped",
            detail: `No tool is registered for action "${execution.action}".`,
          },
        ],
        `Allowed, but no tool is registered for action "${execution.action}" — nothing was executed.`,
      );
      return {
        attempted: false,
        succeeded: false,
        // `markSkipped` moved the row to `skipped`, which is terminal. Read it back
        // from the record rather than hard-coding it here.
        runState: updated.runState ?? "skipped",
        toolId: null,
        toolResult: null,
        execution: updated,
      };
    }

    const claimedAt = new Date().toISOString();
    const staleBefore = new Date(Date.now() - STALE_RUN_MS).toISOString();
    const claimed = await timed("claim", () => this.repos.executions.claimToolRun(
      execution.id,
      tool.id,
      claimedAt,
      staleBefore,
      // Passed explicitly even though the repository defaults to the same value:
      // the ceiling being a deliberate part of the dispatch contract is worth
      // stating at the call site rather than inheriting silently.
      MAX_TOOL_ATTEMPTS,
    ));

    if (!claimed) {
      // Idempotence: someone already ran this execution's tool.
      const stored = (await this.repos.executions.findById(execution.id)) ?? execution;
      return {
        // This call ran nothing — but the run itself may well have succeeded, in
        // another request. `attempted: false` describes this call; `runState`
        // describes reality. Conflating the two is what made the old single-field
        // contract unusable for a caller arriving second.
        attempted: false,
        succeeded: false,
        runState: stored.runState ?? null,
        toolId: stored.toolId ?? tool.id,
        toolResult: stored.toolResult ?? null,
        execution: stored,
      };
    }

    const startedAt = Date.now();

    /**
     * Records a failed attempt. Shared by the two ways a tool can fail, which used
     * to be handled very differently: a throw was recorded correctly, while a tool
     * politely returning `{ ok: false }` fell through to the SUCCESS path below and
     * was stored as `succeeded` / `allowed`. Because `succeeded` is terminal, that
     * declined call was also not retryable — a failure the operator could neither
     * see nor recover from. Both paths now land here.
     */
    const recordFailure = async (
      message: string,
      toolResult: Record<string, unknown>,
    ): Promise<DispatchOutcome> => {
      /*
       * Même transaction unique que la voie succès. L'ordre que l'ancien découpage
       * payait — état terminal d'abord pour rester rejouable — est remplacé par
       * l'atomicité : ou tout atterrit, ou rien, et la reprise par ancienneté couvre le
       * processus qui meurt au milieu.
       *
       * La trace reste appendue depuis la version stockée et non depuis l'instantané
       * capturé avant l'exécution de l'outil, qui ignore ce qu'un autre écrivain —
       * l'approbation qui a libéré l'action, une reprise concurrente — a ajouté depuis.
       */
      const settledFailure = await this.repos.executions.settleToolRun(
        execution.id,
        { ok: false, at: new Date().toISOString(), error: message },
        [
          { at: claimedAt, actor: "Gateway", event: "Tool execution started", detail: tool.name },
          {
            at: new Date().toISOString(),
            actor: tool.name,
            event: "Tool execution failed",
            detail: message,
          },
        ],
        {
          status: "failed",
          result: `Tool execution failed: ${message}`,
          toolId: tool.id,
          toolResult,
        },
      );
      const failed = settledFailure ?? (await this.repos.executions.findById(execution.id));
      /*
       * Un échec AVANT l'outil (le registre lui-même) ne consomme rien et n'a pas de reçu :
       * `grant` est alors nul. Un échec de l'outil, lui, a dépensé l'autorisation.
       */
      await this.closeLedger(grant, failed ?? execution, "failed", toolResult, message);
      return {
        // The tool really was invoked, so `attempted` is true — the side effect may
        // even have partially happened upstream, which is exactly why this must not
        // be reported as "nothing happened" either.
        attempted: true,
        succeeded: false,
        runState: failed?.runState ?? "failed",
        toolId: tool.id,
        toolResult,
        execution: failed ?? execution,
      };
    };

    /*
     * LE REGISTRE D'AUTORITÉ, AVANT l'outil. Fermé par défaut : si l'autorisation ne peut pas
     * être inscrite et consommée, l'outil ne tourne pas, et l'échec dit que rien n'est parti.
     */
    let grant: GrantRecord | null = null;
    if (this.ledger) {
      try {
        grant = await this.ledger.open({ execution, toolId: tool.id, attempt: Date.now(), at: claimedAt });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return recordFailure(`Authority ledger unavailable: nothing was sent. ${reason}`, {
          ok: false,
          dispatched: false,
          reason: "ledger_unavailable",
        });
      }
    }

    let result: ToolResult;
    try {
      result = await timed("tool", () => tool.execute({
        organizationId: this.organizationId,
        executionId: execution.id,
        agentId: execution.agentId,
        agentName: execution.agentName,
        action: execution.action,
        target: execution.target,
        metadata,
        currency: this.currency,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool failed";
      return recordFailure(message, { ok: false, error: message });
    }

    if (!result.ok) {
      /*
       * A tool that reports failure without throwing. This is the NORMAL way a
       * well-behaved SDK reports a declined card or a rejected request, and it was
       * being filed as a completed action. `result.data` is preserved so the
       * provider's own error payload survives for debugging.
       */
      return recordFailure(result.summary || "Tool reported failure", {
        ...result.data,
        ok: false,
      });
    }

    const finishedAt = new Date().toISOString();
    // `succeeded` is terminal: no later claim, retry or double-approve can run
    // this tool again.
    /*
     * UNE SEULE TRANSACTION pour l'état terminal, la trace et les colonnes scalaires.
     *
     * C'étaient trois appels — `completeToolRun`, `appendAudit`, `update` — donc trois
     * allers-retours de base et trois validations durables pour décrire UN événement :
     * l'outil a tourné. Mesuré sur la voie du pare-feu, 9,5 ms des 37,8 ms de surcoût.
     *
     * L'ancien découpage payait un ordre — l'état terminal d'abord, pour que la ligne
     * soit rejouable même si l'audit n'arrivait pas. L'atomicité rend cet ordre inutile :
     * ou les trois atterrissent, ou aucune, et un processus qui meurt laisse la
     * réclamation périmée que la reprise par ancienneté récupère déjà.
     *
     * La trace est toujours appendue depuis la version STOCKÉE, lue sous verrou dans la
     * même transaction — jamais reconstruite depuis l'instantané que cette méthode tient,
     * qui a été capturé AVANT que l'outil ne tourne.
     */
    const settled = await timed("settle", () => this.repos.executions.settleToolRun(
      execution.id,
      { ok: true, at: claimedAt, result: result.data },
      [
        { at: claimedAt, actor: "Gateway", event: "Tool execution started", detail: tool.name },
        {
          at: finishedAt,
          actor: tool.name,
          event: "Tool execution completed",
          detail: result.summary,
        },
      ],
      {
        status: "allowed",
        result: result.summary,
        durationMs: Math.max(execution.durationMs, Date.now() - startedAt),
        toolId: tool.id,
        toolResult: storage === "bounded" ? boundStoredResult(result.data) : result.data,
        lastError: null,
      },
    ));
    /*
     * `undefined` veut dire que la ligne n'était plus `running` : quelqu'un d'autre l'a
     * close. L'ancienne version ignorait le booléen de `completeToolRun` et écrasait
     * quand même la trace — ce chemin-là est désormais refusé, et on rend ce qui est
     * réellement stocké plutôt que ce qu'on croyait écrire.
     */
    const updated = settled ?? (await this.repos.executions.findById(execution.id));
    await this.closeLedger(grant, updated ?? execution, "succeeded", result.data, result.summary);

    return {
      attempted: true,
      succeeded: true,
      runState: updated?.runState ?? "succeeded",
      toolId: tool.id,
      toolResult: result.data,
      execution: updated ?? execution,
    };
  }

  /**
   * Append to the trail, and optionally set `result` in the same logical step.
   *
   * The append goes through the repository's atomic `appendAudit` rather than
   * `update({ audit: [...execution.audit, ...entries] })`. The old form rebuilt the
   * whole trail from the in-memory snapshot this method was handed, so any entry
   * another writer had added since that snapshot was read — an approval resolving,
   * a concurrent retry — was silently overwritten. Losing entries from an audit
   * trail is not a performance detail; the trail is the record the whole product
   * exists to produce.
   *
   * `result` is a scalar column, so a normal patch is correct for it. It is written
   * second: if the process dies in between, the trail has one extra entry, which is
   * strictly better than a `result` describing an event the trail does not contain.
   */
  private async appendAudit(
    execution: Execution,
    entries: AuditEntry[],
    result?: string,
  ): Promise<Execution> {
    const appended = await this.repos.executions.appendAudit(execution.id, entries);
    if (result === undefined) return appended ?? execution;

    const updated = await this.repos.executions.update(execution.id, { result });
    return updated ?? appended ?? execution;
  }
}
