/**
 * §8 — the console's display rules, tested.
 *
 * These were nested ternaries inside JSX and therefore untested, which is where both
 * frontend truth bugs lived: a retry button offered on runs the server would refuse,
 * and a green success panel for a tool that had thrown. Now they are pure functions
 * with a test each, so a regression fails here instead of on someone's screen.
 */

import { describe, expect, it } from "vitest";
import {
  retryAffordance,
  executionDisplayStatus,
  toolOutcome,
  toolOutcomeLabel,
  toolOutcomeSentence,
} from "./run-presentation";
import type { Retryability } from "./api";

function retry(overrides: Partial<Retryability> = {}): Retryability {
  return {
    retryable: true,
    attempts: 1,
    maxAttempts: 5,
    attemptsRemaining: 4,
    reason: null,
    ...overrides,
  };
}

describe("retryAffordance", () => {
  it("offers the button when the server says retryable and the reader may execute", () => {
    const result = retryAffordance(retry(), true);
    expect(result).toEqual({ kind: "button", remaining: 4, max: 5 });
  });

  it("uses the server's own numbers in the caption", () => {
    // Not recomputed locally: `maxAttempts` is per-deployment, so a client-side
    // constant would be wrong on any install that changes OATHRION_MAX_TOOL_ATTEMPTS.
    const result = retryAffordance(retry({ attemptsRemaining: 1, maxAttempts: 3 }), true);
    expect(result).toEqual({ kind: "button", remaining: 1, max: 3 });
  });

  it("shows the server's reason when the run cannot be retried", () => {
    const result = retryAffordance(
      retry({ retryable: false, reason: "This run already succeeded." }),
      true,
    );
    /* La raison du serveur, traduite pour la console (`server-text.ts`). */
    expect(result).toEqual({ kind: "blocked", message: expect.stringMatching(/^This run already succeeded/) as string });
  });

  it("une raison que la console ne connaît pas s'affiche telle quelle, jamais remplacée", () => {
    const result = retryAffordance(retry({ retryable: false, reason: "A reason added later on the server." }), true);
    expect(result).toEqual({ kind: "blocked", message: "A reason added later on the server." });
  });

  it("shows the ceiling reason verbatim rather than a generic refusal", () => {
    /*
     * The bug this replaces: the button was enabled, the operator clicked, and the
     * console said "The server refused this retry" with no number and nothing to act
     * on. The ceiling must be visible before the click.
     */
    const reason = "This execution has used its 5 permitted tool attempts and will not be…";
    const result = retryAffordance(
      retry({ retryable: false, attemptsRemaining: 0, attempts: 5, reason }),
      true,
    );
    /* Traduite, et le plafond reste visible avant le clic. */
    expect(result.kind === "blocked" && result.message).toMatch(/used its 5 permitted tool attempts/);
  });

  it("does not claim the run is finished when the reader merely lacks the capability", () => {
    /*
     * The other frontend bug. A viewer looking at a FAILED run fell through to
     * "Waiting for a worker to claim this run" — a statement about the system that
     * was simply false. Retryability describes the RUN; capability describes the
     * READER; the two must not be merged.
     */
    const result = retryAffordance(retry(), false);
    expect(result.kind).toBe("no-capability");
    expect(result.kind === "no-capability" && result.message).toMatch(/"execute" capability/i);
    expect(result.kind === "no-capability" && result.message).not.toMatch(/waiting|claim/i);
  });

  it("prefers the blocked reason over the capability message", () => {
    // A viewer on an exhausted run should read why the RUN is finished, which is the
    // more informative of the two facts.
    const result = retryAffordance(
      retry({ retryable: false, reason: "This run already succeeded." }),
      false,
    );
    expect(result.kind).toBe("blocked");
  });

  it("never renders an empty explanation, even if the reason field is missing", () => {
    // Defensive: a field mismatch after a deploy must degrade to a vague sentence,
    // not to a panel with a blank space where the explanation belongs.
    const result = retryAffordance(retry({ retryable: false, reason: null }), true);
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.message.length).toBeGreaterThan(0);
  });
});

describe("toolOutcome", () => {
  it("reports a successful run as succeeded", () => {
    expect(toolOutcome({ attempted: true, succeeded: true })).toBe("succeeded");
  });

  it("reports an attempted-but-failed run as failed, not as success", () => {
    /*
     * The §7 ambiguity, as it appeared in the UI. The old code inferred success from
     * `toolResult?.ok !== false`. A tool that THREW returns no `toolResult` at all, so
     * `?.ok !== false` was true and the panel went green for a failure.
     */
    expect(toolOutcome({ attempted: true, succeeded: false })).toBe("failed");
  });

  it("reports a run that never reached a tool as not attempted", () => {
    expect(toolOutcome({ attempted: false, succeeded: false })).toBe("not-attempted");
  });

  it("does not hide an inconsistent server response", () => {
    // `succeeded` without `attempted` would be a server bug. Silently reclassifying
    // it as a failure would conceal the inconsistency instead of showing it.
    expect(toolOutcome({ attempted: false, succeeded: true })).toBe("succeeded");
  });

  it("labels the three states distinctly", () => {
    const labels = [
      toolOutcomeLabel({ attempted: false, succeeded: false }),
      toolOutcomeLabel({ attempted: true, succeeded: false }),
      toolOutcomeLabel({ attempted: true, succeeded: true }),
    ];
    expect(new Set(labels).size).toBe(3);
  });
});

describe("toolOutcomeSentence", () => {
  it("names the tool when it completed", () => {
    const text = toolOutcomeSentence(
      { attempted: true, succeeded: true, toolId: "purchase_tool" },
      true,
    );
    expect(text).toContain("purchase_tool");
    expect(text).toMatch(/completed/i);
  });

  it("says plainly that the action did not complete when the tool failed", () => {
    const text = toolOutcomeSentence(
      { attempted: true, succeeded: false, toolId: "purchase_tool" },
      true,
    );
    expect(text).toMatch(/failed/i);
    expect(text).toMatch(/did not complete/i);
    // Must not read as a success in any wording.
    expect(text).not.toMatch(/completed\.\s*$/i);
  });

  it("distinguishes a held action from a dry run", () => {
    /*
     * Both have `attempted: false`. Describing a dry run as "the Gateway held the
     * action" would report an enforcement event that never happened — and a dry run
     * writes nothing at all, which is the thing the operator needs told.
     */
    const held = toolOutcomeSentence({ attempted: false, succeeded: false, toolId: null }, true);
    const dry = toolOutcomeSentence({ attempted: false, succeeded: false, toolId: null }, false);

    expect(held).toMatch(/held the action/i);
    expect(dry).toMatch(/dry run/i);
    expect(dry).toMatch(/wrote nothing/i);
    expect(held).not.toBe(dry);
  });
});

describe("l'effet inconnu", () => {
  const unknown = { attempted: true, succeeded: false, toolId: "connector_slack", toolResult: { dispatched: "unknown" } };

  it("n'est ni un succès ni un échec", () => {
    expect(toolOutcome(unknown)).toBe("unknown");
    expect(toolOutcomeLabel(unknown)).toMatch(/Unknown/);
    expect(toolOutcomeSentence(unknown, true)).toMatch(/MAY have happened/);
    expect(toolOutcomeSentence(unknown, true)).not.toMatch(/did not complete/);
  });

  it("un échec où rien n'est parti reste un échec", () => {
    expect(toolOutcome({ ...unknown, toolResult: { dispatched: false } })).toBe("failed");
  });

  it("la relance n'est offerte que comme une confirmation, et seulement à qui peut approuver", () => {
    const retry = { retryable: false, attempts: 1, maxAttempts: 3, attemptsRemaining: 2, reason: "may already have taken effect", requiresConfirmation: true };
    expect(retryAffordance(retry, true, true)).toMatchObject({ kind: "confirm", canConfirm: true });
    expect(retryAffordance(retry, true, false)).toMatchObject({ kind: "confirm", canConfirm: false });
    expect(retryAffordance(retry, false, true)).toMatchObject({ kind: "confirm", canConfirm: false });
  });
});

describe("le statut affiché dans la liste", () => {
  it("un essai à l'effet inconnu n'est ni compté ni filtré comme un échec", () => {
    expect(executionDisplayStatus({ status: "failed", toolResult: { dispatched: "unknown" } })).toBe("unknown");
    expect(executionDisplayStatus({ status: "failed", toolResult: { dispatched: false } })).toBe("failed");
    expect(executionDisplayStatus({ status: "failed", toolResult: null })).toBe("failed");
    expect(executionDisplayStatus({ status: "allowed", toolResult: { dispatched: "unknown" } })).toBe("allowed");
  });
});
