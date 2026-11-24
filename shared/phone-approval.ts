/**
 * L'ACCORD SIGNÉ PAR LE TÉLÉPHONE — la seule preuve qu'Oathrion garde et que la machine ne peut
 * pas fabriquer seule (`notes/CONCEPTION-SAINT-GRAAL-RECUS.md`, lot 1).
 *
 * La page du téléphone (`relay/public/common.js`) garde sa propre clé (ECDSA P-256, non
 * exportable). À chaque décision, en plus de l'appui que le relais vérifie, elle signe :
 *
 *   oathrion-phone-v1|approval|<route>|<nonce>|<choix>|<heure du téléphone>|<empreinte de ce qu'elle a montré>
 *
 * L'empreinte (`shownDigest`) est calculée PAR LE TÉLÉPHONE, sur ce qu'il a affiché : l'agent,
 * l'ordinateur, le titre et la raison (jamais le contenu de la demande), l'heure de la demande.
 * Le pivot la recalcule sur ce qu'il a envoyé, vérifie la signature avec la clé de l'appareil
 * appairé, et garde l'accord. N'importe qui la revérifie ensuite, avec la seule clé publique.
 *
 * CE QUE ÇA PROUVE : un appareil appairé, dont la clé est nommée, a dit ce choix à ce texte-là.
 * CE QUE ÇA NE PROUVE PAS : qui tenait le téléphone ; que l'action exécutée est bien celle que
 * le texte décrit (la page la montre à côté, pour qu'on compare).
 */
import { createHash, createPublicKey, verify } from "node:crypto";

import { canonical } from "./canonical";

export const PHONE_APPROVAL_TYPE = "oathrion.phone-approval/v1";

/** Ce que le téléphone a affiché, tel qu'il l'a reçu. */
export interface PhoneShown {
  route: string;
  agent: string;
  computer: string;
  title: string;
  body: string;
  /** L'heure de la demande, en millisecondes (posée par l'ordinateur). */
  at: number;
}

export interface PhoneApproval {
  type: typeof PHONE_APPROVAL_TYPE;
  device: {
    /** La clé publique de l'appareil : P-256, 65 octets bruts, base64url. */
    publicKey: string;
    fingerprint: string;
    /** Le nom que le téléphone s'est donné à l'appairage (« Android phone ») : déclaré. */
    label: string;
  };
  shown: PhoneShown;
  nonce: string;
  /** Le bouton : « approve », « reject », « allow-hour »… */
  choice: string;
  /** L'heure du téléphone au moment de l'appui, en millisecondes. */
  at: number;
  /** ECDSA P-256 (r‖s), base64url. */
  signature: string;
}

/** Les champs affichés, ramenés à la même forme des deux côtés (une valeur absente devient vide). */
export function shownOf(data: Partial<Record<keyof PhoneShown, unknown>>): PhoneShown {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return { route: text(data.route), agent: text(data.agent), computer: text(data.computer), title: text(data.title), body: text(data.body), at: typeof data.at === "number" && Number.isFinite(data.at) ? data.at : 0 };
}

/** L'empreinte de ce qui a été montré : SHA-256 de la forme canonique, base64url. */
export function shownDigest(shown: PhoneShown): string {
  return createHash("sha256").update(canonical(shownOf(shown)), "utf8").digest("base64url");
}

/** Ce que le téléphone signe, sans le préfixe `oathrion-phone-v1|` que sa page ajoute. */
export function approvalData(input: { shown: PhoneShown; nonce: string; choice: string; at: number }): string {
  return `approval|${input.shown.route}|${input.nonce}|${input.choice}|${String(input.at)}|${shownDigest(input.shown)}`;
}

/** L'empreinte d'une clé d'appareil : SHA-256 des octets bruts, 32 chiffres hexadécimaux par groupes de 4. */
export function deviceFingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 32).match(/.{4}/g)!.join(" ");
}

/** La signature d'un appareil (ECDSA P-256, r‖s) sur `oathrion-phone-v1|<data>`. */
export function verifyDeviceSignature(publicKey: string, data: string, signature: string): boolean {
  try {
    const raw = Buffer.from(publicKey, "base64url");
    if (raw.length !== 65 || raw[0] !== 4) return false;
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    return verify("sha256", Buffer.from(`oathrion-phone-v1|${data}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export type PhoneApprovalCheck = { ok: true } | { ok: false; reason: string };

/** Revérifie un accord, sans réseau et sans Oathrion : la clé de l'appareil est dedans, l'empreinte la nomme. */
export function verifyPhoneApproval(approval: unknown): PhoneApprovalCheck {
  const candidate = approval as Partial<PhoneApproval> | null;
  if (!candidate || candidate.type !== PHONE_APPROVAL_TYPE || !candidate.device || !candidate.shown || typeof candidate.signature !== "string") return { ok: false, reason: "this is not a phone approval" };
  if (typeof candidate.device.publicKey !== "string" || deviceFingerprint(candidate.device.publicKey) !== candidate.device.fingerprint) return { ok: false, reason: "the fingerprint shown does not match the phone's key" };
  if (typeof candidate.nonce !== "string" || typeof candidate.choice !== "string" || typeof candidate.at !== "number") return { ok: false, reason: "this is not a phone approval" };
  const data = approvalData({ shown: shownOf(candidate.shown), nonce: candidate.nonce, choice: candidate.choice, at: candidate.at });
  return verifyDeviceSignature(candidate.device.publicKey, data, candidate.signature) ? { ok: true } : { ok: false, reason: "the phone did not sign this" };
}

/** Le bouton, en mots : ce que la page montre. */
export function choiceLabel(choice: string): string {
  return choice === "approve" ? "Approved" : choice === "reject" ? "Rejected" : choice === "allow-hour" ? "Allowed for 1 hour" : choice;
}
