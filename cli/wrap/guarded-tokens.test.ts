/**
 * Les jetons des serveurs protégés, devenus des pièges (`guarded-tokens.ts`) : relevés au
 * lancement d'un serveur (empreintes seulement), puis refusés s'ils apparaissent ailleurs — ce
 * que l'agent de `cursor-agent` a tenté le 10 novembre (lire la configuration, et appeler le
 * service avec le jeton).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { judge, type RuleContext } from "./claude-hook-rules";
import { guardedTokenIn, guardedTokensPath, loadGuardedTokens, recordServerTokens, serverTokens, tokenCandidates } from "./guarded-tokens";
import { McpRelay } from "./relay";

const TOKEN = "placet_yOUGrWZFi4hp0bocy1c4qt4Ro2k2tTNW";
const GITHUB = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function recorded() {
  const env = { OATHRION_WRAP_HOME: mkdtempSync(join(tmpdir(), "oathrion-guarded-")) } as NodeJS.ProcessEnv;
  const serverEnv = { PATH: "/usr/bin", HOME: "/home/awa", MCP_REMOTE_HEADERS: JSON.stringify({ Authorization: `Bearer ${TOKEN}` }), GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB, LOG_LEVEL: "debug" };
  recordServerTokens(env, "placet-local", serverTokens(serverEnv, ["--url", "https://mcp.example.com/v1"]));
  return { env, guarded: loadGuardedTokens(env)! };
}

describe("les jetons des serveurs protégés", () => {
  it("relevés au lancement : seulement des empreintes, jamais le jeton", () => {
    const { env, guarded } = recorded();
    const file = readFileSync(guardedTokensPath(env), "utf8");
    expect(file).not.toContain(TOKEN);
    expect(file).not.toContain(GITHUB);
    expect(Object.values(guarded.byHash).map((v) => v.from).sort()).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN", "MCP_REMOTE_HEADERS"]);
    expect(tokenCandidates("/home/awa/essai-claude/photos and some-words-only-here")).toEqual([]);
  });

  it("le contournement de cursor-agent : appeler le service avec le jeton trouvé, refusé ; le travail ordinaire passe", () => {
    const { guarded } = recorded();
    const ctx: RuleContext = { projectDir: "/home/awa/projet", home: "/home/awa", scratchDirs: ["/tmp"], exists: () => false, tracked: () => null, guarded };
    const command = `curl -X POST http://127.0.0.1:5000/api/mcp -H "Authorization: Bearer ${TOKEN}" -d '{}'`;
    expect(judge({ tool: "Bash", input: { command } }, ctx)).toMatchObject({ verdict: "deny", rule: "server-token", reason: expect.stringMatching(/token given to the "placet-local" server[\s\S]*go around Oathrion/) });
    expect(judge({ tool: "Write", input: { file_path: "/home/awa/projet/x.sh", content: `export T=${GITHUB}` } }, ctx)).toMatchObject({ verdict: "deny", rule: "server-token" });
    expect(judge({ tool: "mcp__slack__post_message", input: { text: GITHUB } }, ctx)).toMatchObject({ verdict: "deny", rule: "server-token" });
    expect(judge({ tool: "Bash", input: { command: "npm test" } }, ctx)).toMatchObject({ verdict: null });
    expect(judge({ tool: "Bash", input: { command } }, { ...ctx, disabled: new Set(["server-token"]) })).toMatchObject({ verdict: null });
  });

  it("le relais MCP refuse un outil appelé avec le jeton d'un serveur protégé", async () => {
    const { guarded } = recorded();
    const out: string[] = [];
    const posted: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const message = JSON.parse(init.body) as { id: unknown; method: string };
      posted.push(message.method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "mcp.mail.send" }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const relay = new McpRelay({ endpoint: "http://127.0.0.1:1/api/mcp", key: "k", serverName: "mail", write: (l) => out.push(l), log: () => undefined, fetchImpl, guardedToken: (text) => guardedTokenIn(text, guarded) });
    await relay.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send", arguments: { body: `here: ${TOKEN}` } } }));
    expect(out.at(-1)).toMatch(/go around Oathrion/);
    expect(posted).not.toContain("tools/call");
  });
});
