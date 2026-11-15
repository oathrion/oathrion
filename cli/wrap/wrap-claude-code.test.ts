/**
 * Claude Code devant `oathrion wrap`, dans l'ordre où il parle (relevé par une sonde sur Claude
 * Code 2.1.312, le 28 octobre 2026) : `server/discover` d'abord, puis `initialize` en
 * `2025-11-25` avec `elicitation` (form et url) et un titre lisible, « Claude Code ».
 *
 * Ce qui doit tenir : `server/discover` reçoit « méthode inconnue » sans créer d'agent, le
 * client se présente sous son titre, et une écriture s'approuve DANS le client.
 */
import { afterAll, describe, expect, it } from "vitest";

import { alive, freshHome, hubTree, mcpClient, ready } from "./hub-test-kit";

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

describe.skipIf(!ready)("Claude Code, dans l'ordre où il parle", () => {
  it("server/discover → méthode inconnue, aucun agent ; un seul agent, « Claude Code » ; l'approbation dans le client", async () => {
    const home = freshHome("oathrion-claude-code-");
    /* Sans --approbation : la question dans le client est le défaut, dès qu'il sait la poser. */
    const client = mcpClient(home, "carnet", "claude-code", { wrapArgs: ["--attendre", "20"] });
    /* La personne coche « Oui, j'autorise » et accepte. */
    client.proc.stdout!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.method === "elicitation/create") {
          client.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { confirmer: true } } })}\n`);
        }
      }
    });

    const discover = (await client.ask("server/discover")) as { error?: { code: number } };
    expect(discover.error?.code).toBe(-32601);

    const init = (await client.ask("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { roots: { listChanged: true }, elicitation: { form: {}, url: {} } },
      clientInfo: { name: "claude-code", title: "Claude Code", version: "2.1.312" },
    })) as { result?: { protocolVersion?: string } };
    expect(init.result?.protocolVersion).toBe("2025-06-18");
    for (const pid of hubTree(home)) seen.add(pid);

    const called = (await client.ask("tools/call", { name: "create_note", arguments: { text: "depuis Claude Code" } })) as {
      result?: { isError?: boolean; content?: { text: string }[] };
    };
    expect(called.result?.isError).toBe(false);
    expect(called.result?.content?.[0]?.text).toMatch(/note \d+ créée/);

    const log = client.stderr();
    expect(log).toContain("\"Claude Code\": this client's agent");
    expect(log).not.toContain("Client MCP");
    expect(log).toContain("approved in Claude Code");
    expect(await client.close()).toBe(0);
  }, 60_000);
});
