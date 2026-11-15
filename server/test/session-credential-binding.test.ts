/**
 * A session must not outlive the credential that opened it.
 *
 * `rbac.test.ts` already proves that a session dies the moment it is *explicitly*
 * revoked. This file covers the dimension that was missing, and that the
 * fault-injection bench (`script/chaos.ts`, scenario
 * `resilience/session-survives-restart`) found empirically: rotating or removing a
 * console user left every session it had issued fully usable for the remainder of
 * its 12-hour TTL.
 *
 * That is a revocation failure with a concrete operational shape. An operator whose
 * password has leaked cannot be locked out by changing it, and an operator removed
 * from `OATHRION_CONSOLE_USERS` keeps administrative access until a timer they cannot
 * see runs down. "Rotate the password" is the first thing anyone does during an
 * incident, and until this was fixed it did nothing.
 *
 * `resolveBearer` checked two things — the HMAC over the session id, and that the
 * session row was active. Neither depends on the password, so neither noticed.
 *
 * P0-2 moved passwords into the database, which put this property at risk a second
 * time: a stored row survives its configuration line being edited or deleted, so
 * without reconciliation "rotate the password" would silently stop working again.
 * The assertions below are unchanged in intent and now also cover the database path —
 * a password changed by its owner, a role demoted, an account suspended.
 *
 * Note on what is deliberately *not* changed: the session secret
 * (`OATHRION_SESSION_SECRET`) is a separate concern, and sessions surviving a plain
 * restart is correct behaviour that the bench confirms and that these tests protect.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changePassword, login, resetAuthConfig, resetLoginThrottle, resolveBearer } from "../auth";
import { userStore } from "../repositories/users";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { TEST_CONSOLE_EMAIL, TEST_CONSOLE_PASSWORD, TEST_VIEWER_EMAIL } from "./harness";

/** Signs in and fails loudly rather than returning a null the assertions must guard. */
function signIn(email = TEST_CONSOLE_EMAIL, password = TEST_CONSOLE_PASSWORD) {
  const { session, failure } = login(email, password);
  if (!session) throw new Error(`sign-in failed: ${failure}`);
  return session;
}

/** Restores the console-user list whatever the assertion did. */
function withConsoleUsers<T>(value: string | undefined, body: () => T): T {
  const original = process.env.OATHRION_CONSOLE_USERS;
  if (value === undefined) delete process.env.OATHRION_CONSOLE_USERS;
  else process.env.OATHRION_CONSOLE_USERS = value;
  resetAuthConfig();
  try {
    return body();
  } finally {
    if (original === undefined) delete process.env.OATHRION_CONSOLE_USERS;
    else process.env.OATHRION_CONSOLE_USERS = original;
    resetAuthConfig();
  }
}

describe("a session is bound to the credential that opened it", () => {
  beforeEach(() => {
    resetLoginThrottle();
    resetAuthConfig();
  });

  afterEach(() => {
    resetAuthConfig();
  });

  it("accepts a fresh session while the configuration is unchanged", () => {
    // The control. If this ever fails, the assertions below prove nothing.
    const issued = signIn();
    expect(resolveBearer(issued.token)).not.toBeNull();
  });

  it("refuses the session once that console password has been rotated", () => {
    const issued = signIn();
    expect(resolveBearer(issued.token)).not.toBeNull();

    withConsoleUsers(`${TEST_CONSOLE_EMAIL}:admin:a-freshly-rotated-password-9876`, () => {
      expect(resolveBearer(issued.token)).toBeNull();
    });
  });

  it("refuses the session once that console user has been removed entirely", () => {
    const issued = signIn();

    withConsoleUsers("someone.else@placet.test:admin:an-unrelated-password-4321", () => {
      expect(resolveBearer(issued.token)).toBeNull();
    });
  });

  it("keeps accepting the session when an unrelated user's password is rotated", () => {
    // Revocation must be targeted. Rotating one operator's password must not sign
    // every other operator out — that would make the fix worse than the flaw.
    const issued = withConsoleUsers(
      `${TEST_CONSOLE_EMAIL}:admin:${TEST_CONSOLE_PASSWORD},second@placet.test:operator:second-operator-password-1234`,
      () => signIn(),
    );

    withConsoleUsers(
      `${TEST_CONSOLE_EMAIL}:admin:${TEST_CONSOLE_PASSWORD},second@placet.test:operator:rotated-operator-password-5678`,
      () => {
        expect(resolveBearer(issued.token)).not.toBeNull();
      },
    );
  });

  it("still refuses a session whose signature was tampered with", () => {
    // Non-regression: the new credential check must not replace the HMAC check.
    const issued = signIn();
    const [id] = issued.token.split(".");
    expect(resolveBearer(`${id}.not-a-valid-signature`)).toBeNull();
  });

  /* ------- P0-2: the same property, through the database rather than the env ----- */

  it("refuses every other session the moment the owner changes their own password", () => {
    const first = signIn(TEST_VIEWER_EMAIL, "test-viewer-password");
    const second = signIn(TEST_VIEWER_EMAIL, "test-viewer-password");
    expect(resolveBearer(first.token)).not.toBeNull();

    const changed = changePassword(
      second.identity.id,
      "test-viewer-password",
      "a-brand-new-viewer-password-2468",
      second.identity.sessionId,
    );
    expect(changed.ok).toBe(true);

    // The other browser is dead, the tab that made the change is not.
    expect(resolveBearer(first.token)).toBeNull();
    expect(resolveBearer(second.token)).not.toBeNull();

    // Restore, so the configured password is the one the rest of the suite uses.
    expect(
      changePassword(
        second.identity.id,
        "a-brand-new-viewer-password-2468",
        "test-viewer-password",
        second.identity.sessionId,
      ).ok,
    ).toBe(true);
  });

  it("refuses the session as soon as the account is suspended", () => {
    const issued = signIn(TEST_VIEWER_EMAIL, "test-viewer-password");
    expect(resolveBearer(issued.token)).not.toBeNull();

    userStore.setStatus(issued.identity.id, "suspended");
    try {
      expect(resolveBearer(issued.token)).toBeNull();
    } finally {
      userStore.setStatus(issued.identity.id, "active");
    }
  });

  it("refuses the session as soon as the role behind it is demoted", () => {
    /*
     * The dangerous case is the opposite of a demotion taking effect too fast: an
     * admin demoted to viewer keeps admin capabilities until their token expires,
     * because the role is carried in the session row. The session must be refused so
     * a new one is issued with the current role.
     */
    const issued = signIn(TEST_VIEWER_EMAIL, "test-viewer-password");
    expect(resolveBearer(issued.token)?.role).toBe("viewer");

    userStore.grant(DEFAULT_ORGANIZATION_ID, issued.identity.id, "operator");
    try {
      expect(resolveBearer(issued.token)).toBeNull();
    } finally {
      userStore.grant(DEFAULT_ORGANIZATION_ID, issued.identity.id, "viewer");
    }
  });

  it("refuses the session once the membership behind it is revoked", () => {
    const issued = signIn(TEST_VIEWER_EMAIL, "test-viewer-password");
    expect(resolveBearer(issued.token)).not.toBeNull();

    userStore.revokeMembership(DEFAULT_ORGANIZATION_ID, issued.identity.id);
    try {
      expect(resolveBearer(issued.token)).toBeNull();
    } finally {
      userStore.grant(DEFAULT_ORGANIZATION_ID, issued.identity.id, "viewer");
    }
  });
});
