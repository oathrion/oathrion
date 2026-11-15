/**
 * Prévenir l'approbateur, de bout en bout : une écriture retenue → une notification de bureau
 * → le clic « Décider » → la console s'ouvre DÉJÀ CONNECTÉE.
 *
 * La vraie commande compilée et le vrai pivot. L'outil de notification et le navigateur sont
 * remplacés par deux faux en tête du PATH : le faux `notify-send` note ses arguments et
 * « clique » sur Décider ; le faux `xdg-open` note l'adresse qu'on lui donne. Rien ne s'affiche
 * sur le bureau de la personne.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { alive, freshHome, hubTree, mcpClient, ready, until } from "./hub-test-kit";

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

describe.skipIf(!ready || process.platform !== "linux")("prévenir l'approbateur (Linux)", () => {
  it("une écriture retenue : une notification « Cursor veut utiliser … » ; « Décider » ouvre la console connectée", async () => {
    const home = freshHome("oathrion-notifier-");
    const bin = join(home, "faux-outils");
    mkdirSync(bin);
    const notified = join(home, "notify-send.log");
    const opened = join(home, "xdg-open.log");
    writeFileSync(
      join(bin, "notify-send"),
      /* La personne clique le corps de la notification (« default ») : la console s'ouvre. */
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${notified}"; done\nfor a in "$@"; do case "$a" in --action=default*) echo default; exit 0;; esac; done\nfor a in "$@"; do case "$a" in --action*) echo decider; exit 0;; esac; done\nexit 0\n`,
    );
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${opened}"\nexit 0\n`);
    chmodSync(join(bin, "notify-send"), 0o755);
    chmodSync(join(bin, "xdg-open"), 0o755);

    const client = mcpClient(home, "carnet", "Cursor", { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, OATHRION_LOCAL_NOTIFY_DESKTOP: "1" } });
    await client.initialize();
    for (const pid of hubTree(home)) seen.add(pid);
    await client.ask("tools/call", { name: "create_note", arguments: { text: "à approuver" } });

    await until(() => existsSync(opened), 15_000, "la console ouverte par « Décider »");
    const args = readFileSync(notified, "utf8");
    expect(args).toContain('Cursor wants to use "create_note"');
    expect(args).toContain('Server "carnet".');
    /* La notification qui décide : « Approve » / « Reject », et le corps qui ouvre la console. */
    expect(args).toContain("--action=approve=Approve");
    expect(args).toContain("--action=reject=Reject");
    expect(args).toContain("--action=default=Open the console");

    const url = readFileSync(opened, "utf8").trim();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/console#\/connexion-locale\?ticket=v1\./);
    const ticket = new URLSearchParams(url.split("?")[1]).get("ticket");
    const base = url.split("/console")[0]!;
    const login = await fetch(`${base}/api/local/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
    expect(login.status).toBe(200);

    expect(await client.close()).toBe(0);
  }, 60_000);

  it("« Approve » dans la notification : l'écriture part, sans console ; puis « Was Oathrion right? », gardé sur la machine", async () => {
    const home = freshHome("oathrion-notifier-approve-");
    const bin = join(home, "faux-outils");
    mkdirSync(bin);
    const notified = join(home, "notify-send.log");
    /* La personne clique « Approve » ; à la question qui suit, « 👍 Right ». */
    writeFileSync(
      join(bin, "notify-send"),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${notified}"; done\nfor a in "$@"; do case "$a" in --action=approve*) echo approve; exit 0;; --action=right*) echo right; exit 0;; esac; done\nexit 0\n`,
    );
    chmodSync(join(bin, "notify-send"), 0o755);

    const client = mcpClient(home, "carnet", "Cursor", { wrapArgs: ["--attendre", "20"], env: { PATH: `${bin}:${process.env.PATH ?? ""}`, OATHRION_LOCAL_NOTIFY_DESKTOP: "1" } });
    await client.initialize();
    for (const pid of hubTree(home)) seen.add(pid);
    const answer = (await client.ask("tools/call", { name: "create_note", arguments: { text: "approuvée depuis la notification" } })) as { result?: { isError?: boolean; content?: { text: string }[] } };
    expect(answer.result?.isError).not.toBe(true);

    const feedback = join(home, "_local", "feedback.jsonl");
    await until(() => existsSync(feedback), 10_000, "la réponse au feedback");
    expect(JSON.parse(readFileSync(feedback, "utf8").trim().split("\n")[0]!)).toMatchObject({ decision: "Approved: the action ran", right: true });
    /* La question du feedback garde son titre : pas celui, générique, d'une demande. */
    const lines = readFileSync(notified, "utf8").split("\n");
    expect(lines).toContain("Approved: the action ran. Was Oathrion right?");
    expect(lines).not.toContain("Oathrion is waiting for your decision");
    expect(await client.close()).toBe(0);
  }, 60_000);

  it("la question posée et tranchée dans le client : aucune notification ; ignorée : la notification part après le délai", async () => {
    const home = freshHome("oathrion-notifier-client-");
    const bin = join(home, "faux-outils");
    mkdirSync(bin);
    const notified = join(home, "notify-send.log");
    writeFileSync(join(bin, "notify-send"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${notified}"; done\nexit 0\n`);
    chmodSync(join(bin, "notify-send"), 0o755);

    const client = mcpClient(home, "carnet", "Claude Code", {
      wrapArgs: ["--attendre", "3"],
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, OATHRION_LOCAL_NOTIFY_DESKTOP: "1", OATHRION_LOCAL_NOTIFY_GRACE_MS: "800" },
    });
    /* La première question est tranchée aussitôt ; la seconde est ignorée. */
    let questions = 0;
    client.proc.stdout!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.method === "elicitation/create" && (questions += 1) === 1) {
          client.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { confirmer: true } } })}\n`);
        }
      }
    });
    await client.ask("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "claude-code", title: "Claude Code", version: "1" } });
    for (const pid of hubTree(home)) seen.add(pid);

    await client.ask("tools/call", { name: "create_note", arguments: { text: "tranchée dans le client" } });
    await new Promise((done) => setTimeout(done, 1_500));
    expect(existsSync(notified)).toBe(false);

    await client.ask("tools/call", { name: "create_note", arguments: { text: "question ignorée" } });
    await until(() => existsSync(notified), 10_000, "la notification après le délai");
    expect(readFileSync(notified, "utf8")).toContain('Claude Code wants to use "create_note"');
    expect(await client.close()).toBe(0);
  }, 60_000);
});
