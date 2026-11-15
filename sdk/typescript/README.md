# Oathrion TypeScript SDK

Ask Oathrion whether an action is allowed, before doing it.

```ts
import { OathrionClient } from "./sdk/typescript/src";

const placet = new OathrionClient({
  baseUrl: process.env.OATHRION_URL!,
  apiKey: process.env.OATHRION_API_KEY!,
  agentId: "agt_support_bot",
});

const decision = await placet.evaluate({
  action: "stripe.refund",
  target: "cus_12345",
  input: { amount: 75, currency: "EUR", category: "refunds" },
  persist: true,
});

if (decision.allowed) {
  await stripe.refunds.create({ charge: "ch_1", amount: 7500 });
}
```

Runnable version: [`examples/typescript/refund-flow.ts`](../../examples/typescript/refund-flow.ts).

## The three decisions

```ts
decision.allowed          // ALLOW only
decision.blocked          // BLOCK only
decision.pendingApproval  // APPROVAL_REQUIRED only
```

All three are derived **exhaustively** from the decision string, never as
negations of one another. `blocked = !allowed` would fold a hold into "blocked";
`allowed = !blocked` would fold it into "permitted". The second is dangerous, so
neither shape is used — and it is why `if (!decision.blocked)` is the wrong test
to write in your own code too.

`decision` also carries everything the API returned: `reason`, `policyId`,
`policyName`, `risk`, `requestId`, `approvalId`, `executionId`, `runState`,
`matched`. See [Decisions](../../docs/decisions.md).

## `requireAllow`

For call sites where continuing without permission is not meaningful:

```ts
await placet.requireAllow({ action: "stripe.refund", target: "cus_1", input: {...} });
await stripe.refunds.create(...);
```

Throws `OathrionNotAllowedError` on BLOCK **and** on APPROVAL_REQUIRED. Forgetting
to check becomes impossible rather than merely discouraged.

## Errors are not decisions

```ts
try {
  const d = await placet.evaluate({ ... });
} catch (err) {
  // No decision was made. The action must NOT proceed.
}
```

| Error | Meaning |
| --- | --- |
| `OathrionConnectionError` | Oathrion unreachable. |
| `OathrionTimeoutError` | Oathrion did not answer in time. |
| `OathrionHttpError` | 4xx/5xx — credential rejected, bad request, server fault. |
| `OathrionProtocolError` | A response this build does not recognise as a decision. |
| `OathrionNotAllowedError` | `requireAllow` on a real BLOCK or hold. |

All extend `OathrionError`.

**None of these is a BLOCK, and none is an ALLOW.** Downtime is not permission.
The SDK never invents a decision when it cannot reach the server, and never
converts `APPROVAL_REQUIRED` into `ALLOW` locally — a second decision engine
would be a second answer to the same question, running on the least trustworthy
machine in the system.

`OathrionProtocolError` on an unrecognised decision string is the same reflex:
guessing is how protocol drift becomes an authorization bypass.

## Options

| | |
| --- | --- |
| `baseUrl` | Required. |
| `apiKey` | Required. Sent as `Authorization: Bearer`. |
| `agentId` | Default agent for calls that do not name one. |
| `timeoutMs` | Default 10 000. |
| `fetch` | Injected in tests. |

There is deliberately **no "no timeout" setting**. A request that hangs forever
is an agent that hangs forever, and the operator response to that is usually to
delete the authorization call.

`agentId` is a convenience. The server still decides which agent a credential
may act as, and a key bound to another agent is refused regardless of what you
set here. See [Agent identity](../../docs/agents.md).

## `AgentAction`

```ts
{ agentId?: string; action: string; target: string; input?: object;
  context?: object; persist?: boolean }
```

**`target` is required.** An omitted target silently matches no `targetMatches`
rule, so a policy scoped to `prod-*` simply would not apply — a fail-open
produced by an omission, where nothing in the output looks wrong.

**`persist` defaults to `false`**, matching the API. A dry run records nothing
and files **no approval**, so an `APPROVAL_REQUIRED` has nothing for a human to
act on. Pass `persist: true` when a real action follows.

## Health

```ts
const h = await placet.health();   // { ok, httpStatus, body }
```

`httpStatus` is the HTTP code; `body.status` is Oathrion's own report. They are
named apart on purpose — a single `status` field meaning two different things
across two SDKs was a real bug found in this phase.
