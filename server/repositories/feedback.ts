/**
 * Le dépôt des retours produit.
 *
 * ## La règle qui gouverne tout ce fichier
 *
 * **Aucune lecture n'est possible sans nommer l'organisation.** Chaque fonction qui lit
 * prend `organization` en PREMIER paramètre, et chaque requête porte
 * `WHERE organization_id = ?`. Ce n'est pas une politesse : le tableau de bord interne
 * de l'équipe Oathrion lit par une voie séparée (`listForTriage`), et une seule requête
 * non cadrée ici suffirait à faire fuir les retours d'un client chez un autre.
 *
 * ## Pourquoi un `upsert` et pas un `insert`
 *
 * La migration 19 pose une unicité sur `(organisation, auteur, fonctionnalité, contexte)`.
 * Écrire deux fois au même endroit n'ajoute donc pas une ligne : cela **révise** l'avis.
 * C'est le comportement voulu — quelqu'un qui change d'avis corrige le sien, il n'en
 * empile pas un second — et c'est aussi le contrôle anti-abus : cent clics produisent
 * une ligne.
 *
 * Le `status` et la `resolution_note` ne sont PAS écrasés par une révision. Ils
 * appartiennent à l'équipe qui traite, pas à l'auteur : un retour marqué « planifié »
 * ne doit pas repasser à « reçu » parce que son auteur a corrigé une faute de frappe.
 */

import crypto from "node:crypto";
import { rawDb } from "../db";
import { FEEDBACK_TABLE } from "../migrations";

export const FEEDBACK_CATEGORIES = [
  "experience",
  "bug",
  "missing_feature",
  "wrong_result",
  "performance",
  "security",
  "suggestion",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_STATUSES = [
  "received",
  "triaging",
  "planned",
  "in_progress",
  "resolved",
  "declined",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface FeedbackRecord {
  id: string;
  organizationId: string;
  authorUserId: string;
  vote: -1 | 0 | 1;
  category: FeedbackCategory;
  comment: string | null;
  feature: string;
  productVersion: string;
  contextRef: string | null;
  status: FeedbackStatus;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  organization_id: string;
  author_user_id: string;
  vote: number;
  category: string;
  comment: string | null;
  feature: string;
  product_version: string;
  context_ref: string | null;
  status: string;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (row: Row): FeedbackRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  authorUserId: row.author_user_id,
  vote: row.vote as -1 | 0 | 1,
  category: row.category as FeedbackCategory,
  comment: row.comment,
  feature: row.feature,
  productVersion: row.product_version,
  contextRef: row.context_ref,
  status: row.status as FeedbackStatus,
  resolutionNote: row.resolution_note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/*
 * Préparation différée, pour la raison écrite dans `organization-quotas.ts` : préparer au
 * niveau module s'exécuterait pendant l'évaluation de `db.ts`, quand `rawDb` n'existe
 * pas encore.
 */
type Statement = ReturnType<typeof rawDb.prepare<unknown[]>>;
function lazy(sql: string): () => Statement {
  let prepared: Statement | undefined;
  return () => (prepared ??= rawDb.prepare<unknown[]>(sql));
}

const COLUMNS =
  "id, organization_id, author_user_id, vote, category, comment, feature, product_version, context_ref, status, resolution_note, created_at, updated_at";

const upsertStmt = lazy(
  `INSERT INTO ${FEEDBACK_TABLE}
     (${COLUMNS})
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL, ?, ?)
   ON CONFLICT (organization_id, author_user_id, feature, coalesce(context_ref, ''))
   DO UPDATE SET
     vote            = excluded.vote,
     category        = excluded.category,
     comment         = excluded.comment,
     product_version = excluded.product_version,
     updated_at      = excluded.updated_at`,
);

const listForTenantStmt = lazy(
  `SELECT ${COLUMNS} FROM ${FEEDBACK_TABLE}
    WHERE organization_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?`,
);

const oneForTenantStmt = lazy(
  `SELECT ${COLUMNS} FROM ${FEEDBACK_TABLE}
    WHERE organization_id = ? AND id = ?`,
);

const statusStmt = lazy(
  `UPDATE ${FEEDBACK_TABLE}
      SET status = ?, resolution_note = ?, updated_at = ?
    WHERE organization_id = ? AND id = ?`,
);

export interface FeedbackInput {
  organizationId: string;
  authorUserId: string;
  vote: -1 | 0 | 1;
  category: FeedbackCategory;
  comment: string | null;
  feature: string;
  productVersion: string;
  contextRef: string | null;
}

export const feedbackRepository = {
  /**
   * Dépose ou révise un avis. Rend l'enregistrement tel qu'il est APRÈS écriture, relu
   * depuis la base plutôt que reconstruit en mémoire : sur une révision, `created_at` et
   * `status` viennent de la ligne existante, pas de ce qu'on vient d'envoyer.
   */
  record(input: FeedbackInput): FeedbackRecord {
    const now = new Date().toISOString();
    upsertStmt().run(
      `fb_${crypto.randomUUID().replace(/-/g, "")}`,
      input.organizationId,
      input.authorUserId,
      input.vote,
      input.category,
      input.comment,
      input.feature,
      input.productVersion,
      input.contextRef,
      now,
      now,
    );
    const row = rawDb
      .prepare<unknown[]>(
        `SELECT ${COLUMNS} FROM ${FEEDBACK_TABLE}
          WHERE organization_id = ? AND author_user_id = ? AND feature = ?
            AND coalesce(context_ref, '') = coalesce(?, '')`,
      )
      .get(input.organizationId, input.authorUserId, input.feature, input.contextRef) as Row;
    return toRecord(row);
  },

  /** Les retours d'UN locataire. Le seul chemin de lecture offert à un client. */
  listForTenant(organization: string, limit = 100): FeedbackRecord[] {
    return (listForTenantStmt().all(organization, limit) as Row[]).map(toRecord);
  },

  findForTenant(organization: string, id: string): FeedbackRecord | undefined {
    const row = oneForTenantStmt().get(organization, id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  },

  /**
   * Change le statut d'un retour. Cadré au locataire comme tout le reste : un
   * administrateur ne trie que ce qui lui appartient.
   */
  setStatus(
    organization: string,
    id: string,
    status: FeedbackStatus,
    resolutionNote: string | null,
  ): FeedbackRecord | undefined {
    statusStmt().run(status, resolutionNote, new Date().toISOString(), organization, id);
    return feedbackRepository.findForTenant(organization, id);
  },
};
