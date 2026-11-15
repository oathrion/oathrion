# Agent identity

Before Oathrion can decide what an agent may do, it has to know which agent is
asking.

## Registering one

```bash
curl -X POST $OATHRION_URL/api/agents -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{
    "id": "agt_support_bot",
    "name": "Support Bot",
    "description": "Handles refunds raised from the support inbox.",
    "provider": "openai",
    "model": "gpt-4o",
    "status": "active",
    "owner": "support@example.com",
    "mandate": {
      "maxTransactionAmount": 500, "currency": "EUR",
      "allowedCategories": ["refunds"], "blockedCategories": [], "allowedDomains": []
    },
    "permissions": [
      { "scope": "execute:payments", "label": "Issue refunds", "granted": true, "risk": "high" }
    ],
    "policyIds": [], "tags": ["support"]
  }'
```

All of `id, name, description, provider, model, status, owner, mandate,
permissions, policyIds, tags` are required. `provider` is
`openai | anthropic | google | custom`. `status` is
`active | paused | draft | review`.

`risk` is **lowercase** (`"high"`, not `"HIGH"`). This is the single most common
`400` on this endpoint.

A fresh server has no agents. Seeding is opt-in via `OATHRION_SEED=config`.

## The mandate

The agent's own envelope, independent of any organisation policy. Both apply;
the stricter wins.

| | |
| --- | --- |
| `maxTransactionAmount` / `currency` | Spending ceiling. |
| `allowedCategories` | If non-empty, the action's category must be in it. |
| `blockedCategories` | Never, regardless of policy. |
| `allowedDomains` | Where the agent may reach. |

### allowedCategories is fail-closed

Once `allowedCategories` is set, a request that declares **no** category is
**blocked** — `mnd_<agent>_category_missing`, priority 86.

Not an oversight. An action that cannot be shown to fall inside the mandate has
not been shown to be inside it, and "the field was missing" is not evidence of
safety. Send `input.category`:

```json
"input": { "amount": 75, "currency": "EUR", "category": "refunds" }
```

## Permissions

```json
{ "scope": "execute:payments", "label": "Issue refunds", "granted": true, "risk": "high" }
```

Scopes: `execute:payments`, `read:crm`, `write:crm`, `read:email`, `send:email`,
`read:database`, `write:database`, `read:files`, `write:files`,
`call:external-api`.

## Saying who you are

Three ways, in order of strength:

1. **A bound API key.** Issued with `agentId`, the key *is* the agent. Naming a
   different one in the body or header is **refused**. Strongest, because
   nothing the caller sends can change it.
2. **`X-ARIA-Agent-Id`.** The header. Used by the MCP gateway.
3. **`agentId` in the body.** Convenient, and it is a claim by the caller.

Only (1) is trusted; (2) and (3) are compared against it, never accepted over
it. Requiring (1) deployment-wide is the default when `NODE_ENV=production`.
Outside production it is off, and `OATHRION_REQUIRE_AGENT_BINDING` overrides either
way (`true` / `false`, exact strings only). See
[Known limitations](limitations.md).

An id must be 3-64 chars of `[a-zA-Z0-9._-]`. Malformed is `400` before any
lookup; well-formed but unknown is `404`. Neither is a decision.

## Lifecycle

```bash
curl -X PATCH $OATHRION_URL/api/agents/agt_support_bot -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"status":"paused"}'
```

Pausing is the kill switch: it takes effect on the next decision, no redeploy.
`draft` and `review` are for agents not yet cleared to act.
