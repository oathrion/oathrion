# Troubleshooting

## "I'm getting BLOCK and I didn't write a policy that blocks it"

Read `matched` in the response. It lists every verdict that fired, and the one
that decided is usually not the one you were thinking about.

Then work down this list — in practice it is almost always the first two.

### 1. The action is not declared

```
"decision": "BLOCK", "policyId": "sys_undeclared_action"
```

Oathrion has never heard of this verb, and unknown means blocked. Write an enabled
policy naming it in `condition.actions`. See [Policies](policies.md).

### 2. The mandate restricts categories and you sent none

```
"policyId": "mnd_agt_support_bot_category_missing"
```

Add `input.category`, matching one of the agent's `allowedCategories`. Fail-
closed by design: [Agent identity](agents.md#allowedcategories-is-fail-closed).

### 3. The name looks dangerous

```
"policyId": "sys_unknown_dangerous_action"
```

An uncatalogued verb whose name advertises destruction (`delete`, `drop`,
`wipe`). A wildcard policy does not clear this — the action must be named
**literally**. See the [wildcard asymmetry](security-model.md#the-wildcard-asymmetry).

### 4. Money with no ceiling

```
"policyId": "sys_ungoverned_money_movement"
```

A financial verb with no spending limit governing it. Add a
`MAX_TRANSACTION_AMOUNT` policy.

### 5. The agent is not active

`status` must be `active`. `paused`, `draft` and `review` do not act.

## "My APPROVAL_REQUIRED never reaches anyone"

`approvalId` is `null`, isn't it. The call was a **dry run** — `/api/evaluate`
defaults to `persist: false`, records nothing and files no approval. Send
`"persist": true`.

## "The audit trail is empty"

Same cause. Dry runs record nothing. Also: the response key is **`events`**, not
`items`.

## "404 on the agent"

The id is well-formed but not registered. A fresh server has no agents — seeding
is opt-in via `OATHRION_SEED=config`. Create it: [Agent identity](agents.md).

A `400` instead means the id could not possibly be valid (3-64 chars,
`[a-zA-Z0-9._-]`).

## "400 creating an agent"

`risk` must be **lowercase**: `"high"`, not `"HIGH"`. That is the usual one.

Otherwise, all of `id, name, description, provider, model, status, owner,
mandate, permissions, policyIds, tags` are required.

## "403 creating a policy"

Policies need a **console session token**, not an API key. Log in at
`POST /api/auth/login`. See [Authentication](authentication.md).

Also note a dry-run evaluate needs `read` while `persist: true` needs `execute`.

## "409 approving"

The approval window closed. Nothing was released; raise a fresh request. Not
`403` — nothing about you was wrong, you were late. See [Approvals](approvals.md).

## "ALLOW, but nothing happened" — `runState: "skipped"`

Oathrion authorized the action and did not call anything, because no tool is
registered for that verb. `GET /api/tools` lists every registered tool with the
verbs it serves; a verb absent from all of them is one nothing is wired to.
Declare your own with `OATHRION_TOOLS` — see
[Declaring your own tools](mcp.md#declaring-your-own-tools) — or see
[Known limitations](limitations.md).

## "My declared tool says `simulated: true`"

`simulated` answers one question: would a call right now stay inside Oathrion? For
a declared tool it is `true` exactly when its `destination` is not in the
destination registry. The boot check names this before it can happen — a
declaration whose destination is unregistered stops the deploy with the list of
destinations that *are* registered — so reaching this state usually means
`OATHRION_DESTINATIONS` changed under a running process.

## "My declared tool returned `unprojectable_arguments`"

A declared argument had no value in that call. The declaration says, for example,
`"reference": "metadata.reference"`, and the agent sent no `reference`. Oathrion
refuses the dispatch rather than sending the instruction without the field: see
[Known limitations](limitations.md#execution) for why omitting it would be worse.
Either have the caller send the field, or stop declaring it.

## "It says executed, but it didn't work"

`executed` means **attempted**. Check `succeeded`. An approval that released an
action into a tool that then failed shows `succeeded: false`, deliberately.

## "The SDK threw instead of returning BLOCK"

Then there was no decision. `OathrionConnectionError` and `OathrionTimeoutError` mean
Oathrion was unreachable, `OathrionHttpError` means the credential or request was
rejected, `OathrionProtocolError` means the response was not a decision this build
understands. None of them is a BLOCK, and none is an ALLOW. Your action must not
proceed. See [Decisions](decisions.md).

`OathrionNotAllowedError` is different — that is `requireAllow` doing its job on a
real BLOCK or hold.

## CLI exit codes

`0` ALLOW · `1` BLOCK · `2` APPROVAL_REQUIRED · `3` usage · `4` unreachable ·
`5` HTTP · `6` protocol.

Only `0` is permission. `oathrion evaluate ... && do_thing` is therefore safe.
See the [CLI](../cli/README.md).

## Server will not start

Config is validated at boot and Oathrion refuses to run misconfigured rather than
running degraded. Read the error — it names the variable. `OATHRION_SESSION_SECRET`
is required; generate with `openssl rand -hex 32`.

Also: exporting `DATABASE_URL` points Oathrion at PostgreSQL, whose repositories are
not ported in this build. See [Known limitations](limitations.md).

## Still stuck

Quote the `requestId` from the response. It appears in the logs and the audit
trail, and it is the fastest way to find the exact decision.
