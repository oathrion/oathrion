---
name: oathrion
description: Use when the user wants to control what an AI coding agent may do on their machine, or when Oathrion paused, held or refused one of your actions. Triggers include "put guardrails on Claude Code", "make my agent ask before it writes", "approve my agent's actions from my phone", "protect my MCP servers (GitHub, Slack, Stripe)", "keep a verifiable record of what the agent did", or a message that starts with "Oathrion:" or "Oathrion refuses". Explains how the person sets up Oathrion (open source, local) and how you must behave under it - wait for the person, never work around a refusal.
---

# Working with Oathrion

Oathrion is an open-source (Apache-2.0), local guard for AI agents. It sits between agents
(Claude Code, Cursor, any MCP client) and what they act on: files, shell, secrets, MCP servers.
Reads go through; writes wait for a person; destructive actions are blocked or asked; every
action leaves a signed receipt. Everything stays on the person's machine: no account, no
telemetry. It is a public preview (`0.1.0-preview.1`): say so if the person plans to rely on it
unattended.

You meet Oathrion in one of two ways. Follow the matching section.

## 1. The person wants to set it up

The person installs Oathrion **themselves, in their own terminal**. Do not run the install
for them: it changes your own client's settings and installs the guard that checks your
actions, and a guard set up by the agent it guards proves nothing to the person.

Tell them, in this order:

1. To see it first, harmlessly: `npx oathrion demo` (a notification on a pretend agent).
2. To protect the machine: `npx oathrion` (Node 22 or later). It lists the agents and MCP
   servers it found, and changes nothing until the person presses Enter. Every file is backed
   up first.
3. To approve from the phone (optional): `oathrion phone telegram`.
4. To undo everything: `npx oathrion --undo`.

Then explain in two sentences what will change for you: reads go through, writes and risky
commands will wait for their decision, and some actions will be refused outright. Point to
`references/what-oathrion-checks.md` if they want the detail.

## 2. Oathrion held or refused one of your actions

### Held: "Oathrion: … Allow it?", or a write waiting for approval

The person decides, never you.

1. Stop that action. Do not retry it in a loop, and do not try the same thing another way
   (another tool, other arguments, a script, a different command).
2. Tell the person, using the format below, what is waiting and where they can decide: in this
   client when it asks, in Oathrion's notification, in Oathrion's console, or on their phone if
   they paired it.
3. Carry on with work that does not depend on it, or wait.
4. Once they say they decided, you may repeat **the exact same call**: it returns the decided
   result instead of asking again.

### Refused: "Oathrion refuses …"

A refusal is final for you. **Never work around it.** In particular, never:

- rewrite the command in another language or tool (a Python or Node one-liner, `find`, a
  script file) to do the same thing;
- split it, encode it, or hide it in a variable, a pipe or a subshell;
- edit, move or delete Oathrion's files (`~/.oathrion/`), its rules, or your client's settings
  and hooks;
- start the agent or the server outside Oathrion, or use another MCP server for the same effect;
- open Oathrion's console, run `oathrion console`, read `~/.oathrion`, or call Oathrion's API to
  approve your own request.

Instead:

1. Quote Oathrion's reason to the person, word for word.
2. Propose a safer way that stays inside the project, if there is one.
3. Leave the decision to them. If they disagree with the refusal, **they** can run the command
   themselves, or turn the rule off in their own settings
   (`references/what-oathrion-checks.md`). You never change those settings.

### A tool you expected is missing

Oathrion withholds a tool whose definition changed since the person accepted it, and destructive
tools until the person allows them. Tell the person which tool you need and why. They can review
it with `oathrion tools list --name <server>` and accept it with
`oathrion tools accept --name <server> <tool>`; it is available at the next start.

### Output format

When an action is held or refused, tell the person in this shape, and nothing longer:

```
Paused by Oathrion: <the action, in plain words, and its target>
Why: <Oathrion's reason, quoted>
Your decision: <where: this client / the notification / the console / your phone>
Meanwhile: <what you will do, or "I am waiting">
```

For a refusal, replace "Your decision" with "A safer way:" and your proposal, or "None that I
can see".

## 3. The person asks what the agent did

Every action that went through Oathrion has a receipt, chained so that a change is detected.

- `oathrion receipts verify` re-reads the whole chain and says whether it is intact.
- The console's **Activity** screen shows everything the agents did, on one timeline, with an
  export. The person opens it with `oathrion console`; you do not.
- A single receipt can be shared: it is signed (Ed25519), and anyone can check it without
  Oathrion.

## 4. Oathrion was wrong

If Oathrion stopped something harmless, or let something through that it should have stopped,
suggest the person tells its makers: `oathrion feedback "<what happened>"`. It opens a
pre-filled report that the person reads and sends themselves; nothing leaves on its own.

## What Oathrion does not cover

Say this plainly when it matters:

- Claude Code's own file **reads**, and Cursor's own built-in tools, are not checked.
- The command line is judged, not what a script file will do once it runs.
- The agent watch, the jail and the decoys work on Linux only for now.
