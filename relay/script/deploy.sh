#!/usr/bin/env bash
# DÉPLOYER LE RELAIS EN UNE COMMANDE (23 novembre, relay/README.md), depuis le compte Cloudflare
# qui porte oathrion.com :
#
#   bash relay/script/deploy.sh             le relais et la page du téléphone (Web Push)
#   bash relay/script/deploy.sh --telegram  en plus, le robot Telegram officiel (@BotFather d'abord)
#
# 1. installe wrangler et se connecte à Cloudflare (le navigateur s'ouvre une fois) ;
# 2. tire les secrets du relais sur CETTE machine (sa clé de signature, le sel des révocations, la
#    clé VAPID) : ils partent chez Cloudflare sans être affichés ; le fichier temporaire est effacé ;
# 3. --telegram : ouvre @BotFather sur le téléphone (un QR code), reçoit le jeton du robot depuis le
#    téléphone (un second QR code, sur le Wi-Fi) ou collé ici sans s'afficher, et le vérifie ;
# 4. déploie le Worker sur relay.oathrion.com, vérifie /v1/health ;
# 5. épingle la clé publique du relais dans server/local-phone-relay.ts (à commiter).
#
# Relancé plus tard : la clé du relais est gardée (la changer désappairerait chaque ordinateur).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
BOT="$(sed -n 's/^BOT_USERNAME = "\(.*\)"/\1/p' wrangler.toml)"
HOST="relay.oathrion.com"
TELEGRAM=0
[ "${1:-}" = "--telegram" ] && TELEGRAM=1

echo "Oathrion relay: deploying on https://$HOST"
npm install --no-audit --no-fund --silent
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

TOKEN=""
if [ "$TELEGRAM" = 1 ]; then
  # Le jeton vient du téléphone (deux QR codes) ou se colle ici : `script/receive-token.ts`.
  TOKEN="$(node script/receive-token.ts "$BOT" || true)"
  # Collé avec des espaces, des guillemets ou « token: » devant : on garde le jeton seul.
  TOKEN="$(printf '%s' "$TOKEN" | grep -oE '[0-9]{5,15}:[A-Za-z0-9_-]{30,64}' | head -n1 || true)"
  if [ -z "$TOKEN" ]; then
    echo "This is not a bot token: a token looks like 123456789:AAH… (digits, a colon, then about 35 letters)." >&2
    exit 1
  fi
  ME="$(curl -sS "https://api.telegram.org/bot$TOKEN/getMe" || true)"
  NAME="$(printf '%s' "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
  if [ -z "$NAME" ]; then
    echo "Telegram refused this token (it was revoked, or a character is missing). In BotFather: /mybots, your bot, API Token, then run again." >&2
    exit 1
  fi
  if [ "$NAME" != "$BOT" ]; then
    # BotFather a donné un autre nom (celui-ci était pris) : le relais prend le nom du robot.
    echo "This token is @$NAME, not @$BOT: the relay will use @$NAME."
    sed -i "s/^BOT_USERNAME = \".*\"/BOT_USERNAME = \"$NAME\"/" wrangler.toml
    BOT="$NAME"
  fi
  echo "Token checked: it is @$BOT."
fi

EXISTING="$(npx wrangler secret list 2>/dev/null || true)"
FIRST=1
if printf '%s' "$EXISTING" | grep -q RELAY_SIGNING_KEY; then FIRST=0; fi
KEYS="$(node script/keys.ts)"
pick() { printf '%s\n' "$KEYS" | sed -n "s/^$1=//p"; }
PUBLIC="$(printf '%s\n' "$KEYS" | sed -n 's/.*OFFICIAL_RELAY.key): //p')"
WEBHOOK_SECRET="$(pick TELEGRAM_WEBHOOK_SECRET)"
{
  printf '{'
  SEP=""
  if [ "$FIRST" = 1 ]; then
    printf '"RELAY_SIGNING_KEY":"%s","RELAY_REVOKE_SALT":"%s"' "$(pick RELAY_SIGNING_KEY)" "$(pick RELAY_REVOKE_SALT)"
    SEP=","
  else
    echo "The relay key is already at Cloudflare: kept." >&2
  fi
  # La clé VAPID : tirée une fois ; la changer obligerait chaque téléphone à s'appairer de nouveau.
  if ! printf '%s' "$EXISTING" | grep -q VAPID_PRIVATE_KEY; then
    printf '%s"VAPID_PRIVATE_KEY":"%s"' "$SEP" "$(pick VAPID_PRIVATE_KEY)"
    SEP=","
  fi
  if [ -n "$TOKEN" ]; then printf '%s"TELEGRAM_BOT_TOKEN":"%s","TELEGRAM_WEBHOOK_SECRET":"%s"' "$SEP" "$TOKEN" "$WEBHOOK_SECRET"; fi
  printf '}'
} > "$TMP/secrets.json"
chmod 600 "$TMP/secrets.json"
unset KEYS

npx wrangler deploy --secrets-file "$TMP/secrets.json"
rm -f "$TMP/secrets.json"

if [ -n "$TOKEN" ]; then
  curl -fsS "https://api.telegram.org/bot$TOKEN/setWebhook" \
    --data-urlencode "url=https://$HOST/v1/telegram" \
    --data-urlencode "secret_token=$WEBHOOK_SECRET" \
    --data-urlencode 'allowed_updates=["message","callback_query"]' >/dev/null
  curl -fsS "https://api.telegram.org/bot$TOKEN/setMyCommands" \
    --data-urlencode 'commands=[{"command":"stop","description":"Unpair every computer from this account"}]' >/dev/null
  echo "Telegram now sends @$BOT's messages to https://$HOST/v1/telegram."
fi
unset TOKEN WEBHOOK_SECRET

OK=0
for _ in $(seq 1 30); do
  if curl -fsS "https://$HOST/v1/health" 2>/dev/null | grep -q '"web":true'; then OK=1; break; fi
  sleep 2
done
if [ "$OK" = 1 ]; then echo "https://$HOST/v1/health answers, with browser notifications on."; else echo "https://$HOST/v1/health does not answer yet (the certificate can take a few minutes)." >&2; fi

if [ "$FIRST" = 1 ]; then
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const text = fs.readFileSync(file, "utf8");
    const next = text.replace(/(export const OFFICIAL_RELAY = \{ url: "[^"]*", key: )"[^"]*"/, `$1"${process.argv[2]}"`);
    if (next === text) { console.error("OFFICIAL_RELAY not found: pin the key by hand: " + process.argv[2]); process.exit(1); }
    fs.writeFileSync(file, next);
  ' "$ROOT/server/local-phone-relay.ts" "$PUBLIC"
  echo "Relay public key pinned in server/local-phone-relay.ts: $PUBLIC"
  echo "Next: tell Claude it is deployed; it commits the key, builds, and you pair your phone from the console."
fi
