/**
 * LE RELAIS DU TÉLÉPHONE (23 novembre 2026, `notes/CONCEPTION-RELAIS-TELEPHONE.md`) : le robot
 * Telegram officiel d'Oathrion, et la connexion sortante du pivot de chaque machine. Appairer son
 * téléphone tient en un scan : rien à créer chez @BotFather, aucun jeton à recopier.
 *
 * Ce fichier est tout le relais, sans plateforme : les adaptateurs (`worker.ts` pour Cloudflare,
 * `node.ts` pour une machine) ne font que porter les connexions et les webhooks jusqu'ici.
 *
 * ## Ce que le relais garde : presque rien
 *
 * En mémoire : les connexions ouvertes, le code d'appairage en attente (5 minutes), les compteurs
 * de débit — l'état d'une connexion (`Session`) tient en quelques centaines d'octets, pour
 * survivre au sommeil d'un Durable Object. Durable : seulement les révocations par compte
 * (`/stop`), une empreinte salée et une date. L'appairage lui-même est un TICKET signé par le
 * relais, que le pivot garde et présente à chaque connexion.
 *
 * ## Ce qui protège la décision
 *
 * - Le pivot prouve sa clé (un défi signé) ; un ticket n'est valable qu'avec la clé de SA machine.
 * - Un appui ne part vers une machine que s'il vient du compte appairé, dans la conversation
 *   appairée ; il part SIGNÉ par le relais, et le pivot vérifie la signature avec la clé épinglée.
 * - Le webhook ne vient que de Telegram (`X-Telegram-Bot-Api-Secret-Token`, vérifié par
 *   l'adaptateur).
 */

import { pushEndpointAllowed, sendPush, type VapidKeys } from "./webpush.ts";

export const DOMAIN = "oathrion-relay-v1";
/** Ce que signe l'appareil appairé (la clé de la page du téléphone). */
export const PHONE_DOMAIN = "oathrion-phone-v1";
/** Dix minutes pour scanner et appairer (sur iPhone : ajouter la page à l'écran d'accueil d'abord). */
export const PAIR_WITHIN_MS = 10 * 60_000;
/** Un identifiant de machine (43 caractères) ; les 11 premiers suffisent à la retrouver. */
export const ROUTE_LENGTH = 11;
const SECRET_LENGTH = 22;
const MAX_MESSAGE = 8 * 1024;
const MAX_PNG = 256 * 1024;

/* ------------------------------------------------------------------ encodages et signatures */

const encoder = new TextEncoder();

export function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const randomId = (bytes: number) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(text: string | Uint8Array): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof text === "string" ? encoder.encode(text) : text)));
}

/** L'identifiant d'une machine : l'empreinte de sa clé publique Ed25519 (brute, en base64url). */
export const machineOf = (publicKey: string) => sha256(unb64u(publicKey));

const signed = (kind: string, data: string) => encoder.encode(`${DOMAIN}|${kind}|${data}`);

/** La clé du relais : elle signe les tickets, les appuis, les fins d'appairage. */
export class RelayKeys {
  private readonly key: CryptoKey;
  readonly publicKey: string;

  private constructor(key: CryptoKey, publicKey: string) {
    this.key = key;
    this.publicKey = publicKey;
  }

  /** La clé privée PKCS#8, en base64 (`RELAY_SIGNING_KEY`, tirée par `script/keys.ts`). */
  static async load(pkcs8: string): Promise<RelayKeys> {
    const der = unb64u(pkcs8.trim().replace(/=+$/, ""));
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (typeof jwk.x !== "string") throw new Error("RELAY_SIGNING_KEY is not an Ed25519 private key.");
    return new RelayKeys(key, jwk.x);
  }

  async sign(kind: string, data: string): Promise<string> {
    return b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", this.key, signed(kind, data))));
  }
}

export async function verifySigned(publicKey: string, kind: string, data: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", unb64u(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, unb64u(signature), signed(kind, data));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ le ticket d'appairage */

export interface TicketPayload {
  v: 1;
  /** Aléatoire : un appairage, pas un autre. */
  id: string;
  machine: string;
  /** `web` : les notifications du navigateur ; `telegram` (ou absent, les premiers tickets) : le robot. */
  kind?: "telegram" | "web";
  /** Telegram : la conversation, et la personne qui seule décide. */
  chat?: number;
  user?: number;
  /** Web : la clé publique ECDSA P-256 de l'appareil (brute, base64url), et l'abonnement de son navigateur. */
  device?: string;
  push?: { endpoint: string; p256dh: string; auth: string };
  /** Le compte Telegram (« @nom »), ou l'appareil (« Android phone »), tel que la console l'affiche. */
  account: string;
  /** Le nom de la machine, tel que le pivot l'a donné à l'appairage. */
  label: string;
  at: number;
}

export async function signTicket(keys: RelayKeys, payload: TicketPayload): Promise<string> {
  const data = b64u(encoder.encode(JSON.stringify(payload)));
  return `${data}.${await keys.sign("ticket", data)}`;
}

/** Le ticket, s'il est bien signé par cette clé ; sinon rien. */
export async function readTicket(publicKey: string, ticket: string): Promise<TicketPayload | null> {
  const [data, signature, extra] = ticket.split(".");
  if (!data || !signature || extra !== undefined || ticket.length > 4096) return null;
  if (!(await verifySigned(publicKey, "ticket", data, signature))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64u(data))) as TicketPayload;
    if (payload.v !== 1 || typeof payload.machine !== "string") return null;
    if (payload.kind === "web") return typeof payload.device === "string" && typeof payload.push?.endpoint === "string" ? payload : null;
    return typeof payload.chat === "number" && typeof payload.user === "number" ? payload : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ Telegram */

export class TelegramError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** L'API du robot, réduite à ce que le relais appelle. Le jeton est dans l'adresse : il ne remonte jamais. */
export class TelegramClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(token: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init), base = "https://api.telegram.org") {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.base = base.replace(/\/+$/, "");
  }

  async call<T>(method: string, body: Record<string, unknown> | FormData = {}, timeoutMs = 20_000, retried = false): Promise<T> {
    const form = body instanceof FormData;
    const response = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      ...(form ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!payload.ok) {
      /* Trop vite pour Telegram (30 messages par seconde pour tout le robot) : une seconde chance, courte. */
      const wait = payload.parameters?.retry_after;
      if (payload.error_code === 429 && !retried && typeof wait === "number" && wait <= 5) {
        await new Promise((done) => setTimeout(done, wait * 1000));
        return this.call(method, body, timeoutMs, true);
      }
      throw new TelegramError(payload.description ?? `HTTP ${String(response.status)}`, payload.error_code ?? response.status);
    }
    return payload.result as T;
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type?: string }; from?: { id: number; username?: string; first_name?: string }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } };
}

/* ------------------------------------------------------------------ révocations et débit */

/** Le seul état durable : « tout ce que ce compte a appairé avant cette date ne vaut plus ». */
export interface Revocations {
  before(user: string): Promise<number | null>;
  revoke(user: string, at: number): Promise<void>;
}

export class MemoryRevocations implements Revocations {
  readonly entries = new Map<string, number>();
  async before(user: string): Promise<number | null> {
    return this.entries.get(user) ?? null;
  }
  async revoke(user: string, at: number): Promise<void> {
    this.entries.set(user, Math.max(at, this.entries.get(user) ?? 0));
  }
}

/** Un seau qui se remplit : `rate` jetons par minute, `burst` au plus. Sérialisable. */
export interface Bucket {
  tokens: number;
  at: number;
}

export function take(bucket: Bucket, now: number, rate: number, burst: number): boolean {
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 60_000) * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Pour l'adaptateur Node : un nombre d'événements par fenêtre et par clé (une adresse IP). */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }
}

export const LIMITS = {
  /** Messages envoyés, par machine et par minute (et leur rafale). */
  send: { rate: 20, burst: 5 },
  /** Modifications et réponses aux boutons. */
  edit: { rate: 60, burst: 15 },
  /** Codes d'appairage : 5 par 10 minutes. */
  pair: { count: 5, windowMs: 10 * 60_000 },
} as const;

/* ------------------------------------------------------------------ le protocole */

/** L'état d'une connexion : tout ce que le relais sait d'une machine, tant qu'elle est connectée. */
export interface Session {
  challenge: string;
  /** L'identifiant annoncé dans l'adresse (`?m=`) : le Durable Object de cette machine. */
  claimed: string | null;
  machine: string | null;
  label: string;
  ticket: TicketPayload | null;
  /** `seen` : la page du téléphone s'est ouverte avec ce code (la console le montre en direct). */
  pending: { secret: string; until: number; kind: "web" | "telegram"; seen?: boolean } | null;
  begun: number[];
  send: Bucket;
  edit: Bucket;
  /** Les appuis transmis à cette machine : elle seule y répond. */
  presses: string[];
}

export interface Conn {
  session: Session;
  send(message: object): void;
  close(code: number, reason: string): void;
}

/** Les connexions de la machine dont l'identifiant commence par `route`. */
export type Room = (route: string) => Promise<Conn[]>;

export interface RelayDeps {
  /** Le robot Telegram, facultatif : sans jeton, le relais ne sert que le Web Push. */
  bot: string;
  telegram: TelegramClient | null;
  /** Le Web Push : la clé VAPID du relais, son adresse publique (la page du téléphone y vit). */
  vapid?: VapidKeys | null;
  publicUrl?: string;
  /** Pour les essais : le service de notifications des navigateurs. */
  pushFetch?: typeof fetch;
  keys: RelayKeys;
  revocations: Revocations;
  /** Le sel des empreintes de révocation (`RELAY_REVOKE_SALT`). */
  salt: string;
  now?: () => number;
  /** Un journal sans texte : des événements et des codes, jamais un message. */
  log?: (event: string, detail?: Record<string, string | number>) => void;
}

type Button = { label: string; data: string };
type Photo = { fileId: string } | { png: string };

const BUTTON_DATA = /^[A-Za-z0-9_-]{6,16}:[a-z][a-z0-9-]{0,30}$/;
const NONCE = /^[A-Za-z0-9_-]{6,16}$/;
const CHOICE = /^[a-z][a-z0-9-]{0,30}$/;
const RAW_P256 = /^[A-Za-z0-9_-]{87}$/;

/** La signature d'un appareil (ECDSA P-256, r‖s), sur ce qu'il a dit. */
export async function verifyDevice(device: string, data: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", unb64u(device), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(signature), encoder.encode(`${PHONE_DOMAIN}|${data}`));
  } catch {
    return false;
  }
}

/** Une réponse HTTP du relais à la page du téléphone. */
export interface WebReply {
  status: number;
  json: Record<string, unknown>;
}
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** Un nom court, sans caractères de contrôle ni retours à la ligne : le nom de la machine, le compte Telegram. */
const clean = (text: unknown, max: number) =>
  String(text ?? "")
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, max);

/** Un texte de plusieurs lignes : les lignes restent, les autres caractères de contrôle partent. */
const cleanLines = (text: string, max: number) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\p{Cc}+/gu, " "))
    .join("\n")
    .trim()
    .slice(0, max);

/**
 * Le robot porte un texte écrit par le pivot : aucun lien ne doit y devenir cliquable (un escroc
 * qui aurait fait scanner son QR code enverrait sinon des liens « d'Oathrion »). Un espace sans
 * largeur casse l'adresse pour Telegram, pas pour l'œil.
 */
export function unlinked(text: string): string {
  return text.replace(/:\/\//g, ":/\u200b/").replace(/(\w)\.(?=\w)/g, "$1.\u200b").replace(/@(?=\w)/g, "@\u200b");
}

/** Le texte tel qu'il part : celui du pivot, sans liens, puis d'où il vient. */
export function framed(text: string, ticket: TicketPayload): string {
  const day = new Date(ticket.at).toISOString().slice(0, 10);
  return `${unlinked(cleanLines(text, 1200))}\n\n— Oathrion on ${unlinked(ticket.label || "your computer")}, paired ${day}`;
}

export const HELP_TEXT = "This is Oathrion's bot. To approve your agents' requests here, open Oathrion's console on your computer and choose Pair my phone.";

export class RelayCore {
  private readonly deps: RelayDeps;
  private readonly now: () => number;

  constructor(deps: RelayDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  get bot(): string {
    return this.deps.bot;
  }

  /** Une connexion qui s'ouvre : son état, et le défi à signer. */
  open(claimed: string | null): { session: Session; hello: object } {
    const now = this.now();
    const session: Session = {
      challenge: randomId(24),
      claimed: claimed && /^[A-Za-z0-9_-]{43}$/.test(claimed) ? claimed : null,
      machine: null,
      label: "",
      ticket: null,
      pending: null,
      begun: [],
      send: { tokens: LIMITS.send.burst, at: now },
      edit: { tokens: LIMITS.edit.burst, at: now },
      presses: [],
    };
    return { session, hello: { t: "hello", v: 1, bot: this.deps.bot, challenge: session.challenge, web: Boolean(this.deps.vapid), telegram: Boolean(this.deps.telegram) } };
  }

  private userHash(user: number): Promise<string> {
    return sha256(`${this.deps.salt}|${String(user)}`);
  }

  /** L'empreinte sous laquelle un appairage se révoque : le compte Telegram, ou l'appareil. */
  private revocationKey(ticket: Pick<TicketPayload, "kind" | "user" | "device">): Promise<string> {
    return ticket.kind === "web" ? sha256(`${this.deps.salt}|device|${String(ticket.device)}`) : this.userHash(ticket.user ?? 0);
  }

  private async revoked(ticket: TicketPayload): Promise<boolean> {
    const before = await this.deps.revocations.before(await this.revocationKey(ticket));
    return before !== null && ticket.at <= before;
  }

  private async signedMessage(t: string, payload: Record<string, unknown>): Promise<object> {
    const p = JSON.stringify(payload);
    return { t, p, s: await this.deps.keys.sign(t, p) };
  }

  private async unpaired(conn: Conn, reason: "revoked" | "blocked" | "asked" | "invalid" | "expired", ref: string | null = null): Promise<void> {
    const machine = conn.session.machine;
    conn.session.ticket = null;
    if (machine) conn.send({ ...(await this.signedMessage("unpaired", { machine, reason, at: this.now() })), ...(ref ? { ref } : {}) });
  }

  /** Un message du pivot. Toute erreur de forme ferme la connexion : un pivot honnête n'en envoie pas. */
  async onMessage(conn: Conn, raw: string, room: Room): Promise<void> {
    if (raw.length > MAX_MESSAGE + (MAX_PNG * 4) / 3 + 1024) return conn.close(1009, "too big");
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return conn.close(1003, "not json");
    }
    const session = conn.session;
    if (message.t === "ping") return conn.send({ t: "pong" });
    if (session.machine === null) {
      if (message.t !== "auth") return conn.close(4001, "auth first");
      return this.auth(conn, message, room);
    }
    const ref = typeof message.ref === "string" ? message.ref.slice(0, 40) : null;
    const now = this.now();
    try {
      switch (message.t) {
        case "pair.begin": {
          session.begun = session.begun.filter((at) => now - at < LIMITS.pair.windowMs);
          if (session.begun.length >= LIMITS.pair.count) return conn.send({ t: "error", ref, code: "rate", message: "Too many pairing codes: wait a few minutes." });
          session.begun.push(now);
          session.label = clean(message.label, 40) || "your computer";
          const kind = message.kind === "telegram" ? "telegram" : "web";
          if (kind === "web" ? !this.deps.vapid || !this.deps.publicUrl : !this.deps.telegram) return conn.send({ t: "error", ref, code: "kind", message: `This relay does not offer ${kind === "web" ? "browser notifications" : "Telegram"}.` });
          /* Un seul code à la fois par machine : le nouveau remplace l'ancien. */
          session.pending = { secret: randomId(16), until: now + PAIR_WITHIN_MS, kind };
          const code = `${session.machine.slice(0, ROUTE_LENGTH)}${session.pending.secret}`;
          /* Web : le code reste dans le fragment de l'adresse, que le navigateur n'envoie à personne. */
          const link = kind === "web" ? `${this.deps.publicUrl!.replace(/\/+$/, "")}/pair#${code}` : `https://t.me/${this.deps.bot}?start=${code}`;
          this.deps.log?.("pair.begin", { kind });
          return conn.send({ t: "code", ref, kind, bot: this.deps.bot, code, link, until: session.pending.until });
        }
        case "send":
        case "edit": {
          const ticket = await this.live(conn);
          if (!ticket) return conn.send({ t: "error", ref, code: "unpaired", message: "This computer is not paired." });
          if (ticket.kind === "web" || !this.deps.telegram) return conn.send({ t: "error", ref, code: "kind", message: "This phone gets browser notifications: send them with push." });
          const bucket = message.t === "send" ? session.send : session.edit;
          const limit = message.t === "send" ? LIMITS.send : LIMITS.edit;
          if (!take(bucket, now, limit.rate, limit.burst)) return conn.send({ t: "error", ref, code: "rate", message: "Too many messages to your phone: slow down." });
          const text = typeof message.text === "string" ? message.text : "";
          const keyboard = this.keyboard(session.machine, message.buttons);
          if (keyboard === "bad" || text === "" || text.length > MAX_MESSAGE) return conn.close(1008, "bad message");
          const result = message.t === "send" ? await this.sendCard(ticket, text, keyboard, message.photo) : await this.editCard(ticket, message, text, keyboard);
          return conn.send({ t: message.t === "send" ? "sent" : "edited", ref, ...result });
        }
        case "push": {
          const ticket = await this.live(conn);
          if (!ticket) return conn.send({ t: "error", ref, code: "unpaired", message: "This computer is not paired." });
          if (ticket.kind !== "web" || !ticket.push || !this.deps.vapid) return conn.send({ t: "error", ref, code: "kind", message: "This phone is paired with Telegram." });
          const bucket = message.replace === true ? session.edit : session.send;
          const limit = message.replace === true ? LIMITS.edit : LIMITS.send;
          if (!take(bucket, now, limit.rate, limit.burst)) return conn.send({ t: "error", ref, code: "rate", message: "Too many messages to your phone: slow down." });
          const body = typeof message.body === "string" ? unb64u(message.body) : new Uint8Array();
          const topic = typeof message.topic === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(message.topic) ? message.topic : undefined;
          /* Déjà chiffré par le pivot (RFC 8291) : le relais ne peut pas le lire ; 4 Ko au plus, la limite des services. */
          if (body.length < 103 || body.length > 4096) return conn.close(1008, "bad push");
          const ttl = typeof message.ttl === "number" ? Math.max(0, Math.min(86_400, Math.floor(message.ttl))) : 3600;
          const result = await sendPush(this.deps.vapid, ticket.push.endpoint, body, { ttl, ...(topic ? { topic } : {}) }, this.deps.pushFetch);
          if (result.outcome === "gone") {
            /* Le navigateur a retiré la permission, ou a été effacé : le téléphone n'est plus appairé. */
            this.deps.log?.("push.gone", { status: result.status, host: new URL(ticket.push.endpoint).hostname, reason: result.reason ?? "" });
            await this.unpaired(conn, "expired");
            return conn.send({ t: "error", ref, code: "expired", message: `Your phone no longer accepts Oathrion's notifications (the service answered ${String(result.status)}${result.reason ? `: ${result.reason}` : ""}).` });
          }
          if (result.outcome === "failed") {
            this.deps.log?.("push.failed", { status: result.status, host: new URL(ticket.push.endpoint).hostname, reason: result.reason ?? "" });
            return conn.send({ t: "error", ref, code: "push", message: `The phone's notification service answered ${String(result.status)}${result.reason ? `: ${result.reason}` : ""}.` });
          }
          return conn.send({ t: "pushed", ref });
        }
        case "answer": {
          if (!this.deps.telegram) return;
          const pressId = typeof message.pressId === "string" ? message.pressId : "";
          if (!session.presses.includes(pressId) || !take(session.edit, now, LIMITS.edit.rate, LIMITS.edit.burst)) return;
          session.presses = session.presses.filter((id) => id !== pressId);
          await this.deps.telegram!.call("answerCallbackQuery", { callback_query_id: pressId, text: clean(message.text, 190) });
          return;
        }
        case "unpair": {
          const ticket = session.ticket;
          if (ticket && ticket.kind !== "web" && this.deps.telegram) await this.deps.telegram!.call("sendMessage", { chat_id: ticket.chat, text: `${unlinked(ticket.label)} is unpaired: its requests will no longer arrive here.` }).catch(() => undefined);
          session.pending = null;
          this.deps.log?.("unpair");
          /* La réponse à « unpair » : elle porte sa référence, le pivot n'attend pas. */
          await this.unpaired(conn, "asked", ref);
          return;
        }
        default:
          return conn.close(1008, "unknown message");
      }
    } catch (error) {
      if (error instanceof TelegramError && error.code === 403 && session.ticket) {
        /* La personne a bloqué le robot, ou supprimé la conversation : le téléphone n'est plus appairé. */
        this.deps.log?.("blocked");
        await this.unpaired(conn, "blocked");
        return conn.send({ t: "error", ref, code: "blocked", message: "Your phone stopped Oathrion's bot." });
      }
      this.deps.log?.("telegram.error", { code: error instanceof TelegramError ? error.code : 0 });
      return conn.send({ t: "error", ref, code: "telegram", message: error instanceof Error ? error.message.slice(0, 200) : "Telegram failed." });
    }
  }

  private async auth(conn: Conn, message: Record<string, unknown>, room: Room): Promise<void> {
    const session = conn.session;
    const key = typeof message.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.key) ? message.key : null;
    const sig = typeof message.sig === "string" ? message.sig : "";
    if (!key || !(await verifySigned(key, "connect", session.challenge, sig))) return conn.close(4003, "bad signature");
    const machine = await machineOf(key);
    /* Le Durable Object a été choisi par l'identifiant annoncé : il doit être celui de la clé. */
    if (session.claimed !== null && session.claimed !== machine) return conn.close(4003, "wrong machine");
    session.machine = machine;
    /* La même machine, reconnectée : l'ancienne connexion cède la place. */
    for (const other of await room(machine.slice(0, ROUTE_LENGTH))) {
      if (other !== conn && other.session.machine === machine) other.close(4000, "replaced");
    }
    if (typeof message.ticket === "string") {
      const ticket = await readTicket(this.deps.keys.publicKey, message.ticket);
      if (!ticket || ticket.machine !== machine) await this.unpaired(conn, "invalid");
      else if (await this.revoked(ticket)) await this.unpaired(conn, "revoked");
      else {
        session.ticket = ticket;
        session.label = ticket.label;
      }
    }
    this.deps.log?.("connect", { paired: session.ticket ? 1 : 0 });
    conn.send({ t: "ready", bot: this.deps.bot, paired: session.ticket !== null, account: session.ticket?.account ?? null });
  }

  /** Le ticket de cette connexion, s'il vaut encore (le compte a pu envoyer `/stop` entre-temps). */
  private async live(conn: Conn): Promise<TicketPayload | null> {
    const ticket = conn.session.ticket;
    if (!ticket) return null;
    if (await this.revoked(ticket)) {
      await this.unpaired(conn, "revoked");
      return null;
    }
    return ticket;
  }

  private keyboard(machine: string, buttons: unknown): { text: string; callback_data: string }[][] | null | "bad" {
    if (buttons === undefined || buttons === null) return null;
    if (!Array.isArray(buttons) || buttons.length > 2) return "bad";
    const rows: { text: string; callback_data: string }[][] = [];
    for (const row of buttons) {
      if (!Array.isArray(row) || row.length === 0 || row.length > 3) return "bad";
      const cells: { text: string; callback_data: string }[] = [];
      for (const button of row as Button[]) {
        if (typeof button?.data !== "string" || !BUTTON_DATA.test(button.data)) return "bad";
        const label = clean(button.label, 24);
        if (label === "") return "bad";
        cells.push({ text: label, callback_data: `${machine.slice(0, ROUTE_LENGTH)}.${button.data}` });
      }
      rows.push(cells);
    }
    return rows;
  }

  private async sendCard(ticket: TicketPayload, text: string, keyboard: { text: string; callback_data: string }[][] | null, photo: unknown): Promise<{ messageId: number; photo: boolean; fileId?: string }> {
    const caption = framed(text, ticket);
    const markup = keyboard ? { inline_keyboard: keyboard } : undefined;
    const image = photo as Photo | undefined;
    if (image && typeof image === "object" && ("fileId" in image || "png" in image)) {
      let sent: { message_id: number; photo?: { file_id: string }[] };
      if ("fileId" in image) {
        if (typeof image.fileId !== "string" || !FILE_ID.test(image.fileId)) throw new TelegramError("bad photo", 400);
        sent = await this.deps.telegram!.call("sendPhoto", { chat_id: ticket.chat, photo: image.fileId, caption: caption.slice(0, 1024), ...(markup ? { reply_markup: markup } : {}) });
      } else {
        const bytes = typeof image.png === "string" ? unb64u(image.png) : new Uint8Array();
        /* Une image PNG, et petite : la mascotte, rien d'autre. */
        if (bytes.length === 0 || bytes.length > MAX_PNG || bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new TelegramError("bad photo", 400);
        const form = new FormData();
        form.set("chat_id", String(ticket.chat));
        form.set("caption", caption.slice(0, 1024));
        if (markup) form.set("reply_markup", JSON.stringify(markup));
        form.set("photo", new Blob([bytes], { type: "image/png" }), "mascot.png");
        sent = await this.deps.telegram!.call("sendPhoto", form);
      }
      const fileId = sent.photo?.at(-1)?.file_id;
      return { messageId: sent.message_id, photo: true, ...(fileId ? { fileId } : {}) };
    }
    const sent = await this.deps.telegram!.call<{ message_id: number }>("sendMessage", { chat_id: ticket.chat, text: caption.slice(0, 4096), link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) });
    return { messageId: sent.message_id, photo: false };
  }

  private async editCard(ticket: TicketPayload, message: Record<string, unknown>, text: string, keyboard: { text: string; callback_data: string }[][] | null): Promise<{ messageId: number }> {
    const messageId = typeof message.messageId === "number" ? message.messageId : 0;
    const photo = message.photo === true;
    const caption = framed(text, ticket);
    await this.deps.telegram!.call(photo ? "editMessageCaption" : "editMessageText", {
      chat_id: ticket.chat,
      message_id: messageId,
      ...(photo ? { caption: caption.slice(0, 1024) } : { text: caption.slice(0, 4096), link_preview_options: { is_disabled: true } }),
      reply_markup: { inline_keyboard: keyboard ?? [] },
    });
    return { messageId };
  }

  /** La machine à qui ce message de Telegram s'adresse (le code d'un Start, la route d'un bouton) ; `null` : à personne. */
  routeOf(update: TelegramUpdate): string | null {
    const data = update.callback_query?.data;
    if (data) return /^[A-Za-z0-9_-]{11}\./.test(data) ? data.slice(0, ROUTE_LENGTH) : null;
    const start = /^\/start ([A-Za-z0-9_-]{33})$/.exec(update.message?.text?.trim() ?? "");
    return start ? start[1]!.slice(0, ROUTE_LENGTH) : null;
  }

  /** Un message de Telegram (webhook ou `getUpdates`). `room` rend les connexions d'une machine. */
  async onUpdate(update: TelegramUpdate, room: Room): Promise<void> {
    const telegram = this.deps.telegram;
    if (!telegram) return;
    const press = update.callback_query;
    if (press) {
      const route = this.routeOf(update);
      const conns = route ? await room(route) : [];
      const [, rest] = (press.data ?? "").split(".");
      const [nonce, choice] = (rest ?? "").split(":");
      /* Seul le compte appairé, dans sa conversation : tout autre appui est ignoré, sans rien dire. */
      const target = conns.find((c) => c.session.ticket && c.session.ticket.user === press.from.id && c.session.ticket.chat === press.message?.chat.id);
      if (!target || !nonce || !choice) {
        const text = conns.length === 0 && route ? "Your computer is offline, or Oathrion stopped. Decide in Oathrion's console when it is back." : "";
        await telegram.call("answerCallbackQuery", { callback_query_id: press.id, ...(text ? { text } : {}) }).catch(() => undefined);
        return;
      }
      if (await this.live(target).then((t) => t === null)) {
        await telegram.call("answerCallbackQuery", { callback_query_id: press.id, text: "This computer is unpaired." }).catch(() => undefined);
        return;
      }
      target.session.presses = [...target.session.presses.slice(-9), press.id];
      this.deps.log?.("press");
      target.send(await this.signedMessage("press", { machine: target.session.machine, nonce, choice, pressId: press.id, at: this.now() }));
      return;
    }
    const message = update.message;
    if (!message?.from || message.chat.type !== "private") return;
    const text = message.text?.trim() ?? "";
    const reply = (words: string) => telegram.call("sendMessage", { chat_id: message.chat.id, text: words }).catch(() => undefined);
    if (text === "/stop") {
      await this.deps.revocations.revoke(await this.userHash(message.from.id), this.now());
      this.deps.log?.("stop");
      await reply("Done: every computer paired with this account is unpaired. To pair again, choose Pair my phone in Oathrion's console.");
      return;
    }
    const route = this.routeOf(update);
    if (!route) {
      await reply(HELP_TEXT);
      return;
    }
    const secret = text.slice(-SECRET_LENGTH);
    const now = this.now();
    const target = (await room(route)).find((c) => c.session.machine?.startsWith(route) && c.session.pending?.secret === secret && c.session.pending.kind === "telegram" && c.session.pending.until > now);
    if (!target) {
      await reply("This pairing code has expired, or was used already. In Oathrion's console, choose Pair my phone again.");
      return;
    }
    const session = target.session;
    session.pending = null;
    const account = message.from.username ? `@${clean(message.from.username, 40)}` : clean(message.from.first_name, 40) || "your Telegram account";
    const ticket: TicketPayload = { v: 1, id: randomId(12), machine: session.machine!, chat: message.chat.id, user: message.from.id, account, label: session.label || "your computer", at: now };
    session.ticket = ticket;
    this.deps.log?.("paired");
    target.send({ t: "paired", ticket: await signTicket(this.deps.keys, ticket) });
    await reply(`✅ Paired with ${unlinked(ticket.label)}. Requests from its agents will arrive here, with Approve and Reject.\n\nTo unpair, choose Unpair in Oathrion's console, or send /stop.`);
  }

  /* -------------------------------------------------------------- la page du téléphone (Web Push) */

  /** Le manifeste de la page : ajoutée à l'écran d'accueil (iPhone), elle s'ouvre avec son code. */
  webManifest(code: string | null): Record<string, unknown> {
    const start = code && /^[A-Za-z0-9_-]{33}$/.test(code) ? `/pair#${code}` : "/pair";
    return {
      name: "Oathrion",
      short_name: "Oathrion",
      start_url: start,
      scope: "/",
      display: "standalone",
      background_color: "#06071c",
      theme_color: "#06071c",
      icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }],
    };
  }

  /** La clé VAPID publique : `applicationServerKey` de l'abonnement du navigateur. */
  webKey(): string | null {
    return this.deps.vapid?.publicKey ?? null;
  }

  /** La machine visée par une requête de la page : le code d'appairage, ou la route d'un appui. */
  webRouteOf(body: Record<string, unknown>): string | null {
    if (typeof body.code === "string" && /^[A-Za-z0-9_-]{33}$/.test(body.code)) return body.code.slice(0, ROUTE_LENGTH);
    if (typeof body.route === "string" && /^[A-Za-z0-9_-]{11}$/.test(body.route)) return body.route;
    return null;
  }

  /**
   * « Allow notifications » sur le téléphone : le code (usage unique), l'abonnement du navigateur
   * et la clé publique de l'appareil. Le ticket les porte ; le pivot en est prévenu.
   */
  async webPair(body: Record<string, unknown>, room: Room): Promise<WebReply> {
    if (!this.deps.vapid) return { status: 404, json: { error: "Browser notifications are off on this relay." } };
    const code = typeof body.code === "string" ? body.code : "";
    const route = this.webRouteOf({ code });
    const sub = (body.subscription ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const device = typeof body.device === "string" && RAW_P256.test(body.device) ? body.device : null;
    const p256dh = typeof sub.keys?.p256dh === "string" && RAW_P256.test(sub.keys.p256dh) ? sub.keys.p256dh : null;
    const auth = typeof sub.keys?.auth === "string" && /^[A-Za-z0-9_-]{22}$/.test(sub.keys.auth) ? sub.keys.auth : null;
    if (!route || !device || !p256dh || !auth || !pushEndpointAllowed(sub.endpoint)) return { status: 400, json: { error: "This page sent something Oathrion does not understand: reload it." } };
    const now = this.now();
    const secret = code.slice(ROUTE_LENGTH);
    const target = (await room(route)).find((c) => c.session.machine?.startsWith(route) && c.session.pending?.secret === secret && c.session.pending.kind === "web" && c.session.pending.until > now);
    if (!target) return { status: 410, json: { error: "This pairing code has expired, or was used already. In Oathrion's console, choose Pair my phone again." } };
    const session = target.session;
    session.pending = null;
    const ticket: TicketPayload = {
      v: 1,
      kind: "web",
      id: randomId(12),
      machine: session.machine!,
      device,
      push: { endpoint: sub.endpoint as string, p256dh, auth },
      account: clean(body.label, 40) || "your phone",
      label: session.label || "your computer",
      at: now,
    };
    session.ticket = ticket;
    this.deps.log?.("paired", { kind: "web" });
    target.send({ t: "paired", ticket: await signTicket(this.deps.keys, ticket) });
    return { status: 200, json: { ok: true, computer: ticket.label } };
  }

  /**
   * La page du téléphone vient de s'ouvrir avec ce code (bilan design du 23 novembre : les deux
   * écrans se répondent) : la console le montre tout de suite, la page dit à quel ordinateur elle
   * va se lier. Le code n'est pas consommé ; seul l'appairage le consomme.
   */
  async webSeen(body: Record<string, unknown>, room: Room): Promise<WebReply> {
    const code = typeof body.code === "string" ? body.code : "";
    const route = this.webRouteOf({ code });
    if (!route) return { status: 400, json: { error: "bad code" } };
    const now = this.now();
    const secret = code.slice(ROUTE_LENGTH);
    const target = (await room(route)).find((c) => c.session.machine?.startsWith(route) && c.session.pending?.secret === secret && c.session.pending.kind === "web" && c.session.pending.until > now);
    if (!target) return { status: 410, json: { error: "This pairing code has expired, or was used already. In Oathrion's console, choose Pair my phone again." } };
    if (!target.session.pending!.seen) {
      target.session.pending!.seen = true;
      target.send({ t: "pair.seen" });
    }
    return { status: 200, json: { computer: target.session.label || "your computer" } };
  }

  /** Un bouton touché sur le téléphone : signé par la clé de l'appareil, transmis à sa machine. */
  async webPress(body: Record<string, unknown>, room: Room): Promise<WebReply> {
    const route = this.webRouteOf({ route: body.route });
    const nonce = typeof body.nonce === "string" && NONCE.test(body.nonce) ? body.nonce : null;
    const choice = typeof body.choice === "string" && CHOICE.test(body.choice) ? body.choice : null;
    const at = typeof body.at === "number" && Number.isFinite(body.at) ? body.at : null;
    const device = typeof body.device === "string" && RAW_P256.test(body.device) ? body.device : null;
    const sig = typeof body.sig === "string" && body.sig.length <= 200 ? body.sig : "";
    /* L'accord signé sur ce que la page a montré : le relais ne voit pas ce texte, il le transmet tel quel ; l'ordinateur le vérifie. */
    const approval = typeof body.approval === "string" && /^[A-Za-z0-9_-]{60,200}$/.test(body.approval) ? body.approval : null;
    if (!route || !nonce || !choice || at === null || !device) return { status: 400, json: { error: "bad press" } };
    const now = this.now();
    if (Math.abs(now - at) > 15 * 60_000) return { status: 400, json: { error: "This phone's clock is off: set it to the right time." } };
    if (!(await verifyDevice(device, `press|${route}|${nonce}|${choice}|${String(at)}`, sig))) return { status: 403, json: { error: "This phone is not the one paired." } };
    const conns = await room(route);
    const target = conns.find((c) => c.session.ticket?.kind === "web" && c.session.ticket.device === device);
    if (!target) return { status: 503, json: { offline: true, error: "Your computer is offline, or Oathrion stopped. Decide in Oathrion's console when it is back." } };
    if ((await this.live(target)) === null) return { status: 403, json: { error: "This phone is unpaired." } };
    this.deps.log?.("press", { kind: "web" });
    /* L'appui part avec la signature de l'appareil : le pivot la vérifie lui-même. */
    target.send(await this.signedMessage("press", { machine: target.session.machine, nonce, choice, pressId: randomId(9), at: now, device: { at, sig, ...(approval ? { approval } : {}) } }));
    return { status: 200, json: { ok: true } };
  }

  /** « Unpair this phone », sur la page : signé par l'appareil, révoqué durablement. */
  async webUnpair(body: Record<string, unknown>): Promise<WebReply> {
    const device = typeof body.device === "string" && RAW_P256.test(body.device) ? body.device : null;
    const at = typeof body.at === "number" && Number.isFinite(body.at) ? body.at : null;
    const sig = typeof body.sig === "string" && body.sig.length <= 200 ? body.sig : "";
    if (!device || at === null || Math.abs(this.now() - at) > 15 * 60_000) return { status: 400, json: { error: "bad unpair" } };
    if (!(await verifyDevice(device, `unpair|${device}|${String(at)}`, sig))) return { status: 403, json: { error: "bad signature" } };
    await this.deps.revocations.revoke(await this.revocationKey({ kind: "web", device }), this.now());
    this.deps.log?.("stop", { kind: "web" });
    return { status: 200, json: { ok: true } };
  }
}
