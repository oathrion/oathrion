/**
 * The password module, on its own.
 *
 * `session-credential-binding.test.ts` proves what a password change does to a
 * session; this file proves the property underneath it: that a stored password cannot
 * be read back, that a malformed or unfamiliar stored value is refused rather than
 * accepted, and that the verification cost does not depend on whether the account
 * exists.
 *
 * The assertions are deliberately about the STORED FORMAT and about failing closed.
 * Those are the two things a well-meaning change breaks: someone lowers the cost
 * parameters to speed the test suite up, or someone adds a "legacy plaintext"
 * fallback to unblock a migration. Both are caught here.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  passwordProblems,
  spendVerificationTime,
  verifyPassword,
} from "../passwords";

const PASSWORD = "a-perfectly-decent-password";

describe("the stored form of a password", () => {
  it("is a scrypt digest with its parameters and a salt, never the password", () => {
    const hash = hashPassword(PASSWORD);
    const [algorithm, n, r, p, salt, digest] = hash.split("$");

    expect(algorithm).toBe("scrypt");
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    // 16 bytes of salt and 32 of digest, base64 — the lengths are what make a
    // precomputed table useless, so they are asserted rather than assumed.
    expect(Buffer.from(salt, "base64")).toHaveLength(16);
    expect(Buffer.from(digest, "base64")).toHaveLength(32);
    expect(hash).not.toContain(PASSWORD);
  });

  it("is different every time, so two people with one password have two hashes", () => {
    // Without a per-password salt, identical hashes in the table would tell an
    // attacker which accounts share a password, and one cracked hash would open all.
    const first = hashPassword(PASSWORD);
    const second = hashPassword(PASSWORD);
    expect(first).not.toBe(second);
    expect(verifyPassword(PASSWORD, first)).toBe(true);
    expect(verifyPassword(PASSWORD, second)).toBe(true);
  });

  it("verifies the exact password and nothing else", () => {
    const hash = hashPassword(PASSWORD);
    expect(verifyPassword(PASSWORD, hash)).toBe(true);
    expect(verifyPassword(`${PASSWORD} `, hash)).toBe(false);
    expect(verifyPassword(PASSWORD.toUpperCase(), hash)).toBe(false);
    expect(verifyPassword(PASSWORD.slice(0, -1), hash)).toBe(false);
    expect(verifyPassword("", hash)).toBe(false);
  });

  it("accepts a password with any byte in it, including colons and non-ASCII", () => {
    // The configuration format uses `:` and `,`, and the encoding uses `$`. None of
    // them may leak into what a password is allowed to contain.
    for (const password of ["a:b:c,d$e", "mot-de-passe-très-sûr", "🔐-emoji-passphrase-x", "  padded  "]) {
      expect(verifyPassword(password, hashPassword(password)), password).toBe(true);
    }
  });
});

describe("an unusable stored value fails closed", () => {
  it("refuses a row that is not a hash at all, rather than comparing plaintext", () => {
    /*
     * THE FAILURE THAT MATTERS. If a row somehow holds a plaintext password — a bad
     * import, a hand-written INSERT, a half-finished migration — the one behaviour
     * that must never happen is accepting it. Refusing locks out one account;
     * accepting turns the whole table into plaintext credentials.
     */
    for (const stored of [PASSWORD, "", "not-a-hash", "$$$$", "scrypt$", "scrypt$16384$8$1$only-five"]) {
      expect(verifyPassword(PASSWORD, stored), JSON.stringify(stored)).toBe(false);
    }
  });

  it("refuses an algorithm it does not implement", () => {
    // A future migration to argon2 must not silently degrade to "accept anything".
    const real = hashPassword(PASSWORD);
    const [, ...rest] = real.split("$");
    expect(verifyPassword(PASSWORD, ["argon2id", ...rest].join("$"))).toBe(false);
    expect(verifyPassword(PASSWORD, ["", ...rest].join("$"))).toBe(false);
  });

  it("refuses parameters outside the bounds instead of trying to honour them", () => {
    const [, , r, p, salt, digest] = hashPassword(PASSWORD).split("$");
    // N=2 would verify almost instantly: a stored row must not be able to choose a
    // cost low enough to be brute-forced, and N=2**30 must not be able to exhaust
    // the process's memory on an unauthenticated request.
    expect(verifyPassword(PASSWORD, ["scrypt", "2", r, p, salt, digest].join("$"))).toBe(false);
    expect(verifyPassword(PASSWORD, ["scrypt", "1073741824", r, p, salt, digest].join("$"))).toBe(false);
    expect(verifyPassword(PASSWORD, ["scrypt", "16384", "0", p, salt, digest].join("$"))).toBe(false);
    expect(verifyPassword(PASSWORD, ["scrypt", "16384", r, "99", salt, digest].join("$"))).toBe(false);
    expect(verifyPassword(PASSWORD, ["scrypt", "not-a-number", r, p, salt, digest].join("$"))).toBe(false);
  });

  it("refuses a truncated salt or digest", () => {
    const [algo, n, r, p, salt, digest] = hashPassword(PASSWORD).split("$");
    const shortSalt = Buffer.from(salt, "base64").subarray(0, 4).toString("base64");
    const shortDigest = Buffer.from(digest, "base64").subarray(0, 8).toString("base64");
    expect(verifyPassword(PASSWORD, [algo, n, r, p, shortSalt, digest].join("$"))).toBe(false);
    expect(verifyPassword(PASSWORD, [algo, n, r, p, salt, shortDigest].join("$"))).toBe(false);
  });
});

describe("cost upgrades", () => {
  it("does not ask for a rehash of a hash it just produced", () => {
    expect(needsRehash(hashPassword(PASSWORD))).toBe(false);
  });

  it("asks for a rehash of a hash cheaper than the current parameters", () => {
    const [algo, , r, p, salt, digest] = hashPassword(PASSWORD).split("$");
    expect(needsRehash([algo, "4096", r, p, salt, digest].join("$"))).toBe(true);
  });

  it("asks for a rehash of anything it cannot read, so the account self-heals", () => {
    expect(needsRehash("nonsense")).toBe(true);
    expect(needsRehash("")).toBe(true);
  });
});

describe("the cost of verifying is paid whether or not the account exists", () => {
  it("spends comparable time on an unknown address", () => {
    /*
     * Anti-enumeration. If a missing account returns in a microsecond and a real one
     * takes 40 ms, the sign-in endpoint answers "does this person have an account
     * here?" to anyone with a stopwatch — for a control plane, that is a customer
     * list.
     *
     * Timing on a shared CI runner is noisy, so the assertion is deliberately loose:
     * the decoy must be within an order of magnitude of a real verification, not
     * equal to it. A regression that skips the work entirely (microseconds) fails
     * this by a wide margin; scheduler jitter does not.
     */
    const hash = hashPassword(PASSWORD);

    // One warm-up of each, so the first-call cost of the native binding is not
    // attributed to whichever runs first.
    verifyPassword(PASSWORD, hash);
    spendVerificationTime(PASSWORD);

    const realStart = process.hrtime.bigint();
    for (let i = 0; i < 5; i += 1) verifyPassword("wrong-password-entirely", hash);
    const real = Number(process.hrtime.bigint() - realStart);

    const decoyStart = process.hrtime.bigint();
    for (let i = 0; i < 5; i += 1) spendVerificationTime("wrong-password-entirely");
    const decoy = Number(process.hrtime.bigint() - decoyStart);

    expect(decoy).toBeGreaterThan(real / 10);
    expect(decoy).toBeLessThan(real * 10);
  });

  it("returns nothing an attacker could read", () => {
    // Not `false`, not a hash: no value at all. Nothing about the decoy is usable.
    expect(spendVerificationTime(PASSWORD)).toBeUndefined();
  });
});

describe("what a new password is allowed to be", () => {
  it("requires a real length rather than a character-class ritual", () => {
    /*
     * Length is the only requirement, and it is deliberately higher than the usual
     * eight. Composition rules ("one uppercase, one digit, one symbol") push people
     * towards `Password1!` and towards writing passwords down; length is what
     * actually costs an attacker.
     */
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
    expect(passwordProblems("x".repeat(MIN_PASSWORD_LENGTH - 1)).length).toBeGreaterThan(0);
    expect(passwordProblems("four random common words")).toEqual([]);
  });

  it("refuses the passwords that are tried first", () => {
    for (const bad of ["password", "changeme", "aria-demo", "admin"]) {
      expect(passwordProblems(bad).length, bad).toBeGreaterThan(0);
    }
  });

  it("never echoes the rejected password in the reason", () => {
    // These strings end up in an HTTP response and in logs.
    const secret = "shortie";
    expect(passwordProblems(secret).join(" ")).not.toContain(secret);
  });
});
