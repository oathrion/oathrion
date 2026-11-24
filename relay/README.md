# Oathrion's phone relay

It lets a person pair their phone in one scan and approve their agents' requests from anywhere:
Pair my phone in the console, a QR code, Oathrion's page opens on the phone, Allow notifications,
Paired. No app, no account. The requests then arrive as the phone browser's notifications (Web
Push), with Approve and Reject. An official Telegram bot is optional.

- `src/core.ts`: the whole relay, with no platform: pairing codes, signed tickets, challenges,
  routing of presses, checks, rate limits; `src/webpush.ts`: VAPID and delivery.
- `public/`: the phone's page (`/pair`, `/decide`), its service worker and icon.
- `src/worker.ts`: Cloudflare Workers + Durable Objects (recommended).
- `src/node.ts`, `src/node-main.ts`: a single Node process (plan B, and local trials).
- Tests: `relay/test/`, `server/test/local-phone-relay.test.ts` (Telegram) and
  `server/test/local-phone-relay-web.test.ts` (Web Push), run by the repository's `npx vitest run`.

## What the relay sees and keeps

Web Push: nothing of a request. The computer encrypts each notification for the paired browser
(RFC 8291); the relay signs the VAPID header and hands the sealed packet to the browser's
notification service (Google, Apple, Mozilla, Microsoft only), which cannot read it either. Each
press is signed by the phone's own key (ECDSA P-256, kept by its browser); the relay checks it,
then the computer checks it again. Telegram: the title and the reason, for the time of a message.

It logs events and counts, never a text. It keeps in memory the open connections, the pending
pairing code (10 minutes) and the rate counters. The only durable state: the revocations (a
salted hash of a Telegram account or of a phone's key, and a date). The pairing itself is a
ticket signed by the relay, which the computer keeps and shows at each connection.

## Secrets

Never in a file of the repository. `npm run keys` draws them on your machine:

| Name | What |
|---|---|
| `RELAY_SIGNING_KEY` | the relay's Ed25519 private key (PKCS#8): it signs tickets and presses |
| `RELAY_REVOKE_SALT` | the salt of the revocation hashes |
| `VAPID_PRIVATE_KEY` | the relay's P-256 key for the browsers' notification services |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | optional: the bot, from @BotFather |

The relay's public key is pinned in `server/local-phone-relay.ts` (`OFFICIAL_RELAY.key`): the
computers only believe a ticket or a press signed by that key. Changing it, or the VAPID key,
unpairs every phone.

## Deploy on Cloudflare

From the Cloudflare account that holds oathrion.com:

```bash
bash relay/script/deploy.sh
```

It installs wrangler and signs you in (once), draws the relay's secrets on your machine and sends
them to Cloudflare without showing them, deploys on `relay.oathrion.com` with the phone's page,
checks `https://relay.oathrion.com/v1/health`, then pins the relay's public key in
`server/local-phone-relay.ts`, to commit. Run again later, it keeps the keys.

`--telegram` adds the official bot: a QR code opens @BotFather on the phone, a second one opens a
page (served by your computer on the Wi-Fi) where you paste the bot's token on the phone itself,
or you paste it in the terminal, never shown.

Checked before release without an account: `npx wrangler deploy --dry-run` bundles the Worker
and its page; `wrangler dev` served the page with its content policy, paired a browser through
the Durable Objects, and reached Google's real notification service with a VAPID signature; with
Telegram, pairing, a press, an intruder's press and /stop.

## Run it on a machine (plan B, or a local trial)

```bash
cd relay && npm install
RELAY_SIGNING_KEY=… RELAY_REVOKE_SALT=… VAPID_PRIVATE_KEY=… PUBLIC_URL=https://… npm start
```

The phone's page needs HTTPS (a service worker does): put Caddy in front. With Telegram, add
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `BOT_USERNAME`; `RELAY_MODE=poll` reads the
bot with `getUpdates` instead of a webhook (no public address needed: a trial with a test bot). Behind Caddy, `TRUST_PROXY=1`. A computer is pointed at it
with `OATHRION_PHONE_RELAY_URL=ws://127.0.0.1:8787/v1/connect` and
`OATHRION_PHONE_RELAY_KEY=<public key>`.
