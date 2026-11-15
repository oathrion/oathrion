/**
 * LE CALME ET LA COHÉRENCE (12 novembre) : le téléphone n'est sollicité que si personne n'a décidé
 * sur l'ordinateur ; une décision prise sur un canal efface les boutons des autres ; le son ne se
 * répète pas plus d'une fois toutes les 30 secondes (le danger passe toujours).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NOTIFICATIONS_FILE, registerLocalNotifications, type Announcement } from "../local-notifications";
import { writeTelegram } from "../local-telegram";
import { Notifier } from "../notifications";
import { DesktopChannel, resetPopupCheck } from "../notifications/desktop";
import type { NotificationEvent } from "../notifications/types";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Un faux Telegram : les méthodes appelées, dans l'ordre. */
function fakeTelegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) for (const [k, v] of init.body.entries()) body[k] = typeof v === "string" ? v : "(file)";
    else if (typeof init?.body === "string") Object.assign(body, JSON.parse(init.body));
    calls.push({ method, body });
    if (method === "getUpdates") await wait(20);
    const result = method === "getUpdates" ? [] : method.startsWith("send") ? { message_id: 7 } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Un faux `notify-send` : il répond `answer` après `afterMs`. */
function fakeNotifySend(answer: string, afterMs: number) {
  return () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    (child as unknown as { stdout: PassThrough }).stdout = stdout;
    setTimeout(() => {
      stdout.end(`${answer}\n`);
      child.emit("exit", 0);
    }, afterMs);
    return child;
  };
}

const paused = (onChoice: (c: string) => string): Announcement => ({
  id: "outside_agy",
  name: "agy",
  custom: true,
  title: "agy was paused",
  description: "It was running outside the jail.",
  actions: [
    { id: "resume", label: "Resume" },
    { id: "stop", label: "Stop" },
  ],
  onChoice,
});

describe("le téléphone, seulement quand il le faut", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.OATHRION_LOCAL_NOTIFY_PHONE;
    process.env.OATHRION_LOCAL_PHONE_DELAY_MS = "60";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  function setup(spawnImpl: ReturnType<typeof fakeNotifySend>) {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-calm-"));
    writeTelegram(dir, { token: "1:x", bot: "b", chatId: 42, userId: 42 });
    const telegram = fakeTelegram();
    const announce = registerLocalNotifications(new Notifier(), { stateDir: dir, baseUrl: "http://127.0.0.1:1", secret: "s".repeat(48), desktopAllowed: true, popup: false, spawnImpl, phoneFetch: telegram.fetchImpl });
    const sent = () => telegram.calls.filter((c) => c.method === "sendPhoto" || c.method === "sendMessage");
    return { dir, telegram, announce, sent };
  }

  it("décidé sur l'ordinateur avant le délai : le téléphone ne sonne pas", async () => {
    const { announce, sent } = setup(fakeNotifySend("stop", 5));
    announce(paused(() => "agy stopped"));
    await wait(150);
    expect(sent()).toEqual([]);
  });

  it("la notification de l'ordinateur coupée (« je suis parti ») : le téléphone tout de suite", async () => {
    const { dir, announce, sent } = setup(fakeNotifySend("", 5));
    writeFileSync(join(dir, NOTIFICATIONS_FILE), JSON.stringify({ desktop: false }));
    announce(paused(() => "agy stopped"));
    await wait(30);
    expect(sent()).toHaveLength(1);
  });

  it("personne n'a décidé : le téléphone après le délai ; puis décidé sur l'ordinateur, le message perd ses boutons", async () => {
    const { announce, sent, telegram } = setup(fakeNotifySend("stop", 160));
    announce(paused(() => "agy stopped"));
    await wait(110);
    expect(sent()).toHaveLength(1);
    await wait(120);
    const edit = telegram.calls.find((c) => c.method === "editMessageCaption" || c.method === "editMessageText");
    expect(edit).toBeDefined();
    expect(JSON.stringify(edit!.body)).toContain("agy stopped (on your computer)");
    expect(JSON.stringify(edit!.body.reply_markup)).toBe('{"inline_keyboard":[]}');
  });

  it("une alerte (un leurre lu) part tout de suite, même devant l'ordinateur", async () => {
    const { announce, sent } = setup(fakeNotifySend("", 500));
    announce({ id: "decoy", name: "decoy", custom: true, danger: true, title: "Something read one of your decoys", description: "…" });
    await wait(30);
    expect(sent()).toHaveLength(1);
  });
});

describe("la fenêtre de l'ordinateur, décidée ailleurs", () => {
  it("elle le dit, sans redemander d'avis ; un clic tardif n'agit plus", async () => {
    process.env.DISPLAY = ":0";
    resetPopupCheck();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const told: string[] = [];
    stdin.on("data", (chunk: Buffer) => told.push(String(chunk).trim()));
    const acted: string[] = [];
    const channel = new DesktopChannel({
      platform: "linux",
      popupScript: "/x/window.py",
      spawnSyncImpl: () => 0,
      spawnPopup: () => Object.assign(new EventEmitter() as ChildProcess, { stdin, stdout, kill: () => true }),
      onAction: (_e, id) => (acted.push(id), "done"),
    });
    const event: NotificationEvent = {
      id: "program_x",
      type: "approval.requested",
      at: "2026-11-12T00:00:00Z",
      title: "agy was paused",
      summary: "…",
      risk: "high",
      agentId: "agy",
      agentName: "agy",
      executionId: null,
      approvalId: null,
      policyId: null,
      policyName: null,
      data: { custom: true, actions: [{ id: "stop", label: "Stop" }] },
    };
    await channel.deliver(event);
    channel.settled("program_x", "agy stopped (from your phone)");
    stdout.write('{"choice": "stop"}\n');
    await wait(20);
    expect(told).toEqual(['{"settled":"agy stopped (from your phone)"}']);
    expect(acted).toEqual([]);
  });
});

describe("le son", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("au plus un toutes les 30 secondes ; le danger passe toujours", async () => {
    delete process.env.OATHRION_LOCAL_NOTIFY_SOUND;
    process.env.OATHRION_LOCAL_NOTIFY_PHONE = "0";
    const played: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "oathrion-sound-"));
    const announce = registerLocalNotifications(new Notifier(), {
      stateDir: dir,
      baseUrl: "http://127.0.0.1:1",
      secret: "s".repeat(48),
      desktopAllowed: true,
      popup: false,
      spawnImpl: fakeNotifySend("", 5),
      sounds: { ask: "/x/ask.wav", danger: "/x/danger.wav" },
      play: (file) => played.push(file),
    });
    announce(paused(() => "x"));
    announce(paused(() => "x"));
    announce({ id: "decoy", name: "decoy", custom: true, danger: true, title: "Decoy read", description: "…" });
    await wait(20);
    expect(played).toEqual(["/x/ask.wav", "/x/danger.wav"]);
  });
});
