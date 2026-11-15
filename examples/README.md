# Examples

Every example here has been run against a real Oathrion server. If one stops
working, that is a bug, not a documentation nit.

Start the server and create what the examples expect:

```bash
bash examples/quickstart/quickstart.sh
```

That script is also the cURL example — it is the whole journey (create an agent,
create a policy, ask three questions, read the audit trail) written as plain
HTTP calls with nothing hidden.

| | |
| --- | --- |
| [`quickstart/`](quickstart/quickstart.sh) | cURL, end to end, from an empty database. |
| [`typescript/`](typescript/refund-flow.ts) | The TypeScript SDK. |
| [`python/`](python/refund_flow.py) | The Python SDK. Standard library only. |
| [`mcp-client/`](mcp-client/) | The official MCP SDK talking to Oathrion's gateway (inbound). |
| [`mcp-server/`](mcp-server/) | A tool server Oathrion dispatches to, importing nothing from Oathrion (outbound). |
| [`framework-adapter/`](framework-adapter/) | Put Oathrion in front of any tool, any framework — any of `execute`, `invoke`, `call`, `func`, `run`, `_run`, or a bare function. |
| [`../cli/`](../cli/README.md) | The shell. Exit codes are the contract. |
| [`mandate-bank/`](mandate-bank/README.md) | A bank that checks an agent's mandate itself, before paying, and countersigns: 3,200 EUR executed, a forged authorization and a revoked mandate refused by the bank. Runs in the test suite. |
| [`no-receipt-no-merge/`](no-receipt-no-merge/README.md) | A repository where a pull request an AI agent worked on carries its signed Oathrion receipt, and GitHub refuses to merge without it. Tried end to end on a local git repository; not yet on GitHub (it needs `0.1.0-preview.1` on npm). |

## Two ways to use Oathrion

**MOTIF A — the MCP gateway.** The agent's only route to its tools goes through
Oathrion. Oathrion is physically in the path, so an action it refuses cannot happen.
This is the strong guarantee. See [`mcp-client/`](mcp-client/).

**MOTIF B — ask before you act.** Your code calls `/api/evaluate`, directly or
through an SDK, and acts on the answer. This is the flexible one: it works with
any language, any framework, any transport, and it does not change how your
agent is built.

Be clear about MOTIF B's limit. Oathrion cannot physically stop a program that
decides to ignore the answer it was given. What it guarantees is that the
decision is authoritative, recorded and tamper-evident — that there is no
version of events in which the action was quietly authorized. If you need the
check to be unavoidable rather than authoritative, use MOTIF A.

## The one thing worth reading twice

There are three decisions, not two.

```
ALLOW              go ahead
BLOCK              policy says no
APPROVAL_REQUIRED  a human has not answered yet
```

`APPROVAL_REQUIRED` is not permission, and the most common integration bug is
code that treats it as one — usually by writing `if (!blocked)`. Every SDK here
derives `allowed` exhaustively from the decision string rather than as the
negation of anything else, and every example branches on all three.
