# Oathrion CLI

**Runtime authorization for AI agents, from a shell.** AI can act. You decide
what it can do.

```bash
npm run cli -- evaluate --action stripe.refund --target customer_123 \
  --amount 75 --currency EUR
```

Set `OATHRION_URL`, `OATHRION_API_KEY` and optionally `OATHRION_AGENT_ID` first. `oathrion
config` prints what it resolved, with the credential masked.

## Exit codes are the whole point

| Code | Meaning | |
| ---- | ------- | - |
| `0` | `ALLOW` | permitted. **The only zero.** |
| `1` | `BLOCK` | policy refused it. |
| `2` | `APPROVAL_REQUIRED` | a human must decide. **Not permission.** |
| `3` | usage | bad flags or missing configuration. Nothing was asked. |
| `4` | unreachable | Oathrion could not be reached. **Nothing decided anything.** |
| `5` | http | Oathrion answered, but not with a decision (401/403/400/5xx). |
| `6` | protocol | the answer could not be read as a decision. |

This is the shape the tool exists for:

```bash
oathrion evaluate --action stripe.refund --target cus_1 --amount 75 --currency EUR \
  && ./issue-refund.sh
```

The shell runs `issue-refund.sh` if and only if `oathrion` exits 0. A block, a hold,
an expired credential or a network timeout all stop the chain. That is why
`APPROVAL_REQUIRED` is non-zero: exiting 0 for a held action would make every
approval gate in every shell script decorative.

Failures are non-zero **and distinct from decisions**. A timeout is not a
`BLOCK` — nothing decided anything — so it gets its own code, and the message
says so, because "policy refused this" and "I could not ask" are entirely
different incidents.

Verified in a real shell against a real server:

```
health                                        EXIT=0
refund 75 EUR                                 EXIT=0   ALLOW
refund 750 EUR                                EXIT=2   APPROVAL_REQUIRED
delete_customer                               EXIT=1   BLOCK
custom.company.operation                      EXIT=1   BLOCK (undeclared)
bad credential                                EXIT=5
unreachable server                            EXIT=4
missing --target                              EXIT=3
```

## Dry run by default

Without `--persist`, `evaluate` records nothing and reports what Oathrion *would*
decide. So a dry-run `APPROVAL_REQUIRED` files **no approval** — nobody can
approve it and nothing is waiting in a queue. The CLI says so explicitly rather
than letting you wait for something that was never filed:

```
APPROVAL_REQUIRED  amount over the limit
approval    not filed: this was a dry run. Re-run with --persist if a human is meant to see it.
```

Pass `--persist` when the action is real.

## What it is not

A thin wrapper over the TypeScript SDK, which is a thin wrapper over
`POST /api/evaluate`. No rule evaluation, no cache, no local allow-list, no
default decision. The decision comes from the server or the command fails.

There is no `oathrion protect`. It was specified only if a matching server route
existed, and none does — a command whose behaviour lived entirely in the client
would be the second decision engine this project must not grow.

## Credentials

Prefer `OATHRION_API_KEY`. `--api-key` works, but a key on the command line is
written to your shell history file and is visible in the process list to anyone
else on the machine.

## Tests

```bash
npm test -- cli
```

33 tests, nearly all asserting exit codes, including: unknown flags refused
rather than ignored, malformed `--input`, missing `--target`, absent
configuration, invalid and forbidden credentials, a rejected payload, a 500, an
unreachable server, a timeout, an HTML page from a proxy, a 200 that is not a
decision, an undeclared verb, and `oathrion` with no arguments at all (exit 3 — help
that exited 0 would look like an ALLOW to any script testing its status).
