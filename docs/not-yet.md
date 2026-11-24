# What Oathrion does not do yet

Oathrion is a **preview**. This page says, plainly, what it does not do or has not proven, so
you can decide before you rely on it. The technical detail, with the reasons, is in
[limitations.md](limitations.md). The measurements are in
[STRESS-TEST-LOG.md](STRESS-TEST-LOG.md).

## It does not do

- **It only governs what goes through it.** An agent that holds its own key to a tool, or that
  has the raw MCP server in its configuration, can act without Oathrion. Reconciliation sees
  some of those actions after the fact, on GitHub, Slack, Linear and Stripe. It does not stop
  them. The client's own tools are outside it too: Cursor's built-in shell and file editing,
  and Claude Code's file reads. Claude Code's shell and file edits are checked by local rules
  (a hook), which read the command line, not what it really does.
- **It does not solve prompt injection.** It does not detect injected instructions. When Claude Code has read a web page, a search, an issue or a message, the rest of its session's outgoing actions ask a person, saying where it read from; the provenance is lost if the content is copied into a file another session reads. With decoys planted (`oathrion decoys plant`), a fake secret that shows up in what the agent sends is refused — a sign it was tricked — but a decoy sent encoded or split is not recognised. It bounds what a tricked agent can do — a refund
  ceiling holds whether or not the agent was fooled — and that is a smaller promise.
- **It cannot undo an action already taken at a provider**, and it cannot revoke a token there.
- **A signed receipt does not prove who held the key.** On your machine, receipts,
  statements and reports are signed with your computer's key, and a decision made on your
  phone also carries the phone's own signature; anyone can check them with
  `npx oathrion receipt verify`, without trusting us. They prove which key signed and that
  nothing changed since. They do not prove who held the key: your computer's key sits in
  `~/.oathrion`, readable by anything that runs as you. There is no external anchor, so the
  time is your computer's clock. On the team server, the receipt chain is not signed yet: it
  shows that nothing was edited, removed or reordered, not who wrote it.
- **It cannot erase one person from a live organization.** The person's name is inside the
  chained receipts, so erasing it would look like tampering. A whole organization can be
  erased.
- **It does not deduplicate at the provider.** If a provider receives the same creation twice,
  it creates two things. Oathrion's part is to refuse a retry when the first outcome is
  unknown.
- **`oathrion wrap` does not understand resources yet.** You cannot write « this repository
  and not that one » for a wrapped server. Its classification of tools is a cautious guess
  that you correct rule by rule, and pinning tool definitions does not catch a server that
  keeps its declaration but changes what it does.
- **Your phone decides only while your computer is on and online.** The request lives on your
  computer; the phone is paired in one scan (console → « Pair my phone ») and
  reached through Oathrion's relay, or your own Telegram bot. Notifications have no buttons
  by default (Chrome on Android flags those as possible spam): tapping one opens the page
  where you decide. On iPhone, add that page to your home screen first. Approving from Slack
  is part of the team version, with a shared Oathrion.
- **`oathrion wrap` does not contain an agent that can read your files.** It governs the
  MCP server it wraps, nothing else: your client's own shell and file tools go around it, and
  an agent that can read `~/.oathrion` can read the secret that signs console sessions and
  approve its own actions on your computer. It cannot make your phone's signature: that key
  never leaves the phone. Each decision says which it was, « Signed on <your phone> » or
  « No phone signature ». See [what it does not do](wrap.md#what-it-does-not-do).
- **It is not hosted.** You run it yourself: on your machine with `oathrion wrap`, or on your
  servers.
- **Four connectors only:** GitHub, Slack, Linear, Stripe. Anything else goes through an MCP
  server, wrapped or declared.

- **Stop an agent that has an unrestricted shell on the same machine.** No local tool running
  as the same user can: such an agent can read the console's secret, the database, or a
  server's token in the client's configuration. Oathrion local keeps the console's sign-in
  link out of an agent's shell and tells the agent not to try; keep the agent's shell under
  your client's approval. The team version (another approver, tokens in the vault) is the
  answer when it matters.
- **Remote MCP servers whose sign-in (OAuth) is handled by the client**, such as a server
  signed in from Claude Code with `/mcp`. Remote servers with their token in the client's
  configuration are governed.

## It has not proven

- **That every client works.** Claude Code is used every day by the person who builds
  Oathrion, with its hook and the phone, and Cursor was verified before it; no outside team
  uses either with Oathrion yet. Claude Desktop has not been verified.
- **`npx oathrion` and `oathrion wrap` in front of a person on macOS and Windows.** At every
  change, a machine of each system installs the package, protects a server, opens the
  console and undoes it all (the `visitor` job of the CI); nobody has used it there yet.
  The « Decide » button (a dialog on macOS, a Windows notification) is tested against a
  fake launcher only.
  On Windows, `npx oathrion` writes the `cmd /c npx …` form that Claude Code documents for
  native Windows; nobody has run it there yet. Changing Claude Code's servers needs its
  `claude` command on the `PATH`; if it is missing, `npx oathrion` says so and leaves those
  servers as they are.
- **The local Oathrion for 12 hours.** The team server has run 12 hours without an error;
  the local one, behind `npx oathrion`, has run 9 hours on its endurance bench without an
  error (161,336 calls, 17 November, `script/endurance-pivot.mjs`). With that many actions,
  more than a year of use, its home page took 1 to 3 seconds to open.
- **More than 12 hours of continuous running.** A 72-hour run is planned.
- **Several instances sharing one database**, beyond the two-process test.
- **Resistance to a third-party penetration test.** There has been none.
- **That someone who did not build it gets through the setup alone.** No acceptance session
  with outside testers has been run yet.
- **One-click connection (OAuth)** against the real Slack and Linear.

## What we do with this list

Each line is either a limit we chose and explain, or work in progress. When one is closed,
it moves to the [changelog](../CHANGELOG.md) with the evidence. If you hit something that
is not on this page, it is a bug: please report it.
