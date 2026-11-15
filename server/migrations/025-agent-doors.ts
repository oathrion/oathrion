/**
 * Migration 25 — les « portes » de chaque agent : l'a-t-on vérifié sans autre route ?
 *
 * ## Ce que la table garde
 *
 * Quand un agent existant est branché sur Oathrion, la clé qu'il détenait pour chaque
 * service doit être morte, sinon il garde une seconde route (`docs/FEUILLE-DE-ROUTE-AGENTS.md`
 * §1). Une ligne par (agent, outil) : ce que la personne a DÉCLARÉ (« il n'en avait pas »,
 * « je l'ai révoquée »), et ce que le SERVICE a répondu quand l'ancienne clé lui a été
 * présentée (morte, vivante, inconnu), avec la date. Jamais la clé elle-même.
 *
 * ## Pourquoi une table à part, et pas une colonne de `agents`
 *
 * La route qui modifie un agent accepte ses champs du client. Une colonne là ferait du
 * « vérifié morte » une valeur qu'un client pourrait écrire. Ici, `check_state` n'est
 * écrit QUE par la route de vérification, à partir de la réponse du service — et la
 * route de déclaration ne peut pas le poser.
 *
 * ## La colonne s'appelle `organization_id`
 *
 * Comme le coffre de credentials : ces lignes appartiennent au locataire et partent avec
 * lui (`script/lib/tenant-purge.ts` les trouve par ce nom de colonne).
 */

import type { Migration, SchemaInspect } from "./types";

export const AGENT_DOORS_TABLE = "agent_doors";

export const agentDoors: Migration = {
  version: 25,
  name: "agent-doors",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(AGENT_DOORS_TABLE)) return [];
    const time = schema.dialect === "sqlite" ? "TEXT" : "TIMESTAMPTZ";
    return [
      `CREATE TABLE IF NOT EXISTS ${AGENT_DOORS_TABLE} (
         organization_id TEXT NOT NULL,
         agent_id        TEXT NOT NULL,
         connector_id    TEXT NOT NULL,
         declared        TEXT NOT NULL,
         declared_by     TEXT NOT NULL,
         declared_at     ${time} NOT NULL,
         check_state     TEXT,
         check_detail    TEXT NOT NULL DEFAULT '',
         checked_by      TEXT,
         checked_at      ${time},
         PRIMARY KEY (organization_id, agent_id, connector_id)
       )`,
    ];
  },
};
