/**
 * `oathrion phone` — décider depuis son téléphone, partout (12 novembre 2026,
 * `server/local-telegram.ts`).
 *
 *   oathrion phone                        un téléphone est-il appairé ?
 *   oathrion phone telegram               appairer : le jeton d'un robot créé avec @BotFather est
 *                                         demandé au clavier (jamais dans l'historique du terminal)
 *   oathrion phone test                   une notification d'essai sur le téléphone
 *   oathrion phone off                    désappairer
 *
 * L'appairage se fait ici, dans le terminal : le pivot ne lit Telegram qu'une fois l'appairage
 * fini (deux lecteurs du même robot se gêneraient). La personne envoie le code au robot depuis
 * SON téléphone ; seul ce compte, dans cette conversation, pourra décider.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { forgetTelegram, paired, phoneCaption, readTelegram, TelegramApi, TelegramError, TOKEN_SHAPE, writeTelegram } from "../../server/local-telegram";
import { hubDir } from "./hub";
import { terminalQr } from "./qr";

export const PHONE_USAGE = `
oathrion phone                          whether a phone is paired
oathrion phone telegram                 pair your phone, through Telegram (it asks for the bot token)
oathrion phone test                     a test notification on your phone
oathrion phone off                      unpair

  To get a bot token: in Telegram, open @BotFather, send /newbot, pick a name.
  Use a new bot for Oathrion: it should serve nothing else.
`;

export interface PhoneIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Le script d'Oathrion (`oathrion.mjs`) : la console et ses sons sont à côté, dans `public/`. */
  script?: string;
  fetchImpl?: typeof fetch;
  /**
   * Le jeton tapé au clavier, sans écho (`cli/bin.ts`) : en argument, il resterait en clair dans
   * l'historique du terminal ; et une commande affichée avec « <bot token> », recopiée telle
   * quelle, fait échouer le shell (essai réel du 12 novembre). `null` sans terminal.
   */
  askSecret?: (question: string) => Promise<string | null>;
  /** Pour les essais : combien de temps attendre le code envoyé depuis le téléphone. */
  pairWithinMs?: number;
}

/** Un fichier livré avec la console (`public/…`), ou celui de la copie de développement. */
export function shippedFile(script: string | undefined, path: string): string | null {
  const here = script ? dirname(script) : process.cwd();
  for (const candidate of [join(here, "public", path), join(here, "..", "client", "public", path), join(process.cwd(), "client", "public", path)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Message {
  update_id: number;
  message?: { chat: { id: number; type?: string }; from?: { id: number }; text?: string };
}

export async function runPhone(argv: readonly string[], io: PhoneIo): Promise<number> {
  const dir = hubDir(io.env);
  const [command, value] = argv;
  const settings = readTelegram(dir);

  if (command === undefined) {
    if (paired(settings)) io.out(`Phone: paired, through Telegram (@${settings.bot}). Requests arrive there, with Approve and Reject.`);
    else io.out('Phone: not paired. "oathrion phone telegram" pairs it in two minutes.');
    return 0;
  }

  if (command === "off" || command === "remove") {
    if (paired(settings)) {
      await new TelegramApi(settings.token, io.fetchImpl).call("sendMessage", { chat_id: settings.chatId, text: "Oathrion: this phone is no longer paired. Requests will not arrive here any more." }).catch(() => undefined);
    }
    forgetTelegram(dir);
    io.out("Phone unpaired: requests will no longer go to Telegram.");
    return 0;
  }

  if (command === "test") {
    if (!paired(settings)) {
      io.err('No phone is paired: "oathrion phone telegram" first.');
      return 1;
    }
    try {
      await new TelegramApi(settings.token, io.fetchImpl).sendCard(
        settings.chatId,
        phoneCaption("Oathrion: test", "A request from one of your agents will look like this, with Approve and Reject. Tap them from anywhere: your computer fetches your answer itself.", false),
        shippedFile(io.script, "mascots/warden.png"),
        null,
      );
      io.out("Test sent to your phone.");
      return 0;
    } catch (error) {
      io.err(`Telegram refused: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (command === "telegram") {
    let token = (value ?? "").trim();
    if (token === "") {
      io.out("In Telegram, open @BotFather, send /newbot, pick a name: it gives you a token.");
      token = ((await io.askSecret?.("Paste the bot token (it is not shown): ")) ?? "").trim();
      if (token === "") {
        io.err("No token: nothing changed.");
        return 3;
      }
    }
    if (!TOKEN_SHAPE.test(token)) {
      io.err(`That does not look like a bot token (expected 123456789:AA…).${PHONE_USAGE}`);
      return 3;
    }
    const api = new TelegramApi(token, io.fetchImpl);
    let bot: string;
    try {
      bot = (await api.call<{ username: string }>("getMe")).username;
      /* Un robot qui renvoyait ses messages ailleurs (webhook) ne se lit pas : il est rendu à Oathrion. */
      await api.call("deleteWebhook", { drop_pending_updates: false });
    } catch (error) {
      io.err(`Telegram refused this token: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const code = randomBytes(4).toString("hex");
    writeTelegram(dir, { token, bot, pairCode: code });
    io.out(`Bot found: @${bot}.`);
    io.out("");
    /* Le plus court : l'appareil photo du téléphone ouvre Telegram sur le robot, avec le code. */
    io.out("  Scan this with your phone's camera, then tap Start in Telegram:");
    io.out("");
    for (const line of terminalQr(`https://t.me/${bot}?start=${code}`)) io.out(`    ${line}`);
    io.out("");
    io.out(`  No camera at hand? In Telegram, search @${bot}, tap Start, then send this code: ${code}`);
    io.out("");
    io.out("Waiting for your phone…");

    const deadline = Date.now() + (io.pairWithinMs ?? 5 * 60_000);
    let offset = 0;
    while (Date.now() < deadline) {
      let updates: Message[];
      try {
        updates = await api.call<Message[]>("getUpdates", { offset, timeout: Math.max(1, Math.min(25, Math.floor((deadline - Date.now()) / 1000))), allowed_updates: ["message"] }, 40_000);
      } catch (error) {
        /* Le pivot lit encore l'ancien appairage (409) : il lâche le robot en moins d'une minute. */
        if (error instanceof TelegramError && error.code === 409) {
          await new Promise((done) => setTimeout(done, 3_000));
          continue;
        }
        io.err(`Telegram is unreachable: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        const text = message?.text?.trim() ?? "";
        if (!message?.from || message.chat.type !== "private" || (text !== code && text !== `/start ${code}`)) continue;
        writeTelegram(dir, { token, bot, chatId: message.chat.id, userId: message.from.id });
        /* Les messages déjà lus ne reviennent pas au pivot. */
        await api.call("getUpdates", { offset, timeout: 0 }).catch(() => undefined);
        await welcome(api, message.chat.id, io.script).catch(() => undefined);
        io.out(`✓ Paired: requests from your agents now reach your phone (@${bot}), with Approve and Reject.`);
        io.out("  On your phone, set Oathrion's sound for this chat: the bot just sent it, with how.");
        io.out('  "oathrion phone test" sends a test; "oathrion phone off" unpairs.');
        return 0;
      }
    }
    io.err('No code received in time. Run "oathrion phone telegram" again.');
    return 1;
  }

  io.err(`Unknown command: ${command}.${PHONE_USAGE}`);
  return 3;
}

/** Le premier message sur le téléphone : ce qui arrivera ici, et la sonnerie d'Oathrion à poser. */
async function welcome(api: TelegramApi, chatId: number, script: string | undefined): Promise<void> {
  await api.call("sendMessage", {
    chat_id: chatId,
    text:
      `✓ This phone is paired with Oathrion on "${hostname()}".\n\n` +
      "When one of your AI agents wants to do something that needs you, it arrives here, with the agent's mascot and Approve / Reject. " +
      "Tap them from anywhere: your computer fetches your answer itself, nothing reaches into it.\n\n" +
      "What leaves your computer: what the agent wants to do (keys and tokens hidden), never the content of your files.",
  });
  const sound = shippedFile(script, "sounds/oathrion.mp3");
  if (sound) {
    await api.sendSound(
      chatId,
      sound,
      "Oathrion's sound. To hear it for every request: touch and hold this sound → Save for notifications. Then tap this chat's name → Notifications → Sound → Oathrion.",
    );
  }
}
