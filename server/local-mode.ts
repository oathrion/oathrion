/**
 * LE MODE LOCAL — Oathrion sur le poste d'un développeur, pour `oathrion wrap`.
 *
 * ## La règle qu'il ne doit pas affaiblir
 *
 * `database-config.ts` refuse SQLite en production, et le dit : « No environment variable
 * can opt SQLite into production. » La raison est un DÉPLOIEMENT : un fichier local qu'une
 * seconde instance ne peut pas lire, qu'un conteneur éphémère efface. Cette raison ne
 * s'applique pas à un outil qu'une personne lance sur son propre poste, pour elle seule —
 * mais la règle doit rester vraie pour tout ce qui ressemble à un serveur.
 *
 * ## Comment le mode local s'ouvre, et pourquoi pas par l'environnement
 *
 * Il n'existe PAS de variable qui l'active. Il s'active par un point d'entrée distinct,
 * `server/local-entry.ts`, compilé dans son propre fichier (`dist/oathrion-local.cjs`), qui
 * appelle `enterLocalMode()` avant de charger le serveur. Le paquet serveur habituel
 * (`dist/index.cjs`) ne contient pas ce point d'entrée : aucune configuration, aucun
 * en-tête, aucune variable ne peut l'y faire basculer. `local-mode.test.ts` vérifie que
 * `enterLocalMode` n'est appelé que par `local-entry.ts`.
 *
 * ## Ce que le mode local change, et rien d'autre
 *
 *   · SQLite est accepté, dans un fichier sous `~/.oathrion/` ;
 *   · l'écoute est FORCÉE sur la boucle locale : `OATHRION_HOST` vers une autre adresse
 *     est refusé au démarrage, pas ignoré.
 *
 *   · les quotas mesurent sans refuser (`observe`, `server/quotas.ts`) : sur la machine
 *     d'une personne, il n'y a pas d'autre locataire à protéger, et le plafond mensuel
 *     coupait tous ses clients (journal §5.75).
 *
 * Tout le reste du durcissement de production reste actif : clés liées à un agent, cookie
 * protégé, limites de débit, console servie depuis les fichiers compilés.
 */

let local = false;

/** Réservé à `server/local-entry.ts`. */
export function enterLocalMode(): void {
  local = true;
}

export function isLocalMode(): boolean {
  return local;
}
