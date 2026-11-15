/**
 * Migration 26 — la réconciliation se souvient : dernier passage, et écritures vues.
 *
 * La réconciliation (`POST /api/connectors/:id/reconcile`, puis la tâche périodique)
 * relit chez le service ce qui s'est fait depuis la connexion. Deux tables :
 *
 *   · `reconcile_runs` — le DERNIER passage par (organisation, outil) : quand, déclenché
 *     comment, son verdict et ses comptes. Ce que la console affiche sans relancer.
 *   · `reconcile_findings` — chaque écriture vue HORS d'Oathrion (ou portant une marque
 *     inconnue), une seule fois. La clé primaire est le mécanisme d'alerte unique : un
 *     `INSERT … ON CONFLICT DO NOTHING RETURNING` ne rend que ce qui est NOUVEAU, donc deux
 *     instances qui réconcilient en même temps n'alertent qu'une fois.
 *
 * Aucune clé, aucun corps : un titre ou un montant tronqué, un lien, un auteur.
 * Colonne `organization_id` : les lignes partent avec le locataire.
 */

import type { Migration, SchemaInspect } from "./types";

export const RECONCILE_RUNS_TABLE = "reconcile_runs";
export const RECONCILE_FINDINGS_TABLE = "reconcile_findings";

export const reconcileMemory: Migration = {
  version: 26,
  name: "reconcile-memory",
  statements(schema: SchemaInspect): string[] {
    const time = schema.dialect === "sqlite" ? "TEXT" : "TIMESTAMPTZ";
    const statements: string[] = [];
    if (!schema.tableExists(RECONCILE_RUNS_TABLE)) {
      statements.push(`CREATE TABLE IF NOT EXISTS ${RECONCILE_RUNS_TABLE} (
         organization_id TEXT NOT NULL,
         connector_id    TEXT NOT NULL,
         ran_at          ${time} NOT NULL,
         run_trigger     TEXT NOT NULL,
         ok              INTEGER NOT NULL,
         verdict         TEXT NOT NULL,
         since           TEXT NOT NULL DEFAULT '',
         identity        TEXT NOT NULL DEFAULT '',
         scanned         INTEGER NOT NULL DEFAULT 0,
         via_placet      INTEGER NOT NULL DEFAULT 0,
         outside_count   INTEGER NOT NULL DEFAULT 0,
         unknown_count   INTEGER NOT NULL DEFAULT 0,
         others          INTEGER NOT NULL DEFAULT 0,
         truncated       INTEGER NOT NULL DEFAULT 0,
         detail          TEXT NOT NULL DEFAULT '',
         PRIMARY KEY (organization_id, connector_id)
       )`);
    }
    if (!schema.tableExists(RECONCILE_FINDINGS_TABLE)) {
      statements.push(`CREATE TABLE IF NOT EXISTS ${RECONCILE_FINDINGS_TABLE} (
         organization_id TEXT NOT NULL,
         connector_id    TEXT NOT NULL,
         item_id         TEXT NOT NULL,
         category        TEXT NOT NULL,
         kind            TEXT NOT NULL,
         url             TEXT,
         summary         TEXT NOT NULL DEFAULT '',
         actor           TEXT,
         marker          TEXT,
         item_created_at TEXT NOT NULL DEFAULT '',
         first_seen_at   ${time} NOT NULL,
         PRIMARY KEY (organization_id, connector_id, item_id)
       )`);
    }
    return statements;
  },
};
