/**
 * One evaluator per policy type.
 *
 * Every evaluator is a pure function `(policy, context) => PolicyVerdict | null`.
 * Returning `null` means "this policy has no opinion about this action".
 */

import {
  addMoney,
  compareMoney,
  describeMoneyError,
  formatMoney,
  moneyFromDecimal as money,
  parseCurrency,
  type MoneyError,
} from "../money";
import {
  matchesAny,
  matchesExplicit,
  matchesTargetForDeny,
  readCurrency,
  readNumber,
} from "./matchers";
import type {
  CurrencyCode,
  EvaluationContext,
  PolicyRule,
  PolicyType,
  PolicyVerdict,
} from "./types";

type RuleEvaluator = (policy: PolicyRule, ctx: EvaluationContext) => PolicyVerdict | null;

function verdict(
  policy: PolicyRule,
  decision: PolicyVerdict["decision"],
  reason: string,
  risk = policy.risk,
): PolicyVerdict {
  return {
    policyId: policy.id,
    policyName: policy.name,
    decision,
    reason,
    risk: decision === "ALLOW" ? "LOW" : risk,
    priority: policy.priority,
  };
}

/**
 * The currency a monetary policy is denominated in.
 *
 * The unit of account belongs to the TENANT (`ctx.orgCurrency`), not to the deployment —
 * one Oathrion instance serves a franc CFA tenant and a euro tenant, so this cannot be read
 * from a module constant. A policy that omits the field inherits its organization's
 * currency; a policy that declares a *different* one is a misconfiguration, not a
 * feature — the engine cannot convert, so it returns `null` and the caller refuses the
 * action rather than comparing incomparable numbers.
 */
function policyCurrency(declared: string | undefined, orgCurrency: CurrencyCode): CurrencyCode | null {
  if (!declared) return orgCurrency;
  return parseCurrency(declared) === orgCurrency ? orgCurrency : null;
}

/**
 * Refuses an action whose declared currency cannot be compared with the
 * policy's. Returns a verdict when the action must be refused, `null` when the
 * comparison is safe to make.
 */
function currencyMismatch(
  policy: PolicyRule,
  ctx: EvaluationContext,
  expected: CurrencyCode | null,
): PolicyVerdict | null {
  if (expected === null) {
    return verdict(
      policy,
      "BLOCK",
      `"${policy.name}" is written in a currency other than the organisation's ` +
        `(${ctx.orgCurrency}) and cannot be evaluated. Oathrion holds no exchange rate: ` +
        `rewrite the policy in ${ctx.orgCurrency}.`,
      "HIGH",
    );
  }
  const declared = readCurrency(ctx.metadata);
  if (declared === "INVALID" || (declared !== null && declared !== expected)) {
    return verdict(
      policy,
      "BLOCK",
      `This action is denominated in ${String(ctx.metadata.currency)} but "${policy.name}" is set in ${expected}. Amounts in different currencies are not comparable.`,
      "HIGH",
    );
  }
  return null;
}

/**
 * Transaction ceiling. Under (or equal to) the limit is explicitly allowed.
 *
 * Fail-closed: when the policy governs this action but the action does not
 * carry the field the ceiling is written against, the ceiling cannot be
 * applied — so the action is refused rather than waved through by the engine's
 * permissive default.
 */
const maxTransactionAmount: RuleEvaluator = (policy, ctx) => {
  if (policy.condition.kind !== "amountAtMost") return null;
  const { field = "amount", max, actions, currency } = policy.condition;
  if (!matchesAny(ctx.action, actions)) return null;

  const expected = policyCurrency(currency, ctx.orgCurrency);
  const mismatch = currencyMismatch(policy, ctx, expected);
  if (mismatch) return mismatch;
  const unit = expected as CurrencyCode;

  const ceiling = money(max, unit);
  if (!ceiling.ok) {
    // The POLICY is unusable, not the action: a ceiling of 1000,5 XOF cannot be enforced
    // because it is not an amount. Refusing is the only honest answer — rounding it would
    // decide for the operator which side of the limit an action falls on.
    return verdict(
      policy,
      "BLOCK",
      `The ceiling of "${policy.name}" (${max} ${unit}) is not a valid amount: ` +
        `${describeMoneyError(ceiling.error)}`,
      "HIGH",
    );
  }

  const declared = readNumber(ctx.metadata, field);
  if (declared === null) {
    return verdict(
      policy,
      "BLOCK",
      `"${policy.name}" caps this action at ${formatMoney(ceiling.money)}, but the action declares no numeric "${field}" and cannot be checked.`,
      "HIGH",
    );
  }

  const amount = money(declared, unit);
  if (!amount.ok) {
    return verdict(
      policy,
      "BLOCK",
      `The declared amount (${declared} ${unit}) cannot be compared with the ceiling of ` +
        `"${policy.name}": ${describeMoneyError(amount.error)}`,
      "HIGH",
    );
  }

  /*
   * Compared in minor units, as integers. `amount <= max` on floats refused an action at
   * exactly its ceiling whenever the two values had no exact binary representation —
   * 0.1 + 0.2 > 0.3 is true in IEEE 754 — and a spending limit is the one number in this
   * system that must not be approximately right.
   */
  if (compareMoney(amount.money, ceiling.money) <= 0) {
    return verdict(
      policy,
      "ALLOW",
      `${formatMoney(amount.money)} is within the ${formatMoney(ceiling.money)} limit set by "${policy.name}".`,
    );
  }
  return verdict(
    policy,
    policy.action,
    `${formatMoney(amount.money)} exceeds the ${formatMoney(ceiling.money)} limit set by "${policy.name}".`,
  );
};

/** Explicit human-in-the-loop gate on a set of actions / targets. */
const requireHumanApproval: RuleEvaluator = (policy, ctx) => {
  if (policy.condition.kind !== "targetMatches") return null;
  const { targets, actions, exceptTargets } = policy.condition;
  if (!matchesAny(ctx.action, actions)) return null;
  if (!matchesTargetForDeny(ctx.target, targets)) return null;
  if (exceptTargets && matchesExplicit(ctx.target, exceptTargets)) return null;

  return verdict(
    policy,
    "APPROVAL_REQUIRED",
    `"${policy.name}" requires human approval before ${ctx.action} on ${ctx.target}.`,
  );
};

/** Hard deny-list on a tool / resource. */
const blockTool: RuleEvaluator = (policy, ctx) => {
  if (policy.condition.kind !== "targetMatches") return null;
  const { targets, actions, exceptTargets } = policy.condition;
  if (!matchesAny(ctx.action, actions)) return null;
  if (!matchesTargetForDeny(ctx.target, targets)) return null;
  if (exceptTargets && matchesExplicit(ctx.target, exceptTargets)) return null;

  return verdict(policy, "BLOCK", `"${policy.name}" denies access to ${ctx.target}.`);
};

/** Explicit allow-list. Never overrides a BLOCK — precedence is resolved by the engine. */
const allowTool: RuleEvaluator = (policy, ctx) => {
  if (policy.condition.kind !== "targetMatches") return null;
  const { targets, actions } = policy.condition;
  if (!matchesAny(ctx.action, actions)) return null;
  if (!matchesExplicit(ctx.target, targets)) return null;

  return verdict(policy, "ALLOW", `"${policy.name}" explicitly allows ${ctx.target}.`);
};

/**
 * Rolling daily budget. The action's own cost counts towards the budget.
 *
 * An action that declares no cost genuinely consumes no budget, so it keeps no
 * opinion here — unlike the transaction ceiling, where the amount is the whole
 * point of the rule.
 */
const maxDailySpend: RuleEvaluator = (policy, ctx) => {
  if (policy.condition.kind !== "dailySpendAtMost") return null;
  const { max, field = "cost", currency } = policy.condition;

  const expected = policyCurrency(currency, ctx.orgCurrency);
  const mismatch = currencyMismatch(policy, ctx, expected);
  if (mismatch) return mismatch;
  const unit = expected as CurrencyCode;

  const budget = money(max, unit);
  if (!budget.ok) {
    return verdict(
      policy,
      "BLOCK",
      `The budget of "${policy.name}" (${max} ${unit}) is not a valid amount: ` +
        `${describeMoneyError(budget.error)}`,
      "HIGH",
    );
  }

  const declared = readNumber(ctx.metadata, field);
  if (declared === null) return null;

  const cost = money(declared, unit);
  const spent = money(ctx.dailySpend, unit);
  if (!cost.ok || !spent.ok) {
    const error = !cost.ok ? cost.error : (spent as { ok: false; error: MoneyError }).error;
    return verdict(
      policy,
      "BLOCK",
      `The daily total of "${policy.name}" cannot be computed: ${describeMoneyError(error)}`,
      "HIGH",
    );
  }

  /*
   * Summed in minor units. The float version accumulated error across a day's worth of
   * additions, so a budget could be exceeded or spuriously enforced by a fraction of a
   * centime that no operator could see or explain.
   */
  const projected = addMoney(spent.money, cost.money);
  if (compareMoney(projected, budget.money) <= 0) {
    return verdict(
      policy,
      "ALLOW",
      `Projected daily spend ${formatMoney(projected)} is within the ${formatMoney(budget.money)} budget.`,
    );
  }
  return verdict(
    policy,
    policy.action,
    `Projected daily spend ${formatMoney(projected)} exceeds the ${formatMoney(budget.money)} daily budget set by "${policy.name}".`,
  );
};

export const RULE_EVALUATORS: Record<PolicyType, RuleEvaluator> = {
  MAX_TRANSACTION_AMOUNT: maxTransactionAmount,
  REQUIRE_HUMAN_APPROVAL: requireHumanApproval,
  BLOCK_TOOL: blockTool,
  ALLOW_TOOL: allowTool,
  MAX_DAILY_SPEND: maxDailySpend,
};
