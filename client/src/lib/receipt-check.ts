/**
 * Vérifier un reçu signé DANS CE NAVIGATEUR (WebCrypto, Ed25519), comme le fait le fichier HTML
 * du reçu (`server/receipt-share-html.ts`) : l'empreinte nomme bien la clé, et la signature porte
 * sur la forme canonique de la déclaration. Le serveur n'est pas cru sur parole : c'est le
 * navigateur de la personne qui refait le calcul, au moment où le reçu apparaît.
 */
import { canonical } from "@shared/canonical";
import type { SharedReceipt } from "@shared/receipt-share";

export type ReceiptVerdict = { ok: true } | { ok: false; reason: string } | { ok: null; reason: string };

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export async function checkReceipt(shared: SharedReceipt): Promise<ReceiptVerdict> {
  if (typeof crypto?.subtle?.importKey !== "function") return { ok: null, reason: "This browser cannot check signatures." };
  try {
    const raw = bytes(shared.statement.issuer.publicKey);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    if (hex.slice(0, 32).match(/.{4}/g)!.join(" ") !== shared.statement.issuer.fingerprint) return { ok: false, reason: "The fingerprint does not match the key that signed it." };
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, bytes(shared.signature), new TextEncoder().encode(canonical(shared.statement)));
    return valid ? { ok: true } : { ok: false, reason: "The receipt was changed after it was signed." };
  } catch {
    return { ok: null, reason: "This browser cannot check Ed25519 signatures." };
  }
}
