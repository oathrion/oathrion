/**
 * LE SCÉNARIO GUIDÉ — une tâche réelle, à travers les outils connectés, par la passerelle.
 *
 * ## Ce qu'il est
 *
 * La suite d'appels qu'un agent d'équipe ferait : lire un contexte (Slack, Linear ou
 * GitHub), préparer une tâche Linear, proposer une issue GitHub, puis — une fois les
 * écritures approuvées — publier un résumé dans Slack. Plus une tentative VOLONTAIRE hors
 * du périmètre choisi, pour que le client voie un refus.
 *
 * ## Ce qu'il n'est pas
 *
 * Il n'est pas une simulation. Chaque étape est `gateway.execute` — l'appel exact de
 * `POST /api/execute` et de `tools/call` MCP — au nom de l'agent choisi : mêmes
 * politiques, même mandat, même file d'approbation, même audit. Une étape autorisée
 * atteint le vrai service et rend son lien ; une étape bloquée n'atteint rien.
 *
 * Il n'est pas non plus un agent. C'est Oathrion qui joue la séquence, et l'audit le dit :
 * l'acteur enregistré est « <personne> · scénario guidé ». Un agent réel connecté par MCP
 * suit le même chemin ; la console le montre à l'étape « Connecter un agent ».
 *
 * ## Ce qu'il ne prédit pas
 *
 * Rien n'est écrit d'avance. La décision affichée est celle que le moteur a rendue : si
 * le client a choisi « écritures libres », l'issue GitHub passe sans approbation, et
 * l'écran le dit tel quel.
 */

import type { AgentGateway, GatewayResult } from "./gateway/agent-gateway";
import type { ConnectorPlane } from "./connectors";
import { lookupConnector } from "./connectors";
import { readSelection } from "./connectors/guardrails";
import type { Repositories } from "./repositories/types";

export interface ScenarioStep {
  key: "read" | "payments" | "task" | "issue" | "outside" | "notify";
  title: string;
  /** Ce que l'étape démontre, en une phrase. */
  explanation: string;
  action: string;
  target: string;
  decision: GatewayResult["decision"];
  reason: string;
  policyName: string | null;
  executionId: string | null;
  approvalId: string | null;
  attempted: boolean;
  succeeded: boolean;
  /** Le lien chez le fournisseur, quand l'appel a abouti et qu'il en rend un. */
  url: string | null;
  /** La requête est partie sans réponse : l'action a PEUT-ÊTRE eu lieu. */
  effectUnknown: boolean;
  summary: string | null;
}

export interface ScenarioDeps {
  gateway: AgentGateway;
  repositories: Repositories;
  connectors: ConnectorPlane;
  actor: string;
}

export class ScenarioError extends Error {}

const OUTSIDE_PLACEHOLDER = {
  slack: "slack.com/C0OUTOFSCOPE",
  linear: "linear.app/OUT",
  github: "github.com/oathrion-out-of-scope/unauthorized-repo",
  stripe: "stripe.com/acct_OutOfScope0",
};

function urlOf(result: GatewayResult): string | null {
  const url = result.toolResult?.url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

function summaryOf(result: GatewayResult): string | null {
  const value = result.execution?.result;
  return typeof value === "string" && value !== "" ? value : null;
}

async function step(
  deps: ScenarioDeps,
  agentId: string,
  shape: Omit<ScenarioStep, "decision" | "reason" | "policyName" | "executionId" | "approvalId" | "attempted" | "succeeded" | "url" | "effectUnknown" | "summary">,
  metadata: Record<string, unknown>,
): Promise<{ step: ScenarioStep; result: GatewayResult }> {
  const result = await deps.gateway.execute({
    agentId,
    action: shape.action,
    target: shape.target,
    metadata,
    actor: deps.actor,
  });
  return {
    result,
    step: {
      ...shape,
      decision: result.decision,
      reason: result.reason,
      policyName: result.policyName,
      executionId: result.executionId,
      approvalId: result.approvalId,
      attempted: result.attempted,
      succeeded: result.succeeded,
      url: urlOf(result),
      effectUnknown: result.toolResult?.dispatched === "unknown",
      summary: summaryOf(result),
    },
  };
}

/** Le texte lu à l'étape 1, réduit à ce qui sert de contexte à la tâche. */
function contextFrom(result: GatewayResult): string {
  const data = result.toolResult ?? {};
  const lines: string[] = [];
  for (const m of (Array.isArray(data.messages) ? data.messages : []) as { text?: unknown }[]) {
    if (typeof m.text === "string" && m.text.trim() !== "") lines.push(`> ${m.text.trim().slice(0, 200)}`);
  }
  for (const i of (Array.isArray(data.issues) ? data.issues : Array.isArray(data.items) ? data.items : []) as { title?: unknown }[]) {
    if (typeof i.title === "string") lines.push(`- ${i.title.slice(0, 200)}`);
  }
  return lines.slice(0, 5).join("\n");
}

export async function runScenario(deps: ScenarioDeps, agentId: string): Promise<ScenarioStep[]> {
  const agent = await deps.repositories.agents.findById(agentId);
  if (!agent) throw new ScenarioError("This agent does not exist in your workspace.");

  const policies = await deps.repositories.policies.list();
  const described = await deps.connectors.describe();
  const connected = new Set(described.filter((c) => c.status.state === "connected").map((c) => c.id));
  const chosen = (id: string): string | null => {
    if (!connected.has(id)) return null;
    return readSelection(id, policies).resources?.[0] ?? null;
  };
  const channel = chosen("slack");
  const team = chosen("linear");
  const repo = chosen("github");
  const account = chosen("stripe");
  if (!channel && !team && !repo && !account) {
    throw new ScenarioError(
      "No tool has a chosen resource. Connect at least one tool and choose a channel, a team, a repository or an account.",
    );
  }

  const steps: ScenarioStep[] = [];

  /* 1. Lire un contexte. Une lecture : elle passe, sauf règle contraire du client. */
  let context = "";
  if (channel || team || repo) {
    const shape = channel
      ? { action: "slack.history.read", target: channel, title: "Read the context in Slack", metadata: { limit: 5 } }
      : team
        ? { action: "linear.issue.search", target: team, title: "Read the Linear tasks", metadata: { limit: 5 } }
        : { action: "github.issue.search", target: repo!, title: "Read the GitHub issues", metadata: { limit: 5 } };
    const { step: done, result } = await step(
      deps,
      agentId,
      {
        key: "read",
        title: shape.title,
        explanation: "A read in a resource you chose.",
        action: shape.action,
        target: shape.target,
      },
      shape.metadata,
    );
    steps.push(done);
    if (result.succeeded) context = contextFrom(result);
  }

  /*
   * 1 bis. Lire les derniers paiements Stripe. Une lecture seulement : le scénario ne
   * rembourse jamais rien de lui-même — un remboursement déplace de l'argent, il se décide.
   */
  if (account) {
    const { step: done } = await step(
      deps,
      agentId,
      {
        key: "payments",
        title: "Read the latest Stripe payments",
        explanation: "A read on the chosen account. A refund, on the other hand, always waits for a decision.",
        action: "stripe.payments.list",
        target: account,
      },
      { limit: 5 },
    );
    steps.push(done);
  }

  const title = `Oathrion · task prepared by ${agent.name}`;
  const body =
    `Prepared by the agent "${agent.name}" during the Oathrion guided scenario.` +
    (context ? `\n\nContext read:\n${context}` : "");

  /* 2. Préparer une tâche Linear. */
  let linearUrl: string | null = null;
  if (team) {
    const { step: done } = await step(
      deps,
      agentId,
      {
        key: "task",
        title: "Prepare a Linear task",
        explanation: "A write in the chosen team: it follows your Linear write rule.",
        action: "linear.issue.create",
        target: team,
      },
      { title, description: body, priority: 3 },
    );
    steps.push(done);
    linearUrl = done.url;
  }

  /* 3. Proposer une issue GitHub. */
  if (repo) {
    const { step: done } = await step(
      deps,
      agentId,
      {
        key: "issue",
        title: "Propose a GitHub issue",
        explanation: "A write in the chosen repository: by default, it waits for your approval.",
        action: "github.issue.create",
        target: repo,
      },
      { title, body: linearUrl ? `${body}\n\nLinear task: ${linearUrl}` : body },
    );
    steps.push(done);
  }

  /* 4. Une tentative VOLONTAIRE hors du périmètre. */
  {
    const outside = await outsideTarget(deps.connectors, connected, { slack: channel, linear: team, github: repo, stripe: account });
    const metadata =
      outside.action === "slack.message.post"
        ? { text: "This message must never go out: the channel was not allowed." }
        : outside.action === "stripe.refund.create"
          ? { amount: 1, currency: "EUR", refund_reason: "requested_by_customer" }
          : { title: "This task must never be created", body: "Resource not allowed." };
    const { step: done } = await step(
      deps,
      agentId,
      {
        key: "outside",
        title: "Try an action outside the scope",
        explanation: outside.real
          ? "A resource the tool reaches, but that you did not choose. Oathrion must refuse BEFORE any call."
          : "A resource you did not choose (example identifier). Oathrion must refuse BEFORE any call.",
        action: outside.action,
        target: outside.target,
      },
      metadata,
    );
    steps.push(done);
  }

  return steps;
}

/**
 * Une cible hors périmètre : de préférence une ressource RÉELLE que l'outil atteint et
 * que le client n'a pas choisie — la démonstration est alors indiscutable. À défaut, un
 * identifiant d'exemple, et l'écran le dit (`real: false`).
 */
async function outsideTarget(
  plane: ConnectorPlane,
  connected: Set<string>,
  chosen: { slack: string | null; linear: string | null; github: string | null; stripe: string | null },
): Promise<{ action: string; target: string; real: boolean }> {
  /* Stripe en dernier : une clé n'atteint qu'un compte, la cible sera donc presque toujours un exemple. */
  const order: { id: "slack" | "linear" | "github" | "stripe"; action: string }[] = [
    { id: "slack", action: "slack.message.post" },
    { id: "linear", action: "linear.issue.create" },
    { id: "github", action: "github.issue.create" },
    { id: "stripe", action: "stripe.refund.create" },
  ];
  for (const { id, action } of order) {
    if (!connected.has(id) || !chosen[id]) continue;
    const connector = lookupConnector(id);
    const context = plane.contextFor(id);
    if (!connector?.resources || !context) continue;
    const listed = await connector.resources(context).catch(() => null);
    const other = listed?.ok ? listed.resources.find((r) => r.target !== chosen[id]) : undefined;
    if (other) return { action, target: other.target, real: true };
  }
  const first = order.find(({ id }) => connected.has(id) && chosen[id]) ?? order[0]!;
  return { action: first.action, target: OUTSIDE_PLACEHOLDER[first.id], real: false };
}

/**
 * La dernière étape : publier le résumé dans Slack, avec les liens de ce qui a
 * RÉELLEMENT été créé. Lancée après les approbations, puisque c'est leur résultat
 * qu'elle annonce.
 */
export async function notifyScenario(deps: ScenarioDeps, agentId: string, executionIds: string[]): Promise<ScenarioStep> {
  const policies = await deps.repositories.policies.list();
  const channel = readSelection("slack", policies).resources?.[0];
  if (!channel) throw new ScenarioError("No Slack channel is chosen: there is nowhere to post the summary.");

  const links: string[] = [];
  for (const id of executionIds.slice(0, 10)) {
    const execution = await deps.repositories.executions.findById(id);
    const url = execution?.toolResult?.url;
    if (execution && execution.agentId === agentId && typeof url === "string" && url.startsWith("https://")) {
      links.push(`• ${execution.action} : ${url}`);
    }
  }
  const text =
    "Oathrion · guided scenario summary\n" +
    (links.length > 0 ? links.join("\n") : "No write went through: nothing was created.") +
    "\nEvery action went through the team's Oathrion rules.";

  const { step: done } = await step(
    deps,
    agentId,
    {
      key: "notify",
      title: "Post the summary to Slack",
      explanation: "A post in the chosen channel, with links to what was really created.",
      action: "slack.message.post",
      target: channel,
    },
    { text },
  );
  return done;
}
