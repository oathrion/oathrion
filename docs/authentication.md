# Authentication

Two kinds of caller, because they are not the same thing.

**API keys** are for agents and machines. They ask for decisions.
**Console sessions** are for humans. They change the rules.

An agent's key can ask Oathrion a thousand questions and cannot raise its own
spending limit by one euro.

```
Authorization: Bearer <api-key-or-session-token>
```

## API keys

Configured at boot:

```bash
OATHRION_API_KEYS="Support Bot:operator:<key-one>,Auditor:viewer:<key-two>"
```

Format is `name:role:secret`, comma-separated. Or issued at runtime with a
console session:

```bash
curl -X POST $OATHRION_URL/api/keys -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Support Bot","role":"operator","expiresInDays":90,"agentId":"agt_support_bot"}'
```

Only the hash is stored. The secret is shown once.

### Binding a key to an agent

`agentId` is optional, and that is the design decision. A key issued with one is
**confined** to that agent: every request acts as that agent, and naming a
different one in the body or in `X-ARIA-Agent-Id` is **refused**, not silently
honoured. A stolen bound key cannot be pointed at a more privileged agent.

It is **required by default in production** (`NODE_ENV=production`): an unbound
machine credential is refused outright rather than allowed to name an agent.
Outside production it is not required, because a key is also how an operator
drives the API by hand and that has no single agent to pin to.

`OATHRION_REQUIRE_AGENT_BINDING` overrides the default in either direction, and only
the exact strings `true` and `false` are recognised — a mistyped opt-out leaves
production closed. Whichever posture is active is printed at boot:

```
[oathrion] agent binding: REQUIRED (production default). Unbound machine credentials
       cannot act as any agent. Set OATHRION_REQUIRE_AGENT_BINDING=false to relax
       this during a migration.
```

See [Known limitations](limitations.md).

## Console sessions

```bash
curl -X POST $OATHRION_URL/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@placet.local","password":"...","organization":"org_default"}'
```

Returns `{ "token": "..." }`, used as a bearer token. Bootstrap users come from
`OATHRION_CONSOLE_USERS="email:role:password"`; passwords are stored as
`scrypt$N$r$p$salt$hash` and the environment stops overriding the hash once a
user sets their own.

Creating policies requires a console session, not an API key.

## Roles and capabilities

Four roles, four capabilities:

| Role | read | execute | approve | manage |
| --- | :-: | :-: | :-: | :-: |
| `viewer` | ● | | | |
| `operator` | ● | ● | | |
| `approver` | ● | | ● | |
| `admin` | ● | ● | ● | ● |

- **read** — see agents, policies, executions, approvals, the audit trail.
- **execute** — ask Oathrion to run an action. The right to *ask*, never to bypass:
  the action may still be blocked or held.
- **approve** — resolve a pending approval.
- **manage** — change the rules: agents, policies, keys, other people's sessions.

**Separation of duties is the point of the matrix.** An `operator` can trigger
actions but cannot approve its own held one; an `approver` can release actions
but cannot originate them. Only `admin` holds both, and an admin key is not what
you give an agent.

Note that a dry-run evaluate needs `read` while `persist: true` needs `execute`
— asking a hypothetical and committing a real action are different privileges.

## Organisations

Every credential belongs to one. Agents, policies, approvals and audit entries
are scoped to it, and a credential from one organisation cannot read or decide
about another's — the tenant id is even in the audit chain's genesis hash, so a
trail copied between tenants fails verification rather than transferring.

## Practical notes

- Keys are compared in constant time and never logged.
- Rate limits apply per credential; `429` is not a decision.
- Never put credentials in `input` or `context` — they are audit content.
- `.env` is not shipped in the checkpoint. `.env.example` is.
