/**
 * L'agent que crée la console pour un ensemble d'outils connectés — le même modèle pour le
 * démarrage guidé et pour « Ajouter un agent existant ».
 *
 * Le mandat nomme les domaines des outils choisis et rien d'autre : toute autre
 * destination est bloquée. Les permissions sont celles des outils choisis, et seulement
 * elles ; le plafond de dépense reste à poser par l'équipe (aucun par défaut).
 */
import type { Agent, Permission } from "@/types";

export const TOOL_SCOPES: Record<string, { scope: Permission["scope"]; label: string; risk: Permission["risk"] }[]> = {
  github: [
    { scope: "read:repository", label: "Read repositories", risk: "low" },
    { scope: "write:repository", label: "Write repositories", risk: "medium" },
  ],
  slack: [
    { scope: "read:chat", label: "Read channels", risk: "medium" },
    { scope: "write:chat", label: "Post to channels", risk: "medium" },
  ],
  linear: [
    { scope: "read:tasks", label: "Read tasks", risk: "low" },
    { scope: "write:tasks", label: "Create tasks", risk: "medium" },
  ],
  stripe: [
    { scope: "read:payments", label: "Read payments", risk: "medium" },
    { scope: "execute:payments", label: "Refund payments", risk: "high" },
  ],
};

export const TOOL_DOMAIN: Record<string, string> = {
  github: "github.com",
  slack: "slack.com",
  linear: "linear.app",
  stripe: "stripe.com",
};

export function agentForTools(
  name: string,
  tools: string[],
  options: { description: string; provider?: Agent["provider"]; tags: string[] },
): Agent {
  const id = `agt_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  return {
    id,
    name,
    description: options.description,
    provider: options.provider ?? "custom",
    model: "agent-mcp",
    status: "active",
    owner: "team",
    mandate: {
      maxTransactionAmount: null,
      currency: "EUR",
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: tools.map((t) => TOOL_DOMAIN[t]!).filter(Boolean),
    },
    permissions: tools.flatMap((t) =>
      (TOOL_SCOPES[t] ?? []).map((p) => ({ scope: p.scope, label: p.label, description: "", granted: true, risk: p.risk })),
    ),
    policyIds: [],
    tags: options.tags,
  } as unknown as Agent;
}
