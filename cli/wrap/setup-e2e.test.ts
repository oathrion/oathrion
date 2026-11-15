/**
 * `npx oathrion`, de bout en bout : la vraie commande compilée réécrit la configuration de
 * Cursor d'une fausse machine, puis on lance le serveur EXACTEMENT comme Cursor le lancera, à
 * partir de ce qui a été écrit. Il doit démarrer derrière Oathrion et retenir une écriture.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterAll, describe, expect, it } from "vitest";

import { alive, cli, envFor, FAKE, freshHome, hubTree, ready } from "./hub-test-kit";

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

describe.skipIf(!ready)("npx oathrion, de bout en bout", () => {
  it("la configuration écrite démarre le serveur derrière Oathrion, qui retient une écriture", async () => {
    const home = freshHome("oathrion-setup-e2e-");
    mkdirSync(join(home, ".cursor"));
    const config = join(home, ".cursor", "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { carnet: { command: process.execPath, args: [FAKE] } } }));

    const setup = cli(home, ["--oui"], { cwd: home });
    expect(await setup.exited()).toBe(0);
    expect(setup.stdout()).toMatch(/✓ Cursor · all your projects: carnet/);

    const written = (JSON.parse(readFileSync(config, "utf8")) as { mcpServers: { carnet: { command: string; args: string[] } } }).mcpServers.carnet;
    expect(written.args).toContain("wrap");

    /*
     * Comme Cursor : la commande et ses arguments, tels qu'écrits — avec seulement
     * `--attendre 0` après `wrap`, pour ne pas attendre 50 s une approbation (l'attente a ses
     * propres tests).
     */
    const args = [...written.args];
    args.splice(args.indexOf("wrap") + 1, 0, "--attendre", "0");
    const client = spawn(written.command, args, { env: envFor(home), stdio: ["pipe", "pipe", "pipe"] });
    const answers = new Map<number, (m: Record<string, unknown>) => void>();
    createInterface({ input: client.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === "number") answers.get(message.id)?.(message as Record<string, unknown>);
    });
    let next = 1;
    const ask = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((done) => {
        const id = next++;
        answers.set(id, done);
        client.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Cursor", version: "1" } });
    for (const pid of hubTree(home)) seen.add(pid);
    const tools = (await ask("tools/list")) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name)).toContain("create_note");
    const held = (await ask("tools/call", { name: "create_note", arguments: { text: "retenue" } })) as { result: { content: { text: string }[] } };
    expect(held.result.content[0]!.text).toMatch(/approv/i);

    client.stdin.end();
    expect(await new Promise((done) => client.once("exit", done))).toBe(0);
  }, 60_000);
});
