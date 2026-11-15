/**
 * Pure presentation rules for a tool run.
 *
 * WHY THESE ARE FUNCTIONS AND NOT JSX
 * -----------------------------------
 * The decisions below — whether to offer a retry, what to say when we do not, and
 * what the tool's outcome actually was — used to be nested ternaries inside JSX.
 * That made them untestable in practice, and it is where the frontend's two truth
 * bugs lived:
 *
 *  - the retry button was offered whenever `runState === "failed"`, ignoring the two
 *    other reasons the server refuses a retry, and a reader without the `execute`
 *    capability fell through to "Waiting for a worker to claim this run" while
 *    looking at a run that had already failed;
 *  - tool success was inferred from `toolResult?.ok !== false`, so a tool that threw
 *    (no `toolResult` at all) rendered green.
 *
 * Extracted here they are ordinary functions with ordinary tests, and each rule
 * exists exactly once. They contain no policy of their own: `retryAffordance` reads
 * the server's `retry` block rather than re-deriving it, because the attempt ceiling
 * is per-deployment and a second copy of that rule would eventually disagree with the
 * server.
 */

import { retryReasonLabel } from "./server-text";
import type { Retryability } from "@/lib/api";

/* ------------------------------ Retry button ------------------------------ */

export type RetryAffordance =
  /** Show an enabled retry button. `remaining`/`max` are for the caption. */
  | { kind: "button"; remaining: number; max: number }
  /** The run could be retried, but this reader may not do it. */
  | { kind: "no-capability"; message: string }
  /** The run cannot be retried at all; `message` is the server's reason. */
  | { kind: "blocked"; message: string }
  /**
   * The effect is unknown. Retrying is possible only after someone with `approve`
   * confirms, having checked the service, that nothing happened.
   */
  | { kind: "confirm"; message: string; canConfirm: boolean };

/**
 * Decides what the retry area shows.
 *
 * The two inputs are deliberately separate. `retry.retryable` describes the RUN and
 * is the same for every reader; `canExecute` describes the READER. Merging them would
 * make a viewer's screen claim the run itself was finished when it merely was not
 * theirs to retry — which is a lie about the system, not a permission message.
 */
export function retryAffordance(retry: Retryability, canExecute: boolean, canApprove = false): RetryAffordance {
  if (!retry.retryable && retry.requiresConfirmation === true) {
    return {
      kind: "confirm",
      message: retry.reason ? retryReasonLabel(retry.reason) : "The effect of the previous attempt is unknown.",
      canConfirm: canExecute && canApprove,
    };
  }
  if (!retry.retryable) {
    return {
      kind: "blocked",
      // The server always supplies a reason alongside `retryable: false`. The
      // fallback exists so a future field mismatch degrades to a vague sentence
      // rather than rendering an empty panel with no explanation at all.
      message: retry.reason ? retryReasonLabel(retry.reason) : "This execution cannot be retried.",
    };
  }

  if (!canExecute) {
    return {
      kind: "no-capability",
      message: 'This execution can be retried, but your role lacks the "execute" capability.',
    };
  }

  return { kind: "button", remaining: retry.attemptsRemaining, max: retry.maxAttempts };
}

/* ------------------------------ Tool outcome ------------------------------ */

export type ToolOutcome = "not-attempted" | "failed" | "unknown" | "succeeded";

/**
 * The tool's real outcome, in three states rather than two.
 *
 * "Not attempted", "attempted and failed" and "succeeded" are genuinely different,
 * and collapsing the last two — which a single `executed: Yes` did — is what made a
 * failed payment look like a completed one.
 *
 * Note the order: `succeeded` is checked first and `attempted` is not consulted for
 * it. A `succeeded` that arrived without `attempted` would be a server bug, and this
 * function must not silently reclassify it as a failure and hide it.
 */
export function toolOutcome(result: {
  attempted: boolean;
  succeeded: boolean;
  toolResult?: Record<string, unknown> | null;
}): ToolOutcome {
  if (result.succeeded) return "succeeded";
  /*
   * The connector sent the request and got no answer (`dispatched: "unknown"`). Calling
   * that "failed — the action did not complete" was false: the service may have acted.
   */
  if (result.toolResult?.dispatched === "unknown") return "unknown";
  return result.attempted ? "failed" : "not-attempted";
}

export function toolOutcomeLabel(result: {
  attempted: boolean;
  succeeded: boolean;
  toolResult?: Record<string, unknown> | null;
}): string {
  switch (toolOutcome(result)) {
    case "succeeded":
      return "Succeeded";
    case "unknown":
      return "Unknown — check with the service";
    case "failed":
      return "Failed";
    default:
      return "Not attempted";
  }
}

/**
 * The sentence shown under the verdict panel.
 *
 * `persisted` distinguishes a real run that reached no tool (the engine held it) from
 * a dry run that could not have reached one. Both have `attempted: false`, and
 * reporting a dry run as "the Gateway held the action" would describe an enforcement
 * event that never happened.
 */
export function toolOutcomeSentence(
  result: { attempted: boolean; succeeded: boolean; toolId: string | null; toolResult?: Record<string, unknown> | null },
  persisted: boolean,
): string {
  switch (toolOutcome(result)) {
    case "succeeded":
      return `Tool reached — ${result.toolId} completed.`;
    case "unknown":
      return `Tool reached — ${result.toolId} sent the request, but the service did not answer. The action MAY have happened: check with the service before trying again.`;
    case "failed":
      return `Tool reached — ${result.toolId} was called and failed. The action did not complete.`;
    default:
      return persisted
        ? "No tool was reached: the gateway held the action."
        : "Dry run — the engine returned a decision and wrote nothing: no execution, no approval, no log, no tool call.";
  }
}

/* ----------------------------- List status ----------------------------- */

/**
 * The status shown in the execution LIST. A run whose request reached the service
 * without an answer is stored as `failed` (its tool run did fail to complete), but
 * listing it as « Failed » told the reader the action did not happen — which nobody
 * knows. It is shown, counted and filtered as its own state.
 */
export type DisplayStatus = "allowed" | "blocked" | "pending" | "failed" | "unknown";

export function executionDisplayStatus(execution: {
  status: "allowed" | "blocked" | "pending" | "failed";
  toolResult?: Record<string, unknown> | null;
}): DisplayStatus {
  if (execution.status === "failed" && execution.toolResult?.dispatched === "unknown") return "unknown";
  return execution.status;
}
