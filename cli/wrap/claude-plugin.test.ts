/**
 * Le plugin Claude Code (`plugin/`, copié à la racine du paquet npm) : ses hooks appellent le même
 * hook que `npx oathrion`, avec `--plugin`, et se taisent quand `npx oathrion` a déjà posé les siens.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      expect(entries[0]!.hooks).toEqual([{ type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/oathrion-hook.mjs" claude-code ${phase} ${PLUGIN_FLAG}`, ...(phase === "pre" ? { timeout: 120 } : {}) }]);
    }
  });

  it("son manifeste et le catalogue : le même nom, la source npm du paquet", () => {
    const plugin = read("plugin/.claude-plugin/plugin.json");
    const market = read(".claude-plugin/marketplace.json") as { name: string; plugins: { name: string; source: unknown }[] };
    expect(plugin.name).toBe("oathrion");
    expect(plugin.version).toBeUndefined();
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: { source: "npm", package: "oathrion" } })]);
  });
});
