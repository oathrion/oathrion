/**
 * LES ACCORDS SIGNÉS PAR LE TÉLÉPHONE, gardés sur la machine (`shared/phone-approval.ts`).
 *
 * Un fichier à côté de la base, ligne à ligne : l'accord tel que le téléphone l'a signé, et la
 * décision qu'il tranche (l'exécution, l'approbation, la notification). Il n'a pas besoin de la
 * chaîne d'Oathrion pour être cru : chaque ligne se revérifie avec la clé de l'appareil, et une
 * ligne fausse ou abîmée est ignorée à la lecture.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { verifyPhoneApproval, type PhoneApproval } from "@shared/phone-approval";

export const PHONE_APPROVALS_FILE = "phone-approvals.jsonl";

export interface PhoneApprovalRecord {
  executionId: string | null;
  approvalId: string | null;
  eventId: string;
  approval: PhoneApproval;
}

export function recordPhoneApproval(dir: string, record: PhoneApprovalRecord): void {
  const file = join(dir, PHONE_APPROVALS_FILE);
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Les accords valides, par exécution et par approbation : le plus récent l'emporte. */
export function readPhoneApprovals(dir: string): Map<string, PhoneApproval> {
  const found = new Map<string, PhoneApproval>();
  const file = join(dir, PHONE_APPROVALS_FILE);
  if (!existsSync(file)) return found;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: Partial<PhoneApprovalRecord>;
    try {
      record = JSON.parse(line) as Partial<PhoneApprovalRecord>;
    } catch {
      continue;
    }
    if (!verifyPhoneApproval(record.approval).ok) continue;
    if (typeof record.executionId === "string" && record.executionId) found.set(record.executionId, record.approval!);
    if (typeof record.approvalId === "string" && record.approvalId) found.set(record.approvalId, record.approval!);
  }
  return found;
}
