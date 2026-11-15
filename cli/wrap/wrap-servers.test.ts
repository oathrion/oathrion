/**
 * L'écran « Serveurs » de la console locale (`GET /api/local/servers`), sur le vrai pivot.
 *
 * Une fausse machine : un client « Claude Code » porte le serveur « carnet » sous Oathrion ;
 * `~/.claude.json` déclare aussi, pour un projet, un serveur NON protégé et un serveur distant ;
 * Cursor en déclare un déjà protégé. L'écran doit dire qui porte « carnet », s'il a déjà servi,
 * et nommer ce qui passe à côté d'Oathrion — sans rien modifier.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { alive, cli, freshHome, hubTree, mcpClient, ready, until } from "./hub-test-kit";

const seen = new Set<number>();
afterAll(() => {
  for (const pid of seen) {
    try {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      /* parti */
    }
  }
});

interface Screen {
  servers: { name: string; clients: string[]; actions: number; classes: { read: number; write: number }; lastAction: { tool: string; decision: string } | null }[];
  unprotected: { client: string; where: string; name: string; protectable: boolean }[];
}

describe.skipIf(!ready)("l'écran « Serveurs »", () => {
  it("qui porte chaque serveur, sa dernière action ; et ce qui passe à côté d'Oathrion", async () => {
    const home = freshHome("oathrion-serveurs-");
    const project = join(home, "projet");
    mkdirSync(project);
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { protege: { command: "npx", args: ["-y", "oathrion@0.1.0-preview.1", "wrap", "--", "srv"] } } }));
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [project]: { mcpServers: { memoire: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }, distant: { type: "http", url: "https://exemple.test/mcp" } } } } }),
    );

    const client = mcpClient(home, "carnet", "claude-code");
    await client.ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", title: "Claude Code", version: "1" } });
    for (const pid of hubTree(home)) seen.add(pid);

    const consoleRun = cli(home, ["console", "--sans-navigateur"]);
    seen.add(consoleRun.proc.pid!);
    await until(() => /Direct sign-in/.test(consoleRun.stdout()), 30_000, "le lien de la console");
    const port = readFileSync(join(home, "_local", "port"), "utf8").trim();
    const base = `http://127.0.0.1:${port}`;
    const ticket = new URLSearchParams(/ticket=(\S+)/.exec(consoleRun.stdout())![0]).get("ticket");
    const { token } = (await (await fetch(`${base}/api/local/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) })).json()) as { token: string };
    const screen = async () => (await (await fetch(`${base}/api/local/servers`, { headers: { authorization: `Bearer ${token}` } })).json()) as Screen;

    /* Branché, pas encore servi. */
    let shown = await screen();
    expect(shown.servers).toHaveLength(1);
    expect(shown.servers[0]).toMatchObject({ name: "carnet", clients: ["Claude Code"], actions: 0, lastAction: null });
    expect(shown.servers[0]!.classes.write).toBeGreaterThan(0);
    expect(shown.unprotected).toEqual([
      { client: "Claude Code", where: "Claude Code · ~/projet", name: "memoire", protectable: true },
      { client: "Claude Code", where: "Claude Code · ~/projet", name: "distant", protectable: false },
    ]);

    /* Une première action : l'écran la montre. */
    await client.ask("tools/call", { name: "read_note", arguments: {} });
    shown = await screen();
    expect(shown.servers[0]).toMatchObject({ actions: 1, lastAction: { tool: "read_note", decision: "allow" } });

    /* Sans session : rien. */
    expect((await fetch(`${base}/api/local/servers`)).status).toBe(401);

    consoleRun.proc.kill("SIGINT");
    expect(await client.close()).toBe(0);
  }, 60_000);
});
