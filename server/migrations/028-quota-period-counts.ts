/**
 * Migration 28 — le compteur d'exécutions du mois, par organisation.
 *
 * Le quota d'exécutions se vérifiait en COMPTANT, à chaque exécution et sous le verrou de
 * l'organisation, toutes les exécutions du mois (relais et voie directe). Mesuré sur une
 * base remplie d'un million d'autorisations consommées dans le mois : environ 1 s par
 * comptage (PostgreSQL parcourt la table) — donc, le verrou tenu pendant ce temps, environ
 * une exécution par seconde pour l'organisation (journal §5.34). Les bancs précédents ne
 * le voyaient pas : leurs bases ne contenaient que quelques milliers d'actions.
 *
 * Désormais un compteur par (organisation, compteur, début de période), lu et incrémenté
 * dans la MÊME transaction que l'écriture qu'il compte, sous le même verrou : un coût
 * constant, quel que soit le volume. Il est initialisé paresseusement, la première fois
 * qu'une période est lue, par UN comptage — le seul qui reste, une fois par mois et par
 * organisation (`server/sql/execution-quota.ts`).
 *
 * Table seule : aucune donnée existante n'est modifiée.
 */

import type { Migration, SchemaInspect } from "./types";

export const QUOTA_PERIOD_COUNTS_TABLE = "quota_period_counts";

export const quotaPeriodCounts: Migration = {
  version: 28,
  name: "quota-period-counts",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(QUOTA_PERIOD_COUNTS_TABLE)) return [];
    return [
      `CREATE TABLE IF NOT EXISTS ${QUOTA_PERIOD_COUNTS_TABLE} (
         organization_id TEXT NOT NULL,
         counter         TEXT NOT NULL,
         period_start    TEXT NOT NULL,
         used            INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (organization_id, counter, period_start)
       )`,
    ];
  },
};
