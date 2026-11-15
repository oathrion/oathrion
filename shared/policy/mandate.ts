/**
 * Agent mandates — the per-agent half of the control plane.
 *
 * A policy is an organisation-wide rule ("no agent may touch the production
 * database"). A mandate is what *this particular agent* was hired to do: how
 * much it may spend on its own, which categories of goods it may buy, which
 * suppliers it may reach. Both are evaluated by the same engine and compete
 * through the same precedence rules, so a mandate is simply a policy the agent
 * carries with it.
 *
 * Pure and synchronous, like the rest of `shared/policy`. No I/O, no framework.
 */

import {
  compareMoney,
  DEFAULT_CURRENCY,
  describeMoneyError,
  formatMoney,
  moneyFromDecimal as money,
  type MoneyError,
} from "../money";
import { OUTBOUND_ACTIONS, SPENDING_ACTIONS } from "./actions";
import {
  extractHost,
  formatAmount,
  matchesDomain,
  normalizeToken,
  readCurrency,
  readNumber,
} from "./matchers";
import type { CurrencyCode, EvaluationContext, PolicyVerdict } from "./types";

/** What an agent is allowed to do autonomously, before org policies apply. */
export interface AgentMandate {
  /** Spend above this needs a human. `null` = no autonomous ceiling of its own. */
  maxTransactionAmount: number | null;
  /** Currency the ceiling is denominated in. */
  currency: CurrencyCode;
  /** Empty = every category is in scope. */
  allowedCategories: string[];
  /** Always denied, even if listed as allowed. */
  blockedCategories: string[];
  /** Empty = every destination is in scope. Matched against the action target. */
  allowedDomains: string[];
}

export const EMPTY_MANDATE: AgentMandate = {
  maxTransactionAmount: null,
  currency: DEFAULT_CURRENCY,
  allowedCategories: [],
  blockedCategories: [],
  allowedDomains: [],
};

/*
 * `SPENDING_ACTIONS` and `OUTBOUND_ACTIONS` used to be hand-written arrays right
 * here. They are now derived from `shared/policy/actions.ts` and re-exported for
 * the callers that already import them from this module.
 *
 * The old arrays were the second and third of four independent lists describing
 * "which verbs are dangerous", and they disagreed with the first (the engine's
 * permission barrier): `payment`, `transfer` and `subscribe` were capped here but
 * required no permission there, while `refund`, `payout`, `withdraw`, `charge`
 * and `reimburse` appeared in none of them. See `actions.ts` for the full
 * rationale and the regression tests that keep them aligned.
 */
export { OUTBOUND_ACTIONS, SPENDING_ACTIONS };

function mandateVerdict(
  agentId: string,
  suffix: string,
  agentName: string,
  label: string,
  decision: PolicyVerdict["decision"],
  reason: string,
  risk: PolicyVerdict["risk"],
  priority: number,
): PolicyVerdict {
  return {
    policyId: `mnd_${agentId}_${suffix}`,
    policyName: `${agentName} · ${label}`,
    decision,
    reason,
    risk,
    priority,
  };
}

/**
 * Evaluate an agent's mandate against one action.
 * Returns every clause that had an opinion; the engine merges them with the
 * organisation policies and applies the usual BLOCK > APPROVAL > ALLOW ordering.
 */
export function evaluateMandate(
  mandate: AgentMandate | undefined,
  ctx: EvaluationContext,
): PolicyVerdict[] {
  if (!mandate) return [];

  const { agent, action, target, metadata } = ctx;
  const verdicts: PolicyVerdict[] = [];
  const category = typeof metadata.category === "string" ? metadata.category.trim() : null;
  const normalizedAction = normalizeToken(action);

  /* ---------------------------- Category scope ---------------------------- */

  /**
   * Fail-closed. When the mandate restricts categories, an action that does not
   * declare one cannot be shown to be in scope, so it is not autonomous work.
   * The previous behaviour — no category, no opinion, engine defaults to ALLOW —
   * let any caller step outside its mandate by omitting a field.
   */
  if (!category && mandate.allowedCategories.length > 0) {
    verdicts.push(
      mandateVerdict(
        agent.id,
        "category_missing",
        agent.name,
        "Allowed categories",
        "BLOCK",
        `${agent.name} is restricted to specific categories and this action declares none, so it cannot be verified.`,
        "HIGH",
        86,
      ),
    );
  }

  if (category) {
    const token = normalizeToken(category);
    const blocked = mandate.blockedCategories.some((c) => normalizeToken(c) === token);

    if (blocked) {
      verdicts.push(
        mandateVerdict(
          agent.id,
          "category",
          agent.name,
          "Blocked categories",
          "BLOCK",
          `"${category}" is a blocked category for ${agent.name}.`,
          "CRITICAL",
          95,
        ),
      );
    } else if (
      mandate.allowedCategories.length > 0 &&
      !mandate.allowedCategories.some((c) => normalizeToken(c) === token)
    ) {
      verdicts.push(
        mandateVerdict(
          agent.id,
          "category",
          agent.name,
          "Allowed categories",
          "BLOCK",
          `"${category}" is outside ${agent.name}'s allowed categories.`,
          "HIGH",
          85,
        ),
      );
    }
  }

  /* ----------------------------- Domain scope ----------------------------- */

  /**
   * The allowlist is applied to the *parsed host*, not to the raw target string.
   * `https://evil.com/checkout`, `evil.com.` and `user@evil.com:443` all resolve
   * to `evil.com`. A target that carries no readable host while the mandate
   * restricts destinations is refused: unverifiable is not permitted.
   */
  if (mandate.allowedDomains.length > 0 && OUTBOUND_ACTIONS.includes(normalizedAction)) {
    const host = extractHost(target);

    if (host === null) {
      verdicts.push(
        mandateVerdict(
          agent.id,
          "domain_unparsable",
          agent.name,
          "Allowed domains",
          "BLOCK",
          `"${target}" does not resolve to a destination that can be checked against ${agent.name}'s approved domains.`,
          "HIGH",
          81,
        ),
      );
    } else if (!mandate.allowedDomains.some((d) => matchesDomain(host, d))) {
      verdicts.push(
        mandateVerdict(
          agent.id,
          "domain",
          agent.name,
          "Allowed domains",
          "BLOCK",
          `${host} is not an approved destination for ${agent.name}.`,
          "HIGH",
          80,
        ),
      );
    }
  }

  /* -------------------------- Autonomous spending ------------------------- */

  /**
   * Fail-closed on both the amount and its currency.
   *
   * A spending action that omits `amount` used to produce no verdict at all,
   * and the engine's permissive default then turned it into ALLOW: sending
   * `{ total: 999999 }` instead of `{ amount: 999999 }` walked straight past a
   * ceiling. A ceiling that can be skipped by renaming a field is not a ceiling.
   *
   * Likewise, an amount in another currency is not comparable to the ceiling.
   * The engine does not know exchange rates, so it refuses instead of guessing.
   */
  if (mandate.maxTransactionAmount !== null && SPENDING_ACTIONS.includes(normalizedAction)) {
    const amount = readNumber(metadata, "amount");
    const currency = readCurrency(metadata);

    if (currency === "INVALID" || (currency !== null && currency !== mandate.currency)) {
      verdicts.push(
        mandateVerdict(
          agent.id,
          "limit_currency",
          agent.name,
          "Autonomous spending limit",
          "BLOCK",
          `This action is denominated in ${String(metadata.currency)}, but ${agent.name}'s spending limit is set in ${mandate.currency}. Amounts in different currencies are not comparable.`,
          "HIGH",
          52,
        ),
      );
    } else if (amount === null) {
      verdicts.push(
        mandateVerdict(
          agent.id,
          "limit_missing",
          agent.name,
          "Autonomous spending limit",
          "BLOCK",
          `A ${normalizedAction} must declare a numeric "amount" so it can be checked against ${agent.name}'s spending limit of ${formatAmount(mandate.maxTransactionAmount, mandate.currency)}.`,
          "HIGH",
          51,
        ),
      );
    } else {
      /*
       * Compared in minor units, as integers — the same rule the policy evaluators in
       * `rules.ts` follow, and for the same reason: `amount > max` on floats is not an
       * answer about money.
       *
       * It also closes a gap the engine-level tests could not see and
       * `script/e2e-currency.ts` did: an amount that is NOT representable in the
       * currency — 1000,5 XOF, where the franc has no subdivision — used to pass this
       * check silently whenever it happened to fall below the ceiling. The comparison
       * said "below the limit" and was arithmetically right about a quantity that is not
       * a sum of money. Precision is validated here, so a fractional franc is refused
       * whichever side of the ceiling it lands on.
       */
      const declared = money(amount, mandate.currency);
      const ceiling = money(mandate.maxTransactionAmount, mandate.currency);

      if (!declared.ok || !ceiling.ok) {
        const error = !declared.ok ? declared.error : (ceiling as { ok: false; error: MoneyError }).error;
        verdicts.push(
          mandateVerdict(
            agent.id,
            "limit_amount",
            agent.name,
            "Autonomous spending limit",
            "BLOCK",
            `The amount cannot be compared with ${agent.name}'s ceiling: ${describeMoneyError(error)}`,
            "HIGH",
            52,
          ),
        );
      } else if (compareMoney(declared.money, ceiling.money) > 0) {
        verdicts.push(
          mandateVerdict(
            agent.id,
            "limit",
            agent.name,
            "Autonomous spending limit",
            "APPROVAL_REQUIRED",
            `${formatMoney(declared.money)} ${normalizedAction} exceeds ${agent.name}'s autonomous spending limit of ${formatMoney(ceiling.money)}.`,
            "MEDIUM",
            50,
          ),
        );
      }
    }
  }

  return verdicts;
}
