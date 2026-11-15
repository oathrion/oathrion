/**
 * Les liens « Décider » des notifications qui ne rappellent pas Oathrion : sous Windows, le
 * bouton d'une notification n'appelle pas le pivot, il ouvre une ADRESSE. Un lien de
 * connexion à la console fabriqué à l'avance expirerait en deux minutes, bien avant qu'une
 * personne revenue à son bureau ne clique.
 *
 * Le pivot donne donc à la notification une adresse à usage unique,
 * `/api/local/decider?n=<jeton>`, valable quinze minutes et gardée en mémoire seulement.
 * Le clic l'échange contre un lien de connexion NEUF (`server/routes.ts`). Le jeton ne passe
 * jamais par l'agent : seul le pivot l'émet, dans la notification qu'il affiche lui-même.
 */
import { randomBytes } from "node:crypto";

const VALID_MS = 15 * 60_000;
const links = new Map<string, number>();

/** Un jeton neuf, à usage unique, valable quinze minutes. */
export function mintDecideToken(now = Date.now()): string {
  for (const [token, expires] of links) if (expires <= now) links.delete(token);
  const token = randomBytes(24).toString("base64url");
  links.set(token, now + VALID_MS);
  return token;
}

/** Vrai une seule fois, et seulement avant l'échéance. */
export function claimDecideToken(token: string, now = Date.now()): boolean {
  const expires = links.get(token);
  links.delete(token);
  return expires !== undefined && expires > now;
}
