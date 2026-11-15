/**
 * Les arguments propres à chaque verbe de connecteur, pour la voie MCP.
 *
 * ## Le défaut que ce fichier ferme
 *
 * Le routeur MCP refuse tout argument qu'il n'évalue pas — c'est une bonne règle : un
 * argument ignoré laisse un modèle croire qu'il a contraint un appel. Mais la liste ne
 * contenait que `target`, `reason`, `amount`, `currency`, `category`. Un agent MCP ne
 * pouvait donc PAS donner le titre d'une issue ni le texte d'un message Slack : les
 * connecteurs réels étaient listés et inutilisables par cette voie.
 *
 * Ici, chaque verbe déclare exactement ce qu'il lit. Une seule table sert aux deux
 * moitiés : le schéma annoncé au modèle (`tool-catalog.ts`) et la validation stricte de
 * ce qu'il envoie (`router.ts`). Un argument non déclaré reste refusé.
 */

export interface ArgumentSpec {
  type: "string" | "integer";
  description: string;
  /** Longueur maximale (chaîne) ou bornes (entier). */
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  required?: boolean;
}

export interface ActionArguments {
  /** Ce que `target` doit contenir pour ce verbe — affiché au modèle. */
  target: string;
  args: Record<string, ArgumentSpec>;
}

const REPO = 'The repository, written "github.com/<owner>/<repo>". Policies match on it.';
const CHANNEL = 'The Slack channel ID, written "slack.com/<CHANNEL_ID>" (e.g. slack.com/C0123ABCD). Never the channel name.';
const TEAM = 'The Linear team key, written "linear.app/<TEAM_KEY>" (e.g. linear.app/ENG).';
const STRIPE_ACCOUNT = 'The Stripe account, written "stripe.com/<ACCOUNT_ID>" (e.g. stripe.com/acct_1AbC…).';

export const ACTION_ARGUMENTS: Record<string, ActionArguments> = {
  "github.repos.list": { target: 'Always "github.com".', args: {} },
  "github.repo.read": { target: REPO, args: {} },
  "github.issue.search": {
    target: REPO,
    args: {
      query: { type: "string", description: "Words that must appear in the title.", maxLength: 200 },
      state: { type: "string", description: "open (default), closed or all.", enum: ["open", "closed", "all"] },
      limit: { type: "integer", description: "At most this many results (1–50).", minimum: 1, maximum: 50 },
    },
  },
  "github.issue.create": {
    target: REPO,
    args: {
      title: { type: "string", description: "Issue title.", maxLength: 256, required: true },
      body: { type: "string", description: "Issue body, Markdown.", maxLength: 20_000 },
    },
  },
  "github.issue.comment": {
    target: REPO,
    args: {
      issue: { type: "integer", description: "Issue or pull request number.", minimum: 1, required: true },
      body: { type: "string", description: "Comment, Markdown.", maxLength: 20_000, required: true },
    },
  },
  "slack.channels.list": { target: 'Always "slack.com".', args: {} },
  "slack.history.read": {
    target: CHANNEL,
    args: { limit: { type: "integer", description: "Most recent messages to read (1–50).", minimum: 1, maximum: 50 } },
  },
  "slack.message.post": {
    target: CHANNEL,
    args: { text: { type: "string", description: "Message text.", maxLength: 4_000, required: true } },
  },
  "linear.teams.list": { target: 'Always "linear.app".', args: {} },
  "linear.issue.search": {
    target: TEAM,
    args: {
      query: { type: "string", description: "Words that must appear in the title.", maxLength: 200 },
      limit: { type: "integer", description: "At most this many results (1–25).", minimum: 1, maximum: 25 },
    },
  },
  "linear.issue.create": {
    target: TEAM,
    args: {
      title: { type: "string", description: "Issue title.", maxLength: 255, required: true },
      description: { type: "string", description: "Issue description, Markdown.", maxLength: 10_000 },
      priority: { type: "integer", description: "0 none, 1 urgent, 2 high, 3 medium, 4 low.", minimum: 0, maximum: 4 },
    },
  },
  "linear.comment.create": {
    target: 'The issue, written "linear.app/<TEAM_KEY>/<ISSUE_ID>" (e.g. linear.app/ENG/ENG-123).',
    args: { body: { type: "string", description: "Comment, Markdown.", maxLength: 10_000, required: true } },
  },
  "stripe.balance.read": { target: STRIPE_ACCOUNT, args: {} },
  "stripe.payments.list": {
    target: STRIPE_ACCOUNT,
    args: {
      customer: { type: "string", description: "Only this customer's payments (cus_…).", maxLength: 60 },
      limit: { type: "integer", description: "At most this many payments (1–25).", minimum: 1, maximum: 25 },
    },
  },
  "stripe.customers.search": {
    target: STRIPE_ACCOUNT,
    args: {
      email: { type: "string", description: "Only customers with this exact email address.", maxLength: 200 },
      limit: { type: "integer", description: "At most this many customers (1–25).", minimum: 1, maximum: 25 },
    },
  },
  /*
   * `amount` et `currency` viennent du schéma commun des verbes financiers (tool-catalog) :
   * le montant en UNITÉS (12.50), comparé au plafond de l'agent. Le connecteur refuse un
   * remboursement sans montant ou dans une autre devise que celle du paiement.
   */
  "stripe.refund.create": {
    target: 'The payment to refund, written "stripe.com/<ACCOUNT_ID>/<PAYMENT_INTENT_ID>" (e.g. stripe.com/acct_1AbC…/pi_3XyZ…). Always give amount and currency.',
    args: {
      refund_reason: {
        type: "string",
        description: "Stripe's refund reason. Your own justification goes in `reason`.",
        enum: ["duplicate", "fraudulent", "requested_by_customer"],
      },
    },
  },
};

export function argumentsFor(action: string): ActionArguments | undefined {
  return ACTION_ARGUMENTS[action];
}

/** Le fragment de schéma JSON d'un argument déclaré. */
export function argumentSchema(spec: ArgumentSpec): Record<string, unknown> {
  return {
    type: spec.type,
    description: spec.description,
    ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
    ...(spec.minimum !== undefined ? { minimum: spec.minimum } : {}),
    ...(spec.maximum !== undefined ? { maximum: spec.maximum } : {}),
    ...(spec.enum ? { enum: spec.enum } : {}),
  };
}

/**
 * Valide UNE valeur contre sa déclaration. Rend le motif du refus, ou `null`.
 *
 * Validée ici et pas seulement annoncée : un schéma montré à un modèle est une
 * indication, pas une frontière.
 */
export function argumentProblem(name: string, spec: ArgumentSpec, value: unknown): string | null {
  if (spec.type === "string") {
    if (typeof value !== "string") return `"${name}" must be a string.`;
    if (spec.maxLength !== undefined && value.length > spec.maxLength) return `"${name}" is longer than ${String(spec.maxLength)} characters.`;
    if (spec.enum && !spec.enum.includes(value)) return `"${name}" must be one of: ${spec.enum.join(", ")}.`;
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return `"${name}" must be an integer.`;
  if (spec.minimum !== undefined && value < spec.minimum) return `"${name}" must be at least ${String(spec.minimum)}.`;
  if (spec.maximum !== undefined && value > spec.maximum) return `"${name}" must be at most ${String(spec.maximum)}.`;
  return null;
}
