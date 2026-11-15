/**
 * Boundary adapters between the engine vocabulary (uppercase, executable) and the
 * product/UI vocabulary (lowercase, display-oriented) declared in `shared/types.ts`.
 *
 * Keeping the translation in one file means the engine never imports the UI model
 * and the UI never has to know about `APPROVAL_REQUIRED`.
 */

import type {
  Decision,
  EngineRiskLevel,
  PolicyRule,
} from "./types";
import type {
  DecisionOutcome,
  ExecutionStatus,
  Policy,
  RiskLevel,
} from "../types";

export function toEngineRisk(risk: RiskLevel): EngineRiskLevel {
  return risk.toUpperCase() as EngineRiskLevel;
}

export function toUiRisk(risk: EngineRiskLevel): RiskLevel {
  return risk.toLowerCase() as RiskLevel;
}

const DECISION_TO_OUTCOME: Record<Decision, DecisionOutcome> = {
  ALLOW: "allow",
  BLOCK: "block",
  APPROVAL_REQUIRED: "require_approval",
};

const DECISION_TO_STATUS: Record<Decision, ExecutionStatus> = {
  ALLOW: "allowed",
  BLOCK: "blocked",
  APPROVAL_REQUIRED: "pending",
};

export function toDecisionOutcome(decision: Decision): DecisionOutcome {
  return DECISION_TO_OUTCOME[decision];
}

export function toExecutionStatus(decision: Decision): ExecutionStatus {
  return DECISION_TO_STATUS[decision];
}

/**
 * Projects a stored/display policy onto the executable shape the engine consumes.
 * Returns `null` for advisory policies that carry no machine-evaluable condition
 * (e.g. `warn`-only guidance), so the engine simply ignores them.
 */
export function toPolicyRule(policy: Policy): PolicyRule | null {
  if (!policy.type || !policy.condition) return null;
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    type: policy.type,
    condition: policy.condition,
    action: policy.action ?? "BLOCK",
    status: policy.status,
    appliesToAgentIds: policy.appliesToAgentIds ?? null,
    risk: toEngineRisk(policy.risk ?? "medium"),
    priority: policy.priority ?? 0,
  };
}

export function toPolicyRules(policies: Policy[]): PolicyRule[] {
  return policies
    .map(toPolicyRule)
    .filter((rule): rule is PolicyRule => rule !== null);
}
