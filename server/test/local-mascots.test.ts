/**
 * LES MASCOTTES PROVISOIRES (`server/local-mascots.ts`) et NOTRE FENÊTRE DE NOTIFICATION
 * (`server/notifications/popup.ts`, branchée dans `desktop.ts`) : avec un faux lanceur, rien ne
 * s'affiche sur l'écran pendant les essais.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { defaultMascot, MASCOTS, mascotSvg, writeMascots } from "../local-mascots";
import { DesktopChannel, popupEnv, resetPopupCheck } from "../notifications/desktop";
import { POPUP_PY } from "../notifications/popup";
import type { NotificationEvent } from "../notifications/types";

describe("les mascottes provisoires", () => {
  it("une par famille d'agents, reconnue par son nom ; un inconnu (et ce qui lit un leurre) a la sienne, Oathrion aussi", () => {
    expect(["claude", "Claude Code", "cursor-agent", "Cursor (app)", "agy", "Antigravity (app)", "codex", "gemini", "aider", "inconnu", "decoy", "oathrion"].map((a) => defaultMascot(a).name)).toEqual([
      "Ember",
      "Ember",
      "Pixel",
      "Pixel",
      "Nova",
      "Nova",
      "Bolt",
      "Echo",
      "Orbit",
      "Shade",
      "Shade",
      "Warden",
    ]);
  });

  it("des dessins à nous, en SVG, sans texte ni image d'ailleurs ; écrits dans le dossier du pivot", () => {
    for (const m of MASCOTS) {
      const svg = mascotSvg(m);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).not.toMatch(/<image|<text|href=/);
    }
    const dir = mkdtempSync(join(tmpdir(), "oathrion-mascottes-"));
    const mascotFor = writeMascots(dir);
    expect(readdirSync(join(dir, "mascots"))).toHaveLength(MASCOTS.length);
    expect(mascotFor("agy")).toEqual({ path: join(dir, "mascots", "nova.svg"), name: "Nova", id: "nova" });
    expect(readFileSync(mascotFor("agy").path, "utf8")).toContain("#8b6cf0");
  });

  it("l'illustration livrée avec Oathrion d'abord, le dessin provisoire si elle manque", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-mascottes-"));
    const images = mkdtempSync(join(tmpdir(), "oathrion-illustrations-"));
    writeFileSync(join(images, "nova.png"), "png");
    const mascotFor = writeMascots(dir, images);
    expect(mascotFor("agy")).toEqual({ path: join(images, "nova.png"), name: "Nova", id: "nova" });
    expect(mascotFor("cursor-agent").path).toBe(join(dir, "mascots", "pixel.svg"));
  });

  it("les illustrations sont dans le dépôt, une par mascotte", () => {
    const shipped = readdirSync(join(__dirname, "..", "..", "client", "public", "mascots"));
    expect(shipped.sort()).toEqual(MASCOTS.map((m) => `${m.id}.png`).sort());
  });
});

describe("notre fenêtre de notification", () => {
  const before = process.env.DISPLAY;
  afterEach(() => {
    resetPopupCheck();
    if (before === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = before;
  });

  const event: NotificationEvent = {
    id: "program_outside_agy_1",
    type: "approval.requested",
    at: "2026-11-10T23:00:00Z",
    title: "agy was paused",
    summary: "Nothing it was doing is lost.",
    risk: "high",
    agentId: "outside_agy",
    agentName: "agy",
    executionId: null,
    approvalId: null,
    policyId: null,
    policyName: null,
    data: {
      custom: true,
      mascot: { path: "/x/mascots/nova.svg", name: "Nova", id: "nova" },
      actions: [
        { id: "resume", label: "Resume" },
        { id: "stop", label: "Stop it" },
      ],
    },
  };

  it("la mascotte, la bulle et les boutons ; le choix agit, la même fenêtre dit ce qui a été fait, puis le 👍 / 👎", async () => {
    process.env.DISPLAY = ":0";
    resetPopupCheck();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const launched: { script: string; spec: Record<string, unknown> }[] = [];
    const told: string[] = [];
    stdin.on("data", (chunk: Buffer) => told.push(String(chunk).trim()));
    const feedback: unknown[] = [];
    const channel = new DesktopChannel({
      platform: "linux",
      popupScript: "/x/oathrion-notify-window.py",
      spawnSyncImpl: () => 0,
      spawnPopup: (script, spec) => {
        launched.push({ script, spec: JSON.parse(spec) as Record<string, unknown> });
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { stdin, stdout, kill: () => true });
        return child;
      },
      onAction: (_e, id) => (id === "stop" ? "agy stopped" : "agy resumed"),
      onFeedback: (_e, right, decision) => feedback.push({ right, decision }),
    });
    const result = await channel.deliver(event);
    expect(result.detail).toBe('Oathrion window, buttons "Resume" "Stop it"');
    expect(launched[0]!.spec).toMatchObject({ kind: "alert", title: "agy was paused", body: "Nothing it was doing is lost.", agent: "agy · Nova", mascot: "/x/mascots/nova.svg", mascotId: "nova", actions: [{ id: "resume" }, { id: "stop" }] });

    stdout.write('{"choice": "stop"}\n');
    await new Promise((done) => setTimeout(done, 20));
    expect(told).toEqual(['{"done":"agy stopped"}']);
    stdout.write('{"feedback": "wrong"}\n');
    await new Promise((done) => setTimeout(done, 20));
    expect(feedback).toEqual([{ right: false, decision: "agy stopped" }]);
  });

  it("partager depuis la notification : la phrase vient de ce que le bouton a fait ; le réseau s'ouvre avec elle", async () => {
    process.env.DISPLAY = ":0";
    resetPopupCheck();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const told: string[] = [];
    stdin.on("data", (chunk: Buffer) => told.push(String(chunk).trim()));
    const shared: unknown[] = [];
    const channel = new DesktopChannel({
      platform: "linux",
      popupScript: "/x/oathrion-notify-window.py",
      spawnSyncImpl: () => 0,
      spawnPopup: () => {
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { stdin, stdout, kill: () => true });
        return child;
      },
      onAction: () => ({ text: "Stopped. Nova won't do anything.", share: "Oathrion caught my AI agent agy acting where it should not, and I stopped it in one click." }),
      onShare: (_e, network, sentence) => shared.push({ network, sentence }),
    });
    await channel.deliver(event);
    stdout.write('{"share": "linkedin"}\n');
    await new Promise((done) => setTimeout(done, 20));
    expect(shared).toEqual([]);
    stdout.write('{"choice": "stop"}\n');
    await new Promise((done) => setTimeout(done, 20));
    expect(JSON.parse(told[0]!)).toEqual({ done: "Stopped. Nova won't do anything.", share: "Oathrion caught my AI agent agy acting where it should not, and I stopped it in one click." });
    stdout.write('{"share": "linkedin"}\n{"share": "elsewhere"}\n');
    await new Promise((done) => setTimeout(done, 20));
    expect(shared).toEqual([{ network: "linkedin", sentence: "Oathrion caught my AI agent agy acting where it should not, and I stopped it in one click." }]);
  });

  it("un leurre lu : la fenêtre en rouge, la phrase à partager d'emblée", async () => {
    process.env.DISPLAY = ":0";
    resetPopupCheck();
    const launched: Record<string, unknown>[] = [];
    const channel = new DesktopChannel({
      platform: "linux",
      popupScript: "/x/oathrion-notify-window.py",
      spawnSyncImpl: () => 0,
      spawnPopup: (_script, spec) => {
        launched.push(JSON.parse(spec) as Record<string, unknown>);
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => true });
        return child;
      },
      onAction: () => "",
      onShare: () => undefined,
    });
    await channel.deliver({ ...event, data: { ...event.data, danger: true, share: "Something read one of the fake secrets Oathrion laid on my computer.", actions: [{ id: "open", label: "See what happened" }] } });
    expect(launched[0]).toMatchObject({ kind: "danger", share: "Something read one of the fake secrets Oathrion laid on my computer.", actions: [{ id: "open" }] });
  });

  it("sans GTK, ou sans écran : la notification du système, comme avant", async () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    resetPopupCheck();
    let popups = 0;
    const calls: string[][] = [];
    const channel = new DesktopChannel({
      platform: "linux",
      popupScript: "/x/oathrion-notify-window.py",
      spawnSyncImpl: () => 0,
      spawnPopup: () => {
        popups += 1;
        throw new Error("pas de fenêtre");
      },
      spawnImpl: (_command, args) => {
        calls.push(args);
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { stdout: new PassThrough() });
        setTimeout(() => child.emit("exit", 0), 5);
        return child;
      },
      onAction: () => "done",
    });
    expect((await channel.deliver(event)).detail).toBe('notify-send, buttons "Resume" "Stop it"');
    expect(popups).toBe(0);
    expect(calls[0]).toContain("--action=stop=Stop it");
  });

  it("sous Wayland : XWayland, et sa clé retrouvée quand le pivot ne l'a pas reçue", () => {
    const run = mkdtempSync(join(tmpdir(), "oathrion-session-"));
    writeFileSync(join(run, ".mutter-Xwaylandauth.ABC123"), "");
    expect(popupEnv({ DISPLAY: ":0", XDG_RUNTIME_DIR: run })).toMatchObject({ GDK_BACKEND: "x11", XAUTHORITY: join(run, ".mutter-Xwaylandauth.ABC123") });
    expect(popupEnv({ DISPLAY: ":0", XAUTHORITY: "/x/auth", XDG_RUNTIME_DIR: run }).XAUTHORITY).toBe("/x/auth");
    expect(popupEnv({ WAYLAND_DISPLAY: "wayland-0" }).GDK_BACKEND).toBeUndefined();
  });

  it("une fenêtre qui ne peut pas s'afficher (elle meurt aussitôt) : la notification du système prend le relais", async () => {
    process.env.DISPLAY = ":0";
    resetPopupCheck();
    const calls: string[][] = [];
    const channel = new DesktopChannel({
      platform: "linux",
      popupScript: "/x/oathrion-notify-window.py",
      spawnSyncImpl: () => 0,
      spawnPopup: () => {
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => true });
        setTimeout(() => child.emit("exit", 1), 10);
        return child;
      },
      spawnImpl: (_command, args) => {
        calls.push(args);
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { stdout: new PassThrough() });
        setTimeout(() => child.emit("exit", 0), 5);
        return child;
      },
      onAction: () => "done",
    });
    expect((await channel.deliver(event)).detail).toBe('notify-send, buttons "Resume" "Stop it"');
    expect(calls).toHaveLength(1);
  });

  it("le script de la fenêtre : GTK 3, une ligne JSON par geste, l'écoute du pivot, le mode capture", () => {
    expect(POPUP_PY).toContain('gi.require_version("Gtk", "3.0")');
    expect(POPUP_PY).toContain('emit({"choice": action["id"]})');
    expect(POPUP_PY).toContain('emit({"share": network})');
    expect(POPUP_PY).toContain("clipboard.set_image(picture)");
    expect(POPUP_PY).toContain('emit({"feedback": verdict})');
    expect(POPUP_PY).toContain("GLib.io_add_watch(sys.stdin");
    expect(POPUP_PY).toContain("Gtk.OffscreenWindow()");
  });
});
