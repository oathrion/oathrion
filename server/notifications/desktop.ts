/**
 * La notification de BUREAU — prévenir la personne qu'une action attend sa décision, sur sa
 * machine, sans rien configurer (`oathrion wrap`, pivot local).
 *
 * Sans elle, une demande pouvait attendre sans que personne ne la voie : c'était l'écart le plus
 * net face aux passerelles qui préviennent par Slack ou par e-mail (comparaison du 28 octobre
 * 2026). Elle passe par l'outil de notification du système :
 *
 *   · Linux : `notify-send`, avec un bouton « Décider » quand il le permet ; le clic ouvre la
 *     console DÉJÀ CONNECTÉE, par un lien que fabrique le pivot (`onDecide`) — jamais l'agent ;
 *   · macOS : un dialogue `osascript` « Plus tard / Décider », qui s'efface seul après deux
 *     minutes ; « Décider » appelle `onDecide`, comme sous Linux. S'il ne peut s'afficher, une
 *     notification simple, qui dit quoi faire ;
 *   · Windows : une notification Windows avec « Décider » et « Plus tard ». Windows y ouvre une
 *     ADRESSE, sans rappeler le pivot : `decideUrl` en fabrique une à usage unique
 *     (`server/local-decide-links.ts`). À défaut, une bulle qui dit quoi faire.
 *
 * Sous macOS et Windows, rien n'a encore été essayé sur une vraie machine (`docs/not-yet.md`).
 *
 * Elle ne bloque jamais : la notification part, le clic est traité à part. Un système sans outil
 * de notification n'est pas une erreur grave — la console et Slack restent.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { NotificationWords } from "@shared/approval-text";
import { SHARE_NETWORKS, type ShareNetwork } from "@shared/share";

import { passable } from "../local-hour-passes";
import type { DeliveryResult, NotificationChannel, NotificationEvent, NotificationEventType } from "./types";
import type { PopupSpec } from "./popup";

export const DESKTOP_CHANNEL_ID = "desktop";

export type Spawner = (command: string, args: string[]) => ChildProcess;

/*
 * L'environnement de la fenêtre. Sous Wayland, elle passe par XWayland (là, elle peut se placer
 * en haut à droite, au-dessus) : il faut `DISPLAY` et la clé d'XWayland, `XAUTHORITY`. Un pivot
 * lancé sans elle (essai réel du 11 novembre : GTK n'ouvrait pas l'écran, et rien ne
 * s'affichait) la retrouve dans le dossier de la session.
 */
export function popupEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!env.DISPLAY) return { ...env };
  let xauthority = env.XAUTHORITY;
  if (!xauthority && env.XDG_RUNTIME_DIR) {
    try {
      const found = readdirSync(env.XDG_RUNTIME_DIR).find((name) => name.startsWith(".mutter-Xwaylandauth."));
      if (found) xauthority = join(env.XDG_RUNTIME_DIR, found);
    } catch {
      /* pas de dossier de session lisible */
    }
  }
  return { ...env, GDK_BACKEND: "x11", ...(xauthority ? { XAUTHORITY: xauthority } : {}) };
}

/* Le temps qu'une fenêtre qui ne peut pas s'afficher met à mourir. */
const POPUP_GRACE_MS = 1_500;
/** Après la fin de `notify-send`, le temps laissé à sa sortie pour arriver jusqu'au bout. */
const OUTPUT_GRACE_MS = 500;

/* GTK pour Python, et l'écran VRAIMENT ouvert, avec l'environnement de la fenêtre : vérifié une fois par pivot. */
let popupChecked: boolean | null = null;
function popupAvailable(run: (command: string, args: string[]) => number | null): boolean {
  if (popupChecked === null) {
    popupChecked =
      Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) &&
      run("python3", ["-c", "import sys, gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk; sys.exit(0 if Gtk.init_check()[0] else 1)"]) === 0;
  }
  return popupChecked;
}

/** Pour les essais : oublier la vérification de GTK. */
export function resetPopupCheck(): void {
  popupChecked = null;
}

export interface DesktopChannelOptions {
  /** Pour les essais : la vérification de GTK, et le lancement de notre fenêtre. */
  spawnSyncImpl?: (command: string, args: string[]) => number | null;
  spawnPopup?: (script: string, spec: string) => ChildProcess;
  platform?: NodeJS.Platform;
  spawnImpl?: Spawner;
  /** Le clic sur « Décider » : ouvrir la console connectée, sur cette demande (et ses boutons, `local-decisions.ts`). */
  onDecide?: (approvalId: string | null, event?: NotificationEvent) => void;
  /**
   * Un bouton d'action de la notification a été cliqué (Linux). Les boutons d'un événement sont
   * dans `event.data.actions` ; sans eux, une approbation en reçoit deux, « Approve » et
   * « Reject ». Cliquer le corps de la notification ouvre la console (`onDecide`).
   */
  onAction?: (event: NotificationEvent, actionId: string) => unknown;
  /**
   * La réponse au « Was Oathrion right? » (👍 = `right`), avec ce qui a été fait. Dans notre
   * fenêtre, elle est dans la même bulle ; avec `notify-send`, dans une seconde notification.
   */
  onFeedback?: (event: NotificationEvent, right: boolean, decision: string) => void;
  /**
   * Notre fenêtre de notification (`popup.ts`) : le chemin du script. Absente, ou sans GTK sur la
   * machine : `notify-send`, comme avant.
   */
  popupScript?: string;
  /**
   * « Share it » dans notre fenêtre : la carte y est déjà copiée ; ouvrir le réseau, avec la phrase.
   * La phrase vient de l'alerte (`event.data.share`) ou de ce que le bouton a fait (`onAction`
   * rend alors `{ text, share }`).
   */
  onShare?: (event: NotificationEvent, network: ShareNetwork, sentence: string) => void;
  /**
   * « Your signed receipt » dans notre fenêtre, après une approbation tranchée (16 novembre) : la
   * console s'ouvre sur le reçu signé de cette action (`components/receipts/ReceiptMoment.tsx`).
   */
  onReceipt?: (event: NotificationEvent) => void;
  /** Windows : l'adresse qu'ouvre le bouton « Décider » (à usage unique, fabriquée par le pivot). */
  decideUrl?: (event?: NotificationEvent) => string;
}

/** Ce qu'un bouton a fait : un texte, ou `{ text, share }` quand ce qui a été fait se partage. */
export function doneOf(done: unknown): { text: string; share?: string } {
  if (typeof done === "string") return { text: done !== "" ? done : "Done" };
  if (done && typeof done === "object" && typeof (done as { text?: unknown }).text === "string") {
    const { text, share } = done as { text: string; share?: unknown };
    return { text: text !== "" ? text : "Done", ...(typeof share === "string" && share !== "" ? { share } : {}) };
  }
  return { text: "Done" };
}

/** « mcp.fichiers.write_file » → le serveur et l'outil. */
export function wrappedParts(action: unknown): { server: string; tool: string } | null {
  const match = /^mcp\.([a-z0-9][a-z0-9_-]*)\.(.+)$/.exec(String(action ?? ""));
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

/** Les mots d'une demande (`shared/approval-text.ts`), s'ils sont là et bien formés. */
function wordsOf(event: NotificationEvent): NotificationWords | null {
  const words = event.data.words as Partial<NotificationWords> | undefined;
  return words && typeof words.headline === "string" ? { headline: words.headline, content: typeof words.content === "string" ? words.content : null, why: typeof words.why === "string" ? words.why : null } : null;
}

/**
 * Ce que dit la notification : qui veut faire quoi, sur quoi exactement, et pourquoi Oathrion
 * demande (16 novembre, retour des premiers testeurs : sans le quoi ni le pourquoi, on approuve
 * sans lire). `content: false` : sans le contenu (les arguments peuvent être privés) — pour le
 * téléphone, dont les messages passent par Telegram.
 */
export function desktopText(event: NotificationEvent, { content = true }: { content?: boolean } = {}): { title: string; body: string } {
  /* Plusieurs demandes rapprochées, en une seule notification (`notifications/coalesce.ts`) : la liste, pas un renvoi à la console. */
  if (typeof event.data.grouped === "number") {
    const lines = Array.isArray(event.data.headlines) ? event.data.headlines.filter((h): h is string => typeof h === "string") : [];
    const more = event.data.grouped - Math.min(lines.length, 3);
    const body = lines.length > 0 ? [...lines.slice(0, 3).map((line) => `· ${line}`), ...(more > 0 ? [`· and ${String(more)} more`] : []), "Decide each one in Oathrion's console."].join("\n") : `${event.summary} Decide in Oathrion's console.`;
    return { title: `${String(event.data.grouped)} requests are waiting for your decision`.slice(0, 120), body: body.slice(0, 300) };
  }
  const words = wordsOf(event);
  const why = words?.why ? `Why: ${words.why}.` : null;
  /* Une commande de Claude Code envoyée par son hook (mode automatique) : la commande elle-même, pas « shell ». */
  if (typeof event.data.action === "string" && event.data.action.startsWith("mcp.claude-code.")) {
    const command = typeof event.data.command === "string" ? event.data.command : String(event.data.target ?? "").replace(/^file:\/\//, "");
    const verb = event.data.action.endsWith(".file_write") ? "write" : "run";
    return { title: `Claude Code wants to ${verb}: ${command}`.slice(0, 120), body: (why ?? "It is in auto mode, so Oathrion asks you. Your approval is needed before it runs.").slice(0, 300) };
  }
  /*
   * Une alerte du pivot qui porte son propre titre (un agent mis en pause, un leurre lu, la
   * question du feedback) : son titre et son texte, tels quels (10 novembre : ils étaient
   * remplacés par le texte du programme jamais vu).
   */
  if (event.data.custom === true) {
    return { title: event.title.slice(0, 120), body: event.summary.slice(0, 300) };
  }
  /*
   * Un programme jamais vu (`server/local-programs.ts`). 16 novembre, retour des premiers
   * testeurs (« pourquoi Oathrion a bloqué ? ») : la question qu'on pose vraiment, et que c'est
   * normal, une fois par programme ; le chemin et l'empreinte restent dans la console.
   */
  if (event.data.unknownProgram === true) {
    const here = Array.isArray(event.data.actions) && event.data.actions.length > 0;
    return {
      title: (typeof event.data.title === "string" ? event.data.title : `First time Oathrion meets "${event.agentName}": is it yours?`).slice(0, 120),
      body: `Nothing it asks goes through until you answer: Oathrion checks each program once, the first time. If you just started ${event.agentName}, it is yours. ${here ? "Confirm it or block it here." : "Confirm it or block it in Oathrion's console."}`.slice(0, 300),
    };
  }
  /* Une demande d'approbation : les mots de la console (« claude-code wants to create note on the carnet server »). */
  if (words && event.type === "approval.requested") {
    const said = content && words.content ? `“${words.content}”` : null;
    return { title: words.headline.slice(0, 120), body: ([said, why].filter(Boolean).join("\n") || "Your approval is needed before the action runs.").slice(0, 300) };
  }
  const parts = wrappedParts(event.data.action);
  const title = parts ? `${event.agentName} wants to use "${parts.tool}"` : `${event.agentName} is waiting for your decision`;
  const body = parts ? `Server "${parts.server}". Your approval is needed before the action runs.` : event.title;
  return { title: title.slice(0, 120), body: body.slice(0, 300) };
}

const appleString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const powershellString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const xmlText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** L'identifiant d'application de Windows PowerShell : une notification Windows doit en nommer une installée. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** Le script d'une notification Windows à deux boutons ; « Décider » ouvre `url`. */
export function windowsToastScript(title: string, body: string, url: string): string {
  const xml =
    `<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>${xmlText(title)}</text><text>${xmlText(body)}</text></binding></visual>` +
    `<actions><action content="Decide" activationType="protocol" arguments="${xmlText(url)}"/>` +
    `<action content="Later" activationType="system" arguments="dismiss"/></actions></toast>`;
  return [
    "$ErrorActionPreference = 'Stop';",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;",
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument;",
    `$x.LoadXml(${powershellString(xml)});`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${powershellString(POWERSHELL_APP_ID)}).Show((New-Object Windows.UI.Notifications.ToastNotification $x))`,
  ].join(" ");
}

/** Le dialogue macOS : « Décider » par défaut, effacé seul après deux minutes. */
export function macDialogScript(title: string, body: string): string {
  return `display dialog ${appleString(body)} with title ${appleString(title)} buttons {"Later", "Decide"} default button "Decide" giving up after 120 with icon caution`;
}

/** Les boutons d'une notification : ceux de l'événement, sinon « Approve » / « Reject » pour une approbation. */
export function notificationActions(event: NotificationEvent): { id: string; label: string }[] {
  const given = event.data.actions;
  if (Array.isArray(given)) {
    return given
      .filter((a): a is { id: string; label: string } => a !== null && typeof a === "object" && typeof (a as { id?: unknown }).id === "string" && typeof (a as { label?: unknown }).label === "string")
      .filter((a) => /^[a-z][a-z0-9-]{0,30}$/.test(a.id) && a.id !== "default")
      .slice(0, 3);
  }
  if (event.type === "approval.requested" && event.approvalId) {
    return [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
      /* Un outil d'un serveur derrière Oathrion : une heure sans redemander (`local-hour-passes.ts`). */
      ...(passable(event.data.action) ? [{ id: "allow-hour", label: "Allow 1 hour" }] : []),
    ];
  }
  return [];
}

export class DesktopChannel implements NotificationChannel {
  readonly id = DESKTOP_CHANNEL_ID;
  private readonly platform: NodeJS.Platform;
  private readonly spawnImpl: Spawner;

  private readonly spawnSyncImpl: (command: string, args: string[]) => number | null;
  private readonly spawnPopup: (script: string, spec: string) => ChildProcess;

  constructor(private readonly options: DesktopChannelOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnImpl = options.spawnImpl ?? ((command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], detached: false }));
    this.spawnSyncImpl = options.spawnSyncImpl ?? ((command, args) => spawnSync(command, args, { stdio: "ignore", timeout: 10_000, env: popupEnv() }).status);
    this.spawnPopup = options.spawnPopup ?? ((script, spec) => spawn("python3", [script, spec], { stdio: ["pipe", "pipe", "ignore"], env: popupEnv() }));
  }

  handles(type: NotificationEventType): boolean {
    return type === "approval.requested";
  }

  async deliver(event: NotificationEvent): Promise<DeliveryResult> {
    const at = new Date().toISOString();
    const { title, body } = desktopText(event);
    const result = (ok: boolean, detail: string): DeliveryResult => ({ channelId: this.id, eventId: event.id, at, ok, detail });

    if (this.platform === "linux") {
      /*
       * La notification qui décide (10 novembre, `notes/CONCEPTION-MASCOTTES.md`) : l'image de
       * l'agent, et deux boutons qui agissent sans ouvrir la console ; cliquer le corps l'ouvre.
       * notify-send attend le clic et écrit le nom de l'action. Un notify-send trop ancien
       * refuse : un seul bouton, puis aucun.
       */
      const actions = notificationActions(event);
      const image = typeof event.data.image === "string" && event.data.image !== "" ? [`--icon=${event.data.image}`] : [];
      /* Notre fenêtre, comme la maquette : la mascotte, la bulle, les deux boutons et le feedback, ensemble. */
      if (actions.length > 0 && this.options.onAction && this.options.popupScript && popupAvailable(this.spawnSyncImpl)) {
        /* Une fenêtre qui meurt aussitôt (l'écran refusé) : la notification du système prend le relais. */
        if (await this.popup(event, title, body, actions)) return result(true, `Oathrion window, buttons ${actions.map((a) => `"${a.label}"`).join(" ")}`);
      }
      if (actions.length > 0 && this.options.onAction) {
        const rich = await this.launch(
          "notify-send",
          ["--app-name=Oathrion", "--urgency=critical", ...image, "--action=default=Open the console", ...actions.map((a) => `--action=${a.id}=${a.label}`), title, body],
          (stdout) => {
            const chosen = stdout.trim();
            if (chosen === "default") this.options.onDecide?.(event.approvalId, event);
            else if (actions.some((a) => a.id === chosen)) void this.decided(event, chosen, image);
          },
        );
        if (rich.ok) return result(true, `notify-send, buttons ${actions.map((a) => `"${a.label}"`).join(" ")}`);
      }
      const withAction = await this.launch("notify-send", ["--app-name=Oathrion", "--urgency=critical", ...image, "--action=decider=Decide", title, body], (stdout) => {
        if (stdout.trim() === "decider") this.options.onDecide?.(event.approvalId, event);
      });
      if (withAction.ok) return result(true, 'notify-send, "Decide" button');
      const plain = await this.launch("notify-send", ["--app-name=Oathrion", "--urgency=critical", title, `${body} To decide: oathrion console`]);
      return result(plain.ok, plain.ok ? "notify-send" : `no desktop notification: ${plain.detail}`);
    }
    if (this.platform === "darwin") {
      /* Le dialogue attend le clic et écrit « button returned:Decide » ; s'il ne peut s'afficher, une notification simple. */
      const dialog = await this.launch("osascript", ["-e", macDialogScript(title, body)], (stdout) => {
        if (/button returned:Decide/.test(stdout)) this.options.onDecide?.(event.approvalId, event);
      });
      if (dialog.ok) return result(true, 'osascript, "Decide" dialog');
      const sent = await this.launch("osascript", ["-e", `display notification ${appleString(`${body} To decide: oathrion console`)} with title ${appleString(title)}`]);
      return result(sent.ok, sent.ok ? "osascript" : `no desktop notification: ${sent.detail}`);
    }
    if (this.platform === "win32") {
      /* Une notification Windows à boutons ; à défaut (Windows ancien, PowerShell sans WinRT), la bulle. */
      if (this.options.decideUrl) {
        /* Attendue jusqu'au bout : PowerShell démarre lentement, et un échec doit mener à la bulle. */
        const toast = await this.launch("powershell", ["-NoProfile", "-Command", windowsToastScript(title, body, this.options.decideUrl(event))], undefined, true);
        if (toast.ok) return result(true, 'Windows notification, "Decide" button');
      }
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$n = New-Object System.Windows.Forms.NotifyIcon;",
        "$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true;",
        `$n.ShowBalloonTip(10000, ${powershellString(title)}, ${powershellString(`${body} To decide: oathrion console`)}, 'Warning');`,
        "Start-Sleep -Seconds 11; $n.Dispose()",
      ].join(" ");
      const sent = await this.launch("powershell", ["-NoProfile", "-Command", script]);
      return result(sent.ok, sent.ok ? "powershell" : `no desktop notification: ${sent.detail}`);
    }
    return result(false, `no desktop notification on ${this.platform}`);
  }

  /* Les fenêtres ouvertes : empilées l'une sous l'autre, et fermées avec le pivot. */
  private readonly windows = new Set<ChildProcess>();
  /* Les fenêtres encore à décider, par notification : décidées ailleurs, elles le disent (`settled`). */
  private readonly undecided = new Map<string, (text: string) => void>();

  /**
   * Décidé ailleurs (le téléphone, la console) : la fenêtre de cette notification retire ses
   * boutons, le dit, ne redemande pas d'avis et se ferme. Sans fenêtre ouverte : rien.
   */
  settled(eventId: string, text: string): void {
    this.undecided.get(eventId)?.(text);
  }

  /** Ferme les fenêtres encore ouvertes (le pivot s'arrête). */
  close(): void {
    for (const child of this.windows) child.kill();
    this.windows.clear();
  }

  /** Notre fenêtre : ce que la personne choisit, ce qui a été fait, et son avis, dans la même bulle. */
  private async popup(event: NotificationEvent, title: string, body: string, actions: { id: string; label: string }[]): Promise<boolean> {
    const mascot = (event.data.mascot ?? null) as { path?: unknown; name?: unknown; id?: unknown } | null;
    let sentence = typeof event.data.share === "string" && this.options.onShare ? event.data.share : "";
    const spec: PopupSpec = {
      kind: event.data.danger === true ? "danger" : "alert",
      title,
      body,
      agent: typeof mascot?.name === "string" ? `${event.agentName} · ${mascot.name}` : event.agentName,
      ...(typeof mascot?.path === "string" ? { mascot: mascot.path } : {}),
      ...(typeof mascot?.id === "string" ? { mascotId: mascot.id } : {}),
      actions,
      ...(sentence ? { share: sentence } : {}),
      slot: this.windows.size,
    };
    let child: ChildProcess;
    try {
      child = this.spawnPopup(this.options.popupScript!, JSON.stringify(spec));
    } catch {
      return false;
    }
    this.windows.add(child);
    let decision = "";
    this.undecided.set(event.id, (text) => {
      if (decision !== "") return;
      decision = text;
      this.undecided.delete(event.id);
      child.stdin?.write(`${JSON.stringify({ settled: text })}\n`);
    });
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let message: { choice?: unknown; feedback?: unknown; open?: unknown; share?: unknown } = {};
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        /* Décidée ailleurs entre-temps (`settled`) : un clic tardif n'agit plus. */
        if (typeof message.choice === "string" && actions.some((a) => a.id === message.choice) && decision === "") {
          void (async () => {
            this.undecided.delete(event.id);
            const { text, share } = doneOf(await this.options.onAction?.(event, message.choice as string));
            decision = text;
            if (share && this.options.onShare) sentence = share;
            const receipt = event.type === "approval.requested" && event.executionId !== null && this.options.onReceipt !== undefined;
            child.stdin?.write(`${JSON.stringify({ done: decision, ...(sentence && this.options.onShare ? { share: sentence } : {}), ...(receipt ? { receipt: true } : {}) })}\n`);
          })().catch(() => undefined);
        } else if (message.feedback === "right" || message.feedback === "wrong") {
          this.options.onFeedback?.(event, message.feedback === "right", decision);
        } else if (message.open === "receipt" && decision !== "") {
          this.options.onReceipt?.(event);
        } else if (message.open === true) {
          /* Notre fenêtre a déjà ses boutons : le corps ouvre la console, pas la décision une seconde fois. */
          this.options.onDecide?.(event.approvalId);
        } else if (typeof message.share === "string" && (SHARE_NETWORKS as readonly string[]).includes(message.share) && sentence) {
          this.options.onShare?.(event, message.share as ShareNetwork, sentence);
        }
      }
    });
    /* Partie en moins d'une seconde et demie, sans un geste : elle n'a pas pu s'afficher. */
    const survived = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(true), POPUP_GRACE_MS);
      timer.unref?.();
      child.once("exit", (code) => {
        this.windows.delete(child);
        this.undecided.delete(event.id);
        clearTimeout(timer);
        done(code === 0);
      });
      child.once("error", () => {
        this.windows.delete(child);
        clearTimeout(timer);
        done(false);
      });
    });
    return survived;
  }

  /** `notify-send` : le bouton a agi ; le feedback vient dans une seconde notification. */
  private async decided(event: NotificationEvent, actionId: string, image: string[]): Promise<void> {
    if (actionId === "open") {
      this.options.onDecide?.(event.approvalId);
      return;
    }
    const decision = doneOf(await this.options.onAction?.(event, actionId)).text;
    if (!this.options.onFeedback) return;
    await this.launch(
      "notify-send",
      ["--app-name=Oathrion", ...image, "--action=right=👍 Right", "--action=wrong=👎 Wrong", `${decision}. Was Oathrion right?`, "Your answer stays on this machine."],
      (stdout) => {
        const verdict = stdout.trim();
        if (verdict === "right" || verdict === "wrong") this.options.onFeedback?.(event, verdict === "right", decision);
      },
    );
  }

  /**
   * Lance l'outil SANS l'attendre (le bouton peut attendre longtemps) ; rend dès qu'il est parti
   * ou qu'il a échoué tout de suite. `onExit` reçoit sa sortie quand il se termine.
   */
  private launch(command: string, args: string[], onExit?: (stdout: string) => void, waitExit = false): Promise<{ ok: boolean; detail: string }> {
    return new Promise((done) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(command, args);
      } catch (error) {
        done({ ok: false, detail: error instanceof Error ? error.message : String(error) });
        return;
      }
      let stdout = "";
      let settled = false;
      const settle = (value: { ok: boolean; detail: string }) => {
        if (settled) return;
        settled = true;
        done(value);
      };
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.once("error", (error) => settle({ ok: false, detail: error.message }));
      /* Un refus immédiat (option inconnue) sort vite avec un code ≠ 0 : on le voit avant de dire « parti ». */
      const early = waitExit ? undefined : setTimeout(() => settle({ ok: true, detail: "started" }), 400);
      child.once("exit", (code) => {
        clearTimeout(early);
        /*
         * « exit » peut précéder la fin de la sortie : la réponse (« right ») était alors lue vide et
         * perdue (endurance du 16 novembre, `wrap-notify.test.ts` une fois sur trois). On attend
         * que la sortie soit lue jusqu'au bout.
         */
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (code === 0) onExit?.(stdout);
          settle(code === 0 ? { ok: true, detail: "done" } : { ok: false, detail: `${command} answered ${String(code)}` });
        };
        /* Une demi-seconde au plus : un descendant qui garderait la sortie ouverte ne bloque pas tout. */
        const out = child.stdout;
        if (!out || out.readableEnded || out.destroyed) finish();
        else {
          out.once("end", finish);
          out.once("close", finish);
          setTimeout(finish, OUTPUT_GRACE_MS).unref?.();
        }
      });
    });
  }
}
