/**
 * `GET /api/metrics` et le compteur de réponses HTTP.
 *
 * ## Montée AVANT `authenticate()`, et pourquoi ce n'est pas un contournement
 *
 * Le dépôt ferme `/api/*` par défaut (`authenticate()` est monté avant toute route) et
 * tient une liste explicite de chemins publics. Cette page n'y entre pas, et ce choix
 * est le point intéressant : la liste `PUBLIC_API_PATHS` documente que chacun de ses
 * membres « ne divulgue rien au-delà de "ce processus tourne" — no version, no tenant,
 * no counts ». Or une page de métriques n'est QUE des comptes. L'y inscrire aurait
 * rendu ce commentaire faux pour un lecteur futur, et c'est le genre de fausseté qui
 * autorise la suivante.
 *
 * Elle a donc son propre portail, qui exige son propre jeton — plus strict que la
 * liste publique, pas plus permissif. Et quand la variable est absente, la route n'est
 * **pas montée du tout** : `/api/metrics` devient alors INDISTINGUABLE de n'importe
 * quelle URL inexistante sous `/api`, et ne confirme donc jamais qu'une page de
 * supervision existe ici.
 *
 * Le premier jet de ce fichier annonçait « répond 404 ». C'était faux, et le banc
 * `verify:obs` l'a montré en recevant 401 : le portail général ferme TOUT `/api/*` qui
 * n'est pas explicitement public, donc un chemin inexistant répond 401 sans credential
 * et 404 avec. C'est exactement la propriété voulue — il n'y a rien de particulier à
 * `/api/metrics` — mais ce n'est pas le statut que j'avais écrit, et le banc vérifie
 * désormais l'INDISTINGUABILITÉ plutôt qu'une constante : comparée à un chemin
 * réellement inexistant, la page absente répond la même chose, authentifié ou non.
 */

import type { Express, NextFunction, Request, Response } from "express";
import { increment, renderDeploymentMetrics, type DeploymentState } from "./metrics";
import { scrapeToken, scrapeTokenMatches } from "./scrape-token";

/**
 * La surface d'un chemin : un ensemble FINI, dérivé du préfixe.
 *
 * Étiqueter par chemin d'URL serait la faute classique — `/api/agents/agt_1234` crée une
 * série par agent, et la mémoire du collecteur suit le nombre d'objets du client. Un
 * préfixe en revanche appartient à un ensemble que ce fichier énumère, donc borné, et il
 * ne divulgue aucun identifiant.
 */
export function surfaceOf(path: string): string {
  if (path === "/api/live" || path === "/api/ready" || path === "/api/health" || path === "/api/metrics") return "probe";
  if (path.startsWith("/api/auth") || path.startsWith("/api/invitations")) return "auth";
  if (path.startsWith("/api/actions")) return "actions";
  if (path.startsWith("/api/mcp")) return "mcp";
  if (path.startsWith("/api/")) return "console";
  return "other";
}

/** `204` → `"2xx"`. Une classe et non un statut : cinq valeurs au lieu de soixante. */
export function statusClass(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

/**
 * Compte chaque réponse. Monté très tôt, et sur `res.on("finish")`.
 *
 * `finish` et non un enrobage de `res.end` : l'événement se déclenche aussi pour une
 * réponse écrite par un gestionnaire d'erreur, par le 404 d'API ou par le fichier
 * statique, c'est-à-dire précisément les chemins qu'un enrobage posé sur une route
 * manquerait. Une réponse interrompue par le client (`close` sans `finish`) n'est pas
 * comptée, ce qui est correct : le serveur n'a rien répondu.
 */
export function countResponses() {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      increment("oathrion_http_responses_total", {
        surface: surfaceOf(req.path),
        class: statusClass(res.statusCode),
      });
    });
    next();
  };
}

export interface MetricsRouteDeps {
  /** L'état que le registre ne connaît pas : lu au moment du scrape. */
  state: () => Promise<DeploymentState>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Monte `/api/metrics` si — et seulement si — un jeton est configuré.
 *
 * Retourne `true` quand la route a été montée, pour que l'appelant puisse le dire dans
 * la bannière sans relire la variable (un second lecteur de la même règle finirait par
 * ne plus dire la même chose qu'elle).
 */
export function registerMetricsRoute(app: Express, deps: MetricsRouteDeps): boolean {
  const expected = scrapeToken(deps.env ?? process.env);
  if (expected === null) return false;

  app.get("/api/metrics", (req: Request, res: Response) => {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!scrapeTokenMatches(presented, expected)) {
      /*
       * 401 et un corps vide. Le corps d'erreur habituel du dépôt nomme la règle
       * violée, ce qui est juste pour un client d'API et faux ici : le lecteur de cette
       * page est un collecteur, qui n'a rien à lire, et un message décrivant la règle
       * du jeton aide surtout qui n'en a pas.
       */
      res.status(401).end();
      return;
    }

    void (async () => {
      const state = await deps.state();
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      /*
       * Jamais mise en cache. Un proxy qui garderait cette réponse trente secondes
       * rendrait des compteurs figés indistinguables d'un trafic nul — soit la pire
       * panne possible pour une supervision, puisqu'elle ressemble au calme.
       */
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(renderDeploymentMetrics(state));
    })();
  });

  return true;
}
