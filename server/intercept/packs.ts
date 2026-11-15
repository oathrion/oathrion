/**
 * LES PAQUETS DE RÈGLES — mettre un outil courant sous contrôle sans l'écrire soi-même.
 *
 * ## Le problème que ces paquets résolvent
 *
 * La voie pare-feu gouverne N'IMPORTE QUELLE API HTTP, et c'est sa force. Mais pour
 * chaque outil, un exploitant devait écrire à la main : le chemin exact, où lire la cible
 * dans le corps, où lire le montant, son échelle, et quels en-têtes relayer.
 *
 * Ce n'est pas de la configuration, c'est de l'EXPERTISE PAR API. Un exploitant qui se
 * trompe sur `amountScale` ne voit rien : un plafond de 100 € laisse passer 10 000 €
 * parce que Stripe compte en centimes. L'erreur est silencieuse et coûteuse, et c'est
 * exactement la classe de défaut que ce produit existe pour empêcher.
 *
 * Un paquet est donc un ensemble de règles ÉCRITES UNE FOIS, relues, et éprouvées contre
 * un corps de requête réaliste.
 *
 * ## CE QU'UN PAQUET NE FAIT PAS, ET C'EST DÉLIBÉRÉ
 *
 * **Il ne déclare pas la destination.** Une destination porte sa portée par locataire
 * (`organizations`), et un paquet ne peut pas la connaître — c'est l'exploitant qui sait
 * quels locataires ont le droit d'atteindre son compte Stripe. Un paquet qui déclarerait
 * sa propre destination contournerait le cadrage par locataire, c'est-à-dire la
 * propriété d'isolation la plus importante du produit.
 *
 * L'exploitant déclare donc toujours la destination lui-même, avec l'identifiant du
 * paquet. Si elle manque, `interceptRuleProblems` refuse le démarrage en la nommant.
 *
 * **Il ne fournit aucun credential.** Le jeton vient du coffre ou de l'environnement,
 * comme pour toute destination.
 *
 * ## LE STATUT HONNÊTE DE CES PAQUETS
 *
 * Les chemins et les noms de champs viennent de la DOCUMENTATION PUBLIÉE de chaque
 * fournisseur. Chaque paquet est éprouvé contre un corps de requête réaliste, ce qui
 * prouve que l'extraction fonctionne — et ne prouve PAS que le fournisseur se comporte
 * comme sa documentation le dit.
 *
 * Classement : **implémenté et éprouvé localement, NON VÉRIFIÉ contre le service réel.**
 * `limits` porte, pour chaque paquet, ce qu'il ne gouverne pas. Lisez-le avant de vendre
 * quoi que ce soit : il y a au moins un cas — Gmail — où une promesse évidente est
 * techniquement impossible, et il vaut mieux le découvrir ici qu'en clientèle.
 */

import type { InterceptRule } from "./rules";

/** Une règle de paquet : une règle d'interception sans sa destination, qui est ajoutée. */
export type PackRule = Omit<InterceptRule, "destination">;

export interface InterceptPack {
  /** L'identifiant du paquet, ET celui de la destination que l'exploitant doit déclarer. */
  id: string;
  label: string;
  /** L'origine officielle, à recopier dans `OATHRION_DESTINATIONS`. */
  origin: string;
  /** La forme du credential attendue par ce fournisseur, pour la documentation. */
  credential: { header: string; template: string };
  rules: readonly PackRule[];
  /** Ce que ce paquet NE gouverne PAS. Affiché par `npm run packs`. */
  limits: readonly string[];
}

/* ------------------------------------------------------------------ OpenAI */

const OPENAI: InterceptPack = {
  id: "openai",
  label: "OpenAI",
  origin: "https://api.openai.com",
  credential: { header: "authorization", template: "Bearer {secret}" },
  rules: [
    {
      id: "openai_chat",
      method: "POST",
      path: "/v1/chat/completions",
      action: "api.request",
      /*
       * La cible est le MODÈLE. C'est ce sur quoi une politique veut porter : interdire
       * un modèle coûteux, ou n'autoriser qu'un modèle hébergé dans une région donnée.
       */
      target: "body.model",
      /*
       * `stream: true` — sinon Oathrion tamponnerait la réponse entière et supprimerait le
       * streaming que l'application de l'utilisateur attend. C'est la différence entre un
       * pare-feu utilisable devant une API de modèle et un pare-feu qu'on retire.
       */
      stream: true,
      forwardHeaders: ["content-type", "accept", "openai-organization", "openai-project"],
    },
    {
      id: "openai_responses",
      method: "POST",
      path: "/v1/responses",
      action: "api.request",
      target: "body.model",
      stream: true,
      forwardHeaders: ["content-type", "accept", "openai-organization", "openai-project"],
    },
    {
      id: "openai_embeddings",
      method: "POST",
      path: "/v1/embeddings",
      action: "api.request",
      target: "body.model",
      forwardHeaders: ["content-type"],
    },
  ],
  limits: [
    "The CONTENT of messages is not inspected: Oathrion governs the call, not the prompt.",
    "The cost cannot be extracted — it depends on the token count, which only the response reveals. A spending cap on this destination is not possible through a rule.",
    "Tool calls the model asks for in return do not go through here: your agent executes them, and it is your AGENT that must go through Oathrion.",
    "A policy that DENIES a model by name compares the exact name: denying `gpt-4o` lets the dated snapshot `gpt-4o-2024-08-06` through, which is the same model. Deny the family with a pattern (`gpt-4o`, `gpt-4o-20*`), or better, explicitly ALLOW only the models you want — an allow list cannot be bypassed with an alias.",
  ],
};

/* --------------------------------------------------------------- Anthropic */

const ANTHROPIC: InterceptPack = {
  id: "anthropic",
  label: "Anthropic",
  origin: "https://api.anthropic.com",
  credential: { header: "x-api-key", template: "{secret}" },
  rules: [
    {
      id: "anthropic_messages",
      method: "POST",
      path: "/v1/messages",
      action: "api.request",
      target: "body.model",
      stream: true,
      /*
       * `anthropic-version` est OBLIGATOIRE chez ce fournisseur : sans elle dans
       * l'allowlist, l'API répond 400 et le symptôme est trompeur — la décision d'Oathrion
       * aura été ALLOW, donc l'exploitant cherche l'erreur du mauvais côté. C'est le
       * défaut exact rencontré avec `MCP-Protocol-Version` sur un autre amont.
       */
      forwardHeaders: ["content-type", "accept", "anthropic-version", "anthropic-beta"],
    },
    {
      id: "anthropic_count_tokens",
      method: "POST",
      path: "/v1/messages/count_tokens",
      action: "query",
      target: "body.model",
      forwardHeaders: ["content-type", "anthropic-version"],
    },
  ],
  limits: [
    "Same limits as the OpenAI pack: neither the content nor the actual cost.",
    "`anthropic-version` must be sent by your agent. Oathrion relays it; it does not make it up.",
  ],
};

/* ------------------------------------------------------------------ Stripe */

const STRIPE: InterceptPack = {
  id: "stripe",
  label: "Stripe",
  origin: "https://api.stripe.com",
  credential: { header: "authorization", template: "Bearer {secret}" },
  /*
   * CE PAQUET A ÉTÉ CORRIGÉ PAR LE VRAI STRIPE, et les corrections valent d'être lues.
   *
   * Écrit d'abord d'après la documentation, il a été passé à `npm run verify:stripe` avec
   * une vraie clé de test. Trois défauts en sont sortis, qu'aucun test local ne pouvait
   * voir puisque les tests locaux vérifiaient ce que J'AVAIS COMPRIS de l'API :
   *
   *   · `/v1/refunds` lisait `body.currency`, et les limites disaient même « `currency`
   *     doit être envoyée ». Stripe répond `Received unknown parameter: currency` : un
   *     remboursement prend la devise de la charge d'origine. Un agent qui suivait ce
   *     conseil voyait TOUS ses remboursements rejetés.
   *   · `/v1/refunds` ne lisait que `body.charge`, alors que Stripe accepte aussi
   *     `payment_intent` — la forme qu'emploient ses bibliothèques actuelles.
   *   · `amountScale: 100` partout. Stripe compte l'euro en centimes mais le franc CFA en
   *     francs : pour une organisation en XOF, chaque montant était jugé CENT FOIS trop
   *     petit — dans le sens qui laisse passer. `amountUnit: "minor"` prend l'échelle dans
   *     le registre des devises, comme `shared/money.ts`.
   */
  rules: [
    {
      id: "stripe_refund",
      method: "POST",
      path: "/v1/refunds",
      action: "refund",
      /* Le paiement remboursé, sous la forme actuelle d'abord, l'ancienne ensuite. */
      target: "body.payment_intent|body.charge",
      amount: "body.amount",
      /*
       * PAS DE `currency` ICI : Stripe la refuse sur cet endpoint. Le montant est donc jugé
       * dans la devise de l'ORGANISATION, ce qui n'est juste que si le compte Stripe
       * facture dans cette devise — c'est la première limite déclarée plus bas.
       */
      amountUnit: "minor",
      forwardHeaders: ["content-type", "stripe-version", "idempotency-key"],
    },
    {
      id: "stripe_payment_intent",
      method: "POST",
      path: "/v1/payment_intents",
      action: "payment",
      target: "body.customer",
      amount: "body.amount",
      /* Ici la devise est dans la requête — obligatoire chez Stripe — donc l'échelle aussi. */
      currency: "body.currency",
      amountUnit: "minor",
      forwardHeaders: ["content-type", "stripe-version", "idempotency-key"],
    },
    {
      id: "stripe_payout",
      method: "POST",
      path: "/v1/payouts",
      action: "payout",
      /*
       * `body.destination` est FACULTATIF chez Stripe — absent, le virement va au compte
       * bancaire par défaut. Or une cible déclarée et absente est une ERREUR dans ce
       * produit, pas un vide : décider sans savoir OÙ l'argent part serait pire que
       * refuser. L'agent doit donc nommer la destination, et c'est une contrainte que
       * l'exploitant doit connaître avant d'activer ce paquet — elle est dans `limits`.
       */
      target: "body.destination",
      amount: "body.amount",
      currency: "body.currency",
      amountUnit: "minor",
      forwardHeaders: ["content-type", "stripe-version", "idempotency-key"],
    },
    {
      id: "stripe_charge_capture",
      method: "POST",
      /* La ressource est dans l'URL : c'est la source `path.` qui la lit. */
      path: "/v1/charges/{charge}/capture",
      action: "charge",
      target: "path.charge",
      amount: "body.amount",
      /* Comme un remboursement, une capture prend la devise de la charge : pas de `currency`. */
      amountUnit: "minor",
      forwardHeaders: ["content-type", "stripe-version", "idempotency-key"],
    },
  ],
  limits: [
    "A refund and a capture are judged in YOUR ORGANIZATION's currency: Stripe rejects the `currency` parameter on these endpoints, the currency is that of the original charge. The cap is therefore only accurate if your Stripe account bills in your organization's currency.",
    "`/v1/payouts` REQUIRES your agent to name `destination`. Stripe accepts it missing (payout to the default account); Oathrion refuses with 422, because deciding without knowing where the money goes would be worse than refusing.",
    "Capturing a PaymentIntent (`/v1/payment_intents/{id}/capture`) is not covered: only the older per-charge route is. A PaymentIntent capture is refused, not forwarded.",
    "Customers, subscriptions and incoming webhooks are not covered: this pack governs outgoing money movements.",
  ],
};

/* ------------------------------------------------------------------- Slack */

const SLACK: InterceptPack = {
  id: "slack",
  label: "Slack",
  origin: "https://slack.com",
  credential: { header: "authorization", template: "Bearer {secret}" },
  /*
   * CORRIGÉ PAR LE VRAI SLACK. L'API Web répond HTTP 200 même quand elle refuse, avec
   * `{"ok": false, "error": "…"}`. `npm run verify:slack` a montré qu'Oathrion enregistrait
   * alors le message rejeté comme ENVOYÉ. `successField: "ok"` fait lire la réussite dans
   * le corps : un refus de Slack est désormais un échec dans le reçu.
   */
  rules: [
    {
      id: "slack_post_message",
      method: "POST",
      path: "/api/chat.postMessage",
      action: "send_message",
      /* Le canal est un champ à plat, en JSON comme en form : les deux marchent. */
      target: "body.channel",
      forwardHeaders: ["content-type"],
      /* Slack répond 200 même quand il refuse : la réussite se lit dans `ok`. */
      successField: "ok",
    },
    {
      id: "slack_post_ephemeral",
      method: "POST",
      path: "/api/chat.postEphemeral",
      action: "send_message",
      target: "body.channel",
      forwardHeaders: ["content-type"],
      /* Slack répond 200 même quand il refuse : la réussite se lit dans `ok`. */
      successField: "ok",
    },
    {
      id: "slack_files_upload",
      method: "POST",
      path: "/api/files.getUploadURLExternal",
      action: "upload",
      target: "body.filename",
      forwardHeaders: ["content-type"],
      /* Slack répond 200 même quand il refuse : la réussite se lit dans `ok`. */
      successField: "ok",
    },
  ],
  limits: [
    "The TEXT of the message is not inspected. A policy can deny a channel, not a content.",
    "`chat.postMessage` also accepts sending to a user ID in `channel`: a policy that only allows public channels must list the IDs, not assume a prefix.",
    "Slack incoming webhooks (`hooks.slack.com`) do not go through here — that is another origin, and they go the other way.",
  ],
};

/* ------------------------------------------- Google Workspace (Gmail, Drive) */

const GOOGLE: InterceptPack = {
  id: "google",
  label: "Google Workspace (Gmail, Drive)",
  origin: "https://gmail.googleapis.com",
  credential: { header: "authorization", template: "Bearer {secret}" },
  rules: [
    {
      id: "gmail_send",
      method: "POST",
      path: "/gmail/v1/users/{user_id}/messages/send",
      action: "send_email",
      /*
       * LA CIBLE EST LA BOÎTE EXPÉDITRICE, PAS LE DESTINATAIRE — et il faut le dire fort.
       *
       * L'API Gmail prend le message entier encodé en base64url dans `body.raw` : le
       * destinataire est À L'INTÉRIEUR de ce blob, dans un en-tête RFC 2822. Oathrion lit
       * des champs, il ne décode pas du base64 pour analyser des en-têtes de courrier —
       * et il ne doit pas le faire, parce qu'un extracteur qui se trompe sur un format
       * aussi tordu produirait une cible fausse, donc une décision prise sur autre chose
       * que la réalité.
       *
       * La cible utile et HONNÊTE est donc `path.user_id` : quelle boîte cet agent
       * utilise-t-il pour envoyer. C'est réel, c'est gouvernable, et ce n'est pas ce
       * qu'un acheteur imagine en entendant « on contrôle les envois de mails ».
       *
       * La conséquence est dans `limits`, en toutes lettres : **une politique ne peut pas
       * restreindre les DESTINATAIRES sur cet endpoint.**
       */
      target: "path.user_id",
      forwardHeaders: ["content-type"],
    },
    {
      id: "gmail_draft",
      method: "POST",
      path: "/gmail/v1/users/{user_id}/drafts",
      action: "write",
      target: "path.user_id",
      forwardHeaders: ["content-type"],
    },
  ],
  limits: [
    "**The recipient of an email CANNOT be governed.** Gmail encodes the whole message as base64url in `raw`; the recipient's address is inside that blob. A policy can limit the sending mailbox and the number of sends, never the \"to whom\".",
    "Drive is not included: its upload API is multipart with JSON metadata, and the useful target (the parent folder) cannot be read flat. Write it by hand if you need it.",
    "**Not usable in production as is, and outside the launch scope.** Google only issues one-hour tokens. Oathrion can refresh a token (`OATHRION_OAUTH_<DESTINATION>`), but that refresh has NEVER been tested against Google, and Oathrion does not offer the consent flow that provides the refresh token: you would have to obtain it elsewhere and paste it. A pasted access token expires in one hour.",
  ],
};

/* ------------------------------------------------------------- le catalogue */

export const INTERCEPT_PACKS: readonly InterceptPack[] = [
  OPENAI,
  ANTHROPIC,
  STRIPE,
  SLACK,
  GOOGLE,
];

export function lookupPack(id: string): InterceptPack | undefined {
  return INTERCEPT_PACKS.find((pack) => pack.id === id.trim().toLowerCase());
}

/**
 * Développe `OATHRION_INTERCEPT_PACKS` en règles d'interception.
 *
 * La destination de chaque règle est l'identifiant du paquet : l'exploitant doit avoir
 * déclaré une entrée `OATHRION_DESTINATIONS` portant cet identifiant, avec la portée par
 * locataire qu'il veut. `interceptRuleProblems` refuse le démarrage si elle manque, en la
 * nommant — donc un paquet activé sans destination ne passe pas en silence.
 *
 * Un nom de paquet inconnu LÈVE, avec la liste de ceux qui existent. Le tolérer ferait
 * démarrer un déploiement en croyant gouverner un outil qu'il ne gouverne pas, ce qui est
 * la pire défaillance possible pour ce produit.
 */
export function packRules(env: NodeJS.ProcessEnv = process.env): InterceptRule[] {
  const raw = env.OATHRION_INTERCEPT_PACKS?.trim();
  if (!raw) return [];

  const rules: InterceptRule[] = [];
  const seen = new Set<string>();
  for (const name of raw.split(",").map((n) => n.trim()).filter((n) => n !== "")) {
    const pack = lookupPack(name);
    if (!pack) {
      throw new Error(
        `OATHRION_INTERCEPT_PACKS: the pack "${name}" does not exist. Available: ` +
          `${INTERCEPT_PACKS.map((p) => p.id).join(", ")}. ` +
          `Tolerating an unknown pack would suggest a tool is governed when it is not.`,
      );
    }
    if (seen.has(pack.id)) {
      throw new Error(`OATHRION_INTERCEPT_PACKS: the pack "${pack.id}" is named twice.`);
    }
    seen.add(pack.id);
    for (const rule of pack.rules) rules.push({ ...rule, destination: pack.id });
  }
  return rules;
}
