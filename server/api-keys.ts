/**
 * API key material — generation, hashing, display form. P0-5.
 *
 * ## Why this is NOT `server/passwords.ts`
 *
 * A password is a low-entropy secret chosen by a human, so it needs a deliberately
 * slow, salted KDF: scrypt exists to make a dictionary of the ten thousand most
 * common passwords expensive to try. An API key here is 32 bytes from the system CSPRNG.
 * There is no dictionary to try — an offline attacker holding the hash faces 2^256
 * candidates, and no amount of key stretching improves on that.
 *
 * What key stretching *would* do is put ~40 ms of scrypt on the authentication path of
 * every single machine request. That is not a micro-optimisation argument: the whole
 * product is a gateway that agents call in a loop, and a 40 ms floor per call would be
 * a design error introduced in the name of a security property the token's entropy
 * already provides. So: one SHA-256.
 *
 * This is the same reasoning behind how GitHub and Stripe store their tokens, and it is
 * the reason `hashKey` and `hashPassword` are separate functions rather than one
 * "hash a secret" helper — they are answers to two different questions.
 *
 * ## Why the hash is unsalted, and what that costs
 *
 * A per-row salt would prevent a stolen database from being attacked with a single
 * precomputed table. Against 256-bit random tokens there is no table to precompute, so
 * the salt buys nothing — and it would cost the one property that makes the hot path
 * cheap: with an unsalted digest, resolving a credential is a single indexed lookup
 * (`WHERE secret_hash = ?`). With a salt it becomes "read every row, hash the candidate
 * once per row", which is O(number of keys) hashes per request and turns a large key
 * inventory into a self-inflicted denial of service.
 *
 * THE HONEST CAVEAT: keys adopted from `OATHRION_API_KEYS` are *not* 32 random bytes. They
 * are whatever the operator typed, and a short guessable one would be recoverable from
 * a stolen database by dictionary attack. Two things bound that: the boot-time checks
 * already refuse a key shorter than `MIN_SECRET_LENGTH` or on the forbidden list, and
 * such a key's plaintext is sitting in the environment anyway, so the database hash is
 * not the weakest copy. Keys created through the product are always generated here.
 *
 * ## Why no pepper
 *
 * An HMAC keyed on `OATHRION_SESSION_SECRET` would defend the weak adopted keys described
 * above, and it would be free — same primitive, same cost. It is deliberately NOT done,
 * because it would silently couple two rotations that must stay independent: rotating
 * the session secret is a routine incident response that currently invalidates sessions,
 * and it would additionally invalidate every API key in the deployment **irreversibly** —
 * the plaintexts are gone, so nobody could re-derive them. Trading "every integration
 * breaks permanently, at the worst possible moment" for "a weak legacy key is harder to
 * crack in an already-catastrophic breach" is the wrong trade. Recorded here rather than
 * left as an unexplained absence.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Every generated key starts with this. It exists so a leaked string is *recognisable*:
 * secret scanners (GitHub's, GitLab's, and any grep an operator writes) match on a fixed
 * prefix, and a key pasted into a chat or a stack trace can be identified as a Oathrion
 * credential without anyone having to test it against the API.
 */
/**
 * Le préfixe d'une clé NOUVELLEMENT émise.
 *
 * Sûr à renommer, contrairement aux autres valeurs portant l'ancien nom, et il vaut de
 * dire pourquoi : une clé présentée est résolue par l'EMPREINTE de sa valeur entière
 * (`hashKey`), jamais par son préfixe. Une clé `aria_…` déjà émise continue donc de
 * fonctionner exactement comme avant, et la colonne `prefix` garde le fragment qui
 * décrit la clé telle qu'elle existe — ce qui est correct, puisqu'elle existe ainsi.
 *
 * Seul `displayPrefixOf` compare ce préfixe, et uniquement à l'émission, pour
 * distinguer une clé émise par cette fonction d'une clé adoptée depuis
 * l'environnement.
 */
export const KEY_PREFIX = "oathrion_";

/** 32 bytes. See the header: this is what makes a slow KDF unnecessary. */
const SECRET_BYTES = 32;

/**
 * How much of a generated key is stored in clear for display.
 *
 * The operator needs to tell two keys apart in a list, and after creation the only thing
 * they will ever see again is this fragment — so it has to be enough to match against
 * what they pasted into their deployment. Fifteen characters (`oathrion_` + 6) leaves
 * ~220 bits of the token unknown, which is not a meaningful reduction of 256.
 *
 * « Quinze » : `aria_` + 6 faisait onze, `placet_` + 6 treize. Chaque renommage a
 * allongé le préfixe, et la phrase comptait le total. Une arithmétique dans un
 * commentaire se périme en silence — ce commentaire l'a prouvé deux fois.
 */
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 6;

/**
 * The shortest credential that can be a key at all.
 *
 * Kept in step with `MIN_SECRET_LENGTH` in `server/auth.ts` — a key adopted from the
 * environment has already been checked against it, and one generated here is far longer.
 * It is re-stated as a guard so that a future code path that inserts a key without going
 * through either check still cannot store a two-character credential.
 */
export const MIN_KEY_LENGTH = 16;

/** A newly minted key. The plaintext exists only inside this object, once. */
export interface GeneratedKey {
  /** The full credential. Shown to the operator exactly once and never stored. */
  secret: string;
  /** What goes in the `secret_hash` column. */
  hash: string;
  /** What goes in the `prefix` column, and what the console lists afterwards. */
  displayPrefix: string;
}

export function generateKey(): GeneratedKey {
  // base64url: no `+`, `/` or `=`, so the key survives a URL, a shell argument, a YAML
  // scalar and a `.env` line without quoting or escaping. A key that has to be quoted
  // to be transported correctly is a key that will one day be transported incorrectly.
  const secret = KEY_PREFIX + randomBytes(SECRET_BYTES).toString("base64url");
  return {
    secret,
    hash: hashKey(secret),
    displayPrefix: displayPrefixOf(secret),
  };
}

/** The stored form of a credential. Deterministic, so lookup is a single indexed read. */
export function hashKey(secret: string): string {
  return `sha256$${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

/**
 * The fragment safe to show for a credential.
 *
 * A key adopted from `OATHRION_API_KEYS` gets **no** fragment of its own value: unlike a
 * generated key, its plaintext was never displayed to anyone in a browser, and it may be
 * a human-chosen string whose beginning is meaningful (`acme-prod-…`). Widening where it
 * appears — into a page, a screenshot, a support ticket — for the sake of a nicer list
 * is not worth it. `env:` is what the console shows instead, which also tells the
 * operator the truthful thing: this key is managed in the environment, not here.
 */
export function displayPrefixOf(secret: string): string {
  if (!secret.startsWith(KEY_PREFIX)) return "env:";
  return secret.slice(0, DISPLAY_PREFIX_LENGTH);
}

/**
 * Constant-time comparison of two stored digests.
 *
 * The lookup is by digest, so the database has already narrowed to one row and an
 * attacker cannot use the *result* to learn anything. This is still constant-time
 * because the comparison is the last gate before a credential is accepted, and a
 * length-dependent early return there is the kind of detail that becomes exploitable
 * after some later refactor moves the call. Cheap to be correct now.
 */
export function keyHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Why a candidate cannot be accepted as a key. Empty means acceptable. */
export function keyProblems(secret: string): string[] {
  const problems: string[] = [];
  if (secret.length < MIN_KEY_LENGTH) {
    problems.push(`must be at least ${MIN_KEY_LENGTH} characters`);
  }
  if (secret !== secret.trim()) {
    // Leading or trailing whitespace makes a credential that works when pasted from one
    // place and fails from another, with no diagnostic. Refused, not silently trimmed.
    problems.push("must not begin or end with whitespace");
  }
  return problems;
}
