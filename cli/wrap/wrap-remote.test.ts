/**
 * Un serveur MCP DISTANT sous Oathrion, de bout en bout : `npx oathrion` (la vraie commande
 * compilée) protège un serveur déclaré par une URL et son jeton dans la configuration de
 * Cursor ; on lance ce qui est écrit, comme Cursor. Le pivot lance le pont (`oathrion pont`)
 * vers le faux serveur distant : la lecture passe et atteint le serveur, l'écriture est
 * retenue, la destruction n'est pas proposée, et le jeton n'est jamais dans les arguments.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REMOTE_TOKEN, startFakeRemote, type FakeRemote } from "./fake-remote-mcp";
import { alive, cli, envFor, freshHome, hubTree, ready } from "./hub-test-kit";

const seen = new Set<number>();
let remote: FakeRemote;
beforeAll(async () => {
  remote = await startFakeRemote();
});
afterAll(async () => {
  for (const pid of seen) {
    try {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      /* parti */
    }
  }
  await remote.close();
});

describe.skipIf(!ready)("un serveur distant sous Oathrion", () => {
  it("npx oathrion le protège ; lu à travers le pont, écriture retenue, destruction cachée, jeton hors des arguments", async () => {
    const home = freshHome("oathrion-distant-");
    mkdirSync(join(home, ".cursor"));
    const config = join(home, ".cursor", "mcp.json");
    const original = { url: remote.url, headers: { Authorization: `Bearer ${REMOTE_TOKEN}` } };
    writeFileSync(config, JSON.stringify({ mcpServers: { docs: original } }));

    const setup = cli(home, ["--oui"], { cwd: home });
    expect(await setup.exited()).toBe(0);
    expect(setup.stdout()).toMatch(/docs +to protect/);
    const written = (JSON.parse(readFileSync(config, "utf8")) as { mcpServers: { docs: { command: string; args: string[]; env: Record<string, string> } } }).mcpServers.docs;
    expect(written.args).toEqual(expect.arrayContaining(["wrap", "--url", remote.url]));
    expect(JSON.stringify(written.args)).not.toContain(REMOTE_TOKEN);

    /* Comme Cursor, avec `--attendre 0` pour ne pas attendre 50 s l'approbation de l'écriture. */
    const args = [...written.args];
    args.splice(args.indexOf("wrap") + 1, 0, "--attendre", "0");
    const client = spawn(written.command, args, { env: { ...envFor(home), ...written.env }, stdio: ["pipe", "pipe", "pipe"] });
    let log = "";
    client.stderr.on("data", (c: Buffer) => (log += c.toString()));
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
    expect(log).toMatch(/server "docs" \(faux-distant 2\.0\.0\): 1 read\(s\) allowed, 1 write\(s\) on approval, 1 destructive tool\(s\) blocked/);

    const tools = ((await ask("tools/list")) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toContain("read_doc");
    expect(tools).toContain("create_doc");
    expect(tools).not.toContain("delete_doc");

    const read = (await ask("tools/call", { name: "read_doc", arguments: {} })) as { result: { content: { text: string }[] } };
    expect(read.result.content[0]!.text).toBe("read_doc fait (distant)");
    const held = (await ask("tools/call", { name: "create_doc", arguments: { title: "x" } })) as { result: { content: { text: string }[] } };
    expect(held.result.content[0]!.text).toMatch(/approv/i);
    expect(remote.received.filter((r) => r.rpc === "tools/call").length).toBe(1);

    client.stdin.end();
    expect(await new Promise((done) => client.once("exit", done))).toBe(0);

    /* Et l'aller-retour : --annuler remet le serveur distant tel qu'il était. */
    const undo = cli(home, ["--annuler", "--oui"], { cwd: home });
    expect(await undo.exited()).toBe(0);
    expect((JSON.parse(readFileSync(config, "utf8")) as { mcpServers: { docs: unknown } }).mcpServers.docs).toEqual(original);
  }, 60_000);
});
