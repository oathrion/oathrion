/**
 * `oathrion receipts verify` — la vérification COMPLÈTE de la chaîne de reçus d'un Oathrion
 * local, faite directement sur sa base SQLite, sans serveur.
 *
 * Appelée par `server/local-entry.ts` quand le paquet local est lancé avec
 * `--verify-receipts`. Elle relit toute la chaîne de l'espace « Oathrion local », par lots,
 * avec le même vérificateur que la route `GET /api/actions/receipts/verify`, et rend un
 * verdict en JSON sur la sortie standard.
 *
 * EN LECTURE SEULE. Elle n'avance pas le point de reprise de la vérification par étapes :
 * un `oathrion wrap` peut tourner en même temps sur la même base (SQLite en WAL accepte un
 * lecteur à côté d'un écrivain), et cette commande ne doit rien changer à ce qu'il écrit.
 */

import { authorityFor, initializeActionAuthority } from "./authority";
import { ReceiptChainVerifier, receiptEntryHash } from "./authority/receipt-chain";
import { LOCAL_ORGANIZATION } from "./local-bootstrap";
import { organizationStore } from "./repositories/organizations";
import type { OrganizationId } from "@shared/tenancy";

export interface LocalVerdict {
  ok: boolean;
  entries: number;
  headHash: string | null;
  brokenAt: number | null;
  reason: string | null;
  lastExecutedAt: string | null;
  /** Autorisations consommées dont le reçu manque. */
  consumedWithoutReceipt: number;
}

/**
 * Le point de reprise du BILAN (endurance du 16 novembre) : la console redemande le bilan
 * toutes les 15 s, et relire toute la chaîne à chaque fois coûtait 250 ms à 3 000 reçus,
 * une dizaine de secondes à 100 000. Entre deux relectures complètes, espacées de
 * `FULL_EVERY_MS` au plus, le bilan ne relit que les reçus écrits depuis, après avoir
 * vérifié que le dernier reçu déjà vérifié (l'ancre) est toujours celui-là. En mémoire de
 * ce processus seulement : la commande `oathrion receipts verify` relit toujours tout.
 */
const FULL_EVERY_MS = 10 * 60_000;
let checked: { organization: OrganizationId; entries: number; entrySeq: number; headHash: string; lastExecutedAt: string | null; fullAt: number } | null = null;

export async function verifyLocalReceipts(options: { sinceLastCheck?: boolean; now?: () => number } = {}): Promise<LocalVerdict> {
  const now = options.now ?? Date.now;
  await initializeActionAuthority();
  const organization = organizationStore.findByName(LOCAL_ORGANIZATION);
  if (!organization) {
    return { ok: true, entries: 0, headHash: null, brokenAt: null, reason: null, lastExecutedAt: null, consumedWithoutReceipt: 0 };
  }
  const id = organization.id as OrganizationId;
  const { store } = authorityFor(id);
  let from = options.sinceLastCheck && checked?.organization === id && now() - checked.fullAt < FULL_EVERY_MS ? checked : null;
  if (from) {
    /* L'ancre a changé : la relecture complète dira où et comment. */
    const anchor = await store.findReceiptBySeq(from.entrySeq);
    if (!anchor || anchor.entryHash !== from.headHash || receiptEntryHash(id, anchor) !== from.headHash) from = null;
  }
  const verifier = new ReceiptChainVerifier(id, from ? { entries: from.entries, headHash: from.headHash } : undefined);
  let lastExecutedAt = from?.lastExecutedAt ?? null;
  let lastSeq = from?.entrySeq ?? null;
  for await (const batch of from ? store.receiptChainBatchesAfter(from.entrySeq) : store.receiptChainBatches()) {
    for (const receipt of batch) {
      verifier.push(receipt);
      lastExecutedAt = receipt.executedAt;
      if (receipt.entrySeq !== null) lastSeq = receipt.entrySeq;
    }
  }
  const verdict = verifier.verdict();
  checked =
    verdict.ok && verdict.headHash !== null && lastSeq !== null
      ? { organization: id, entries: verdict.entries, entrySeq: lastSeq, headHash: verdict.headHash, lastExecutedAt, fullAt: from?.fullAt ?? now() }
      : null;
  const orphans = await store.consumedWithoutReceipt();
  return {
    ok: verdict.ok && orphans.count === 0,
    entries: verdict.entries,
    headHash: verdict.headHash,
    brokenAt: verdict.brokenAt,
    reason: verdict.ok && orphans.count > 0 ? `${String(orphans.count)} authorisation(s) consumed without a receipt` : verdict.reason,
    lastExecutedAt,
    consumedWithoutReceipt: orphans.count,
  };
}
