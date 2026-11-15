/**
 * Migration 27 — un index pour compter les autorisations CONSOMMÉES du mois.
 *
 * Le quota d'exécutions de la voie directe se compte désormais sur `action_grants`
 * (`consumed_at` dans la période), et non plus sur les reçus. La raison : le reçu n'est
 * écrit qu'APRÈS l'appel au fournisseur, alors que la consommation est l'instant où
 * l'exécution est décidée. Compter les reçus laissait passer, sous concurrence, toutes
 * les exécutions en vol : 1 279 pour un plafond de 600 à 1 024 clients
 * (`verify:load`, journal §5.27).
 *
 * Le comptage se fait à chaque exécution, sous un verrou par locataire : sans cet index,
 * il parcourrait toutes les autorisations de l'organisation, consommées ou non.
 * Index seul : aucune donnée n'est modifiée.
 */

import type { Migration, SchemaInspect } from "./types";
import { ACTION_GRANTS_TABLE } from "./012-action-authority";

export const grantConsumptionIndex: Migration = {
  version: 27,
  name: "grant-consumption-index",
  statements(schema: SchemaInspect): string[] {
    if (!schema.tableExists(ACTION_GRANTS_TABLE)) return [];
    return [
      `CREATE INDEX IF NOT EXISTS idx_action_grants_consumed
         ON ${ACTION_GRANTS_TABLE} (organization_id, consumed_at)`,
    ];
  },
};
