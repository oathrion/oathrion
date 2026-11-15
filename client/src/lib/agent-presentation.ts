/**
 * Pure presentation rules for the agent lifecycle control.
 *
 * WHAT WAS BROKEN
 * ---------------
 * The lifecycle toggle was rendered in two places — `pages/agent-detail.tsx` and
 * `components/agents/AgentTable.tsx` — and both computed the same two decisions
 * inline:
 *
 *     disabled={!canManage || agent.status === "draft"}
 *     {agent.status === "active" ? "Pause" : "Resume"}
 *
 * Both were wrong, and they were wrong in a way that made the product's core
 * lifecycle unusable:
 *
 *  1. `agent.status === "draft"` DISABLED the only control that can leave `draft`.
 *     A drafted agent was therefore permanently drafted from the console, even
 *     though `store.toggleAgentStatus` computes `draft → active` correctly and
 *     `PATCH /api/agents/:id` accepts `status: "active"` (the server's own
 *     `agentPatchSchema` admits the whole `active|paused|draft|review` enum). The
 *     backend and the store agreed; only the button disagreed, so an agent could
 *     be created and never switched on.
 *  2. The label said "Resume" for a `draft` agent, which had never run. "Resume"
 *     describes returning a paused agent to service; a drafted one is being
 *     activated for the first time. An operator reading "Resume" on an agent with
 *     no history cannot tell what the button will do.
 *
 * Extracted here, each rule exists exactly once and is an ordinary tested
 * function rather than a ternary duplicated across two components.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not weaken RBAC. `canManage` is still required, and it is still
 * re-checked in the click handler, because a `disabled` attribute is a hint to a
 * browser and not an authorization boundary — the server's
 * `requireCapability("manage")` is the real barrier and stays untouched.
 */

import type { AgentStatus } from "@/types";

/** What the lifecycle button will do, and how to say so. */
export interface AgentToggleAffordance {
  /** The status the server will be asked to store. */
  readonly next: Extract<AgentStatus, "active" | "paused">;
  /** Button text. */
  readonly label: string;
  /** `pause` renders the pause glyph; `start` renders the play glyph. */
  readonly icon: "pause" | "start";
  /**
   * True when this status has no lifecycle transition available from the
   * console. Never true merely because the agent is a draft.
   */
  readonly unavailable: boolean;
  /** Present only when `unavailable`; explains why, for a tooltip. */
  readonly unavailableReason?: string;
}

/**
 * The lifecycle transition offered for an agent in `status`.
 *
 * `review` is the one status with no console transition: an agent held for
 * review is waiting on a human decision recorded elsewhere, and letting the
 * toggle silently mark it `active` would route around that review. It is
 * reported as unavailable WITH a reason rather than rendered as a dead control.
 */
export function agentToggleAffordance(status: AgentStatus): AgentToggleAffordance {
  switch (status) {
    case "active":
      return { next: "paused", label: "Pause agent", icon: "pause", unavailable: false };
    case "paused":
      return { next: "active", label: "Resume agent", icon: "start", unavailable: false };
    case "draft":
      // The transition this module exists to restore.
      return { next: "active", label: "Activate agent", icon: "start", unavailable: false };
    case "review":
      return {
        next: "active",
        label: "Held for review",
        icon: "start",
        unavailable: true,
        unavailableReason:
          "This agent is held for review. Resolve the review before putting it into service.",
      };
  }
}

/**
 * Whether the lifecycle button is interactive.
 *
 * Two independent reasons to refuse, kept separate so the caller can explain
 * which one applies: the caller's capability, and the agent's status.
 */
export function agentToggleDisabled(status: AgentStatus, canManage: boolean): boolean {
  return !canManage || agentToggleAffordance(status).unavailable;
}

/**
 * The activity-feed sentence for a completed transition.
 *
 * Written from the transition actually performed, not from the target status, so
 * a first activation is not reported as a resumption.
 */
export function agentTransitionMessage(from: AgentStatus, to: "active" | "paused"): string {
  if (to === "paused") return "Agent paused by a person";
  return from === "draft" ? "Agent activated by a person" : "Agent resumed";
}
