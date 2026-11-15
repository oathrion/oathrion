# `oathrion wrap` — govern any MCP server with one command

```bash
oathrion wrap -- npx -y @modelcontextprotocol/server-github
```

Put Oathrion in front of an MCP server your agent already uses. Reads go through, writes
wait for your approval, destructive tools are blocked, and every executed call leaves a
receipt in a tamper-evident chain. No Docker, no PostgreSQL, no account: everything runs on
your machine, on `127.0.0.1`, and the data stays in `~/.oathrion/_local/`: **one Oathrion
for the whole machine**, one console and one receipt chain for all your servers and all your
clients.

> **Status: preview.** Verified with **Cursor** (`cursor-agent` 2026.10.22) and **Claude Code**
> (2.1.318, approval in the console). **Claude Desktop has not been verified yet** — the
> configuration below is what it documents, not something we have run. See
> [Verified clients](#verified-clients).

## Set it up

```bash
npx oathrion
```

It finds the MCP servers of Claude Code, Claude Desktop and Cursor on your machine, shows them, and puts
Oathrion in front of all of them after one answer (Enter means yes). Then restart your client.

Where it looks:

| Client | Where |
|---|---|
| Claude Code | `.mcp.json` of the current folder; in `~/.claude.json`, your own servers (scope `user`) and those of **every** project (scope `local`, what `claude mcp add` writes) |
| Cursor | `~/.cursor/mcp.json`, and `.cursor/mcp.json` of the current folder |

- **`~/.claude.json` is changed through Claude Code's own commands** (`claude mcp remove`,
  then `claude mcp add-json`), because Claude Code rewrites that file while it runs. If the
  add fails, the original server is put back.
- **Every file is copied first**, readable only by you, since it may hold tokens
  (`<file>.avant-oathrion-<date>`).
- **Remote servers** (a URL) whose token is in the configuration (`headers`) are protected
  too: see [Remote servers](#remote-servers). A remote server without a token in the
  configuration has its sign-in (OAuth) handled by the client; it is left as it is.
- **The client runs the same Oathrion you ran**: `npx -y oathrion@<this exact version>`, so no
  package changes under you; or, if Oathrion is installed or built, its path.
- **One question per action, in Claude Code.** Claude Code asks its own permission before
  every MCP tool. Behind Oathrion, that would be a second question for the same action. So
  `npx oathrion` adds a rule `mcp__<server>` for each server it protects: in
  `~/.claude/settings.json` for your own servers, and in `<project>/.claude/settings.local.json`
  (personal, never shared) for a project's. Claude Code then lets Oathrion ask you. Reads go
  through, writes are asked by Oathrion, destructive tools are blocked.
  - A rule is added only for a server that really is under Oathrion afterwards.
  - The rest of the file is kept, and the file is copied first.
  - `--keep-claude-prompts` leaves Claude Code asking as well.
- `--except <name>` (repeatable) leaves a server as it is: it is named in the list, not changed.
- `npx oathrion --undo` puts every server back as it was, and removes those rules.
- `--yes` applies without asking. The French option names of `0.1.0-preview.0` (`--annuler`,
  `--sauf`, `--oui`, `--approbation`…) are still understood.

For one client and one file only: `npx oathrion install cursor` (`--global` for
`~/.cursor/mcp.json`) or `npx oathrion install claude-code` (`.mcp.json`).

By hand, it is the same: in your agent's MCP configuration, replace the server's command
with `oathrion wrap -- <the same command>`. Nothing else changes.

```jsonc
// before
{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
                              "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" } } } }

// after
{ "mcpServers": { "github": { "command": "oathrion",
                              "args": ["wrap", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
                              "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" } } } }
```

The server's own environment variables (its tokens) are passed to it unchanged.

Without a global install (`npm install -g oathrion`), let `npx` fetch it:
`"command": "npx", "args": ["-y", "oathrion", "wrap", "--", "npx", "-y", "@modelcontextprotocol/server-github"]`.

From a checkout of this repository instead (`npm run build`), use the compiled command:
`"command": "node", "args": ["<repo>/dist/oathrion.mjs", "wrap", "--", …]`.

## What you will see

On the first start, on the server's standard error (your client's MCP log):

```
[oathrion wrap] server "github": <r> read(s) allowed, <w> write(s) on approval, <d> destructive tool(s) blocked.
[oathrion wrap] first launch: the definitions of <n> tool(s) are pinned. …
[oathrion wrap] console: "oathrion console" opens it, signed in.
[oathrion wrap] "Cursor": this client's agent, in Oathrion's console.
```

To see what Oathrion shows when an agent acts without permission, without waiting for one:

```
oathrion demo            # a pretend agent, Nova, paused: try « Stop », then « Share it »
oathrion demo --decoy    # the red notification, for a decoy read
```

Nothing real is paused or read. On macOS and Windows, the system's notification shows it.

**Each agent has its own mascot**, so you recognise at once which one Oathrion stopped. In the
console (Agents, or the mascot in « Running now »), choose another one and give the agent a
name: « Kiki (agy) is paused ». It holds for the whole agent (« Claude Code » and `claude` are
one), in the notifications, the feed and the cards you share.

There is no account to create and no password to remember: the machine is already yours.
`oathrion console` opens the console in your browser, signed in, on the requests waiting for
you. The console is where you approve, read the receipts, and change the rules.

**Your agent is your client.** Oathrion names it after what the client calls itself — « Cursor »,
« claude-code » — with the tools of all the servers it reaches through Oathrion. A second client
on the same server is simply a second agent: both share the same running server.

## The defaults, and how a tool is classed

Each tool of the server becomes an Oathrion action `mcp.<name>.<tool>`, classed when the
server starts:

| Class | How it is recognised | Default |
|---|---|---|
| destructive | `destructiveHint`, or a name about deleting, paying, or running commands (`delete`, `remove`, `drop`, `purge`, `pay`, `refund`, `exec`, `shell`, `command`…). The official filesystem server declares `write_file`, `edit_file` and `move_file` destructive, because they can overwrite a file | blocked; if you grant the agent `mcp:destructive`, held for your approval |
| write | a name with a write verb (`create`, `update`, `push`, `merge`, `add`… anywhere; `comment`, `run`, `set`… as its first word), or `readOnlyHint: false` | held for your approval |
| read | `readOnlyHint: true`; or, when the server gives no annotation, a name that starts with `get`, `list`, `search`, `read`, `fetch`, `query`, `find`, `describe`, `show`, `view`, `lookup`, `count`, `check` | allowed |
| write | everything else | held for your approval |

The rows are checked in this order. A server's annotations are its own claim, so a write
verb in the name always wins over a `readOnlyHint`. A tool classed as a read **on its name
alone** — the server does not annotate it — is listed when the server starts, so you can hold
it with a rule if you disagree.

Tuned on real servers on 28 October 2026. The official filesystem and memory servers annotate
their tools. The GitHub server (`github-mcp-server` 0.6.2) annotates none: by name, 14 of its 26
tools are reads, and its 12 writes are all real writes.

To change a default, use the console:
- **Policies**: the rule « `<name>`: every write waits for approval » can be
  disabled. It is never re-enabled behind your back.
- **Agents**: grant `mcp:destructive` to let destructive tools through, under your rules.

## Programs Oathrion has never seen

A client names itself (« Claude Code », « Cursor »), and any program can take any name. So
Oathrion also looks at **the program that really started the server**: the relay walks up its
parent processes, past `npx`, `npm exec`, shells and `env`, to the real executable (and the
script, for `node app.js`), and takes its SHA-256 fingerprint.

A program Oathrion has never seen gets **no key**: nothing it asks goes through, not even a
read. A desktop notification tells you at once ("A program Oathrion has never seen wants to use
your servers"; **Decide** opens the console). The console shows it at the top of **Approvals**,
with what it *says* it is next to what Oathrion *knows*: its executable and fingerprint.
Meanwhile the agent sees the server's tools (not the destructive ones) and one more,
`oathrion_unknown_program`, explaining why; a call **waits for your decision**, like an
approval (50 seconds by default). **It's mine, confirm** lets that very call go on, under
your usual rules, without restarting anything. **Block it** keeps it out for good. Not
decided in time: the agent is told why, and the next call waits again.

- `npx oathrion` confirms Claude Code in advance when it finds it on your machine: you ran
  the command yourself.
- A known program updated in place (a new version of Claude Code) stays known; its previous
  fingerprint is kept.
- The same name from another executable is another program, and waits.
- On Linux, an AppImage (Cursor) is identified by its AppImage file, not by where it is
  mounted for that run.

**Limits.** Linux and macOS read the parent processes; on Windows, Oathrion falls back to the
name the client gives, which is weaker. This is a gate for what goes *through* Oathrion: a
program running as you can still reach a server's own token, or Oathrion's files, outside it
(see [What it does not do](#what-it-does-not-do)). The setting
`OATHRION_UNSAFE_TRUST_ALL_PROGRAMS=1` exists for automated tests only: never set it
elsewhere.

## Approving

When your agent calls a write tool, the call **waits for your decision**, up to 50 seconds
by default (Cursor gives up on a call after about 60 seconds), and the console link is printed on standard error.
- **Approved**: the agent receives the server's real answer, as if the call had just
  succeeded.
- **Rejected**: the agent is told the tool was not called.
- **No decision in time**: the agent gets « held », with the link. The action still runs when
  you approve it, and its result is in the receipt.
- **The agent calls again**: a call identical to one still held (same tool, same arguments)
  creates **no new request**. It waits for the first one, and once you have decided, returns
  its outcome: the server's answer, or the refusal. One approval, one execution. Clients
  retry when they give up waiting, so without this every retry was a new request, and
  approving them all ran the action several times.

`--wait <seconds>` changes the wait; `0` returns « held » at once.

### Deciding once

An agent that writes twenty files should not ask twenty questions. For a **write** tool,
the question in your client asks « And next time? »:
- **Only this time** (the default);
- **This tool, without asking again until the client closes**: the next calls of this tool
  pass without a question until the client closes. Each one is still approved and
  written to the log, as « Granted for the session »;
- **This tool, always**: a rule, `<server>: allowed without approval`, in the console
  (Policies). The tool leaves the « every write waits » rule. It holds across restarts;
  removing it from the rule puts the tool back under approval at the next start.

In the console, **« Approve, don't ask again »** does the same as « always ».

A **destructive** tool never gets these choices: it asks a person every time. A read never
asks anyway.

### Being told

A held action is only useful if someone sees it. The local Oathrion tells you:

- **on your desktop, by default, with nothing to set up**: « Cursor wants to use
  "write_file" », with a **Decide** button that opens the console, already signed in, on
  the request. The link is made by Oathrion itself, never passed through the agent.
  - **Linux**: **Oathrion's own notification window**, top right of the screen: the agent's
    mascot on the left (Ember for Claude, Pixel for Cursor, Nova for agy, Bolt for Codex,
    Echo for Gemini, Orbit for the others, Shade for a program never seen, Warden for
    Oathrion itself: illustrations made for Oathrion, shipped with it, never a vendor's
    logo; the same mascots in « Running now »), the message and two buttons
    on the right, and below, 👍 👎 « Was Oathrion right? » and « Open the console ». After
    your choice, the same window says what was done and waits for your 👍 or 👎, then closes.
    It needs GTK for Python, which Ubuntu and most Linux desktops ship; without it, the
    system's notification, with the same buttons and the feedback in a second notification.
    Windows left by an earlier local Oathrion are closed when it starts again. It
    **decides by itself**, without the console. A request: « Approve » /
    « Reject », released or refused exactly as from the console. A program never seen:
    « It's mine » / « Block it ». An agent paused outside the jail: « Resume » / « Stop it ».
    A decoy read: « It was me » / « Not me ». Your 👍 / 👎 stays on this machine
    (`~/.oathrion/_local/feedback.jsonl`), never sent. A grouped notification (several
    requests in a minute) keeps the single « Decide » button: one click never decides more
    than what it shows. Where `notify-send` cannot show several buttons, the « Decide »
    button as before.
  - **macOS**: a dialog, « Later » or « Decide », that closes by itself after two
    minutes.
  - **Windows**: a Windows notification with « Decide » and « Later ». Windows opens an
    address on the click: a one-time link, valid fifteen minutes, that Oathrion exchanges
    for a fresh sign-in.

  Where the button cannot be shown, a plain notification says what to run. On macOS and
  Windows, « Decide » opens the console on that request, with the agent's mascot and the same
  buttons. macOS and Windows have not been tried on a real machine yet;
- **on your phone, anywhere** (Telegram): see below;
- **on Slack, if you want it**: `oathrion notifications slack <incoming webhook URL>`. The
  message says who wants what, and where to decide. It has **no buttons**: Slack cannot call
  back a console that listens only on `127.0.0.1`, so you decide on your computer or in your
  client.

```bash
oathrion notifications                  # what is on
oathrion notifications slack <url>      # also on Slack (--remove to stop)
oathrion notifications desktop off      # no desktop notification
oathrion notifications sound off        # no sound (on by default)
oathrion notifications test             # a test message on each channel
```

Each notification on your computer comes with **Oathrion's sound**: a short rising chime for
a request, a more urgent one when something read a decoy or an agent was paused.

#### Approving from your phone, anywhere

Leave your computer at home, and decide from your phone. Requests arrive on **Telegram**, with
the agent's mascot and **Approve** / **Reject**:

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name. It gives you a token. Use a
   new bot for Oathrion: it should serve nothing else.
2. On your computer: `oathrion phone telegram`. Paste the token when it asks (it is not shown,
   and stays out of your shell history). A QR code appears.
3. Scan it with your phone's camera: Telegram opens your bot; tap **Start**. Done. (No camera?
   Open your bot, tap **Start**, send the short code shown under the QR.)

The bot then sends Oathrion's sound: touch and hold it → *Save for notifications*, then the
chat's name → *Notifications* → *Sound* → *Oathrion*.

**When the phone rings.** In front of your computer, you decide there: the phone is asked only
if nobody decided within 45 seconds. It rings at once for an alert (something read a decoy), or
when the desktop notification is off (`oathrion notifications desktop off`: « I am away »).
Whatever you decide, wherever, the others lose their buttons and say where it was decided.

How it works, and what leaves your computer:

- **Nothing reaches into your computer.** Your Oathrion asks Telegram for the buttons you
  pressed (long polling): no open port, no service of ours.
- **Only you decide**: a press counts only from the account and the chat paired by the code.
  Each button holds a random identifier valid for that request only; an old message, or a
  request from before Oathrion restarted, no longer acts.
- **What is sent**: what the agent wants to do, its mascot, and what you decided. A command
  line goes through a filter first: what looks like a key or a token becomes `•••`. Never the
  content of a file. Telegram carries these messages; if that is not acceptable, do not pair.
- Your computer must be on, and online, for the request to exist and for your answer to arrive.

```bash
oathrion phone                          # is a phone paired?
oathrion phone telegram                 # pair it (asks for the bot token)
oathrion phone test                     # a test notification on your phone
oathrion phone off                      # unpair
```

The settings live in `~/.oathrion/_local/notifications.json` and `telegram.json` (0600: a
Slack webhook carries its secret in its address, a bot its token; neither is ever printed). They are read again at each
notification: no restart.

### Approving in your client

**By default, the question appears in your MCP client** when the client says it can ask
one (MCP *elicitation*). It shows the tool, the server and the arguments in plain words,
and a box to tick, **« Yes, I approve this action »**, then *Accept* or *Decline*.
- Your decision is recorded in Oathrion as « You, from your MCP client ».
- If you close the question without deciding, the console takes over.
- If you have not answered after 50 seconds, your agent is told the request is waiting, and
  goes on. The question stays open in your client: answering it later still counts, exactly
  like a decision in the console.
- A client that cannot ask: the console decides, as before.
- `--approval console` (on `wrap`, `npx oathrion` or `install`) keeps every decision
  in the console.

**Why the box.** This trusts your client to show the question to a person: it is the
client's interface that answers, not the model. A client that accepted questions on its
own, for example in a non-interactive mode, would answer *Accept* without ticking the box.
That is not a decision: the request stays in the console, for a person.

**One question, not two.** While the question is in your client, the desktop (and Slack)
notification waits 10 seconds (`OATHRION_LOCAL_NOTIFY_GRACE_MS` changes it). It is sent only
if the request is still undecided: you did not see the question, or you closed it. Decide in
the console instead, and the question in your client closes by itself, and the agent goes on
at once.

**Several requests close together, one notification.** The first request after a quiet
minute is notified at once. The ones that follow within that minute are held, then sent
together (« 3 requests are waiting for your decision »), and only those still undecided:
a request you already answered does not disturb you again. A command Claude Code runs in
auto mode is named in the notification itself (« Claude Code wants to run: git push »).

**Decide once.** When you approved the same tool of the same agent three times in a row,
its next request in the console says so (« You approved this tool 3 times in a row ») and
highlights **Approve, don't ask again**. One rejection starts the count over. It is only a
suggestion: nothing is allowed until you click. It is not offered for Claude Code's own
commands, which are each different.

Which clients say they can ask:
- Claude Code 2.1.312, observed on 2026-10-28 (`form` and `url`);
- Cursor, `cursor-agent` 2026.10.22.

That either of them shows the question to a person has **not been verified yet**.

### The console

On your machine, the console has five pages: **Home** (what is running now, and the news feed
of what Oathrion did and what you decided, with each agent's mascot), **Approvals**, **Agents**,
**Protection** and **Settings**; the detailed pages are under « Details ». Every feed item has a
**Share** button: a card with the mascot and a plain sentence, and nothing private on it (no
path, file name, command or process number), to download, copy, or send to X, LinkedIn or
WhatsApp. « Share » in Oathrion's notification window opens it.


**« Servers »**, where the console opens when nothing waits for a decision, answers the
first question: does it work?
- **For each server under Oathrion**: the client using it now (« Claude Code »), what
  passes, what is asked, what is blocked, and its last action — or « waiting for your
  agent's first action ».
- **The servers of Claude Code and Cursor that go around Oathrion**, read from their
  configurations on this machine, with the command that protects them (`npx oathrion`).
  Nothing is changed from the console.

**« Protection »** says what Oathrion really covers on this machine, agent by agent (Claude
Code, Cursor, Claude Desktop), and what it cannot see. Each way an agent acts is in one of four
states: **protected** (an MCP server behind Oathrion), **checked by rules** (Claude Code's
shell and file edits, through its hook), **bypasses Oathrion** (`npx oathrion` can fix it), and
**Oathrion cannot see it** (Claude Code's file reads, Cursor's terminal and edits, Claude
Desktop's extensions and connectors, remote servers whose sign-in the client handles). What
needs you comes first.

**« Activity »** is the audit, on one timeline: everything your agents did, newest first —
what went through Oathrion (MCP servers) and what Claude Code ran itself (its hook: shell
and file writes), each line saying which. For each action: the agent, the command or tool,
Oathrion's decision, a person's answer when there was one (including a command sent to you in
auto mode and approved later: « ask the agent again to run it »), and the outcome. Filter by
agent; export exactly what is shown as JSON or CSV. The state of the Claude Code journal's
chain is shown above the list.

```bash
oathrion console
```

It opens the console in your browser, signed in: a link that works once, for two minutes
(`--no-browser` prints it instead). If a client is running, it gives you that link and
returns. If none is, it starts the local Oathrion and restarts the servers it already knows
(their command, the environment of your terminal; `--name` for just one), so an action you
approve there really runs, and stays open until Ctrl+C. A client that starts meanwhile
simply shares the same Oathrion.

The local Oathrion lives while a client or a console is attached, and stops by itself a little
after the last one leaves; a server that no client uses any more is stopped, and the next
client starts it fresh, with its own environment.

If the wrapped server is not running, approving is refused (`409`) and the request stays
pending: an approval with nothing to run would be consumed for nothing.

## Claude Code's own tools

Claude Code runs its shell and edits files with its own tools, without MCP. As soon as Claude
Code is on the machine, even with no MCP server at all, `oathrion` adds its hooks once, for all
your projects, to `~/.claude/settings.json`: before and after each `Bash`, `Write`, `Edit`,
`MultiEdit` and `NotebookEdit`, Claude Code calls `oathrion-hook.mjs`, a small file next to the
command. A hook left in a project's `.claude/settings.local.json` by an earlier version is
removed: two hooks would check each command twice, and ask you twice in auto mode.

| Rule | What happens |
|---|---|
| `rm -rf` (any recursive `rm`) on the home folder, the project itself, or outside the project and the temporary folders | refused |
| `git push --force`, `git push -f`, `git push origin +branch` | refused |
| `curl …` or `wget …` piped into a shell | refused |
| `chmod -R 777` | refused |
| a write or edit outside the project and the temporary folders | refused |
| a write or edit of `.claude/settings*.json`, `.mcp.json`, `~/.claude.json` or `~/.oathrion/` | refused: the agent cannot switch off its own guard rails |
| `git push`, `npm`/`pnpm`/`yarn`/`cargo publish` | Claude Code asks you, with Oathrion's reason |
| replacing an existing file that git does not track (`Write`) | Claude Code asks you |
| anything else | nothing: Claude Code decides as usual |

**Oathrion never answers "allow" on its own**: that would skip Claude Code's own permissions. It
refuses, asks, or stays silent.

**A question needs a person, in every mode.** In the default mode, Claude Code asks you itself,
with Oathrion's reason. In a mode where Claude Code asks no one (`auto`, `bypassPermissions`,
`dontAsk`, and file writes in `acceptEdits`), **Oathrion asks a person itself**, like a write on an
MCP server: the request appears in the console and as a desktop notification (**Decide**), and
the hook waits for the answer (`OATHRION_HOOK_WAIT_SECONDS`, 50 by default). Approved: the
command goes through — the one "allow" the hook gives, because a person decided. Refused or
expired: refused. No answer yet: refused, with the reason telling the agent to ask again once you
have approved; the same command then finds its approval. One approval runs one command. The
local Oathrion is started if needed, and stays up while the hook waits. The rules run in the hook itself: they hold even when the local Oathrion
is not running.

**When the session has read something it shouldn't trust.** Oathrion does not try to detect a
prompt injection; it knows where what the agent read came from. As soon as Claude Code reads
content written by someone else — a web page (`WebFetch`), a search (`WebSearch`), or an MCP
tool that reads issues, pull requests, comments, e-mails, messages or pages — its session is
marked until it ends. From then on, what can send something out (`curl`, `wget`, `ssh`, `scp`,
`git push`, `gh … create/comment/api`, publishing, a script with a URL) and what will run later
(CI workflows, git hooks) asks a person, and the question says why: « this session read
untrusted content (WebFetch evil.example, at 10:42 UTC) ». In auto mode, Oathrion asks you
itself, and the request in the console carries the same warning. Refusals stay refusals; the
rule can be disabled like the others (`"disable": ["tainted-session"]`). What it does not do:
the provenance is lost when the content is copied into a file that another session reads later,
and a read the hook does not see (Claude Code's own `Read`, a shell `cat`) does not mark the
session.

**Saying what would leave.** In a session at risk, the question names what would go out: « Sending
something out now (with a GitHub token in it) », « (with .ssh/id_rsa in it) ». Secrets are
recognised by their shape (GitHub, AI provider, Slack, AWS, Google and npm keys, bearer tokens,
`password=…`, a password in an address); sensitive files by their path (`.env`, `~/.ssh`,
`~/.aws`, `.netrc`, `.npmrc`, `.pgpass`, Docker and Kubernetes configs). `WebFetch`,
`WebSearch` and MCP tools are looked at too, but only when they carry such a secret: a URL with
a token in it asks; the rest goes through without a cost. In auto mode, such a web or MCP call is
refused with its reason (the console can only be asked about a command or a file write). The
journal keeps these calls with their secrets redacted.

**Decoys: catching the agent being tricked.** `oathrion decoys plant` puts fake secrets where
an attacker would look — `~/.aws/credentials.backup` (a fake AWS key) and
`~/.env.production.backup` (a fake GitHub token, AI provider key and database password) —
after showing you the list, and only where no file of that name exists: your real files are
never touched. Each value is random and unique to your machine. No honest task sends them
anywhere, so if one appears in what Claude Code runs, writes, fetches or passes to an MCP tool,
or in the arguments of a tool behind `oathrion wrap` (any client), Oathrion refuses it — session
at risk or not — and says « your agent was most likely tricked by something it read ». The decoy
file's *name* is refused when the command sends something out, or when the session is at risk;
reading it alone, or naming it in a file, is not. `oathrion decoys list` shows them,
`oathrion decoys remove` takes them away (only what Oathrion planted and that has not changed
since). The rule is `decoy`, and can be disabled like the others. What it does not do: a decoy
copied in a transformed form (encoded, split) is not recognised, and a decoy read by Claude
Code's own `Read` is seen only when it is used.

**The tokens of the servers Oathrion protects leave your clients' configuration.** `npx oathrion`
moves them — environment variables named like a token, key, secret or password, and a remote
server's authorization headers — out of `~/.cursor/mcp.json`, `~/.claude.json` and Claude
Desktop's file into Oathrion's own vault (`~/.oathrion/_local/server-secrets/`, readable by you
only, and refused to Claude Code's tools and shell). The client's configuration keeps only the
`oathrion wrap` command, which gives the tokens back to the server when it starts. An agent
reading its client's configuration finds nothing to go around Oathrion with. `npx oathrion
--undo` puts every token back where it was; an existing installation is moved on the next
`npx oathrion` (« move token »).

**The tokens of the servers Oathrion protects are tripwires too.** When `oathrion wrap` starts
a server, it records the tokens it is given — environment variables named like a token, key,
secret or password, authorization headers, and what looks like a secret in its arguments — as
SHA-256 fingerprints only, never the tokens themselves (`~/.oathrion/_local/guarded-tokens.json`,
readable by you only). If one shows up anywhere else — in a command (a `curl` with the token an
agent found in a configuration file), in a file Claude Code writes, or in a call to another
tool — the agent is going around Oathrion: refused, and told to use that server instead (rule
`server-token`). Claude Code's shell and file tools are checked by the hook; every client's MCP
calls by the relay. The shell of another client (Cursor's) has no hook: there, only an agent
started inside an isolated environment cannot get around Oathrion.

**Heredocs.** What a heredoc (`<<EOF … EOF`) carries is read as commands only when it goes
to a shell (`bash <<EOF`). Sent to an interpreter (`python3 - <<EOF`), it is code, checked
for network access in a session at risk; otherwise (`cat > notes.md <<EOF`) it is data, and a
file that merely contains a download piped into a shell is not refused. A decoy, or a file
that guards the agent as the target, is caught either way.

**The journal.** Every judged call and its outcome (including a failure, with its exit code)
go to
`~/.oathrion/_local/claude-code/journal.jsonl`, each line chained to the previous one.
`oathrion receipts verify` checks it, on a line of its own: these are actions **Claude Code**
executed, not Oathrion, so they are kept apart from Oathrion's receipts. The journal keeps the
command and the path, never a file's content nor a command's output (a SHA-256 digest and a
size instead).

**Your own rules**, optional, in `~/.oathrion/claude-code-rules.json`:

```json
{ "disable": ["git-push"],
  "deny": [{ "id": "prod", "pattern": "psql .*prod", "reason": "no direct access to production." }],
  "ask":  [{ "id": "deploy", "pattern": "^kubectl apply", "reason": "a deployment." }] }
```

**What the rules read.** A command is read like the shell would split it: quotes, `;`, `&&`,
`||`, pipes, background `&`, subshells and groups, `if … then`, loops; and what runs a command
inside another — `bash -c "…"`, `sh -c`, `eval`, `xargs`, and prefixes such as `sudo -u …`,
`env -i`, `timeout 5`, `nice`. `cd` is followed, so `cd ~ && rm -rf *` is seen as a delete in
your home folder; `find … -delete` and `find … -exec rm` count as deletes; git's global options
(`git -C . push`) do not hide a push. The files that guard the agent (Claude Code's settings,
`.mcp.json`, `~/.oathrion`) are protected from the shell too: a redirection, `sed -i`, `cp`,
`mv` or `rm` that targets them is refused; reading them (`cat`, `grep`, `jq`) is not. In a
session at risk, a command whose program comes out of a substitution (`` `…` ``, `$(…)`, `$VAR`)
asks a person, since Oathrion cannot tell what it runs.

**Limits.** The rules still read the command line, not what it does. A script file can hide an
`rm`; a program built at run time from pieces is not recognised outside a session at risk;
`xargs` with targets coming from its input is not judged on them; a script downloaded to a file
and run later is not recognised as « from the network ». This is not a sandbox: Oathrion bounds
the common mistakes and the common tricks, and says what it saw. Claude Code's file reads
(`Read`, `Grep`, `Glob`) are not checked by the hook, with one exception: Oathrion's own secrets
(the console's session secret, the key that signs receipts, the decoy list, the database) are
refused to them by Claude Code itself, through `permissions.deny` rules set with the hook in
`~/.claude/settings.json` and removed with it. Verified with Claude Code 2.1.318; the hook
format belongs to Claude Code and can change.

## Remote servers

```bash
MCP_REMOTE_HEADERS='{"Authorization":"Bearer …"}' oathrion wrap --name docs --url https://mcp.example.com/mcp
```

A server your client reaches by URL is governed the same way as a local one: reads pass,
writes wait, destructive tools are blocked, receipts, pinned definitions. The local Oathrion
runs a small bridge (`oathrion bridge`) that speaks to the remote server and presents it as a
local one.
- **Transports**: Streamable HTTP (`--transport http`, the default) and the older SSE
  transport (`--transport sse`).
- **Headers** (usually a token) come from `MCP_REMOTE_HEADERS`, a JSON object, never from
  the arguments, which any user of the machine can read in the process list. `npx oathrion`
  moves them there from the client's configuration, and puts them back with `--undo`.
- **Tokens never travel in clear off your machine**: `https`, or `http` to `127.0.0.1` /
  `localhost` only. An SSE server that announces an address on another origin is refused.
  Neither the token nor the address beyond its origin is written to the log.
- **Not yet**: servers whose sign-in (OAuth) is handled by the client, such as a server
  added in Claude Code and signed in with `/mcp`. The client keeps those tokens, not the
  configuration, so Oathrion cannot stand in front of them yet; `npx oathrion` and the
  « Servers » screen name them.

## Receipts

```bash
oathrion receipts verify            # the local Oathrion (and any older per-server one)
oathrion receipts verify --name github   # the chain that holds this server's receipts
```

This command re-reads the whole receipt chain, read-only. Exit code `0` means the chain is
intact. `1` means it is broken: a receipt was edited, removed or reordered, or an executed
authorization has no receipt.

### A receipt you can share

In « Activity », every action has a **Receipt** button. It downloads one file,
`oathrion-receipt-<reference>.html`, that you can send to anyone: a client, a manager, an
auditor. They open it in a browser, with nothing to install, and see the action, the decision,
the outcome, and **✓ Verified** or **✕ Altered**. A single changed character makes it fail.

```bash
oathrion receipt verify oathrion-receipt-toolu_01.html   # the same check, without trusting the page
```

What it proves: the receipt has not changed since it was signed by the Oathrion holding the key
whose fingerprint is shown (an Ed25519 key, created on first use in
`~/.oathrion/_local/receipt-signing-key.pem`, readable by you only). Once sent, it is also a copy
outside your machine: rewriting the local record later no longer changes what you sent.

What it does not prove: that the action really happened beyond what Oathrion recorded, nor who
holds the key. Publish your fingerprint where the people you send receipts to can compare it. On
your machine, an agent that can read `~/.oathrion` could sign in your name; the team version
keeps its key away from the agents.

### No receipt, no merge: the receipt in the pull request

When Claude Code worked on a branch, the pull request can carry its receipt: every action it
took in the repository, what was asked of a person, what Oathrion blocked, signed.

```bash
oathrion receipt bundle            # on the branch: writes .oathrion/receipts/<branch>.json
git add .oathrion/receipts && git commit -m "Oathrion receipt"
```

It covers the branch since it left `origin/main` (or `--base <ref>`), and only this repository:
Claude Code's commands and file edits checked by Oathrion's hook, not MCP actions, which are not
tied to a repository. Since the file ends up in a repository, sometimes a public one, paths
become relative (`.`, `~`) and secrets recognisable in commands (tokens, `Bearer …`,
`password=…`) are redacted before signing. That is not a guarantee: read the summary it prints
before you commit it.

On the repository's side, the action in [`action/verify`](../action/verify/README.md) checks it
and writes the summary on the pull request; made a required check, no receipt means no merge.
`oathrion receipt verify .oathrion/receipts --github` is the same check anywhere. It fails when
the receipt was altered, when its fingerprint is not among `OATHRION_TRUSTED_FINGERPRINTS` (if
set), or when the commit it covers is not part of the pull request; commits made after the
receipt are reported as not covered.

### The summary, and what Oathrion stopped

The console opens on « Activity », headed by the summary: today (or the last 7 days), how many
actions went through on their own, asked a person, and were blocked, with the chains re-read
there and then. A recursive delete that Oathrion refused says what it would have deleted
(« would have deleted 48,312 files (3.2 GB) »), measured read-only at that moment, without
following links, and capped (« more than 200,000 files »).

## When a server changes its tools

On the first start, the tool definitions (name, title, description, schemas, annotations) are
pinned. On a later start, a tool whose definition changed, or a new tool, is **removed from
what your agent sees** until you accept it.

It is removed, and not merely held for approval, because a poisoned description is the attack
itself: showing it to the model would already deliver it.

```bash
oathrion tools list   --name github           # what is waiting, and which fields changed
oathrion tools accept --name github create_issue
oathrion tools accept --name github           # everything that is waiting
```

The acceptance takes effect the next time the server starts.

## Verified clients

| Client | Status |
|---|---|
| Cursor (`cursor-agent` 2026.10.22, headless) | **verified** on 2026-10-28 with a test server: the tools are listed under their original names, a read is answered, a write is held and never reaches the server, destructive tools are absent |
| Cursor (`cursor-agent` 2026.10.22, interactive) | **verified** on 2026-10-28 in front of the real `@modelcontextprotocol/server-filesystem`: a read is answered; `write_file` is held, approved in the console, and really writes the file; the receipt chain verifies |
| Claude Code (2.1.318) | **verified** on 2026-11-05 in front of the real `server-filesystem` and `server-memory`: reads answered without a question; writes held, approved in the console, then run (even after the agent gave up); deletions refused; the receipt chain verifies. **Not verified: the approval question inside Claude Code's chat.** Note: for local files, Claude Code uses its own built-in tools, which do not go through Oathrion |
| Claude Desktop | detected by `npx oathrion` since 2026-11-05; **not verified** |

**Cursor in headless mode** (`cursor-agent -p`) rejects every MCP tool call unless the project
allows it. Allow only the wrapped server, and keep the shell closed. Avoid `--force`, which
would open the shell too:

```json
// .cursor/cli.json
{ "permissions": { "allow": ["Mcp(github:*)"], "deny": ["Shell(*)"] } }
```

Cursor asks you to approve the server again whenever its configuration changes.

## An agent that cannot go around Oathrion: `oathrion jail`

An agent running freely under your account has your rights: it can read a file, find a token,
and call the service without Oathrion. On Linux, `oathrion jail` runs it where it cannot:

```bash
oathrion jail -- cursor-agent
oathrion jail --keep-env ANTHROPIC_API_KEY -- claude
```

To stop depending on a habit, it is the default: on Linux, `npx oathrion` offers it with the
rest (one answer), and `npx oathrion --undo` removes it. On its own:

```bash
oathrion jail --always
```

It puts a small launcher for `cursor-agent`, `claude` and `agy` in `~/.oathrion/bin`, and that
folder first in your `PATH` (a marked block in `~/.bashrc`, `~/.profile` and `~/.zshrc`, each
copied first to `<file>.oathrion-backup`). Open a new terminal: typing `cursor-agent` starts it
in the jail. The launcher looks for the real agent in your `PATH` each time, so an agent that
updates itself to a new folder is still found. `oathrion jail --always --undo` puts things back.

If the jail cannot start on this machine (bubblewrap missing, or Ubuntu's AppArmor), `npx
oathrion` says so at once, with the command to type, and puts nothing in place until it can.
The first time an agent runs in the jail, the jail tells you what may surprise it (for `agy`:
it may say you are signed out, because its login is in the keyring the jail hides; sign in
once inside, and it keeps its login in `~/.gemini`).

Inside the jail:

- **the system is read-only.** Only the project folder, `/tmp` and the agent's own folders
  (`~/.cursor`, `~/.claude`, `~/.claude.json`, `~/.cache`, `~/.npm`, `~/.config`,
  `~/.local/share`, `~/.local/state`) can be written;
- **your secrets are hidden**: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`,
  `~/.config/gcloud`, `~/.azure`, `~/.docker`, `~/.kube`, `~/.password-store`, `~/.config/op`
  appear empty; `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, `~/.pgpass`, `~/.pypirc` appear
  empty;
- **the project's secrets are shown empty**: `.env`, `.env.local`, `.env.production`…, keys and
  certificates (`*.pem`, `*.key`, `*.p12`), `credentials.json`, `service-account*.json`, up to
  four folders deep, dependencies left aside. A template (`.env.example`) stays as it is. The
  jail lists them when it starts; `--show-project-secrets` shows them;
- **the network is closed.** The agent reaches only the local Oathrion, and HTTPS to its AI
  provider, through a gate that runs outside the jail: `cursor-agent` reaches `cursor.sh`,
  `cursor.com` and `cursorapi.com`; `claude` reaches `anthropic.com`, `claude.ai` and
  `claude.com`; `agy` (Antigravity CLI) the Google APIs, `accounts.google.com`,
  `antigravity.google` and its settings and profile-picture hosts, not the whole of
  `google.com`; `codex` and `gemini` their own. Any other host is refused, with an answer the
  agent can read and pass on, and when the jail closes it lists them with the command that
  allows them: `--allow-host HOST` (a host and its subdomains). A program that ignores
  `HTTPS_PROXY` has no network at all. `--network open` gives the whole network back;
- **`~/.oathrion` is hidden**, except the local Oathrion's port and the *relay* secret of this
  jail, created by the local Oathrion for it alone and dropped when it closes. That secret only
  lets a relay do what a relay does (attach, start its server, get its key, ask a question, add
  to Claude Code's journal), and only for its own relays. It never opens the console, never
  decides, never gets an approval key: tried from inside, the console answers 403;
- **who the agent is, is decided outside.** `oathrion jail` identifies the program it starts
  (its real path and SHA-256) before starting it; inside, what a relay says about itself is
  ignored. **An agent never seen does not start**, even one without any MCP server: you get
  the notification, and the jail waits until you confirm it in the console (« Approvals »).
  Blocked there, it never starts;
- **environment variables that carry a secret are removed** (their name says token, key,
  secret, password…). `--keep-env NAME` keeps one the agent needs, such as its own API key;
- **your desktop session's sockets are hidden** (`/run/user/<uid>`, `SSH_AUTH_SOCK`,
  `DBUS_SESSION_BUS_ADDRESS`): your SSH and GPG agents, and D-Bus, through which the keyring,
  unlocked when you log in, hands out the passwords it keeps;
- **its MCP servers are only the ones you configured.** The local Oathrion runs *outside*,
  next to the tokens' vault, with the network. A relay from inside can only have it start the
  exact command of a server found in your clients' configuration, with that server's tokens
  taken from the vault outside, never with an environment sent from inside. Any other command
  is refused;
- its processes cannot see yours, and stop with it.

### Being told when an agent runs outside the jail: `oathrion watch`

While the local Oathrion runs, it looks at your processes every two seconds and recognizes the
AI agents by their real program, not by the name they give: `claude`, `cursor-agent`, `agy`,
`codex`, `gemini`, `aider`, `goose`, `opencode`, and the Cursor and Antigravity apps, including
an agent started by another agent. One that runs **outside** a jail of Oathrion, and that you
have not allowed there, is **paused at once**, like an antivirus puts a threat in quarantine:
it is frozen where it was (Linux's cgroup freezer: nothing it was doing is lost, and its shell
does not notice), its terminal says why, and you get a notification. In the console, « Running
now » offers « Resume, and allow it from now on » (remembered for that program), « Stop it »
(it and what it started), or the command to start it again in the jail. Measured: paused 3.4 s
after it started. A program Oathrion descends from is never paused; where the freezer is not
available, the agent is stopped by a signal instead (its shell then shows it as « Stopped »). « Running now », on the dashboard and the Agents page, shows
every agent running and where: in the jail, outside and allowed (by whom, when, with « Stop
allowing »), or outside without your leave. An agent counts as jailed only if it descends from a jail that `oathrion jail`
opened: starting `bwrap` yourself is not enough.

**The tripwire.** The decoys laid by `oathrion decoys plant` have no honest reader. While the
local Oathrion runs, anything that reads one, a known agent or not, in the jail or outside, is
reported within two seconds: a notification (with the agents running outside the jail at that
moment) and, in « Running now », the decoy and the time. It works without administrator rights
through the file's access time (Linux's default `relatime`; not on a system mounted
`noatime`), and it cannot say which program read: only that something did. Your real secrets
are not watched this way: `ssh` reads your keys at every `git push`.

The watch is meant to run all the time, like an antivirus for AI agents. On Linux,
`npx oathrion` turns it on with the rest (one answer), and `npx oathrion --undo` turns it off.
On its own:

```bash
oathrion watch --always
```

It becomes a service of your session (`~/.config/systemd/user/oathrion-watch.service`):
started with the session, even without a desktop, and started again by systemd within seconds
if it stops or is killed. `oathrion watch` stays attached to the local Oathrion and starts it
again if it stops, and starts itself again with the new version when Oathrion is updated: it
asks the older local Oathrion to make way at once when no agent depends on it, and the new one
answers on the same address a second or two later (the console already open finds it again).
An agent still attached to the older one keeps it running until that agent closes.
Without systemd for the session, it uses the desktop's autostart instead, and runs at once.
`oathrion watch --always --undo` turns it off.

The agent you run `npx oathrion` from (Claude Code, for instance) is allowed outside the jail
at once, and `npx oathrion` says so: otherwise the watch would pause the very conversation in
which you install Oathrion. Allow the other agents you run outside the jail on purpose (« Allow
outside the jail, from now on »), or they are paused too, until you resume them.

What the watch does not do: recognize an agent whose program it does not know; stop an agent
before it starts (it pauses it within seconds); look at another
account's programs; run elsewhere than on Linux, for now. And it runs with your rights: an
agent running outside the jail could turn it off (`systemctl --user disable`), as it could
anything else of yours. An agent in the jail cannot: it has no access to your session's bus.
Watching that no program of your own can stop needs a service with administrator rights: not
built yet.

Before starting, the jail checks that no token is left in a client's configuration (the agent
would read it there): if one is, run `npx oathrion` once, which moves it into the vault.

What the jail does not do:

- **Linux only**, with bubblewrap (`sudo apt install bubblewrap`). macOS and Windows: not yet.
  On Ubuntu 24.04, bubblewrap has no AppArmor profile and is refused its namespaces
  (« setting up uid map: Permission denied »): `oathrion jail` then prints the profile to add,
  with `sudo`, and how to remove it. That changes your system's security settings, so Oathrion
  never does it for you. The profile lets any program use bubblewrap to create a namespace.
- **The allowed hosts are allowed whole.** The agent can send what it reads in the project to
  its AI provider (that is its job), and to any host you add.
- **The agent's own edits in the project are not governed** (except Claude Code's, through its
  hook): review them as you would review any change, with git.
- **A secret committed to git** stays readable in the history, and a secret file created after
  the jail started is not hidden.
- **`/tmp` stays writable and shared** with the rest of the machine.
- **The decoys are not watched inside the jail**, and Claude Code's « session at risk » mark
  lives in the jail's own temporary space, where the agent could erase it.
- **An agent that keeps its login in the desktop keyring** (`agy`) is signed out the first time
  in the jail, where the keyring is hidden: sign in once inside; it then keeps its own login in
  its own folder (`~/.gemini`), never in your keyring.
- **A desktop app started from its icon** (Cursor, Claude Desktop, Antigravity) is not in the jail, nor an
  agent started by its full path; `--always` covers the commands typed in a terminal.
- **A flaw in the Linux kernel** would let a program out of any such jail. No program running
  on the same machine protects against that: only the team version does, where the tokens
  and the approver are on another machine.

## Files

`~/.oathrion/_local/` (`OATHRION_WRAP_HOME` moves `~/.oathrion`):

| File | What it holds |
|---|---|
| `oathrion.db` | rules, approvals, executions, receipts — for all servers and clients |
| `session.secret`, `port` | kept between starts, so the console stays reachable at the same address |
| `serveurs/<name>/commande.json` | a wrapped server's command and arguments, for `oathrion console`. Not its environment: a token passed as an argument would be written here |
| `serveurs/<name>/outils-acceptes.json`, `outils-vus.json` | the pinned and the last-seen tool definitions |
| `oathrion.log` | the full log of the local Oathrion |
| `server-secrets/<name>.json` | the tokens moved out of your clients' configuration, given to the server when it starts (readable by you only, refused to Claude Code, hidden in the jail) |
| `guarded-tokens.json` | the fingerprints (SHA-256) of the tokens given to protected servers, never the tokens: used to refuse them anywhere else |
| `servers.json` | the servers a jailed relay may have started (each jail's relay secret is kept in memory only, and in the jail's own temporary folder) |

Each client connection gets its own key, bound to its agent, revoked when it leaves; keys are
never written to disk. Older installations kept one folder per server (`~/.oathrion/<name>/`):
they are left as they are, and `oathrion receipts verify` still checks them.

## What it does not do

- **It only governs what goes through it.** If your agent also has the raw server in its
  configuration, it can bypass Oathrion. `wrap` never reads or edits your client's
  configuration. Your client's own tools are not governed either: in our Cursor trial, the
  agent ran shell commands and read files with Cursor's built-in tools, even with
  `"deny": ["Shell(*)"]` set for the project. Claude Code does the same, but since 5 November
  2026 its shell and file edits go through Oathrion's local rules (see
  [Claude Code's own tools](#claude-codes-own-tools)); its file reads do not.
- **It does not stop an agent that has an unrestricted shell on your machine.** No local
  tool running as your user can. Such an agent could read `~/.oathrion/_local/session.secret`
  and forge a console session, write to the database, or simply read a server's token in your
  client's configuration and call the service itself, around Oathrion. What Oathrion does:
  - the console's sign-in link is printed, and the browser opened, **only in a terminal**:
    run by an agent's shell tool, which has none, `oathrion console` gives the bare address;
  - the instructions Oathrion gives the agent tell it that only the person approves, and
    never to open the console, read `~/.oathrion`, or use a token found on the machine;
  - the database and the secret are readable by you only;
  - in Claude Code, reading them is refused: by its own permission rules for its file tools, and
    by Oathrion's hook for the shell (even `cat`). An agent in another client, or one whose
    shell you let run anything, can still read them.

  What you do: on Linux, **run the agent in [`oathrion jail`](#an-agent-that-cannot-go-around-oathrion-oathrion-jail)**;
  elsewhere, **keep your agent's shell under your client's own approval.** Don't let it run
  any command without asking. An agent that can neither approve itself nor go around
  Oathrion needs the team version: the approver is another person on another machine, and the
  tokens are in Oathrion's vault, not on the agent's machine.
- **The server's tokens are on your machine**, in Oathrion's local vault: hidden from the
  jail and refused to Claude Code, but readable by any program you run outside the jail.
- **The classification is a cautious heuristic, not a proof.** Correct it rule by rule.
- **Pinning covers what a server declares, not what it does.** A server that keeps its
  declaration and changes its behaviour is stopped by your rules and approvals, not by the pin.
- **Resources are not understood yet.** You cannot say « this repository and not that one » in
  a rule; the target of a call is `mcp://<name>/<tool>`.
- **One name, one command.** Two clients can share a server; a second server under the same
  `--name` with a different command is refused.
- **Permissions are per client, not per server.** Allowing « Destroy » for Cursor allows it on
  all of Cursor's servers. Each destructive call still waits for your approval.
- **No bridge to a team yet.** The local Oathrion and a team's Oathrion (the server in
  [Run Oathrion for a team](../README.md#run-oathrion-for-a-team)) are separate; moving a
  local setup to a team's is not built.

## Troubleshooting

| Message | What to do |
|---|---|
| « The name "…" is already taken by another command » | two different servers under the same `--name`: give one another name |
| « Port … is already taken » | another program uses the saved port; use `--port` |
| the console is unreachable | no client is running: run `oathrion console` |
| approving answers « No tool can run … right now » | the wrapped server is not running: the request stays pending; approve it once your client or `oathrion console` is open |
| « The local hub stopped while starting » | read `~/.oathrion/_local/oathrion.log`; the wrapped server's own error is usually the last lines |
| « Local Oathrion is not answering: the call was NOT passed to the MCP server » | the local Oathrion stopped; restart your client |
| a tool disappeared | `oathrion tools list --name <name>`: its definition changed |
| a tool is missing from the start | it is destructive and the agent lacks `mcp:destructive` (the start message lists how many). The filesystem server marks `write_file`, `edit_file` and `move_file` destructive itself |
