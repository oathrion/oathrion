/**
 * Migration 20 — le registre des effacements.
 *
 * ## Pourquoi une table SURVIT à la purge
 *
 * Effacer un locataire supprime tout ce qui lui appartient, sa chaîne de reçus comprise.
 * Après quoi l'exploitant ne peut plus rien prouver : ni ce que ce client a fait, ni même
 * qu'il a existé. C'est le résultat voulu — mais un effacement dont il ne reste aucune
 * trace est indiscernable d'une perte de données, et c'est la première question qu'un
 * auditeur pose.
 *
 * Ce registre est la réponse. Il conserve **qu'un effacement a eu lieu**, quand, à la
 * demande de qui, et **combien** de lignes par table. Il ne conserve **rien** de leur
 * contenu : ni nom, ni adresse, ni reçu. Une preuve que la suppression s'est produite
 * n'a pas besoin de ce qui a été supprimé — et s'en souvenir annulerait l'effacement.
 *
 * ## Le piège que cette table évite, et il n'est pas théorique
 *
 * La colonne s'appelle `purged_organization_id`, **pas** `organization_id`.
 *
 * `script/lib/tenant-export.ts` découvre les tables d'un locataire en interrogeant le
 * schéma : toute table portant une colonne `organization_id` en fait partie. La purge
 * emploie la même découverte, pour la même raison — une liste écrite à la main oublie la
 * table suivante. Nommer cette colonne `organization_id` ferait donc de ce registre une
 * table « du locataire », et la purge **effacerait sa propre preuve** dans la même
 * transaction, sans que rien ne le signale.
 *
 * ## `name_key` et pas `name`
 *
 * Le nom normalisé, qui est déjà la clé unique depuis la migration 18, suffit à répondre
 * « cet effacement concernait-il bien ce client ? » à quelqu'un qui connaît déjà le nom.
 * Il ne le divulgue pas à quelqu'un qui l'ignore. La raison sociale complète, elle, est
 * une donnée du client : la garder après l'avoir effacé serait se souvenir de lui.
 */

import type { Migration, SchemaInspect } from "./types";

export const TENANT_ERASURES_TABLE = "tenant_erasures";

export const tenantErasure: Migration = {
  version: 20,
  name: "tenant-erasure",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(TENANT_ERASURES_TABLE)) return [];

    const common = `
         id                      TEXT PRIMARY KEY,
         purged_organization_id  TEXT NOT NULL,
         purged_name_key         TEXT NOT NULL,
         requested_by            TEXT NOT NULL,
         reason                  TEXT NOT NULL,
         /* { "table": nombre } — des comptes, jamais des lignes. */
         row_counts              TEXT NOT NULL,
         schema_version          INTEGER`;

    if (schema.dialect === "sqlite") {
      return [
        `CREATE TABLE IF NOT EXISTS ${TENANT_ERASURES_TABLE} (${common},
           erased_at TEXT NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS ${TENANT_ERASURES_TABLE}_by_org
           ON ${TENANT_ERASURES_TABLE} (purged_organization_id)`,
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS ${TENANT_ERASURES_TABLE} (${common},
         erased_at TIMESTAMPTZ NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS ${TENANT_ERASURES_TABLE}_by_org
         ON ${TENANT_ERASURES_TABLE} (purged_organization_id)`,
    ];
  },
};
