import type { CurrencyCode } from "../money";
import type { AgentMandate } from "./mandate";

/**
 * Oathrion Policy Engine — type contracts.
 *
 * This module is deliberately free of React, Express, Drizzle and any I/O.
 * It describes what a policy *is* and what evaluating an action *returns*.
 */

/** The executable kinds of policy the engine understands. */
export type PolicyType =
  | "MAX_TRANSACTION_AMOUNT"
  | "REQUIRE_HUMAN_APPROVAL"
  | "BLOCK_TOOL"
  | "ALLOW_TOOL"
  | "MAX_DAILY_SPEND";

/**
 * The currencies this deployment understands.
 *
 * Re-exported from `shared/money.ts`, which owns the registry — this module used to
 * declare its own `"EUR" | "USD"` union, so adding a currency meant widening two
 * independent lists and the policy engine could disagree with the rest of the system
 * about what XOF even is. Amounts are still never converted between currencies: the
 * engine holds no exchange rates and refuses rather than guessing.
 */
export type { CurrencyCode };

/** What a policy does when its condition matches. */
export type PolicyAction = "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";

/** The verdict returned to the caller of `evaluateAction`. */
export type Decision = PolicyAction;

/** Engine-side risk vocabulary (uppercase). Mapped to the UI vocabulary at the boundary. */
export type EngineRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Structured, machine-evaluable condition. One variant per policy type.
 * `targets` and `actions` accept exact tokens or `*` wildcards (e.g. `postgres.prod.*`).
 */
export type PolicyCondition =
  | {
      kind: "amountAtMost";
      /** Path in metadata holding the numeric amount. Defaults to `amount`. */
      field?: string;
      max: number;
      currency?: CurrencyCode;
      /** Restrict the rule to these actions. Empty/undefined = every action. */
      actions?: string[];
    }
  | {
      kind: "targetMatches";
      targets: string[];
      actions?: string[];
      /**
       * Exceptions to a DENY-side rule (BLOCK_TOOL, REQUIRE_HUMAN_APPROVAL), matched
       * against the WHOLE target like an allow rule (`matchesExplicit`), never by segment.
       *
       * It exists for one sentence an operator says constantly and could not write:
       * « l'agent ne publie que dans #produit » — i.e. block `slack.com` except
       * `slack.com/C0PRODUIT`. Without it, the only tools were a deny-list (which cannot
       * name "everything else") and ALLOW_TOOL (which never overrides a BLOCK).
       *
       * Strict on purpose: an exception that matched by segment would let
       * `evil.com/slack.com/C0PRODUIT` through a rule written for one channel. A target
       * spelled differently from the exception (`https://…`, other case of a path) stays
       * blocked — fail closed.
       */
      exceptTargets?: string[];
    }
  | {
      kind: "dailySpendAtMost";
      /**
       * Metadata field holding the cost of THIS action. Defaults to `cost`.
       * Deliberately distinct from `amount` (a purchase's face value) so that a
       * $12,000 procurement order does not consume the provider-spend budget.
       */
      field?: string;
      max: number;
      currency?: CurrencyCode;
    };

/** A policy as the engine consumes it. */
export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  type: PolicyType;
  condition: PolicyCondition;
  /** Applied when the condition is violated (or matched, for BLOCK/ALLOW_TOOL). */
  action: PolicyAction;
  status: "enabled" | "disabled" | "draft";
  /** `null` means the policy applies to every agent in the organization. */
  appliesToAgentIds: string[] | null;
  risk: EngineRiskLevel;
  /** Higher wins when two policies produce the same decision. */
  priority: number;
}

/** Minimal agent projection the engine needs. Keeps the engine decoupled from the full Agent model. */
export interface EvaluationAgent {
  id: string;
  name: string;
  status: "active" | "paused" | "draft" | "review";
  /** Granted permission scopes, e.g. `send:email`. */
  permissions: string[];
  policyIds: string[];
  /** What this agent may do on its own authority. Absent = no per-agent limits. */
  mandate?: AgentMandate;
}

export interface EvaluationContext {
  agent: EvaluationAgent;
  action: string;
  target: string;
  metadata: Record<string, unknown>;
  /** Amount, in `orgCurrency`, already spent by this agent in the rolling day. */
  dailySpend: number;
  /**
   * The tenant's unit of account. Every ceiling evaluated against this context is
   * denominated in it, and an action declaring a different currency is refused rather
   * than converted. Per tenant since migration 15; before that it was the
   * deployment-wide `ORG_CURRENCY` constant.
   */
  orgCurrency: CurrencyCode;
  now: Date;
}

/** One policy's opinion about the action under evaluation. */
export interface PolicyVerdict {
  policyId: string;
  policyName: string;
  decision: Decision;
  reason: string;
  risk: EngineRiskLevel;
  priority: number;
}

export interface EvaluationResult {
  decision: Decision;
  reason: string;
  policyId: string | null;
  policyName: string | null;
  riskLevel: EngineRiskLevel;
  /** Every policy that expressed an opinion, strongest first. Useful for the audit trail. */
  matched: PolicyVerdict[];
  evaluatedAt: string;
}

/** Strength ordering used to resolve conflicts between policies. */
export const DECISION_WEIGHT: Record<Decision, number> = {
  ALLOW: 0,
  APPROVAL_REQUIRED: 1,
  BLOCK: 2,
};

export const RISK_WEIGHT: Record<EngineRiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export type { AgentMandate } from "./mandate";
