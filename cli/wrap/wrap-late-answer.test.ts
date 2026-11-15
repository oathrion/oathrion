/**
 * UNE RÉPONSE TARDIVE DANS LE CLIENT COMPTE. Le relais n'attend la réponse à sa question que
 * quelques secondes ; passé ce délai, l'agent apprend que la demande attend, mais la question
 * reste affichée dans Claude Code. Vu le 5 novembre : la personne y répondait après coup, et
 * rien ne se passait. Sa réponse vaut désormais une décision prise dans la console.
 */
import { afterAll, describe, expect, it } from "vitest";

import { alive, freshHome, hubTree, mcpClient, ready, until } from "./hub-test-kit";
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

describe.skipIf(!ready)("une réponse tardive à la question", () => {
  it("après le délai, « Oui » dans le client approuve la demande, et l'action a lieu", async () => {
    const home = freshHome("oathrion-tardive-");
    const client = mcpClient(home, "carnet", "claude-code", { wrapArgs: ["--attendre", "2"] });
    let pending: { id: unknown } | null = null;
    client.proc.stdout!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.method === "elicitation/create") pending = { id: message.id };
      }
    });
    await client.ask("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "claude-code", title: "Claude Code", version: "1" } });
    for (const pid of hubTree(home)) seen.add(pid);

    const call = (text: string) => client.ask("tools/call", { name: "create_note", arguments: { text } }) as Promise<{ result?: { content?: { text: string }[] } }>;
    const first = await call("tardive");
    expect(first.result?.content?.[0]?.text).toMatch(/Held for human approval/);
    expect(pending).not.toBeNull();
    expect(client.stderr()).toMatch(/an answer to the question still counts/);

    /* La personne coche « Oui » APRÈS le délai. */
    client.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: pending!.id, result: { action: "accept", content: { confirmer: true, suite: CHOICE_ONCE } } })}\n`);
    await until(() => /"create_note": approved in Claude Code\./.test(client.stderr()), 10_000, "la décision tardive");

    /* L'agent redemande : la même demande, décidée — l'issue de l'outil, sans nouvelle question. */
    const again = await call("tardive");
    expect(again.result?.content?.[0]?.text).toMatch(/note \d+ créée/);
    expect(await client.close()).toBe(0);
  }, 60_000);
});
