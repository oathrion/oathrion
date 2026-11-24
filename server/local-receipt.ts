/**
 * D'une ligne d'« Activity » à un reçu PARTAGEABLE (`shared/receipt-share.ts`) : la déclaration
 * — l'action, la décision, l'issue — et la preuve de sa chaîne au moment de l'export, à signer.
 *
 * Deux chaînes, nommées comme telles, comme dans la chronologie :
 *   · une action passée PAR Oathrion : l'historique chaîné de son exécution ;
 *   · une commande de Claude Code : les lignes chaînées du journal du hook.
 *
 * Fonction pure : la route lui passe l'entrée, la preuve et l'émetteur.
 */
import { plainStep } from "@shared/plain-step";
import { RECEIPT_TYPE, type ReceiptStatement } from "@shared/receipt-share";

import type { ActivityEntry, ActivityOutcome } from "./local-activity";

/** Les mêmes mots que la console (`client/src/pages/activity.tsx`). */
export const OUTCOME_LABEL: Record<ActivityOutcome, string> = {
  done: "Done",
  failed: "Failed",
  refused: "Refused by Oathrion",
  waiting: "Waiting for a person",
  "asked-done": "Asked, then done",
  "asked-failed": "Asked, then failed",
  "asked-not-run": "Asked, not run",
  "approved-done": "Approved by a person, done",
  "approved-failed": "Approved by a person, failed",
  "refused-by-person": "Refused by a person",
  "approved-not-run": "Approved by a person, not run yet",
  "not-run": "Not run",
  running: "Running",
};

export interface ChainEvidence {
  chain: string;
  entries: { seq: number | null; hash: string }[];
  chainIntact: boolean;
  chainEntries: number;
  chainHead: string | null;
}

export function receiptStatement(entry: ActivityEntry, evidence: ChainEvidence, issuer: ReceiptStatement["issuer"], issuedAt: string): ReceiptStatement {
  return {
    type: RECEIPT_TYPE,
    issuedAt,
    issuer,
    action: {
      at: entry.at,
      agent: entry.agent,
      via: entry.source === "claude-code" ? "Run by Claude Code itself, checked by Oathrion's hook" : "Through Oathrion",
      what: entry.action,
      target: entry.target,
      outcome: entry.outcome,
      outcomeLabel: OUTCOME_LABEL[entry.outcome],
      detail: entry.detail,
      impact: entry.impact ?? null,
      ref: entry.ref,
      todo: plainStep(entry.action, entry.target).todo,
    },
    evidence,
    ...(entry.phone ? { approval: entry.phone } : {}),
  };
}
