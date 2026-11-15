/**
 * Root-cause investigation for the historical "mot de passe incorrect" report.
 *
 * THE RULE THIS FILE OBEYS
 * ------------------------
 * The reported symptom is that an operator sets `OATHRION_CONSOLE_USERS`, types the
 * password they configured, and is told it is wrong. The temptation with a report
 * like that is a permissive fallback — trimming both sides, comparing
 * case-insensitively, falling back to a default user. Every one of those turns an
 * authentication bug into an authentication *vulnerability*. So this file's job is
 * to find the actual mechanism, prove it with a test, and fix only that.
 *
 * WHAT THE INVESTIGATION FOUND
 * ----------------------------
 * `parseTriples` splits `OATHRION_CONSOLE_USERS` on `,` and then on `:`, keeping
 * everything after the role as the secret, and finally calls `.trim()` on it. Three
 * distinct mechanisms follow from that, and they are NOT equally bad:
 *
 *   (a) **A comma in the password.** `Alice:admin:pa,ssword` splits into
 *       `Alice:admin:pa` and `ssword`. This is loud, not silent: the first fragment
 *       is too short and the second is not a triple, so both are recorded as
 *       problems and the server refuses to start. Loud is the correct posture, but
 *       the message says "the secret is shorter than 12 characters" — which is
 *       actively misleading when the operator's password is 20 characters long. The
 *       operator has no way to reach the real explanation from that text.
 *
 *   (b) **Leading or trailing whitespace in the password.** This one is silent and
 *       is the mechanism that actually produces "incorrect password" with a
 *       *running* server. `.trim()` means the stored secret differs from what the
 *       operator wrote, the config validates cleanly, boot succeeds, and login then
 *       fails forever. The operator sees a healthy server rejecting the exact string
 *       in their env file.
 *
 *   (c) **Two users sharing one password.** Login takes a password and no username,
 *       so the first configured match wins. That is not a rejected login — it is
 *       worse: the operator is silently signed in as somebody else, possibly with a
 *       different role.
 *
 * The fixes are correspondingly narrow: (a) and (b) become explicit, accurate
 * configuration errors at boot; (c) becomes a boot-time refusal. No comparison is
 * loosened anywhere, and `safeEqual` is untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authConfigNotices, authConfigProblems, login, resetAuthConfig } from "./auth";

/**
 * Since P0-2 a sign-in carries an e-mail address as well as a password, and a
 * configuration line that has no address gets one derived from the display name and
 * the organization. These tests configure users by name, exactly as a pre-P0-2
 * deployment does, so `signIn` resolves the derived address the same way the boot
 * notice tells the operator to.
 */
function derivedEmail(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug}@default.aria.local`;
}

/** Attempts a sign-in for a configured display name. Null when refused. */
function signIn(name: string, password: string) {
  return login(derivedEmail(name), password).session;
}

const VALID_SECRET = "test-session-secret-value-0123456789";

/** Snapshot and restore the environment so tests cannot leak into each other. */
const KEYS = ["OATHRION_SESSION_SECRET", "OATHRION_CONSOLE_USERS", "OATHRION_API_KEYS"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.OATHRION_SESSION_SECRET = VALID_SECRET;
  delete process.env.OATHRION_CONSOLE_USERS;
  delete process.env.OATHRION_API_KEYS;
  resetAuthConfig();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAuthConfig();
});

describe("a correctly configured password works", () => {
  it("signs in with the exact configured value", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:correct-horse-battery";
    resetAuthConfig();
    expect(authConfigProblems()).toEqual([]);

    const issued = signIn("Alice", "correct-horse-battery");
    expect(issued).not.toBeNull();
    expect(issued?.identity.role).toBe("admin");
    expect(issued?.identity.name).toBe("Alice");
  });

  it("accepts a password containing colons, since the split is bounded", () => {
    // Everything after the role is the secret, so a colon is not a delimiter. This
    // already worked and is asserted here so a future refactor cannot break it.
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:a:b:c:d:e:f:g:h";
    resetAuthConfig();
    expect(authConfigProblems()).toEqual([]);
    expect(signIn("Alice", "a:b:c:d:e:f:g:h")).not.toBeNull();
  });

  it("still refuses a wrong password, obviously", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:correct-horse-battery";
    resetAuthConfig();
    expect(signIn("Alice", "correct-horse-batteries")).toBeNull();
    expect(signIn("Alice", "")).toBeNull();
    expect(signIn("Alice", "CORRECT-HORSE-BATTERY")).toBeNull();
  });
});

/* -------------------------- (a) comma in the password ---------------------- */

describe("mechanism (a): a comma in the password", () => {
  it("is refused at boot rather than silently truncated", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:summer,2026,is-coming";
    resetAuthConfig();
    const problems = authConfigProblems();
    expect(problems.length).toBeGreaterThan(0);
  });

  it("says the password contains a comma, instead of blaming its length", () => {
    // This is the whole fix for (a). The old message was
    // "the secret for Alice is shorter than 12 characters", which is unactionable
    // when the operator is looking at a 20-character password. An operator who
    // cannot reach the real cause from the error text is an operator who ends up
    // adding a permissive fallback.
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:summer,2026,is-coming";
    resetAuthConfig();
    const joined = authConfigProblems().join("\n");
    expect(joined).toMatch(/comma/i);
  });

  it("never echoes the password fragments into the error text", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:summer,2026,is-coming";
    resetAuthConfig();
    const joined = authConfigProblems().join("\n");
    expect(joined).not.toContain("summer");
    expect(joined).not.toContain("is-coming");
  });
});

/* ---------------------- (b) whitespace in the password --------------------- */

describe("mechanism (b): whitespace around the password", () => {
  it("no longer silently changes the password the operator configured", () => {
    // THE HISTORICAL BUG. `.trim()` stored "spaced-out-password" while the operator
    // had written " spaced-out-password ". Config validated, the server booted
    // healthy, and every login attempt with the configured value failed.
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin: spaced-out-password ";
    resetAuthConfig();
    const problems = authConfigProblems();

    // Refused loudly at boot. The alternative designs were both worse: keeping the
    // whitespace makes the password undiscoverable from the env file, and trimming
    // silently is exactly the bug.
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/whitespace/i);
  });

  it("does not echo the password when reporting the whitespace", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin: spaced-out-password ";
    resetAuthConfig();
    expect(authConfigProblems().join("\n")).not.toContain("spaced-out-password");
  });

  it("still allows internal spaces, which are a legitimate passphrase choice", () => {
    // Only the edges are the problem. "four random common words" is good practice
    // and must keep working.
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:four random common words";
    resetAuthConfig();
    expect(authConfigProblems()).toEqual([]);
    expect(signIn("Alice", "four random common words")).not.toBeNull();
  });

  it("tolerates whitespace around the name and the role, which are not secrets", () => {
    // Operators format these lists across multiple lines. Trimming a role is
    // harmless because a role is compared against a closed set, not a secret.
    process.env.OATHRION_CONSOLE_USERS = " Alice : admin :correct-horse-battery";
    resetAuthConfig();
    expect(authConfigProblems()).toEqual([]);
    expect(signIn("Alice", "correct-horse-battery")?.identity.name).toBe("Alice");
  });
});

/* ------------------------ (c) two users, one password --------------------- */

describe("mechanism (c): a password shared between two users", () => {
  it("is refused at boot instead of silently signing in as the wrong person", () => {
    // Login takes a password and no username, so the first match won. An operator
    // configured as `viewer` could be handed an `admin` session, or vice versa —
    // a silent privilege confusion, not merely a failed login.
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:shared-password-value,Bob:viewer:shared-password-value";
    resetAuthConfig();
    const problems = authConfigProblems();
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/same secret|shared|duplicate/i);
  });

  it("refuses a console password that is also a service API key", () => {
    // The same confusion across the two lists: the credential resolves to whichever
    // list is consulted first, and the two lists can carry different roles.
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:shared-password-value";
    process.env.OATHRION_API_KEYS = "Robot:viewer:shared-password-value";
    resetAuthConfig();
    expect(authConfigProblems().join("\n")).toMatch(/same secret|shared|duplicate/i);
  });

  it("allows two users with different passwords, as normal", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:alice-password-value,Bob:viewer:bob-password-value";
    resetAuthConfig();
    expect(authConfigProblems()).toEqual([]);
    expect(signIn("Alice", "alice-password-value")?.identity.role).toBe("admin");
    expect(signIn("Bob", "bob-password-value")?.identity.role).toBe("viewer");
  });
});

/* ---------------------------- No permissive fallback ---------------------- */

/* -------------------- P0-2: the address the operator must type -------------- */

describe("a configuration written without an e-mail address", () => {
  it("tells the operator, at boot, exactly what to sign in with", () => {
    /*
     * Every deployment that predates P0-2 configures a display name, not an address.
     * Sign-in now needs an address, so an operator who is not told the derived one
     * cannot get in — a silent lockout on upgrade. The notice is non-fatal by design:
     * the deployment is valid, the operator just has to know one more thing.
     */
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:correct-horse-battery";
    resetAuthConfig();
    expect(authConfigProblems()).toEqual([]);

    const notices = authConfigNotices().join("\n");
    expect(notices).toContain(derivedEmail("Alice"));
    expect(notices).not.toContain("correct-horse-battery");
  });

  it("says nothing when the configuration already carries an address", () => {
    process.env.OATHRION_CONSOLE_USERS = "alice@example.com:admin:correct-horse-battery";
    resetAuthConfig();
    expect(authConfigProblems()).toEqual([]);
    expect(authConfigNotices()).toEqual([]);
    expect(login("alice@example.com", "correct-horse-battery").session).not.toBeNull();
  });

  it("resolves the address case-insensitively, as e-mail is in practice", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice@Example.COM:admin:correct-horse-battery";
    resetAuthConfig();
    expect(login("alice@example.com", "correct-horse-battery").session).not.toBeNull();
    expect(login("  ALICE@EXAMPLE.COM  ", "correct-horse-battery").session).not.toBeNull();
  });

  it("refuses two console users that resolve to one address", () => {
    // Both derive to alice@default.aria.local: one row, so the surviving role would
    // depend on adoption order. That is the (c) failure mode on the new identifier.
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:alice-password-value,alice:viewer:other-password-value";
    resetAuthConfig();
    expect(authConfigProblems().join("\n")).toMatch(/same sign-in address/i);
  });
});

describe("the fix introduces no permissive behaviour", () => {
  it("does not trim the submitted password to make a login succeed", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:correct-horse-battery";
    resetAuthConfig();
    // If the comparison had been loosened to "fix" the whitespace report, this
    // would pass. It must not.
    expect(signIn("Alice", "  correct-horse-battery  ")).toBeNull();
  });

  it("does not fall back to any default user when no console user is configured", () => {
    process.env.OATHRION_API_KEYS = "Robot:viewer:robot-api-key-value";
    resetAuthConfig();
    expect(authConfigProblems()).toEqual([]);
    // A valid config with zero console users must accept no password at all.
    expect(signIn("Robot", "robot-api-key-value")).toBeNull();
    expect(signIn("Robot", "admin")).toBeNull();
  });

  it("still refuses known demo credentials", () => {
    process.env.OATHRION_CONSOLE_USERS = "Alice:admin:placet-demo";
    resetAuthConfig();
    expect(authConfigProblems().length).toBeGreaterThan(0);
  });
});
