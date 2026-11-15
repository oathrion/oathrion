/**
 * PROPOSER « DÉCIDER UNE FOIS » — après des approbations répétées du même outil.
 *
 * Approuver dix fois de suite la même écriture, c'est la preuve que la question ne sert plus à
 * rien : la carte le dit (« You approved this tool 4 times in a row ») et met en avant
 * « Approve, don't ask again ». Le choix reste à la personne ; un seul refus remet le compte à zéro ; une demande expirée ne compte pas (personne ne l'a vue).
 *
 * Seulement pour les outils d'un serveur derrière Oathrion (`mcp.<serveur>.…`) : c'est ce que le
 * pivot sait accorder. Les commandes du hook Claude Code (`mcp.claude-code.*`) en sont exclues :
 * chacune est une commande différente, et leurs règles vivent ailleurs.
 */
import type { Approval } from "@/types";

export const DECIDE_ONCE_AFTER = 3;

/** L'outil d'une demande : le titre avant « · » (« mcp.files.write file »). Null : pas proposable. */
export function toolOf(approval: Pick<Approval, "title">): string | null {
  const tool = approval.title.split(" · ")[0]!.trim();
  if (!tool.startsWith("mcp.") || tool.startsWith("mcp.claude-code.")) return null;
  return tool;
}

/** Combien de fois de suite cet agent a vu cet outil approuvé, juste avant cette demande. */
export function approvedInARow(approval: Approval, history: readonly Approval[]): number {
  const tool = toolOf(approval);
  if (tool === null) return 0;
  const decided = history
    .filter((a) => a.id !== approval.id && a.agentId === approval.agentId && (a.status === "approved" || a.status === "rejected") && toolOf(a) === tool)
    .sort((a, b) => (b.resolvedAt ?? b.requestedAt).localeCompare(a.resolvedAt ?? a.requestedAt));
  let count = 0;
  for (const a of decided) {
    if (a.status !== "approved") break;
    count += 1;
  }
  return count;
}

/** Le nombre à afficher sur la carte, ou null quand il n'y a rien à proposer. */
export function decideOnceSuggestion(approval: Approval, history: readonly Approval[]): number | null {
  if (approval.status !== "pending") return null;
  const count = approvedInARow(approval, history);
  return count >= DECIDE_ONCE_AFTER ? count : null;
}
