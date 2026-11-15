# Oathrion Python SDK

**Runtime authorization for AI agents.** AI can act. You decide what it can do.

`CHANGE THE ENDPOINT, NOT YOUR AGENT.`

## Install

```bash
pip install -e sdk/python
```

No runtime dependencies — the client uses `urllib` from the standard library
rather than `requests`. An authorization client is the last place you want a
dependency tree, and this way `pip install` cannot fail on a machine that is
about to start making security decisions. Python 3.9+.

## Use

```python
import os
from oathrion import OathrionClient

client = OathrionClient(
    base_url=os.environ["OATHRION_URL"],
    api_key=os.environ["OATHRION_API_KEY"],
    agent_id="support-agent",
)

decision = client.evaluate(
    action="stripe.refund",
    target="customer_123",
    input={"amount": 75, "currency": "EUR"},
)

if decision.allowed:
    stripe.Refund.create(charge="ch_123", amount=7500)
elif decision.pending_approval:
    print(f"A human must approve this: {decision.reason}")
else:
    print(f"Blocked: {decision.reason}")
```

If you would rather not be able to forget the check, `require_allow` raises
unless the answer is ALLOW:

```python
from oathrion import OathrionNotAllowedError

try:
    client.require_allow(action="stripe.refund", target="customer_123",
                         input={"amount": 75, "currency": "EUR"})
    stripe.Refund.create(...)
except OathrionNotAllowedError as exc:
    print(exc.decision.decision, exc.decision.reason)
```

## Three decisions, and only three

| `decision`          | `allowed` | `blocked` | `pending_approval` | What it means |
| ------------------- | --------- | --------- | ------------------ | ------------- |
| `ALLOW`             | `True`    | `False`   | `False`            | Go ahead. |
| `BLOCK`             | `False`   | `True`    | `False`            | Policy forbids it. |
| `APPROVAL_REQUIRED` | `False`   | `False`   | `True`             | A human must decide. **Not a yes.** |

`APPROVAL_REQUIRED` is not permission. `allowed` is true only for `ALLOW`, and
`require_allow` raises on a hold exactly as it raises on a block.

## If you are building an approval flow, read this

`evaluate()` defaults to `persist=False`, which is a **dry run**: Oathrion tells you
what it *would* decide and records nothing.

So a dry run returning `APPROVAL_REQUIRED` files **no approval record**. Nothing
reaches a review queue, and there is nothing for a human to approve. Code that
reads that decision, tells the user "waiting for approval" and waits will wait
forever. `decision.approval_id` is `None` on a dry run, and that is the signal.

```python
# Exploring the rules — records nothing, files nothing.
preview = client.evaluate(action="stripe.refund", target="c1",
                          input={"amount": 750, "currency": "EUR"})
assert preview.approval_id is None

# A real action — recorded, and a human can act on it.
real = client.evaluate(action="stripe.refund", target="c1",
                       input={"amount": 750, "currency": "EUR"}, persist=True)
print(real.approval_id)  # apr_… — this one is in the queue
```

Use the default to explore. Use `persist=True` for anything a human is expected
to answer.

## A failure is never a decision

Every failure is an exception, and none of them carries a `decision`. There are
exactly two outcomes: a decision Oathrion made, or a raise.

| Exception             | When |
| --------------------- | ---- |
| `OathrionConnectionError` | No response at all — DNS, refused, TLS. |
| `OathrionTimeoutError`    | No answer within the timeout. |
| `OathrionHttpError`       | Oathrion answered, not with a decision. `.status`, `.code`, `.request_id`, `.is_auth_failure`, `.is_request_invalid`. |
| `OathrionProtocolError`   | A 200 this SDK cannot read as a decision. |
| `OathrionNotAllowedError` | From `require_allow`, when the answer was not ALLOW. |

A timeout means Oathrion did not answer. It does not mean yes, and it does not mean
no. The SDK will not invent either, because a client that can synthesise a
decision is one edit away from synthesising `ALLOW` "so the agent keeps working
during an outage".

The SDK also has no cache. A cached yes is a decision taken under conditions
that may have moved — daily spend advances, policies get edited, agents get
paused, mandates expire.

## Unknown actions

`OATHRION_UNDECLARED_ACTION` defaults to `block`. A verb no policy declares is
refused, and that judgement is made **by the server** — this SDK contains no
rule evaluation, no allow-list and no notion of which verbs exist.

To govern a verb Oathrion has never heard of, declare it: write a policy whose
`condition.actions` names it literally. See `docs/policies.md`.

## What this SDK guarantees, and what it does not

It is a typed HTTP client for `POST /api/evaluate`. It is not a second policy
engine, and it must never become one.

When you ask Oathrion over HTTP and then act on the answer yourself, **Oathrion cannot
physically stop your process from ignoring the answer.** What it guarantees is
that the decision is authoritative, attributable and recorded: a BLOCK you chose
to override is a BLOCK in the audit log.

For Oathrion to sit *physically* between the agent and the tool, use the MCP
gateway, where a blocked call never reaches the tool at all. Both guarantees are
stated side by side in `docs/security-model.md` rather than letting the stronger
one be assumed.

## Tests

Standard library `unittest` — pytest is not required.

```bash
python3 -m unittest discover -s sdk/python -v
```

The unit tests use hostile fixtures (a proxy returning HTML, a 200 with no
decision, a body claiming `allowed: true` beside `decision: "BLOCK"`), because a
suite built only from well-formed responses would pass against a client that
fails open on every one of them. The integration tests boot a real Oathrion server
and run the same scenarios as the TypeScript SDK; they **skip with a reason** if
Node is unavailable rather than substituting a mock and reporting a pass.
