/**
 * CHIFFRER POUR LE TÉLÉPHONE (23 novembre, `notes/CONCEPTION-RELAIS-TELEPHONE.md`) : chaque
 * notification part chiffrée d'ici, pour le seul navigateur appairé (RFC 8291, « aes128gcm »).
 * Le relais d'Oathrion et le service de notifications du navigateur (Google, Apple, Mozilla) ne
 * transportent qu'un paquet qu'ils ne peuvent pas lire.
 */
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/** La taille d'enregistrement annoncée : un seul enregistrement, la notification entière. */
const RECORD_SIZE = 4096;

const info = (label: string) => Buffer.from(`Content-Encoding: ${label}\0`, "utf8");

/**
 * Le paquet chiffré : l'en-tête (le sel, la taille d'enregistrement, la clé éphémère de
 * l'expéditeur), puis la notification chiffrée par AES-128-GCM.
 * `p256dh` : la clé publique du navigateur ; `auth` : son secret, tous deux en base64url.
 */
export function encryptPush(payload: Uint8Array, subscription: { p256dh: string; auth: string }, salt: Buffer = randomBytes(16)): Buffer {
  const receiver = Buffer.from(subscription.p256dh, "base64url");
  const auth = Buffer.from(subscription.auth, "base64url");
  if (receiver.length !== 65 || auth.length !== 16) throw new Error("This phone's subscription keys are malformed.");
  const sender = createECDH("prime256v1");
  const senderPublic = sender.generateKeys();
  const shared = sender.computeSecret(receiver);
  /* RFC 8291 §3.4 : le secret partagé, lié au secret du navigateur et aux deux clés publiques. */
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), receiver, senderPublic]), 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, info("aes128gcm"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, info("nonce"), 12));
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  /* 0x02 : le dernier (et seul) enregistrement. */
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, sealed]);
}
