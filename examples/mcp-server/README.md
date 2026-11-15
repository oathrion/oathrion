# MCP tool server → the other half of the path

`mcp-client/` is the **inbound** half: an agent talks to Oathrion's gateway. This is the
**outbound** half: Oathrion talks to *your* tool server.

```
   mcp-client/                                        mcp-server/   ← you are here
   ┌──────────┐      ┌───────────────────────┐      ┌─────────────┐
   │  agent   │ ───► │ Oathrion — decide, record │ ───► │  your tool  │
   └──────────┘      └───────────────────────┘      └─────────────┘
       inbound                                           outbound
```

The file is a complete MCP tool server in one page of `node:http`, and it imports
**nothing** from Oathrion — not `server/`, not `shared/`, not one constant. That is the
point, and it is not a stylistic one.

## Why an independent server had to exist

Every proof the repository had about the outbound path went through
`server/mcp-local/local-mcp-server.ts`, a fixture written by the same hand as the
gateway. A shared misreading of the protocol would have passed both sides at once:
two green tests, wrong together. The repository already makes this argument in the
other direction — `TestClient.baseUrl` exists so a third-party client can aim at the
real gateway — it had simply never been made in this direction.

`npm run verify:mcp` boots the shipped bundle (`dist/index.cjs`, `NODE_ENV=production`,
PostgreSQL) with `OATHRION_LOCAL_MCP_URL` pointed at this server, and proves against it:

| | |
| --- | --- |
| ALLOW | the tool is reached **exactly once** |
| BLOCK | the tool is never reached, and no grant is issued |
| APPROVAL_REQUIRED | nothing leaves before a human approves; then once, not twice |
| replay | a consumed grant is refused, and no second request is sent |
| provider refusal | receipt `outcome: "failed"`, grant spent, **no silent retry** |
| headers | the protocol revision and idempotency key, as this server observed them |

## Running it by hand

```bash
npx tsx examples/mcp-server/server.ts 7801
```

then, on the Oathrion side:

```
OATHRION_LOCAL_MCP_URL=http://127.0.0.1:7801/
OATHRION_LOCAL_MCP_ORGANIZATIONS=<your tenant's opaque id>
```

`OATHRION_LOCAL_MCP_ORGANIZATIONS` is mandatory in production. Without it the fixture
would be registered for every tenant with nobody having said so — which is the
defect it was added to close.

## The three things the file demonstrates

**1. The protocol minimum.** `initialize`, `tools/list`, `tools/call`. A useful MCP
server does not have to be larger than that. Oathrion announces revision `2026-07-28` in
`MCP-Protocol-Version`, and this server *refuses* anything else rather than tolerating
it: a permissive server lets a client speaking another revision through, and the
disagreement then surfaces much later, on a field.

**2. Idempotency is yours, not Oathrion's.** Oathrion guarantees a grant is consumed exactly
once — proved, including under multi-process concurrency. It cannot guarantee that an
effect at *your* provider happens once: if your server succeeds and the response is
lost on the wire, Oathrion records a failure where you have already charged the card.
[`docs/COMMERCIAL_READINESS.md`](../../docs/COMMERCIAL_READINESS.md) says so in as many
words — *provider-side deduplication: NOT DONE in Oathrion*. The deduplication key arrives in the
`X-Oathrion-Execution-Id` header, and also in the JSON-RPC `id` as `placet-<executionId>`.
Storing it is your job, and this file shows the shape.

In production that store is not a `Map`. It is a table with a uniqueness constraint on
the key, written **in the same transaction as the effect**. An in-memory map loses its
memory on restart, which is precisely the moment deduplication matters.

**3. How to refuse.** A business refusal is `isError: true` *inside* the result, not a
transport error. Oathrion then writes a receipt with `outcome: "failed"`, consumes the
grant, and does **not** retry on its own — a second attempt is a second authorization.
A transport-level error, by contrast, is reported as an execution failure and never as
a quiet success.

## Two counters, and why

`executedCount()` counts **effects**; `receivedCount()` counts **requests**, replays
included. The second exists because the first cannot see a double dispatch: this
server is idempotent, so a gateway that sent the same action twice would have its
second request deduplicated and leave the effect count at 1. That was not a
hypothetical — mutating the enforcement point to dispatch twice left the verification
fully green until `receivedCount()` was added. An "exactly once" proof has to count
requests, not only effects.
