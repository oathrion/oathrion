/**
 * LA SESSION DE LA CONSOLE DANS UN COOKIE PROTÉGÉ — pour qu'un rechargement de page ne
 * déconnecte plus.
 *
 * ## Le problème, et pourquoi ce n'était pas un oubli
 *
 * La console gardait son jeton de session EN MÉMOIRE seulement (`client/src/lib/auth.tsx`),
 * jamais dans le navigateur : choix de sécurité délibéré. Conséquence : recharger la page
 * déconnectait. L'utilisateur a choisi (27 octobre 2026) un cookie protégé plutôt que
 * `sessionStorage`, qu'un script injecté pourrait lire et emporter.
 *
 * ## Les propriétés du cookie
 *
 *   · `HttpOnly` : AUCUN script de la page ne peut le lire. Un script injecté peut encore
 *     agir dans la page tant qu'elle est ouverte — c'est vrai de toute session —, mais il
 *     ne peut pas emporter le jeton pour s'en servir ailleurs.
 *   · `SameSite=Strict` : le navigateur ne l'envoie jamais sur une requête partie d'un autre
 *     site. C'est la première protection contre la requête forgée (CSRF).
 *   · `Secure` dès que la connexion est en HTTPS (directement, ou derrière un mandataire qui
 *     le dit) ; en HTTP local, il ne pourrait pas être posé autrement.
 *   · `Path=/api` : il n'accompagne que les appels à l'API.
 *   · `Max-Age` = la durée de la session : il disparaît quand elle expire.
 *
 * ## La seconde protection contre la requête forgée
 *
 * Une requête qui MODIFIE (POST, PUT, PATCH, DELETE) et qui n'est authentifiée QUE par ce
 * cookie doit porter l'en-tête `X-Oathrion-Console`. Un autre site ne peut pas poser un
 * en-tête personnalisé sur une requête vers ce domaine sans une autorisation CORS, qui
 * n'existe pas. Deux protections indépendantes : si l'une saute (un navigateur ancien qui
 * ignore `SameSite`), l'autre tient.
 *
 * Une requête qui présente un `Authorization: Bearer …` n'est pas concernée : un autre site
 * ne peut pas le forger, et c'est le chemin des agents, des scripts et du SDK, inchangé.
 */
import type { Request, Response } from "express";

export const SESSION_COOKIE = "oathrion_session";
export const CONSOLE_HEADER = "X-Oathrion-Console";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** La même règle que les autres cookies d'Oathrion (`routes-oidc.ts`, `routes-connectors.ts`). */
export function isSecureRequest(req: Request): boolean {
  return req.protocol === "https" || req.get("x-forwarded-proto") === "https";
}

export function setSessionCookie(req: Request, res: Response, token: string, expiresAt: string): void {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/api", "HttpOnly", "SameSite=Strict", `Max-Age=${String(seconds)}`];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, "Path=/api", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/** Le jeton porté par le cookie de session, ou `null`. */
export function readSessionCookie(req: Request): string | null {
  const header = req.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const raw = value.join("=");
      if (raw === "") return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Vrai si une requête authentifiée par cookie modifie quelque chose sans l'en-tête de la console. */
export function lacksConsoleHeader(req: Request): boolean {
  return UNSAFE_METHODS.has(req.method.toUpperCase()) && (req.get(CONSOLE_HEADER) ?? "") === "";
}
