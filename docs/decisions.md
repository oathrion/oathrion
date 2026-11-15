# Decisions

Three answers. Not two.

| Decision | Meaning | Your code should |
| --- | --- | --- |
| `ALLOW` | Permitted. | Do the thing. |
| `BLOCK` | Policy refused it. | Do not do the thing. |
| `APPROVAL_REQUIRED` | A human has not answered yet. | Do not do the thing *yet*. |

## APPROVAL_REQUIRED is not permission

This is the mistake worth designing against. It usually arrives as:

```ts
if (!decision.blocked) { await refund(); }   // WRONG
```

which runs the refund on a hold. Write the positive test instead:

```ts
if (decision.allowed) { await refund(); }    // right
```

Every SDK here derives the three flags **exhaustively** from the decision string
rather than as negations of one another:

```ts
allowed         = decision === "ALLOW"
blocked         = decision === "BLOCK"
pendingApproval = decision === "APPROVAL_REQUIRED"
```

`blocked = !allowed` would have folded a hold into "blocked", and
`allowed = !blocked` would have folded it into "permitted". One of those is
merely wrong and the other is dangerous, so neither form is used.

The CLI encodes the same rule as exit codes: `0` for ALLOW and nothing else,
`2` for a hold. See the [CLI](../cli/README.md).

## The two other things that are not ALLOW

**Unreachable is not allowed.** If Oathrion cannot be reached, no SDK here invents a
decision — the call raises. An SDK that answered on the server's behalf would be
a second decision engine, and the one running on the least trustworthy machine.

**Unknown is not allowed.** A `200` whose `decision` is `"PERMIT"`, `"allow"` or
`null` is not a decision this build understands. The SDKs raise a protocol error
rather than guess, and the CLI exits `6`. Guessing is how protocol drift becomes
an authorization bypass.

## How a decision is reached

Every applicable rule is evaluated and each produces a verdict. The strictest
wins:

```
BLOCK  >  APPROVAL_REQUIRED  >  ALLOW
```

Ties are broken by `priority` (higher first). One BLOCK is enough — a single
refusal is not outvoted by any number of allows.

The full list is returned in `matched`, which is how you find out that your
policy said ALLOW but something stricter overruled it:

```json
"matched": [
  { "policyId": "mnd_agt_support_bot_category_missing", "decision": "BLOCK", "priority": 86 },
  { "policyId": "pol_refund_ceiling", "decision": "ALLOW", "priority": 80 }
]
```

Sources of verdicts, in one place:

- **Organisation policies** you wrote. See [Policies](policies.md).
- **The agent's mandate** — its own envelope: spending ceiling, allowed and
  blocked categories, allowed domains. See [Agent identity](agents.md).
- **Synthetic verdicts** Oathrion raises itself, below.

## Synthetic verdicts

These are not policies you wrote. They fire when the *absence* of a rule would
otherwise mean "no opinion, therefore allowed".

| id | priority | Fires when |
| --- | --- | --- |
| `sys_undeclared_action` | 95 | The action is not in the catalogue and no enabled policy covers it. |
| `sys_unknown_dangerous_action` | 90 | An uncatalogued verb whose *name* advertises a dangerous effect (`delete`, `drop`, `wipe`...). |
| `sys_ungoverned_money_movement` | 88 | A financial verb with no spending ceiling governing it. |
| `mnd_<agent>_category_missing` | 86 | The mandate restricts categories and the request declared none. |

They are all fail-closed, and they are the reason a fresh Oathrion is useful before
you have written a single policy.

`sys_unknown_dangerous_action` stands down only for a verb named **literally**
in an enabled applicable policy — wildcards do not count. A policy covering
`stripe.*` is enough to make an action *declared*, but not enough to certify
that `stripe.wipe_all_customers` has been risk-assessed. That asymmetry is
deliberate.

## Reading a response

```json
{
  "decision": "APPROVAL_REQUIRED",
  "reason": "750 € exceeds the 500 € limit set by \"Refund ceiling\".",
  "policyId": "pol_refund_ceiling",
  "policyName": "Refund ceiling",
  "risk": "high",
  "requestId": "req_...",
  "persisted": true,
  "executionId": "exe_...",
  "approvalId": "apr_...",
  "runState": "pending",
  "matched": [ ... ]
}
```

`reason` is written to be shown to a human. `requestId` appears in the logs and
the audit trail — quote it in a bug report.

`approvalId` is `null` on a dry run. See [Approvals](approvals.md) and the
`persist` flag in the [HTTP API](http-api.md).
