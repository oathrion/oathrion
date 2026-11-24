/**
 * `npm run keys` : tire, sur CETTE machine, les secrets du relais. Rien n'est écrit : ils
 * s'affichent une fois, à coller avec `wrangler secret put` (ou dans l'environnement de la
 * machine). La clé publique s'épingle dans le pivot (`server/local-phone-relay.ts`).
 */
import { b64u, randomId } from "../src/core.ts";

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const pkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
/* La clé VAPID (P-256) : elle signe les envois aux services de notifications des navigateurs. */
const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const vapidPkcs8 = b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", vapid.privateKey)));

process.stdout.write(
  [
    `RELAY_SIGNING_KEY=${pkcs8}`,
    `TELEGRAM_WEBHOOK_SECRET=${randomId(32)}`,
    `RELAY_REVOKE_SALT=${randomId(32)}`,
    `VAPID_PRIVATE_KEY=${vapidPkcs8}`,
    "",
    `Public key, to pin in server/local-phone-relay.ts (OFFICIAL_RELAY.key): ${publicKey}`,
    "Keep the secrets out of every file of the repository.",
    "",
  ].join("\n"),
);
