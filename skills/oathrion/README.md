# Oathrion skill

Teaches an AI agent to work under [Oathrion](https://github.com/oathrion/oathrion), the
open-source local guard for AI agents: how the person sets it up, and how the agent behaves
when Oathrion holds or refuses one of its actions.

- **Free**, Apache-2.0, like Oathrion itself.
- **No scripts, no network, nothing installed by the agent.** The skill is instructions only.
  Oathrion is installed by the person, in their own terminal (`npx oathrion`), never by the
  agent: a guard set up by the agent it guards proves nothing.

## What it changes in your agent

- When you ask for guardrails, approvals or a record of what the agent did, it explains how to
  set up Oathrion and what will change.
- When Oathrion holds an action, the agent stops, tells you in four lines what waits and where to
  decide, and does not retry in a loop.
- When Oathrion refuses an action, the agent quotes the reason and proposes a safer way. It never
  rewrites the command to get around the refusal, and never touches Oathrion's settings.

## Files

| File | What it is |
|---|---|
| `SKILL.md` | The instructions the agent loads |
| `references/what-oathrion-checks.md` | What Oathrion lets through, asks and refuses, and how the person turns a rule off |
| `examples/held-and-refused.md` | Oathrion's messages, and the right and wrong answers |

## Works with

Any agent that reads `SKILL.md` skills (Claude Code, and others that support the format).
Oathrion itself protects Claude Code, Cursor and any MCP client; see its README.

Questions: contact@oathrion.com
