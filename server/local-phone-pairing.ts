/**
 * APPAIRER SON TÉLÉPHONE DEPUIS LA CONSOLE (16 novembre, retour des premiers testeurs : « rien
 * que pour approuver depuis le téléphone, le parcours est trop complexe »). Le même appairage
 * que `oathrion phone telegram` (`cli/wrap/phone.ts`), sans terminal : la personne crée son robot
 * avec @BotFather sur CET ordinateur, colle le jeton dans la console, scanne le QR code avec son
 * téléphone et touche Start. La console voit l'appairage arriver toute seule.
 *
 * La sécurité ne change pas : un code à usage unique, envoyé depuis le téléphone ; seul ce compte,
 * dans cette conversation privée, pourra décider. Le pivot ne lit le robot qu'une fois appairé.
 */
import { randomBytes } from "node:crypto";

import { create } from "qrcode/lib/core/qrcode";

import { paired, phoneCaption, readTelegram, TelegramApi, TelegramError, TOKEN_SHAPE, writeTelegram } from "./local-telegram";

/** Cinq minutes pour scanner et toucher Start, comme dans le terminal. */
export const PAIR_WITHIN_MS = 5 * 60_000;

export type PairingState =
  | { state: "idle" }
  | { state: "waiting"; bot: string; link: string; code: string; until: string; qr: { size: number; cells: string } }
  | { state: "paired"; bot: string }
  | { state: "expired"; bot: string }
  | { state: "failed"; message: string };

interface Update {
  update_id: number;
  message?: { chat: { id: number; type?: string }; from?: { id: number }; text?: string };
}

/** Le QR code du lien : une ligne de « 0 » et de « 1 » par module, que la console dessine. */
function qrOf(text: string): { size: number; cells: string } {
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  let cells = "";
  for (let row = 0; row < modules.size; row += 1) for (let col = 0; col < modules.size; col += 1) cells += modules.get(row, col) ? "1" : "0";
  return { size: modules.size, cells };
}

export class PhonePairing {
  private current: PairingState = { state: "idle" };
  private run = 0;

  constructor(
    private readonly dir: string,
    private readonly options: { fetchImpl?: typeof fetch; withinMs?: number; mascot?: string | null } = {},
  ) {}

  status(): PairingState {
    const settings = readTelegram(this.dir);
    if (this.current.state !== "waiting" && paired(settings)) return { state: "paired", bot: settings.bot };
    return this.current;
  }

  /** Vérifie le jeton auprès de Telegram, puis attend le Start du téléphone, en arrière-plan. */
  async start(rawToken: string): Promise<PairingState> {
    const token = rawToken.trim();
    if (!TOKEN_SHAPE.test(token)) return (this.current = { state: "failed", message: "That is not a bot token: a token starts with digits and a colon, like 123456789:AA…. Copy the whole line BotFather sent, after « Use this token »." });
    const api = new TelegramApi(token, this.options.fetchImpl);
    let bot: string;
    try {
      bot = (await api.call<{ username: string }>("getMe")).username;
      /* Un robot qui renvoyait ses messages ailleurs (webhook) ne se lit pas : il est rendu à Oathrion. */
      await api.call("deleteWebhook", { drop_pending_updates: false });
    } catch (error) {
      return (this.current = { state: "failed", message: `Telegram refused this token: ${error instanceof Error ? error.message : String(error)}` });
    }
    const code = randomBytes(4).toString("hex");
    writeTelegram(this.dir, { token, bot, pairCode: code });
    const link = `https://t.me/${bot}?start=${code}`;
    const until = Date.now() + (this.options.withinMs ?? PAIR_WITHIN_MS);
    this.current = { state: "waiting", bot, link, code, until: new Date(until).toISOString(), qr: qrOf(link) };
    const run = ++this.run;
    void this.await(api, token, bot, code, until, run);
    return this.current;
  }

  private async await(api: TelegramApi, token: string, bot: string, code: string, until: number, run: number): Promise<void> {
    let offset = 0;
    while (Date.now() < until && run === this.run) {
      let updates: Update[];
      try {
        updates = await api.call<Update[]>("getUpdates", { offset, timeout: Math.max(1, Math.min(25, Math.floor((until - Date.now()) / 1000))), allowed_updates: ["message"] }, 40_000);
      } catch (error) {
        /* Le pivot lit encore l'ancien appairage du même robot (409) : il le lâche en moins d'une minute. */
        if (error instanceof TelegramError && error.code === 409) {
          await new Promise((done) => setTimeout(done, 3_000));
          continue;
        }
        if (run === this.run) this.current = { state: "failed", message: `Telegram is unreachable: ${error instanceof Error ? error.message : String(error)}` };
        return;
      }
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        const text = message?.text?.trim() ?? "";
        if (!message?.from || message.chat.type !== "private" || (text !== code && text !== `/start ${code}`)) continue;
        if (run !== this.run) return;
        writeTelegram(this.dir, { token, bot, chatId: message.chat.id, userId: message.from.id });
        /* Les messages déjà lus ne reviennent pas au pivot. */
        await api.call("getUpdates", { offset, timeout: 0 }).catch(() => undefined);
        await this.test().catch(() => undefined);
        this.current = { state: "paired", bot };
        return;
      }
    }
    if (run === this.run && this.current.state === "waiting") this.current = { state: "expired", bot };
  }

  /** Une demande d'essai, telle qu'elle arrivera : la mascotte, le texte, sans boutons. */
  async test(): Promise<void> {
    const settings = readTelegram(this.dir);
    if (!paired(settings)) throw new Error("No phone is paired.");
    await new TelegramApi(settings.token, this.options.fetchImpl).sendCard(
      settings.chatId,
      phoneCaption("Oathrion: your phone is paired", "A request from one of your agents will look like this, with Approve and Reject. Tap them from anywhere: your computer fetches your answer itself.", false),
      this.options.mascot ?? null,
      null,
    );
  }
}
