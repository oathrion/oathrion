/**
 * Oathrion Policy Engine.
 *
 *   agent + action + target + metadata  →  ALLOW | BLOCK | APPROVAL_REQUIRED
 *
 * Pure and synchronous: no database, no network, no framework. Callers supply the
 * policies and the pre-computed daily spend, which makes the engine trivially testable
 * and lets the persistence layer evolve independently.
 */

import {
  SPENDING_ACTIONS,
  isDangerousActionName,
  lookupAction,
  normalizeActionName,
} from "./actions";
import { DEFAULT_CURRENCY, type CurrencyCode } from "../money";
import { evaluateMandate } from "./mandate";
import { matchesAny } from "./matchers";
import {
  DEFAULT_UNDECLARED_ACTION_POSTURE,
  type UndeclaredActionPosture,
} from "./posture";
import { RULE_EVALUATORS } from "./rules";
import {
  DECISION_WEIGHT,
  RISK_WEIGHT,
  type Decision,
  type EvaluationAgent,
  type EvaluationContext,
  type EvaluationResult,
  type PolicyRule,
  type PolicyVerdict,
} from "./types";

export interface EvaluateActionInput {
  agent: EvaluationAgent;
  action: string;
  target: string;
  metadata?: Record<string, unknown>;
  policies: PolicyRule[];
  /** Amount already spent by this agent within the rolling day. Defaults to 0. */
  dailySpend?: number;
  now?: Date;
  /**
   * What to do with a verb that is in no catalog and named by no policy.
   *
   * Defaults to `DEFAULT_UNDECLARED_ACTION_POSTURE` (`block`). Callers that omit
   * it get the fail-closed answer, which is deliberate: the engine is a pure
   * function used from tests, the console and the server, and the one place a
   * missing argument must never mean "permissive" is the security default.
   * See `shared/policy/posture.ts`.
   */
  undeclaredActionPosture?: UndeclaredActionPosture;
  /**
   * The tenant's unit of account — every ceiling in `policies` and in the agent's mandate
   * is denominated in it.
   *
   * Defaults to `DEFAULT_CURRENCY`. Unlike `undeclaredActionPosture`, the default here is
   * an ergonomic for the pure function's many test call sites and NOT a security
   * fallback: it cannot make a refusal into an allowance. What it affects is which
   * currency a policy that omits the field inherits, and a mismatch between that and the
   * action's declared currency is a BLOCK either way — the engine holds no exchange rates
   * and refuses rather than converting.
   *
   * The server path must still pass the real tenant's currency, because a policy written
   * in XOF for a franc-zone tenant would otherwise be read as EUR and refuse every action
   * that tenant sends. `shared/policy/currency-single-path.test.ts` asserts structurally
   * that `server/services/decision-service.ts` supplies it.
   */
  orgCurrency?: CurrencyCode;
}

/** A policy applies when it is enabled and either org-wide or bound to this agent. */
function appliesTo(policy: PolicyRule, agent: EvaluationAgent): boolean {
  if (policy.status !== "enabled") return false;
  if (policy.appliesToAgentIds === null) return true;
  if (policy.appliesToAgentIds.includes(agent.id)) return true;
  return agent.policyIds.includes(policy.id);
}

/** BLOCK beats APPROVAL_REQUIRED beats ALLOW; ties broken by priority, then risk. */
function strongest(a: PolicyVerdict, b: PolicyVerdict): PolicyVerdict {
  const byDecision = DECISION_WEIGHT[b.decision] - DECISION_WEIGHT[a.decision];
  if (byDecision !== 0) return byDecision > 0 ? b : a;
  if (b.priority !== a.priority) return b.priority > a.priority ? b : a;
  return RISK_WEIGHT[b.risk] > RISK_WEIGHT[a.risk] ? b : a;
}

function sortVerdicts(verdicts: PolicyVerdict[]): PolicyVerdict[] {
  return [...verdicts].sort((a, b) => {
    const byDecision = DECISION_WEIGHT[b.decision] - DECISION_WEIGHT[a.decision];
    if (byDecision !== 0) return byDecision;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return RISK_WEIGHT[b.risk] - RISK_WEIGHT[a.risk];
  });
}

/**
 * Maps an action verb onto the permission scope required to perform it.
 *
 * This used to be a hand-written `switch` covering only the five verbs wired to
 * a tool (`purchase`, `send_email`, `access`, `query`, `write`), on the argument
 * that gating an unwired verb "would enforce nothing real". That argument had a
 * hole: it made the permission barrier depend on a *separate* hand-maintained
 * table (the tool registry's action map), so wiring a new tool silently created
 * an un-gated dangerous verb. Worse, `payment`, `transfer` and `subscribe` were
 * already subject to the mandate spending ceiling while requiring NO permission,
 * so an agent without `execute:payments` could obtain an ALLOW for `transfer`.
 *
 * The answer is now derived from `shared/policy/actions.ts`, the single source of
 * truth, which also feeds `SPENDING_ACTIONS`, `OUTBOUND_ACTIONS` and the tool
 * registry's own validation. See that file's header for the full rationale.
 */
export function requiredPermissionForAction(action: string): string | null {
  return lookupAction(action)?.requiredScope ?? null;
}

/**
 * Synthetic verdict for a verb that is not catalogued but whose name advertises
 * a dangerous effect.
 *
 * Returned as a normal high-priority verdict rather than an early return so it
 * still composes with the usual precedence: a real policy that says BLOCK beats
 * it, and it shows up in `matched` so the console can explain the hold.
 */
function unknownDangerousVerdict(action: string): PolicyVerdict {
  return {
    policyId: "sys_unknown_dangerous_action",
    policyName: "Unrecognised dangerous action",
    decision: "APPROVAL_REQUIRED",
    reason:
      `"${action}" is not a declared action (see shared/policy/actions.ts), but its name indicates a ` +
      `destructive or monetary effect. An undeclared action has not been risk-assessed, so it needs a human.`,
    risk: "HIGH",
    priority: 90,
  };
}

/**
 * Is ANY transaction ceiling configured that governs this verb for this agent?
 *
 * Asked of the *configuration*, not of the emitted verdicts, because the mandate
 * ceiling deliberately stays silent when an amount is within the limit — so
 * "no verdict" cannot be distinguished from "no ceiling exists" after the fact.
 *
 * A ceiling counts when either:
 *   - the agent's mandate sets `maxTransactionAmount` and the verb is financial; or
 *   - an applicable, enabled MAX_TRANSACTION_AMOUNT policy names the verb.
 *
 * A MAX_DAILY_SPEND policy deliberately does NOT count: it is evaluated against
 * the `cost` field, so it would happily approve an action declaring `cost: 0.01`
 * and `amount: 1_000_000_000` and leave the transaction amount unexamined.
 */
function hasTransactionCeiling(
  policies: PolicyRule[],
  agent: EvaluationAgent,
  normalizedAction: string,
): boolean {
  const mandate = agent.mandate;
  if (
    mandate &&
    mandate.maxTransactionAmount !== null &&
    SPENDING_ACTIONS.includes(normalizedAction)
  ) {
    return true;
  }

  for (const policy of policies) {
    if (!appliesTo(policy, agent)) continue;
    if (policy.type !== "MAX_TRANSACTION_AMOUNT") continue;
    if (policy.condition.kind !== "amountAtMost") continue;
    if (matchesAny(normalizedAction, policy.condition.actions)) return true;
  }

  return false;
}

/**
 * Synthetic verdict for money moving with no ceiling behind it.
 *
 * This closes the last of the four drifting lists. Even after the action catalog
 * unified the permission barrier, the mandate ceiling and the domain allowlist, a
 * gap remained: each MAX_TRANSACTION_AMOUNT *policy* carries its own
 * `condition.actions` list, and the shipped `pol_purchase_limit` names only
 * `purchase`, `payment` and `checkout`. So `agt_data` — which legitimately holds
 * `execute:payments` and has no mandate ceiling — could obtain a plain ALLOW for a
 * €999,999,999 `refund`: the permission barrier passed, and no ceiling of any kind
 * was ever evaluated against the amount.
 *
 * Rather than force every policy's action list to enumerate every financial verb
 * (which would just recreate the drift), the engine now asserts the invariant
 * directly: a financial verb with no governing ceiling is ungoverned money
 * movement, and ungoverned money movement needs a human. Configure a mandate
 * ceiling or a MAX_TRANSACTION_AMOUNT policy covering the verb and the action
 * flows autonomously again.
 */
function ungovernedMoneyVerdict(action: string): PolicyVerdict {
  return {
    policyId: "sys_ungoverned_money_movement",
    policyName: "Ungoverned money movement",
    decision: "APPROVAL_REQUIRED",
    reason:
      `"${action}" moves money but no spending ceiling governs it for this agent: neither the agent's ` +
      `mandate nor any enabled MAX_TRANSACTION_AMOUNT policy covers this action. An amount that was ` +
      `never checked against a limit cannot be released autonomously.`,
    risk: "HIGH",
    priority: 88,
  };
}

/**
 * True when an applicable policy names this exact verb as a LITERAL string.
 *
 * Phase 8 defect P8-3. `unknownDangerousVerdict` fires on any uncatalogued verb
 * whose name advertises a dangerous effect, and its stated justification is
 * that the action "has not been risk-assessed". `sys_undeclared_action` already
 * accepts an explicit policy as that assessment, and its own remedy text tells
 * the operator to `write a policy whose condition names it`. The heuristic did
 * not accept the same evidence — so an operator who followed Oathrion's printed
 * advice for `stripe.refund` got APPROVAL_REQUIRED forever, and the 500 EUR
 * threshold they had just written could never produce an ALLOW for any amount.
 * The escape hatch was unusable for precisely the verbs it matters most for.
 *
 * The premise is false once a human has written an enabled policy naming the
 * verb: that IS a risk assessment, made deliberately and recorded. So the
 * heuristic stands down.
 *
 * LITERAL, and not `hasExplicitActionPolicy`, is the whole safety of this.
 * `hasExplicitActionPolicy` honours wildcards, which is right for the posture:
 * `crm.*` is a human taking responsibility for a namespace. Honouring wildcards
 * HERE would be different in kind, because a single `actions: ["*"]` policy —
 * an entirely reasonable thing for an operator to write as an org-wide default
 * — would silently disarm the dangerous-name heuristic for every unknown verb
 * in the system at once. Requiring the exact verb means the off-switch cannot
 * be thrown by accident: an operator disarms `stripe.refund` only by typing
 * `stripe.refund`, one verb at a time, in a policy that then governs it.
 *
 * Disabled policies are excluded, because a rule that is not in force is not an
 * assessment — but that exclusion comes from `appliesTo`, which already refuses
 * a policy whose status is not `enabled`. A second status check here was
 * written first and then removed: it read like the enforcement point while
 * being unreachable, which is worse than no check at all, and a mutation test
 * confirmed it changed nothing.
 */
function namesActionLiterally(
  policies: PolicyRule[],
  agent: EvaluationAgent,
  normalizedAction: string,
): boolean {
  for (const policy of policies) {
    if (!appliesTo(policy, agent)) continue;
    const condition = policy.condition;
    if (condition.kind === "dailySpendAtMost") continue;
    const actions = condition.actions;
    if (!actions || actions.length === 0) continue;
    // Compared as plain strings on purpose: no pattern expansion, so `*` and
    // `stripe.*` do not match here even though they would elsewhere.
    if (actions.some((entry) => normalizeActionName(entry) === normalizedAction)) return true;
  }
  return false;
}

/**
 * Does an enabled, applicable policy EXPLICITLY name this verb?
 *
 * This is the escape hatch that keeps a fail-closed default from turning Oathrion
 * into a closed catalog. A verb Oathrion does not ship becomes governed — and so
 * stops being "undeclared" — the moment an operator writes a policy whose
 * condition lists it.
 *
 * "Explicitly" is doing real work here. A condition with no `actions` list means
 * "every action" (see `matchesAny`), and counting that as an explicit naming
 * would defeat the posture entirely: one org-wide amount ceiling would silently
 * re-authorise every unknown verb in the system. So an absent or empty list
 * does NOT count. A wildcard (`crm.*`) does — a human typed it, which is exactly
 * the act of taking responsibility we are looking for.
 *
 * `dailySpendAtMost` has no `actions` field at all and therefore can never
 * declare a verb; that is a property of the condition type, not an oversight.
 */
function hasExplicitActionPolicy(
  policies: PolicyRule[],
  agent: EvaluationAgent,
  normalizedAction: string,
): boolean {
  for (const policy of policies) {
    if (!appliesTo(policy, agent)) continue;
    const condition = policy.condition;
    if (condition.kind === "dailySpendAtMost") continue;
    const actions = condition.actions;
    if (!actions || actions.length === 0) continue;
    if (matchesAny(normalizedAction, actions)) return true;
  }
  return false;
}

/**
 * Synthetic verdict for a verb nobody declared, under a non-permissive posture.
 *
 * Priority 95 places it above `unknownDangerousVerdict` (90) and
 * `ungovernedMoneyVerdict` (88), so when several synthetic verdicts fire on the
 * same call the reason the caller reads is the most fundamental one: Oathrion has
 * never heard of this action at all.
 *
 * Emitted as an ordinary verdict rather than an early return so it composes
 * under the normal precedence rules and appears in `matched`, where the console
 * and the audit trail can show *why* the call was refused.
 */
function undeclaredActionVerdict(action: string, decision: "BLOCK" | "APPROVAL_REQUIRED"): PolicyVerdict {
  const remedy =
    `Declare it in shared/policy/actions.ts, or write a policy whose condition names it ` +
    `(for example actions: ["${action}"]), or set OATHRION_UNDECLARED_ACTION to "approval" or "allow".`;
  return {
    policyId: "sys_undeclared_action",
    policyName: "Undeclared action",
    decision,
    reason:
      `"${action}" is not a declared action and no policy names it, so nothing has ever ` +
      `assessed what it does. Oathrion does not authorise actions it has never heard of. ${remedy}`,
    risk: "HIGH",
    priority: 95,
  };
}

/**
 * Evaluate a single agent action against the supplied policy set.
 *
 * Guard rails applied before any policy runs:
 *  - a paused / draft agent is blocked outright;
 *  - the agent must hold the permission scope the action requires (a capability
 *    barrier, checked before the mandate or any policy — a granted permission
 *    does not by itself authorise anything; it only clears the way for
 *    mandate/policy to make the real decision, and a missing one blocks
 *    outright even if every policy would have said ALLOW);
 *  - the default posture when no policy expresses an opinion is ALLOW (permissive
 *    default, matching how teams onboard agents incrementally).
 */
export function evaluateAction(input: EvaluateActionInput): EvaluationResult {
  const now = input.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const metadata = input.metadata ?? {};

  if (input.agent.status !== "active") {
    return {
      decision: "BLOCK",
      reason: `Agent "${input.agent.name}" is ${input.agent.status} and cannot execute actions.`,
      policyId: null,
      policyName: null,
      riskLevel: "MEDIUM",
      matched: [],
      evaluatedAt,
    };
  }

  const requiredScope = requiredPermissionForAction(input.action);
  if (requiredScope && !input.agent.permissions.includes(requiredScope)) {
    return {
      decision: "BLOCK",
      reason: `Agent "${input.agent.name}" does not have the required permission: ${requiredScope}.`,
      policyId: null,
      policyName: null,
      riskLevel: "MEDIUM",
      matched: [],
      evaluatedAt,
    };
  }

  const ctx: EvaluationContext = {
    agent: input.agent,
    action: input.action,
    target: input.target,
    metadata,
    dailySpend: input.dailySpend ?? 0,
    orgCurrency: input.orgCurrency ?? DEFAULT_CURRENCY,
    now,
  };

  // The agent's own mandate is evaluated alongside the organisation policies
  // and competes under the same precedence rules.
  const verdicts: PolicyVerdict[] = evaluateMandate(input.agent.mandate, ctx);

  /*
   * Undeclared verbs. A catalogued verb is never subject to either rule below —
   * its descriptor is authoritative.
   *
   * Two independent mechanisms, kept separate on purpose:
   *
   *   1. The name heuristic (unchanged since before Phase 8) escalates a verb
   *      whose own spelling advertises a destructive or monetary effect. It
   *      still runs under EVERY posture, including `allow`, so relaxing the
   *      posture cannot silently disarm it. The one thing that stands it down
   *      is an enabled policy naming the verb LITERALLY, which is a human
   *      risk-assessing that specific verb — see `namesActionLiterally` for why
   *      a wildcard deliberately does not count there even though it counts for
   *      mechanism 2.
   *   2. The posture (Phase 8) refuses — or escalates — any undeclared verb that
   *      no policy names, whatever it is called. This is the rule that closes
   *      the `crm.update_record` hole the heuristic cannot see.
   *
   * Under `allow` the second mechanism is inert, which makes that posture behave
   * exactly as the engine did before Phase 8. That equivalence is asserted in
   * `undeclared-action-posture.test.ts`.
   */
  const normalizedAction = normalizeActionName(input.action);
  const descriptor = lookupAction(normalizedAction);
  if (descriptor === undefined) {
    if (
      isDangerousActionName(normalizedAction) &&
      !namesActionLiterally(input.policies, input.agent, normalizedAction)
    ) {
      verdicts.push(unknownDangerousVerdict(input.action));
    }
    const posture = input.undeclaredActionPosture ?? DEFAULT_UNDECLARED_ACTION_POSTURE;
    if (
      posture !== "allow" &&
      !hasExplicitActionPolicy(input.policies, input.agent, normalizedAction)
    ) {
      verdicts.push(
        undeclaredActionVerdict(input.action, posture === "block" ? "BLOCK" : "APPROVAL_REQUIRED"),
      );
    }
  }

  // Money never moves without a ceiling having been evaluated. See
  // `ungovernedMoneyVerdict` for why the permission barrier alone was not enough.
  if (descriptor?.financial && !hasTransactionCeiling(input.policies, input.agent, normalizedAction)) {
    verdicts.push(ungovernedMoneyVerdict(input.action));
  }

  for (const policy of input.policies) {
    if (!appliesTo(policy, input.agent)) continue;
    const evaluator = RULE_EVALUATORS[policy.type];
    if (!evaluator) continue;
    const result = evaluator(policy, ctx);
    if (result) verdicts.push(result);
  }

  if (verdicts.length === 0) {
    return {
      decision: "ALLOW",
      reason: "No policy constrains this action.",
      policyId: null,
      policyName: null,
      riskLevel: "LOW",
      matched: [],
      evaluatedAt,
    };
  }

  const winner = verdicts.reduce(strongest);

  return {
    decision: winner.decision,
    reason: winner.reason,
    policyId: winner.policyId,
    policyName: winner.policyName,
    riskLevel: winner.risk,
    matched: sortVerdicts(verdicts),
    evaluatedAt,
  };
}

/** Convenience predicate used by the API layer. */
export function requiresApproval(decision: Decision): boolean {
  return decision === "APPROVAL_REQUIRED";
}

export type { Decision, EvaluationResult, PolicyRule, EvaluationAgent };
