/**
 * LE CLIC SLACK, ET TOUT CE QU'IL FAUT PROUVER AVANT DE LE CROIRE.
 *
 * ## Ce que cette route est
 *
 * Le seul point d'entrée d'Oathrion qui n'est PAS authentifié par un credential Oathrion.
 * C'est Slack qui appelle, et Slack ne connaît aucune clé d'Oathrion. Une route publique,
 * donc, qui relâche des actions d'agents — et dont la sécurité tient entièrement aux
 * quatre contrôles ci-dessous, dans cet ordre.
 *
 *   1. **La signature Slack**, sur le corps BRUT (`slack-signature.ts`). Elle prouve que
 *      l'appel vient de notre application Slack. Rien de plus.
 *   2. **La fraîcheur**, cinq minutes. Sans elle, une requête signée capturée une fois
 *      reste rejouable pour toujours — et rejouer une approbation relâche une action
 *      autant de fois qu'on veut.
 *   3. **LA CORRESPONDANCE NOMINATIVE.** Une signature valide ne dit rien de la personne
 *      qui a cliqué : un espace de travail Slack contient toute l'entreprise. Seuls les
 *      identifiants Slack déclarés dans `OATHRION_SLACK_APPROVERS` sont écoutés.
 *   4. **LA CAPACITÉ `approve`**, vérifiée sur le rôle de l'utilisateur de console
 *      correspondant. La liste Slack donne une IDENTITÉ ; elle ne donne pas un DROIT.
 *      Sans ce quatrième contrôle, écrire un identifiant Slack dans une variable
 *      d'environnement accorderait un pouvoir que l'écran des rôles ne montre pas.
 *
 * ## LA RÉSOLUTION PASSE PAR LA PASSERELLE, PAS À CÔTÉ
 *
 * `gateway.resolveApproval` — exactement la méthode que la route de console appelle. Ce
 * n'est pas une préférence de style : c'est elle qui relâche l'action retenue EXACTEMENT
 * UNE FOIS, qui n'appelle aucun outil sur un refus, et qui écrit la trace d'audit. Une
 * résolution écrite ici aurait été un second chemin vers l'effet, c'est-à-dire la chose
 * que tout ce dépôt est construit pour ne pas avoir.
 *
 * ## CE QUE L'AUDIT ENREGISTRE
 *
 * `resolvedBy` porte les DEUX identités : l'utilisateur de console et l'identifiant
 * Slack. Un auditeur qui lit « approuvé par directrice@acme.com » sans savoir que le
 * geste est venu d'un canal Slack ne pourrait pas reconstituer ce qui s'est passé, et le
 * canal fait partie du fait.
 */

import type { Express, Request, RequestHandler, Response } from "express";

import { can } from "@shared/roles";
import type { OrganizationId } from "@shared/tenancy";

import { userStore } from "./repositories/users";
import {
  parseSlackApprovers,
  verifySlackRequest,
  type SlackApprover,
} from "./notifications/slack-signature";
import { SLACK_APPROVE_ACTION, SLACK_REJECT_ACTION } from "./notifications/slack";
import type { AgentGateway } from "./gateway/agent-gateway";

export interface SlackRouteDeps {
  handle: (fn: (req: Request, res: Response) => Promise<unknown>) => RequestHandler;
  approvalRateLimit: RequestHandler;
  /** La portée d'un locataire, par la même fonction que toutes les autres routes. */
  scopeFor: (organizationId: OrganizationId) => { gateway: AgentGateway };
}

/**
 * Ce que Slack reçoit en cas de refus.
 *
 * TOUJOURS LE MÊME TEXTE, et toujours un 200. Deux raisons :
 *
 *   · Slack affiche le corps d'une réponse 200 à la personne qui a cliqué ; un 401 ne
 *     lui montre qu'une erreur générique, donc elle ne saurait pas quoi faire.
 *   · Distinguer « signature fausse » de « vous n'êtes pas dans la liste » dirait à qui
 *     sonde s'il a trouvé le bon format de requête. Le motif précis va dans les journaux
 *     du serveur, pour l'exploitant.
 */
const REFUSAL = {
  response_type: "ephemeral",
  replace_original: false,
  text:
    "Oathrion did not take this click into account. If you need to approve this action, " +
    "do it from the console — and report this message to your operator.",
} as const;

/** La réponse éphémère rendue à l'auteur du clic. */
function ephemeral(text: string): Record<string, unknown> {
  return { response_type: "ephemeral", replace_original: false, text };
}

/**
 * L'utilisateur de console derrière un identifiant Slack, et son organisation.
 *
 * Rend `null` avec un motif plutôt qu'une exception : chaque refus se journalise de la
 * même façon, et aucun ne doit changer ce que l'appelant voit.
 */
function resolveApprover(approver: SlackApprover): {
  organizationId: OrganizationId;
  name: string;
  reason: null;
} | { organizationId: null; name: null; reason: string } {
  const user = userStore.findByEmail(approver.email);
  if (!user) {
    return { organizationId: null, name: null, reason: `no console user for ${approver.email}` };
  }
  if (user.status !== "active") {
    return { organizationId: null, name: null, reason: `the user ${approver.email} is suspended` };
  }

  const memberships = userStore.membershipsOf(user.id);
  if (memberships.length === 0) {
    return { organizationId: null, name: null, reason: `${approver.email} belongs to no organization` };
  }
  if (memberships.length > 1) {
    /*
     * UNE LIMITE ASSUMÉE, et refusée plutôt que devinée.
     *
     * Un clic Slack ne dit pas pour quelle organisation la personne agit. Choisir la
     * première appartenance ferait résoudre l'approbation d'un locataire par un geste
     * destiné à un autre — la pire issue possible sur un plan de contrôle multi-locataire.
     * Pour ces utilisateurs, l'approbation se fait dans la console, où le locataire est
     * porté par la session.
     */
    return {
      organizationId: null,
      name: null,
      reason:
        `${approver.email} belongs to ${String(memberships.length)} organizations; ` +
        `approval through Slack requires a single membership`,
    };
  }

  const membership = memberships[0]!;
  if (!can(membership.role, "approve")) {
    /*
     * LA LISTE SLACK DONNE UNE IDENTITÉ, PAS UN DROIT. Sans ce contrôle, ajouter un
     * identifiant Slack dans une variable d'environnement accorderait la capacité
     * d'approbation à quelqu'un dont l'écran des rôles dit le contraire.
     */
    return {
      organizationId: null,
      name: null,
      reason: `${approver.email} has the role "${membership.role}", which lacks the approve capability`,
    };
  }

  return { organizationId: membership.organizationId, name: user.name || user.email, reason: null };
}

interface SlackAction {
  action_id?: unknown;
  value?: unknown;
  block_id?: unknown;
}

export function registerSlackRoutes(app: Express, deps: SlackRouteDeps): void {
  const { handle } = deps;

  app.post(
    "/api/slack/interactions",
    /*
     * Le même limiteur que les approbations de la console. Une route publique sans
     * limiteur est une invitation à forcer des signatures.
     */
    deps.approvalRateLimit,
    handle(async (req, res) => {
      const signingSecret = process.env.OATHRION_SLACK_SIGNING_SECRET?.trim() ?? "";
      if (signingSecret === "") {
        /*
         * 404 et non 403 : quand Slack n'est pas configuré, cette fonctionnalité n'existe
         * pas. Un 403 confirmerait l'existence du point d'entrée à qui le cherche.
         */
        return res.status(404).json({ error: "Not found" });
      }

      const verdict = verifySlackRequest({
        signingSecret,
        signature: req.get("x-slack-signature") ?? undefined,
        timestamp: req.get("x-slack-request-timestamp") ?? undefined,
        /*
         * LE CORPS BRUT, capturé par le `verify` des analyseurs de `server/index.ts`.
         * La signature porte sur ce que Slack a envoyé ; la recalculer sur un corps
         * ré-encodé ne correspondrait jamais.
         */
        rawBody: (req as unknown as { rawBody?: Buffer }).rawBody?.toString("utf8"),
      });
      if (!verdict.ok) {
        console.warn(`[slack] click refused: ${verdict.reason}`);
        return res.status(200).json(REFUSAL);
      }

      /* Slack envoie `payload=<json>` en form-encoded. */
      const rawPayload = (req.body as Record<string, unknown> | undefined)?.payload;
      if (typeof rawPayload !== "string") {
        console.warn("[slack] click refused: no `payload` field");
        return res.status(200).json(REFUSAL);
      }
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawPayload);
        if (typeof parsed !== "object" || parsed === null) throw new Error("payload is not an object");
        payload = parsed as Record<string, unknown>;
      } catch {
        console.warn("[slack] click refused: unreadable `payload`");
        return res.status(200).json(REFUSAL);
      }

      const slackUser = (payload.user as Record<string, unknown> | undefined)?.id;
      const actions = Array.isArray(payload.actions) ? (payload.actions as SlackAction[]) : [];
      const action = actions[0];
      if (typeof slackUser !== "string" || !action) {
        console.warn("[slack] click refused: neither user nor action in the payload");
        return res.status(200).json(REFUSAL);
      }

      const actionId = typeof action.action_id === "string" ? action.action_id : "";
      const status =
        actionId === SLACK_APPROVE_ACTION
          ? ("approved" as const)
          : actionId === SLACK_REJECT_ACTION
            ? ("rejected" as const)
            : null;
      if (status === null) {
        /* Un autre bouton du même message — Slack en envoie pour ses propres éléments. */
        console.warn(`[slack] click ignored: unknown action "${actionId}"`);
        return res.status(200).json(REFUSAL);
      }

      const approvalId = typeof action.value === "string" ? action.value.trim() : "";
      if (approvalId === "") {
        console.warn("[slack] click refused: no approval ID");
        return res.status(200).json(REFUSAL);
      }

      /*
       * L'identifiant d'approbation est porté DEUX FOIS par le message qu'Oathrion a posté
       * — dans la valeur du bouton et dans le `block_id`. On exige qu'ils concordent :
       * un message fabriqué qui mélangerait le bouton d'une approbation avec le bloc
       * d'une autre est refusé.
       */
      const blockId = typeof action.block_id === "string" ? action.block_id : "";
      if (blockId !== "" && blockId !== `placet_approval:${approvalId}`) {
        console.warn("[slack] click refused: the block and the button do not point to the same approval");
        return res.status(200).json(REFUSAL);
      }

      const approvers = parseSlackApprovers(process.env.OATHRION_SLACK_APPROVERS);
      const approver = approvers.get(slackUser);
      if (!approver) {
        /*
         * Signature valide, personne inconnue. C'est le refus qui compte le plus : il
         * sépare « l'appel vient bien de notre application Slack » de « cette personne a
         * le droit d'approuver ».
         */
        console.warn(`[slack] click refused: the Slack user ${slackUser} is not declared as an approver`);
        return res.status(200).json(REFUSAL);
      }

      const resolved = resolveApprover(approver);
      if (resolved.organizationId === null) {
        console.warn(`[slack] click refused: ${resolved.reason}`);
        return res.status(200).json(REFUSAL);
      }

      /*
       * LES DEUX IDENTITÉS DANS LA TRACE. Le canal fait partie du fait : un auditeur qui
       * lit « approuvé par directrice@acme.com » sans savoir que le geste est venu de
       * Slack ne peut pas reconstituer ce qui s'est passé.
       */
      const resolvedBy = `${resolved.name} (Slack ${slackUser})`;

      const outcome = await deps
        .scopeFor(resolved.organizationId)
        .gateway.resolveApproval(approvalId, status, resolvedBy);

      if (!outcome?.approval) {
        /*
         * Introuvable DANS CETTE ORGANISATION. Un approbateur d'un locataire ne peut pas
         * résoudre l'approbation d'un autre, et il ne doit pas non plus apprendre qu'elle
         * existe : la réponse est la même que pour un identifiant inventé.
         */
        console.warn(`[slack] approval ${approvalId} not found for ${String(resolved.organizationId)}`);
        return res.status(200).json(ephemeral("This request no longer exists, or it belongs to another organization."));
      }

      if (outcome.approval.expired === true) {
        return res.status(200).json(
          ephemeral(
            "The approval window is closed: NO action was released. " +
              "A new request must be issued.",
          ),
        );
      }

      if (!outcome.approval.changed) {
        /*
         * Déjà résolue — deux clics, ou deux approbateurs. Idempotent par construction :
         * `resolveApproval` ne relâche l'action que sur la PREMIÈRE résolution, et le dire
         * évite qu'un approbateur croie avoir agi deux fois.
         */
        return res.status(200).json(
          ephemeral(
            `This request was already ${outcome.approval.approval.status === "approved" ? "approved" : "denied"}.`,
          ),
        );
      }

      return res.status(200).json(
        ephemeral(
          status === "approved"
            ? `Approved. ${outcome.executed ? "The action was released." : "No tool was called."}`
            : "Denied. No action was released.",
        ),
      );
    }),
  );
}
