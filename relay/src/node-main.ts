/**
 * `npm start` : le relais sur une machine. Tout vient de l'environnement, rien du dépôt
 * (`relay/README.md`) : `RELAY_SIGNING_KEY`, `RELAY_REVOKE_SALT`, `VAPID_PRIVATE_KEY`, `PUBLIC_URL` ;
 * Telegram, facultatif : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `BOT_USERNAME` ; et
 * `PORT`, `HOST`, `RELAY_MODE=poll`, `RELAY_REVOCATIONS_FILE`, `TELEGRAM_API_BASE`, `TRUST_PROXY=1`.
 */
import { RelayCore, RelayKeys, TelegramClient } from "./core.ts";
import { FileRevocations, startNodeRelay } from "./node.ts";
import { VapidKeys } from "./webpush.ts";

const need = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[relay] ${name} is missing (an environment variable, never a file of the repository).`);
    process.exit(2);
  }
  return value;
};

const mode = process.env.RELAY_MODE === "poll" ? "poll" : "webhook";
const port = Number(process.env.PORT || 8787);
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const telegram = token ? new TelegramClient(token, undefined, process.env.TELEGRAM_API_BASE || undefined) : null;
const vapidKey = process.env.VAPID_PRIVATE_KEY?.trim();
const core = new RelayCore({
  bot: (process.env.BOT_USERNAME || "OathrionBot").replace(/^@/, ""),
  telegram,
  vapid: vapidKey ? await VapidKeys.load(vapidKey) : null,
  publicUrl: process.env.PUBLIC_URL || `http://127.0.0.1:${String(port)}`,
  keys: await RelayKeys.load(need("RELAY_SIGNING_KEY")),
  revocations: new FileRevocations(process.env.RELAY_REVOCATIONS_FILE || "./revocations.json"),
  salt: need("RELAY_REVOKE_SALT"),
  /* Des événements et des compteurs, jamais un texte. */
  log: (event, detail) => console.error(`[relay] ${event}${detail ? ` ${JSON.stringify(detail)}` : ""}`),
});
const relay = await startNodeRelay({
  core,
  telegram,
  mode,
  ...(telegram && mode === "webhook" ? { webhookSecret: need("TELEGRAM_WEBHOOK_SECRET") } : {}),
  port,
  host: process.env.HOST || "127.0.0.1",
  trustProxy: process.env.TRUST_PROXY === "1",
});
console.error(`[relay] listening on port ${String(relay.port)}: ${core.webKey() ? "browser notifications" : "no browser notifications"}, ${telegram ? `Telegram @${core.bot} (${mode})` : "no Telegram"}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void relay.close().then(() => process.exit(0)));
