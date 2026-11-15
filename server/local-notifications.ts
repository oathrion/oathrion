/**
 * PRÉVENIR L'APPROBATEUR, en local (`oathrion wrap`, pivot local).
 *
 * Une action retenue n'a de sens que si quelqu'un la voit. Le pivot prévient :
 *
 *   · sur le BUREAU, par défaut et sans réglage (`notifications/desktop.ts`) ; le bouton
 *     « Décider » ouvre la console déjà connectée, par un lien que le pivot fabrique avec son
 *     secret — jamais un lien qui passerait par l'agent ;
 *   · sur SLACK, si la personne l'a configuré (`oathrion notifications slack <url>`) : un
 *     message SANS boutons (Slack ne peut pas rappeler 127.0.0.1), qui dit où décider.
 *
 * Le réglage vit dans `_local/notifications.json` (0600 : un webhook Slack porte son secret dans
 * son adresse). Il est relu à chaque envoi : le changer ne demande aucun redémarrage.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { mintLocalLoginTicket } from "@shared/local-login-ticket";

import { shareUrl } from "@shared/share";
import { mintDecideToken } from "./local-decide-links";
import type { DecisionDesk } from "./local-decisions";
import { TelegramPhone } from "./local-telegram";

import { coalesced } from "./notifications/coalesce";
import { DesktopChannel, desktopText, doneOf, type Spawner } from "./notifications/desktop";
import { writePopupScript } from "./notifications/popup";
import { SlackChannel } from "./notifications/slack";
import type { Notifier } from "./notifications";
import type { DeliveryResult, NotificationChannel, NotificationEvent, NotificationEventType } from "./notifications/types";

export const NOTIFICATIONS_FILE = "notifications.json";

export interface LocalNotificationSettings {
  slackWebhookUrl?: string;
  desktop?: boolean;
  /** Le son d'Oathrion avec chaque notification de l'ordinateur (oui par défaut). */
  sound?: boolean;
}

export function readNotificationSettings(stateDir: string): LocalNotificationSettings {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, NOTIFICATIONS_FILE), "utf8")) as Record<string, unknown>;
    return {
      ...(typeof raw.slackWebhookUrl === "string" && raw.slackWebhookUrl.trim() !== "" ? { slackWebhookUrl: raw.slackWebhookUrl.trim() } : {}),
      ...(typeof raw.desktop === "boolean" ? { desktop: raw.desktop } : {}),
      ...(typeof raw.sound === "boolean" ? { sound: raw.sound } : {}),
    };
  } catch {
    return {};
  }
}

/** Le message local : qui veut quoi, en clair, plutôt que le verbe technique. */
function localEvent(event: NotificationEvent): NotificationEvent {
  const { title, body } = desktopText(event);
  return { ...event, title, summary: body };
}

/** Slack, relu à chaque envoi ; sans boutons. */
class ConfiguredSlackChannel implements NotificationChannel {
  readonly id = "slack-local";

  constructor(private readonly stateDir: string) {}

  handles(type: NotificationEventType): boolean {
    return type === "approval.requested" && readNotificationSettings(this.stateDir).slackWebhookUrl !== undefined;
  }

  async deliver(event: NotificationEvent): Promise<DeliveryResult> {
    const url = readNotificationSettings(this.stateDir).slackWebhookUrl;
    if (!url) return { channelId: this.id, eventId: event.id, at: new Date().toISOString(), ok: false, detail: "Slack is no longer configured" };
    try {
      const channel = new SlackChannel({
        url,
        buttons: false,
        decideHint: 'To decide on your computer: "oathrion console" opens the console, already signed in — or in your client, if it asks.',
      });
      return { ...(await channel.deliver(localEvent(event))), channelId: this.id };
    } catch (error) {
      /* L'adresse n'est jamais journalisée : un webhook Slack porte son secret dans son chemin. */
      return { channelId: this.id, eventId: event.id, at: new Date().toISOString(), ok: false, detail: `Slack webhook refused: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

/**
 * L'IDENTITÉ SONORE (12 novembre) : le son d'Oathrion, joué sans attendre et sans rien ouvrir.
 * Le premier lecteur présent : PipeWire, PulseAudio, ALSA ; `afplay` sous macOS ; le lecteur de
 * .NET sous Windows. Aucun : en silence.
 */
export function playSound(file: string): void {
  if (!existsSync(file)) return;
  const quoted = `'${file.replace(/'/g, "''")}'`;
  const players: [string, string[]][] =
    process.platform === "darwin"
      ? [["afplay", [file]]]
      : process.platform === "win32"
        ? [["powershell", ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer ${quoted}).PlaySync()`]]]
        : [
            ["pw-play", [file]],
            ["paplay", [file]],
            ["aplay", ["-q", file]],
          ];
  const attempt = (at: number) => {
    const player = players[at];
    if (!player) return;
    try {
      const child = spawn(player[0], player[1], { stdio: "ignore" });
      child.once("error", () => attempt(at + 1));
      child.unref();
    } catch {
      attempt(at + 1);
    }
  };
  attempt(0);
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const opener = spawn(command, args as string[], { detached: true, stdio: "ignore" });
    opener.on("error", () => undefined);
    opener.unref();
  } catch {
    /* la console reste joignable par « oathrion console » */
  }
}

/**
 * Quand la question est déjà posée DANS le client (Claude Code), la personne est devant : la
 * notification attendrait en double. Elle attend donc `graceMs`, et ne part que si la demande
 * est toujours en attente — la personne n'a pas vu la question, ou l'a fermée.
 */
export interface InClientGrace {
  asks: (agentId: string | null) => boolean;
  pending: (approvalId: string | null) => Promise<boolean>;
  graceMs: number;
}

function afterGrace(grace: InClientGrace | undefined, deliver: (event: NotificationEvent) => Promise<DeliveryResult>, channelId: string) {
  return async (event: NotificationEvent): Promise<DeliveryResult> => {
    if (grace && grace.asks(event.agentId)) {
      await new Promise((done) => setTimeout(done, grace.graceMs));
      if (!(await grace.pending(event.approvalId))) {
        return { channelId, eventId: event.id, at: new Date().toISOString(), ok: true, detail: "decided in the client: no notification" };
      }
    }
    return deliver(event);
  };
}

/** Une minute : la première demande part tout de suite, les suivantes de la minute partent ensemble. */
export const NOTIFICATION_GROUP_MS = 60_000;

/**
 * LE CALME (12 novembre) : le téléphone ne sonne que si personne n'a décidé sur l'ordinateur
 * pendant ce temps — devant son écran, on n'est pas sollicité deux fois. Tout de suite : une
 * alerte (un leurre lu), la démo, ou quand la notification de l'ordinateur est coupée (« je
 * suis parti »). `OATHRION_LOCAL_PHONE_DELAY_MS` le règle (les essais).
 */
export const PHONE_DELAY_MS = 45_000;
/** Au plus un son toutes les 30 secondes ; celui du danger passe toujours. */
export const SOUND_GAP_MS = 30_000;

function phoneDelay(): number {
  const raw = process.env.OATHRION_LOCAL_PHONE_DELAY_MS;
  const ms = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : PHONE_DELAY_MS;
}

const wait = (ms: number) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });

/*
 * LA NOTIFICATION QUI DÉCIDE (10 novembre, `notes/CONCEPTION-MASCOTTES.md`) : une alerte du pivot
 * porte ses deux boutons et ce que fait chacun ; la personne décide sans ouvrir la console.
 * Après sa décision, une seconde notification lui demande si Oathrion a eu raison (👍 / 👎) :
 * la réponse est gardée sur la machine (`feedback.jsonl`), jamais envoyée.
 */
export interface Announcement {
  id: string;
  name: string;
  description: string;
  title?: string;
  /** L'image de l'agent (sa mascotte), un fichier local. */
  image?: string;
  /**
   * Trois boutons au plus, le premier est le principal ; `id: "open"` ouvre la console sans
   * décider. `onChoice` rend ce qui a été fait, et, si cela se partage, la phrase à partager.
   */
  actions?: { id: string; label: string }[];
  onChoice?: (actionId: string) => Promise<Done> | Done;
  /** Ce qu'Oathrion a fait, pour la question du feedback (« paused agy »). */
  feedbackAbout?: string;
  /** Le titre et la description sont affichés tels quels (pas le texte du programme jamais vu). */
  custom?: boolean;
  /** L'élément du fil d'actualité qui raconte cette alerte. */
  feedId?: string;
  /** Un leurre lu : la fenêtre en rouge. */
  danger?: boolean;
  /** La phrase à partager dès l'alerte (rien de privé, `local-feed.ts`). */
  share?: string;
  /** L'agent dont la mascotte est montrée, s'il n'est pas `name` (la démo : Nova). */
  mascotOf?: string;
  /** Sur le téléphone tout de suite, sans attendre l'ordinateur (la démo du parcours guidé). */
  phoneNow?: boolean;
}

export type Done = string | { text: string; share?: string };

export const FEEDBACK_FILE = "feedback.jsonl";

/** Une réponse 👍 / 👎, gardée sur la machine. */
export function recordFeedback(stateDir: string, entry: { about: string; decision: string; right: boolean }, now = new Date()): void {
  appendFileSync(join(stateDir, FEEDBACK_FILE), `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
}

/** Branche les canaux du pivot sur le notificateur du serveur. */
export function registerLocalNotifications(
  target: Notifier,
  options: {
    stateDir: string;
    baseUrl: string;
    secret: string;
    desktopAllowed: boolean;
    inClient?: InClientGrace;
    /** Trancher une approbation depuis la notification, par la même voie que la console. */
    decideApproval?: (approvalId: string, status: "approved" | "rejected") => Promise<string>;
    /** L'image d'Oathrion (en attendant la mascotte de chaque agent). */
    image?: string;
    /** Pour les essais : un faux lanceur de `notify-send` (rien ne s'affiche). */
    spawnImpl?: Spawner;
    /** La mascotte d'un agent (`local-mascots.ts`) : une image locale, et son nom. */
    mascotFor?: (agent: string) => { path: string; name: string; id: string };
    /** `false` : jamais notre fenêtre, toujours `notify-send` (les essais). */
    popup?: boolean;
    /** Les décisions ouvertes dans la console par « Decide » (macOS, Windows : `local-decisions.ts`). */
    decisions?: DecisionDesk;
    /** L'identité sonore (`client/public/sounds/`) : la demande, et le danger. */
    sounds?: { ask: string; danger: string };
    /** `false` : jamais le téléphone (les essais). */
    phone?: boolean;
    /** Pour les essais : un faux Telegram, et un faux lecteur de son. */
    phoneFetch?: typeof fetch;
    play?: (file: string) => void;
    /** Garder une carte à partager, que la console ouvrira (`LocalHub.keepShareCard`) ; rend son jeton. */
    keepShareCard?: (card: { sentence: string; mascot: { id: string; name: string }; at: string; tone: "good" | "warn" | "bad" | "info" }) => string;
  },
): (program: Announcement) => void {
  /* Ce que fait chaque bouton, et de quoi parle le feedback, par notification envoyée. */
  const choices = new Map<string, { onChoice: (actionId: string) => Promise<Done> | Done; about: string }>();
  const abouts = new Map<string, string>();
  /* Le bouton agit, et rend ce qui a été fait : la fenêtre l'affiche, puis demande « Was Oathrion right? ». */
  const act = async (event: NotificationEvent, actionId: string): Promise<unknown> => {
    /* « See what happened » : la console, déjà connectée, sur le fil d'actualité. */
    if (actionId === "open") {
      openBrowser(`${options.baseUrl}/console#/connexion-locale?ticket=${mintLocalLoginTicket(options.secret)}&next=${encodeURIComponent("/home")}`);
      return "";
    }
    const choice = choices.get(event.id);
    if (choice) {
      choices.delete(event.id);
      abouts.set(event.id, choice.about);
      return choice.onChoice(actionId);
    }
    /* Une approbation : « Approve » / « Reject », par la même voie que la console. */
    if (event.approvalId && options.decideApproval && (actionId === "approve" || actionId === "reject")) {
      abouts.set(event.id, `asked you before ${event.agentName} acted`);
      return options.decideApproval(event.approvalId, actionId === "approve" ? "approved" : "rejected");
    }
    return "";
  };
  const feedback = (event: NotificationEvent, right: boolean, decision: string): void => {
    recordFeedback(options.stateDir, { about: abouts.get(event.id) ?? event.title, decision, right });
    abouts.delete(event.id);
  };
  /*
   * UNE DÉCISION, PARTOUT (12 novembre) : décidée sur un canal (l'ordinateur, la console, le
   * téléphone), elle efface les boutons des autres, qui disent où elle a été prise.
   */
  const settleElsewhere = (event: NotificationEvent, done: unknown, via: "computer" | "console" | "phone") => {
    const { text } = doneOf(done);
    if (text === "Done") return;
    const where = { computer: "on your computer", console: "in Oathrion's console", phone: "from your phone" }[via];
    if (via !== "phone") void phone?.settled(event.id, `${text} (${where})`).catch(() => undefined);
    if (via !== "computer") desktop?.settled(event.id, `${text} (${where})`);
    open.delete(event.id);
  };
  const actFrom = (via: "computer" | "console" | "phone") => async (event: NotificationEvent, actionId: string) => {
    const done = await act(event, actionId);
    settleElsewhere(event, done, via);
    return done;
  };
  /* Les approbations encore ouvertes sur un canal : tranchées ailleurs (la page « Approvals »), on le voit ici. */
  const open = new Map<string, NotificationEvent>();
  const track = (event: NotificationEvent) => {
    if (event.approvalId && options.inClient) open.set(event.id, event);
  };
  if (options.inClient) {
    const pending = options.inClient.pending;
    const sweep = setInterval(() => {
      for (const [id, event] of open) {
        void pending(event.approvalId).then((still) => {
          if (!still && open.has(id)) settleElsewhere(event, "Decided", "console");
        });
      }
    }, 5_000);
    sweep.unref?.();
  }
  /* Les mêmes boutons et le même feedback pour la décision ouverte dans la console. */
  options.decisions?.bind({ act: actFrom("console"), feedback });
  /* La mascotte de l'agent, dans chaque notification. */
  const withMascot = (event: NotificationEvent): NotificationEvent => {
    const mascot = options.mascotFor?.(typeof event.data.mascotOf === "string" ? event.data.mascotOf : event.agentName);
    return mascot ? { ...event, data: { ...event.data, mascot, image: mascot.path } } : options.image ? { ...event, data: { image: options.image, ...event.data } } : event;
  };
  /* Le son d'Oathrion sur l'ordinateur, avec chaque notification : celui de la demande, ou celui du danger. */
  let lastRing = 0;
  const ring = (event: NotificationEvent) => {
    if (!options.sounds || process.env.OATHRION_LOCAL_NOTIFY_SOUND === "0" || readNotificationSettings(options.stateDir).sound === false) return;
    const danger = event.data.danger === true;
    if (!danger && Date.now() - lastRing < SOUND_GAP_MS) return;
    lastRing = Date.now();
    (options.play ?? playSound)(danger ? options.sounds.danger : options.sounds.ask);
  };
  const desktopOn = () => desktop !== null && readNotificationSettings(options.stateDir).desktop !== false;
  /*
   * LE TÉLÉPHONE (12 novembre, `local-telegram.ts`) : la machine peut rester à la maison, sans
   * écran — la demande arrive sur Telegram, avec la mascotte et ses boutons, partout.
   */
  const phone = options.phone === false || process.env.OATHRION_LOCAL_NOTIFY_PHONE === "0" ? null : new TelegramPhone({ dir: options.stateDir, act: actFrom("phone"), feedback, text: desktopText, ...(options.phoneFetch ? { fetchImpl: options.phoneFetch } : {}) });
  if (phone) {
    phone.start();
    process.once("exit", () => phone.stop());
    const toPhone = async (event: NotificationEvent): Promise<DeliveryResult> => {
      /* Devant l'ordinateur, on y décide : le téléphone n'est sollicité que si rien n'est tranché. */
      if (desktopOn()) {
        await wait(phoneDelay());
        if (event.approvalId && options.inClient && !(await options.inClient.pending(event.approvalId))) {
          return { channelId: "telegram", eventId: event.id, at: new Date().toISOString(), ok: true, detail: "decided on the computer: the phone was not needed" };
        }
      }
      const at = new Date().toISOString();
      try {
        track(event);
        const ok = await phone.deliver(withMascot(event));
        return { channelId: "telegram", eventId: event.id, at, ok, detail: ok ? "Telegram" : "Telegram is not paired" };
      } catch (error) {
        return { channelId: "telegram", eventId: event.id, at, ok: false, detail: `Telegram: ${error instanceof Error ? error.message : String(error)}` };
      }
    };
    target.register({
      id: "telegram",
      handles: (type) => type === "approval.requested" && phone.configured,
      deliver: afterGrace(options.inClient, coalesced(toPhone, "telegram", { windowMs: NOTIFICATION_GROUP_MS, pending: options.inClient?.pending }), "telegram"),
    });
  }
  let desktop: DesktopChannel | null = null;
  if (options.desktopAllowed) {
    const popupScript = options.popup === false || process.env.OATHRION_LOCAL_NOTIFY_POPUP === "0" ? undefined : writePopupScript(options.stateDir);
    const channel = new DesktopChannel({
      ...(options.spawnImpl ? { platform: "linux" as const, spawnImpl: options.spawnImpl } : {}),
      ...(popupScript ? { popupScript } : {}),
      /*
       * « Decide » : la console, déjà connectée — sur CETTE décision quand la notification a des
       * boutons que le système n'a pas pu montrer (macOS, Windows : la mascotte, les boutons, puis le
       * partage), sinon sur l'accueil.
       */
      onDecide: (_approvalId, event) => {
        const kept = event ? options.decisions?.keep(event) : null;
        openBrowser(`${options.baseUrl}/console#/connexion-locale?ticket=${mintLocalLoginTicket(options.secret)}${kept ? `&next=${encodeURIComponent(`/decide?e=${kept}`)}` : ""}`);
      },
      /*
       * « Share it » : la carte s'ouvre dans la console, où le navigateur la copie lui-même puis
       * ouvre le réseau (essai réel du 11 novembre : copiée par la fenêtre, sous X11, elle
       * n'arrivait pas dans Chrome, sous Wayland). Sans console, le réseau directement.
       */
      onShare: (event, network, sentence) => {
        const mascot = (event.data.mascot ?? null) as { id?: unknown; name?: unknown } | null;
        if (!options.keepShareCard || typeof mascot?.id !== "string") {
          openBrowser(shareUrl(network, sentence));
          return;
        }
        const token = options.keepShareCard({
          sentence,
          mascot: { id: mascot.id, name: typeof mascot.name === "string" ? mascot.name : mascot.id },
          at: new Date().toISOString(),
          tone: event.data.danger === true ? "bad" : "good",
        });
        openBrowser(`${options.baseUrl}/console#/connexion-locale?ticket=${mintLocalLoginTicket(options.secret)}&next=${encodeURIComponent(`/share?t=${token}&to=${network}`)}`);
      },
      /* Windows ouvre une adresse au clic : un jeton à usage unique, échangé contre une connexion neuve. */
      decideUrl: (event) => {
        const kept = event ? options.decisions?.keep(event) : null;
        return `${options.baseUrl}/api/local/decider?n=${mintDecideToken()}${kept ? `&e=${encodeURIComponent(kept)}` : ""}`;
      },
      onAction: actFrom("computer"),
      onFeedback: feedback,
    });
    desktop = channel;
    /* Le pivot s'arrête : ses fenêtres se ferment avec lui (pas d'anciennes notifications qui traînent). */
    process.once("exit", () => channel.close());
    /* Le bureau se coupe dans le réglage (`oathrion notifications bureau non`), relu à chaque envoi. */
    target.register({
      id: channel.id,
      handles: (type) => channel.handles(type) && readNotificationSettings(options.stateDir).desktop !== false,
      deliver: afterGrace(
        options.inClient,
        coalesced(
          (event) => {
            const shown = withMascot(event);
            ring(shown);
            track(shown);
            return channel.deliver(shown);
          },
          channel.id,
          { windowMs: NOTIFICATION_GROUP_MS, pending: options.inClient?.pending },
        ),
        channel.id,
      ),
    });
  }
  /*
   * Un programme jamais vu (9 novembre), un agent mis en pause, un leurre lu : prévenu tout de
   * suite, sans délai de grâce — sur l'ordinateur, et sur le téléphone s'il est appairé.
   */
  const announce = (program: Announcement) => {
    const onDesktop = desktop !== null && readNotificationSettings(options.stateDir).desktop !== false;
    const onPhone = phone?.configured === true;
    if (!onDesktop && !onPhone) return;
    const eventId = `program_${program.id}_${Date.now().toString(36)}`;
    if (program.onChoice && program.actions?.length) choices.set(eventId, { onChoice: program.onChoice, about: program.feedbackAbout ?? program.title ?? program.name });
    const event = withMascot({
        id: eventId,
        type: "approval.requested",
        at: new Date().toISOString(),
        title: program.title ?? "A program Oathrion has never seen wants to use your servers",
        summary: program.description,
        risk: "high",
        agentId: program.id,
        agentName: program.name,
        executionId: null,
        approvalId: null,
        policyId: null,
        policyName: null,
        data: {
          /* Un titre donné (agent en pause, leurre lu) : affiché tel quel ; sinon, un programme jamais vu. */
          ...(program.custom ? { custom: true } : { unknownProgram: true, ...(program.title ? { title: program.title } : {}) }),
          description: program.description,
          ...(program.image ?? options.image ? { image: program.image ?? options.image } : {}),
          ...(program.actions?.length ? { actions: program.actions } : {}),
          ...(program.feedId ? { feedId: program.feedId } : {}),
          ...(program.danger ? { danger: true } : {}),
          ...(program.share ? { share: program.share } : {}),
          ...(program.mascotOf ? { mascotOf: program.mascotOf } : {}),
        },
      });
    if (onDesktop) {
      ring(event);
      void desktop!.deliver(event).catch(() => undefined);
    }
    if (onPhone) {
      /* Une alerte, la démo, ou personne devant l'ordinateur : tout de suite. Sinon, seulement si rien n'a été décidé. */
      const now = program.danger === true || program.phoneNow === true || !onDesktop;
      const asked = program.onChoice !== undefined && (program.actions?.length ?? 0) > 0;
      void (async () => {
        if (!now) {
          await wait(phoneDelay());
          if (asked && !choices.has(eventId)) return;
        }
        await phone!.deliver(event);
      })().catch(() => undefined);
    }
  };
  const slack = new ConfiguredSlackChannel(options.stateDir);
  target.register({
    id: slack.id,
    handles: (type) => slack.handles(type),
    deliver: afterGrace(options.inClient, coalesced((event) => slack.deliver(event), slack.id, { windowMs: NOTIFICATION_GROUP_MS, pending: options.inClient?.pending }), slack.id),
  });
  return announce;
}
