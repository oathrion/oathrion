# Quickstart

From nothing to a governed refund. About five minutes.

```bash
bash examples/quickstart/quickstart.sh
```

That script is the source of truth for this page — it is run before release, and
if it fails, this page is wrong. What follows is the same journey with the
reasoning left in.

## 0. Start a server

```bash
export ADMIN_KEY="<a-long-random-key>"
export CONSOLE_PASSWORD="<a-password>"

NODE_ENV=development PORT=5000 OATHRION_DB=/tmp/placet.db \
OATHRION_SESSION_SECRET="$(openssl rand -hex 32)" \
OATHRION_API_KEYS="Admin:admin:$ADMIN_KEY" \
OATHRION_CONSOLE_USERS="admin@placet.local:admin:$CONSOLE_PASSWORD" \
  npx tsx server/index.ts
```

Generate the session secret, do not invent one: `openssl rand -hex 32`. The
same goes for the API key.

```bash
curl -sf http://127.0.0.1:5000/api/health
```

A fresh server is **empty**. There are no agents and no policies; seed data is
opt-in via `OATHRION_SEED=config`. That is deliberate, and it is why this quickstart
creates its own agent rather than assuming one.

## 1. Sign in to the console

Creating agents and policies is an administrative act, so it needs a signed-in
human rather than an agent's API key. An operator key can *ask* for a decision
but cannot rewrite the rules that produce it. See [Authentication](authentication.md).

```bash
TOKEN=$(curl -sf -X POST http://127.0.0.1:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@placet.local","password":"'"$CONSOLE_PASSWORD"'","organization":"org_default"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
```

## 2. Create an agent

Oathrion will not answer authorization questions about an agent it has never heard
of. An unknown `agentId` is a `404` — not a decision — because "I don't know who
that is" must never resolve to "allowed".

```bash
curl -X POST http://127.0.0.1:5000/api/agents \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "agt_support_bot",
    "name": "Support Bot",
    "description": "Handles customer refunds raised from the support inbox.",
    "provider": "openai",
    "model": "gpt-4o",
    "status": "active",
    "owner": "support@example.com",
    "mandate": {
      "maxTransactionAmount": 500,
      "currency": "EUR",
      "allowedCategories": ["refunds"],
      "blockedCategories": [],
      "allowedDomains": ["api.stripe.com"]
    },
    "permissions": [
      { "scope": "execute:payments", "label": "Issue refunds", "granted": true, "risk": "high" }
    ],
    "policyIds": [],
    "tags": ["support"]
  }'
```

The **mandate** is the agent's own envelope, independent of organisation
policies. Note `allowedCategories`: once a mandate restricts categories, a
request that declares none is **blocked**, because an action that cannot be
shown to be in scope is not autonomous work. This trips people up in step 4, so
it is worth remembering now.

## 3. Create a policy for `stripe.refund`

Do not skip this. It is the step most likely to be skipped and the one that
makes the rest work.

`stripe.refund` is **not** in Oathrion's built-in action catalogue. An action Oathrion
has never heard of is blocked by default — an agent inventing a new verb at
runtime is exactly the event you want stopped rather than waved through.

So this policy does two jobs: it makes `stripe.refund` a *known* action by naming
it literally, and it *governs* it.

```bash
curl -X POST http://127.0.0.1:5000/api/policies \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "pol_refund_ceiling",
    "name": "Refund ceiling",
    "description": "Refunds up to 500 EUR run autonomously. Above that, a human decides.",
    "type": "MAX_TRANSACTION_AMOUNT",
    "condition": {
      "kind": "amountAtMost", "field": "amount",
      "max": 500, "currency": "EUR",
      "actions": ["stripe.refund"]
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

Note the policy is created with the **console token**, not the API key.

## 4. Ask

```bash
curl -X POST http://127.0.0.1:5000/api/evaluate \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "agt_support_bot",
    "action": "stripe.refund",
    "target": "cus_12345",
    "input": { "amount": 75, "currency": "EUR", "category": "refunds" }
  }'
```

```json
{ "decision": "ALLOW", "reason": "75 € is within the 500 € limit set by \"Refund ceiling\".",
  "policyId": "pol_refund_ceiling", "requestId": "req_...", "persisted": false }
```

Change the amount to `750`:

```json
{ "decision": "APPROVAL_REQUIRED", "reason": "750 € exceeds the 500 € limit set by \"Refund ceiling\"." }
```

Ask about something nobody declared:

```json
{ "decision": "BLOCK", "reason": "\"stripe.transfer_balance\" is not a declared action..." }
```

**`category` is in every request above for a reason.** The agent's mandate
restricts it to `refunds`, and Oathrion fails closed: omit the field and you get a
`BLOCK` from `mnd_..._category_missing`, not an `ALLOW`. Omitting a field is not
a neutral act.

## 5. Make it real

Everything above was a **dry run**. `/api/evaluate` does not persist unless you
ask, so nothing was recorded and — importantly — the `APPROVAL_REQUIRED` filed
**no approval**. There is nothing for a human to click, and an integration that
waits for one will wait forever.

Add `"persist": true`:

```bash
  -d '{ "agentId": "agt_support_bot", "action": "stripe.refund", "target": "cus_12345",
        "input": { "amount": 750, "currency": "EUR", "category": "refunds" },
        "persist": true }'
```

Now the response carries an `approvalId` and an `executionId`, and the decision
is in the audit trail:

```bash
curl -sf http://127.0.0.1:5000/api/audit -H "Authorization: Bearer $ADMIN_KEY"
```

Use dry runs to explore and to preview policy changes. Use `persist: true`
whenever a real action is about to follow.

## What did not happen

If you ran the ALLOW with `persist: true`, the response said
`runState: "skipped"`. Oathrion authorised the refund and recorded that it did; it
did not call Stripe. No tool is registered for `stripe.refund` in this build —
see [Known limitations](limitations.md). The decision is the part Oathrion is
responsible for.

## Next

- Same journey in code: [TypeScript](../examples/typescript/refund-flow.ts) ·
  [Python](../examples/python/refund_flow.py) · [CLI](../cli/README.md)
- Put Oathrion in the path instead of asking politely: [MCP gateway](mcp.md)
- Getting a `BLOCK` you did not expect: [Troubleshooting](troubleshooting.md)
