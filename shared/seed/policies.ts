import type { Policy } from "@shared/types";

/**
 * Default policy set shipped with every Oathrion organization.
 *
 * `rule` is the human-readable summary rendered in the UI; `type` + `condition` +
 * `action` form the executable definition consumed by the Policy Engine.
 *
 * `triggeredCount` is 0 on every entry here, and must stay that way.
 *
 * It previously shipped with hand-written values (14, 61, 27, 3, 2) which the
 * console rendered as "Triggered 14×" — indistinguishable, to anyone looking at
 * the screen, from a real measurement. Nothing had triggered anything: a freshly
 * seeded organisation has evaluated zero actions. The counter is incremented for
 * real by the repository, in the same transaction as the decision it belongs to
 * (`server/repositories/sqlite.ts`), so any number on this page is now something
 * the system actually did.
 *
 * The last two entries (`pol_pii`, `pol_offhours`) carry no `type`/`condition`
 * and are therefore NOT executable: the engine skips them because
 * `RULE_EVALUATORS` has nothing to run. They are display-only rows illustrating
 * the policy surface. Marked as such in their descriptions rather than left to
 * look enforced.
 */
export const policies: Policy[] = [
  {
    id: "pol_purchase_limit",
    name: "Maximum purchase amount",
    description:
      "Any purchase request above the threshold must be approved by a human operator before execution.",
    rule: "purchase.amount > $10,000 → require_approval",
    scope: "organization",
    appliesTo: "All agents",
    effect: "require_approval",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: "2026-08-04",
    type: "MAX_TRANSACTION_AMOUNT",
    condition: {
      kind: "amountAtMost",
      field: "amount",
      max: 10_000,
      currency: "EUR",
      actions: ["purchase", "payment", "checkout"],
    },
    action: "APPROVAL_REQUIRED",
    appliesToAgentIds: null,
    risk: "high",
    priority: 40,
  },
  {
    id: "pol_email_approval",
    name: "External email approval",
    description:
      "Outbound email to recipients outside the organization domain is held for review.",
    rule: "email.recipient.domain ∉ acme.com → require_approval",
    scope: "organization",
    appliesTo: "All agents with send:email",
    effect: "require_approval",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: "2026-08-01",
    type: "REQUIRE_HUMAN_APPROVAL",
    condition: {
      kind: "targetMatches",
      targets: ["external_email", "email:external*", "mail:external*"],
      actions: ["send_email", "email", "reply"],
    },
    action: "APPROVAL_REQUIRED",
    appliesToAgentIds: null,
    risk: "medium",
    priority: 30,
  },
  {
    id: "pol_db_prod",
    name: "Production database protection",
    description: "Any operation against a production database is denied for all agents.",
    rule: "target == production_database → block",
    scope: "organization",
    appliesTo: "All agents",
    effect: "block",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: "2026-07-22",
    type: "BLOCK_TOOL",
    condition: {
      kind: "targetMatches",
      targets: ["production_database", "postgres.prod*", "db:prod*", "*.prod.ledger"],
    },
    action: "BLOCK",
    appliesToAgentIds: null,
    risk: "critical",
    priority: 90,
  },
  {
    id: "pol_api_spend",
    name: "Maximum daily spend",
    description:
      "Agents are throttled once their rolling daily provider spend crosses the budget. Measured on the action's `cost`, not on a purchase's face value.",
    rule: "agent.daily_spend + action.cost > $500 → block",
    scope: "organization",
    appliesTo: "All agents",
    effect: "block",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: "2026-07-30",
    type: "MAX_DAILY_SPEND",
    condition: { kind: "dailySpendAtMost", field: "cost", max: 500, currency: "EUR" },
    action: "BLOCK",
    appliesToAgentIds: null,
    risk: "high",
    priority: 20,
  },
  {
    /*
     * The refund approval threshold.
     *
     * Added because nothing in the shipped policy set governed `refund` at all:
     * `pol_purchase_limit` names only `purchase`, `payment` and `checkout`, so a
     * refund was held — when it was held — either by the acting agent's own
     * mandate ceiling or by the engine's "ungoverned money movement" invariant.
     * Both are real protections, but neither is a rule an operator wrote, and
     * "which policy stopped this?" had no satisfying answer.
     *
     * Priority 60 sits deliberately above the mandate ceiling's fixed priority
     * of 50 (see `shared/policy/mandate.ts`). When both have an opinion the
     * decision is identical — APPROVAL_REQUIRED either way, because precedence
     * is resolved by decision weight first — but the *explanation* surfaced to
     * the operator becomes the named org policy rather than the per-agent
     * mandate. Every clause that fired is still listed in `matched`.
     */
    id: "pol_refund_approval",
    name: "Refund approval threshold",
    description:
      "A refund at or below the threshold is released autonomously. Above it, a human approver must release the funds before the refund reaches the payment provider.",
    rule: "refund.amount > €500 → require_approval",
    scope: "organization",
    appliesTo: "All agents",
    effect: "require_approval",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: "2026-09-02",
    type: "MAX_TRANSACTION_AMOUNT",
    condition: {
      kind: "amountAtMost",
      field: "amount",
      max: 500,
      currency: "EUR",
      actions: ["refund"],
    },
    action: "APPROVAL_REQUIRED",
    appliesToAgentIds: null,
    risk: "high",
    priority: 60,
  },
  {
    /*
     * Customer deletion is never autonomous.
     *
     * `targets: ["*"]` is intentional and is the whole rule: this is a denial of
     * the *verb*, not of a particular destination. Erasing a customer record is
     * irreversible and carries data-subject obligations, so there is no target
     * for which an agent should perform it.
     *
     * Before this policy, `delete_customer` was uncatalogued and the engine's
     * dangerous-name heuristic escalated it to APPROVAL_REQUIRED — which put an
     * irreversible deletion into a queue where a distracted approver could
     * release it. A named BLOCK is both stronger and legible: the console can now
     * answer "which rule stopped this?" with a row the operator can read.
     *
     * Priority 95 is above `pol_db_prod` (90). It does not change the outcome —
     * BLOCK already outranks every other decision by weight — but it keeps this
     * rule as the reported reason when several deny rules fire at once.
     */
    id: "pol_customer_deletion",
    name: "Customer deletion is never autonomous",
    description:
      "No agent may erase a customer record, on any target. Deletion is irreversible and carries data-subject obligations, so it is denied outright rather than queued for approval.",
    rule: "action ∈ {delete_customer, purge_customer} → block",
    scope: "organization",
    appliesTo: "All agents",
    effect: "block",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: "2026-09-02",
    type: "BLOCK_TOOL",
    condition: {
      kind: "targetMatches",
      // Any target: the verb itself is what is denied.
      targets: ["*"],
      actions: ["delete_customer", "purge_customer", "erase_customer"],
    },
    action: "BLOCK",
    appliesToAgentIds: null,
    risk: "critical",
    priority: 95,
  },
  {
    id: "pol_readonly_analytics",
    name: "Analytics read access",
    description:
      "Read-only analytics warehouses are explicitly allow-listed so reporting agents are never held for review.",
    rule: "target == analytics_warehouse AND op == read → allow",
    scope: "organization",
    appliesTo: "All agents",
    effect: "warn",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: "2026-08-06",
    type: "ALLOW_TOOL",
    condition: {
      kind: "targetMatches",
      targets: ["analytics_warehouse", "warehouse:read*"],
      actions: ["read", "query", "access"],
    },
    action: "ALLOW",
    appliesToAgentIds: null,
    risk: "low",
    priority: 10,
  },
  {
    id: "pol_pii",
    name: "Redact PII in external calls",
    description:
      "NOT ENFORCED — display-only. This row has no executable definition (no type/condition), so the policy engine never evaluates it. Personal data is not currently stripped from outbound payloads.",
    rule: "payload contains PII AND destination == external → warn",
    scope: "integration",
    appliesTo: "All external APIs",
    effect: "warn",
    status: "enabled",
    triggeredCount: 0,
    updatedAt: "2026-06-18",
  },
  {
    id: "pol_offhours",
    name: "Restrict off-hours execution",
    description:
      "NOT ENFORCED — display-only, and still in draft. This row has no executable definition (no type/condition), so the policy engine never evaluates it.",
    rule: "risk >= high AND hour ∉ 08:00–20:00 → require_approval",
    scope: "organization",
    appliesTo: "All agents",
    effect: "require_approval",
    status: "draft",
    triggeredCount: 0,
    updatedAt: "2026-08-07",
  },
];
