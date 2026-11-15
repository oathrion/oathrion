/**
 * DÉCIDER DEPUIS SON TÉLÉPHONE, PARTOUT (12 novembre 2026, demandé par l'utilisateur : « une
 * personne qui laisse sa machine chez elle doit pouvoir recevoir la notification et approuver
 * depuis son téléphone, à n'importe quel moment »). Le canal choisi : Telegram.
 *
 * ## Pourquoi Telegram, et comment sans ouvrir la machine
 *
 * Un téléphone ne peut pas joindre une machine restée derrière la box. Le pivot ne s'ouvre donc
 * pas : il APPELLE Telegram (`getUpdates`, en attente longue) et y lit les boutons pressés. Rien
 * n'écoute dehors, aucune redirection de port, aucun service à nous.
 *
 * ## Ce qui protège la décision
 *
 * - Seuls comptent les boutons pressés par LE compte appairé, dans LA conversation appairée
 *   (`userId`, `chatId`, posés par `oathrion phone telegram`).
 * - Chaque bouton porte un identifiant aléatoire, valable pour cette notification seulement, en
 *   mémoire du pivot : un bouton ne se fabrique pas, et un vieux message n'agit plus.
 * - Telegram ne fabrique pas un appui : un programme qui volerait le jeton du robot pourrait lire
 *   les messages, pas presser un bouton au nom de la personne.
 *
 * ## Ce qui sort de la machine
 *
 * Le titre de la notification (quel agent, quelle action, quel serveur), la mascotte, et ce qui a
 * été décidé. Jamais le contenu d'un fichier. Une ligne de commande y est passée au crible :
 * ce qui ressemble à une clé ou à un jeton devient « ••• » (`redactForPhone`).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { doneOf, notificationActions } from "./notifications/desktop";
import type { NotificationEvent } from "./notifications/types";

export const TELEGRAM_FILE = "telegram.json";

export interface TelegramSettings {
  token: string;
  /** Le nom du robot (sans @), pour le lien d'appairage. */
  bot: string;
  /** Posés à l'appairage : la conversation, et la personne qui seule peut décider. */
  chatId?: number;
  userId?: number;
  /** Le code du lien d'appairage, tant qu'il n'a pas servi. */
  pairCode?: string;
}

export function readTelegram(dir: string): TelegramSettings | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, TELEGRAM_FILE), "utf8")) as Record<string, unknown>;
    if (typeof raw.token !== "string" || typeof raw.bot !== "string") return null;
    return {
      token: raw.token,
      bot: raw.bot,
      ...(typeof raw.chatId === "number" ? { chatId: raw.chatId } : {}),
      ...(typeof raw.userId === "number" ? { userId: raw.userId } : {}),
      ...(typeof raw.pairCode === "string" ? { pairCode: raw.pairCode } : {}),
    };
  } catch {
    return null;
  }
}

export function writeTelegram(dir: string, settings: TelegramSettings): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, TELEGRAM_FILE), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function forgetTelegram(dir: string): void {
  rmSync(join(dir, TELEGRAM_FILE), { force: true });
}

export const paired = (s: TelegramSettings | null): s is TelegramSettings & { chatId: number; userId: number } =>
  s !== null && typeof s.chatId === "number" && typeof s.userId === "number";

/** Un jeton de robot tel que BotFather le donne : `123456789:AA…`. */
export const TOKEN_SHAPE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

/**
 * Ce qui part sur le téléphone : une ligne de commande passée au crible. Les clés et jetons
 * reconnaissables, et toute longue suite de caractères qui en a l'air, deviennent « ••• ».
 */
export function redactForPhone(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)[-_](live|test)?[-_]?[A-Za-z0-9]{8,}/g, "•••")
    .replace(/\b(ghp|gho|ghs|github_pat|xox[abpr]|glpat|AKIA|ASIA)[-_A-Za-z0-9]{8,}/g, "•••")
    .replace(/\b(Bearer|token|password|passwd|secret|api[-_]?key)([=:\s]+)\S+/gi, "$1$2•••")
    /* Sans « / » : un chemin reste lisible ; une longue suite d'un seul tenant est masquée. */
    .replace(/[A-Za-z0-9_+=-]{32,}/g, "•••");
}

/** L'API de Telegram, réduite à ce qu'Oathrion appelle. Injectable pour les essais. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, body: Record<string, unknown> | FormData = {}, timeoutMs = 20_000): Promise<T> {
    const form = body instanceof FormData;
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      ...(form ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!payload.ok) {
      /* Le jeton est dans l'adresse : seule la description de Telegram remonte, jamais l'adresse. */
      throw new TelegramError(payload.description ?? `HTTP ${String(response.status)}`, payload.error_code ?? response.status);
    }
    return payload.result as T;
  }

  /** Une photo (la mascotte) avec sa légende et ses boutons ; sans photo lisible, un message. */
  async sendCard(chatId: number, caption: string, image: string | null, keyboard: Button[][] | null): Promise<{ message_id: number; photo: boolean }> {
    const markup = keyboard ? { inline_keyboard: keyboard } : undefined;
    if (image && existsSync(image) && image.endsWith(".png")) {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("caption", caption.slice(0, 1024));
      if (markup) form.set("reply_markup", JSON.stringify(markup));
      form.set("photo", new Blob([readFileSync(image)], { type: "image/png" }), "mascot.png");
      const sent = await this.call<{ message_id: number }>("sendPhoto", form);
      return { message_id: sent.message_id, photo: true };
    }
    const sent = await this.call<{ message_id: number }>("sendMessage", { chat_id: chatId, text: caption.slice(0, 4096), ...(markup ? { reply_markup: markup } : {}) });
    return { message_id: sent.message_id, photo: false };
  }

  /** Un son, à garder comme sonnerie de la conversation. */
  async sendSound(chatId: number, file: string, caption: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption.slice(0, 1024));
    form.set("title", "Oathrion");
    form.set("performer", "Oathrion");
    form.set("audio", new Blob([readFileSync(file)], { type: "audio/mpeg" }), "oathrion.mp3");
    await this.call("sendAudio", form);
  }
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export interface Button {
  text: string;
  callback_data: string;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } };
}

/** La légende d'une notification : le titre, ce qui se passe, et d'où ça vient. */
export function phoneCaption(title: string, body: string, danger: boolean): string {
  return `${danger ? "🔴 " : ""}${redactForPhone(title)}\n\n${redactForPhone(body)}\n\n— Oathrion, on your computer`;
}

interface Sent {
  event: NotificationEvent;
  caption: string;
  photo: boolean;
  messageId: number;
  decided: string | null;
}

/**
 * Le canal du téléphone : envoie la carte (la mascotte, le titre, les boutons), lit les boutons
 * pressés, agit par la même voie que la notification de l'ordinateur (`act`), puis demande
 * « Was this right? ».
 */
export class TelegramPhone {
  private readonly sent = new Map<string, Sent>();
  private offset = 0;
  private running = false;

  constructor(
    private readonly options: {
      dir: string;
      act: (event: NotificationEvent, actionId: string) => unknown;
      feedback: (event: NotificationEvent, right: boolean, decision: string) => void;
      text: (event: NotificationEvent) => { title: string; body: string };
      fetchImpl?: typeof fetch;
      /** Pour les essais : le temps d'attente entre deux tours quand rien n'est appairé. */
      idleMs?: number;
    },
  ) {}

  private api(settings: TelegramSettings): TelegramApi {
    return new TelegramApi(settings.token, this.options.fetchImpl);
  }

  get configured(): boolean {
    return paired(readTelegram(this.options.dir));
  }

  /** Envoie la notification sur le téléphone ; rend vrai si elle est partie. */
  async deliver(event: NotificationEvent): Promise<boolean> {
    const settings = readTelegram(this.options.dir);
    if (!paired(settings)) return false;
    const { title, body } = this.options.text(event);
    const caption = phoneCaption(title, body, event.data.danger === true);
    const actions = notificationActions(event).filter((a) => a.id !== "open");
    const id = randomBytes(9).toString("base64url");
    const keyboard = actions.length > 0 ? [actions.map((a) => ({ text: a.label, callback_data: `${id}:${a.id}` }))] : null;
    const image = typeof event.data.image === "string" ? event.data.image : null;
    const sent = await this.api(settings).sendCard(settings.chatId, caption, image, keyboard);
    if (keyboard) {
      this.sent.set(id, { event, caption, photo: sent.photo, messageId: sent.message_id, decided: null });
      while (this.sent.size > 100) this.sent.delete(this.sent.keys().next().value!);
    }
    return true;
  }

  /**
   * Décidé ailleurs (l'ordinateur, la console) : le message de cette notification perd ses
   * boutons et dit qui a décidé. Il ne redemande pas d'avis : il a été demandé là où on a décidé.
   */
  async settled(eventId: string, text: string): Promise<void> {
    const settings = readTelegram(this.options.dir);
    if (!paired(settings)) return;
    for (const [id, item] of this.sent) {
      if (item.event.id !== eventId || item.decided !== null) continue;
      item.decided = text;
      this.sent.delete(id);
      await this.edit(this.api(settings), settings.chatId, item, `${item.caption}\n\n✓ ${text}`, null);
    }
  }

  /** Un tour : lit ce qui est arrivé depuis le dernier, et y répond. Rend le nombre d'appuis traités. */
  async poll(waitSeconds = 50): Promise<number> {
    const settings = readTelegram(this.options.dir);
    if (!paired(settings)) return 0;
    const api = this.api(settings);
    const updates = await api.call<Update[]>("getUpdates", { offset: this.offset, timeout: waitSeconds, allowed_updates: ["callback_query", "message"] }, (waitSeconds + 15) * 1000);
    let handled = 0;
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const press = update.callback_query;
      if (!press) continue;
      /* Seule la personne appairée, dans sa conversation : tout autre appui est ignoré, sans réponse. */
      if (press.from.id !== settings.userId || press.message?.chat.id !== settings.chatId) continue;
      handled += 1;
      await this.press(api, settings.chatId, press.id, press.data ?? "").catch(() => undefined);
    }
    return handled;
  }

  private async press(api: TelegramApi, chatId: number, pressId: string, data: string): Promise<void> {
    const [id, choice] = data.split(":");
    const item = id ? this.sent.get(id) : undefined;
    if (!item || !choice) {
      await api.call("answerCallbackQuery", { callback_query_id: pressId, text: "This decision is no longer here: Oathrion restarted, or it was made already." });
      return;
    }
    if (choice === "right" || choice === "wrong") {
      if (item.decided === null) return;
      this.sent.delete(id!);
      this.options.feedback(item.event, choice === "right", item.decided);
      await api.call("answerCallbackQuery", { callback_query_id: pressId, text: "Thanks: Oathrion learns from it." });
      await this.edit(api, chatId, item, `${item.caption}\n\n✓ ${item.decided}`, null);
      return;
    }
    if (item.decided !== null) {
      await api.call("answerCallbackQuery", { callback_query_id: pressId, text: item.decided });
      return;
    }
    if (!notificationActions(item.event).some((a) => a.id === choice)) return;
    const { text } = doneOf(await this.options.act(item.event, choice));
    item.decided = `${text} (from your phone)`;
    await api.call("answerCallbackQuery", { callback_query_id: pressId, text: text.slice(0, 190) });
    await this.edit(api, chatId, item, `${item.caption}\n\n✓ ${item.decided}\nWas this right?`, [
      [
        { text: "👍", callback_data: `${id}:right` },
        { text: "👎", callback_data: `${id}:wrong` },
      ],
    ]);
  }

  private async edit(api: TelegramApi, chatId: number, item: Sent, caption: string, keyboard: Button[][] | null): Promise<void> {
    const markup = { inline_keyboard: keyboard ?? [] };
    await api.call(item.photo ? "editMessageCaption" : "editMessageText", {
      chat_id: chatId,
      message_id: item.messageId,
      ...(item.photo ? { caption: caption.slice(0, 1024) } : { text: caption.slice(0, 4096) }),
      reply_markup: markup,
    });
  }

  /** La boucle du pivot : un tour après l'autre, tant qu'il tourne ; patiente si rien n'est appairé. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const idle = this.options.idleMs ?? 15_000;
    const loop = async () => {
      while (this.running) {
        try {
          if (!this.configured) {
            await sleep(idle);
            continue;
          }
          await this.poll();
        } catch (error) {
          /* Hors ligne, ou un autre lecteur du même robot (409) : on réessaie, plus tard. */
          await sleep(error instanceof TelegramError && error.code === 409 ? 30_000 : 10_000);
        }
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
