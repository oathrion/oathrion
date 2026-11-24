/**
 * PRÉVENIR L'APPROBATEUR en local : le bureau par défaut, Slack s'il est configuré.
 *
 * Le canal de bureau avec un faux lanceur (rien ne s'affiche pendant les tests), le canal Slack
 * « prévenir seulement » contre un faux Slack sur la boucle locale, et le réglage relu à chaque
 * envoi.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FEEDBACK_FILE, readNotificationSettings, registerLocalNotifications } from "../local-notifications";
import { DesktopChannel, desktopText, notificationActions } from "../notifications/desktop";
import { Notifier } from "../notifications";
import { SlackChannel } from "../notifications/slack";
import type { NotificationEvent } from "../notifications/types";

const event = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  id: "ntf_essai",
  type: "approval.requested",
  at: "2026-10-28T20:00:00Z",
  title: "Approval required — mcp.fichiers.write file · mcp://fichiers/write_file",
  summary: "« fichiers : chaque écriture attend une approbation »",
  risk: "medium",
  agentId: "agt_local_cursor",
  agentName: "Cursor",
  executionId: "exe_1",
  approvalId: "apr_1",
  policyId: null,
  policyName: null,
  data: { action: "mcp.fichiers.write_file", target: "mcp://fichiers/write_file" },
  ...over,
});

/** Un faux processus : il sort avec `code`, après avoir écrit `stdout`. */
function fakeSpawner(behaviour: (command: string, args: string[]) => { code: number; stdout?: string; delayMs?: number }) {
  const calls: { command: string; args: string[] }[] = [];
  const spawnImpl = (command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    (child as unknown as { stdout: PassThrough }).stdout = stdout;
    const { code, stdout: text, delayMs } = behaviour(command, args);
    setTimeout(() => {
      if (text) stdout.write(text);
      stdout.end();
      child.emit("exit", code);
    }, delayMs ?? 5);
    return child;
  };
  return { calls, spawnImpl };
}

describe("la notification qui décide (10 novembre)", () => {
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

  it("une approbation : « Yes, go ahead » / « No », l'image, et le corps qui ouvre la console", async () => {
    const chosen: string[] = [];
    const opened: (string | null)[] = [];
    for (const answer of ["approve", "default"]) {
      const { calls, spawnImpl } = fakeSpawner(() => ({ code: 0, stdout: `${answer}\n` }));
      const channel = new DesktopChannel({ platform: "linux", spawnImpl, onAction: (_e, id) => chosen.push(id), onDecide: (id) => opened.push(id) });
      const result = await channel.deliver(event({ data: { image: "/opt/oathrion/public/favicon.png" } }));
      expect(result).toMatchObject({ ok: true, detail: 'notify-send, buttons "Yes, go ahead" "No"' });
      expect(calls[0]!.args).toEqual(expect.arrayContaining(["--icon=/opt/oathrion/public/favicon.png", "--action=default=Open the console", "--action=approve=Yes, go ahead", "--action=reject=No"]));
      await wait(20);
    }
    expect(chosen).toEqual(["approve"]);
    expect(opened).toEqual(["apr_1"]);
  });

  it("une alerte à elle garde son titre ; un programme jamais vu dit où décider, ici ou dans la console", () => {
    expect(desktopText(event({ approvalId: null, title: "agy was paused", summary: "Nothing it was doing is lost.", data: { custom: true } }))).toEqual({ title: "agy was paused", body: "Nothing it was doing is lost." });
    const unknown = (data: Record<string, unknown>) => desktopText(event({ approvalId: null, agentName: "agy", data: { unknownProgram: true, description: "/x/agy", ...data } })).body;
    /* Warden parle : Oathrion a retenu ce programme (`shared/friendly-words.ts`). */
    expect(unknown({ actions: [{ id: "trust", label: "It's mine" }] })).toBe("Did you just start agy? I've never seen it. Tell me it's yours and it can work.");
    expect(unknown({})).toMatch(/\(in Oathrion's console\)\.$/);
  });

  it("les boutons d'un événement : trois au plus, des noms sûrs ; une notification groupée n'en a pas", () => {
    const given = event({ approvalId: null, data: { actions: [{ id: "resume", label: "Resume" }, { id: "default", label: "x" }, { id: "Bad Id", label: "x" }, { id: "stop", label: "Stop it" }, { id: "extra", label: "x" }] } });
    expect(notificationActions(given)).toEqual([
      { id: "resume", label: "Resume" },
      { id: "stop", label: "Stop it" },
      { id: "extra", label: "x" },
    ]);
    expect(notificationActions(event({ approvalId: null }))).toEqual([]);
  });

  it("notify-send refuse plusieurs boutons : le bouton « Decide » d'avant", async () => {
    const { calls, spawnImpl } = fakeSpawner((_, args) => ({ code: args.filter((a) => a.startsWith("--action")).length > 1 ? 1 : 0 }));
    const result = await new DesktopChannel({ platform: "linux", spawnImpl, onAction: () => undefined }).deliver(event());
    expect(result).toMatchObject({ ok: true, detail: 'notify-send, "Decide" button' });
    expect(calls).toHaveLength(2);
  });

  it("une alerte du pivot : le bouton agit, puis « Oathrion a-t-il eu raison ? » ; la réponse reste sur la machine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-retour-"));
    const answers = ["stop", "wrong"];
    const { calls, spawnImpl } = fakeSpawner(() => ({ code: 0, stdout: `${answers.shift() ?? ""}\n` }));
    const done: string[] = [];
    const announce = registerLocalNotifications(new Notifier(), { stateDir: dir, baseUrl: "http://127.0.0.1:1", secret: "s".repeat(48), desktopAllowed: true, spawnImpl, image: "/x/oathrion.png" });
    announce({
      id: "outside_agy",
      name: "agy",
      title: "agy was paused",
      description: "…",
      actions: [
        { id: "resume", label: "Resume" },
        { id: "stop", label: "Stop it" },
      ],
      feedbackAbout: "paused agy, running outside the jail",
      onChoice: (choice) => {
        done.push(choice);
        return "agy stopped";
      },
    });
    await wait(60);
    expect(done).toEqual(["stop"]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--icon=/x/oathrion.png", "--action=resume=Resume", "--action=stop=Stop it"]));
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["--action=right=👍 Right", "--action=wrong=👎 Wrong", "agy stopped. Was Oathrion right?"]));
    const recorded = readFileSync(join(dir, FEEDBACK_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { about: string; decision: string; right: boolean });
    expect(recorded).toEqual([expect.objectContaining({ about: "paused agy, running outside the jail", decision: "agy stopped", right: false })]);
  });
});

describe("ce que dit la notification", () => {
  it("qui veut quoi, en clair, et sur quel serveur", () => {
    expect(desktopText(event())).toEqual({
      title: 'Cursor wants to use "write_file"',
      body: 'Server "fichiers". Your approval is needed before the action runs.',
    });
  });
});

describe("le canal de bureau", () => {
  it("Linux : un bouton « Décider » ; le clic appelle onDecide avec la demande", async () => {
    const decided: (string | null)[] = [];
    const { calls, spawnImpl } = fakeSpawner(() => ({ code: 0, stdout: "decider\n" }));
    const channel = new DesktopChannel({ platform: "linux", spawnImpl, onDecide: (id) => decided.push(id) });
    const result = await channel.deliver(event());
    expect(result.ok).toBe(true);
    expect(calls[0]!.command).toBe("notify-send");
    expect(calls[0]!.args).toContain("--action=decider=Decide");
    expect(calls[0]!.args).toContain('Cursor wants to use "write_file"');
    await new Promise((done) => setTimeout(done, 20));
    expect(decided).toEqual(["apr_1"]);
  });

  it("Linux, notify-send trop ancien pour un bouton : une notification simple, qui dit quoi faire", async () => {
    const { calls, spawnImpl } = fakeSpawner((_, args) => ({ code: args.some((a) => a.startsWith("--action")) ? 1 : 0 }));
    const result = await new DesktopChannel({ platform: "linux", spawnImpl }).deliver(event());
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.at(-1)).toMatch(/To decide: oathrion console$/);
  });

  it("macOS : un dialogue « Plus tard / Décider », guillemets échappés ; « Décider » appelle onDecide, « Plus tard » non", async () => {
    for (const [answer, expected] of [["button returned:Decide, gave up:false", ["apr_1"]], ["button returned:Later, gave up:false", []], ["button returned:, gave up:true", []]] as const) {
      const decided: (string | null)[] = [];
      const { calls, spawnImpl } = fakeSpawner(() => ({ code: 0, stdout: `${answer}\n` }));
      const result = await new DesktopChannel({ platform: "darwin", spawnImpl, onDecide: (id) => decided.push(id) }).deliver(event({ agentName: 'Agent "x"' }));
      expect(result).toMatchObject({ ok: true, detail: 'osascript, "Decide" dialog' });
      expect(calls[0]!.command).toBe("osascript");
      expect(calls[0]!.args[1]).toContain('with title "Agent \\"x\\" wants to use \\"write_file\\""');
      expect(calls[0]!.args[1]).toContain('buttons {"Later", "Decide"} default button "Decide" giving up after 120');
      await new Promise((done) => setTimeout(done, 20));
      expect(decided).toEqual(expected);
    }
  });

  it("macOS : le dialogue refusé (pas de session graphique) : la notification simple, qui dit quoi faire", async () => {
    const { calls, spawnImpl } = fakeSpawner((_, args) => ({ code: args[1]!.startsWith("display dialog") ? 1 : 0 }));
    expect((await new DesktopChannel({ platform: "darwin", spawnImpl }).deliver(event())).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[1]).toMatch(/^display notification .*To decide: oathrion console/);
  });

  it("Windows : une notification à boutons, « Décider » ouvre l'adresse à usage unique (XML échappé) ; refusée : la bulle", async () => {
    let minted = 0;
    const decideUrl = () => `http://127.0.0.1:5000/api/local/decider?n=jeton${String((minted += 1))}&x=<y>`;
    const toast = fakeSpawner(() => ({ code: 0 }));
    const result = await new DesktopChannel({ platform: "win32", spawnImpl: toast.spawnImpl, decideUrl }).deliver(event({ agentName: "Claude & Code" }));
    expect(result).toMatchObject({ ok: true, detail: 'Windows notification, "Decide" button' });
    const script = toast.calls[0]!.args.at(-1)!;
    expect(script).toContain('<action content="Decide" activationType="protocol" arguments="http://127.0.0.1:5000/api/local/decider?n=jeton1&amp;x=&lt;y&gt;"/>');
    expect(script).toContain("<text>Claude &amp; Code wants to use &quot;write_file&quot;</text>");
    expect(script).toContain('<action content="Later" activationType="system" arguments="dismiss"/>');
    expect(minted).toBe(1);

    const refused = fakeSpawner((_, args) => ({ code: args.at(-1)!.includes("ToastNotificationManager") ? 1 : 0 }));
    expect((await new DesktopChannel({ platform: "win32", spawnImpl: refused.spawnImpl, decideUrl }).deliver(event())).ok).toBe(true);
    expect(refused.calls).toHaveLength(2);
    expect(refused.calls[1]!.args.at(-1)).toMatch(/ShowBalloonTip.*To decide: oathrion console/);
  });

  it("plateforme inconnue : pas d'envoi, et il le dit", async () => {
    const { spawnImpl } = fakeSpawner(() => ({ code: 0 }));
    expect((await new DesktopChannel({ platform: "aix", spawnImpl }).deliver(event())).ok).toBe(false);
  });

  it("aucun outil de notification : l'envoi échoue proprement, sans exception", async () => {
    const spawnImpl = () => {
      const child = new EventEmitter() as ChildProcess;
      setTimeout(() => child.emit("error", new Error("spawn notify-send ENOENT")), 1);
      return child;
    };
    const result = await new DesktopChannel({ platform: "linux", spawnImpl }).deliver(event());
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toMatch(/ENOENT/);
  });
});

describe("Slack, « prévenir seulement »", () => {
  let server: Server;
  const received: string[] = [];
  let url = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        received.push(body);
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address() as { port: number };
    url = `http://127.0.0.1:${String(address.port)}/services/T/B/secret`;
  });

  afterAll(() => {
    server.close();
  });

  it("sans boutons : le message dit où décider", async () => {
    const channel = new SlackChannel({ url, allowPrivate: true, buttons: false, decideHint: "À décider sur votre ordinateur." });
    expect((await channel.deliver(event())).ok).toBe(true);
    const posted = JSON.parse(received.at(-1)!) as { blocks: { type: string; text?: { text: string } }[] };
    expect(posted.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(posted.blocks.at(-1)?.text?.text).toBe("_À décider sur votre ordinateur._");
  });

  it("avec boutons (l'équipe, par défaut) : inchangé", async () => {
    await new SlackChannel({ url, allowPrivate: true }).deliver(event());
    const posted = JSON.parse(received.at(-1)!) as { blocks: { type: string }[] };
    expect(posted.blocks.some((b) => b.type === "actions")).toBe(true);
  });
});

describe("le réglage local, relu à chaque envoi", () => {
  it("bureau coupé, Slack absent puis présent : les canaux suivent le fichier, sans redémarrage", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-notif-"));
    const target = new Notifier();
    registerLocalNotifications(target, { stateDir: dir, baseUrl: "http://127.0.0.1:1", secret: "s".repeat(40), desktopAllowed: true });
    const handling = () => (target as unknown as { channels: { id: string; handles: (t: string) => boolean }[] }).channels.filter((c) => c.handles("approval.requested")).map((c) => c.id);

    expect(handling()).toEqual(["desktop"]);
    writeFileSync(join(dir, "notifications.json"), JSON.stringify({ desktop: false, slackWebhookUrl: "https://hooks.slack.com/services/T/B/x" }));
    expect(readNotificationSettings(dir)).toEqual({ desktop: false, slackWebhookUrl: "https://hooks.slack.com/services/T/B/x" });
    expect(handling()).toEqual(["slack-local"]);
  });
});

describe("la question déjà posée dans le client : la notification attend", () => {
  /* Slack vers une adresse privée : refusé par le canal, donc rien ne part, mais la tentative se voit. */
  const setup = (asks: boolean, pending: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-notif-grace-"));
    writeFileSync(join(dir, "notifications.json"), JSON.stringify({ desktop: false, slackWebhookUrl: "http://127.0.0.1:9/services/T/B/x" }));
    const target = new Notifier();
    const asked: (string | null)[] = [];
    registerLocalNotifications(target, {
      stateDir: dir,
      baseUrl: "http://127.0.0.1:1",
      secret: "s".repeat(40),
      desktopAllowed: false,
      inClient: { asks: (agentId) => (asked.push(agentId), asks), pending: async () => pending, graceMs: 30 },
    });
    const { id: _id, at: _at, ...input } = event();
    target.emit(input);
    return { target, asked };
  };
  const settled = async (target: Notifier) => {
    for (let i = 0; i < 100 && target.recentDeliveries().length === 0; i += 1) await new Promise((done) => setTimeout(done, 10));
    return target.recentDeliveries()[0]!;
  };

  it("décidée dans le client pendant le délai : aucune notification", async () => {
    const { target, asked } = setup(true, false);
    expect(await settled(target)).toMatchObject({ ok: true, detail: "decided in the client: no notification" });
    expect(asked).toEqual(["agt_local_cursor"]);
  });

  it("toujours en attente après le délai : la notification part", async () => {
    const { target } = setup(true, true);
    expect((await settled(target)).detail).toMatch(/Slack webhook refused/);
  });

  it("un client qui ne pose pas la question : la notification part aussitôt", async () => {
    const { target } = setup(false, false);
    expect((await settled(target)).detail).toMatch(/Slack webhook refused/);
  });
});
