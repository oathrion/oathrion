/**
 * `npx oathrion` : tout trouver, tout montrer, une réponse.
 *
 * Une fausse machine dans un dossier jetable : Cursor (global et projet), Claude Code (`.mcp.json`
 * du projet, et dans `~/.claude.json` un serveur de la personne et les serveurs de deux projets),
 * et un faux `claude` qui applique `mcp remove` / `mcp add-json` à ce `~/.claude.json` comme le
 * vrai, et note chaque appel. Aucun fichier de la personne n'est lu ni touché.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isWrapped, unwrapServer, wrapServer } from "./install";
import { shimScript } from "./jail-always";
import { claudeDesktopConfig, claudeOnPath, claudeRule, consoleCommandFor, findSources, hooksPresent, launcherFor, runSetup, SECRET_READ_DENY, type ClaudeRunner } from "./setup";

const VERSION = "0.1.0-preview.1";
const NPX_SCRIPT = "/home/x/.npm/_npx/abc123/node_modules/oathrion/oathrion.mjs";

function machine() {
  const home = mkdtempSync(join(tmpdir(), "oathrion-setup-"));
  const project = join(home, "projet");
  const old = join(home, "ancien");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(project, ".cursor"), { recursive: true });
  mkdirSync(old);
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "jeton" } }, distant: { url: "https://exemple.test/mcp" } } }));
  writeFileSync(join(project, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { linear: { command: "linear-mcp" } } }));
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { equipe: { command: "srv-equipe", args: ["--port", "0"] } } }));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 12,
      mcpServers: { memoire: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: {} } },
      projects: {
        [project]: { allowedTools: [], mcpServers: { fichiers: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", project], env: {} } } },
        [old]: { mcpServers: {} },
        [join(home, "disparu")]: { mcpServers: { vieux: { command: "x" } } },
      },
    }),
  );
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", permissions: { allow: ["Bash(ls:*)"] } }));
  const calls: { args: string[]; cwd: string }[] = [];
  /* Le faux `claude` : la même forme que le vrai sur `~/.claude.json`. */
  const claude: ClaudeRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    const path = join(home, ".claude.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown>; projects: Record<string, { mcpServers: Record<string, unknown> }> };
    const scope = args[args.indexOf("-s") + 1];
    const bucket = scope === "user" ? state.mcpServers : state.projects[cwd]!.mcpServers;
    if (args[1] === "remove") delete bucket[args[2]!];
    if (args[1] === "add-json") bucket[args[2]!] = JSON.parse(args[3]!);
    writeFileSync(path, JSON.stringify(state));
    return { code: 0, out: "" };
  };
  const lines: string[] = [];
  const io = (answer: boolean | null) => ({
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(l),
    confirm: async () => answer,
    cwd: project,
    home,
    claude,
    script: NPX_SCRIPT,
    version: VERSION,
    now: () => new Date("2026-10-29T08:00:00Z"),
  });
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, { command: string; args?: string[]; env?: unknown; url?: string }> } & Record<string, unknown>;
  return { home, project, calls, lines, io, json };
}

describe("npx oathrion", () => {
  it("trouve tous les endroits : Cursor global et projet, .mcp.json, ~/.claude.json (la personne, chaque projet)", () => {
    const m = machine();
    const { sources, notes } = findSources(m.home, m.project);
    expect(sources.map((s) => s.label)).toEqual([
      "Claude Code · ~/projet (.mcp.json)",
      "Cursor · all your projects",
      "Cursor · ~/projet",
      "Claude Code · all your projects",
      "Claude Code · ~/projet",
    ]);
    expect(notes).toEqual(["Claude Code · ~/disparu: this folder no longer exists, left as is."]);
  });

  /*
   * Ajouté le 5 novembre : le premier testeur utilise Claude Desktop sous Windows. Même format
   * que Cursor (`mcpServers`), à l'endroit propre à chaque système ; les autres réglages du
   * fichier ne bougent pas, et l'annulation rend le fichier exact.
   */
  it("Claude Desktop : son fichier, sur chaque système, protégé puis rendu à l'identique", async () => {
    expect(claudeDesktopConfig("C:\\Users\\x", "win32", "C:\\Users\\x\\AppData\\Roaming")).toMatch(/Roaming.Claude.claude_desktop_config\.json$/);
    expect(claudeDesktopConfig("/Users/x", "darwin")).toBe("/Users/x/Library/Application Support/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfig("/home/x", "linux")).toBe("/home/x/.config/Claude/claude_desktop_config.json");

    const m = machine();
    const desktop = claudeDesktopConfig(m.home, "linux");
    mkdirSync(join(m.home, ".config", "Claude"), { recursive: true });
    const before = { globalShortcut: "Ctrl+Space", mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { MEMORY_FILE_PATH: "C:\\essai\\memoire.json" } } } };
    writeFileSync(desktop, JSON.stringify(before));
    expect(findSources(m.home, m.project, desktop).sources.map((s) => s.label)).toContain("Claude Desktop");

    expect(await runSetup([], m.io(true))).toBe(0);
    const after = m.json(desktop);
    expect(after.globalShortcut).toBe("Ctrl+Space");
    expect(after.mcpServers.memory.args).toEqual(["-y", "oathrion@0.1.0-preview.1", "wrap", "--name", "memory", "--", "npx", "-y", "@modelcontextprotocol/server-memory"]);
    expect(after.mcpServers.memory.env).toEqual(before.mcpServers.memory.env);
    expect(m.lines.join("\n")).toMatch(/Claude Desktop: quit it completely/);

    expect(await runSetup(["--undo", "--yes"], m.io(null))).toBe(0);
    expect(JSON.parse(readFileSync(desktop, "utf8"))).toEqual(before);
  });

  it("le client lance la même Oathrion : npx à la version exacte, ou le fichier qui tourne", () => {
    expect(launcherFor(NPX_SCRIPT, VERSION)).toEqual({ command: "npx", prefix: ["-y", "oathrion@0.1.0-preview.1"] });
    expect(launcherFor("/opt/oathrion/dist/oathrion.mjs", VERSION, "/usr/bin/node")).toEqual({ command: "/usr/bin/node", prefix: ["/opt/oathrion/dist/oathrion.mjs"] });
    /* Windows : `npx` passe par `cmd /c`, et la forme reste reconnue comme « sous Oathrion », et réversible. */
    const windows = launcherFor("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\ab\\oathrion.mjs", VERSION, "node", "win32");
    expect(windows).toEqual({ command: "cmd", prefix: ["/c", "npx", "-y", "oathrion@0.1.0-preview.1"] });
    const server = { command: "cmd", args: ["/c", "npx", "-y", "@modelcontextprotocol/server-memory"] };
    const wrapped = wrapServer("memoire", server, false, windows);
    expect(isWrapped(wrapped)).toBe(true);
    expect(unwrapServer(wrapped)).toEqual(server);
  });

  it("une réponse : tout est protégé, les fichiers copiés, ~/.claude.json changé par les commandes de Claude Code", async () => {
    const m = machine();
    expect(await runSetup([], m.io(true))).toBe(0);
    const text = m.lines.join("\n");
    expect(text).toMatch(/Protect|✓/);
    /* Décisions du 5 novembre : dire ce qui est caché et pourquoi, et ce qu'Oathrion ne voit pas. */
    expect(text).toMatch(/write_file can\noverwrite a file\) stays hidden until you allow it in the console/);
    expect(text).toMatch(/Claude Code's own shell and file edits are checked by Oathrion's local rules/);
    expect(text).toMatch(/"npx oathrion --undo" puts everything back/);

    /* Le parcours guidé suit : deux lignes, sans le mur de texte ; ce qu'Oathrion ne voit pas reste dit. */
    const guided = machine();
    const short: string[] = [];
    expect(await runSetup([], { ...guided.io(true), out: (l: string) => short.push(l), guided: true })).toBe(0);
    expect(short.join("\n")).toContain("Oathrion asks you: in its chat, or by a notification");
    expect(short.join("\n")).toContain("Claude Code's own file reads are not checked by Oathrion");
    expect(short.join("\n")).not.toMatch(/everything kept in a journal|For a team|See what Oathrion shows/);

    /* Installée (npm i -g) : la commande à retaper est « oathrion », pas « npx oathrion ». */
    const installed = machine();
    const lines: string[] = [];
    expect(await runSetup([], { ...installed.io(true), out: (l: string) => lines.push(l), script: "/usr/lib/node_modules/oathrion/oathrion.mjs" })).toBe(0);
    expect(lines.join("\n")).toMatch(/"oathrion --undo" puts everything back/);
    expect(lines.join("\n")).not.toMatch(/npx oathrion --undo/);

    const cursor = m.json(join(m.home, ".cursor", "mcp.json"));
    /* Le jeton a QUITTÉ la configuration de Cursor pour le coffre d'Oathrion (`server-secrets.ts`, 10 novembre). */
    expect(cursor.mcpServers.github).toEqual({
      command: "npx",
      args: ["-y", "oathrion@0.1.0-preview.1", "wrap", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
    });
    const vault = join(m.home, ".oathrion", "_local", "server-secrets", "github.json");
    expect(JSON.parse(readFileSync(vault, "utf8"))).toEqual({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: "jeton" } });
    expect(statSync(vault).mode & 0o777).toBe(0o600);
    expect(cursor.mcpServers.distant).toEqual({ url: "https://exemple.test/mcp" });
    expect(isWrapped(m.json(join(m.project, ".cursor", "mcp.json")).mcpServers.linear!)).toBe(true);
    expect(isWrapped(m.json(join(m.project, ".mcp.json")).mcpServers.equipe!)).toBe(true);

    const claude = m.json(join(m.home, ".claude.json")) as unknown as { numStartups: number; mcpServers: Record<string, { type: string; args: string[] }>; projects: Record<string, { allowedTools: unknown; mcpServers: Record<string, { type: string; args: string[] }> }> };
    expect(claude.numStartups).toBe(12);
    expect(claude.mcpServers.memoire).toMatchObject({ type: "stdio", command: "npx" });
    expect(claude.mcpServers.memoire!.args.slice(0, 5)).toEqual(["-y", "oathrion@0.1.0-preview.1", "wrap", "--name", "memoire"]);
    expect(claude.projects[m.project]!.mcpServers.fichiers!.args).toContain("@modelcontextprotocol/server-filesystem");
    expect(claude.projects[m.project]!.allowedTools).toEqual([]);
    expect(m.calls.map((c) => `${c.args.slice(0, 3).join(" ")} ${c.args.at(-1)!} @${c.cwd === m.home ? "~" : "projet"}`)).toEqual([
      "mcp remove memoire user @~",
      "mcp add-json memoire user @~",
      "mcp remove fichiers local @projet",
      "mcp add-json fichiers local @projet",
    ]);

    /* Une copie de chaque fichier touché, lisible par la seule personne. */
    const backups = readdirSync(m.home).filter((f) => f.startsWith(".claude.json.before-oathrion-"));
    expect(backups).toHaveLength(1);
    expect(statSync(join(m.home, backups[0]!)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(m.home, ".cursor")).filter((f) => f.includes("before-oathrion"))).toHaveLength(1);
    expect(text).toMatch(/Restart Claude Code and Cursor/);
    expect(text).toMatch(/npx oathrion@0\.1\.0-preview\.1 console/);
    expect(text).toMatch(/distant +remote, sign-in handled by the client \(OAuth\): left as is/);

    /* Une seconde fois : rien à faire. */
    m.lines.length = 0;
    expect(await runSetup([], m.io(true))).toBe(0);
    expect(m.lines.join("\n")).toMatch(/Everything is already behind Oathrion/);
  });

  it.runIf(process.platform === "linux")("la veille des agents : proposée avec le reste, même quand tout est protégé ; --undo la retire", async () => {
    const m = machine();
    let installed = false;
    const watch = { installed: () => installed, install: () => ((installed = true), "systemd" as const), remove: () => void (installed = false) };
    let asked = "";
    expect(await runSetup([], { ...m.io(true), watch, confirm: async (q: string) => ((asked = q), true) })).toBe(0);
    expect(installed).toBe(true);
    expect(m.lines.join("\n")).toMatch(/The agent watch, like an antivirus for AI agents/);
    expect(m.lines.join("\n")).toMatch(/✓ The agent watch is on \(a service of your session/);

    /* Tout est protégé, la veille déjà là : rien à demander. */
    m.lines.length = 0;
    expect(await runSetup([], { ...m.io(true), watch })).toBe(0);
    expect(m.lines.join("\n")).toMatch(/Everything is already behind Oathrion/);

    /* Tout est protégé, mais la veille a été retirée : une seule question, pour elle. */
    installed = false;
    m.lines.length = 0;
    expect(await runSetup([], { ...m.io(true), watch, confirm: async (q: string) => ((asked = q), true) })).toBe(0);
    expect(asked).toBe("Turn on the agent watch? [Y/n] ");
    expect(installed).toBe(true);

    expect(await runSetup(["--undo"], { ...m.io(true), watch })).toBe(0);
    expect(installed).toBe(false);
  });

  it.runIf(process.platform === "linux")("la prison par défaut : proposée avec la veille ; bloquée par AppArmor, la commande dite d'emblée ; --undo", async () => {
    const m = machine();
    let jailed = false;
    let watching = false;
    const installer = { available: () => ["cursor-agent", "agy"], installed: () => jailed, present: () => jailed, install: () => ((jailed = true), ["cursor-agent (/x)", "agy (/y)"]), remove: () => void (jailed = false) };
    const watch = { installed: () => watching, install: () => ((watching = true), "systemd" as const), remove: () => void (watching = false) };
    /* Les serveurs d'abord, pour ne garder que la prison et la veille à proposer. */
    await runSetup([], m.io(true));

    /* AppArmor refuse : la commande à taper, et pas de prison posée (l'agent y buterait). */
    m.lines.length = 0;
    const blocked = { ready: false as const, reason: "apparmor" as const, message: "bubblewrap cannot start here.\nUbuntu only lets programs with an AppArmor profile create user namespaces." };
    expect(await runSetup([], { ...m.io(true), jail: { installer, readiness: () => blocked } })).toBe(0);
    expect(m.lines.join("\n")).toMatch(/The jail, by default, needs one step from you first:\n {4}bubblewrap cannot start here/);
    expect(m.lines.join("\n")).toMatch(/Then run « .*oathrion » again/);
    expect(jailed).toBe(false);

    /* Prête : une question pour les deux, une réponse, et c'est posé. */
    m.lines.length = 0;
    let asked = "";
    expect(await runSetup([], { ...m.io(true), watch, jail: { installer, readiness: () => ({ ready: true }) }, confirm: async (q: string) => ((asked = q), true) })).toBe(0);
    expect(asked).toBe("Turn on the jail for your agents and the agent watch? [Y/n] ");
    expect(m.lines.join("\n")).toMatch(/The jail, by default: cursor-agent, agy typed in a terminal/);
    expect(m.lines.join("\n")).toMatch(/✓ In the jail by default: cursor-agent, agy/);
    expect([jailed, watching]).toEqual([true, true]);

    expect(await runSetup(["--undo"], { ...m.io(true), watch, jail: { installer, readiness: () => ({ ready: true }) } })).toBe(0);
    expect([jailed, watching]).toEqual([false, false]);
  });

  it.runIf(process.platform === "linux")("lancé depuis un agent (Claude Code) : cet agent est autorisé d'avance hors de la prison, une fois, et c'est dit", async () => {
    const m = machine();
    await runSetup([], m.io(true));
    const watch = { installed: () => true, install: () => "systemd" as const, remove: () => undefined };
    const launchingAgent = () => ({ agent: "claude", exe: "/home/p/claude-code/claude" });
    m.lines.length = 0;
    expect(await runSetup([], { ...m.io(true), watch, launchingAgent })).toBe(0);
    expect(m.lines.join("\n")).toMatch(/✓ claude, from which you ran this, is allowed outside the jail/);
    const allowed = JSON.parse(readFileSync(join(m.home, ".oathrion", "_local", "agents-outside.json"), "utf8")) as Record<string, { agent: string; by: string }>;
    expect(allowed["/home/p/claude-code/claude"]).toMatchObject({ agent: "claude", by: "npx oathrion (run from this agent)" });
    m.lines.length = 0;
    await runSetup([], { ...m.io(true), watch, launchingAgent });
    expect(m.lines.join("\n")).not.toMatch(/from which you ran this/);
  });

  it("--annuler remet chaque serveur comme il était", async () => {
    const m = machine();
    const before = { cursor: m.json(join(m.home, ".cursor", "mcp.json")), claude: m.json(join(m.home, ".claude.json")) };
    expect(await runSetup(["--oui"], m.io(null))).toBe(0);
    expect(await runSetup(["--annuler", "--oui"], m.io(null))).toBe(0);
    /* Le jeton est revenu de lui-même dans la configuration, et le coffre est vidé. */
    expect(m.json(join(m.home, ".cursor", "mcp.json"))).toEqual(before.cursor);
    expect(m.json(join(m.home, ".claude.json"))).toEqual(before.claude);
    expect(existsSync(join(m.home, ".oathrion", "_local", "server-secrets", "github.json"))).toBe(false);
  });

  it("une installation d'avant le coffre : les jetons d'un serveur déjà protégé quittent la configuration", async () => {
    const m = machine();
    expect(await runSetup(["--oui"], m.io(null))).toBe(0);
    /* Comme avant le 10 novembre : le jeton de nouveau dans le fichier de Cursor, le coffre vide. */
    const path = join(m.home, ".cursor", "mcp.json");
    const config = m.json(path) as { mcpServers: Record<string, Record<string, unknown>> };
    config.mcpServers.github = { ...config.mcpServers.github, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "jeton" } };
    writeFileSync(path, JSON.stringify(config));
    rmSync(join(m.home, ".oathrion", "_local", "server-secrets"), { recursive: true });
    m.lines.length = 0;
    expect(await runSetup(["--oui"], m.io(null))).toBe(0);
    expect(m.lines.join("\n")).toMatch(/github\s+move token\s+its tokens leave this file for Oathrion's vault/);
    expect((m.json(path) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers.github!.env).toBeUndefined();
    expect(JSON.parse(readFileSync(join(m.home, ".oathrion", "_local", "server-secrets", "github.json"), "utf8"))).toEqual({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: "jeton" } });
  });

  it("refusé, ou personne pour répondre : rien n'est touché", async () => {
    const m = machine();
    const snapshot = readFileSync(join(m.home, ".claude.json"), "utf8");
    expect(await runSetup([], m.io(false))).toBe(1);
    expect(await runSetup([], m.io(null))).toBe(1);
    expect(readFileSync(join(m.home, ".claude.json"), "utf8")).toBe(snapshot);
    expect(m.calls).toHaveLength(0);
    expect(m.lines.join("\n")).toMatch(/run again with --yes/);
  });

  it("l'ajout refusé par Claude Code : le serveur est remis comme avant, et c'est dit", async () => {
    const m = machine();
    const io = m.io(true);
    const real = io.claude;
    io.claude = async (args, cwd) => (args[1] === "add-json" && args[3]!.includes("oathrion") ? { code: 1, out: "Invalid configuration" } : real(args, cwd));
    expect(await runSetup([], io)).toBe(2);
    const claude = m.json(join(m.home, ".claude.json")) as unknown as { mcpServers: Record<string, { args: string[] }> };
    expect(claude.mcpServers.memoire!.args).toEqual(["-y", "@modelcontextprotocol/server-memory"]);
    expect(m.lines.join("\n")).toMatch(/✗ Claude Code · all your projects · memoire: Invalid configuration \(put back as before\)/);
  });

  it("une seule question : Claude Code laisse Oathrion décider pour les serveurs protégés, et le reste de ses réglages est gardé", async () => {
    const m = machine();
    const allow = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { permissions: { allow: string[] } }).permissions.allow;
    expect(await runSetup([], m.io(true))).toBe(0);
    expect(m.lines.join("\n")).toMatch(/One question per action: Claude Code will let Oathrion ask you, for:/);
    expect(m.lines).toContain("    memoire   (~/.claude/settings.json)");
    const user = JSON.parse(readFileSync(join(m.home, ".claude", "settings.json"), "utf8")) as { theme: string };
    expect(user.theme).toBe("dark");
    expect(allow(join(m.home, ".claude", "settings.json"))).toEqual(["Bash(ls:*)", "mcp__memoire"]);
    expect(allow(join(m.project, ".claude", "settings.local.json")).sort()).toEqual(["mcp__equipe", "mcp__fichiers"]);
    /* Cursor n'a pas de telles règles : rien n'est écrit pour lui. */
    expect(readdirSync(join(m.home, ".cursor"))).not.toContain(".claude");

    expect(await runSetup(["--annuler", "--oui"], m.io(null))).toBe(0);
    expect(allow(join(m.home, ".claude", "settings.json"))).toEqual(["Bash(ls:*)"]);
    /* Plus aucune règle dans ce fichier : pas de liste vide laissée derrière. */
    expect((JSON.parse(readFileSync(join(m.project, ".claude", "settings.local.json"), "utf8")) as { permissions?: unknown }).permissions).toBeUndefined();
  });

  it("un serveur déjà protégé sans la règle : la règle seule est proposée", async () => {
    const m = machine();
    expect(await runSetup(["--oui", "--garder-questions-claude"], m.io(null))).toBe(0);
    /* Les questions de Claude Code sont gardées : aucune règle `mcp__…` (le hook, lui, va dans `~/.claude`). */
    expect(existsSync(join(m.project, ".claude", "settings.local.json"))).toBe(false);
    m.lines.length = 0;
    let asked = "";
    const io = { ...m.io(true), confirm: async (q: string) => ((asked = q), true) };
    expect(await runSetup([], io)).toBe(0);
    expect(asked).toMatch(/Let Oathrion alone ask for your approval/);
    expect(readFileSync(join(m.project, ".claude", "settings.local.json"), "utf8")).toContain(claudeRule("fichiers"));
  });

  /*
   * Les hooks Claude Code (décision du 5 novembre) : UN SEUL, pour tous les projets, dans
   * `~/.claude/settings.json`, À CÔTÉ des hooks de la personne ; `--undo` ne retire que les nôtres.
   */
  /* Avant aussi, le hook voit le web et les outils MCP : un leurre, un secret qui sortirait. */
  const OUR_PRE = { matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*", hooks: [{ type: "command", command: `"${process.execPath}" "/opt/oathrion/oathrion.mjs" hook claude-code pre`, timeout: 120 }] };
  it("les hooks Claude Code : un seul pour tous les projets, à côté de ceux de la personne, retirés seuls", async () => {
    const m = machine();
    const userPath = join(m.home, ".claude", "settings.json");
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "mon-audit.sh" }] };
    writeFileSync(userPath, JSON.stringify({ theme: "dark", hooks: { PreToolUse: [theirs] }, permissions: { allow: ["Bash(ls:*)"] } }));
    const local = join(m.project, ".claude", "settings.local.json");

    expect(await runSetup(["--yes"], { ...m.io(null), script: "/opt/oathrion/oathrion.mjs" })).toBe(0);
    const after = JSON.parse(readFileSync(userPath, "utf8")) as { theme: string; hooks: Record<string, { matcher: string; hooks: { command: string }[] }[]>; permissions: { allow: string[] } };
    expect(after.hooks.PreToolUse).toEqual([theirs, OUR_PRE]);
    expect(after.hooks.PostToolUse[0]!.hooks[0]!.command).toMatch(/hook claude-code post$/);
    expect(after.hooks.PostToolUseFailure[0]!.hooks[0]!.command).toMatch(/hook claude-code post$/);
    expect(after.theme).toBe("dark");
    expect(after.permissions.allow).toContain("Bash(ls:*)");
    /* Pas un deuxième dans le projet : chaque commande serait jugée deux fois. */
    expect(existsSync(local) ? (JSON.parse(readFileSync(local, "utf8")) as { hooks?: unknown }).hooks : undefined).toBeUndefined();
    expect(m.lines.join("\n")).toMatch(/✓ Claude Code's own shell and file edits: checked by Oathrion \(Claude Code · all your projects\)/);

    /* Relancé : rien à refaire. */
    m.lines.length = 0;
    expect(await runSetup(["--yes"], { ...m.io(null), script: "/opt/oathrion/oathrion.mjs" })).toBe(0);
    expect(m.lines.join("\n")).not.toMatch(/✓ Claude Code's own shell/);

    expect(await runSetup(["--undo", "--yes"], m.io(null))).toBe(0);
    expect((JSON.parse(readFileSync(userPath, "utf8")) as { hooks: unknown }).hooks).toEqual({ PreToolUse: [theirs] });
  });

  /* L'audit du 8 novembre : le hook ne voit pas les lectures ; Claude Code refuse lui-même de lire les secrets d'Oathrion. */
  it("les secrets d'Oathrion : illisibles par Claude Code, posés et retirés avec le hook ; les interdictions de la personne restent", async () => {
    const m = machine();
    const userPath = join(m.home, ".claude", "settings.json");
    writeFileSync(userPath, JSON.stringify({ permissions: { deny: ["Read(./.env)"] } }));
    expect(await runSetup(["--yes"], { ...m.io(null), script: "/opt/oathrion/oathrion.mjs" })).toBe(0);
    const deny = (JSON.parse(readFileSync(userPath, "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toEqual(["Read(./.env)", ...SECRET_READ_DENY]);
    expect(hooksPresent(userPath)).toBe(true);

    /* Une installation d'avant l'audit (le hook, sans les interdictions) est mise à jour. */
    const before = JSON.parse(readFileSync(userPath, "utf8")) as { permissions: { deny: string[] } };
    writeFileSync(userPath, JSON.stringify({ ...before, permissions: { deny: ["Read(./.env)"] } }));
    expect(hooksPresent(userPath)).toBe(false);
    expect(await runSetup(["--yes"], { ...m.io(null), script: "/opt/oathrion/oathrion.mjs" })).toBe(0);
    expect((JSON.parse(readFileSync(userPath, "utf8")) as { permissions: { deny: string[] } }).permissions.deny).toEqual(["Read(./.env)", ...SECRET_READ_DENY]);

    expect(await runSetup(["--undo", "--yes"], m.io(null))).toBe(0);
    /* Exactement comme avant : ni règle d'Oathrion, ni liste vide laissée derrière (essai du 8 novembre). */
    expect(JSON.parse(readFileSync(userPath, "utf8"))).toEqual({ permissions: { deny: ["Read(./.env)"] } });
  });

  it("une installation précédente avait un hook dans le projet : il est retiré, celui de tous les projets le remplace", async () => {
    const m = machine();
    const local = join(m.project, ".claude", "settings.local.json");
    mkdirSync(join(m.project, ".claude"), { recursive: true });
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "mon-audit.sh" }] };
    writeFileSync(local, JSON.stringify({ hooks: { PreToolUse: [theirs, OUR_PRE], PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "oathrion hook claude-code post" }] }] } }));

    expect(await runSetup(["--yes"], { ...m.io(null), script: "/opt/oathrion/oathrion.mjs" })).toBe(0);
    expect((JSON.parse(readFileSync(local, "utf8")) as { hooks: unknown }).hooks).toEqual({ PreToolUse: [theirs] });
    const user = JSON.parse(readFileSync(join(m.home, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, unknown[]> };
    expect(user.hooks.PreToolUse).toEqual([OUR_PRE]);
    expect(m.lines.join("\n")).toMatch(/Earlier project hook removed/);
  });

  it("Claude Code sans aucun serveur MCP : son shell et ses écritures sont quand même protégés", async () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-setup-nu-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 1 }));
    const lines: string[] = [];
    let asked = "";
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), confirm: async (q: string) => ((asked = q), true), home, cwd: home, version: "0.1.0", script: "/opt/oathrion/oathrion.mjs" };
    expect(await runSetup([], io as never)).toBe(0);
    const user = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, unknown[]> };
    expect(user.hooks.PreToolUse).toEqual([OUR_PRE]);
    expect(asked).toMatch(/Let Oathrion check Claude Code's own shell and file edits\?/);
    expect(lines.join("\n")).not.toMatch(/No MCP server found/);
  });

  it("une installation d'avant la session à risque et les leurres est mise à jour : le hook voit aussi le web et MCP, avant et après, sans doublon", async () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-setup-maj-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 1 }));
    const post = { matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: `"${process.execPath}" "/opt/oathrion/oathrion.mjs" hook claude-code post` }] };
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ ...OUR_PRE, matcher: post.matcher }], PostToolUse: [post], PostToolUseFailure: [post] } }));
    const io = { out: () => undefined, err: () => undefined, confirm: async () => true, home, cwd: home, version: "0.1.0", script: "/opt/oathrion/oathrion.mjs" };
    expect(await runSetup(["--yes"], io as never)).toBe(0);
    const hooks = (JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, { matcher: string }[]> }).hooks;
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0]!.matcher).toBe("Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*");
    expect(hooks.PostToolUseFailure).toHaveLength(1);
    expect(hooks.PreToolUse).toEqual([OUR_PRE]);
  });

  it("jamais de règle pour un serveur dont la protection a échoué", async () => {
    const m = machine();
    const io = m.io(true);
    const real = io.claude;
    io.claude = async (args, cwd) => (args[1] === "add-json" && args[2] === "memoire" && args[3]!.includes("oathrion") ? { code: 1, out: "refusé" } : real(args, cwd));
    expect(await runSetup([], io)).toBe(2);
    expect(readFileSync(join(m.home, ".claude", "settings.json"), "utf8")).not.toContain("mcp__memoire");
    expect(readFileSync(join(m.project, ".claude", "settings.local.json"), "utf8")).toContain("mcp__fichiers");
  });

  it("--sauf : ce serveur reste tel quel, nommé ; les autres sont protégés", async () => {
    const m = machine();
    const before = m.json(join(m.home, ".cursor", "mcp.json")).mcpServers.github;
    expect(await runSetup(["--sauf", "github", "--oui"], m.io(null))).toBe(0);
    expect(m.json(join(m.home, ".cursor", "mcp.json")).mcpServers.github).toEqual(before);
    expect(m.lines.join("\n")).toMatch(/github +excluded \(--except\): left as is/);
    expect(isWrapped(m.json(join(m.project, ".mcp.json")).mcpServers.equipe!)).toBe(true);
    expect(readFileSync(join(m.home, ".claude", "settings.json"), "utf8")).not.toContain("mcp__github");
  });

  it("les options en anglais (--except, --yes, --undo) font la même chose que les françaises", async () => {
    const m = machine();
    const before = m.json(join(m.home, ".cursor", "mcp.json")).mcpServers.github;
    expect(await runSetup(["--except", "github", "--yes"], m.io(null))).toBe(0);
    expect(m.json(join(m.home, ".cursor", "mcp.json")).mcpServers.github).toEqual(before);
    expect(isWrapped(m.json(join(m.project, ".mcp.json")).mcpServers.equipe!)).toBe(true);
    expect(await runSetup(["--undo", "--yes"], m.io(null))).toBe(0);
    expect(isWrapped(m.json(join(m.project, ".mcp.json")).mcpServers.equipe!)).toBe(false);
    expect(await runSetup(["--vite"], m.io(null))).toBe(3);
    expect(m.lines.join("\n")).toMatch(/Unknown option: --vite[\s\S]*--undo[\s\S]*--except <name>/);
  });

  it("aucun serveur nulle part : il le dit simplement, sans commande à recopier", async () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-setup-vide-"));
    const lines: string[] = [];
    expect(await runSetup([], { out: (l) => lines.push(l), err: (l) => lines.push(l), confirm: async () => true, cwd: home, home, version: VERSION })).toBe(0);
    expect(lines.join("\n")).toMatch(/found no MCP server[\s\S]*one Enter protects it/);
    expect(lines.join("\n")).not.toMatch(/claude mcp add/);
  });

  it("aucun serveur, mais la veille et la prison possibles (Linux) : on continue, sans parler de serveurs", async () => {
    if (process.platform !== "linux") return;
    const home = mkdtempSync(join(tmpdir(), "oathrion-setup-veille-"));
    const lines: string[] = [];
    let installed = false;
    const watch = { installed: () => installed, install: () => ((installed = true), "systemd" as const), remove: () => undefined };
    expect(await runSetup([], { out: (l) => lines.push(l), err: (l) => lines.push(l), confirm: async () => true, cwd: home, home, version: VERSION, watch: watch as never })).toBe(0);
    expect(installed).toBe(true);
    expect(lines.join("\n")).not.toMatch(/found no MCP server|reads go through; writes wait/);
    expect(lines.join("\n")).toMatch(/The agent watch is on/);
  });
});

describe("la commande de la console, telle qu'on la tape", () => {
  it("le vrai Claude Code du PATH, pas le lanceur de la prison par défaut (parcours du 11 novembre)", () => {
    const root = mkdtempSync(join(tmpdir(), "oathrion-path-"));
    const shims = join(root, "shims");
    const bin = join(root, "bin");
    mkdirSync(shims);
    mkdirSync(bin);
    writeFileSync(join(shims, "claude"), shimScript({ name: "claude", fallback: join(bin, "claude"), shimDir: shims, node: "/usr/bin/node", script: "/x/oathrion.mjs" }), { mode: 0o755 });
    writeFileSync(join(bin, "claude"), "\x7fELF…", { mode: 0o755 });
    expect(claudeOnPath(`${shims}:${bin}`, "linux")).toBe(join(bin, "claude"));
    expect(claudeOnPath(shims, "linux")).toBeUndefined();
    /* Un fichier qui ne s'exécute pas (une installation cassée) n'est pas Claude Code. */
    chmodSync(join(bin, "claude"), 0o644);
    expect(claudeOnPath(`${shims}:${bin}`, "linux")).toBeUndefined();
  });

  it("installée : « oathrion console » ; par npx : la version ; une copie de développement : le fichier", () => {
    expect(consoleCommandFor("/home/awa/.nvm/versions/node/v22/bin/oathrion", "0.1.0", false)).toBe("oathrion console");
    expect(consoleCommandFor("C:\\Users\\awa\\AppData\\Roaming\\npm\\oathrion.cmd", "0.1.0", false)).toBe("oathrion console");
    expect(consoleCommandFor(undefined, "0.1.0", true)).toBe("npx oathrion@0.1.0 console");
    expect(consoleCommandFor("/src/aria/dist/oathrion.mjs", "0.1.0", false)).toBe("node /src/aria/dist/oathrion.mjs console");
  });
});
