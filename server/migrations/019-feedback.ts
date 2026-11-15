/**
 * Migration 19 — le retour produit, et les trois choses qu'il ne doit pas devenir.
 *
 * ## Ce que la table stocke, et ce qu'elle refuse de stocker
 *
 * Un avis sur le produit : un vote, une catégorie, un commentaire facultatif, et de quoi
 * le relier à une fonctionnalité et à une version. Rien d'autre.
 *
 * Il n'y a **pas** de colonne pour un identifiant d'exécution, un argument d'outil, un
 * prompt ou une charge utile. Un retour est écrit par un humain qui vient de voir un
 * écran ; lui attacher le contexte technique complet reviendrait à recopier des données
 * métier dans une table dont la vocation est d'être lue par l'équipe produit, c'est-à-dire
 * par des gens qui n'ont aucune raison de les voir. `context_ref` existe pour cela : une
 * référence **courte et non sensible**, bornée à 120 caractères par la base, qui désigne
 * un écran ou un objet sans en transporter le contenu.
 *
 * ## Trois contraintes qui ne sont pas des détails
 *
 * **`organization_id` est obligatoire, et c'est la seule clé de lecture.** Un retour
 * appartient au locataire qui l'a écrit. Le tableau de bord interne de l'équipe Oathrion
 * lit à travers une voie distincte, et le §7 du cahier des charges l'exige : « Les données
 * privées d'une organisation ne doivent jamais être exposées à une autre. »
 *
 * **L'unicité `(organization_id, author_user_id, feature, context_ref)`** est le contrôle
 * anti-abus, et il est posé par la BASE plutôt que par l'application. Un compteur
 * applicatif se contourne en ouvrant deux onglets ; une contrainte d'unicité ne se
 * contourne pas. Elle autorise un avis par personne et par endroit — révisable, puisque
 * l'écriture est un `upsert`, jamais une accumulation.
 *
 * **`status` a une valeur par défaut.** Un retour arrive à l'état `received` sans que
 * l'application ait à y penser : un statut nul plus tard dans un tableau de bord est un
 * retour qu'on croit traité et qui ne l'est pas.
 *
 * ## Pourquoi `vote` est un entier et pas un booléen
 *
 * −1, 0, +1. Le zéro est un retour **sans vote** : quelqu'un qui signale un bug n'émet
 * pas un avis, il rapporte un fait. Un booléen aurait forcé à inventer une polarité pour
 * ces cas-là, et la moyenne des votes aurait compté des signalements comme des
 * mécontentements.
 */

import type { Migration, SchemaInspect } from "./types";

export const FEEDBACK_TABLE = "product_feedback";

/*
 * Les catégories viennent du cahier des charges, et elles sont contraintes par la base.
 * Une catégorie libre finit en liste de synonymes — « ui », « UI », « interface » — et
 * le filtrage du tableau de bord cesse de rien vouloir dire au bout de deux mois.
 */
const CATEGORIES =
  "('experience', 'bug', 'missing_feature', 'wrong_result', 'performance', 'security', 'suggestion')";

/*
 * Le cycle de vie du §7.A, « Non retenu » inclus : un retour écarté doit pouvoir l'être
 * explicitement, sinon il reste ouvert pour toujours et le délai de résolution ment.
 */
const STATUSES = "('received', 'triaging', 'planned', 'in_progress', 'resolved', 'declined')";

export const productFeedback: Migration = {
  version: 19,
  name: "feedback",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(FEEDBACK_TABLE)) return [];

    const common = `
         id                TEXT PRIMARY KEY,
         organization_id   TEXT NOT NULL,
         author_user_id    TEXT NOT NULL,
         vote              INTEGER NOT NULL CHECK (vote IN (-1, 0, 1)),
         category          TEXT NOT NULL CHECK (category IN ${CATEGORIES}),
         comment           TEXT,
         feature           TEXT NOT NULL,
         product_version   TEXT NOT NULL,
         context_ref       TEXT,
         status            TEXT NOT NULL DEFAULT 'received' CHECK (status IN ${STATUSES}),
         resolution_note   TEXT`;

    if (schema.dialect === "sqlite") {
      return [
        `CREATE TABLE IF NOT EXISTS ${FEEDBACK_TABLE} (${common},
           created_at      TEXT NOT NULL,
           updated_at      TEXT NOT NULL,
           CHECK (comment IS NULL OR length(comment) <= 4000),
           CHECK (context_ref IS NULL OR length(context_ref) <= 120)
         )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${FEEDBACK_TABLE}_one_per_place
           ON ${FEEDBACK_TABLE} (organization_id, author_user_id, feature, coalesce(context_ref, ''))`,
        `CREATE INDEX IF NOT EXISTS ${FEEDBACK_TABLE}_by_tenant
           ON ${FEEDBACK_TABLE} (organization_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS ${FEEDBACK_TABLE}_by_status
           ON ${FEEDBACK_TABLE} (status, created_at DESC)`,
      ];
    }

    return [
      `CREATE TABLE IF NOT EXISTS ${FEEDBACK_TABLE} (${common},
         created_at      TIMESTAMPTZ NOT NULL,
         updated_at      TIMESTAMPTZ NOT NULL,
         CHECK (comment IS NULL OR length(comment) <= 4000),
         CHECK (context_ref IS NULL OR length(context_ref) <= 120)
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${FEEDBACK_TABLE}_one_per_place
         ON ${FEEDBACK_TABLE} (organization_id, author_user_id, feature, coalesce(context_ref, ''))`,
      `CREATE INDEX IF NOT EXISTS ${FEEDBACK_TABLE}_by_tenant
         ON ${FEEDBACK_TABLE} (organization_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ${FEEDBACK_TABLE}_by_status
         ON ${FEEDBACK_TABLE} (status, created_at DESC)`,
    ];
  },
};
