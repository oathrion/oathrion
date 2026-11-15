/**
 * Ce que la base garde des réponses (`server/gateway/stored-result.ts`), sur le vrai pivot.
 *
 * Le défaut : chaque réponse était gardée en entier, et la base enflait (1,5 Go en 2 h 30 sous
 * le banc d'endurance, journal §5.74). Désormais :
 *   · une LECTURE autorisée sur-le-champ : l'agent reçoit tout, la base ne garde, au-delà de
 *     16 Ko, que la taille et l'empreinte ;
 *   · une ÉCRITURE approuvée : la base garde sa réponse entière — l'agent la reçoit depuis là.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { alive, cli, freshHome, hubTree, mcpClient, ready, until } from "./hub-test-kit";
import { CHOICE_ONCE } from "./relay";

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

interface StoredExecution {
  action: string;
  toolResult?: Record<string, unknown> | null;
}

describe.skipIf(!ready)("la base garde des réponses bornées", () => {
  it("lecture de 20 Ko : complète pour l'agent, bornée en base ; écriture approuvée : entière en base", async () => {
    const home = freshHome("oathrion-reponse-bornee-");
    const client = mcpClient(home, "carnet", "claude-code", { wrapArgs: ["--attendre", "20"] });
    client.proc.stdout!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.method === "elicitation/create") {
          client.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { confirmer: true, suite: CHOICE_ONCE } } })}\n`);
        }
      }
    });
    await client.ask("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "claude-code", title: "Claude Code", version: "1" } });
    for (const pid of hubTree(home)) seen.add(pid);

    const big = "x".repeat(20_000);
    const written = (await client.ask("tools/call", { name: "create_note", arguments: { text: big } })) as { result: { content: { text: string }[] } };
    expect(written.result.content[0]!.text).toMatch(/note 1 créée/);
    const read = (await client.ask("tools/call", { name: "read_note", arguments: {} })) as { result: { content: { text: string }[] } };
    /* L'agent reçoit la lecture COMPLÈTE. */
    expect(read.result.content[0]!.text).toContain(big);

    const consoleRun = cli(home, ["console", "--sans-navigateur"]);
    seen.add(consoleRun.proc.pid!);
    await until(() => /Direct sign-in/.test(consoleRun.stdout()), 30_000, "le lien de la console");
    const base = `http://127.0.0.1:${readFileSync(join(home, "_local", "port"), "utf8").trim()}`;
    const ticket = new URLSearchParams(/ticket=(\S+)/.exec(consoleRun.stdout())![0]).get("ticket");
    const { token } = (await (await fetch(`${base}/api/local/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) })).json()) as { token: string };
    const executions = (await (await fetch(`${base}/api/executions`, { headers: { authorization: `Bearer ${token}` } })).json()) as StoredExecution[];

    const storedRead = executions.find((e) => e.action === "mcp.carnet.read_note")!;
    expect(JSON.stringify(storedRead.toolResult)).not.toContain(big);
    expect(storedRead.toolResult?.reponseBornee).toMatchObject({ empreinte: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(storedRead.toolResult).length).toBeLessThan(4_000);

    const storedWrite = executions.find((e) => e.action === "mcp.carnet.create_note")!;
    expect(storedWrite.toolResult?.reponseBornee).toBeUndefined();

    /* Le journal du pivot local ne garde aucune réponse d'outil, même son début (§5.76). */
    expect(readFileSync(join(home, "_local", "oathrion.log"), "utf8")).not.toContain("x".repeat(50));

    consoleRun.proc.kill("SIGINT");
    expect(await client.close()).toBe(0);
  }, 60_000);
});
