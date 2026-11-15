/**
 * Ce que le client CHOISIT en connectant un outil, traduit en règles Oathrion ordinaires.
 *
 * ## Pourquoi des règles, et pas un réglage du connecteur
 *
 * « Seulement ce dépôt », « seulement #produit », « seulement l'équipe ENG » : c'est une
 * décision d'autorisation, donc elle appartient au moteur de politiques — le seul endroit
 * qui décide. Une liste tenue par le connecteur serait une seconde autorité : elle
 * refuserait APRÈS la décision, l'exécution serait enregistrée « autorisée puis échouée »
 * au lieu de « bloquée », et la page des politiques ne la montrerait pas.
 *
 * Ici, le choix devient deux politiques aux identifiants stables, visibles et
 * désactivables sur l'écran Politiques comme n'importe quelle autre :
 *
 *   · `pol_placet_<outil>_perimetre` — BLOCK_TOOL sur l'hôte du service, SAUF les
 *     ressources choisies (`exceptTargets`). Sans choix, tout est bloqué : un outil
 *     connecté sans ressource choisie n'agit nulle part.
 *   · `pol_placet_<outil>_ecritures` — ce que deviennent les écritures dans le périmètre :
 *     approbation humaine (défaut), blocage, ou passage libre (règle désactivée).
 *
 * Les listes (`*.list`) restent hors du périmètre : voir quels canaux existent n'écrit
 * rien et sert précisément à choisir.
 *
 * Relire le choix se fait EN RELISANT CES POLITIQUES : il n'y a pas de seconde copie qui
 * pourrait dire autre chose que ce que le moteur applique.
 */

import type { Policy } from "@shared/types";
import { policyCreateContract, toPolicy } from "@shared/validation";

export type WriteMode = "approval" | "block" | "allow";

interface ToolShape {
  host: string;
  /** Les verbes soumis au périmètre (tout sauf la liste). */
  scoped: string[];
  /** Les verbes d'écriture. */
  writes: string[];
  /** Les cibles qu'un choix couvre : une ressource, et pour Linear ses issues. */
  targetsFor(resource: string): string[];
  /** Une ressource bien formée pour ce service, ou `null`. */
  normalize(resource: string): string | null;
  label: string;
}

const SHAPES: Record<string, ToolShape> = {
  github: {
    host: "github.com",
    label: "GitHub",
    scoped: ["github.repo.read", "github.issue.search", "github.issue.create", "github.issue.comment"],
    writes: ["github.issue.create", "github.issue.comment"],
    targetsFor: (r) => [r],
    normalize: (r) => {
      const v = r.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      return /^github\.com\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/i.test(v) ? v : null;
    },
  },
  slack: {
    host: "slack.com",
    label: "Slack",
    scoped: ["slack.history.read", "slack.message.post"],
    writes: ["slack.message.post"],
    targetsFor: (r) => [r],
    normalize: (r) => {
      const v = r.trim();
      return /^slack\.com\/[CG][A-Z0-9]{8,}$/.test(v) ? v : null;
    },
  },
  stripe: {
    host: "stripe.com",
    label: "Stripe",
    scoped: ["stripe.balance.read", "stripe.payments.list", "stripe.customers.search", "stripe.refund.create"],
    writes: ["stripe.refund.create"],
    /* Le compte, et ses paiements (`stripe.com/acct_…/pi_…`), pour un remboursement. */
    targetsFor: (r) => [r, `${r}/*`],
    normalize: (r) => {
      const v = r.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      return /^stripe\.com\/acct_[A-Za-z0-9]{6,40}$/.test(v) ? v : null;
    },
  },
  linear: {
    host: "linear.app",
    label: "Linear",
    scoped: ["linear.issue.search", "linear.issue.create", "linear.comment.create"],
    writes: ["linear.issue.create", "linear.comment.create"],
    targetsFor: (r) => [r, `${r}/*`],
    normalize: (r) => {
      const v = r.trim().replace(/^https?:\/\//i, "");
      const match = /^linear\.app\/([A-Za-z][A-Za-z0-9_]{0,9})$/.exec(v);
      return match ? `linear.app/${match[1]!.toUpperCase()}` : null;
    },
  },
};

export function guardrailShape(connectorId: string): ToolShape | undefined {
  return SHAPES[connectorId];
}

export function scopePolicyId(connectorId: string): string {
  return `pol_placet_${connectorId}_perimetre`;
}

export function writesPolicyId(connectorId: string): string {
  return `pol_placet_${connectorId}_ecritures`;
}

export class GuardrailError extends Error {}

/** Les deux politiques qui portent le choix. Validées par le MÊME contrat que l'API. */
export function guardrailPolicies(connectorId: string, resources: string[], writes: WriteMode): Policy[] {
  const shape = SHAPES[connectorId];
  if (!shape) throw new GuardrailError(`No scope is defined for "${connectorId}".`);
  if (resources.length > 25) throw new GuardrailError("Choose at most 25 resources.");

  const normalized: string[] = [];
  for (const resource of resources) {
    const value = shape.normalize(resource);
    if (value === null) throw new GuardrailError(`"${resource}" is not a recognized ${shape.label} resource.`);
    if (!normalized.includes(value)) normalized.push(value);
  }
  const except = normalized.flatMap((r) => shape.targetsFor(r));

  const scope = policyCreateContract.parse({
    id: scopePolicyId(connectorId),
    name: `${shape.label}: chosen resources only`,
    description:
      normalized.length === 0
        ? `No ${shape.label} resource is chosen: every action on ${shape.host} is blocked.`
        : `Agents only act on: ${normalized.join(", ")}. Everything else on ${shape.host} is blocked.`,
    type: "BLOCK_TOOL",
    condition: {
      kind: "targetMatches",
      targets: [shape.host],
      actions: shape.scoped,
      ...(except.length > 0 ? { exceptTargets: except } : {}),
    },
    scope: "organization",
    appliesTo: "all agents",
    effect: "block",
    status: "enabled",
    action: "BLOCK",
    risk: "high",
    priority: 90,
  });

  const writesPolicy = policyCreateContract.parse({
    id: writesPolicyId(connectorId),
    name:
      writes === "block"
        ? `${shape.label}: writes forbidden`
        : `${shape.label}: every write waits for approval`,
    description:
      writes === "allow"
        ? `Disabled: ${shape.label} writes within scope go through without approval.`
        : writes === "block"
          ? `No agent can write to ${shape.label}.`
          : `Every ${shape.label} write is held until a person approves it in Oathrion.`,
    type: writes === "block" ? "BLOCK_TOOL" : "REQUIRE_HUMAN_APPROVAL",
    condition: { kind: "targetMatches", targets: [shape.host], actions: shape.writes },
    scope: "organization",
    appliesTo: "all agents",
    effect: writes === "block" ? "block" : "require_approval",
    status: writes === "allow" ? "disabled" : "enabled",
    action: writes === "block" ? "BLOCK" : "APPROVAL_REQUIRED",
    risk: "medium",
    priority: 60,
  });

  return [toPolicy(scope), toPolicy(writesPolicy)];
}

export interface GuardrailSelection {
  /** `null` : aucun choix n'a jamais été enregistré pour cet outil. */
  resources: string[] | null;
  writes: WriteMode | null;
}

/** Relit le choix DANS LES POLITIQUES — la seule copie qui fait foi. */
export function readSelection(connectorId: string, policies: Policy[]): GuardrailSelection {
  const shape = SHAPES[connectorId];
  const scope = policies.find((p) => p.id === scopePolicyId(connectorId));
  const writes = policies.find((p) => p.id === writesPolicyId(connectorId));
  let resources: string[] | null = null;
  if (scope && shape) {
    const condition = scope.condition;
    const except = condition && condition.kind === "targetMatches" ? condition.exceptTargets ?? [] : [];
    resources = scope.status === "enabled" ? except.filter((t) => !t.endsWith("/*")) : null;
  }
  let mode: WriteMode | null = null;
  if (writes) {
    mode = writes.status !== "enabled" ? "allow" : writes.type === "BLOCK_TOOL" ? "block" : "approval";
  }
  return { resources, writes: mode };
}
