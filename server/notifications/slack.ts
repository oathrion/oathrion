/**
 * Slack : la demande d'approbation arrive AVEC SES BOUTONS.
 *
 * ## Le défaut que ce fichier ferme
 *
 * `OATHRION_WEBHOOK_URL` pouvait déjà pointer sur un webhook entrant Slack — un webhook
 * entrant est une URL HTTP — donc l'approbation ARRIVAIT dans Slack. Mais sous la forme
 * d'un JSON brut, sans bouton : l'approbateur lisait la notification dans Slack et devait
 * aller l'approuver dans la console. Deux outils pour un geste, et le geste en question
 * est celui qui bloque une action d'agent en production.
 *
 * Ce canal poste un message Block Kit avec « Approuver » et « Refuser », et
 * `server/routes-slack.ts` reçoit le clic.
 *
 * ## CE QUI N'EST PAS DANS LE MESSAGE, ET POURQUOI
 *
 * Un message Slack est lu par tout le canal, archivé par Slack, indexé par sa recherche,
 * et souvent répliqué dans des intégrations tierces. Il porte donc ce qui permet de
 * DÉCIDER — l'agent, le verbe, la cible, le montant évalué, la politique, le risque — et
 * rien de plus :
 *
 *   · aucun credential, évidemment ;
 *   · aucun corps de requête, aucune réponse de fournisseur ;
 *   · aucun identifiant interne autre que celui de l'approbation, qui est un UUID déjà
 *     inutile à qui ne peut pas signer un clic.
 *
 * La trace complète reste dans Oathrion. Slack est une sonnette, pas un journal.
 *
 * ## Le canal est étroit, délibérément
 *
 * Il ne traite que `approval.requested`. Un canal Slack qui recevrait aussi chaque action
 * bloquée deviendrait un flux que personne ne lit — et le jour où une approbation compte,
 * elle serait noyée. Les autres événements restent sur le webhook générique.
 */

import type { DeliveryResult, NotificationChannel, NotificationEvent, NotificationEventType } from "./types";
import { sendGuarded } from "./webhook-transport";
import { assertSafeWebhookUrl } from "./webhook-url";

export const SLACK_CHANNEL_ID = "slack";

/** Les identifiants des deux boutons, lus par `routes-slack.ts`. */
export const SLACK_APPROVE_ACTION = "placet_approve";
export const SLACK_REJECT_ACTION = "oathrion_reject";

export interface SlackChannelOptions {
  url: string;
  timeoutMs?: number;
  allowPrivate?: boolean;
  /**
   * `false` : PRÉVENIR seulement, sans boutons Approuver/Refuser. C'est le cas d'`oathrion wrap`
   * sur la machine de la personne : Slack ne peut pas rappeler un serveur qui n'écoute que sur
   * 127.0.0.1, et un bouton qui ne peut rien faire serait pire que pas de bouton.
   */
  buttons?: boolean;
  /** Où décider, quand il n'y a pas de boutons. */
  decideHint?: string;
}

/**
 * Un bloc de texte Slack, borné.
 *
 * Slack refuse un bloc de plus de 3 000 caractères, et un refus de Slack sur un message
 * d'approbation serait une approbation qui n'arrive jamais. On tronque donc nous-mêmes,
 * en le disant, plutôt que de laisser le fournisseur refuser l'ensemble.
 */
function section(text: string): Record<string, unknown> {
  const body = text.length > 2_800 ? `${text.slice(0, 2_800)}\n_(truncated)_` : text;
  return { type: "section", text: { type: "mrkdwn", text: body } };
}

/**
 * Neutralise la syntaxe Slack dans une valeur venue d'ailleurs.
 *
 * Le nom d'un agent, une cible, un nom de politique : tout cela est écrit par un
 * utilisateur d'Oathrion. Sans échappement, une cible nommée `<!channel>` notifierait tout
 * l'espace de travail à chaque demande d'approbation, et un `<https://…|cliquez ici>`
 * fabriquerait un lien crédible dans un message qui a l'air de venir d'Oathrion.
 *
 * Les trois caractères que Slack traite comme de la structure sont `&`, `<` et `>`, dans
 * cet ordre — `&` d'abord, sinon on échapperait les séquences qu'on vient d'écrire.
 */
function escapeSlack(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export class SlackChannel implements NotificationChannel {
  readonly id = SLACK_CHANNEL_ID;
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly allowPrivate: boolean;
  private readonly buttons: boolean;
  private readonly decideHint: string;

  constructor(options: SlackChannelOptions) {
    /*
     * Validé à la CONSTRUCTION, par la même fonction que le webhook générique : une URL
     * de webhook Slack est une URL configurable vers laquelle Oathrion enverra le détail
     * d'actions d'agents. La laisser pointer sur un voisin RFC1918 serait un SSRF avec du
     * contenu choisi.
     */
    assertSafeWebhookUrl(options.url, { allowPrivate: options.allowPrivate === true });
    this.url = new URL(options.url);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.allowPrivate = options.allowPrivate === true;
    this.buttons = options.buttons !== false;
    this.decideHint = options.decideHint ?? "To be decided in the console.";
  }

  handles(type: NotificationEventType): boolean {
    return type === "approval.requested" || type === "reconciliation.alert" || type === "receipt.gap";
  }

  async deliver(event: NotificationEvent): Promise<DeliveryResult> {
    const at = new Date().toISOString();

    /*
     * Une alerte de réconciliation n'a rien à approuver : un titre, la liste des écritures
     * vues hors d'Oathrion (avec leurs liens), et l'endroit où agir. Pas de bouton.
     */
    if (event.type === "reconciliation.alert") {
      return this.post(event, at, [
        section(`:warning: *${escapeSlack(event.title)}*`),
        section(escapeSlack(event.summary)),
        section("_A key or direct access is still open. Handle it in the console: Connectors, then the page of the agent concerned._"),
      ]);
    }

    if (event.type === "receipt.gap") {
      return this.post(event, at, [
        section(`:rotating_light: *${escapeSlack(event.title)}*`),
        section(escapeSlack(event.summary)),
        section("_The action may have happened at the provider without a receipt. Reconcile it on their side; the full list is in the receipt verification (`GET /api/actions/receipts/verify`)._"),
      ]);
    }

    /*
     * Pas d'approbation, pas de boutons. Un `approval.requested` sans identifiant
     * d'approbation ne devrait pas exister, mais afficher deux boutons qui ne peuvent
     * rien résoudre serait pire que de n'en afficher aucun : un approbateur cliquerait et
     * croirait avoir agi.
     */
    const blocks: Record<string, unknown>[] = [
      section(`*${escapeSlack(event.title)}*`),
      section(
        [
          `*Agent* ${escapeSlack(event.agentName)} (\`${escapeSlack(event.agentId)}\`)`,
          `*Risk* ${escapeSlack(event.risk)}`,
          event.policyName ? `*Policy* ${escapeSlack(event.policyName)}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      ),
      section(escapeSlack(event.summary)),
    ];

    if (event.approvalId && !this.buttons) {
      blocks.push(section(`_${escapeSlack(this.decideHint)}_`));
    } else if (event.approvalId) {
      blocks.push({
        type: "actions",
        /*
         * `block_id` porte l'identifiant d'approbation EN PLUS de la valeur des boutons.
         * Slack renvoie les deux, et les comparer côté réception empêche un message
         * fabriqué de mélanger le bouton d'une approbation avec l'identifiant d'une autre.
         */
        block_id: `placet_approval:${event.approvalId}`,
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            action_id: SLACK_APPROVE_ACTION,
            value: event.approvalId,
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Deny" },
            action_id: SLACK_REJECT_ACTION,
            value: event.approvalId,
          },
        ],
      });
    } else {
      blocks.push(section("_No approval ID: handle it in the console._"));
    }

    return this.post(event, at, blocks);
  }

  private async post(event: NotificationEvent, at: string, blocks: Record<string, unknown>[]): Promise<DeliveryResult> {
    const body = JSON.stringify({
      /* Le texte simple est le repli des notifications mobiles et des clients anciens. */
      text: event.title,
      blocks,
    });

    try {
      const reply = await sendGuarded({
        url: this.url,
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        timeoutMs: this.timeoutMs,
        allowPrivate: this.allowPrivate,
      });
      return {
        channelId: this.id,
        eventId: event.id,
        at,
        ok: reply.ok,
        detail: `HTTP ${String(reply.status)}`,
      };
    } catch (error) {
      /*
       * Le message de transport, jamais l'URL : un webhook entrant Slack porte son secret
       * DANS son chemin, et le journaliser le publierait.
       */
      return {
        channelId: this.id,
        eventId: event.id,
        at,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
