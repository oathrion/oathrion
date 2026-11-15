/**
 * UN ÉCOUTEUR D'ERREUR PERMANENT SUR CHAQUE CONNEXION D'UN POOL POSTGRESQL.
 *
 * ## La course qu'il ferme
 *
 * `pg-pool` pose son propre écouteur sur une connexion INACTIVE. Quand il la remet à un
 * appelant, il le RETIRE d'abord (`_acquireClient`) ; `pool.query` ne pose le sien
 * qu'ensuite, dans son rappel. Entre les deux, la connexion n'est écoutée par personne.
 * Si PostgreSQL s'arrête à cet instant, son message de fin
 * (`57P01 terminating connection due to administrator command`) arrive sur cette
 * connexion : `pg` émet `error` sans écouteur, Node en fait une exception non attrapée,
 * et le cycle de vie arrête le processus.
 *
 * Trouvé par `verify:faults` (journal §5.32) : 3 passages sur 5 où le processus mourait
 * pendant une coupure de base, reproduit sur la version d'avant le renommage avec la même
 * signature ; un diagnostic a montré un client créé par `BoundPool.query`, sans requête
 * active et sans écouteur, au moment du message fatal. `pg-client-guard.test.ts`
 * construit cet état sur un vrai `pg-pool` : une connexion tout juste remise a ZÉRO
 * écouteur.
 *
 * ## Ce que fait cet écouteur, et ce qu'il ne fait pas
 *
 * Il est posé dès la création de chaque connexion (`pool.on("connect")`) et n'est jamais
 * retiré. Il JOURNALISE l'erreur, rien d'autre : il ne la cache à personne. Une requête en
 * cours reçoit toujours son erreur par son propre chemin, le pool retire toujours la
 * connexion cassée, et une transaction en cours garde son propre écouteur
 * (`server/sql/executor.ts`). Il empêche seulement qu'une erreur que PLUS PERSONNE
 * n'attend arrête le serveur.
 */
import type { Pool } from "pg";

export function guardPoolClients(pool: Pool, label: string): Pool {
  pool.on("connect", (client) => {
    client.on("error", (error: Error) => {
      console.warn(`[${label}] PostgreSQL connection lost (already removed or being removed): ${error.message}`);
    });
  });
  return pool;
}
