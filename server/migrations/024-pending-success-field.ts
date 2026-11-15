/**
 * Migration 24 — la requête garée garde la règle qui dit comment juger sa réussite.
 *
 * ## Le défaut corrigé
 *
 * L'API Web de Slack répond HTTP 200 même quand elle refuse un message, avec
 * `{"ok": false}`. Oathrion jugeait la réussite d'un relais sur le statut HTTP, donc il
 * enregistrait un message rejeté par Slack comme ENVOYÉ. `npm run verify:slack` l'a montré
 * contre le vrai service. Une règle peut désormais déclarer `successField` (« ok » pour
 * Slack), et le relais exige que ce champ vaille `true`.
 *
 * ## Pourquoi il faut une colonne
 *
 * Une requête qui attend une approbation humaine est garée dans `pending_interceptions`,
 * puis relayée des minutes plus tard. Si `successField` ne voyageait pas avec elle, un
 * message Slack approuvé par un humain puis refusé par Slack serait de nouveau enregistré
 * comme envoyé — exactement le défaut corrigé, sur la voie où un humain a pris la peine
 * de regarder.
 *
 * NULL signifie « la règle ne déclarait rien » : le statut HTTP suffit, comme avant. Les
 * lignes déjà garées gardent donc leur comportement d'origine.
 */

import type { Migration, SchemaInspect } from "./types";
import { PENDING_INTERCEPTIONS_TABLE } from "./022-pending-interceptions";

export const PENDING_SUCCESS_FIELD_COLUMN = "success_field";

export const pendingSuccessField: Migration = {
  version: 24,
  name: "pending-success-field",
  statements(schema: SchemaInspect): string[] {
    if (!schema.tableExists(PENDING_INTERCEPTIONS_TABLE)) return [];
    if (schema.columns(PENDING_INTERCEPTIONS_TABLE).has(PENDING_SUCCESS_FIELD_COLUMN)) return [];
    return [`ALTER TABLE ${PENDING_INTERCEPTIONS_TABLE} ADD COLUMN ${PENDING_SUCCESS_FIELD_COLUMN} TEXT`];
  },
};
