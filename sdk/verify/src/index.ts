/**
 * @oathrion/verify — ce qu'une contrepartie (une banque, une API, une administration) intègre
 * pour accepter les actions d'agents porteuses d'un mandat Oathrion, et pour vérifier les reçus.
 *
 * Libre et gratuit, sans dépendance (seulement `node:crypto`), sans réseau : « gratuit pour
 * accepter » (`notes/MODELE-ECONOMIQUE.md`). Tout le cœur est `shared/mandate.ts` et
 * `shared/receipt-share.ts` ; ce module en est la surface publique, plus la lecture des en-têtes
 * HTTP que présente un agent.
 */
import {
  verifyPresentation,
  type Check,
  type MandateAction,
  type PresentationOptions,
  type SignedGrant,
  type SignedMandate,
} from "../../../shared/mandate";

export {
  actionHash,
  checkAction,
  countersign,
  fingerprintOfKey,
  /* Côté agent : contresigner l'autorisation reçue avec la clé que le mandat lui donne. */
  presentGrant,
  publicKeyOf,
  verifyCountersigned,
  /* Pour l'auditeur : le mandat, l'autorisation de l'émetteur et le reçu de la contrepartie, ensemble. */
  verifyDualReceipt,
  verifyMandate,
  verifyPresentation,
  verifyStatus,
  type Check,
  type Countersigned,
  type DualReceiptOptions,
  type DualReceipt,
  type MandateAction,
  type PresentationOptions,
  type RevocationStatus,
  type SignedGrant,
  type SignedMandate,
  type SignedStatus,
} from "../../../shared/mandate";
export { extractShared, verifyShared } from "../../../shared/receipt-share";

/** Les en-têtes qu'un agent présente avec sa requête. */
export const MANDATE_HEADER = "oathrion-mandate";
export const GRANT_HEADER = "oathrion-grant";

/** Une pièce signée, dans un en-tête HTTP : du JSON en base64url. */
export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeHeader<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Tout ce qu'une contrepartie fait avant d'exécuter : lire le mandat et l'autorisation dans les
 * en-têtes, puis les vérifier pour CETTE action. `headers` : des noms en minuscules (comme Node).
 */
export function verifyRequest(
  headers: Record<string, string | string[] | undefined>,
  action: MandateAction,
  options: PresentationOptions,
): Check & { mandate: SignedMandate | null; grant: SignedGrant | null } {
  const one = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const mandate = decodeHeader<SignedMandate>(one(MANDATE_HEADER));
  const grant = decodeHeader<SignedGrant>(one(GRANT_HEADER));
  if (!mandate || !grant) return { ok: false, reason: "no Oathrion mandate and authorization with this request", mandate, grant };
  return { ...verifyPresentation(mandate, grant, action, options), mandate, grant };
}
