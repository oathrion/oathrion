/**
 * LA CLÉ DE SIGNATURE D'UNE PERSONNE, dans son navigateur (le mandat vérifiable, étape M2).
 *
 * Une clé Ed25519 créée par WebCrypto, NON EXPORTABLE, gardée dans IndexedDB : le navigateur peut
 * signer avec, personne ne peut la lire — ni une extension, ni le serveur d'Oathrion. Seule la clé
 * publique part au serveur, qui vérifie chaque signature. Perdre ce navigateur, c'est en créer une
 * nouvelle (les mandats déjà signés restent valides).
 */
import { canonical } from "@shared/canonical";

const DB = "oathrion-signing";
const STORE = "keys";

export function ed25519Supported(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined" && typeof crypto?.subtle?.generateKey === "function";
}

function database(): Promise<IDBDatabase> {
  return new Promise((done, fail) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => done(open.result);
    open.onerror = () => fail(open.error ?? new Error("IndexedDB is not available"));
  });
}

async function read(id: string): Promise<CryptoKeyPair | null> {
  const db = await database();
  return new Promise((done, fail) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    request.onsuccess = () => done((request.result as CryptoKeyPair | undefined) ?? null);
    request.onerror = () => fail(request.error ?? new Error("read failed"));
  });
}

async function write(id: string, pair: CryptoKeyPair): Promise<void> {
  const db = await database();
  await new Promise<void>((done, fail) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(pair, id);
    request.onsuccess = () => done();
    request.onerror = () => fail(request.error ?? new Error("write failed"));
  });
}

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

async function publicKeyOf(pair: CryptoKeyPair): Promise<string> {
  return b64(await crypto.subtle.exportKey("raw", pair.publicKey));
}

/** La clé publique que CE navigateur détient pour cette personne, ou null. */
export async function browserPublicKey(userId: string): Promise<string | null> {
  if (!ed25519Supported()) return null;
  const pair = await read(userId).catch(() => null);
  return pair ? publicKeyOf(pair) : null;
}

/** Crée la clé (la privée n'est pas exportable) et rend sa clé publique, à enregistrer. */
export async function createSigningKey(userId: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  await write(userId, pair);
  return publicKeyOf(pair);
}

/** Signe la forme canonique d'une valeur (un mandat) avec la clé de ce navigateur. */
export async function signCanonical(userId: string, value: unknown): Promise<string> {
  const pair = await read(userId);
  if (!pair) throw new Error("This browser does not hold your signing key.");
  return b64(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(canonical(value))));
}
