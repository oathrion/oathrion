/**
 * Ce que les cinq étapes du démarrage partagent : les libellés en clair, la pastille de
 * décision, et l'enveloppe d'une étape.
 *
 * Les libellés sont ici et nulle part ailleurs : une action s'appelle « Publier un
 * message », jamais `slack.message.post`, sur tous les écrans du parcours. Le nom
 * technique reste visible en petit, parce que c'est lui que le journal d'audit porte.
 */

import type { ReactNode } from "react";
import { CheckCircle2, Clock3, OctagonX } from "lucide-react";

import { cn } from "@/lib/utils";

export const ACTION_LABEL: Record<string, string> = {
  "github.repos.list": "List repositories",
  "github.repo.read": "Read a repository",
  "github.issue.search": "Read issues",
  "github.issue.create": "Open an issue",
  "github.issue.comment": "Comment on an issue",
  "slack.channels.list": "List channels",
  "slack.history.read": "Read messages",
  "slack.message.post": "Post a message",
  "linear.teams.list": "List teams",
  "linear.issue.search": "Read tasks",
  "linear.issue.create": "Create a task",
  "linear.comment.create": "Comment on a task",
  "stripe.balance.read": "Read the balance",
  "stripe.payments.list": "List payments",
  "stripe.customers.search": "Search a customer",
  "stripe.refund.create": "Refund a payment",
};

export const TOOL_COPY: Record<string, { benefit: string; resource: string; resourcesLower: string; resources: string }> = {
  github: {
    benefit: "Your agents read issues and propose new ones — every write goes through your rules.",
    resource: "repository",
    resourcesLower: "repositories",
    resources: "Repositories",
  },
  slack: {
    benefit: "Your agents read the team's channel and post a summary there, only where you allow it.",
    resource: "channel",
    resourcesLower: "channels",
    resources: "Channels",
  },
  linear: {
    benefit: "Your agents prepare tasks in the chosen team, with a link to what they read.",
    resource: "team",
    resourcesLower: "teams",
    resources: "Teams",
  },
  stripe: {
    benefit: "Your agents look up payments and customers; a refund always waits for your approval, with amount and currency shown.",
    resource: "account",
    resourcesLower: "accounts",
    resources: "Accounts",
  },
};

/**
 * Où révoquer, chez chaque fournisseur, une clé qu'un agent détenait AVANT Oathrion. Une
 * clé laissée vivante est une seconde route : l'agent peut agir sans passer par les règles.
 */
export const REVOKE_PAGE: Record<string, { url: string; where: string; what: string }> = {
  github: {
    url: "https://github.com/settings/personal-access-tokens",
    where: "GitHub → Settings → Developer settings → Personal access tokens",
    what: 'the token the agent used (and any "classic" tokens)',
  },
  slack: {
    url: "https://api.slack.com/apps",
    where: "api.slack.com/apps → your app → OAuth & Permissions",
    what: 'the agent\'s token ("Revoke tokens"), or the app if only the agent uses it',
  },
  linear: {
    url: "https://linear.app/settings/account/security",
    where: "Linear → Settings → Security & access → Personal API keys",
    what: "the API key the agent used",
  },
  stripe: {
    url: "https://dashboard.stripe.com/apikeys",
    where: "Stripe → Developers → API keys",
    what: 'the secret or restricted key the agent used ("Delete key" or "Roll key")',
  },
};

/** Les étapes de création d'un jeton, quand la connexion en un clic n'est pas offerte. */
export const TOKEN_STEPS: Record<string, { steps: ReactNode[]; placeholder: string }> = {
  github: {
    placeholder: "github_pat_…",
    steps: [
      <>
        Open{" "}
        <a className="font-medium text-primary underline-offset-2 hover:underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
          GitHub's token creation page
        </a>
        .
      </>,
      <>Name it "Oathrion". Under "Repository access", choose "Only select repositories" and tick the repositories concerned.</>,
      <>Under "Repository permissions": "Issues" on "Read and write". GitHub adds "Metadata" read-only. Nothing else.</>,
      <>Click "Generate token", copy the token and paste it below.</>,
    ],
  },
  slack: {
    placeholder: "xoxb-…",
    steps: [
      <>
        Open{" "}
        <a className="font-medium text-primary underline-offset-2 hover:underline" href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
          api.slack.com/apps
        </a>{" "}
        → "Create New App" → "From scratch". Name: "Oathrion", then your workspace.
      </>,
      <>"OAuth &amp; Permissions" → "Bot Token Scopes": add chat:write, channels:read and channels:history (and groups:read, groups:history for private channels).</>,
      <>Click "Install to Workspace", then "Allow".</>,
      <>Copy the "Bot User OAuth Token" — it starts with xoxb- — and paste it below. Not the "User OAuth Token".</>,
      <>In every channel the agent may use, type /invite @Oathrion.</>,
    ],
  },
  linear: {
    placeholder: "lin_api_…",
    steps: [
      <>
        Open{" "}
        <a className="font-medium text-primary underline-offset-2 hover:underline" href="https://linear.app/settings/account/security" target="_blank" rel="noreferrer">
          Linear → Settings → Security &amp; access
        </a>
        .
      </>,
      <>Under "Personal API keys", click "New API key" and name it "Oathrion".</>,
      <>Copy the key — it starts with lin_api_ — and paste it below.</>,
    ],
  },
  stripe: {
    placeholder: "rk_test_… or sk_test_…",
    steps: [
      <>
        Open{" "}
        <a className="font-medium text-primary underline-offset-2 hover:underline" href="https://dashboard.stripe.com/test/apikeys" target="_blank" rel="noreferrer">
          Stripe → Developers → API keys
        </a>{" "}
        in <strong>test mode</strong>.
      </>,
      <>Preferably, "Create restricted key" named "Oathrion": read on Balance, PaymentIntents and Customers, write on Refunds, nothing else. Otherwise, the test secret key works.</>,
      <>Copy the key — it starts with rk_test_ or sk_test_ — and paste it below. Oathrion refuses publishable keys (pk_) and, by default, live-mode keys.</>,
    ],
  },
};

export type Decision = "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";

const DECISION: Record<Decision, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  ALLOW: {
    label: "Allowed",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  BLOCK: {
    label: "Blocked",
    className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    icon: OctagonX,
  },
  APPROVAL_REQUIRED: {
    label: "Approval required",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    icon: Clock3,
  },
};

export function DecisionBadge({ decision }: { decision: Decision }) {
  const d = DECISION[decision];
  const Icon = d.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", d.className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {d.label}
    </span>
  );
}

/** L'enveloppe d'une étape : un titre, une phrase, une action principale. */
export function StepShell({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: string;
  lead: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby="step-title" className="max-w-3xl">
      <p className="text-xs font-medium text-muted-foreground">{eyebrow}</p>
      <h2 id="step-title" className="mt-2 text-2xl font-semibold tracking-tight text-balance">
        {title}
      </h2>
      <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">{lead}</p>
      <div className="mt-8">{children}</div>
    </section>
  );
}

export const inputClass =
  "h-10 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30";

export const primaryButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2";

export const secondaryButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium transition-colors hover:border-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/**
 * Pourquoi le moteur a décidé, en une phrase pour une équipe non technique. Le motif du
 * moteur — exact, en anglais, celui du journal — reste affiché en petit à côté.
 */
export function decisionSentence(decision: Decision, policyName: string | null): string {
  if (decision === "ALLOW") {
    return policyName
      ? `Allowed by the rule "${policyName}".`
      : "No rule holds it, and the agent has the permission it needs.";
  }
  if (decision === "APPROVAL_REQUIRED") {
    return `Held by the rule "${policyName ?? "approval"}": nothing goes out before a person approves.`;
  }
  return `Blocked by ${policyName ? `the rule "${policyName}"` : "the agent's mandate"}: nothing is sent to the service.`;
}
