/**
 * Le client HTTP du kit.
 *
 * Il est délibérément minimal — `fetch`, rien d'autre — pour deux raisons. Un kit de
 * conformité qui dépend d'une bibliothèque cliente juge aussi cette bibliothèque. Et
 * tout tiers qui voudra se conformer doit pouvoir lire ce fichier en entier en une
 * minute pour vérifier qu'aucune indulgence n'y est cachée.
 *
 * Trois propriétés méritent d'être notées :
 *
 *   - **un corps non-JSON n'est pas une exception**. Une implémentation qui répond en
 *     texte brut doit pouvoir être JUGÉE, et donc échouer sur la propriété concernée,
 *     plutôt que faire tomber le kit avec une erreur de parsing ;
 *   - **chaque réponse non-2xx est conservée**, pour le contrôle transversal de C35 ;
 *   - **aucun en-tête n'est ajouté silencieusement** en dehors de ceux que le kit
 *     déclare : un `Authorization` injecté par défaut masquerait C8.
 */

import type { HttpClient, HttpReply } from "./types";

export function createHttpClient(baseUrl: string): HttpClient {
  const errors: HttpReply[] = [];
  const origin = baseUrl.replace(/\/+$/, "");

  return {
    errors,
    async send(method, path, options = {}) {
      const headers: Record<string, string> = {};
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      if (options.json !== undefined) headers["Content-Type"] = "application/json";

      const res = await fetch(`${origin}${path}`, {
        method,
        headers,
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
      });

      const raw = await res.text();
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        // Un tableau est un corps valide (`GET /api/tools`) : on le présente sous une
        // clé plutôt que de le perdre, et sans prétendre que c'est un objet.
        body = Array.isArray(parsed)
          ? { items: parsed }
          : parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {};
      } catch {
        body = {};
      }

      const reply: HttpReply = { status: res.status, body, raw };
      if (res.status < 200 || res.status >= 300) errors.push(reply);
      return reply;
    },
  };
}

/** Le champ `decision` d'une réponse, ou `undefined` si elle n'en porte pas. */
export function decisionOf(reply: HttpReply): string | undefined {
  const value = reply.body.decision;
  return typeof value === "string" ? value : undefined;
}

/** Le `code` d'erreur d'une réponse, ou `undefined`. */
export function codeOf(reply: HttpReply): string | undefined {
  const value = reply.body.code;
  return typeof value === "string" ? value : undefined;
}

/** Vrai pour tout 4xx — la définition de « refus » de SPEC.md § 1.2. */
export function isRefusal(reply: HttpReply): boolean {
  return reply.status >= 400 && reply.status < 500;
}

/**
 * L'égalité différentielle de SPEC.md § 1.3 : même statut ET même code.
 *
 * C'est le cœur du groupe « isolation ». Le kit n'impose ni 404 ni 403 — il impose
 * qu'un objet appartenant à un autre locataire soit INDISCERNABLE d'un objet qui
 * n'existe pas. Les tests du dépôt acceptent `[403, 404, 409]` sans les comparer entre
 * eux ; cette fonction est plus stricte, et c'est voulu.
 */
export function indistinguishable(a: HttpReply, b: HttpReply): boolean {
  return a.status === b.status && codeOf(a) === codeOf(b);
}

export function describe(reply: HttpReply): string {
  const code = codeOf(reply);
  return code ? `${reply.status} ${code}` : String(reply.status);
}
