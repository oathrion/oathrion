/**
 * La deuxième organisation de la suite, et son identifiant historique.
 *
 * ## Pourquoi ce fichier existe
 *
 * `server/test/setup.ts` déclare deux credentials préfixés `Rival Corp/`, et 21 fichiers
 * de tests écrivent en dur l'identifiant attendu : `org_rival_corp`. Cette valeur n'était
 * pas arbitraire — c'était le résultat de `organizationIdFromName("Rival Corp")`, la
 * dérivation retirée par la migration 18. Depuis, un locataire créé par son nom reçoit un
 * identifiant OPAQUE, donc `org_rival_corp` n'existe plus et aucun de ces tests ne le
 * trouve.
 *
 * Créer la ligne avec son ancien identifiant, plutôt que réécrire 32 occurrences, a un
 * mérite propre : c'est EXACTEMENT l'état d'un déploiement antérieur à la migration 18 —
 * des organisations dont l'identifiant dérive encore de leur nom, retrouvées par
 * `ensureByName` au démarrage suivant. La suite exerce donc ce chemin de compatibilité à
 * chaque exécution, au lieu de ne jamais le voir.
 *
 * ## Pourquoi PAS dans `setup.ts`
 *
 * Première tentative, et elle était fausse pour deux raisons mesurées :
 *
 *   1. `setup.ts` tourne pour CHAQUE fichier de test. Y importer le store ouvrait la base
 *      et rejouait la chaîne de migrations même pour les fichiers qui n'y touchent pas :
 *      la préparation de la suite est passée de **1,08 s à 77 s**.
 *   2. Pire : quand le plan d'identité est sur PostgreSQL, cet import ouvrait une
 *      connexion dans chaque fichier — y compris ceux qui détruisent leur base jetable à
 *      la fin. `multitenant-authority-postgres.test.ts` l'a fait tomber en plein vol
 *      (`57P01 terminating connection due to administrator command`), une erreur non
 *      gérée qui faisait sortir la suite en 1 **alors que les 2081 tests passaient**.
 *
 * Appelé d'ici, le coût est payé uniquement par les fichiers qui ouvrent déjà la base.
 */

import { organizationStore } from "../repositories/organizations";
import { organizationId, type OrganizationId } from "@shared/tenancy";

/**
 * L'identifiant de la deuxième organisation : la forme **dérivée**, d'avant la migration
 * 18, volontairement conservée. Les tests qui l'écrivent en dur restent justes, et la
 * suite garde un locataire à identifiant hérité.
 */
export const RIVAL_ORGANIZATION_ID: OrganizationId = organizationId("org_rival_corp");

/**
 * Le nom doit correspondre au préfixe des credentials de `setup.ts` au caractère près :
 * c'est par lui que `resolveOrganizations` retrouve cette ligne au lieu d'en créer une
 * seconde avec un identifiant opaque.
 */
export const RIVAL_ORGANIZATION_NAME = "Rival Corp";

/** Idempotent : `ensure` ne touche pas une organisation existante. */
export function ensureRivalOrganization(): OrganizationId {
  organizationStore.ensure(RIVAL_ORGANIZATION_ID, RIVAL_ORGANIZATION_NAME);
  return RIVAL_ORGANIZATION_ID;
}
