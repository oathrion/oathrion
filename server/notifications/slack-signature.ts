/**
 * LA SEULE CHOSE QUI AUTORISE UN CLIC SLACK.
 *
 * ## Pourquoi ce fichier est le point le plus sensible du produit
 *
 * Toutes les autres routes d'Oathrion sont authentifiées par un credential Oathrion : une
 * clé d'agent, une session de console. Le point d'entrée des interactions Slack ne peut
 * pas l'être — c'est SLACK qui appelle, et Slack ne connaît aucun credential Oathrion.
 *
 * Donc : si cette vérification est fausse, **n'importe qui sur Internet peut approuver
 * n'importe quelle action d'agent** en envoyant un POST. C'est la définition d'un
 * contournement total du plan de contrôle, par la porte qui sert à le faire respecter.
 *
 * ## Les trois propriétés, et ce qu'il arrive si l'une manque
 *
 *  1. **La signature.** HMAC-SHA256 de `v0:<horodatage>:<corps brut>` avec le secret de
 *     signature de l'application Slack. Sans elle, le point d'entrée est ouvert.
 *
 *  2. **LE CORPS BRUT, octet pour octet.** La signature porte sur ce que Slack a envoyé,
 *     pas sur ce qu'un analyseur en a reconstruit. Re-sérialiser le corps analysé donne
 *     une chaîne différente — ordre des clés, encodage des espaces — donc une signature
 *     qui ne correspond jamais, et la tentation de « simplifier » la vérification.
 *     `server/index.ts` capture déjà `rawBody` pour le pare-feu ; c'est la même capture.
 *
 *  3. **LA FRAÎCHEUR.** Un horodatage vieux de plus de cinq minutes est refusé. Sans ce
 *     contrôle, une requête signée capturée une fois — dans un journal de proxy, dans un
 *     outil de capture, dans l'historique d'un terminal — reste rejouable pour toujours.
 *     Et le rejeu d'une approbation est précisément l'attaque qui compte : elle relâche
 *     une action que quelqu'un avait déjà approuvée, autant de fois qu'on veut.
 *
 * ## La comparaison est à temps constant
 *
 * `timingSafeEqual`, et une égalité de longueur vérifiée avant — `timingSafeEqual` lève
 * sur des longueurs différentes, et une exception serait un canal auxiliaire aussi
 * bavard que la comparaison qu'on évite.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** La fenêtre de rejeu. Celle que Slack recommande, et elle est déjà large. */
export const SLACK_MAX_SKEW_MS = 300_000;

export type SlackVerdict =
  | { ok: true }
  | {
      ok: false;
      /**
       * Un motif de journal, JAMAIS rendu à l'appelant tel quel.
       *
       * Distinguer « signature absente » de « signature fausse » dans la réponse HTTP
       * dirait à qui sonde s'il a trouvé le bon format. La réponse est donc toujours la
       * même ; ce champ existe pour l'exploitant, qui lit ses journaux.
       */
      reason:
        | "missing_signature"
        | "missing_timestamp"
        | "stale_timestamp"
        | "missing_body"
        | "bad_signature"
        | "not_configured";
    };

/**
 * La requête est-elle réellement signée par l'application Slack configurée ?
 *
 * `rawBody` est la chaîne exacte reçue. `signature` et `timestamp` viennent des en-têtes
 * `x-slack-signature` et `x-slack-request-timestamp`.
 */
export function verifySlackRequest(params: {
  signingSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string | undefined;
  now?: number;
}): SlackVerdict {
  const { signingSecret } = params;
  if (signingSecret.trim() === "") return { ok: false, reason: "not_configured" };

  const signature = params.signature?.trim() ?? "";
  if (signature === "") return { ok: false, reason: "missing_signature" };

  const timestamp = params.timestamp?.trim() ?? "";
  if (timestamp === "" || !/^\d{1,20}$/.test(timestamp)) {
    return { ok: false, reason: "missing_timestamp" };
  }

  /*
   * L'horodatage de Slack est en SECONDES. Le lire en millisecondes ferait de toute
   * requête un rejeu vieux de cinquante ans, donc refuserait tout — une panne franche, ce
   * qui est la bonne direction, mais une panne quand même.
   */
  const sentAt = Number(timestamp) * 1000;
  const now = params.now ?? Date.now();
  /*
   * La valeur absolue : un horodatage dans le FUTUR est tout aussi suspect qu'un
   * horodatage vieux. N'en vérifier qu'un côté laisserait un attaquant fabriquer un
   * horodatage lointain et obtenir une requête valable pour des années.
   */
  if (Math.abs(now - sentAt) > SLACK_MAX_SKEW_MS) return { ok: false, reason: "stale_timestamp" };

  /*
   * `undefined` et `""` sont distingués : un corps vide est signable, et refuser pour
   * « corps absent » quand il est seulement vide donnerait un motif faux à l'exploitant.
   * `undefined` veut dire que la capture du corps brut n'est pas montée, ce qui est un
   * défaut de déploiement et non une requête suspecte.
   */
  if (params.rawBody === undefined) return { ok: false, reason: "missing_body" };

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${params.rawBody}`, "utf8")
    .digest("hex")}`;

  const given = Buffer.from(signature, "utf8");
  const want = Buffer.from(expected, "utf8");
  /*
   * L'égalité de longueur d'abord : `timingSafeEqual` LÈVE sur des longueurs
   * différentes, et une exception non attrapée ici répondrait 500 — ce qui distingue
   * « mauvaise longueur » de « mauvais contenu » aussi bien qu'un message explicite.
   */
  if (given.length !== want.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(given, want)) return { ok: false, reason: "bad_signature" };

  return { ok: true };
}

/* ------------------------- qui, chez nous, a cliqué ------------------------- */

export interface SlackApprover {
  slackUserId: string;
  email: string;
}

/**
 * La correspondance entre un utilisateur Slack et un utilisateur de la console.
 *
 * ## POURQUOI UNE LISTE EXPLICITE, ET PAS « l'espace de travail »
 *
 * Une requête Slack correctement signée prouve une seule chose : **l'application Slack
 * est bien la nôtre**. Elle ne prouve rien sur la personne qui a cliqué — et un espace de
 * travail Slack contient tout le monde, stagiaires et prestataires compris.
 *
 * Accepter « tout utilisateur de l'espace de travail » reviendrait donc à donner la
 * capacité d'approbation à toute l'entreprise, via un canal qui n'apparaît dans aucun
 * écran de rôles. La correspondance est donc déclarée, nominativement, et un utilisateur
 * Slack absent de la liste est refusé — même avec une signature parfaite.
 *
 * Format : `U123ABC:approbateur@acme.com,U456DEF:directrice@acme.com`
 *
 * L'adresse doit par ailleurs appartenir à un utilisateur réel de la console AYANT la
 * capacité `approve` : cette liste donne une identité, elle ne donne pas un droit.
 */
export function parseSlackApprovers(raw: string | undefined): Map<string, SlackApprover> {
  const out = new Map<string, SlackApprover>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const at = trimmed.indexOf(":");
    if (at <= 0) continue;
    const slackUserId = trimmed.slice(0, at).trim();
    const email = trimmed.slice(at + 1).trim().toLowerCase();
    if (slackUserId === "" || email === "" || !email.includes("@")) continue;
    /*
     * Première occurrence gagnante, et c'est le sens le plus sûr : si un identifiant
     * Slack apparaît deux fois, la dernière écriture pourrait élargir ce que la première
     * accordait. Garder la première rend un doublon inoffensif au lieu de le rendre
     * décisif.
     */
    if (!out.has(slackUserId)) out.set(slackUserId, { slackUserId, email });
  }
  return out;
}

/** Les problèmes de la configuration Slack, nommés au démarrage. */
export function slackConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const url = env.OATHRION_SLACK_WEBHOOK_URL?.trim();
  const secret = env.OATHRION_SLACK_SIGNING_SECRET?.trim();
  const approvers = env.OATHRION_SLACK_APPROVERS?.trim();
  const problems: string[] = [];

  /* Rien de configuré est un état valide : Slack est optionnel. */
  if (!url && !secret && !approvers) return problems;

  if (!url) {
    problems.push(
      "OATHRION_SLACK_SIGNING_SECRET or OATHRION_SLACK_APPROVERS is set without " +
        "OATHRION_SLACK_WEBHOOK_URL: nothing would be posted, so no one would have a button " +
        "to click.",
    );
  }

  if (url && !secret) {
    /*
     * LE REFUS LE PLUS IMPORTANT DE CE FICHIER.
     *
     * Poster des boutons sans pouvoir vérifier les clics, c'est publier une URL qui
     * approuve des actions d'agents sans authentification. Mieux vaut refuser de démarrer
     * que de laisser un exploitant croire qu'il a monté une approbation gouvernée.
     */
    problems.push(
      "OATHRION_SLACK_WEBHOOK_URL is set without OATHRION_SLACK_SIGNING_SECRET. Oathrion " +
        "would post approval buttons without being able to verify who clicks, " +
        "that is, a public route that releases agent actions. Provide the " +
        "signing secret of your Slack app, or remove the webhook.",
    );
  }

  if (url && secret && parseSlackApprovers(approvers).size === 0) {
    problems.push(
      "OATHRION_SLACK_APPROVERS is empty or unreadable. A valid signature proves that " +
        "the Slack app is yours, not that the person who clicked is allowed " +
        "to approve. Declare the mapping, for example " +
        "OATHRION_SLACK_APPROVERS=U123ABC:approver@acme.com",
    );
  }

  return problems;
}
