/**
 * L'export CSV de la chronologie (écran « Activity ») : chaque cellule entre guillemets, les
 * guillemets doublés. Une commande d'agent contient souvent des virgules et des guillemets ;
 * un CSV mal échappé décalerait les colonnes, et un audit illisible ne prouve rien.
 */
import type { ActivityEntry } from "./api";

const cell = (value: string | null) => `"${(value ?? "").replace(/"/g, '""')}"`;

export function toCsv(entries: readonly ActivityEntry[]): string {
  const header = ["at", "agent", "source", "action", "target", "outcome", "detail", "ref", "would_have_deleted"];
  return [header.join(","), ...entries.map((e) => [e.at, e.agent, e.source, e.action, e.target, e.outcome, e.detail, e.ref, e.impact ?? null].map(cell).join(","))].join("\n");
}
