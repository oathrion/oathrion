/**
 * Envelope encryption for secrets at rest (S1).
 *
 * ## Scope — what is encrypted and what is deliberately not
 *
 * This protects values that are secret *to Oathrion's own database*: integration credentials,
 * webhook signing keys — material that grants access to a third-party system and that a
 * database dump would otherwise hand over in clear.
 *
 * It is NOT applied to passwords (scrypt-hashed, and hashing is the correct primitive:
 * they must not be recoverable), nor to API keys (also hashed), nor to the audit trail
 * (which must stay readable and verifiable — see `audit-chain.ts`), nor to ordinary
 * business rows. Encrypting everything indiscriminately would break the tenant-leading
 * index scans that make queries fast, and would protect nothing that is not already
 * protected by tenancy.
 *
 * ## Why two keys
 *
 * A **DEK** (data encryption key) is generated fresh for every value and encrypts that
 * value. A **KEK** (key encryption key) encrypts the DEK. The stored record holds the
 * ciphertext and the *wrapped* DEK; the plaintext DEK exists only in memory.
 *
 * The reason is rotation. Rotating the KEK means re-wrapping a small DEK per record — no
 * plaintext, no re-encryption of data, no downtime. Rotating a single key that encrypted
 * everything directly means decrypting and re-encrypting every row, which is why systems
 * built that way never rotate.
 *
 * A per-value DEK also bounds the damage of a nonce collision to one record, and keeps
 * the number of encryptions under any one key at one.
 *
 * ## Primitive
 *
 * AES-256-GCM for both layers: AEAD, so tampering is *detected* rather than producing
 * garbage plaintext. Unauthenticated modes (CBC, CTR) are not used — a modified
 * ciphertext must fail loudly, and for a credential store that is the whole requirement.
 *
 * 96-bit IVs from `randomBytes`, generated per operation and never derived, never
 * counted, never reused. GCM fails catastrophically on IV reuse under the same key: two
 * messages with one IV leak the XOR of their plaintexts and the authentication subkey.
 * Since each DEK encrypts exactly one value, IV reuse would additionally require the
 * random generator to repeat.
 *
 * ## Additional authenticated data — why a context is mandatory
 *
 * Both layers authenticate a `context` string that the caller supplies, typically
 * `integration:<organizationId>:<integrationId>`. It is not encrypted; it is bound.
 *
 * Without it, a ciphertext is a portable blob: an attacker with write access to the
 * database could copy tenant A's encrypted credential into tenant B's row and Oathrion would
 * decrypt it happily, because the bytes are authentic — just not *for that row*. Binding
 * the tenant and record identity into the AAD makes that substitution fail. The same
 * reasoning as the audit chain's tenant-derived genesis: authenticity is worth little
 * without identity.
 *
 * ## Storage format
 *
 * A single self-describing ASCII string, safe for a `text` column:
 *
 *     aria-env-v1.<kekId>.<wrapIv>.<wrappedDek>.<wrapTag>.<iv>.<ciphertext>.<tag>
 *
 * Eight dot-separated fields; every binary field is unpadded base64url, so no field can
 * contain the separator. Reading left to right:
 *
 *   - `aria-env-v1`  format version. A future format is a different prefix, so an old
 *                    record is never misparsed as a new one; `EnvelopeFormatError` names
 *                    the version it found.
 *   - `kekId`        which KEK wrapped this DEK. Not a secret; it is a label. This is
 *                    what makes rotation possible: a record says which key it needs.
 *   - `wrapIv`       96-bit IV for the DEK-wrapping operation.
 *   - `wrappedDek`   the 256-bit DEK, encrypted under the KEK.
 *   - `wrapTag`      128-bit GCM tag over the wrapped DEK.
 *   - `iv`           96-bit IV for the data encryption.
 *   - `ciphertext`   the value, encrypted under the DEK.
 *   - `tag`          128-bit GCM tag over the ciphertext.
 *
 * The plaintext length is not padded and is therefore observable from the ciphertext
 * length. For credentials this is accepted and stated rather than hidden.
 *
 * ## Key material and rotation
 *
 * KEKs arrive through `SecretProvider` — `OATHRION_KEK` for the active key, and
 * `OATHRION_KEK_<ID>` for retired keys still needed to read old records. **No key is stored
 * in this repository, generated with a default, or derived from a password.** A KEK is 32
 * random bytes, base64-encoded. Refusing anything else is why `loadKeyring` validates the
 * decoded length rather than accepting a short string that would silently weaken AES-256.
 *
 * Rotation, concretely:
 *
 *   1. Generate a new KEK and publish it as `OATHRION_KEK` with a new `OATHRION_KEK_ID`.
 *   2. Keep the previous key available as `OATHRION_KEK_<oldId>` so existing records still
 *      decrypt. Nothing is unreadable at any point; there is no migration window.
 *   3. Re-wrap at leisure with `rewrap`, which decrypts only the DEK under the old KEK and
 *      re-encrypts it under the new one. The data ciphertext, its IV and its tag are
 *      copied unchanged — the plaintext is never touched and never leaves storage.
 *   4. Once no record references the old `kekId`, remove that variable.
 *
 * **No KMS is involved and none is claimed.** There is no AWS KMS, no Cloud KMS, no
 * Vault transit engine here: the KEK is supplied by the environment through
 * `SecretProvider`. `rewrap` is the operation a KMS-backed provider would slot into
 * later, and `kekId` is the field that makes it possible.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { MissingSecretError, type SecretProvider } from "./provider";

/**
 * NE PAS RENOMMER avec le produit. Ce marqueur est écrit DANS chaque enveloppe déjà
 * stockée : le changer rendrait illisible tout enregistrement existant, et le message
 * d'erreur parlerait d'une version de format inconnue sans rien relier au renommage.
 * Les renommages ARIA → Placet → Oathrion l'ont donc laissé tel quel, comme toute valeur déjà écrite
 * (voir `docs/limitations.md`, « Ce qui porte encore l'ancien nom »). Un format futur
 * sera un préfixe différent — et ce sera une décision de format, pas de nom de produit.
 */
const FORMAT = "aria-env-v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FIELDS = 8;

export class EnvelopeFormatError extends Error {}
export class EnvelopeDecryptError extends Error {}
export class EnvelopeKeyError extends Error {}

/** The active key plus any retired keys still needed to read existing records. */
export interface Keyring {
  activeKekId: string;
  keys: ReadonlyMap<string, Buffer>;
}

function b64(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * `allowEmpty` is true only for the ciphertext, which is legitimately empty when the
 * protected value is the empty string. Every other field has a fixed size that the
 * per-field length checks below enforce, so an empty one is always corruption.
 */
function unb64(value: string, field: string, allowEmpty = false): Buffer {
  const pattern = allowEmpty ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9_-]+$/;
  if (!pattern.test(value)) {
    throw new EnvelopeFormatError(`Envelope field "${field}" is not base64url.`);
  }
  return Buffer.from(value, "base64url");
}

/**
 * Validates raw key material.
 *
 * A KEK that is 16 bytes because someone base64'd a passphrase would still "work" as far
 * as an operator can see, while giving AES-128 security under an AES-256 label. The
 * length is therefore checked, and the error never echoes the value.
 */
function decodeKek(name: string, encoded: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(encoded, "base64");
  } catch {
    throw new EnvelopeKeyError(`${name} is not valid base64. (The value is not shown.)`);
  }
  if (key.length !== KEY_BYTES) {
    throw new EnvelopeKeyError(
      `${name} decodes to ${key.length} bytes; AES-256-GCM requires exactly ${KEY_BYTES}.\n` +
        `  Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"\n` +
        `  A short key is refused rather than stretched: padding it would advertise AES-256 and deliver less.`,
    );
  }
  return key;
}

/**
 * Builds the keyring from the secret provider.
 *
 * `OATHRION_KEK` is the active key. `OATHRION_KEK_ID` names it (default `"1"`), and that name is
 * what gets written into every envelope. Retired keys are read from
 * `OATHRION_KEK_<id>` for each id listed in `OATHRION_KEK_RETIRED_IDS`, so that rotation never
 * requires a window in which old records cannot be read.
 */
export async function loadKeyring(secrets: SecretProvider): Promise<Keyring> {
  const activeKekId = (await secrets.getOptional("OATHRION_KEK_ID")) ?? "1";
  if (!/^[A-Za-z0-9_-]+$/.test(activeKekId)) {
    throw new EnvelopeKeyError(
      `OATHRION_KEK_ID must be alphanumeric (plus "_" and "-"): it is written into the envelope as a ` +
        `dot-separated field, so a dot or a colon in it would corrupt the format.`,
    );
  }

  const keys = new Map<string, Buffer>();
  keys.set(activeKekId, decodeKek("OATHRION_KEK", await secrets.get("OATHRION_KEK")));

  const retired = (await secrets.getOptional("OATHRION_KEK_RETIRED_IDS")) ?? "";
  for (const id of retired
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")) {
    if (id === activeKekId) continue;
    const name = `OATHRION_KEK_${id}`;
    const encoded = await secrets.getOptional(name);
    if (encoded === null) {
      throw new MissingSecretError(
        name,
        `OATHRION_KEK_RETIRED_IDS lists "${id}", so records encrypted under it exist and cannot be ` +
          `read without this key. Provide it, or remove "${id}" from the list only once no record references it.`,
      );
    }
    keys.set(id, decodeKek(name, encoded));
  }

  return { activeKekId, keys };
}

/**
 * AAD for the DEK-wrapping layer. Includes the `kekId`, so a wrapped DEK cannot be
 * replayed as if it had been wrapped by a different key.
 *
 * The format version is inside the AAD, not merely a prefix, so a record cannot be
 * replayed against a future format that parses the same fields differently.
 */
function wrapAad(kekId: string, context: string): Buffer {
  return Buffer.from(`${FORMAT}|dek|${kekId}|${context}`, "utf8");
}

/**
 * AAD for the data layer. Bound to the context but deliberately **NOT** to the `kekId`.
 *
 * This asymmetry is the whole reason envelope encryption pays off. If the data layer were
 * bound to the KEK that happened to be active at seal time, then rotating the KEK would
 * change the AAD and force the value itself to be decrypted and re-encrypted — which is
 * precisely the expensive, plaintext-exposing rotation that envelope encryption exists to
 * avoid. Leaving `kekId` out means `rewrap` re-encrypts 32 bytes of key material and
 * copies the ciphertext untouched.
 *
 * Nothing is weakened by the omission: which KEK wrapped the DEK is already authenticated
 * by `wrapAad`, and a DEK that did not authenticate never reaches the data layer.
 *
 * (An earlier draft of this module did include `kekId` here, and its `rewrap` silently
 * re-encrypted the plaintext while the documentation claimed it did not. The format was
 * corrected rather than the claim quietly dropped.)
 */
function dataAad(context: string): Buffer {
  return Buffer.from(`${FORMAT}|data|${context}`, "utf8");
}

/**
 * Encrypts `plaintext` under a fresh DEK, itself wrapped by the active KEK.
 *
 * `context` is mandatory and must identify the record — see the AAD note above. An empty
 * context is refused rather than defaulted, because a default would make every envelope
 * interchangeable and quietly remove the protection.
 */
export function sealSecret(
  keyring: Keyring,
  context: string,
  plaintext: string,
): string {
  if (context.trim() === "") {
    throw new EnvelopeFormatError(
      `A non-empty context is required. It binds the ciphertext to the row that owns it ` +
        `(for example "integration:org_acme:int_stripe"); without it an encrypted credential can be ` +
        `copied into another tenant's row and would still decrypt.`,
    );
  }
  if (context.includes(".")) {
    throw new EnvelopeFormatError(`The context must not contain "." — it would break the format.`);
  }

  const kekId = keyring.activeKekId;
  const kek = keyring.keys.get(kekId);
  if (kek === undefined) {
    throw new EnvelopeKeyError(`The active KEK "${kekId}" is not in the keyring.`);
  }

  // One DEK per value, used exactly once.
  const dek = randomBytes(KEY_BYTES);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  cipher.setAAD(dataAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const wrapIv = randomBytes(IV_BYTES);
  const wrapper = createCipheriv(ALGORITHM, kek, wrapIv);
  wrapper.setAAD(wrapAad(kekId, context));
  const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
  const wrapTag = wrapper.getAuthTag();

  // The plaintext DEK is not returned and not retained.
  dek.fill(0);

  return [
    FORMAT,
    kekId,
    b64(wrapIv),
    b64(wrappedDek),
    b64(wrapTag),
    b64(iv),
    b64(ciphertext),
    b64(tag),
  ].join(".");
}

interface ParsedEnvelope {
  kekId: string;
  wrapIv: Buffer;
  wrappedDek: Buffer;
  wrapTag: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * Structural parsing only. Nothing here is trusted; it establishes that the fields exist
 * and have the right shapes so that a malformed record is a clear `EnvelopeFormatError`
 * rather than an opaque OpenSSL failure.
 */
function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split(".");
  if (parts.length !== FIELDS) {
    throw new EnvelopeFormatError(
      `Expected ${FIELDS} dot-separated fields, found ${parts.length}. Not a Oathrion envelope.`,
    );
  }
  const [format, kekId, wrapIv, wrappedDek, wrapTag, iv, ciphertext, tag] = parts;
  if (format !== FORMAT) {
    throw new EnvelopeFormatError(
      `Unsupported envelope format "${format}"; this build reads "${FORMAT}". ` +
        `Formats are never guessed at \u2014 a record from another version is refused, not reinterpreted.`,
    );
  }
  if (kekId === "" || !/^[A-Za-z0-9_-]+$/.test(kekId)) {
    throw new EnvelopeFormatError(`Envelope field "kekId" is missing or malformed.`);
  }

  const parsed: ParsedEnvelope = {
    kekId,
    wrapIv: unb64(wrapIv, "wrapIv"),
    wrappedDek: unb64(wrappedDek, "wrappedDek"),
    wrapTag: unb64(wrapTag, "wrapTag"),
    iv: unb64(iv, "iv"),
    ciphertext: unb64(ciphertext, "ciphertext", true),
    tag: unb64(tag, "tag"),
  };

  for (const [field, expected, actual] of [
    ["wrapIv", IV_BYTES, parsed.wrapIv.length],
    ["wrapTag", TAG_BYTES, parsed.wrapTag.length],
    ["wrappedDek", KEY_BYTES, parsed.wrappedDek.length],
    ["iv", IV_BYTES, parsed.iv.length],
    ["tag", TAG_BYTES, parsed.tag.length],
  ] as const) {
    if (actual !== expected) {
      throw new EnvelopeFormatError(
        `Envelope field "${field}" is ${actual} bytes; expected ${expected}.`,
      );
    }
  }

  return parsed;
}

function kekFor(keyring: Keyring, kekId: string): Buffer {
  const kek = keyring.keys.get(kekId);
  if (kek === undefined) {
    throw new EnvelopeKeyError(
      `This record was encrypted under KEK "${kekId}", which is not in the keyring.\n` +
        `  Provide it as OATHRION_KEK_${kekId} and list "${kekId}" in OATHRION_KEK_RETIRED_IDS.\n` +
        `  Available: ${[...keyring.keys.keys()].join(", ")}.`,
    );
  }
  return kek;
}

/**
 * Unwraps the DEK, then decrypts the value.
 *
 * Every authentication failure — wrong KEK, altered ciphertext, altered wrapped DEK,
 * altered tag, wrong context — arrives here as a GCM tag mismatch and is reported as one
 * `EnvelopeDecryptError`. That is deliberate: distinguishing "wrong key" from "tampered
 * data" in the message would tell an attacker probing the store which of the two they
 * achieved. The distinction that IS surfaced is a missing key (`EnvelopeKeyError`), an
 * operational condition with no attacker value.
 *
 * A failure never returns a partial or fallback plaintext. There is no path through this
 * function that yields a value it could not authenticate.
 */
export function openSecret(keyring: Keyring, context: string, envelope: string): string {
  const parsed = parseEnvelope(envelope);
  const kek = kekFor(keyring, parsed.kekId);

  let dek: Buffer;
  try {
    const unwrapper = createDecipheriv(ALGORITHM, kek, parsed.wrapIv);
    unwrapper.setAAD(wrapAad(parsed.kekId, context));
    unwrapper.setAuthTag(parsed.wrapTag);
    dek = Buffer.concat([unwrapper.update(parsed.wrappedDek), unwrapper.final()]);
  } catch {
    throw new EnvelopeDecryptError(
      `The data key could not be unwrapped: wrong KEK, a different context, or the record was altered. ` +
        `(Which of these is not reported, so probing the store reveals nothing.)`,
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, dek, parsed.iv);
    decipher.setAAD(dataAad(context));
    decipher.setAuthTag(parsed.tag);
    const plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return plaintext;
  } catch {
    throw new EnvelopeDecryptError(
      `The value failed authentication: the ciphertext or its tag was altered. No plaintext is returned.`,
    );
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wraps an envelope's DEK under the active KEK, leaving the data ciphertext untouched.
 *
 * This is the rotation primitive. It decrypts the DEK only — 32 bytes — and copies the
 * ciphertext, IV and tag verbatim, so the protected value is never decrypted, never
 * materialised in memory, and never re-encrypted. A record already on the active KEK is
 * returned unchanged, which makes running rotation over the whole table idempotent and
 * resumable after an interruption.
 */
export function rewrap(keyring: Keyring, context: string, envelope: string): string {
  const parsed = parseEnvelope(envelope);
  if (parsed.kekId === keyring.activeKekId) return envelope;

  const oldKek = kekFor(keyring, parsed.kekId);
  const newKekId = keyring.activeKekId;
  const newKek = kekFor(keyring, newKekId);

  let dek: Buffer;
  try {
    const unwrapper = createDecipheriv(ALGORITHM, oldKek, parsed.wrapIv);
    unwrapper.setAAD(wrapAad(parsed.kekId, context));
    unwrapper.setAuthTag(parsed.wrapTag);
    dek = Buffer.concat([unwrapper.update(parsed.wrappedDek), unwrapper.final()]);
  } catch {
    throw new EnvelopeDecryptError(
      `Cannot re-wrap: the data key did not authenticate under KEK "${parsed.kekId}".`,
    );
  }

  try {
    // Only the 32-byte DEK is re-encrypted. A fresh wrapping IV is generated because the
    // new KEK must never reuse an IV, and the data fields are copied verbatim: the
    // protected value is not decrypted, not held in memory, and not re-encrypted.
    const wrapIv = randomBytes(IV_BYTES);
    const wrapper = createCipheriv(ALGORITHM, newKek, wrapIv);
    wrapper.setAAD(wrapAad(newKekId, context));
    const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
    const wrapTag = wrapper.getAuthTag();

    return [
      FORMAT,
      newKekId,
      b64(wrapIv),
      b64(wrappedDek),
      b64(wrapTag),
      b64(parsed.iv),
      b64(parsed.ciphertext),
      b64(parsed.tag),
    ].join(".");
  } finally {
    dek.fill(0);
  }
}

/** True when the string is shaped like a Oathrion envelope. Structural only, no key needed. */
export function isEnvelope(value: string): boolean {
  return value.startsWith(`${FORMAT}.`) && value.split(".").length === FIELDS;
}

/** Constant-time comparison, exported so callers do not hand-roll one. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
