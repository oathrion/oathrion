# Approvals

`APPROVAL_REQUIRED` is the answer for actions that should happen, but not
unsupervised. A 750 € refund is not fraud; it is a decision above the agent's
pay grade.

## The lifecycle

```
evaluate (persist: true) → APPROVAL_REQUIRED → approval filed, action HELD
                                    ↓
                        human approves / rejects / lets it expire
                                    ↓
                     released to the tool  /  never runs  /  never runs
```

The action is **held**, not queued for retry and not run optimistically. Nothing
downstream sees it until a human answers.

## Filing one requires `persist: true`

A dry run returns `APPROVAL_REQUIRED` with `approvalId: null` and files nothing.
There is no record and nothing for anyone to click.

```json
{ "decision": "APPROVAL_REQUIRED", "approvalId": null, "persisted": false }
```

If your integration waits for a human, it will wait forever. Send
`"persist": true` when a real action is going to follow. See the
[HTTP API](http-api.md#persist-dry-run-by-default).

## Listing and resolving

```bash
curl -sf $OATHRION_URL/api/approvals -H "Authorization: Bearer $KEY"
curl -sf $OATHRION_URL/api/approvals/apr_123 -H "Authorization: Bearer $KEY"
```

```bash
curl -X POST $OATHRION_URL/api/approvals/apr_123/approve -H "Authorization: Bearer $KEY"
curl -X POST $OATHRION_URL/api/approvals/apr_123/reject  -H "Authorization: Bearer $KEY"
```

Both need the `approve` capability — held by the `approver` and `admin` roles
only. An `operator` can trigger actions but cannot release its own held ones,
which is the point of the split. See [Authentication](authentication.md).

**You cannot say who you are.** The approver's identity is taken from the
verified credential, and a body carrying `resolvedBy` is rejected `400` rather
than ignored. An audit trail that records a client-supplied name records
nothing.

## Reading the result

```json
{
  "approval": { "id": "apr_123", "status": "approved", "resolvedBy": "Ada", ... },
  "execution": { ... },
  "executed": true, "attempted": true, "succeeded": false,
  "runState": "failed", "toolId": "stripe", "toolResult": { ... }
}
```

`executed` means **attempted**, not **worked**. If the approval released the
action into a tool that then failed, `succeeded` is `false` — an approver who
sees a green tick for an action that did not happen has been misled by their own
audit trail.

Approving releases the held action to its tool **exactly once**. Rejecting never
reaches a tool.

## Expiry

Approvals have a deadline. Past it, they sweep to `expired`, and resolving one
returns **`409`** — not `200`:

```json
{ "error": "The approval window has closed. No action was released; a fresh request must be raised." }
```

`409` rather than `200`-with-a-flag, because a client that only checks the
status code would otherwise report "approved" for a request that never ran. And
not `403`: nothing about the caller was wrong — they hold the capability, they
were simply late.

Sweeping is also available on demand, with `manage`:

```bash
curl -X POST $OATHRION_URL/api/approvals/expire -H "Authorization: Bearer $ADMIN_KEY"
```

## In your code

Never convert a hold into a pass locally. An SDK that returned ALLOW for an
`APPROVAL_REQUIRED` — for latency, for convenience, because the approval "was
going to be approved anyway" — would be a second decision engine running on the
least trustworthy machine in the system.

```python
if decision.decision == "APPROVAL_REQUIRED":
    queue_for_human(decision.approval_id)   # hand it off
    return                                   # do NOT proceed
```

The CLI gives a hold its own exit code (`2`), distinct from both success and
block, so a shell script cannot fold it into either. See the
[CLI](../cli/README.md) and [Decisions](decisions.md).
