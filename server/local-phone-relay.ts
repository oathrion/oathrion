/**
 * LE TÉLÉPHONE EN UN SCAN (23 novembre 2026, `notes/CONCEPTION-RELAIS-TELEPHONE.md`) : le robot
 * Telegram OFFICIEL d'Oathrion, joint par son relais (`relay/`). La console affiche un QR code,
 * le téléphone touche Start, c'est appairé : rien à créer chez @BotFather, aucun jeton à recopier.
 * `local-telegram.ts` (son propre robot) reste pour qui l'a déjà.
 *
 * ## Comment, sans ouvrir la machine
 *
 * Le pivot ouvre une connexion SORTANTE vers le relais (WebSocket), seulement s'il est appairé ou
 * en train de l'être : une installation qui n'a jamais touché « Pair my phone » ne parle jamais au
 * relais. Il prouve sa clé (Ed25519, une par machine, dans `phone-relay.json`) en signant un défi.
 *
 * ## Ce qui protège la décision
 *
 * - Chaque bouton porte un identifiant aléatoire, en mémoire du pivot, valable une fois (comme
 *   `TelegramPhone`).
 * - Un appui n'est pris que SIGNÉ par la clé du relais, épinglée ici (`OFFICIAL_RELAY.key`) : une
 *   box ou un proxy qui intercepterait la connexion ne fabrique pas un appui. Le relais ne le
 *   transmet que s'il vient du compte appairé, dans sa conversation.
 * - Un appui de plus de quinze minutes est refusé (l'horloge de l'ordinateur peut dériver).
 *
 * ## Ce qui sort de la machine
 *
 * Comme pour `TelegramPhone` : le titre et la raison (`desktopText(event, { content: false })`),
 * passés au crible (`redactForPhone`), la mascotte. Jamais le contenu d'un fichier.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { approvalData, deviceFingerprint, PHONE_APPROVAL_TYPE, shownOf, verifyDeviceSignature, type PhoneApproval, type PhoneShown } from "@shared/phone-approval";

import { recordPhoneApproval } from "./local-phone-approvals";
import { qrOf } from "./local-phone-pairing";
import { redactForPhone } from "./local-telegram";
import { encryptPush } from "./local-web-push";
import { doneOf, friendlyResult, notificationActions, phoneFriendly } from "./notifications/desktop";
import type { NotificationEvent } from "./notifications/types";

export const RELAY_FILE = "phone-relay.json";
const DOMAIN = "oathrion-relay-v1";

/**
 * Le relais officiel. Sa clé publique s'épingle ici une fois le relais déployé (`relay/README.md`,
 * `npm run keys`) ; tant qu'elle est vide, le jumelage en un scan dit qu'il n'est pas encore là.
 * Qui héberge son propre relais : `OATHRION_PHONE_RELAY_URL` et `OATHRION_PHONE_RELAY_KEY`.
 */
export const OFFICIAL_RELAY = { url: "wss://relay.oathrion.com/v1/connect", key: "N_KYjAaO-Kf8iNM9PXwSgxILhqO01TPb9ijwzP2DQ2k" };

export function relayConfig(): { url: string; key: string } | null {
  const url = process.env.OATHRION_PHONE_RELAY_URL?.trim() || OFFICIAL_RELAY.url;
  const key = process.env.OATHRION_PHONE_RELAY_KEY?.trim() || (url === OFFICIAL_RELAY.url ? OFFICIAL_RELAY.key : "");
  return /^[A-Za-z0-9_-]{43}$/.test(key) ? { url, key } : null;
}

/* ------------------------------------------------------------------ le fichier de la machine */

export interface RelaySettings {
  /** Le relais de l'appairage, et sa clé : gardés tels quels, l'environnement ne les change plus. */
  url: string;
  relayKey: string;
  /** La clé de cette machine (PKCS#8, base64url) et son identifiant (l'empreinte de sa clé publique). */
  privateKey: string;
  publicKey: string;
  machine: string;
  /** Posés à l'appairage : le ticket signé par le relais, le compte Telegram, le robot. */
  ticket?: string;
  account?: string;
  bot?: string;
}

export function readRelay(dir: string): RelaySettings | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, RELAY_FILE), "utf8")) as Partial<RelaySettings>;
    if (typeof raw.url !== "string" || typeof raw.relayKey !== "string" || typeof raw.privateKey !== "string" || typeof raw.publicKey !== "string" || typeof raw.machine !== "string") return null;
    return raw as RelaySettings;
  } catch {
    return null;
  }
}

function writeRelay(dir: string, settings: RelaySettings): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, RELAY_FILE), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export const relayPaired = (s: RelaySettings | null): s is RelaySettings & { ticket: string } => typeof s?.ticket === "string";

function newMachine(config: { url: string; key: string }): RelaySettings {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" }).x!;
  return {
    url: config.url,
    relayKey: config.key,
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: raw,
    machine: createHash("sha256").update(Buffer.from(raw, "base64url")).digest("base64url"),
  };
}

const bytes = (kind: string, data: string) => Buffer.from(`${DOMAIN}|${kind}|${data}`);

export function verifyRelay(relayKey: string, kind: string, data: string, signature: string): boolean {
  try {
    return verify(null, bytes(kind, data), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: relayKey }, format: "jwk" }), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Ce qu'un ticket dit de l'appairage : le compte ou l'appareil, et pour le Web Push, de quoi chiffrer et vérifier. */
export interface RelayTicket {
  kind: "web" | "telegram";
  account: string;
  label: string;
  at: number;
  /** Web : la clé publique de l'appareil (ses appuis sont signés par elle), et l'abonnement de son navigateur. */
  device?: string;
  push?: { endpoint: string; p256dh: string; auth: string };
}

/** Le contenu d'un ticket, s'il est signé par le relais et fait pour cette machine. */
export function readRelayTicket(settings: Pick<RelaySettings, "relayKey" | "machine">, ticket: string): RelayTicket | null {
  const [data, signature] = ticket.split(".");
  if (!data || !signature || !verifyRelay(settings.relayKey, "ticket", data, signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as { machine?: unknown; kind?: unknown; account?: unknown; label?: unknown; at?: unknown; device?: unknown; push?: RelayTicket["push"] };
    if (payload.machine !== settings.machine) return null;
    const base = { account: String(payload.account ?? ""), label: String(payload.label ?? ""), at: Number(payload.at ?? 0) };
    if (payload.kind !== "web") return { kind: "telegram", ...base };
    if (typeof payload.device !== "string" || typeof payload.push?.p256dh !== "string" || typeof payload.push.auth !== "string") return null;
    return { kind: "web", ...base, device: payload.device, push: payload.push };
  } catch {
    return null;
  }
}

/** La signature d'un appareil appairé (ECDSA P-256, r‖s), faite par la page du téléphone. */
export function verifyDevice(device: string, data: string, signature: string): boolean {
  return verifyDeviceSignature(device, data, signature);
}

/* ------------------------------------------------------------------ l'état, pour la console */

export type RelayPairingState =
  | { state: "unavailable"; message: string }
  | { state: "idle"; notice?: string }
  | { state: "connecting" }
  /** `seen` : le téléphone a ouvert la page (les deux écrans se répondent). */
  | { state: "waiting"; kind: "web" | "telegram"; bot: string; link: string; code: string; until: string; qr: { size: number; cells: string }; seen?: boolean }
  /** `lastAt` : la dernière notification partie sur ce téléphone. */
  | { state: "paired"; kind: "web" | "telegram"; bot: string; account: string; online: boolean; lastAt?: string }
  | { state: "expired" }
  | { state: "failed"; message: string };

/**
 * Un appui resté en route plus de quinze minutes ne décide plus rien. Large exprès : l'horloge
 * d'un ordinateur dérive, et le rejeu est déjà fermé par l'identifiant à usage unique du bouton.
 */
const PRESS_FRESH_MS = 15 * 60_000;

interface Sent {
  event: NotificationEvent;
  caption: string;
  /** Web : la notification se remplace par son étiquette ; son titre et son texte, séparés, et son visage. */
  web: boolean;
  tag: string;
  title: string;
  body: string;
  face?: WebFace;
  /** Web : ce que le téléphone a affiché, pour vérifier l'accord qu'il signe dessus. */
  shown?: PhoneShown;
  /** Web : une demande dite comme un ami (la question en titre). */
  friendly?: boolean;
  photo: boolean;
  messageId: number;
  decided: string | null;
}

type Reply = Record<string, unknown> & { t: string };

/** Ce qui donne un visage à une notification du téléphone : la mascotte, l'agent, l'ordinateur, l'heure. */
interface WebFace {
  mascot?: string;
  agent?: string;
  computer?: string;
  at?: number;
  danger?: boolean;
  /** « friendly » : une demande dite comme un ami ; la page la met en forme. */
  style?: "friendly";
}

export interface RelayPhoneOptions {
  /** Pour les essais : une autre classe WebSocket (celle de Node 22 par défaut). */
  WebSocketImpl?: typeof WebSocket;
  /** La carte d'essai (la mascotte), et le nom de la machine montré dans Telegram. */
  mascot?: string | null;
  label?: string;
  now?: () => number;
  /** Pour les essais : le battement (30 s), et le silence après lequel la connexion est tenue pour morte (75 s). */
  heartbeatMs?: number;
  silentMs?: number;
}

/**
 * La connexion au relais, l'appairage, et le canal du téléphone. Un seul par dossier d'état
 * (`relayPhoneFor`) : la console et les notifications parlent à la même connexion.
 */
export class RelayPhone {
  private ws: WebSocket | null = null;
  private ready = false;
  private readyWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private readonly replies = new Map<string, (reply: Reply) => void>();
  private refs = 0;
  private current: RelayPairingState = { state: "idle" };
  private pairing: { until: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private backoff = 1_000;
  /** La dernière fois que le relais a dit quelque chose (un `pong` suffit). */
  private heard = 0;
  private running = false;
  private bot: string | null = null;
  /** Le relais offre-t-il le Web Push (son `hello`) ? */
  private web = false;
  private lastAt: string | null = null;
  private readonly sent = new Map<string, Sent>();
  private readonly photos = new Map<string, string>();
  private handlers: {
    act: (event: NotificationEvent, actionId: string) => unknown;
    feedback: (event: NotificationEvent, right: boolean, decision: string) => void;
    text: (event: NotificationEvent) => { title: string; body: string };
  } | null = null;

  constructor(
    private readonly dir: string,
    private readonly options: RelayPhoneOptions = {},
  ) {}

  /** La mascotte de la carte d'essai : la console la connaît, les notifications non (`relayPhoneFor`). */
  useMascot(mascot: string | null): void {
    this.options.mascot = mascot;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Les boutons pressés agissent par la même voie que l'ordinateur (`local-notifications.ts`). */
  bind(handlers: NonNullable<RelayPhone["handlers"]>): this {
    this.handlers = handlers;
    return this;
  }

  get configured(): boolean {
    return relayPaired(readRelay(this.dir));
  }

  status(): RelayPairingState {
    const settings = readRelay(this.dir);
    if (this.current.state === "waiting" || this.current.state === "connecting") return this.current;
    if (relayPaired(settings)) {
      const kind = readRelayTicket(settings, settings.ticket)?.kind ?? "telegram";
      return { state: "paired", kind, bot: settings.bot ?? this.bot ?? "OathrionBot", account: settings.account ?? (kind === "web" ? "your phone" : "your Telegram account"), online: this.ready, ...(this.lastAt ? { lastAt: this.lastAt } : {}) };
    }
    if (!relayConfig() && !settings) return { state: "unavailable", message: "Oathrion's phone relay is not live yet. Pair with your own Telegram bot meanwhile." };
    return this.current;
  }

  /** Au démarrage du pivot : appairé, il se reconnecte au relais, et y reste. */
  start(): void {
    this.running = true;
    if (this.configured) this.connect();
  }

  stop(): void {
    this.running = false;
    this.disconnect();
  }

  /* -------------------------------------------------------------- la connexion */

  private wanted(): boolean {
    return this.running && (this.configured || this.pairing !== null);
  }

  private connect(): void {
    if (this.ws) return;
    const settings = readRelay(this.dir);
    if (!settings) return;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const ws = new Impl(`${settings.url}?m=${settings.machine}`);
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (ws === this.ws) this.heard = Date.now();
      let message: Reply;
      try {
        message = JSON.parse(String(event.data)) as Reply;
      } catch {
        return;
      }
      void this.onMessage(ws, message).catch(() => undefined);
    });
    ws.addEventListener("close", () => this.onClose(ws));
    /* Une connexion qui ne devient jamais prête (le défi jamais reçu) : refaite, elle aussi. */
    const stuck = setTimeout(() => {
      if (this.ws === ws && !this.ready) this.drop();
    }, this.options.silentMs ?? 20_000);
    stuck.unref?.();
    /* Le WebSocket de Node 22 signale un relais injoignable par « error », sans « close ». */
    ws.addEventListener("error", () => this.onClose(ws));
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.ready = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(new Error("The phone relay is unreachable."));
    for (const [ref, done] of this.replies) {
      this.replies.delete(ref);
      done({ t: "error", code: "offline", message: "The phone relay is unreachable." });
    }
    if (!this.wanted()) return;
    /* Hors ligne, ou le relais redémarre : on réessaie, de plus en plus patiemment (1 s → 60 s). */
    const delay = this.backoff * (0.8 + Math.random() * 0.4);
    this.backoff = Math.min(60_000, this.backoff * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted()) this.connect();
    }, delay);
    this.retry.unref?.();
  }

  /** Une connexion qui ne répond plus : fermée de notre côté ; `onClose` se reconnecte si on le veut. */
  private drop(): void {
    const ws = this.ws;
    if (!ws) return;
    this.onClose(ws);
    try {
      ws.close(4008, "silent");
    } catch {
      /* Déjà fermée. */
    }
  }

  private disconnect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    if (ws) {
      this.onClose(ws);
      try {
        ws.close(1000, "bye");
      } catch {
        /* Déjà fermée. */
      }
    }
  }

  private whenReady(timeoutMs = 15_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.running = true;
    this.connect();
    return new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("The phone relay did not answer.")), timeoutMs);
      timer.unref?.();
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolveReady();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  private request(message: Record<string, unknown>, timeoutMs = 20_000): Promise<Reply> {
    const ref = `r${String((this.refs += 1))}`;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.replies.delete(ref);
        /* Pas de réponse : la connexion est sans doute morte sans le dire ; on la refait pour la suite. */
        this.drop();
        done({ t: "error", code: "timeout", message: "The phone relay did not answer." });
      }, timeoutMs);
      timer.unref?.();
      this.replies.set(ref, (reply) => {
        clearTimeout(timer);
        done(reply);
      });
      this.send({ ...message, ref });
    });
  }

  private async onMessage(ws: WebSocket, message: Reply): Promise<void> {
    const settings = readRelay(this.dir);
    if (!settings || ws !== this.ws) return;
    if (message.t === "hello" && typeof message.challenge === "string") {
      if (typeof message.bot === "string") this.bot = message.bot;
      this.web = message.web === true;
      const sig = sign(null, bytes("connect", message.challenge), createPrivateKey({ key: Buffer.from(settings.privateKey, "base64url"), format: "der", type: "pkcs8" })).toString("base64url");
      ws.send(JSON.stringify({ t: "auth", key: settings.publicKey, sig, ...(settings.ticket ? { ticket: settings.ticket } : {}) }));
      return;
    }
    if (message.t === "ready") {
      this.ready = true;
      this.backoff = 1_000;
      if (typeof message.bot === "string") this.bot = message.bot;
      if (!this.heartbeat) {
        /*
         * Le battement exact que le Durable Object répond sans se réveiller. Sans réponse depuis
         * 75 secondes, la connexion est morte sans l'avoir dit (essai réel du 23 novembre : après un
         * redéploiement du relais, le pivot se croyait « Connected » et envoyait dans le vide) :
         * on la coupe, et on se reconnecte.
         */
        this.heard = Date.now();
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.heard > (this.options.silentMs ?? 75_000)) this.drop();
          else this.send({ t: "ping" });
        }, this.options.heartbeatMs ?? 30_000);
        this.heartbeat.unref?.();
      }
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
      if (!this.wanted()) this.disconnect();
      return;
    }
    if (typeof message.ref === "string" && this.replies.has(message.ref)) {
      this.replies.get(message.ref)!(message);
      this.replies.delete(message.ref);
      return;
    }
    if (message.t === "paired" && typeof message.ticket === "string") return this.onPaired(settings, message.ticket);
    /* Le téléphone a ouvert la page : la console le montre tout de suite. */
    if (message.t === "pair.seen" && this.current.state === "waiting") {
      this.current = { ...this.current, seen: true };
      return;
    }
    /* Ce qui suit doit être signé par le relais épinglé, et fait pour cette machine. */
    if (typeof message.p !== "string" || typeof message.s !== "string" || !verifyRelay(settings.relayKey, message.t, message.p, message.s)) return;
    const payload = JSON.parse(message.p) as Record<string, unknown>;
    if (payload.machine !== settings.machine) return;
    if (message.t === "unpaired") return this.onUnpaired(settings, String(payload.reason ?? ""));
    if (message.t === "press") {
      if (Math.abs(this.now() - Number(payload.at)) > PRESS_FRESH_MS) return;
      const nonce = String(payload.nonce ?? "");
      const choice = String(payload.choice ?? "");
      const ticket = settings.ticket ? readRelayTicket(settings, settings.ticket) : null;
      if (ticket?.kind === "web") {
        /* Le téléphone a signé son appui : on le vérifie ici, sans croire le relais sur parole. */
        const device = payload.device as { at?: unknown; sig?: unknown; approval?: unknown } | undefined;
        const data = `press|${settings.machine.slice(0, 11)}|${nonce}|${choice}|${String(device?.at)}`;
        if (typeof device?.sig !== "string" || !verifyDevice(ticket.device!, data, device.sig)) return;
        /* La page signe aussi ce qu'elle a montré (depuis le 23 novembre) : l'accord que la machine ne peut pas fabriquer. */
        if (typeof device.approval === "string" && typeof device.at === "number") {
          await this.press(String(payload.pressId ?? ""), nonce, choice, { device: ticket.device!, label: ticket.account, at: device.at, signature: device.approval });
          return;
        }
      }
      await this.press(String(payload.pressId ?? ""), nonce, choice);
    }
  }

  /* -------------------------------------------------------------- l'appairage */

  /** « Pair my phone » : la clé de la machine, la connexion, puis le code du QR, en attente du Start. */
  async pair(): Promise<RelayPairingState> {
    const config = relayConfig();
    if (!config) return this.status();
    let settings = readRelay(this.dir);
    /* Un nouveau relais (ou sa clé changée) : une nouvelle clé de machine pour lui. */
    if (!settings || settings.url !== config.url || settings.relayKey !== config.key) {
      this.disconnect();
      settings = newMachine(config);
      writeRelay(this.dir, settings);
    }
    this.endPairing();
    this.pairing = { until: this.now() + 10 * 60_000, timer: null };
    this.current = { state: "connecting" };
    try {
      await this.whenReady();
    } catch (error) {
      this.pairing = null;
      return (this.current = { state: "failed", message: error instanceof Error ? error.message : String(error) });
    }
    /* Les notifications du navigateur d'abord (aucune application à installer), Telegram si le relais n'offre que lui. */
    const kind = this.web ? "web" : "telegram";
    const reply = await this.request({ t: "pair.begin", kind, label: (this.options.label ?? hostname()).slice(0, 40) });
    if (reply.t !== "code" || typeof reply.code !== "string" || typeof reply.bot !== "string") {
      this.pairing = null;
      return (this.current = { state: "failed", message: typeof reply.message === "string" ? reply.message : "The phone relay refused." });
    }
    const until = typeof reply.until === "number" ? reply.until - 10_000 : this.now() + 10 * 60_000;
    const link = typeof reply.link === "string" && /^https?:\/\/[^\s]+$/.test(reply.link) ? reply.link : `https://t.me/${reply.bot}?start=${reply.code}`;
    const timer = setTimeout(() => {
      if (this.current.state !== "waiting" || this.pairing?.timer !== timer) return;
      this.pairing = null;
      this.current = { state: "expired" };
      if (!this.wanted()) this.disconnect();
    }, Math.max(1_000, until - this.now()));
    timer.unref?.();
    this.pairing = { until, timer };
    return (this.current = { state: "waiting", kind, bot: reply.bot, link, code: reply.code, until: new Date(until).toISOString(), qr: qrOf(link) });
  }

  private async onPaired(settings: RelaySettings, ticket: string): Promise<void> {
    const read = readRelayTicket(settings, ticket);
    if (!read) return;
    this.endPairing();
    writeRelay(this.dir, { ...settings, ticket, account: read.account, ...(this.bot ? { bot: this.bot } : {}) });
    this.current = { state: "idle" };
    /* La notification d'essai refusée dès l'appairage : la console dit ce que le service a répondu. */
    await this.test().catch((error: unknown) => {
      if (this.current.state === "idle" && this.current.notice) this.current = { state: "idle", notice: `${this.current.notice} ${error instanceof Error ? error.message : ""}`.trim() };
    });
  }

  private onUnpaired(settings: RelaySettings, reason: string): void {
    const { ticket: _ticket, account: _account, ...rest } = settings;
    writeRelay(this.dir, rest);
    this.sent.clear();
    const notice: Record<string, string> = {
      blocked: "Your phone stopped Oathrion's bot: pair again to approve from it.",
      revoked: "Your phone sent /stop: pair again to approve from it.",
      invalid: "The phone relay no longer knows this pairing: pair again.",
      expired: "Your phone no longer accepts Oathrion's notifications (permission removed, or browser data cleared): pair again.",
    };
    this.current = { state: "idle", ...(notice[reason] ? { notice: notice[reason] } : {}) };
    /* La réponse à la demande en cours suit ce message : on la laisse arriver avant de couper. */
    const later = setTimeout(() => {
      if (!this.wanted()) this.disconnect();
    }, 1_000);
    later.unref?.();
  }

  private endPairing(): void {
    if (this.pairing?.timer) clearTimeout(this.pairing.timer);
    this.pairing = null;
  }

  /** « Unpair » : le téléphone en est prévenu, puis la clé et le ticket de cette machine sont effacés. */
  async unpair(): Promise<RelayPairingState> {
    if (this.configured && this.ready) await this.request({ t: "unpair" }, 3_000).catch(() => undefined);
    this.endPairing();
    this.disconnect();
    rmSync(join(this.dir, RELAY_FILE), { force: true });
    this.sent.clear();
    this.current = { state: "idle" };
    return this.status();
  }

  /** Une demande d'essai, telle qu'elle arrivera : la mascotte, le texte, sans boutons. */
  async test(): Promise<void> {
    if (!this.configured) throw new Error("No phone is paired.");
    await this.whenReady();
    const ticket = this.ticket();
    if (ticket?.kind === "web") {
      await this.pushTo(ticket, { tag: "oathrion-test", title: "Oathrion: your phone is paired", body: "Your agents' questions will arrive like this, from them, in plain words. Answer yes or no from anywhere: your computer gets your answer.", actions: [], mascot: "warden", computer: ticket.label, at: this.now() }, false);
      return;
    }
    const reply = await this.request({
      t: "send",
      text: "Oathrion: your phone is paired\n\nYour agents' questions will arrive like this. Answer yes or no from anywhere: your computer gets your answer through Oathrion's relay.",
      ...this.photoOf(this.options.mascot ?? null),
    });
    if (reply.t !== "sent") throw new Error(typeof reply.message === "string" ? reply.message : "The phone relay refused.");
    this.keepPhoto(this.options.mascot ?? null, reply);
  }

  /* -------------------------------------------------------------- le canal */

  private ticket(): RelayTicket | null {
    const settings = readRelay(this.dir);
    return relayPaired(settings) ? readRelayTicket(settings, settings.ticket) : null;
  }

  /** Une notification du navigateur, chiffrée ici pour ce seul téléphone ; le relais la transmet sans la lire. */
  private async pushTo(ticket: RelayTicket, card: { tag: string; title: string; body: string; actions: { choice: string; label: string }[]; nonce?: string; silent?: boolean } & WebFace, replace: boolean): Promise<void> {
    const settings = readRelay(this.dir)!;
    const data = { v: 1, route: settings.machine.slice(0, 11), ...card, title: card.title.slice(0, 120), body: card.body.slice(0, 600) };
    const body = encryptPush(Buffer.from(JSON.stringify(data), "utf8"), ticket.push!);
    const reply = await this.request({ t: "push", body: body.toString("base64url"), topic: card.tag, replace, ttl: replace ? 600 : 3600 });
    if (reply.t !== "pushed") throw new Error(typeof reply.message === "string" ? reply.message : "The phone relay refused.");
    this.lastAt = new Date(this.now()).toISOString();
  }

  /** La mascotte : son `file_id` une fois envoyée, sinon l'image (une PNG, petite). */
  private photoOf(image: string | null): { photo?: { fileId: string } | { png: string } } {
    if (!image || !image.endsWith(".png") || !existsSync(image)) return {};
    const known = this.photos.get(resolve(image));
    if (known) return { photo: { fileId: known } };
    if (statSync(image).size > 256 * 1024) return {};
    return { photo: { png: readFileSync(image).toString("base64url") } };
  }

  private keepPhoto(image: string | null, reply: Reply): void {
    if (image && typeof reply.fileId === "string") this.photos.set(resolve(image), reply.fileId);
  }

  /** Envoie la notification sur le téléphone ; rend vrai si elle est partie. */
  async deliver(event: NotificationEvent): Promise<boolean> {
    if (!this.configured || !this.handlers) return false;
    await this.whenReady();
    const { title, body } = this.handlers.text(event);
    const caption = `${event.data.danger === true ? "🔴 " : ""}${redactForPhone(title)}\n\n${redactForPhone(body)}`;
    const actions = notificationActions(event).filter((a) => a.id !== "open");
    const id = randomBytes(9).toString("base64url");
    const buttons = actions.length > 0 ? [actions.map((a) => ({ label: a.label, data: `${id}:${a.id}` }))] : null;
    const ticket = this.ticket();
    if (ticket?.kind === "web") {
      /* Sans emoji ni mot d'alerte : le filtre anti-spam de Chrome sur Android se méfie de ce qui imite une alerte. */
      const mascot = (event.data.mascot as { id?: unknown } | undefined)?.id;
      /* Une demande dite comme un ami : la question en titre, ce que ça change puis le code dans le texte, le nom de l'agent comme expéditeur. */
      const friendly = phoneFriendly(event);
      const face: WebFace = {
        ...(typeof mascot === "string" && /^[a-z]{2,20}$/.test(mascot) ? { mascot } : {}),
        agent: (friendly?.sender ?? event.agentName).slice(0, 40),
        computer: ticket.label,
        at: this.now(),
        ...(event.data.danger === true ? { danger: true } : {}),
      };
      const card = {
        tag: id,
        nonce: id,
        title: redactForPhone(friendly?.title ?? title).slice(0, 120),
        body: redactForPhone(friendly?.body ?? body).slice(0, 600),
        actions: actions.map((a) => ({ choice: a.id, label: a.label })),
        ...face,
        /* La page met en forme (la question, puis la raison, puis le code) ; ce qu'elle signe reste le titre et le texte. */
        ...(friendly ? { style: "friendly" as const } : {}),
      };
      await this.pushTo(ticket, card, false);
      if (buttons) {
        const shown = shownOf({ route: readRelay(this.dir)!.machine.slice(0, 11), ...card });
        this.sent.set(id, { event, caption, web: true, tag: id, title: card.title, body: card.body, face, shown, ...(friendly ? { friendly: true } : {}), photo: false, messageId: 0, decided: null });
        while (this.sent.size > 100) this.sent.delete(this.sent.keys().next().value!);
      }
      return true;
    }
    const image = typeof event.data.image === "string" ? event.data.image : null;
    const reply = await this.request({ t: "send", text: caption, ...(buttons ? { buttons } : {}), ...this.photoOf(image) });
    if (reply.t !== "sent") throw new Error(typeof reply.message === "string" ? reply.message : "The phone relay refused.");
    this.keepPhoto(image, reply);
    if (buttons) {
      this.sent.set(id, { event, caption, web: false, tag: id, title: "", body: "", photo: reply.photo === true, messageId: Number(reply.messageId), decided: null });
      while (this.sent.size > 100) this.sent.delete(this.sent.keys().next().value!);
    }
    return true;
  }

  /** Décidé ailleurs (l'ordinateur, la console) : le message perd ses boutons et dit qui a décidé. */
  async settled(eventId: string, text: string): Promise<void> {
    if (!this.configured) return;
    for (const [id, item] of this.sent) {
      if (item.event.id !== eventId || item.decided !== null) continue;
      item.decided = text;
      this.sent.delete(id);
      await this.edit(item, `✓ ${text}`, null);
    }
  }

  /** La carte change : ce qui a été décidé sous son texte, et d'autres boutons (ou aucun). */
  private async edit(item: Sent, extra: string, buttons: { label: string; data: string }[][] | null): Promise<void> {
    if (item.web) {
      const ticket = this.ticket();
      if (!ticket || ticket.kind !== "web") return;
      const actions = (buttons ?? []).flat().map((b) => ({ choice: b.data.split(":")[1]!, label: b.label }));
      if (item.friendly) {
        /* L'agent répond, comme dans une conversation : sa réponse en titre, la question rappelée dessous. */
        const reply = (item.decided ?? extra).replace(/^✓ /, "");
        await this.pushTo(ticket, { ...item.face, tag: item.tag, nonce: item.tag, title: reply, body: `You answered: ${item.title}`, actions, silent: true, style: "friendly" }, true);
        return;
      }
      await this.pushTo(ticket, { ...item.face, tag: item.tag, nonce: item.tag, title: item.title, body: `${item.body}\n\n${extra}`, actions, silent: true }, true);
      return;
    }
    await this.request({ t: "edit", messageId: item.messageId, photo: item.photo, text: `${item.caption}\n\n${extra}`, ...(buttons ? { buttons } : {}) });
  }

  /** La réponse au bouton dans Telegram ; le navigateur, lui, voit sa notification remplacée. */
  private answer(pressId: string, text: string): void {
    if (this.ticket()?.kind === "web") return;
    this.send({ t: "answer", pressId, text: text.slice(0, 190) });
  }

  /** L'accord signé par le téléphone sur ce qu'il a montré : vérifié ici, gardé à côté de la base. */
  private keepApproval(item: Sent, nonce: string, choice: string, signed: { device: string; label: string; at: number; signature: string }): void {
    const approval: PhoneApproval = {
      type: PHONE_APPROVAL_TYPE,
      device: { publicKey: signed.device, fingerprint: deviceFingerprint(signed.device), label: signed.label.slice(0, 60) },
      shown: item.shown!,
      nonce,
      choice,
      at: signed.at,
      signature: signed.signature,
    };
    if (!verifyDeviceSignature(signed.device, approvalData(approval), signed.signature)) return;
    try {
      recordPhoneApproval(this.dir, { executionId: item.event.executionId, approvalId: item.event.approvalId, eventId: item.event.id, approval });
    } catch {
      /* Le dossier n'accepte pas l'écriture : la décision passe quand même, sans sa preuve. */
    }
  }

  private async press(pressId: string, id: string, choice: string, signed?: { device: string; label: string; at: number; signature: string }): Promise<void> {
    const item = this.sent.get(id);
    if (!item || !choice || !this.handlers) {
      this.answer(pressId, "This decision is no longer here: Oathrion restarted, or it was made already.");
      return;
    }
    if (choice === "right" || choice === "wrong") {
      if (item.decided === null) return;
      this.sent.delete(id);
      this.handlers.feedback(item.event, choice === "right", item.decided);
      this.answer(pressId, choice === "right" ? "Thanks: kept on your computer, for your next feedback." : "Thanks. Tell us what it should have done: Send feedback, in the console.");
      await this.edit(item, `✓ ${item.decided}`, null);
      return;
    }
    if (item.decided !== null) {
      this.answer(pressId, item.decided);
      return;
    }
    if (!notificationActions(item.event).some((a) => a.id === choice)) return;
    /* Usage unique : décidé avant même que l'action ne revienne, un second appui ne refait rien. */
    item.decided = "Deciding…";
    if (signed && item.shown) this.keepApproval(item, id, choice, signed);
    const { text } = doneOf(await this.handlers.act(item.event, choice));
    item.decided = item.friendly ? friendlyResult(choice, text) : `${text} (from your phone)`;
    this.answer(pressId, text);
    await this.edit(item, `✓ ${item.decided}\nWas this right?`, [
      [
        { label: "👍", data: `${id}:right` },
        { label: "👎", data: `${id}:wrong` },
      ],
    ]);
  }
}

const phones = new Map<string, RelayPhone>();

/** Le canal du relais de ce dossier d'état : un seul, partagé par la console et les notifications. */
export function relayPhoneFor(dir: string, options: RelayPhoneOptions = {}): RelayPhone {
  const key = resolve(dir);
  if (!phones.has(key)) phones.set(key, new RelayPhone(dir, { ...options }));
  const phone = phones.get(key)!;
  if (options.mascot !== undefined) phone.useMascot(options.mascot);
  return phone;
}
