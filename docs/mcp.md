# MCP authorization gateway

**MOTIF A.** The strong one.

Your agent's MCP client points at Oathrion instead of at your tool server. Oathrion is
**in the path**: it authorizes each `tools/call`, forwards the ones that pass,
and refuses the ones that do not. An action Oathrion blocks cannot happen, because
the call never reaches the tool.

**CHANGE THE ENDPOINT, NOT YOUR AGENT.** This is a configuration change. Your
agent's code, prompts and tool definitions do not change.

```
agent ──MCP──▶ Oathrion ──MCP──▶ your tools
                 │
            decide · record
```

Contrast with [MOTIF B](README.md#motif-b--ask-before-you-act), where your code
asks Oathrion and then acts on the answer. MOTIF B is flexible and works anywhere;
MOTIF A is the one where ignoring the decision is not an option available to the
client.

## Endpoint

```
POST /api/mcp
Authorization: Bearer <api-key>
X-ARIA-Agent-Id: agt_support_bot
```

Protocol version **`2026-07-28`** — and, for clients that still open with the
`initialize` handshake, a **compatibility mode** for `2025-06-18` and `2025-03-26`.

Methods: `server/discover`, `tools/list`, `tools/call` (2026-07-28); `initialize`,
`ping`, `tools/list`, `tools/call` (compatibility mode). Anything else is `-32601` with
HTTP `404` — an unimplemented method is not quietly tolerated. `GET /api/mcp` answers
`405`: no server-initiated stream is offered.

The mode is chosen per request: `MCP-Protocol-Version: 2026-07-28` (with the `_meta`
fields) is the strict mode; a `2025-*` header, or no header and no 2026 `_meta`, is the
compatibility mode. Both run `tools/list` and `tools/call` through the same code and the
same gateway; where a compatibility client sends `Mcp-Method` or `Mcp-Name`, they must
still match the body.

**Real clients.** Verified on 2026-10-19 with **Cursor** (`cursor-agent` 2026.08.11):
before the compatibility mode it could not connect (400 on `initialize`, then 404 on its
SSE fallback); after it, `mcp list` reports *ready*, `mcp list-tools` lists exactly the
tools of the connected services, and an agent run produced one ALLOW, one BLOCK and one
APPROVAL_REQUIRED, matching Oathrion's own records. **Claude Desktop has not been tested.**

## Connecting with the official SDK

The client must **pin** the protocol version. See
[`examples/mcp-client/`](../examples/mcp-client/) for the runnable version.

```ts
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client/streamableHttp";

const client = new Client(
  { name: "my-agent", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

await client.connect(
  new StreamableHTTPClientTransport(new URL("/api/mcp", OATHRION_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${process.env.OATHRION_API_KEY}`,
        "X-ARIA-Agent-Id": "agt_support_bot",
      },
    },
  }),
);

const tools = await client.listTools();
const result = await client.callTool({ name: "stripe.refund", arguments: { amount: 75 } });
```

Verified against `@modelcontextprotocol/client` and `/core` v2.0.0.

## What a refusal looks like

A blocked or held call comes back as a tool **result** carrying the decision and
its reason, not as a silent success and not as a transport error. The agent can
read why it was refused and say so, which is usually what you want it to do.

Held calls are `APPROVAL_REQUIRED`: the tool is not invoked, and a human decides.
See [Approvals](approvals.md).

Every call is subject to the same engine as `/api/evaluate` — same policies,
same mandate, same synthetic fail-closed rules. There is one decision path, not
one per surface.

## Limits

Downstream forwarding reaches a real MCP server, but only one an operator has
named. See [Downstream destinations](#downstream-destinations) below. Oathrion will
not forward to an arbitrary remote host.

The tools an agent can reach are: five built-in simulated tools
(`server/gateway/tool-registry.ts`); the connected [connectors](connectors.md) (GitHub,
Slack, Linear, Stripe); whatever an operator declares in `OATHRION_TOOLS` — see
[Declaring your own tools](#declaring-your-own-tools); and, in local mode, the tools of a
server wrapped by [`oathrion wrap`](wrap.md). A verb that no tool serves is authorized and
recorded with `runState: "skipped"` — Oathrion decided, and did not call anything.

Both are in [Known limitations](limitations.md).

## Downstream destinations

Oathrion dispatches an authorised action to a downstream MCP server only when both
gates below are satisfied. They are independent, and neither substitutes for the
other.

### 1. The destination must be named

```bash
export OATHRION_MCP_DOWNSTREAM_URL=https://mcp.example.com
export OATHRION_MCP_ALLOWED_DESTINATIONS=https://mcp.example.com,https://tools.example.org:8443
```

Comma-separated origins — scheme, host, optional port, no path. `*` is refused
explicitly. An empty or unset allowlist permits **nothing**, so forgetting to
configure it means Oathrion dispatches nowhere rather than anywhere.

Matching is on the whole origin, so `https://mcp.example.com.evil.net`,
`http://mcp.example.com` (different scheme) and `https://mcp.example.com:8443`
(different port) are all distinct destinations.

### 2. The destination must survive the address rules

Refused regardless of the allowlist:

| Refused | Examples |
| --- | --- |
| Loopback | `127.0.0.1`, `localhost`, `::1`, `::ffff:127.0.0.1` |
| Private ranges | `10/8`, `172.16/12`, `192.168/16`, `fc00::/7` |
| Link-local / cloud metadata | `169.254.169.254`, `metadata.google.internal`, `fe80::/10` |
| Reserved internal suffixes | `.internal`, `.local`, `.home.arpa`, `.localdomain` |
| Non-HTTP schemes | `gopher:`, `file:`, `ftp:`, `data:` |
| URLs with credentials | `https://user:pass@host` |
| Non-MCP service ports | 22, 25, 3306, 5432, 6379, 11211, 27017, … |

Being on the allowlist buys no exemption: an allowlist entry that is itself
unsafe is refused when the list is parsed, at boot.

The rules are the ones the webhook channel already uses
(`server/notifications/webhook-url.ts`), reused rather than reimplemented.

### 3. DNS rebinding is handled on the socket

Everything above inspects a string. A hostname that is public when it is
validated can resolve to `127.0.0.1` when the connection is opened, because the
socket performs its own, later lookup.

The dispatch therefore goes through the guarded transport
(`server/notifications/webhook-transport.ts`), which re-checks **every resolved
address at connect time**, does not follow redirects, and bounds the response
body. This is why the client does not use `fetch` — `fetch` exposes no `lookup`
hook and follows redirects by default.

### Timeouts

Every downstream call has a deadline. Default 30s, set with
`OATHRION_MCP_TIMEOUT_MS`. A value that is not a positive whole number is refused at
use rather than silently replaced by the default.

A timeout is an **execution** failure, never an authorization one: the decision
was made and recorded before the call. The audit trail keeps the two apart.

### The local fixture

`OATHRION_LOCAL_MCP_URL` is **loopback-only**. It is what `npm run mcp:local` and the
quickstart point at. Setting both it and `OATHRION_MCP_DOWNSTREAM_URL` is refused
rather than resolved by precedence — they are different things, and guessing
which one was meant is how actions end up somewhere the operator did not intend.

**In production it must declare its tenants.** The fixture used to register the
`local-fixture` destination with `organizations: "*"` — shared by every tenant —
without anybody declaring it, which is the Phase 13 D1 defect through a path the
D1 fix did not cover. Since chantier 1 the scope is explicit:

```bash
OATHRION_LOCAL_MCP_URL=http://127.0.0.1:7801/
OATHRION_LOCAL_MCP_ORGANIZATIONS=org_7f3k9x2qd7m1v8sb4tz0   # or several, comma-separated
```

Absent in production, the boot is refused with the reason named. `*` is accepted
there, but only written out: a destination shared by every tenant has to be a
decision somebody made, never one inherited by omission. Outside production the
variable is optional and the fixture stays shared, which is what development and
the quickstart expect.

### `OATHRION_MCP_DOWNSTREAM_URL` is refused in production

It is not a registry entry: it is the destination the gateway falls back to when a
call names none, so it belongs to the whole deployment and there is nowhere to give
it a tenant. On a shared instance, organization B's authorized action would be
dispatched to the single downstream service, which usually holds organization A's
credentials.

The scoped path already exists and is `OATHRION_DESTINATIONS`, where every entry names
its `organizations` and callers name the destination by id — an id a grant can be
bound to, which a fallback has not got. Outside production the variable is
unchanged.

## Declaring your own tools

Everything above is about *where* an authorized action may go. This section is
about *what* it is. `OATHRION_TOOLS` declares a tool by configuration, so a pilot
wires their own connector without modifying TypeScript:

```bash
export OATHRION_TOOLS='[{
  "id": "acme_refund",
  "label": "Acme refunds",
  "destination": "acme-erp",
  "tool": "refunds.create",
  "actions": ["refund"],
  "arguments": {
    "customer": "target",
    "amount":   "metadata.amount",
    "currency": "currency"
  }
}]'
```

* `destination` names an entry of the destination registry above. It is the same
  gate, with the same allowlist and the same address rules — a declaration opens
  no new outbound surface.
* `tool` is the name **the provider** gives its tool. It is deliberately separate
  from `actions`: `refund` is the verb Oathrion governs, `refunds.create` is what
  the provider answers to.
* `actions` are the verbs this tool serves. A declared tool that claims a verb
  already wired to a built-in **replaces** it — that is the point. A verb absent
  from `shared/policy/actions.ts` is refused at boot, exactly as for a built-in,
  because that entry is what makes the permission scope, the mandate ceiling and
  the domain allowlist apply.
* `arguments` maps a provider field onto a field Oathrion already holds. The
  sources are `target`, `currency`, `agentId`, `agentName`, `action`,
  `executionId`, and `metadata.<key>`. Nothing else is accepted, and an unknown
  source stops the deploy rather than sending an empty field — the one thing a
  generic connector must never do is invent the content of an instruction it
  signs.

`GET /api/tools` reports each tool with `simulated` and the verbs it serves, so
you can confirm a declaration took effect without making a call.

### What a misconfiguration does

Refused at boot, with the reason named: invalid JSON, a duplicate `id`, no
`actions`, an argument source that is not a context field, a `destination` that
is not registered (the message lists the ones that are), or a verb absent from
the action catalogue.

Refused at call time, with the reason named: a destination not visible to that
tenant, and a declared argument that has no value in this call
(`unprojectable_arguments`). Both produce a `failed` receipt and no dispatch —
never a silent success.

### Discovering what the server actually declares

Before writing a declaration, ask the server:

```bash
npm run mcp:discover -- --destination=acme-erp
npm run mcp:discover -- --destination=acme-erp --declare=refund
```

This sends a `tools/list` to a destination that is **already registered**, through the
same allowlist and the same address rules a real call goes through. It contacts nothing
that is not already declared — it is not a scanner. `--declare=<verb>` prints a
`OATHRION_TOOLS` entry to read and paste; the argument sources are *guessed* from the
names, so it prints rather than writes.

### The declaration is checked against that schema, at dispatch

A one-letter typo in `tool`, or a required argument the declaration forgets, used to
surface only on a client's first real call — and as a provider error, not as a
configuration fault. Oathrion now compares the declaration to the server's own
`tools/list` and refuses, naming the correction:

| Situation | Refusal |
|---|---|
| The declared tool name does not exist upstream | `tool_not_found_upstream`, listing the ones that do |
| A **required** argument is not projected | `missing_required_argument`, naming the field and a projection for it |
| A projected argument is not in the schema | `unknown_argument_upstream` — the server would ignore it silently, so you would believe you had sent it |
| The server has no `tools/list` | the dispatch happens and the receipt carries `schemaChecked: false` with the reason. Add `"requireSchema": true` to refuse instead |

The check costs one `tools/list` per destination per five minutes, not one per dispatch.
Only argument **names** are compared: Oathrion does not validate types, and a hand-written
subset of JSON Schema would refuse valid schemas while letting through what it does not
understand.

Why the check is not at boot: it needs the network, and a third-party service in
maintenance would then stop Oathrion from starting. An operator's natural response would
be to switch the check off — and a guard you have to bypass to work protects nobody.

### Proving it

```bash
npm run build
DATABASE_URL=postgres://… npm run verify:tools
```

A declared tool is pointed at `examples/mcp-server/`, which imports nothing from
this repository, and the run asserts that an ALLOW reaches it exactly once under
the provider's own tool name with exactly the declared arguments, that a BLOCK
never reaches it, that a held action reaches it only after a human approves, and
that a declared argument with no value stops the dispatch instead of sending a
half-filled instruction. A third boot carries a deliberately wrong tool name and asserts
that the policy still says ALLOW while **zero** requests reach the provider — the refusal
comes from the comparison with that server's `tools/list`.
