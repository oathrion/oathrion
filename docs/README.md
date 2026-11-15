# Oathrion documentation

**RUNTIME AUTHORIZATION FOR AI AGENTS.**
AI can act. You decide what it can do.

Your agent is about to refund a customer, delete a record or send an email.
Oathrion answers one question, in real time, before it happens:

> Is this agent allowed to do this, right now, with these arguments?

Three answers: `ALLOW`, `BLOCK`, `APPROVAL_REQUIRED`. Every one of them is
recorded.

## Pour un pilote — commencez par ces cinq documents

Écrits à partir du comportement **vérifié**, chaque ligne portant la commande qui
l'établit :

| | |
|---|---|
| [**PILOT-READINESS**](PILOT-READINESS.md) | la matrice réel / partiel / simulé / absent, les critères de sortie, et le verdict |
| [**QUICKSTART-PILOT**](QUICKSTART-PILOT.md) | `npm run pilot:up`, puis comment valider soi-même |
| [**CONNECT-EXISTING-AGENT**](CONNECT-EXISTING-AGENT.md) | les trois voies, ce qu'elles garantissent, ce qu'elles coûtent |
| [**SECURITY-BOUNDARIES**](SECURITY-BOUNDARIES.md) | chemins couverts, non couverts, credentials, limites |
| [**OPERATIONS-RUNBOOK**](OPERATIONS-RUNBOOK.md) | incidents, sauvegardes, révocation, rollback |

Et les deux voies d'intégration en détail : [**pare-feu HTTP**](firewall.md) ·
[**MCP**](mcp.md) · [**connecteurs**](connectors.md).

## Start here

```bash
bash examples/quickstart/quickstart.sh
```

Five minutes, from an empty database to all three decisions and an audit trail.
[**Quickstart**](quickstart.md) narrates what it does.

## The two ways to use Oathrion

Read this before choosing an integration, because the guarantees differ.

### MOTIF A — the MCP authorization gateway

Your agent's MCP client points at Oathrion instead of at your tool server. Oathrion is
**in the path**. An action it refuses cannot happen, because the call never
reaches the tool.

This is the strong guarantee, and it is a configuration change rather than a
code change. **CHANGE THE ENDPOINT, NOT YOUR AGENT.**
→ [MCP gateway](mcp.md)

### MOTIF B — ask before you act

Your code calls `POST /api/evaluate`, directly or through an SDK or the CLI, and
acts on the answer. Works with any language, framework or transport, and does
not change how your agent is built.
→ [HTTP API](http-api.md) · [TypeScript](../sdk/typescript/README.md) ·
[Python](../sdk/python/README.md) · [CLI](../cli/README.md) ·
[any framework](../examples/framework-adapter/)

**The limit of MOTIF B, stated on page one.** Oathrion cannot physically stop a
program that decides to ignore the answer it was given. Nothing that hands out
decisions over HTTP can. What Oathrion guarantees is that the decision is
**authoritative, recorded and tamper-evident** — that there is no version of
events in which the action was quietly authorized, and no way to act outside
policy without that being visible afterwards.

If you need the check to be *unavoidable* rather than *authoritative*, use
MOTIF A. We would rather you knew which one you had.

## Reference

| | |
| --- | --- |
| [Quickstart](quickstart.md) | Empty database to first decision. |
| [Core concepts](concepts.md) | Agents, actions, policies, decisions. |
| [HTTP API](http-api.md) | `/api/evaluate` and the rest. |
| [Authentication](authentication.md) | API keys, console sessions, roles. |
| [Agent identity](agents.md) | Who is asking, and how Oathrion knows. |
| [Policies](policies.md) | Writing the rules. |
| [Decisions](decisions.md) | The three answers, and precedence. |
| [Approvals](approvals.md) | Holding an action for a human. |
| [Audit](audit.md) | What is recorded, and what "tamper-evident" means. |
| [MCP gateway](mcp.md) | MOTIF A, in detail. |
| [`oathrion wrap`](wrap.md) | Govern any MCP server with one command, on your own machine (preview). |
| [What it does not do yet](not-yet.md) | The preview's limits, in plain words. |
| [Security model](security-model.md) | What Oathrion defends against, and what it does not. |
| [Troubleshooting](troubleshooting.md) | Why am I getting BLOCK? |
| [Known limitations](limitations.md) | Read before a pilot. |
| [On-call](ON-CALL.md) | The 3 a.m. page: symptom → command → what to do. |
| [Operations](OPERATIONS.md) | Backup, restore, monitoring, upgrade. |
| [Pilot scope annex](ANNEXE-PERIMETRE-PILOTE.md) | **What is guaranteed, what is measured, what is not supplied.** Written for a client's technical and legal reviewers. |
| [Commercial readiness](COMMERCIAL_READINESS.md) | Line-by-line state, each with its evidence. |

## The one thing to get right

There are **three** decisions, not two.

```
ALLOW              go ahead
BLOCK              policy says no
APPROVAL_REQUIRED  a human has not answered yet
```

`APPROVAL_REQUIRED` is **not permission**. The most common integration bug is
code that treats it as one, usually by writing `if (!blocked)`. Every SDK here
derives `allowed` exhaustively from the decision string rather than as the
negation of anything else, and the CLI gives a hold its own non-zero exit code
for the same reason.

Two more, in the same family:

- **Unreachable is not allowed.** If Oathrion cannot be reached, no SDK here
  invents a decision. The call fails, and your action does not happen.
- **Unknown is not allowed.** An action Oathrion has never heard of is blocked by
  default, and a decision string it does not recognise is a protocol error. See
  [`OATHRION_UNDECLARED_ACTION`](security-model.md#undeclared-actions).
