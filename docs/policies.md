# Policies

The rules. Created by humans with a console session — never by an agent's API
key, because the thing being governed does not get to edit its own limits.

## Anatomy

```bash
curl -X POST $OATHRION_URL/api/policies -H "Authorization: Bearer $CONSOLE_TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "id": "pol_refund_ceiling",
    "name": "Refund ceiling",
    "description": "Refunds up to 500 EUR run autonomously. Above that, a human decides.",
    "type": "MAX_TRANSACTION_AMOUNT",
    "condition": {
      "kind": "amountAtMost", "field": "amount",
      "max": 500, "currency": "EUR", "actions": ["stripe.refund"]
    },
    "scope": "organization",
    "appliesTo": "All agents",
    "effect": "require_approval",
    "status": "enabled",
    "action": "APPROVAL_REQUIRED",
    "risk": "high",
    "priority": 80,
    "rule": "amount <= 500 EUR for stripe.refund"
  }'
```

| | |
| --- | --- |
| `type` | `MAX_TRANSACTION_AMOUNT`, `MAX_DAILY_SPEND`, `REQUIRE_HUMAN_APPROVAL`, `BLOCK_TOOL`, `ALLOW_TOOL`. |
| `condition.kind` | `amountAtMost`, `dailySpendAtMost`, `targetMatches`. Each `type` implies one. |
| `effect` | `block`, `require_approval`, `warn`. |
| `action` | The decision to return: `ALLOW`, `BLOCK`, `APPROVAL_REQUIRED`. |
| `status` | `enabled` or disabled. A disabled policy declares nothing. |
| `priority` | Higher decides ties. Synthetic rules sit at 86-95. |
| `risk` | `low`, `medium`, `high`, `critical`. Lowercase. |

The `type` and the `condition.kind` must agree — a `MAX_TRANSACTION_AMOUNT`
with a `targetMatches` condition is rejected with the expected shape in the
error.

## Policies declare actions

This is the part worth internalising.

`stripe.refund` is not in Oathrion's built-in catalogue. An action nobody has
declared is **blocked**. Writing a policy that names `stripe.refund` in
`condition.actions` does two things at once: it makes the verb *known*, and it
*governs* it.

So a policy is not only a restriction. Often it is the thing that makes an
action possible at all — which is the opposite of how allowlists usually feel,
and it is why the [quickstart](quickstart.md) creates one before its first
call.

### Wildcards make an action known, but not safe

`condition.actions: ["stripe.*"]` is enough to make `stripe.refund` declared.

It is **not** enough to stand down `sys_unknown_dangerous_action` for a verb
whose name advertises destruction. That still requires the action named
**literally**. A wildcard shows someone thought about the Stripe integration; it
does not show anyone considered `stripe.wipe_all_customers`. See the
[security model](security-model.md#the-wildcard-asymmetry).

## Precedence

Every applicable policy votes. The strictest verdict wins:

```
BLOCK  >  APPROVAL_REQUIRED  >  ALLOW
```

Ties break by `priority`, higher first. One BLOCK is enough — a refusal is not
outvoted by any number of allows. The agent's [mandate](agents.md) votes too,
and so do Oathrion's [synthetic rules](decisions.md#synthetic-verdicts).

`matched` in the response lists every verdict that fired, which is how you find
out your ALLOW was overruled by something at priority 86.

## Testing a change safely

Dry-run evaluate (`persist: false`, the default) tells you what a policy set
*would* say, recording nothing:

```bash
curl -X POST $OATHRION_URL/api/evaluate -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agt_support_bot","action":"stripe.refund","target":"cus_1",
       "input":{"amount":499,"currency":"EUR","category":"refunds"}}'
```

Probe the boundary from both sides — 499 and 501 — rather than trusting that a
ceiling behaves as intended in the direction you did not test.

## Listing

```bash
curl -sf $OATHRION_URL/api/policies -H "Authorization: Bearer $KEY"
```

Policies are scoped to an organisation. A credential from one tenant cannot read
or be governed by another's.
