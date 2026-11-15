/**
 * « DÉCIDER UNE FOIS », de bout en bout sur le vrai pivot : un agent qui écrit vingt fichiers
 * ne doit pas poser vingt questions.
 *
 *   1. La question propose « Et pour la suite ? ». « Jusqu'à la fermeture du client » : les
 *      appels suivants de cet outil passent sans question — approuvés quand même, et inscrits
 *      au journal comme « accordé pour la session ».
 *   2. Le client fermé, l'accord de session est parti : la question revient. « Toujours » :
 *      une règle `pol_wrap_<serveur>_toujours`, visible dans la console.
 *   3. Le client relancé (et le pivot avec) : l'écriture passe, sans question ni approbation ;
 *      la règle tient au redémarrage.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { alive, cli, freshHome, hubTree, mcpClient, ready, until } from "./hub-test-kit";
import { CHOICE_ALWAYS, CHOICE_ONCE, CHOICE_SESSION } from "./relay";

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

/** Un client Claude Code qui répond à chaque question par `choice` (case cochée), et compte les questions. */
function claudeCode(home: string, choice: string) {
  const client = mcpClient(home, "carnet", "claude-code", { wrapArgs: ["--attendre", "20"] });
  const questions: { requestedSchema: { properties: Record<string, { enum?: string[] }> } }[] = [];
  client.proc.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as { id?: unknown; method?: string; params?: (typeof questions)[number] };
      if (message.method === "elicitation/create") {
        questions.push(message.params!);
        client.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { confirmer: true, suite: choice } } })}\n`);
      }
    }
  });
  const start = () =>
    client.ask("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "claude-code", title: "Claude Code", version: "1" } });
  const write = async (text: string) =>
    (((await client.ask("tools/call", { name: "create_note", arguments: { text } })) as { result?: { content?: { text: string }[] } }).result?.content?.[0]?.text ?? "");
  return { client, questions, start, write };
}

describe.skipIf(!ready)("décider une fois", () => {
  it("pour la session, puis pour toujours ; et ça tient au redémarrage", async () => {
    const home = freshHome("oathrion-une-fois-");

    /* 1. Pour la session. */
    const first = claudeCode(home, CHOICE_SESSION);
    await first.start();
    for (const pid of hubTree(home)) seen.add(pid);
    expect(await first.write("un")).toMatch(/note \d+ créée/);
    expect(first.questions).toHaveLength(1);
    expect(first.questions[0]!.requestedSchema.properties.suite?.enum).toEqual([CHOICE_ONCE, CHOICE_SESSION, CHOICE_ALWAYS]);
    expect(await first.write("deux")).toMatch(/note \d+ créée/);
    expect(await first.write("trois")).toMatch(/note \d+ créée/);
    expect(first.questions).toHaveLength(1);
    expect(first.client.stderr()).toMatch(/"create_note": granted for the session, without asking\./);
    expect(await first.client.close()).toBe(0);

    /* 2. Le client fermé : la question revient ; cette fois, pour toujours. */
    const second = claudeCode(home, CHOICE_ALWAYS);
    await second.start();
    for (const pid of hubTree(home)) seen.add(pid);
    expect(await second.write("quatre")).toMatch(/note \d+ créée/);
    expect(second.questions).toHaveLength(1);
    expect(second.client.stderr()).toMatch(/allowed without approval, always \(rule pol_wrap_carnet_toujours/);
    expect(await second.client.close()).toBe(0);
    /* Le pivot s'arrête faute de porteur : au prochain client, il redémarre et relit les règles. */
    await until(() => hubTree(home).length === 0, 20_000, "l'arrêt du pivot");

    /* 3. Relancé : l'écriture passe, sans question ni approbation. */
    const third = claudeCode(home, CHOICE_ONCE);
    await third.start();
    for (const pid of hubTree(home)) seen.add(pid);
    expect(await third.write("cinq")).toMatch(/note \d+ créée/);
    expect(third.questions).toHaveLength(0);
    expect(third.client.stderr()).not.toMatch(/attend votre approbation/);

    /* La règle se voit dans la console. */
    const consoleRun = cli(home, ["console", "--sans-navigateur"]);
    seen.add(consoleRun.proc.pid!);
    await until(() => /Direct sign-in/.test(consoleRun.stdout()), 30_000, "le lien de la console");
    const base = `http://127.0.0.1:${readFileSync(join(home, "_local", "port"), "utf8").trim()}`;
    const ticket = new URLSearchParams(/ticket=(\S+)/.exec(consoleRun.stdout())![0]).get("ticket");
    const { token } = (await (await fetch(`${base}/api/local/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) })).json()) as { token: string };
    const policies = (await (await fetch(`${base}/api/policies`, { headers: { authorization: `Bearer ${token}` } })).json()) as { id: string; name: string; status: string; condition?: { actions?: string[] } }[];
    const always = policies.find((p) => p.id === "pol_wrap_carnet_toujours");
    expect(always).toMatchObject({ name: "carnet: allowed without approval", status: "enabled" });
    expect(always?.condition?.actions).toEqual(["mcp.carnet.create_note"]);
    const asks = policies.filter((p) => p.id.startsWith("pol_wrap_carnet_") && p.id !== "pol_wrap_carnet_toujours");
    expect(asks.some((p) => p.condition?.actions?.includes("mcp.carnet.create_note"))).toBe(false);

    consoleRun.proc.kill("SIGINT");
    expect(await third.client.close()).toBe(0);
  }, 90_000);

  it("depuis la console : « Approuver, ne plus demander » ; l'appel suivant passe sans retenue", async () => {
    const home = freshHome("oathrion-une-fois-console-");
    /* Cursor ne pose pas la question ici : la console décide. */
    const client = mcpClient(home, "carnet", "Cursor");
    await client.initialize();
    for (const pid of hubTree(home)) seen.add(pid);
    const held = ((await client.ask("tools/call", { name: "create_note", arguments: { text: "retenue" } })) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    expect(held).toMatch(/approv/i);

    const consoleRun = cli(home, ["console", "--sans-navigateur"]);
    seen.add(consoleRun.proc.pid!);
    await until(() => /Direct sign-in/.test(consoleRun.stdout()), 30_000, "le lien de la console");
    const base = `http://127.0.0.1:${readFileSync(join(home, "_local", "port"), "utf8").trim()}`;
    const ticket = new URLSearchParams(/ticket=(\S+)/.exec(consoleRun.stdout())![0]).get("ticket");
    const { token } = (await (await fetch(`${base}/api/local/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) })).json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const pending = ((await (await fetch(`${base}/api/approvals`, { headers: auth })).json()) as { id: string; status: string }[]).find((a) => a.status === "pending")!;

    expect((await fetch(`${base}/api/local/accords`, { method: "POST", headers: auth, body: JSON.stringify({ approvalId: "apr_inconnue" }) })).status).toBe(404);
    const granted = await fetch(`${base}/api/local/accords`, { method: "POST", headers: auth, body: JSON.stringify({ approvalId: pending.id }) });
    expect(granted.status).toBe(200);
    expect(((await granted.json()) as { policyId: string }).policyId).toBe("pol_wrap_carnet_toujours");
    expect((await fetch(`${base}/api/approvals/${pending.id}/approve`, { method: "POST", headers: auth, body: "{}" })).status).toBe(200);

    const next = ((await client.ask("tools/call", { name: "create_note", arguments: { text: "sans retenue" } })) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    expect(next).toMatch(/note \d+ créée/);

    consoleRun.proc.kill("SIGINT");
    expect(await client.close()).toBe(0);
  }, 60_000);
});
