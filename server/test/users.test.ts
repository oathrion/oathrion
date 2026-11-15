/**
 * Accounts in the database, and what the environment is still allowed to do to them.
 *
 * P0-2 moved console users out of `OATHRION_CONSOLE_USERS` and into a `users` table, with
 * memberships binding a person to an organization and a role. That move has two ways
 * to go wrong, and both are covered here:
 *
 *   1. The environment stops being authoritative when it should not — an operator
 *      rotates a password in the env file and nothing happens, or deletes a line and
 *      the account keeps working. `session-credential-binding.test.ts` covers the
 *      session side; this file covers the account side.
 *   2. The environment stays authoritative when it must not — a user changes their own
 *      password and the next restart quietly puts the configured one back.
 *
 * Adoption also has to be idempotent, because it runs on every boot and on every
 * `resetAuthConfig()`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { changePassword, login, resetAuthConfig, resetLoginThrottle } from "../auth";
import { userStore } from "../repositories/users";
import { verifyPassword } from "../passwords";
import { ensureRivalOrganization } from "./rival-organization";

/** Runs `body` with a replaced console-user list, restoring it afterwards. */
function withConsoleUsers<T>(value: string, body: () => T): T {
  const original = process.env.OATHRION_CONSOLE_USERS;
  process.env.OATHRION_CONSOLE_USERS = value;
  resetAuthConfig();
  try {
    return body();
  } finally {
    if (original === undefined) delete process.env.OATHRION_CONSOLE_USERS;
    else process.env.OATHRION_CONSOLE_USERS = original;
    resetAuthConfig();
  }
}

const ADOPTED = "adopted@placet.test";
const ADOPTED_PASSWORD = "adopted-user-password-01";

beforeEach(() => {
  resetLoginThrottle();
  resetAuthConfig();
});

afterEach(() => {
  resetAuthConfig();
});

describe("adopting the configured console users", () => {
  it("creates one account per configured user, with a hashed password", () => {
    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      expect(login(ADOPTED, ADOPTED_PASSWORD).session).not.toBeNull();

      const stored = userStore.findByEmail(ADOPTED);
      expect(stored).not.toBeNull();
      expect(stored?.passwordSource).toBe("config");
      // The configured password is nowhere in the row, in any form.
      expect(JSON.stringify(stored)).not.toContain(ADOPTED_PASSWORD);
      expect(verifyPassword(ADOPTED_PASSWORD, stored!.passwordHash)).toBe(true);
    });
  });

  it("gives the account exactly the configured role, in the configured organization", () => {
    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      const issued = login(ADOPTED, ADOPTED_PASSWORD).session;
      expect(issued?.identity.role).toBe("operator");
      expect(issued?.identity.organizationId).toBe(DEFAULT_ORGANIZATION_ID);

      const memberships = userStore.membershipsOf(issued!.identity.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].role).toBe("operator");
    });
  });

  it("is idempotent — repeated boots neither duplicate the account nor change it", () => {
    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      login(ADOPTED, ADOPTED_PASSWORD);
      const after = userStore.findByEmail(ADOPTED);

      for (let i = 0; i < 3; i += 1) {
        resetAuthConfig();
        login(ADOPTED, ADOPTED_PASSWORD);
      }

      const again = userStore.findByEmail(ADOPTED);
      expect(again?.id).toBe(after?.id);
      // Same hash object, not merely a hash that still verifies: re-hashing on every
      // boot would invalidate every live session of that user at every restart.
      expect(again?.passwordHash).toBe(after?.passwordHash);
      expect(userStore.membershipsOf(again!.id)).toHaveLength(1);
    });
  });

  it("applies a password rotated in the configuration", () => {
    /*
     * The operator workflow that must not be lost. Editing the env file and
     * restarting is how a leaked console password is dealt with, and a stored row
     * would happily survive that edit if adoption did not overwrite it.
     */
    const rotated = "rotated-config-password-02";
    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      expect(login(ADOPTED, ADOPTED_PASSWORD).session).not.toBeNull();
    });

    withConsoleUsers(`${ADOPTED}:operator:${rotated}`, () => {
      expect(login(ADOPTED, rotated).session).not.toBeNull();
      expect(login(ADOPTED, ADOPTED_PASSWORD).session).toBeNull();
    });
  });

  it("applies a role changed in the configuration", () => {
    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      expect(login(ADOPTED, ADOPTED_PASSWORD).session?.identity.role).toBe("operator");
    });
    withConsoleUsers(`${ADOPTED}:viewer:${ADOPTED_PASSWORD}`, () => {
      expect(login(ADOPTED, ADOPTED_PASSWORD).session?.identity.role).toBe("viewer");
    });
  });

  it("suspends an account the configuration no longer lists", () => {
    // Deleting the line has to remove access, as it did before P0-2. The row survives
    // — the audit trail refers to it — but it can no longer sign in.
    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      expect(login(ADOPTED, ADOPTED_PASSWORD).session).not.toBeNull();
    });

    withConsoleUsers("someone.else@placet.test:admin:unrelated-password-0003", () => {
      const { session, failure } = login(ADOPTED, ADOPTED_PASSWORD);
      expect(session).toBeNull();
      expect(failure).toBe("account_suspended");
      expect(userStore.findByEmail(ADOPTED)?.status).toBe("suspended");
    });
  });

  it("reactivates the account if the configuration lists it again", () => {
    withConsoleUsers("someone.else@placet.test:admin:unrelated-password-0003", () => {
      login(ADOPTED, ADOPTED_PASSWORD);
    });
    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      expect(login(ADOPTED, ADOPTED_PASSWORD).session).not.toBeNull();
      expect(userStore.findByEmail(ADOPTED)?.status).toBe("active");
    });
  });
});

describe("a password the owner set is theirs, not the environment's", () => {
  it("survives a restart with the old configured password still in the env file", () => {
    /*
     * The mirror image of the rotation test, and the more dangerous one. If adoption
     * overwrote a self-chosen password, then every restart would silently reset it —
     * the user would be locked out by a value they never chose and cannot see, and the
     * old password (the one in the env file, possibly the leaked one) would work again.
     */
    const chosen = "the-password-i-chose-04";
    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      const issued = login(ADOPTED, ADOPTED_PASSWORD).session;
      expect(
        changePassword(issued!.identity.id, ADOPTED_PASSWORD, chosen, issued!.identity.sessionId).ok,
      ).toBe(true);
    });

    withConsoleUsers(`${ADOPTED}:operator:${ADOPTED_PASSWORD}`, () => {
      expect(login(ADOPTED, chosen).session).not.toBeNull();
      expect(login(ADOPTED, ADOPTED_PASSWORD).session).toBeNull();
      expect(userStore.findByEmail(ADOPTED)?.passwordSource).toBe("user");
    });
  });

  it("is not suspended by a configuration that no longer lists the account", () => {
    // Reconciliation only owns accounts it created. A user who set their own password
    // is not the environment's to revoke — P1 gives an admin an explicit way to do it.
    withConsoleUsers("someone.else@placet.test:admin:unrelated-password-0003", () => {
      expect(userStore.findByEmail(ADOPTED)?.status).toBe("active");
      expect(login(ADOPTED, "the-password-i-chose-04").session).not.toBeNull();
    });
  });
});

describe("changing one's own password", () => {
  const email = "changer@placet.test";
  const initial = "initial-changer-password-5";

  it("refuses the change when the current password is wrong", () => {
    withConsoleUsers(`${email}:viewer:${initial}`, () => {
      const issued = login(email, initial).session;
      const result = changePassword(issued!.identity.id, "not-the-current-one", "a-fine-new-password-6");
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("invalid_credentials");
      // Nothing changed: the old password still works.
      expect(login(email, initial).session).not.toBeNull();
    });
  });

  it("refuses an unknown user without touching anything", () => {
    withConsoleUsers(`${email}:viewer:${initial}`, () => {
      const result = changePassword("usr_does_not_exist", initial, "a-fine-new-password-6");
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("unknown_user");
    });
  });
});

describe("memberships bind a person to one organization at a time", () => {
  /*
   * A REGISTERED second organization. Only a registered, active organization counts as a
   * membership a session can be opened in — granting into an unknown organization is
   * deliberately inert, so using an invented id here would make the test prove nothing.
   *
   * It used to be created as a side effect of the API keys in `setup.ts`, whose
   * `Rival Corp/` prefix DERIVED the id `org_rival_corp`. Migration 18 removed that
   * derivation, so the row is created explicitly — with the same legacy id, which is
   * exactly the state of a deployment that predates the migration. See
   * `rival-organization.ts`.
   */
  const other = ensureRivalOrganization();
  const email = "multi@placet.test";
  const password = "multi-org-password-0007";

  it("refuses to guess when a user belongs to more than one organization", () => {
    /*
     * Guessing is the dangerous option: it would place someone in a tenant they did
     * not ask for, and every subsequent request would be scoped to the wrong data. The
     * organization picker is P1; until it exists the sign-in is refused, which is
     * visible and safe rather than silent and wrong.
     */
    withConsoleUsers(`${email}:viewer:${password}`, () => {
      const issued = login(email, password).session;
      expect(issued).not.toBeNull();

      userStore.grant(other, issued!.identity.id, "admin");
      try {
        const ambiguous = login(email, password);
        expect(ambiguous.session).toBeNull();
        expect(ambiguous.failure).toBe("ambiguous_organization");

        // With the hint, it works, and lands in exactly the organization asked for.
        const chosen = login(email, password, other).session;
        expect(chosen?.identity.organizationId).toBe(other);
        expect(chosen?.identity.role).toBe("admin");

        const home = login(email, password, DEFAULT_ORGANIZATION_ID).session;
        expect(home?.identity.organizationId).toBe(DEFAULT_ORGANIZATION_ID);
        expect(home?.identity.role).toBe("viewer");
      } finally {
        userStore.revokeMembership(other, issued!.identity.id);
      }
    });
  });

  it("refuses an organization the user is not a member of", () => {
    // Asking for a tenant you have no membership in must not work even with the
    // correct password — that is the cross-tenant attack, expressed at sign-in.
    withConsoleUsers(`${email}:viewer:${password}`, () => {
      const refused = login(email, password, other);
      expect(refused.session).toBeNull();
      expect(refused.failure).toBe("no_active_organization");
    });
  });

  it("lists the members of one organization and nobody else's", () => {
    withConsoleUsers(`${email}:viewer:${password}`, () => {
      const issued = login(email, password).session;
      userStore.grant(other, issued!.identity.id, "admin");
      try {
        const members = userStore.listMembers(other);
        expect(members.map((m) => m.email)).toEqual([email]);
        // The listing carries no hash, by construction of `PublicUser`.
        expect(JSON.stringify(members)).not.toContain("scrypt$");
      } finally {
        userStore.revokeMembership(other, issued!.identity.id);
      }
    });
  });

  it("knows whether an organization would be left without an admin", () => {
    /*
     * The guard P1's user management needs: removing the last admin of an
     * organization locks that customer out of their own tenant, and no support path
     * exists to undo it. Asserted here because the property belongs to the repository,
     * not to the route that will use it.
     */
    withConsoleUsers(`solo.admin@placet.test:admin:solo-admin-password-08`, () => {
      const issued = login("solo.admin@placet.test", "solo-admin-password-08").session;
      const id = issued!.identity.id;
      expect(userStore.hasAnotherActiveAdmin(DEFAULT_ORGANIZATION_ID, id)).toBe(false);

      const second = userStore.ensure({
        email: "second.admin@placet.test",
        name: "Second Admin",
        passwordHash: "scrypt$16384$8$1$" + "A".repeat(24) + "$" + "B".repeat(44),
        passwordSource: "user",
      });
      userStore.grant(DEFAULT_ORGANIZATION_ID, second.id, "admin");
      try {
        expect(userStore.hasAnotherActiveAdmin(DEFAULT_ORGANIZATION_ID, id)).toBe(true);
        // A suspended admin does not count — they cannot sign in to fix anything.
        userStore.setStatus(second.id, "suspended");
        expect(userStore.hasAnotherActiveAdmin(DEFAULT_ORGANIZATION_ID, id)).toBe(false);
      } finally {
        userStore.revokeMembership(DEFAULT_ORGANIZATION_ID, second.id);
      }
    });
  });
});
