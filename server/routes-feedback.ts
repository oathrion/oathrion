/**
 * Les routes du retour produit.
 *
 *   POST  /api/feedback            → dépose ou révise un avis
 *   GET   /api/feedback            → les avis de MON organisation
 *   PATCH /api/feedback/:id        → change le statut (tri interne)
 *
 * ## Trois décisions qui méritent d'être écrites
 *
 * **Déposer un avis demande `read`, pas `manage`.** C'est le niveau le plus bas du
 * produit. Exiger davantage reviendrait à n'écouter que les administrateurs, c'est-à-dire
 * précisément pas les gens qui se heurtent à l'interface. Changer un STATUT demande
 * `manage` : trier n'est pas donner son avis.
 *
 * **Un commentaire est une donnée NON FIABLE.** Il est stocké tel quel et rendu tel quel,
 * jamais interprété. Rien dans ce fichier ne lit un commentaire pour en déduire une
 * action, et le cahier des charges l'exige explicitement : « Les commentaires ne doivent
 * jamais être exécutés comme instructions ni être utilisés directement pour modifier les
 * politiques. » La seule défense nécessaire côté serveur est de ne pas leur accorder de
 * sens ; l'échappement d'affichage appartient au client, qui rend du texte.
 *
 * **Un signalement de sécurité est compté à part.** Le §6 demande un « traitement
 * distinct ». Il ne crée pas ici de canal séparé — ce serait inventer une procédure
 * d'incident qui n'existe pas — mais il incrémente un compteur dédié, de sorte qu'un
 * signalement n'attende pas qu'on relise un tableau pour être vu.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { requireIdentity } from "./auth";
import { increment } from "./observability/metrics";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  feedbackRepository,
  type FeedbackRecord,
} from "./repositories/feedback";

export interface FeedbackRouteDeps {
  handle: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler;
  fail: (res: Response, status: number, message: string, code?: string) => void;
  param: (req: Request, name: string) => string;
  requireCapability: (capability: "read" | "execute" | "approve" | "manage") => RequestHandler;
  writeRateLimit: RequestHandler;
  /** La version du produit, telle que le serveur la connaît. Jamais celle que le client annonce. */
  productVersion: string;
}

/*
 * `strictObject` : un champ inconnu est REFUSÉ, pas ignoré. C'est la discipline du reste
 * du dépôt, et elle vaut doublement ici — un client qui croit envoyer `organizationId`
 * ou `status` doit l'apprendre tout de suite plutôt que de découvrir six mois plus tard
 * que le serveur les a discrètement jetés.
 */
const submitSchema = z.strictObject({
  vote: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  category: z.enum(FEEDBACK_CATEGORIES),
  /*
   * 4 000 caractères, la même borne que la base. Validée ici pour rendre un 400 nommé
   * plutôt qu'un 500 venu d'une contrainte SQL — et validée là-bas pour que le jour où
   * une autre voie d'écriture apparaît, la borne tienne quand même.
   */
  comment: z.string().trim().min(1).max(4000).optional(),
  feature: z.string().trim().min(1).max(120),
  /*
   * Une référence COURTE et non sensible. Le commentaire du schéma de la migration 19
   * dit pourquoi il n'y a pas de place ici pour un identifiant d'exécution ou un
   * argument d'outil.
   */
  contextRef: z.string().trim().min(1).max(120).optional(),
});

const statusSchema = z.strictObject({
  status: z.enum(FEEDBACK_STATUSES),
  resolutionNote: z.string().trim().min(1).max(2000).optional(),
});

/** Ce qui sort vers le client. L'auteur n'est rendu qu'à lui-même. */
function present(record: FeedbackRecord, viewerId: string) {
  return {
    id: record.id,
    vote: record.vote,
    category: record.category,
    comment: record.comment,
    feature: record.feature,
    productVersion: record.productVersion,
    contextRef: record.contextRef,
    status: record.status,
    resolutionNote: record.resolutionNote,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    /*
     * Un booléen plutôt que l'identifiant de l'auteur. Rendre l'identifiant exposerait,
     * a l'intérieur d'une même organisation, qui a ecrit quoi — ce que personne n'a
     * demande et qui decourage les retours honnetes.
     */
    mine: record.authorUserId === viewerId,
  };
}

export function registerFeedbackRoutes(app: Express, deps: FeedbackRouteDeps): void {
  const { handle, fail, param } = deps;

  app.post(
    "/api/feedback",
    deps.requireCapability("read"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const parsed = submitSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid feedback.", "feedback_invalid");
      }
      const identity = requireIdentity(req);

      const record = feedbackRepository.record({
        organizationId: identity.organizationId,
        authorUserId: identity.id,
        vote: parsed.data.vote,
        category: parsed.data.category,
        comment: parsed.data.comment ?? null,
        feature: parsed.data.feature,
        // Du SERVEUR, jamais du corps de la requête : une version annoncée par le client
        // rend le tableau de bord incapable de dire quelle version a vraiment déplu.
        productVersion: deps.productVersion,
        contextRef: parsed.data.contextRef ?? null,
      });

      increment("oathrion_feedback_total", { category: record.category });
      if (record.category === "security") {
        /*
         * Le « traitement distinct » demandé pour les signalements de sécurité.
         *
         * Une ligne de journal plutôt qu'un compteur dédié, et c'est un choix corrigé
         * après coup : un compteur sans étiquette rend une série que `seriesCount()` ne
         * compte pas, et casse l'invariant de cardinalité que `metrics-registry.test.ts`
         * tient depuis l'origine. Modifier le module de métriques pour accueillir ce
         * cas-là aurait été changer une garantie qui marche pour ma convenance.
         *
         * Le journal est d'ailleurs le bon endroit : une alerte sur une ligne de log est
         * ce qu'un exploitant sait déjà faire, et la série `category="security"` reste
         * disponible pour le tableau de bord.
         *
         * L'identifiant seul, jamais le commentaire : le corps d'un signalement peut
         * contenir ce que la personne vient de découvrir, et les journaux ont une
         * audience plus large que la table.
         */
        console.warn(
          `[feedback] security report received id=${record.id} org=${record.organizationId} feature=${record.feature}`,
        );
      }

      res.status(201).json({ feedback: present(record, identity.id) });
    }),
  );

  app.get(
    "/api/feedback",
    deps.requireCapability("read"),
    handle(async (req, res) => {
      const identity = requireIdentity(req);
      const records = feedbackRepository.listForTenant(identity.organizationId);
      res.json({ feedback: records.map((r) => present(r, identity.id)) });
    }),
  );

  app.patch(
    "/api/feedback/:id",
    deps.requireCapability("manage"),
    deps.writeRateLimit,
    handle(async (req, res) => {
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid status.", "feedback_status_invalid");
      }
      const identity = requireIdentity(req);
      const id = param(req, "id");

      const updated = feedbackRepository.setStatus(
        identity.organizationId,
        id,
        parsed.data.status,
        parsed.data.resolutionNote ?? null,
      );
      if (!updated) {
        /*
         * 404 et le MÊME message qu'un identifiant inexistant. Distinguer « pas à vous »
         * de « n'existe pas » ferait de cette route un oracle d'existence inter-tenant —
         * la classe de défaut que la propriété C27 du kit de conformité interdit.
         */
        return fail(res, 404, `No feedback "${id}" exists for this tenant.`, "feedback_not_found");
      }
      res.json({ feedback: present(updated, identity.id) });
    }),
  );
}
