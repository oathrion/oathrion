/**
 * Qui peut lire `/api/metrics`, et la seule définition de cette règle.
 *
 * ## Pourquoi la page est protégée, alors que `/api/live` et `/api/ready` ne le sont pas
 *
 * Parce qu'elle porte des NOMBRES. Le commentaire de `readiness()` dans
 * `server/routes.ts` énonce déjà la règle et la raison : les sondes sont
 * nécessairement sans credential, donc leur corps est délibérément terne — « no counts,
 * since "412 executions" would tell an outsider how busy the tenant is ». Une page de
 * métriques est l'exact contraire d'un corps terne : c'est le volume d'affaires du
 * déploiement, sa charge, et le rythme de ses refus. Elle hérite donc de la règle
 * inverse.
 *
 * ## Trois états, et pas deux
 *
 *   - **variable absente** → la route n'est pas montée, et `/api/metrics` répond
 *     exactement ce que répond n'importe quelle URL inexistante sous `/api` : 401 sans
 *     credential, 404 avec. Rien ne distingue donc la page absente d'un chemin qui
 *     n'a jamais existé, ce qui est le but — un statut qui lui serait propre
 *     confirmerait à qui sonde qu'une page de supervision est là et qu'il suffit d'un
 *     jeton ;
 *   - **variable posée, jeton conforme** → la route est montée et exige
 *     `Authorization: Bearer <jeton>` ;
 *   - **variable posée, jeton trop court** → **refus de démarrer**, en nommant la
 *     variable.
 *
 * Le troisième état est le seul choix discutable, et il est délibéré. Un jeton de huit
 * caractères n'est pas « une protection faible » : c'est une protection qui a l'air
 * d'en être une. L'exploitant qui l'a posé croit sa page fermée, et c'est cette
 * croyance qui est dangereuse — plus que la page ouverte, qu'il sait ouverte. Le dépôt
 * applique déjà ce raisonnement à `OATHRION_SESSION_SECRET` ; il n'y a pas de raison de
 * traiter autrement une page qui décrit tout le trafic.
 *
 * La comparaison est à temps constant. Un jeton de supervision est présenté par une
 * machine, en boucle, depuis le réseau : c'est le cas d'usage même d'une attaque
 * temporelle, et `===` sur une chaîne sort au premier octet qui diffère.
 */

import { timingSafeEqual } from "node:crypto";

export const SCRAPE_TOKEN_VARIABLE = "OATHRION_METRICS_TOKEN";

/**
 * La longueur minimale. 32 caractères, soit la sortie de `openssl rand -hex 16`.
 *
 * Choisie pour être la même consigne que celle que `DEPLOYMENT.md` donne déjà pour les
 * autres secrets, et non un seuil inventé pour cette page : un exploitant qui génère
 * ses secrets d'une seule façon ne se demande pas lequel a quelle règle.
 */
export const MIN_SCRAPE_TOKEN_LENGTH = 32;

/** Le jeton configuré, ou `null` si la page doit rester absente. */
export function scrapeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[SCRAPE_TOKEN_VARIABLE]?.trim();
  return raw === undefined || raw === "" ? null : raw;
}

/**
 * Le problème de configuration, ou `null`. Poussé dans `runtimeConfigProblems`.
 *
 * Ne se déclenche QUE si la variable est posée : ne pas superviser est une décision
 * d'exploitant, pas une erreur, et refuser de démarrer pour une page de métriques
 * absente transformerait un outil d'observation en prérequis de fonctionnement.
 */
export function scrapeTokenProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = scrapeToken(env);
  if (token === null) return null;
  if (token.length < MIN_SCRAPE_TOKEN_LENGTH) {
    return (
      `${SCRAPE_TOKEN_VARIABLE} is ${token.length} characters long, at least ` +
      `${MIN_SCRAPE_TOKEN_LENGTH} are needed. A short token is not weak protection: it is ` +
      `protection in appearance only, and the page it guards describes all of the deployment's traffic. ` +
      `Generate it with \`openssl rand -hex 32\`, or remove the variable — without it, ` +
      `/api/metrics is not mounted at all.`
    );
  }
  /*
   * Un jeton qui est la valeur d'exemple de la documentation est refusé comme s'il
   * était absent de toute règle de longueur : copié depuis DEPLOYMENT.md, il est
   * public, et sa longueur ne le rend pas secret.
   */
  if (/^(changeme|example|votre-jeton|replace-me)/i.test(token)) {
    return (
      `${SCRAPE_TOKEN_VARIABLE} still holds an example value ("${token.slice(0, 12)}…"). ` +
      `A value copied from the documentation is public whatever its length.`
    );
  }
  return null;
}

/** La posture, pour la bannière de démarrage. */
export function describeScrapeToken(env: NodeJS.ProcessEnv = process.env): string {
  return scrapeToken(env) === null
    ? `metrics: page NOT MOUNTED (${SCRAPE_TOKEN_VARIABLE} missing). /api/metrics answers like a nonexistent URL.`
    : `metrics: /api/metrics mounted, token required (${SCRAPE_TOKEN_VARIABLE}).`;
}

/**
 * Le jeton présenté est-il le bon ? Comparaison à temps constant, longueur comprise.
 *
 * `timingSafeEqual` LÈVE quand les longueurs diffèrent, ce qui serait à la fois une
 * fuite de longueur et une exception sur un chemin de requête : on compare donc des
 * empreintes de même taille, pas les chaînes brutes.
 */
export function scrapeTokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Une comparaison factice de même coût, pour ne pas rendre la longueur mesurable.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
