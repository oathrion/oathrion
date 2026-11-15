# Security model

The ordering Oathrion is built on, in priority order:

```
SECURITY > CORRECTNESS > TESTS > SIMPLICITY > UI
```

Fail closed. **When in doubt, BLOCK.**

## The core property

> A forbidden or unapproved action must never reach downstream.

Everything below is a consequence of that sentence.

## Fail-closed, enumerated

Each of these could have been a convenient "allow" and is not:

| Situation | Oathrion does | Because |
| --- | --- | --- |
| Action not declared anywhere | **BLOCK** | An agent inventing a verb at runtime is the event you want stopped. |
| Uncatalogued verb whose name is dangerous | **BLOCK** | `delete_all_customers` is not a good default-allow. |
| Financial verb with no ceiling governing it | **BLOCK** | Money movement with no limit is not "unregulated", it is ungoverned. |
| Mandate restricts categories, request declares none | **BLOCK** | Can't be shown in scope, isn't in scope. |
| Oathrion unreachable | **no decision** | Downtime is not permission. |
| Unrecognised decision string | **protocol error** | Guessing is how drift becomes bypass. |
| Approval window expired | **409, nothing released** | Late is not approved. |
| Bound key names another agent | **refused** | Confinement that can be argued out of is not confinement. |

## Undeclared actions

`OATHRION_UNDECLARED_ACTION` controls the treatment of actions Oathrion has never heard
of. **The default is BLOCK**, and it is validated at boot.

No backward-compatibility argument justifies fail-open on an unknown action. An
existing integration that breaks because it was relying on undeclared verbs
going through has been told something true about itself.

To make an action known, name it in an enabled policy. See
[Policies](policies.md).

### The wildcard asymmetry

`sys_unknown_dangerous_action` stands down only for a verb named **literally**
in an enabled applicable policy. Wildcards do not count — even though a
wildcard policy *is* enough to make an action "declared".

That asymmetry is the safety property. A policy covering `stripe.*` shows
someone thought about the Stripe integration. It does not show anyone
considered `stripe.wipe_all_customers` specifically. For a verb whose name
advertises destruction, Oathrion insists on the specific evidence.

## What Oathrion does not defend against

Stated plainly, because a security model that only lists strengths is marketing.

**MOTIF B cannot physically stop a hostile client.** If your code calls
`/api/evaluate` and then ignores the answer, Oathrion cannot prevent the action —
nothing that hands out decisions over HTTP can. The guarantee is that the
decision is authoritative, recorded and tamper-evident: there is no version of
events in which the action was quietly authorized. For a check that is
*unavoidable* rather than *authoritative*, put Oathrion in the path with the
[MCP gateway](mcp.md).

The same limit applies to the [framework adapter](../examples/framework-adapter/):
it protects the tool it wrapped, and nothing stops you from calling the
unwrapped one.

**Audit tamper-evidence is bounded.** It detects edits within an execution's
trail. It does not detect deletion of an entire execution row, and verification
is internal consistency rather than external cryptographic authenticity — there
is no signature over the chain head. Someone with write access to both database
and code could produce a fresh, consistent chain. See [Audit](audit.md).

**Agent binding is required by default in production** (`NODE_ENV=production`)
and off outside it. An unbound machine credential therefore cannot choose its own
agent in a production deployment that was never configured. Set
`OATHRION_REQUIRE_AGENT_BINDING=false` to relax it during a migration, or `=true` to
require it in a non-production environment. The active posture is printed at boot
so it is never a matter of inference.

**Oathrion does not authenticate the agent's reasoning.** It answers whether *this
identity* may perform *this action*. A compromised agent holding a valid key
gets exactly the permissions that key has — which is the argument for narrow
mandates and bound keys rather than one admin key shared by everything.

**Prompt injection is not solved by Oathrion**, and no authorization layer solves
it. What Oathrion changes is the blast radius: an injected instruction still has to
pass policy, and a refund ceiling holds whether the agent was tricked or not.
That is worth having and it is not immunity.

## Operational

- Secrets are redacted from logs; keys are compared in constant time and never
  logged.
- Rate limits are per credential. `429` is not a decision.
- `.env` is excluded from the shipped checkpoint; `.env.example` is included.
- Boot-time config validation refuses to start on a misconfiguration rather than
  starting in a degraded state.
- Known dependency advisories are listed in [Known limitations](limitations.md)
  rather than left unmentioned.
