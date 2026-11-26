# Changelog

All notable changes to Oathrion are recorded here. Versions follow
[Semantic Versioning](https://semver.org/); during the preview, a minor version may break
compatibility, and the entry says so.

## [Unreleased]

## [0.1.0-preview.7] — 2026-11-26

- **Oathrion is a Claude Code plugin.** From inside Claude Code:
  `/plugin install oathrion --marketplace oathrion/oathrion`. Claude Code's own shell commands and
  file edits are then checked by the same rules as with `npx oathrion`: the most dangerous refused,
  risky ones asked, all of them journaled. The plugin does less than `npx oathrion` (no MCP servers,
  no phone, no rules against reading Oathrion's secrets); if both are installed, the plugin stays
  quiet, so nothing is judged twice. Needs Node 22 or later.

- **The limits page says what is true today.** `docs/not-yet.md` still said that you could not
  approve from your phone and that receipts carried no signature: both changed in preview.3
  and preview.4. It now says what a signed receipt proves and what it does not (who held the
  key), what the phone needs (your computer on and online), that an agent on your computer
  cannot make your phone's signature, and what runs on macOS and Windows at every change. The
  README and `docs/wrap.md` describe pairing your phone in one scan, not only Telegram.

## [0.1.0-preview.6] — 2026-11-23

- **Statements and receipts read like a conversation, not a log.** A client's statement now
  opens with one sentence (« Your agents did 129 things in this project, from 1 to 23 November.
  A person decided 4 times, each on their phone. Oathrion stopped 2 actions. »), then the work
  week by week, folded: « 3 Nov – 7 Nov · ran the tests 5 times, changed 8 files… ». Unfold a
  week and each kind of step is one line in plain words (« Ran the tests · 5 times »); unfold it
  for the exact commands. What matters is never folded: each decision a person made, with their
  phone's signature, and each action Oathrion stopped. The proof is at the bottom, under « How do
  I know this is true? ». A receipt says the action in words first (« Publish the code to the
  shared repository »), with the command under « Show the exact command ». Dates are in English,
  like the page, and the seal now shows when printed.

## [0.1.0-preview.5] — 2026-11-23

- **Your agents now ask like a friend would.** A request reads like a message from your agent,
  under the name and face you gave it: « elias — Can I publish your code to the shared
  repository? Your team will see it. », with the exact command underneath. No rule names, no
  « Why: Oathrion: … ». The buttons answer the question: « Yes, go ahead » and « No » (and « Yes,
  for 1 hour »), and after your answer the agent replies: « Thanks, I'm going ahead. » or « OK, I
  won't do it. ». Several questions at once: « I have 3 questions for you. ». When Oathrion acted
  itself (it paused an agent started without it, something read a fake password, a program it has
  never seen), Warden says so in plain words. The same words everywhere: the notification on your
  computer, the one on your phone and its page (the question, what it changes, then the command),
  and the request waiting in the console. What is kept (your « Was this right? » answers, the
  phone's signed approval) does not change.

## [0.1.0-preview.4] — 2026-11-23

- **Send proof to a client: a statement that checks itself, with each decision signed on the
  person's own phone.** « Send proof » on Home and on each passport asks who it is for. « A
  client »: choose the project folder (and the MCP servers) you worked on for them and a period;
  the preview shows exactly what will be in it; download a page that checks its own signatures
  in any browser, offline, and a message ready to paste. It lists what your agents did there,
  each decision a person made, and what Oathrion stopped (« would have deleted 49 files »).
  Paths are written « . » and « ~ », and secrets in commands are masked before signing. « A
  reviewer »: the branch receipt for the pull request. From a terminal: `oathrion receipt report
  --project <folder> [--server <name>] --for <client>`.
- **A decision made on your phone now carries your phone's own signature.** The phone's page
  signs what it showed you (the agent, the computer, the title and the reason) with a key its
  browser keeps; your computer checks it and keeps it. Receipts, branch receipts, statements and
  passports carry it, and `oathrion receipt verify` and the pages check both signatures: if the
  approval inside a signed document does not check, the whole document is « Not valid ». It is
  the one proof your computer cannot make alone: it says a paired phone gave this answer to this
  text, not who held the phone. Activity shows « Signed on <your phone> », or « No phone
  signature ». Needs the relay's new page (the phone's page signs the approval).
- **Passports download as a page** that checks itself, instead of JSON (`?format=json` still
  gives the JSON).

## [0.1.0-preview.3] — 2026-11-23

- **Pair your phone in one scan, with no app.** In the console, « Approve from your phone » →
  Pair my phone shows a QR code; your phone's camera opens Oathrion's page; tap Allow
  notifications, and the console says « Paired ». No app to install, no account, nothing to copy.
  Your agents' requests then reach your phone as notifications, with Approve and Reject, wherever
  you are (on iPhone, add the page to your home screen first). Each notification is encrypted on
  your computer for your phone alone: Oathrion's relay (`relay/`, open source) passes it on
  without being able to read it, and keeps nothing but revocations. Each press is signed by a key
  your phone's browser keeps; your computer checks it, and a press decides once. Unpair in the
  console, or « Unpair this phone » on the page. Telegram still works: your own bot (« Use your
  own Telegram bot instead », `oathrion phone telegram`), or an official bot the relay can carry.
  Self-hosting the relay: `OATHRION_PHONE_RELAY_URL` and `OATHRION_PHONE_RELAY_KEY`.
  The two screens answer each other: the console shows the moment your phone opens the page,
  and the page says which computer it pairs with (you name your phone there). Each notification
  carries the agent's mascot, the computer it comes from and its own vibration; touching it
  opens a decision page in the passport style — who asks, the command on its own line, why,
  Approve first, Reject plainly, « Allow 1 hour » apart — then « Was this right? ». Once
  paired, the console shows Warden, « Connected » and the last notification. Notifications
  have no buttons by default — Chrome on Android flags notifications with buttons as possible
  spam — and touching one opens the decision page; buttons in the notification are an option
  there. A connection to the relay that goes silent is noticed within 75 seconds and remade.

- **The console is built around each agent's passport.** On your machine, Home is now
  « Your agents »: one passport per agent, in glass and light, with Oathrion's ring, the agent's
  mascot and name, what it did over 7 days (what went through, asked you, was blocked), and the
  last action Oathrion stopped. A decision that waits shows on top, with « Allow once » and
  « Stop ». « Open passport » shows the whole passport — identity, permissions, tools, record,
  protected since, audit trail — and, under it, what this agent did, what it may do, its tools
  and its receipts. « Share passport » downloads it signed, for `oathrion receipt verify`. The menu
  is now Passports, Decisions, This machine and Send feedback; the other pages are under
  « Details ». The local console is dark only, and its font (Exo 2) ships with Oathrion.

## [0.1.0-preview.2] — 2026-11-23

- **An agent's passport, signed.** `oathrion receipt passport --agent "Claude Code"` signs who an
  agent is (the program a person admitted and its fingerprint), what it may do (the tools it
  reached, the hook's rules in force) and what it did over a period (what went through, asked a
  person, was blocked, and the last action Oathrion stopped). Facts, not a rating. Nothing is
  sent; `oathrion receipt verify` checks it and refuses an altered one without showing it.

- **Destroying production now needs a person, in Claude Code.** In April 2026, an AI agent
  deleted a company's production database in 9 seconds, with a single call to its hosting
  provider's API and a token that could do everything (PocketOS, on Railway). Oathrion let that
  kind of call through. Four new rules ask a person first, and the question says what would be
  destroyed:
  - `cloud-destroy`: the hosting and cloud CLIs, such as `railway delete|down|volume delete|environment delete`,
    `fly apps destroy`, `fly volumes destroy`, `heroku apps:destroy`, `heroku pg:reset`,
    `vercel remove`, `netlify sites:delete`, `render … delete --confirm`, `supabase projects delete`,
    `gcloud … delete`, `aws … delete-*|terminate-*`, `aws s3 rm|rb`, `az … delete`,
    `doctl … delete`, Neon, PlanetScale, Turso and `wrangler … delete`.
  - `infra-destroy`: `terraform destroy`, `terraform apply -destroy`, `terraform apply -auto-approve`
    (OpenTofu and Terragrunt too), `pulumi destroy`, `kubectl delete` (a pod or a job stays
    free: its controller recreates it), `helm uninstall`, and `kubectl scale --replicas=0` in a
    namespace or context named for production.
  - `db-reset`: `prisma migrate reset`, `prisma db push --force-reset|--accept-data-loss`,
    `rails db:drop|db:reset`, Django `flush`, Laravel `migrate:fresh|db:wipe`, `supabase db reset`
    (the question says whether it is the linked remote database), `dropdb`,
    `redis-cli FLUSHALL|FLUSHDB`, and the Ecto, Sequelize and TypeORM equivalents.
  - `api-destroy`: `curl`, `wget`, HTTPie or `xh` sending a `DELETE`, or a GraphQL mutation that
    deletes (`volumeDelete`), to a known hosting API (Railway, Fly.io, Heroku, Vercel, Render,
    DigitalOcean, Netlify, Supabase, Neon, PlanetScale, Cloudflare, AWS, Google Cloud, Azure…).

  Reads stay free: `terraform plan`, `kubectl get`, `railway logs`, a `curl` without a method.
  Measured on the comparative benchmark, with 24 new dangerous actions and 14 new look-alikes:
  101 of 109 dangerous actions stopped (67 before), no new false positive, and the typical
  session asks exactly as often as before (9.2 questions per 100 actions). Each rule can be
  turned off like the others.

- **A signed report of a period, for whoever asks what your agents did.**
  `oathrion receipt report` (the last 30 days, or `--days`, `--since`, `--until`) signs what
  the agents Oathrion protects on this machine did: how many actions went through, asked a
  person (approved, refused, waiting) and were blocked, per agent and per rule, the blocked
  actions, and whether both records were intact. It is written to a JSON file and nothing is
  sent. `oathrion receipt verify` checks it offline, and refuses an altered one without showing
  its content. `--counts-only` keeps numbers only; `--for` names who it is for.

- **Three more dangerous commands are stopped in Claude Code.** An adoption benchmark replayed
  a typical 98-action agent session against the hook's real rules. Five of its 17 dangerous
  actions went through, and they are now covered:
  - `git reset --hard` and `git clean -f` (without `-n`) are asked: they throw away work that
    nothing can restore. The question says when `-x` would also delete ignored files such as
    `.env`.
  - `DROP`, `TRUNCATE`, a `DELETE` without `WHERE`, and MongoDB's `drop()` or
    `deleteMany({})`, sent through `psql`, `mysql`, `sqlite3`, `mongosh` and similar tools,
    are asked.
  - A delete written as a one-line script (`python -c`, `node -e`, `ruby -e`, `deno`, `bun`,
    `perl`) is refused when it names a path outside the project, and asked when its path is a
    variable Oathrion cannot read.

  Measured on the same session: every dangerous action is stopped (17 of 17), the 7 that must
  be refused are refused without a question, and none of the 81 safe actions asks anything —
  9.2 questions per 100 actions, against 73.5 for Claude Code's default mode (modelled). Each
  rule can be turned off like the others (`git-discard`, `sql-destroy`, `script-delete`).

- **What the other free hooks stopped, Oathrion stops too.** A comparative benchmark
  (`script/bench/`, a frozen corpus of 222 actions) showed eight dangerous commands that at
  least one other hook for Claude Code stopped and Oathrion let through. They are now covered:
  - `rm -rf "$BUILD_DIR/"`, a path Oathrion cannot read, is asked: if the variable is empty, it
    deletes from the root. `${BUILD_DIR:?}` and `$(mktemp -d)` stay free.
  - A variable set earlier on the same line is read: `D=~; rm -rf "$D"` is refused like
    `rm -rf ~`.
  - A script sent through a pipe is read: `printf 'rm -rf ~' | sh`, and
    `echo ~/other | xargs rm -rf`.
  - `git branch -D main` (or `master`, `trunk`, `develop`, `production`) is asked.
  - `gh pr merge`, `gh release create|delete|upload` and `gh repo delete|archive|rename|transfer`
    are asked.
  - A secret file sent out of the machine is asked, even outside a session at risk:
    `curl -d @.env …`, `cat ~/.ssh/id_rsa | curl …`, `scp .env host:`. A key given to `-i`, a
    file received with `-o`, and templates such as `.env.example` stay free.

  Measured on the same corpus: 67 of 85 dangerous actions stopped (58 before; the three other
  hooks, modelled from their source code, stop 30 or 31), with no new false positive and no new
  question in the typical session. The new rules turn off like the others (`rm-unreadable-path`,
  `gh-publish`, `secret-egress`).

## [0.1.0-preview.1] — on npm since 2026-11-17

What the first users asked for, in the first trials with a real client (Cursor, in front of the
real filesystem server). Upgrading from `0.1.0-preview.0` needs nothing: the data of the
per-server folders (`~/.oathrion/<name>/`) is left as it is, and `oathrion receipts verify`
still checks it.

- **The interface is in English** — the command line, the question asked in your client, the
  desktop notifications and the console. `0.1.0-preview.0` spoke French. Its options keep
  working under their French names, so configurations it wrote still start: `--annuler` is now
  `--undo`, `--oui` `--yes`, `--sauf` `--except`, `--approbation` `--approval`,
  `--garder-questions-claude` `--keep-claude-prompts`, `--attendre` `--wait`,
  `--sans-navigateur` `--no-browser`; `oathrion retour` is now `oathrion feedback`. The
  screens of the team version (connectors, coverage, the HTTP firewall) are still in French.

- **`npx oathrion`: one command, one answer.** Finds the MCP servers of Claude Code and
  Cursor on the machine — including those added with `claude mcp add`, in `~/.claude.json`,
  for every project — shows them, and puts Oathrion in front of all of them. Each file is
  copied first; `~/.claude.json` is changed through Claude Code's own commands; the client
  runs the exact same version. In Claude Code, a rule `mcp__<server>` lets Oathrion be the
  only one to ask, so an action is asked about once, not twice; it is added only for a server
  really under Oathrion (`--keep-claude-prompts` to keep both). `npx oathrion --undo`
  undoes it all; `--except <name>` leaves a server out. Verified on Linux; on Windows it writes the `cmd /c npx …` form that Claude
  Code documents, not yet tried there. Measured: 93 ms to write the
  configuration, 0.85 s until the server lists its tools behind Oathrion.
- **`oathrion install cursor|claude-code`**, for one client and one file: shows each change,
  asks, keeps a copy, warns if a server is still declared elsewhere without Oathrion.
- **One Oathrion for the whole machine, one agent per client.** All wrapped servers and all
  clients share one local Oathrion (`~/.oathrion/_local/`): one console, one receipt chain.
  Each client appears under its own name (« Cursor », « claude-code »), and two clients can
  share a server. It stops by itself a little after the last client or console leaves.
- **Remote servers.** A server reached by URL, with its token in the client's configuration,
  is governed like a local one: `oathrion wrap --url …` (Streamable HTTP or the older SSE
  transport), and `npx oathrion` protects those it finds. The token moves to the
  environment, never the arguments, and never travels in clear off the machine. Servers
  whose sign-in (OAuth) is handled by the client are not supported yet.
- **Decide once.** For a write tool, the question offers « only this time », « until the client
  closes », or « always » (a rule in the console, which holds across restarts); the console
  has « Approve, don't ask again ». A destructive tool still asks every time.
- **« Servers » in the console.** Each server under Oathrion, the client using it, and its
  last action; and the servers of Claude Code and Cursor that go around Oathrion, with the
  command that protects them.
- **You are told.** A held action shows a desktop notification, by default, whose **Decide**
  button opens the console already signed in: on Linux, macOS (a dialog) and Windows (a
  Windows notification, through a one-time link); macOS and Windows not tried on a real
  machine yet. `oathrion notifications slack <url>`
  also posts it to Slack (no buttons: the console listens only on your machine).
- **The answer arrives as soon as you approve**: 40 ms after the approval instead of up to one
  second, measured by `script/mesure-fluidite.mjs`.
- **No relaunch after allowing a tool.** The relay tells the client that its tool list
  changed (`notifications/tools/list_changed`), for clients that honour it, and gives the model
  instructions about holds and withheld tools.
- **Approve in your client, by default.** When the client says it can ask a question
  (Claude Code 2.1.312 does), the approval appears in it, with a box to tick, « Yes, I
  approve this action » — an *Accept* without the box, from a client answering on its own, is not a
  decision. Meanwhile the desktop notification waits 10 s and is sent only if nothing was
  decided: one question, not two. `--approval console` keeps decisions in the console.
  Claude Code's exact opening sequence (`server/discover`, then `initialize`) is replayed in
  the tests; it is shown under its own name, « Claude Code ».
- **No receipt, no merge.** `oathrion receipt bundle`, on a branch an agent worked on, signs
  what Claude Code did in the repository since the branch started — what went through, what a
  person was asked, what Oathrion blocked — into `.oathrion/receipts/<branch>.json`, to commit
  with the branch. `oathrion receipt verify <folder> --github` checks it in a pull request and
  writes the summary there; the action in `action/verify` runs it, and as a required check, no
  receipt means no merge. Paths become relative and recognisable secrets are redacted before
  signing; it covers what went through Oathrion's hook, nothing else, and says so.
- **The session at risk.** Oathrion does not guess a prompt injection; it knows where what the
  agent read came from. Once Claude Code has read a web page, a search, an issue, a comment or a
  message, what its session sends out next (the network, a push, a publication, a message) or
  installs for later (CI, git hooks) asks a person, with the source: « this session read
  untrusted content (WebFetch evil.example) ». The approval card says it first. Rerunning
  `npx oathrion` updates an existing hook.
- **The hook's rules, hardened after an audit.** A command rewritten to hide what it does is
  still judged: nested shells (`bash -c`, `eval`, `xargs`), subshells and groups, background
  `&`, `if`/`then` and loops, prefixes (`sudo -u`, `env -i`, `timeout`), quoting tricks, `cd`
  before a delete, `find -delete`, git's global options. The files that guard the agent are
  protected from the shell too, not only from the file tools. A script fetched and handed to an
  interpreter, or run through a substitution, is refused like a download piped into a shell. In a
  session at risk, DNS lookups and echo requests count as sending something out, and a command
  whose program Oathrion cannot read asks. What remains is written in the documentation.
- **Approving, smoother — found in a real trial with Claude Code 2.1.319.** Decide in the
  console while the question is shown in Claude Code's chat, and the agent goes on at once
  (it used to wait about 50 seconds); the question in the chat is withdrawn. Its second line
  says how to answer, since Claude Code shows only the first lines: Space ticks the box, ↓ to
  Accept, Enter; Esc if you already decided in the console. When a server answers with an
  error, the agent now reads that error (« Access denied - path outside allowed
  directories ») instead of only « the execution failed ». The desktop notification waits
  10 seconds, not 20, when the question is already in the chat. `--undo` leaves Claude
  Code's settings exactly as they were.
- **`oathrion jail -- <agent>`: an agent that cannot go around Oathrion** (Linux, bubblewrap).
  The agent runs with the system read-only outside the project, your secrets (`~/.ssh`,
  `~/.aws`, `~/.config/gh`, `~/.netrc`…) and Oathrion's own files hidden, the environment
  variables that carry a secret removed (`--keep-env NAME` keeps its own API key), and the
  desktop session's sockets hidden (the SSH agent, D-Bus and its keyring). On Ubuntu 24.04,
  where AppArmor refuses bubblewrap its namespaces, it says how to allow it. Its relays
  sign with a *relay* secret that never opens the console nor decides, and can only have the
  local Oathrion, running outside, start the exact command of a server you configured, with its
  tokens from the vault. Tried for real: the SSH key, the console's secret and `GITHUB_TOKEN`
  are out of reach, the console answers 403, and a relay asked to start a shell is refused.
  Then, to leave no way around it: **the network is closed** but for the local Oathrion and
  HTTPS to the agent's AI provider, through a gate outside (`--allow-host HOST` adds one, any
  refused host is listed); **the project's `.env` files and keys are shown empty**; **who the
  agent is, is decided outside**, by `oathrion jail`, and each jail has its own relay secret,
  dropped when it closes, which touches only its own relays; and **`oathrion jail --always`**
  makes `cursor-agent` and `claude` start in the jail from any terminal (`--undo` puts it
  back). Not yet: `/tmp` is shared, the decoys are not watched inside, and it is Linux only.
- **Every new agent is stopped at the door, and one running outside Oathrion's protection, you
  are told.** An agent `oathrion jail` has never seen does not start, even without any MCP
  server: you get a notification, and it waits until you confirm it in the console. And while
  the local Oathrion runs, it recognizes the AI agents among your processes by their real
  program (`claude`, `cursor-agent`, `agy`, `codex`, `gemini`…, the Cursor and Antigravity
  apps): one running outside a jail, you get a notification, and the console offers to stop it
  or to allow it there. Like an antivirus for AI agents, it runs all the time: `npx oathrion`
  turns it on (a service of your session, started again if it stops), `--undo` turns it off.
  Linux.
- **Give each agent a face** (local). In the console (Agents, or the mascot in « Running
  now »), choose an agent's mascot among seven and give it a name, with a preview of its
  notification. The choice holds for the whole agent (« Claude Code » and `claude` are one) and
  shows at once in the notifications, the feed, the share card and the console. Kept on the
  machine (`mascot-choices.json`).
- **The console looks like the site**: light by default (dark, neutral, one click away), the
  Source fonts shipped in the package (SIL Open Font License, in `NOTICE`; nothing loaded from
  the network), a menu of words without icons, each agent's mascot, and how protected the
  machine is, always in view at the foot of the menu. Nothing moves under the pointer any more:
  cards no longer lift on hover, and notices that load late sit below the requests, so a click
  on « Approve » or « Reject » lands where you aimed.
- **`oathrion demo`: see it in ten seconds.** Shows Oathrion's notification on a pretend
  agent, Nova: nothing real is paused. Click « Stop », then « Share it ». `--decoy` shows the
  red one, for a decoy read. `npx oathrion` suggests it at the end.
- **A notification you want to share** (Linux). The window follows the mascot's colours: the
  mascot big, « Stop », « Resume this time », « Allow ». After your click, the same window says
  what was done, asks 👍 / 👎, and offers « Share it »: LinkedIn, X, WhatsApp, Copy image. The
  card (1200 × 630) is copied to the clipboard and the network opens with the text; paste the
  card in your post. A decoy read comes in red, with « See what happened ». What is shared
  says nothing private.
- **A simpler console, with a news feed** (local). Five pages: Home, Approvals, Agents,
  Protection, Settings; « Details » keeps Activity, Servers and Policies (the pages of the team
  version stay reachable, out of the menu; an agent's page no longer shows payment mandates,
  costs or team scopes). Home answers three questions: are my agents protected, does anything
  wait for me (only what waits now), and **what did Oathrion stop**, each with its receipt one
  click away; then the 8 latest events, in plain sentences (« asked to create note on the
  carnet server; you approved »), with each agent's mascot. « Running now » shows one line per
  agent and state, details folded away. Settings shows how each protection stands
  (notifications, your phone, agents started without Oathrion, secrets out of reach, fake
  secrets). **Share**, on the moments Oathrion protected you and in its notification window,
  makes a card to post (the mascot, a sentence, the date, « Protected by Oathrion ») with nothing private on
  it: no path, file name, command or process number; download it, copy the text, or send it
  to X, LinkedIn or WhatsApp. A paused agent you then stop (`kill`, Ctrl+C) is thawed so it
  really stops.
- **Decide from the notification, without the console** (Linux). « Approve » / « Reject » a
  request, « It's mine » / « Block it » a program never seen, « Resume » / « Stop it » an
  agent paused outside the jail, « It was me » / « Not me » a decoy read; then « Was Oathrion
  right? » 👍 / 👎, kept on the machine only. On Linux, it is Oathrion's own window, top right:
  the agent's mascot (drawn for Oathrion: Ember, Pixel, Nova, Bolt, Echo…), the message, two
  buttons, and the 👍 👎 in the same window, which then says what was done. Old notifications
  no longer pile up: the windows close with the local Oathrion.
- **An agent outside the jail is paused, like a threat in quarantine.** Within a few seconds
  (3.4 s measured) of an AI agent starting outside a jail of Oathrion without your leave, it is
  frozen where it was: nothing lost, its shell unaware, its terminal told why, and you notified.
  You resume it (and allow it from then on), stop it, or start it again in the jail. An agent
  started by another agent is now seen too.
  The agent you run `npx oathrion` from (Claude Code, say) is allowed outside the jail at
  once, and told: otherwise the conversation in which you install Oathrion would be paused.
- **The tripwire: a decoy read, you are told.** Anything that reads one of the decoys laid by
  `oathrion decoys plant`, a known agent or not, in the jail or outside, is reported within two
  seconds, with the agents running outside the jail at that moment. No administrator rights
  (the file's access time). In the jail, decoys are now mounted read-write: on a read-only
  mount, Linux does not record the access.
- **« Running now », in the console.** When all is well, Oathrion says nothing; the dashboard
  and the Agents page now show every AI agent running on the machine and where: in the jail,
  outside and allowed (by whom, when, and « Stop allowing »), or outside without your leave.
  The same panel on the Approvals page; and a console left open reloads itself when Oathrion
  is updated, instead of showing the older version.
- **Slow connections no longer drop.** Node gave each address of a host only 250 ms; where
  reaching a service sometimes takes longer, connections failed (3 times in 8 in a real trial,
  in Senegal), and an agent in the jail lost its sign-in. Oathrion now gives each address
  2.5 s, for all its outgoing connections.
- **One command for the whole protection.** On Linux, `npx oathrion` now also offers the jail by
  default and the agent watch, in the same single answer, and `--undo` removes them. If the jail
  cannot start here (Ubuntu's AppArmor, no bubblewrap), it says so at once with the command to
  type, instead of letting an agent run into it. After an update, the local Oathrion makes way
  for the new version in about a second, on the same address. The first time an agent runs in
  the jail, it is told what may surprise it. The agents running outside the jail show on the
  Agents page and the dashboard too.
  `agy` (Antigravity CLI) runs in the jail too, with only the Google hosts it needs. A local
  Oathrion started before an update is recognized: the jail refuses to start on it, and says
  what keeps it running.
- **Servers' tokens leave the clients' configuration files.** They used to sit in clear in
  `~/.cursor/mcp.json` and `~/.claude.json`, where an agent could read them. `npx oathrion` now
  moves them into Oathrion's own vault (readable by you only, refused to Claude Code), and
  `oathrion wrap` gives them back to the server when it starts. `--undo` puts them back exactly;
  an existing installation is moved on the next `npx oathrion`.
- **A protected server's token, used anywhere else, is refused.** Seen in a real trial: an agent
  that could not reach a server read the client's configuration, found the server's token, and
  tried to call the service with it. Oathrion now records the tokens it gives each server, as
  fingerprints only, and refuses a command, a file or another tool's call that carries one:
  that is going around Oathrion. Claude Code (through the hook) and every client's MCP calls.
- **Programs Oathrion has never seen are kept out until you confirm them.** A client's name
  proves nothing: Oathrion now identifies the program that really started each server — its
  executable and SHA-256 fingerprint, found by walking up the parent processes — and gives no
  key to one it has never seen. Nothing it asks goes through, not even a read, and it is told
  why. The console shows it in « Approvals » with what it says it is next to what Oathrion
  knows; confirm it and it goes on by itself within seconds, or block it. `npx oathrion`
  confirms Claude Code in advance. Linux and macOS; on Windows, the client's name only.
- **Oathrion's secrets are out of the agent's reach in Claude Code.** The console's session
  secret, the key that signs receipts, the decoy list and the database cannot be read by the
  shell (refused by the hook, even `cat`) nor by Claude Code's file tools (`permissions.deny`
  rules set with the hook, removed with it): an agent tricked into approving its own requests
  can no longer take the secret that would let it. Rerunning `npx oathrion` adds them.
- **Mandates fail closed.** An unreadable date, the same person listed twice, an amount that is
  not a positive number, or a malformed document is refused with its reason. In
  `@oathrion/verify`, `verifyDualReceipt` now requires `trustedIssuers`: without it, anyone could
  make a mandate, an authorization and a receipt with keys of their own, and all three verified.
- **Decoys, and saying what would leave.** `oathrion decoys plant` puts fake, unique secrets
  where an attacker would look (`~/.aws/credentials.backup`, `~/.env.production.backup`), only
  where no file of that name exists, after showing the list. If one appears in what Claude Code
  runs, writes, fetches or passes to an MCP tool, or in a tool call behind `oathrion wrap`, it is
  refused: the agent was most likely tricked. In a session at risk, the question now names what
  would go out (« with a GitHub token in it », « with .ssh/id_rsa in it »), and a web fetch or an
  MCP call carrying a recognisable secret asks too. `oathrion decoys remove` takes them away.
  Rerunning `npx oathrion` updates the hook so it sees web and MCP calls before they run.
- **A receipt anyone can check.** Every action in « Activity » has a **Receipt**: one HTML
  file, signed (Ed25519, a key created on first use, readable by you only), that anyone opens
  in a browser and sees **Verified** or **Altered**, with nothing to install.
  `oathrion receipt verify <file>` is the same check without trusting the page.
- **The receipt, the moment you decide.** After « Approve » or « Reject » in the console, the
  request turns into its signed receipt — what was done, by which agent, sealed by your
  Oathrion — and **your browser checks the seal** there and then. « Try to change it » flips
  the decision in a copy, and the browser answers that it was changed after it was sealed.
  Each past decision keeps its receipt; on Linux, Oathrion's window offers « Your signed
  receipt » after you decide.
- **The summary.** « Activity »: today or the last 7 days, what went through, what asked a person, what Oathrion blocked, with both chains re-read there and then.
  A recursive delete Oathrion refused says what it would have deleted (« would have deleted
  48,312 files (3.2 GB) »), measured read-only, capped.
- **Claude Code's own shell and file edits are checked.** `npx oathrion` installs a hook, once,
  for all projects, as soon as Claude Code is on the machine: obviously dangerous commands are
  refused, `git push` and publishing are asked, and everything goes to a chained journal. Three
  rules come from real reports where nothing stopped the agent: `rsync --delete` into the root
  or outside the project is refused, and asked when its destination is a variable Oathrion
  cannot read (it may be empty); `docker … prune`, `volume rm` and `compose down -v` are asked;
  deleting the project's `.git` is asked. In
  auto mode, Oathrion asks a person itself, in the console or through a notification. It reads
  the command line, not what a script will do; file reads are not checked.
- **« Activity » and « Protection ».** One timeline of everything your agents did, through
  Oathrion and by Claude Code itself, exportable as JSON or CSV; and, agent by agent, what
  Oathrion covers on this machine and what it cannot see.
- **Fewer interruptions, and you know what you approve.** A notification says what the agent
  wants to do, on what exactly, and why Oathrion asks (« “Invoice F-2026-114 paid” · Why: your
  rule “carnet: every write waits for approval” »); on the phone, without the content.
  Requests close together become one notification, which lists them. **« Allow 1 hour »**, on
  the notification, the phone and the console, lets this agent use this tool for an hour
  without asking: each request still goes through the rules and leaves its receipt, approved
  in the name of that permission; it expires even across a restart, and never covers Claude
  Code's own commands. After three approvals in a row of the same tool, the console offers to
  decide once. An answer to the
  question in your client still counts after the agent was told to wait.
- **A calmer console.** No font loaded from the network; approvals, notifications and the feed
  read as sentences (« Cursor wants to create note on the carnet server »), with no jargon
  (« running without Oathrion's protection », not « outside the jail »).
- **Fixed, found on real machines:** after the machine slept, a relay could keep a revoked key
  and refuse every call until restarted; the console answered « Not Found » when Oathrion was
  installed under a hidden folder (`~/.nvm/…`); a hook installed in both a project and the user
  settings judged each command twice.
- **Fixed:** an agent working fast (several reads in parallel) hit the team server's rate
  limit, 120 decisions a minute, and got « Too many requests »; locally the limit is now 20 a
  second. The « Servers » screen counted at most 1,000 actions; it now counts in the
  database.
- **Fixed, found by a 12-hour run at 5 calls a second** (119,209 calls, no error): the local
  database kept every tool answer in full and grew to 1.5 GB in 2.5 hours — a large answer is
  now kept as its size and hash, while the agent still receives all of it; a key renewed by the
  hub made a few calls fail with « Invalid credentials » — the relay now waits for the new key
  and replays once; the monthly quota of a shared server stopped every call at the
  100,000th of the month — locally it now measures without refusing; each call summed the
  day's spend even with no daily budget, and slowed down as the day went on; the local log
  kept the start of each tool answer — it now keeps status lines only.
- **Pair your phone from the console.** « Pair my phone » (Settings, or the setup card on
  Home): BotFather opened in Telegram Web on this computer, the messages to send copied in one
  click, the token pasted and checked, then a QR code to scan; the console sees the pairing
  arrive and sends a test. The phone stays optional; pairing in one scan, without making a
  bot, is next.
- **Fixed, found on a slow connection:** `npx -y <package>` asked the npm registry at every
  start, even for a cached package (16 s once, more than 60 s sometimes), so a different server
  failed to start each time. A server started by `npx` now prefers the cache
  (`npm_config_prefer_offline`), and asks the registry only when the package is missing; a
  setting of yours (`prefer-offline` or `prefer-online`) is kept.
- **Fixed:** a dialog taller than the screen cut its title and buttons (it now scrolls); « New
  policy » opened, locally, on refunds and euros (it now opens on « Ask me first », with tool
  examples); « Needs you » counted events of the last 24 hours, even settled ones (it now counts
  what waits); refusing a request also listed « Oathrion blocked » (only « you refused » now).
- **Fixed:** a server started from a relative path was not found; approving an action whose
  server is not running consumed the approval (now `409`, the request stays pending); a slow
  server start (`npx`) could cost the client its key.
- **Words, not code.** The console says what an agent did in words (« Delete files », « Write
  file · on the fichiers server »), with the exact command in small print underneath. Settings
  no longer show commands: each one appears, ready to copy, only when you ask for it. Technical
  details (raw data, rule code) are folded away.
- **Send feedback.** It is in the menu, and on Home when you answered « No » to « Was Oathrion
  right? ». Your notes and your answers go in an e-mail to contact@oathrion.com, which you read,
  change and send yourself. Nothing leaves your computer without you.
- **Fixed, found by a one-hour run** (17,936 calls, no error): Home re-read every receipt each
  time it refreshed (it now reads only the new ones, and everything every 10 minutes;
  `oathrion receipts verify` still reads everything); a « Was Oathrion right? » answer could be
  lost when the notification ended too fast; links carrying parameters lost them (sharing from
  a decision, « Tell us what happened »).

## [0.1.0-preview.0] — on npm since 2026-10-28

The first public version. It is a **preview**: try it, pilot it, and tell us what breaks. Do
not run it unattended in production yet. What is proven and what is not is listed in the
[README](README.md#what-is-proven-and-what-is-not).

### `oathrion wrap` — govern any MCP server with one command

- Puts Oathrion in front of any MCP server that runs over stdio. Nothing to install
  besides Node 22: no Docker, no database to set up, no account. It runs on `127.0.0.1` and
  keeps its data in `~/.oathrion/<name>/`.
- **Default rules.** Each tool is classed when the server starts:
  - **reads** pass;
  - **writes** wait for a person's approval;
  - **destructive tools** (delete, pay, run a command) are blocked.
  A write verb in a tool's name always wins over the server's own « read-only » claim. A tool
  classed as a read on its name alone, because its server does not annotate it, is listed at
  start. A destructive tool, even once permitted, still waits for a person.
- **Approval in the same call** (`--attendre`, 50 s by default). Once approved, the agent
  receives the server's real answer.
- **Pinned tool definitions.** A tool whose description, schema or annotations change, or a
  new tool, is removed from what the agent sees until a person accepts it
  (`oathrion tools list|accept`).
- **Receipts.** `oathrion receipts verify` re-reads the receipt chain.
- **No account, no password.** Locally, you are the administrator from the start;
  `oathrion console` opens the console in your browser, signed in, with a link that works
  once for two minutes. It also restarts the local Oathrion and the wrapped server when
  your client is closed, so what is waiting can still be approved.
- **Approve in your client** (`--approbation client`). The question appears in your MCP
  client when it can ask one (MCP *elicitation*), with the console as the fallback. Opt-in
  in this version (the default from `0.1.0-preview.1`).
- **One approval, one execution.** A client that gives up waiting and calls again with the
  same arguments creates no new request.
- Verified with Cursor. See [docs/wrap.md](docs/wrap.md).

### The control plane

- **One decision engine for every path.** Agents reach it through an MCP gateway, a
  single-use grant (`/api/actions/authorize` → `execute`), or an HTTP firewall in front of your
  own API. It weighs rules, mandates (amount ceilings, categories, domains), permissions, and
  approvals held for a person in the console or in Slack.
- **One receipt chain per organization.** Every executed tool call, on every path, leaves a
  receipt chained to the previous one. Full and incremental verification exist, and an alert
  fires when an execution has no receipt.
- **Connectors for GitHub, Slack, Linear and Stripe.** Each credential is verified with the
  provider and kept sealed in a vault; agents never see it. Reconciliation reports writes that
  the provider saw but Oathrion did not authorize.
- **Uncertain outcomes.** A request that reached the tool without an answer is recorded as
  « may have happened », and cannot be retried without a person confirming.
- **Organizations, roles and access.** Multi-tenant organizations; four roles (viewer,
  operator, approver, admin); SSO (OIDC); console sessions in a protected cookie.
- **Limits.** Per-organization monthly quotas, counted exactly under concurrency, plus rate
  limits and load shedding (`503` with `Retry-After`).
- **Storage.** PostgreSQL in production; SQLite for development and for `oathrion wrap`.
- **Clients.** A TypeScript SDK, a Python SDK (`oathrion`), and the `oathrion` command.

### Upgrading from Placet

Oathrion was called *Placet*. Existing installations keep working: `PLACET_*` environment
variables, `X-Placet-*` headers, `placet_` API keys and `import placet` in Python are still
accepted. Values already written at the providers or in your database keep their names. See
[what still carries a previous name](docs/limitations.md#what-still-carries-a-previous-name).

### Known limitations

[docs/limitations.md](docs/limitations.md).

[0.1.0-preview.1]: CHANGELOG.md#010-preview1--planned-for-2026-11-17-with-the-public-announcement
[0.1.0-preview.0]: CHANGELOG.md#010-preview0--on-npm-since-2026-10-28
