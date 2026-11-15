# MCP client → Oathrion gateway

The **MOTIF A** integration: Oathrion sits physically between the agent and the tool.

```
MCP Client  →  Oathrion MCP Gateway  →  Oathrion Authorization  →  Decision  →  Tool
```

The client never talks to the tool. It talks to Oathrion, and Oathrion decides whether the
call reaches anything. This is the stronger of Oathrion's two integration shapes: the
client cannot ignore a decision it never receives the means to act on, because the
connection it holds terminates at Oathrion.

Contrast **MOTIF B** (`examples/typescript`, `examples/python`, `examples/curl`),
where your code asks Oathrion and then acts on the answer itself. There Oathrion's guarantee
is that the decision is authoritative and audited — not that your process obeyed it.
Both are legitimate; they differ in what they can promise, and
[`docs/security-model.md`](../../docs/security-model.md) states the difference rather
than letting the stronger claim be assumed.

## Protocol version

Oathrion implements MCP revision **2026-07-28** and nothing older. The handshake,
`Mcp-Session-Id` and `notifications/initialized` were removed in that revision
(SEP-2575, SEP-2567), and the gateway does not carry the removed surface merely to
look compatible.

The official SDK still defaults to `'legacy'` negotiation, whose list tops out at
`2025-11-25`. A current client therefore has to pin:

```ts
new Client(info, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
```

Without the pin the transport fails during connect. That is the correct outcome —
a version mismatch is not something to paper over — but the error message does not
say "add a pin", so it is worth knowing in advance.

## Packages

Uses the **v2** line:

```
@modelcontextprotocol/client   ^2.0.0
```

Not `@modelcontextprotocol/sdk`, which is the v1 package.

## Running it

```bash
export OATHRION_URL=http://127.0.0.1:5000
export OATHRION_API_KEY=<an operator key>
export OATHRION_AGENT_ID=agt_billing

npx tsx examples/mcp-client/run.ts
```

It walks the four scenarios and prints what Oathrion decided and whether the tool ran.
Nothing in the script is simulated; every decision comes from the server.

## What to expect

| Scenario | Decision | Tool invoked |
|---|---|---|
| `refund` 75 EUR | ALLOW | yes |
| `refund` 750 EUR | APPROVAL_REQUIRED | no |
| `delete_customer` | BLOCK | no |
| an unlisted tool | protocol error | no |

The last row is worth reading twice. Over MCP, a tool the gateway does not list is
refused at the **protocol layer** — the SDK raises rather than handing you a result
that says BLOCK. That is a deliberate layer difference from the HTTP API, where the
same undeclared action comes back as a normal `BLOCK` decision you can inspect.

Both are fail-closed and neither reaches the tool. But if you are writing code that
handles both surfaces, you need a `try/catch` on the MCP path and a decision check on
the HTTP path. Expecting a `BLOCK` payload from MCP and finding an exception instead
is the mistake this table exists to prevent.
