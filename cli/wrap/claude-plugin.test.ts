/**
 * Le plugin Claude Code (`plugin/`, copié à la racine du paquet npm) : ses hooks appellent le même
 * hook que `npx oathrion`, avec `--plugin`, et se taisent quand `npx oathrion` a déjà posé les siens.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PLUGIN_FLAG, runClaudeHook } from "./claude-hook";
import { HOOK_MATCHER, TAINT_MATCHER } from "./claude-hook-rules";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "oathrion-plugin-"));
  const project = join(home, "projet");
  mkdirSync(project);
  const env = { HOME: home, OATHRION_WRAP_HOME: join(home, ".oathrion"), CLAUDE_PROJECT_DIR: project } as NodeJS.ProcessEnv;
  const forcePush = async (extra: NodeJS.ProcessEnv = {}) => {
    const lines: string[] = [];
    const code = await runClaudeHook(["claude-code", "pre", PLUGIN_FLAG], { ...env, ...extra }, JSON.stringify({ session_id: "s1", cwd: project, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin main" } }), (l) => lines.push(l), { channel: () => Promise.reject(new Error("no hub in tests")), pollMs: 1 });
    return { code, lines };
  };
  return { home, project, forcePush };
}

describe("le plugin Claude Code", () => {
  it("seul, il juge comme `npx oathrion` : le push forcé est refusé", async () => {
    const { forcePush } = setup();
    const { code, lines } = await forcePush();
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^Oathrion refuses a forced push/) });
  });

  it("si `npx oathrion` a déjà posé ses hooks (personne ou projet), le plugin se tait : rien n'est jugé deux fois", async () => {
    for (const where of ["home", "project"] as const) {
      const { home, project, forcePush } = setup();
      const dir = join(where === "home" ? home : project, ".claude");
      mkdirSync(dir, { recursive: true });
      const hook = { type: "command", command: `"/usr/bin/node" "/opt/oathrion/oathrion-hook.mjs" claude-code pre` };
      writeFileSync(join(dir, where === "home" ? "settings.json" : "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } }));
      expect(await forcePush()).toEqual({ code: 0, lines: [] });
      expect((await forcePush({ OATHRION_PLUGIN_FORCE: "1" })).lines).toHaveLength(1);
    }
  });

  it("des réglages sans nos hooks, ou illisibles, ne le font pas taire", async () => {
    const { home, forcePush } = setup();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] } }));
    expect((await forcePush()).lines).toHaveLength(1);
    writeFileSync(join(home, ".claude", "settings.json"), "{ cassé");
    expect((await forcePush()).lines).toHaveLength(1);
  });

  it("ses hooks : les trois événements, le même filtre que `npx oathrion`, le fichier du paquet, et `--plugin`", () => {
    const hooks = read("plugin/hooks/hooks.json").hooks as Record<string, { matcher: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "PostToolUseFailure", "PreToolUse"]);
    for (const [event, entries] of Object.entries(hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0]!.matcher).toBe(`${HOOK_MATCHER}|${TAINT_MATCHER}`);
      const phase = event === "PreToolUse" ? "pre" : "post";
      expect(entries[0]!.hooks).toEqual([{ type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/oathrion-hook-launcher.mjs" claude-code ${phase} ${PLUGIN_FLAG}`, ...(phase === "pre" ? { timeout: 120 } : {}) }]);
    }
  });

  it("son manifeste et le catalogue : le même nom, la source npm du paquet", () => {
    const plugin = read("plugin/.claude-plugin/plugin.json");
    const market = read(".claude-plugin/marketplace.json") as { name: string; plugins: { name: string; source: unknown }[] };
    expect(plugin.name).toBe("oathrion");
    expect(plugin.version).toBe((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version);
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: { source: "npm", package: "oathrion" } })]);
  });
});

/*
 * LE LANCEUR (`plugin/scripts/oathrion-hook-launcher.mjs`) : le répertoire d'Anthropic lit le
 * plugin dans un dossier de GitHub, sans le programme du hook. Le lanceur le prend à côté (paquet
 * npm), sinon dans le dossier de données du plugin, où il l'installe une fois.
 */
describe("le lanceur du hook", () => {
  const LAUNCHER = join(ROOT, "plugin", "scripts", "oathrion-hook-launcher.mjs");
  /* Un faux programme du hook : il rend ses arguments et ce qu'il a lu. */
  const FAKE_HOOK = `let d="";process.stdin.on("data",(c)=>d+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:d})+"\\n");process.exit(7);});`;
  const run = (env: NodeJS.ProcessEnv, phase = "pre") =>
    spawnSync(process.execPath, [LAUNCHER, "claude-code", phase, PLUGIN_FLAG], { input: '{"tool_name":"Bash"}', encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

  it("dans le paquet npm : le programme d'à côté, les arguments et l'entrée transmis tels quels, son code de sortie aussi", () => {
    const root = mkdtempSync(join(tmpdir(), "oathrion-launch-"));
    writeFileSync(join(root, "oathrion-hook.mjs"), FAKE_HOOK);
    const out = run({ CLAUDE_PLUGIN_ROOT: root });
    expect(out.status).toBe(7);
    expect(JSON.parse(out.stdout)).toEqual({ args: ["claude-code", "pre", PLUGIN_FLAG], stdin: '{"tool_name":"Bash"}' });
  });

  it("depuis GitHub : installe une fois la version épinglée dans le dossier de données, puis la réutilise", () => {
    const base = mkdtempSync(join(tmpdir(), "oathrion-launch-"));
    const data = join(base, "data");
    const npm = join(base, "fake-npm");
    const calls = join(base, "calls");
    /* Un faux npm : il note l'appel et pose dans la destination une archive comme celle de `npm pack`. */
    writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${calls}"\nwhile [ "$1" != "--pack-destination" ]; do shift; done\nT=$(mktemp -d)\nmkdir -p "$T/package"\ncat > "$T/package/oathrion-hook.mjs" <<'JS'\n${FAKE_HOOK}\nJS\ntar -czf "$2/oathrion-x.tgz" -C "$T" package\necho oathrion-x.tgz\n`);
    chmodSync(npm, 0o755);
    const env = { CLAUDE_PLUGIN_ROOT: join(base, "plugin"), CLAUDE_PLUGIN_DATA: data, OATHRION_PLUGIN_NPM: npm };
    expect(run(env).status).toBe(7);
    expect(run(env).status).toBe(7);
    const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`oathrion@${version}`);
    expect(lines[0]).toMatch(/^pack /);
    expect(existsSync(join(data, "oathrion", version, "package", "oathrion-hook.mjs"))).toBe(true);
    expect(existsSync(join(data, "oathrion", version, "oathrion-x.tgz"))).toBe(false);
  });

  it("si l'installation échoue : avant l'action, demander à la personne en disant pourquoi ; après, rien", () => {
    const base = mkdtempSync(join(tmpdir(), "oathrion-launch-"));
    const npm = join(base, "fake-npm");
    writeFileSync(npm, "#!/bin/sh\necho 'npm ERR! network unreachable' >&2\nexit 1\n");
    chmodSync(npm, 0o755);
    const env = { CLAUDE_PLUGIN_ROOT: join(base, "plugin"), CLAUDE_PLUGIN_DATA: join(base, "data"), OATHRION_PLUGIN_NPM: npm };
    const pre = run(env, "pre");
    expect(pre.status).toBe(0);
    expect(JSON.parse(pre.stdout).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.stringMatching(/^Oathrion could not check this action \(npm pack oathrion@.+ failed: npm ERR! network unreachable\)/) });
    const post = run(env, "post");
    expect(post).toMatchObject({ status: 0, stdout: "" });
  });
});
