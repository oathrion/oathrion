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
import { ReceiptChainVerifier } from "./authority/receipt-chain";
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

export async function verifyLocalReceipts(): Promise<LocalVerdict> {
  await initializeActionAuthority();
  const organization = organizationStore.findByName(LOCAL_ORGANIZATION);
  if (!organization) {
    return { ok: true, entries: 0, headHash: null, brokenAt: null, reason: null, lastExecutedAt: null, consumedWithoutReceipt: 0 };
  }
  const id = organization.id as OrganizationId;
  const { store } = authorityFor(id);
  const verifier = new ReceiptChainVerifier(id);
  let lastExecutedAt: string | null = null;
  for await (const batch of store.receiptChainBatches()) {
    for (const receipt of batch) {
      verifier.push(receipt);
      lastExecutedAt = receipt.executedAt;
    }
  }
  const verdict = verifier.verdict();
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
