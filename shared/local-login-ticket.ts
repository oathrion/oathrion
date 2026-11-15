/**
 * Le ticket de connexion de la console LOCALE (`oathrion console`).
 *
 * En local, la machine est déjà à la personne : lui faire choisir un mot de passe, puis le
 * lui redemander, n'ajoute aucune sécurité — et l'essai réel du 28 octobre 2026 l'a montré,
 * elle l'oublie (STRESS-TEST-LOG §5.53). `oathrion console` imprime donc un lien qui ouvre
 * une session directement.
 *
 * Le lien porte un ticket signé (HMAC-SHA256) avec le secret de session de l'Oathrion local
 * (`session.secret`, 0600, dans le dossier d'état). Il n'ajoute aucun secret sur le disque :
 * quiconque lit ce fichier pouvait déjà fabriquer une session. Il vaut deux minutes, et le
 * serveur ne l'accepte qu'une fois.
 *
 * Node seulement : la console web ne l'importe pas.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Durée de vie d'un ticket. Le serveur refuse aussi une échéance plus lointaine que celle-ci. */
export const LOCAL_LOGIN_TICKET_MS = 120_000;

const LABEL = "oathrion-local-login";

function signature(secret: string, expiresAt: number, nonce: string): string {
  return createHmac("sha256", secret).update(`${LABEL}.v1.${String(expiresAt)}.${nonce}`).digest("base64url");
}

/** Un ticket neuf : `v1.<échéance en ms>.<nonce>.<signature>`. */
export function mintLocalLoginTicket(secret: string, now = Date.now()): string {
  const expiresAt = now + LOCAL_LOGIN_TICKET_MS;
  const nonce = randomBytes(16).toString("base64url");
  return `v1.${String(expiresAt)}.${nonce}.${signature(secret, expiresAt, nonce)}`;
}

export type TicketCheck = { ok: true; nonce: string; expiresAt: number } | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

/** Vérifie forme, échéance et signature. L'usage unique (le nonce) est à la charge du serveur. */
export function checkLocalLoginTicket(secret: string, ticket: string, now = Date.now()): TicketCheck {
  const parts = typeof ticket === "string" ? ticket.split(".") : [];
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{1,16}$/.test(parts[1]!) || !/^[A-Za-z0-9_-]{22}$/.test(parts[2]!)) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = Number(parts[1]);
  const nonce = parts[2]!;
  if (expiresAt <= now || expiresAt - now > LOCAL_LOGIN_TICKET_MS) return { ok: false, reason: "expired" };
  const expected = Buffer.from(signature(secret, expiresAt, nonce));
  const given = Buffer.from(parts[3]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true, nonce, expiresAt };
}
