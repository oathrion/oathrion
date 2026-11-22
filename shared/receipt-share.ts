/**
 * LE REÇU PARTAGEABLE — un reçu qu'une personne qui n'utilise pas Oathrion peut vérifier
 * (priorité du 6 novembre : « le moment waouh, c'est quand quelqu'un qui n'utilise pas Oathrion
 * fait confiance à un reçu Oathrion »).
 *
 * Un reçu partagé est une DÉCLARATION (`statement` : l'action, la décision, l'issue, et la
 * preuve de chaîne au moment de l'export) signée en Ed25519 par la clé de l'Oathrion qui l'a
 * émise. La signature porte sur la forme CANONIQUE de la déclaration (clés triées, JSON
 * compact) : le vérificateur du fichier HTML, celui de `oathrion receipt verify` et tout autre
 * la recalculent à l'identique.
 *
 * CE QUE ÇA PROUVE : la déclaration n'a pas changé d'un caractère depuis sa signature par la clé
 * dont l'empreinte est affichée. Et, une fois partagé, le reçu est une ancre HORS de la machine :
 * une réécriture ultérieure de la chaîne locale ne le rejoint plus.
 * CE QUE ÇA NE PROUVE PAS : que l'action a réellement eu lieu (c'est ce qu'Oathrion a
 * enregistré), ni QUI détient la clé — l'empreinte se compare à celle que l'émetteur a publiée.
 * En local, la clé est dans `~/.oathrion` : un agent qui lit ce dossier pourrait signer à sa
 * place (`docs/wrap.md`, ce qu'il ne fait pas).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RECEIPT_TYPE = "oathrion.receipt/v0";
/** Un PAQUET de reçus : tout ce qu'un agent a fait sur une branche (`server/local-bundle.ts`). */
export const BUNDLE_TYPE = "oathrion.bundle/v0";
/** Le RAPPORT d'une période : ce que les agents de la machine ont fait, compté (`server/local-report.ts`). */
export const REPORT_TYPE = "oathrion.report/v0";
const SIGNED_TYPES: readonly string[] = [RECEIPT_TYPE, BUNDLE_TYPE, REPORT_TYPE];

/** Ce que toute déclaration signée porte : son type et son émetteur. */
export interface SignedDocument {
  type: string;
  issuedAt: string;
  issuer: { name: string; publicKey: string; fingerprint: string };
}
export const SIGNING_KEY_FILE = "receipt-signing-key.pem";

export interface ReceiptStatement {
  type: typeof RECEIPT_TYPE;
  issuedAt: string;
  issuer: { name: string; publicKey: string; fingerprint: string };
  action: {
    at: string;
    agent: string;
    /** « Through Oathrion » ou « Run by Claude Code itself, checked by Oathrion's hook ». */
    via: string;
    what: string;
    target: string;
    outcome: string;
    outcomeLabel: string;
    detail: string | null;
    impact: string | null;
    ref: string;
  };
  evidence: {
    chain: string;
    /** Les empreintes de CETTE action dans sa chaîne. */
    entries: { seq: number | null; hash: string }[];
    chainIntact: boolean;
    chainEntries: number;
    chainHead: string | null;
  };
}

export interface Signed<T extends SignedDocument> {
  statement: T;
  /** Ed25519, base64, sur `canonical(statement)`. */
  signature: string;
}

export interface SharedReceipt {
  statement: ReceiptStatement;
  /** Ed25519, base64, sur `canonical(statement)`. */
  signature: string;
}

/** JSON aux clés triées, sans espace : une seule définition, que la console importe aussi (`shared/canonical.ts`). */
export { canonical } from "./canonical";
import { canonical } from "./canonical";

/** L'empreinte d'une clé publique (32 octets bruts) : SHA-256, 32 chiffres hexadécimaux par groupes de 4. */
export function fingerprintOf(publicKeyRaw: Buffer): string {
  return createHash("sha256").update(publicKeyRaw).digest("hex").slice(0, 32).match(/.{4}/g)!.join(" ");
}

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: string };
  return Buffer.from(jwk.x ?? "", "base64url");
}

/** La clé de signature de cet Oathrion : créée au premier usage, lisible par son seul propriétaire. */
export function signingKey(dir: string): { privateKey: KeyObject; publicKey: string; fingerprint: string } {
  const file = join(dir, SIGNING_KEY_FILE);
  let privateKey: KeyObject;
  if (existsSync(file)) privateKey = createPrivateKey(readFileSync(file, "utf8"));
  else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    privateKey = generateKeyPairSync("ed25519").privateKey;
    writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
  }
  const raw = rawPublicKey(privateKey);
  return { privateKey, publicKey: raw.toString("base64"), fingerprint: fingerprintOf(raw) };
}

export function signDocument<T extends SignedDocument>(statement: T, privateKey: KeyObject): Signed<T> {
  return { statement, signature: sign(null, Buffer.from(canonical(statement), "utf8"), privateKey).toString("base64") };
}

export function signStatement(statement: ReceiptStatement, privateKey: KeyObject): SharedReceipt {
  return signDocument(statement, privateKey);
}

export type ReceiptCheck = { ok: true; fingerprint: string } | { ok: false; reason: string };

/** Vérifie un reçu partagé, sans réseau et sans Oathrion : la clé est dans la déclaration, l'empreinte la nomme. */
export function verifyShared(shared: unknown): ReceiptCheck {
  const candidate = shared as Partial<Signed<SignedDocument>> | null;
  const statement = candidate?.statement;
  if (!statement || typeof candidate?.signature !== "string" || !SIGNED_TYPES.includes(statement.type)) return { ok: false, reason: "this is not an Oathrion receipt" };
  let raw: Buffer;
  let key: KeyObject;
  try {
    raw = Buffer.from(statement.issuer.publicKey, "base64");
    key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  } catch {
    return { ok: false, reason: "the issuer's key is unreadable" };
  }
  if (fingerprintOf(raw) !== statement.issuer.fingerprint) return { ok: false, reason: "the fingerprint shown does not match the issuer's key" };
  const valid = verify(null, Buffer.from(canonical(statement), "utf8"), key, Buffer.from(candidate.signature, "base64"));
  return valid ? { ok: true, fingerprint: statement.issuer.fingerprint } : { ok: false, reason: "the receipt was changed after it was signed" };
}

const OPEN = '<script type="application/json" id="oathrion-receipt">';

/** Le reçu contenu dans un fichier : le HTML partagé, ou le JSON seul. */
export function extractShared(text: string): unknown {
  const start = text.indexOf(OPEN);
  if (start === -1) return JSON.parse(text);
  const end = text.indexOf("</script>", start);
  return JSON.parse(text.slice(start + OPEN.length, end));
}

/** Le reçu, à placer dans `<script type="application/json">` sans pouvoir le refermer. */
export function embedShared(shared: SharedReceipt): string {
  return `${OPEN}${JSON.stringify(shared).replace(/</g, "\\u003c")}</script>`;
}
