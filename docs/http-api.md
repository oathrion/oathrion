# HTTP API

The generic authorization surface. Everything else here — the SDKs, the CLI —
is a wrapper over it.

Base URL is wherever you run Oathrion. All bodies are JSON.

## POST /api/evaluate

The one endpoint that matters.

```bash
curl -X POST http://127.0.0.1:5000/api/evaluate \
  -H "Authorization: Bearer $OATHRION_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "agt_support_bot",
    "action": "stripe.refund",
    "target": "cus_12345",
    "input": { "amount": 75, "currency": "EUR", "category": "refunds" }
  }'
```

### Request

| Field | Required | |
| --- | --- | --- |
| `action` | yes | The verb. `stripe.refund`, `delete_customer`. |
| `target` | yes | What is being acted on. |
| `agentId` | see below | Who is asking. |
| `input` | no | Arguments the policy engine reads: `amount`, `currency`, `category`. |
| `context` | no | Free-form metadata for the audit trail. |
| `persist` | no | Default `false`. See below — this one matters. |

**`target` is required.** It is tempting to leave out when it feels obvious, and
an omitted target silently matches no `targetMatches` rule — so a policy scoped
to `prod-*` simply would not apply. A fail-open produced by an omission is the
worst kind, because nothing in the output looks wrong.

**`agentId`** identifies the caller. It may also arrive as the `X-ARIA-Agent-Id`
header or be bound to the API key. It must match the agent id grammar
(3-64 chars, `[a-zA-Z0-9._-]`); an id that cannot possibly exist is rejected
`400` before any lookup, and a well-formed but unknown id is `404`. Neither is a
decision. See [Agent identity](agents.md).

### `persist`: dry run by default

`persist: false` (the default) answers "what would you say if...". Nothing is
recorded, nothing is executed, and — the part that surprises people — **no
approval is filed**:

```json
{ "decision": "APPROVAL_REQUIRED", "approvalId": null, "persisted": false, "executionId": null }
```

There is nothing for a human to approve. An integration that waits for someone
to click will wait forever.

`persist: true` makes it real: the decision is recorded, an execution is
created, and an `APPROVAL_REQUIRED` files an actual approval.

```json
{ "decision": "APPROVAL_REQUIRED", "approvalId": "apr_...", "persisted": true,
  "executionId": "exe_...", "runState": "pending" }
```

Use dry runs to explore and to preview a policy change. Use `persist: true`
whenever a real action follows.

Note the two paths need different capabilities: `read` for a dry run, `execute`
to persist. See [Authentication](authentication.md).

### Response

| Field | |
| --- | --- |
| `decision` | `ALLOW` · `BLOCK` · `APPROVAL_REQUIRED`. |
| `reason` | Human-readable, safe to show a user. |
| `policyId`, `policyName` | The rule that decided it. |
| `risk` | `low` · `medium` · `high` · `critical`. |
| `requestId` | Quote this in a bug report. |
| `matched` | Every verdict that fired, with priorities. |
| `persisted` | Whether this was recorded. |
| `approvalId` | Set only when an approval was actually filed. |
| `executionId`, `runState` | The execution record, when persisted. |
| `executed`, `attempted`, `succeeded`, `toolId`, `toolResult` | Downstream tool call, if any. |

See [Decisions](decisions.md) for how the answer is reached.

### Status codes

| | |
| --- | --- |
| `200` | A decision. Read `decision` — it may well be `BLOCK`. |
| `400` | The request is malformed, or the agent id cannot possibly be valid. |
| `401` | No credential, or it was rejected. |
| `403` | Authenticated, but lacking the capability. |
| `404` | The agent is well-formed but unknown. |
| `429` | Rate limited. |
| `5xx` | Oathrion failed. |

**Only `200` carries a decision.** Nothing else is a `BLOCK`, and nothing else
is an `ALLOW`. A `401` means nobody decided anything, and code that treats a
non-200 as "denied" will one day treat a `500` as "allowed" by symmetry.

## Other endpoints

| | |
| --- | --- |
| `GET /api/health` | Liveness. Body carries `status`. |
| `POST /api/auth/login` | Console session token. |
| `GET/POST /api/agents`, `GET/PATCH /api/agents/:id` | [Agents](agents.md). |
| `GET/POST /api/policies` | [Policies](policies.md). `POST` needs a console session. |
| `GET /api/approvals`, `POST /api/approvals/:id/approve` | [Approvals](approvals.md). |
| `GET /api/audit` | `{ total, limit, offset, events }`. [Audit](audit.md). |
| `GET /api/executions`, `GET /api/executions/:id` | Execution records. |
| `POST /api/mcp` | The MCP gateway. [MCP](mcp.md). |
| `GET /api/tools` | Registered downstream tools. |
| `POST /api/keys` | Issue an API key. Console session only. |

There is deliberately **no `/authorize`**. `/api/evaluate` is the authorization
surface, and a second endpoint doing the same job differently is how two answers
to the same question come into existence.

## Errors

```json
{ "error": "...", "message": "...", "code": "bad_request", "requestId": "req_..." }
```
