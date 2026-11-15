/**
 * Password hashing — P0-2.
 *
 * WHY THIS EXISTS
 * ---------------
 * Console passwords used to live in `OATHRION_CONSOLE_USERS` in cleartext and were
 * compared with a hash-then-`timingSafeEqual` of the plaintext. That is not a
 * password store: the secret is readable by anything that can read the process
 * environment (a crash dump, `/proc/<pid>/environ`, a CI log, a PaaS dashboard,
 * anyone with shell access), it cannot be rotated by the person it belongs to, and
 * it cannot be revoked without an operator editing a file and restarting.
 *
 * WHY SCRYPT AND NOT BCRYPT OR ARGON2
 * -----------------------------------
 * `crypto.scrypt` is in the Node standard library. bcrypt and argon2 are native
 * addons: they add a compiler to the deployment surface, they are the usual cause
 * of "npm install fails on the customer's host", and `npm audit` currently reports
 * zero vulnerabilities across this project — a number worth keeping. scrypt is
 * memory-hard, which is the property that matters against GPU cracking, and it is
 * an accepted choice for password storage (RFC 7914). Argon2id would be marginally
 * better; the difference does not justify a native dependency at this stage, and
 * the stored format below carries its own algorithm label so a future migration to
 * Argon2 can verify old hashes and re-hash on next sign-in without a flag day.
 *
 * STORED FORMAT
 * -------------
 *     scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>
 *
 * Self-describing on purpose. Parameters live *in* the hash rather than in a
 * constant, because raising the cost later must not invalidate every existing
 * password — old hashes keep verifying with the parameters they were made with.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * No pepper. A pepper only helps if it lives somewhere the database dump does not,
 * and in this deployment shape it would live in the same environment as the
 * database path — so it would add a rotation problem and no real protection. If
 * Oathrion later runs with a KMS, that is the point to add one.
 */

import crypto from "node:crypto";

/**
 * Cost parameters for *new* hashes.
 *
 * N = 16384 costs roughly 25-60 ms of CPU and 16 MB of memory per verification on
 * commodity hardware. That is the honest trade-off being made: high enough that
 * offline cracking of a leaked hash is expensive, low enough that a sign-in stays
 * interactive and that a login endpoint is not itself a memory-exhaustion vector —
 * ten concurrent attempts is 160 MB, which is survivable. The login throttle
 * (P0-7) is what keeps that number bounded.
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * `maxmem` must be raised explicitly: Node's 32 MB default is *below* what
 * N=16384, r=8 needs once its internal accounting is included, and the failure
 * mode is an exception at sign-in rather than a wrong answer. Computed from the
 * parameters instead of hardcoded so raising N cannot silently break verification
 * of hashes made with the larger value.
 */
function maxmemFor(n: number, r: number): number {
  return Math.max(64 * 1024 * 1024, n * r * 256);
}

/** Minimum length for a password a human chooses. Applies to changes, not to verification. */
export const MIN_PASSWORD_LENGTH = 12;

export class PasswordFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordFormatError";
  }
}

/**
 * Hashes a password for storage. Synchronous on purpose: it runs at boot (adopting
 * configured credentials) and inside a request that has nothing else to do, and a
 * synchronous call cannot interleave two hashes of the same password.
 */
export function hashPassword(password: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new PasswordFormatError("A password cannot be empty.");
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns `false` — never throws — for a malformed, truncated or unknown-algorithm
 * stored value. A corrupted row must fail closed and look exactly like a wrong
 * password to the caller, because the alternative is a 500 that tells an attacker
 * which accounts have a damaged hash.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Bounded before use: these numbers come from the database, and a row saying
  // N=2^40 would turn one sign-in attempt into a denial of service on the whole
  // process. Refusing is correct — such a row was not written by this code.
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  /*
   * Exact lengths, not merely non-empty.
   *
   * Deriving `expected.length` bytes and comparing them would otherwise accept a
   * truncated digest: a row holding the first 8 bytes of a real hash would verify,
   * and 8 bytes is brute-forceable. A short salt weakens the same way. Neither could
   * have been written by `hashPassword`, so refusing is the only honest answer.
   */
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, salt, KEY_LENGTH, {
      N: n,
      r,
      p,
      maxmem: maxmemFor(n, r),
    });
  } catch {
    return false;
  }

  // Equal lengths by construction (`expected.length` was requested), so this is a
  // genuine constant-time comparison rather than a length check in disguise.
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Whether a stored hash was produced with weaker parameters than the current ones.
 *
 * Used to re-hash on a successful sign-in, so raising the cost upgrades accounts as
 * their owners use them rather than requiring a password reset for everybody.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < SCRYPT_N || Number(parts[2]) < SCRYPT_R;
}

/**
 * A hash of a value nobody knows, used to spend the same CPU on a sign-in attempt
 * for an unknown e-mail as for a known one.
 *
 * Without this, "unknown account" returns in microseconds while "wrong password"
 * takes ~40 ms, and that difference is a reliable account-enumeration oracle over
 * the network — the endpoint would answer "does this person work here?" to anyone.
 * Computed once per process because it is not a secret; its only job is to cost the
 * same as a real verification.
 */
let decoy: string | null = null;

export function spendVerificationTime(password: string): void {
  decoy ??= hashPassword(crypto.randomBytes(32).toString("base64"));
  verifyPassword(password, decoy);
}

/**
 * Rejects passwords a human should not be allowed to set. Deliberately short:
 * length is the property that actually matters, and a long list of composition
 * rules pushes people towards `Password1!`.
 */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`A password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  if (password !== password.trim()) {
    // Same reasoning as the credential parser: leading or trailing whitespace is
    // ambiguous, and silently trimming it is what previously made correct-looking
    // passwords fail at sign-in.
    problems.push("A password cannot begin or end with a space.");
  }
  if (password.length > 256) {
    // An upper bound exists because scrypt cost grows with input length and this
    // endpoint is reachable by an authenticated caller.
    problems.push("A password cannot be longer than 256 characters.");
  }
  return problems;
}
