/**
 * Une base injoignable n'est pas une erreur interne.
 *
 * Relevé en coupant PostgreSQL sous trafic continu (docs/STRESS-TEST-LOG.md) : pendant les
 * ~16 s de la coupure, Oathrion répondait **500 « Internal Server Error »** à toutes les
 * requêtes authentifiées — la même réponse qu'un défaut de code. Le serveur restait
 * fermé (rien n'était autorisé) et repartait seul ; mais un client, un agent ou une alerte
 * ne pouvait pas distinguer « Oathrion a un bogue » de « la base revient dans un instant,
 * réessayez ». La réponse correcte est **503**, avec `Retry-After`.
 *
 * Ce module reconnaît les erreurs qui signifient « la base n'est pas joignable maintenant »,
 * et seulement elles : une contrainte violée, une requête mal formée ou un délai de
 * requête restent des 500. Il ne dit rien de ce qui a eu lieu avant l'erreur — le message
 * renvoyé ne prétend pas que rien n'a été fait.
 */

/** Codes SQLSTATE de PostgreSQL : arrêt, redémarrage, connexion perdue, trop de connexions. */
const UNAVAILABLE_SQLSTATES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (démarrage ou arrêt en cours)
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "53300", // too_many_connections
]);

/*
 * Réseau : seulement `ECONNREFUSED`, et seulement porté par l'erreur ELLE-MÊME — c'est ainsi
 * que `pg` (et le plan d'identité, qui relaie son code) signale une base arrêtée. La chaîne
 * `cause` n'est volontairement PAS suivie : un appel sortant raté (`fetch failed`, cause
 * `ECONNRESET`) vers GitHub ou un webhook n'est pas une panne de base, et le dire tromperait
 * l'exploitant exactement comme la 500 trompait le client.
 */
const UNAVAILABLE_NETWORK_CODES = new Set(["ECONNREFUSED"]);

/** Messages de `pg` et du plan d'identité qui ne portent pas de code. */
const UNAVAILABLE_MESSAGES = [
  /Connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /Client has encountered a connection error/i,
  /server closed the connection unexpectedly/i,
  /the database system is (shutting down|starting up|in recovery mode)/i,
  /the identity plane did not answer within/i,
];

/*
 * Le plan d'identité ne parle qu'à PostgreSQL : une coupure réseau qu'il relaie
 * (`read ECONNRESET`, `EPIPE`…) est donc une coupure de la base, sans ambiguïté possible
 * avec un appel sortant. Relevé : quatre des cinq dernières 500 de l'expérience de coupure.
 */
const IDENTITY_CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);

export function isDatabaseUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  if (UNAVAILABLE_SQLSTATES.has(code) || UNAVAILABLE_NETWORK_CODES.has(code)) return true;
  if (candidate.name === "IdentityDatabaseError" && IDENTITY_CONNECTION_CODES.has(code)) return true;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(message));
}

/** Ce que l'appelant lit. Ne dit pas que rien n'a eu lieu : l'erreur a pu survenir après un effet. */
export const DATABASE_UNAVAILABLE_MESSAGE =
  "Oathrion's database is temporarily unavailable, so this request could not be completed. Retry shortly.";

/** Secondes conseillées avant une nouvelle tentative. */
export const DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;
