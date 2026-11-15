/**
 * L'ALERTE POUR LES ACTIONS SANS REÇU.
 *
 * Une autorisation consommée dont le reçu n'a jamais été écrit est le seul trou que la
 * chaîne ne voit pas : processus tué entre l'appel au fournisseur et le reçu (`verify:faults`,
 * journal §5.29), ou patience du reçu épuisée. L'action a peut-être eu lieu chez le
 * fournisseur. `GET /api/actions/receipts/verify` les montre déjà ; ce module PRÉVIENT.
 *
 * Ce qu'il garantit :
 *   · une autorisation n'est signalée qu'après un DÉLAI DE GRÂCE — le temps maximal
 *     qu'un reçu légitime peut mettre à s'écrire (délai du fournisseur + patience du reçu
 *     + 30 s). Avant, ce n'est pas un trou, c'est une écriture en cours ;
 *   · chacune n'alerte qu'UNE fois, même avec plusieurs instances : elle est gardée dans
 *     la mémoire de la réconciliation (`reconcile_findings`, catégorie `receipt_gap`), dont
 *     l'`INSERT … ON CONFLICT DO NOTHING RETURNING` ne rend que les nouvelles ;
 *   · l'alerte part par les canaux de l'exploitant (webhook, Slack), et nomme
 *     l'organisation ; jamais d'argument d'action, seulement l'action, l'agent et l'instant.
 */
import type { EmitInput } from "../notifications";
import type { ReconcileStore, StoredFinding } from "../connectors/reconcile-store";
import { downstreamTimeoutMs } from "../gateway/tools/downstream-timeout";
import { receiptPatienceMs } from "./enforcement-point";
import type { ActionAuthorityStore } from "./store";

/** La mémoire de la réconciliation range ces écarts sous ce nom, qui n'est pas un connecteur. */
export const RECEIPT_GAP_SOURCE = "placet-receipts";

/** Le temps maximal qu'un reçu légitime peut mettre à s'écrire, plus une marge. */
export function receiptGapGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return downstreamTimeoutMs(env) + receiptPatienceMs(env) + 30_000;
}

/** Les écarts NOUVEAUX de cette organisation : ceux-là seulement donnent lieu à une alerte. */
export async function findNewReceiptGaps(input: {
  store: ActionAuthorityStore;
  findings: ReconcileStore;
  now?: Date;
  graceMs?: number;
}): Promise<StoredFinding[]> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - (input.graceMs ?? receiptGapGraceMs())).toISOString();
  const gaps = await input.store.consumedWithoutReceipt(500, cutoff);
  if (gaps.grants.length === 0) return [];
  return input.findings.addFindings(
    RECEIPT_GAP_SOURCE,
    gaps.grants.map((grant) => ({
      category: "receipt_gap" as const,
      item: {
        kind: "missing_receipt" as const,
        id: grant.id,
        url: null,
        createdAt: grant.consumedAt ?? "",
        actor: grant.agentId,
        summary: `${grant.action} by ${grant.agentId}, grant consumed without a receipt`,
        marker: null,
        byOathrionIdentity: true,
      },
    })),
    now,
  );
}

export function receiptGapAlert(organizationId: string, organizationName: string, fresh: StoredFinding[]): EmitInput {
  const lines = fresh.slice(0, 10).map((f) => `• ${f.id} — ${f.summary} (consumed on ${f.createdAt})`);
  if (fresh.length > 10) lines.push(`… and ${String(fresh.length - 10)} more.`);
  return {
    type: "receipt.gap",
    title: `Oathrion — ${String(fresh.length)} action(s) without a receipt (${organizationName})`,
    summary: lines.join("\n"),
    risk: "high",
    agentId: "",
    agentName: "",
    executionId: null,
    approvalId: null,
    policyId: null,
    policyName: null,
    data: {
      organizationId,
      organizationName,
      grants: fresh.map((f) => ({ grantId: f.id, agentId: f.actor, summary: f.summary, consumedAt: f.createdAt })),
    },
  };
}
