# Oathrion for Claude Code

Oathrion checks Claude Code's own shell commands and file edits **before they run**:

- the most dangerous are **refused**: a recursive delete outside the project, a forced push, a
  script piped from the internet into a shell, a write outside the project;
- risky ones **ask you** first: a push, a publish, a hard reset, destroying data in a database;
- everything else goes through, and every checked action is written to a tamper-evident
  journal on your machine.

```
/plugin install oathrion --marketplace oathrion/oathrion
```

It needs Node 22 or later on your `PATH`.

## What it runs, fetches and sends

- **It runs** `scripts/oathrion-hook-launcher.mjs` before and after each `Bash`, `Write`, `Edit`,
  `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch` and MCP tool call
  ([`hooks/hooks.json`](hooks/hooks.json)). The launcher hands the call to Oathrion's hook program,
  which judges it on your machine.
- **It fetches**, once, at the first checked action: the npm package `oathrion` at the exact
  version pinned in the launcher (`OATHRION_VERSION`), from the npm registry, with
  `npm install` into the plugin's own data folder. Nothing is fetched when the plugin was installed
  from that npm package: the hook program is already beside it. If the installation fails, each
  checked action asks you in Claude Code instead, saying why.
- **It sends nothing.** No telemetry, no account. The journal and Oathrion's state stay in
  `~/.oathrion` on your machine. What the hook reads: the tool call Claude Code gives it (the
  command or the file path); Oathrion's own state in `~/.oathrion`; the size of what a refused
  delete would have removed, to tell you; and your Claude Code settings, to stay quiet when
  `npx oathrion` is installed too. In Claude Code's automatic mode, to ask you, it may start
  Oathrion's local service, which listens on `127.0.0.1` only.

## What it does not do

The plugin does less than the full install, `npx oathrion`: it does not put Oathrion in front of
your MCP servers, it does not pair your phone (decisions signed by your phone, signed receipts
for your clients), and it cannot add the rules that stop Claude Code from reading Oathrion's own
secrets. Run `npx oathrion` for those; the plugin then stays quiet, so nothing is judged or asked
twice. Shell rules read the command line as Claude writes it, not what a program really does: a
seatbelt, not a sandbox. The full list: [what Oathrion does not do yet](https://github.com/oathrion/oathrion/blob/main/docs/not-yet.md).

## Licence and contact

Apache-2.0. Source: [github.com/oathrion/oathrion](https://github.com/oathrion/oathrion).
Questions and reports: contact@oathrion.com.
