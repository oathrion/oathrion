/**
 * LE BILAN — ce que les agents ont fait, en une page (priorité du 6 novembre : faire du reçu un
 * moment « waouh »).
 *
 * La chronologie (`local-activity.ts`) dit tout, ligne par ligne ; personne ne la lit d'un bout
 * à l'autre. Le bilan dit en trois nombres ce qui s'est passé sur une période — passé seul,
 * demandé à une personne, bloqué par Oathrion — et met en avant ce à quoi on a échappé : les
 * actions bloquées. La preuve vient avec : les deux chaînes (reçus d'Oathrion, journal du hook)
 * sont relues, et le bilan ne dit « rien n'a été modifié » que si elles le sont VRAIMENT.
 *
 * Fonction pure : la route (`/api/local/summary`) lui passe la chronologie et les verdicts.
 */

import type { ActivityEntry, ActivityOutcome } from "./local-activity";

export type SummaryBucket = "passed" | "asked" | "blocked";

/** Où range-t-on chaque issue : passée sans question, une personne a été sollicitée, bloquée par une règle. */
export const BUCKET: Record<ActivityOutcome, SummaryBucket> = {
  done: "passed",
  failed: "passed",
  running: "passed",
  "not-run": "passed",
  waiting: "asked",
  "asked-done": "asked",
  "asked-failed": "asked",
  "asked-not-run": "asked",
  "approved-done": "asked",
  "approved-failed": "asked",
  "approved-not-run": "asked",
  "refused-by-person": "asked",
  refused: "blocked",
};

export interface ChainVerdict {
  ok: boolean;
  entries: number;
  reason: string | null;
}

export interface Summary {
  since: string;
  until: string;
  total: number;
  passed: number;
  asked: number;
  /** Parmi les demandes : celles qu'une personne a refusées, et celles qui attendent encore. */
  refusedByPerson: number;
  waiting: number;
  blocked: number;
  /** Ce à quoi on a échappé : les actions bloquées par une règle, les plus récentes d'abord. */
  saves: ActivityEntry[];
  agents: { agent: string; total: number }[];
  proof: {
    receipts: ChainVerdict;
    journal: ChainVerdict;
    /** Les deux chaînes relues, et intactes. */
    intact: boolean;
  };
}

export function summarize(
  entries: readonly ActivityEntry[],
  options: { since: string; until: string; receipts: ChainVerdict; journal: ChainVerdict; maxSaves?: number },
): Summary {
  const inPeriod = entries.filter((entry) => entry.at >= options.since && entry.at <= options.until);
  const count = (bucket: SummaryBucket) => inPeriod.filter((entry) => BUCKET[entry.outcome] === bucket).length;
  const perAgent = new Map<string, number>();
  for (const entry of inPeriod) perAgent.set(entry.agent, (perAgent.get(entry.agent) ?? 0) + 1);
  return {
    since: options.since,
    until: options.until,
    total: inPeriod.length,
    passed: count("passed"),
    asked: count("asked"),
    refusedByPerson: inPeriod.filter((entry) => entry.outcome === "refused-by-person").length,
    waiting: inPeriod.filter((entry) => entry.outcome === "waiting").length,
    blocked: count("blocked"),
    saves: inPeriod
      .filter((entry) => entry.outcome === "refused")
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, options.maxSaves ?? 20),
    agents: [...perAgent].map(([agent, total]) => ({ agent, total })).sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent)),
    proof: { receipts: options.receipts, journal: options.journal, intact: options.receipts.ok && options.journal.ok },
  };
}
