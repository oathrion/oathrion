/**
 * The single statement of whether an execution may be retried.
 *
 * WHY THIS IS ONE FUNCTION
 * ------------------------
 * The backend has four independent reasons to refuse a retry: the decision was not
 * `allow`, the run is not `failed`, the approval that released it has lapsed, or the
 * attempt ceiling is spent. The third arrived in Phase 5 and was added to
 * `AgentGateway.retry()` only — so this function, whose entire purpose is to be the
 * single statement of the answer, went back to disagreeing with the enforcement it
 * mirrors. Phase 6 restored the invariant and made the parameter required so the
 * same drift cannot recur silently. The console knew
 * about one of them, so it offered an enabled "Retry tool run" button on executions
 * the server was always going to refuse. The operator learned this by clicking and
 * reading a generic failure with no number and no reason.
 *
 * The obvious-looking fix — read `attempts` in the client and compare against a
 * constant — is wrong twice over. The ceiling is per-deployment
 * (`OATHRION_MAX_TOOL_ATTEMPTS`), so a hard-coded client copy is wrong on any install
 * that changes it; and a rule written in two places is a rule that will eventually
 * disagree with itself, at which point the console confidently shows the wrong thing.
 *
 * So the conclusion is computed here, once, and both consumers use it: the API
 * serialises it onto every execution, and `AgentGateway.retry()` words its refusals
 * from the same reasons. `server/test/retryability.test.ts` asserts the advertised
 * answer and the enforced answer agree, in both directions.
 *
 * This describes the EXECUTION, never the caller. `retryable: true` means "the run
 * itself can be dispatched again", and a viewer sees the same value an operator does;
 * whether *this* caller may press the button is a capability check, kept separate. If
 * the two were merged, a viewer's screen would claim the run was finished when it
 * merely was not theirs to retry.
 */

import type { Execution } from "@shared/types";
import { isExpired } from "@shared/approvals/ttl";
import { MAX_TOOL_ATTEMPTS } from "../limits";

/**
 * What the caller knows about the approval that released this execution.
 *
 * `{ expiresAt }`   the execution was gated; this is that approval's deadline.
 * `null`            the execution was never gated, so no window can have closed.
 * `NOT_LOOKED_UP`   the caller decided the answer could not depend on it.
 *
 * WHY THIS PARAMETER IS REQUIRED AND NOT OPTIONAL
 * ----------------------------------------------
 * Because the bug being fixed here is precisely a caller not knowing it had a
 * question to answer. `AgentGateway.retry()` refuses an execution whose gating
 * approval has lapsed; this function did not know approvals existed, so
 * `GET /api/executions/:id` advertised `retryable: true, reason: null` on runs
 * the endpoint answered with a 409. The console offered an enabled button on a
 * run the server was always going to refuse — the exact failure this module's
 * header says it exists to prevent, reintroduced by the Phase 5 expiry work at
 * a layer that had no reason to look here.
 *
 * An optional parameter would have let every existing call site keep compiling
 * and keep being wrong. A required one makes the compiler ask the question.
 */
export type GatingApproval = { expiresAt: string | null } | null | typeof NOT_LOOKED_UP;

/**
 * Explicit "I did not fetch this".
 *
 * A caller may legitimately skip the lookup: only an execution that is `allow`
 * AND `failed` can reach the expiry check, so a list endpoint has no reason to
 * query an approval for a succeeded or blocked run. That optimisation is sound,
 * but it is sound *because of the order of the checks below* — and an
 * optimisation whose correctness depends on the order of statements in another
 * file is one silent edit away from being wrong.
 *
 * So it is made loud instead: if the expiry check is ever actually reached with
 * this sentinel, `retryabilityOf` throws. Reordering the checks turns a wrong
 * answer served to an operator into a failed test.
 */
export const NOT_LOOKED_UP = Symbol("gating-approval-not-looked-up");

/**
 * Whether an execution's retryability can depend on a gating approval.
 *
 * Exported so a caller batching lookups filters on the same predicate this
 * module reasons about, rather than on its own copy of the rule.
 */
export function mayDependOnGatingApproval(execution: Execution): boolean {
  return execution.decision === "allow" && (execution.runState ?? "pending") === "failed";
}

/**
 * The lapsed-approval message, shared with the retry endpoint's 409 for the same
 * reason `exhaustedReason` is.
 */
export function lapsedApprovalReason(): string {
  return (
    "The approval that released this action has expired — a retry would act on a lapsed " +
    "authorisation. Raise a fresh request."
  );
}

/** The tool sent its request and no answer came back: the side effect is unknown. */
export function effectUnknown(execution: Execution): boolean {
  return execution.toolResult?.dispatched === "unknown";
}

/**
 * Verbs whose replay cannot double an effect: READS ONLY, which have no side effect.
 *
 * Every write is excluded, including Linear issue creation. Oathrion sends Linear an id
 * derived from the execution, and Linear is expected to refuse a second create with the
 * same id — but that guarantee has not been verified against the real service, and a
 * retry rule must not rest on an expectation. `verify:launch` checks it once a Linear test
 * key exists; only then could this list grow, with that proof cited here.
 */
export function replaySafe(action: string): boolean {
  const verb = action.trim().toLowerCase();
  return /\.(read|list|search)$/.test(verb);
}

export function unknownEffectReason(): string {
  return (
    "The service received the request but did not answer in time: the action may already " +
    "have taken effect. It is not retried automatically, to avoid doing it twice. Check the " +
    "service; if nothing happened, a person allowed to approve can confirm it and run it again."
  );
}

export interface Retryability {
  /** Whether the run itself may be dispatched again. Not a permission. */
  retryable: boolean;
  /**
   * The run is refused ONLY because its effect is unknown: a person with `approve` may
   * confirm, after checking the service, that nothing happened — then it may run again.
   */
  requiresConfirmation?: boolean;
  /** Attempts already consumed. */
  attempts: number;
  /** The ceiling in force for this deployment. */
  maxAttempts: number;
  /** Never negative, even if the ceiling was lowered after attempts accumulated. */
  attemptsRemaining: number;
  /** Operator-facing explanation when `retryable` is false; `null` when it is true. */
  reason: string | null;
}

/**
 * The exhaustion message, shared with the retry endpoint's 409 so an operator reads
 * the same sentence whether they saw it before clicking or after.
 */
export function exhaustedReason(maxAttempts = MAX_TOOL_ATTEMPTS): string {
  return (
    `This execution has used its ${maxAttempts} permitted tool attempts and will not ` +
    `be dispatched again. The run stays "failed" and remains in the audit trail. ` +
    `Repeated failure of a side-effecting tool is treated as an outage to investigate, ` +
    `not something to retry indefinitely — each attempt can leave a side effect upstream. ` +
    `Submit a new action once the cause is fixed.`
  );
}

export function retryabilityOf(execution: Execution, gating: GatingApproval): Retryability {
  const attempts = execution.attempts ?? 0;
  const maxAttempts = MAX_TOOL_ATTEMPTS;
  const attemptsRemaining = Math.max(0, maxAttempts - attempts);

  const base = { attempts, maxAttempts, attemptsRemaining };

  // Order matters: it must match the order of the checks in `AgentGateway.retry()`,
  // so the reason the console shows is the reason the endpoint would have given.
  if (execution.decision !== "allow") {
    return {
      ...base,
      retryable: false,
      reason:
        `The Policy Engine returned "${execution.decision}" for this action. ` +
        `Only an allowed action can be retried — a retry re-dispatches the tool, it never ` +
        `re-opens the verdict.`,
    };
  }

  const runState = execution.runState ?? "pending";
  if (runState !== "failed") {
    return {
      ...base,
      retryable: false,
      reason:
        runState === "succeeded"
          ? "This run already succeeded. The server refuses a second dispatch for the same execution."
          : runState === "skipped"
            ? "No tool was dispatched: the Policy Engine held this action, so there is nothing to retry."
            : "This run has not been claimed by a worker yet, so there is nothing to retry.",
    };
  }

  /*
   * The approval window, checked in the SAME POSITION as in
   * `AgentGateway.retry()` — after the run state, before the attempt ceiling.
   *
   * Position matters as much as presence. This module's contract is that the
   * reason the console shows is the reason the endpoint would have given, and an
   * execution can be both out of attempts and past its approval deadline. Check
   * them in a different order here and the two layers disagree about which
   * sentence to print for the same run.
   */
  if (gating === NOT_LOOKED_UP) {
    throw new Error(
      "retryabilityOf reached the approval-window check with NOT_LOOKED_UP. " +
        "The caller skipped the gating-approval lookup on the grounds that this " +
        "execution could not reach here, and that is no longer true — see " +
        "`mayDependOnGatingApproval`. Fetch the approval or fix the predicate; " +
        "do not pass null, which asserts the execution was never gated.",
    );
  }
  if (gating !== null && isExpired(gating.expiresAt)) {
    return { ...base, retryable: false, reason: lapsedApprovalReason() };
  }

  if (attempts >= maxAttempts) {
    return { ...base, retryable: false, reason: exhaustedReason(maxAttempts) };
  }

  /*
   * AN UNKNOWN EFFECT IS NOT RETRIED BLINDLY — LAST, and last in `AgentGateway.retry()`.
   *
   * A connector that sent its request and got no answer records
   * `dispatched: "unknown"` (`server/connectors/transport-failure.ts`): Slack may have
   * posted, GitHub may have opened the issue. Re-dispatching could do it twice.
   *
   * Last on purpose: every other reason is final, this one is not. A person with the
   * `approve` capability who has CHECKED the service and found nothing may confirm it,
   * and only then is the run dispatched again — with that confirmation in the audit.
   * `requiresConfirmation` tells the console the procedure exists; it is never true when
   * an earlier, final reason applies, because confirming would not help.
   */
  if (effectUnknown(execution) && !replaySafe(execution.action)) {
    return { ...base, retryable: false, requiresConfirmation: true, reason: unknownEffectReason() };
  }

  return { ...base, retryable: true, reason: null };
}
