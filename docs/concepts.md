# Core concepts

Five nouns.

## Agent

The identity doing the asking. Oathrion will not answer a question about an agent it
has never heard of — an unknown `agentId` is a `404`, not a decision, because
"I don't know who that is" must never resolve to "allowed".

An agent carries a **mandate** (its own envelope: spending ceiling, allowed and
blocked categories, allowed domains) and **permissions** (scopes it has been
granted). It also has a `status`: `active`, `paused`, `draft` or `review`. Only
an active agent acts.

→ [Agent identity](agents.md)

## Action

The verb. `stripe.refund`, `delete_customer`, `send_email`.

Actions Oathrion has never heard of are **blocked by default**. To make one known,
name it in a policy. This is the step new users skip, and it is the reason their
first call returns BLOCK.

## Target and input

`target` is what is being acted on — the customer, the record, the mailbox. It
is **required**, because an omitted target silently matches no `targetMatches`
rule, which is a fail-open produced by an omission.

`input` carries what policies read: `amount`, `currency`, `category`. Omitting
`category` when a mandate restricts categories is a BLOCK, not a shrug.

Together: `AgentAction { agentId, action, input, context? }`.

## Policy

A rule: a condition, an effect, a scope, a priority. Policies are how you say
"refunds up to 500 € run themselves, above that a human decides".

Policies are created by humans with a console session, never by an agent's API
key.

→ [Policies](policies.md)

## Decision

`ALLOW`, `BLOCK`, or `APPROVAL_REQUIRED`. Three, not two. The strictest verdict
among everything that matched wins, ties broken by priority.

→ [Decisions](decisions.md)

---

## How they fit together

```
   agent + action + target + input
                ↓
        POST /api/evaluate
                ↓
   ┌────────────────────────────┐
   │ organisation policies      │
   │ the agent's mandate        │  every applicable rule votes
   │ synthetic fail-closed rules│
   └────────────────────────────┘
                ↓
      strictest verdict wins
                ↓
   ALLOW · BLOCK · APPROVAL_REQUIRED
                ↓
      recorded (if persist: true)
```

There is **one** decision path — `evaluateAction()` in
`shared/policy/engine.ts`. The HTTP API, the SDKs, the CLI and the MCP gateway
are all surfaces over it. No SDK reimplements policy logic, and none converts an
`APPROVAL_REQUIRED` into an `ALLOW` locally. A second decision engine is a
second answer to the same question, and it always runs on the least trustworthy
machine.

## Dry run vs. real

`persist: false` (default) is a hypothetical: nothing recorded, no approval
filed. `persist: true` is real: recorded, execution created, approval actually
filed for a human.

→ [HTTP API](http-api.md#persist-dry-run-by-default)
