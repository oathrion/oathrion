/**
 * The identity half of P2, end to end — and the honest measurement of what it does
 * and does not give the agent governance that Phase 4 will build on top of it.
 *
 * ## Why these tests build their own organization
 *
 * The last-admin guard is the interesting case in member management, and it cannot
 * be asserted inside `org_default`: the suite's other files create and remove users
 * there, so "is this the final administrator?" is a question whose answer depends on
 * which files ran first. Every test below therefore works inside a tenant created
 * here, with its own admin, its own members and its own tokens. That is not
 * isolation theatre — it is the only way these assertions mean the same thing on
 * every run.
 *
 * ## Twelve requested cases, mapped onto the code that actually exists
 *
 * The brief asked for twelve agent-identity cases. Nine of them are about an
 * identity an agent holds *itself*, and that identity does not exist in this build:
 * an agent is a row, a request names it in `agentId`, and the credential that
 * arrives belongs to a human or to a service key. Writing tests that pretend
 * otherwise would produce twelve green assertions about a mechanism nobody can use.
 * So each case is stated where it lands:
 *
 *   1. agent identity created         → NOT AN IDENTITY YET. `POST /api/agents`
 *      creates a row with no credential and a free-text `owner`. Phase 4.
 *   2. agent authenticates            → IMPOSSIBLE TODAY, and pinned as such below
 *      (`no credential can be bound to an agent`).
 *   3. agent belongs to an org        → covered, `tenant-isolation.test.ts`.
 *   4. agent of another org refused   → covered, `tenant-isolation.test.ts`.
 *   5. active agent accepted          → asserted below, through the policy engine.
 *   6. suspended agent refused        → asserted below as `paused`, which is the
 *      real vocabulary; `SUSPENDED` is Phase 4's renaming.
 *   7. revoked agent refused          → NO SUCH STATE. Pinned below so the day it is
 *      added, the pin fails and this comment gets updated.
 *   8. invalid credential refused     → asserted below for identity tokens; covered
 *      for API keys in `api-keys.test.ts`.
 *   9. credential rotation/revocation → asserted below for identity tokens.
 *  10. actor traceability            → covered, `actor-identity.test.ts`.
 *  11. human → agent delegation      → NOT SUPPORTED. Pinned below.
 *  12. multi-tenant isolation        → asserted below for tokens, on top of the
 *      four structural barriers in `tenant-isolation-structural.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { organizationStore } from "../repositories/organizations";
import { userStore } from "../repositories/users";
import { sessionStore } from "../repositories/sessions";
import { identityTokenStore, splitToken } from "../repositories/identity-tokens";
import { hashPassword } from "../passwords";
import { organizationId } from "@shared/tenancy";
import { rawDb } from "../db";
import { resetRateLimits } from "../rate-limit";

/** A tenant that exists only for this file. See the header. */
const ORG = organizationId("org_identity_p2");
const ADMIN_EMAIL = "p2-admin@placet.test";
/** Long enough for `passwordProblems`, and labelled so nobody mistakes it for real. */
const ADMIN_PASSWORD = "test-p2-admin-password-01";
const NEW_PASSWORD = "test-p2-replacement-pass-1";

interface LoginBody {
  token: string;
  identity: { id: string; organizationId: string; role: string };
}

interface IssueBody {
  invitation: { id: string; status: string; email: string; role: string };
  token: string;
}

interface ListBody {
  total: number;
  invitations: { id: string; status: string; email: string; purpose: string }[];
}

describe("P2 identity — invitations, resets, member lifecycle", () => {
  let api: TestClient;
  /** A signed-in administrator of `ORG`. Every management route needs a human. */
  let adminToken: string;
  let adminUserId: string;

  beforeAll(async () => {
    api = await startTestServer();

    organizationStore.ensure(ORG, "P2 Identity Test Org");
    const admin = userStore.ensure({
      email: ADMIN_EMAIL,
      name: "P2 Admin",
      passwordHash: hashPassword(ADMIN_PASSWORD),
      passwordSource: "user",
    });
    adminUserId = admin.id;
    userStore.grant(ORG, admin.id, "admin");

    const res = await api.post<LoginBody>(
      "/api/auth/login",
      { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, organization: ORG },
      { auth: null },
    );
    expect(res.status).toBe(200);
    adminToken = res.body.token;
  });

  /*
   * The redemption throttle is real and is deliberately NOT weakened for these
   * tests: several of them redeem a deliberately invalid token, and ten such
   * refusals from one address is the documented budget. The published test seam
   * clears the window between tests so each one starts from a known state — the
   * same thing `hardening.test.ts` does around the sign-in throttle. The throttle's
   * own behaviour is asserted explicitly further down, so clearing it here removes
   * cross-test interference without removing coverage.
   */
  beforeEach(() => {
    resetRateLimits();
  });

  afterAll(async () => {
    await api.close();
  });

  const asAdmin = () => ({ auth: adminToken });

  /** Issues an invitation and returns the one-time token. */
  async function invite(email: string, role = "viewer"): Promise<IssueBody> {
    const res = await api.post<IssueBody>("/api/invitations", { email, role }, asAdmin());
    expect(res.status).toBe(201);
    return res.body;
  }

  /* ------------------------------ Issuing ------------------------------ */

  describe("issuing", () => {
    it("returns the token exactly once and never again", async () => {
      const issued = await invite("p2-once@placet.test");
      expect(issued.token).toContain(".");
      expect(issued.invitation.status).toBe("pending");

      const list = await api.get<ListBody>("/api/invitations", asAdmin());
      expect(list.status).toBe(200);
      const listed = list.body.invitations.find((i) => i.id === issued.invitation.id);
      expect(listed).toBeDefined();
      // Structural: `PublicIdentityToken` has no secret field, so this cannot
      // regress by someone spreading a record into a response.
      expect(JSON.stringify(list.body)).not.toContain(issued.token);
      expect(JSON.stringify(list.body)).not.toContain(splitToken(issued.token)!.secret);
    });

    it("stores no value that can be presented as the token", async () => {
      const issued = await invite("p2-atrest@placet.test");
      const secret = splitToken(issued.token)!.secret;
      const row = rawDb
        .prepare(`SELECT * FROM identity_tokens WHERE id = ?`)
        .get(issued.invitation.id) as Record<string, unknown>;
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain(secret);
      expect(serialised).not.toContain(issued.token);
      // What IS stored is a digest, and it is prefixed so its nature is legible.
      expect(String(row.secret_hash)).toMatch(/^sha256\$[0-9a-f]{64}$/);
    });

    it("refuses a service credential, even one holding admin", async () => {
      /*
       * The same rule as `/api/keys`, and for the same reason: a machine credential
       * that can create human identities is a persistence mechanism that survives
       * the rotation of the key it came in through.
       */
      const res = await api.post(
        "/api/invitations",
        { email: "p2-machine@placet.test", role: "viewer" },
        { auth: ROLE_KEYS.admin },
      );
      expect(res.status).toBe(403);
    });

    it("refuses a role wider than the issuer's own", async () => {
      const viewerEmail = "p2-widening@placet.test";
      const issued = await invite(viewerEmail, "viewer");
      const accepted = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD, name: "P2 Viewer" },
        { auth: null },
      );
      expect(accepted.status).toBe(201);

      const viewerLogin = await api.post<LoginBody>(
        "/api/auth/login",
        { email: viewerEmail, password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(viewerLogin.status).toBe(200);

      // A viewer has no `manage`, so the capability gate refuses before the
      // role comparison is even reached — which is the correct order.
      const res = await api.post(
        "/api/invitations",
        { email: "p2-escalated@placet.test", role: "admin" },
        { auth: viewerLogin.body.token },
      );
      expect(res.status).toBe(403);
    });

    it("refuses a second outstanding invitation for the same address", async () => {
      const email = "p2-duplicate@placet.test";
      await invite(email);
      const again = await api.post("/api/invitations", { email, role: "viewer" }, asAdmin());
      expect(again.status).toBe(409);
    });

    it("refuses an invitation for somebody who is already a member", async () => {
      const res = await api.post(
        "/api/invitations",
        { email: ADMIN_EMAIL, role: "viewer" },
        asAdmin(),
      );
      expect(res.status).toBe(409);
    });
  });

  /* ----------------------------- Redeeming ----------------------------- */

  describe("redeeming", () => {
    it("creates the account, grants the role, and lets the person sign in", async () => {
      const email = "p2-joiner@placet.test";
      const issued = await invite(email, "operator");

      const accepted = await api.post<{ role: string; organizationId: string }>(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD, name: "P2 Joiner" },
        { auth: null },
      );
      expect(accepted.status).toBe(201);
      expect(accepted.body.role).toBe("operator");
      expect(accepted.body.organizationId).toBe(ORG);

      const signedIn = await api.post<LoginBody>(
        "/api/auth/login",
        { email, password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.identity.organizationId).toBe(ORG);
      expect(signedIn.body.identity.role).toBe("operator");

      // And only that organization: the roster they can read is their own.
      const members = await api.get<{ members: { email: string }[] }>("/api/members", {
        auth: signedIn.body.token,
      });
      expect(members.status).toBe(200);
      expect(members.body.members.map((m) => m.email)).toContain(email);
      expect(members.body.members.map((m) => m.email)).not.toContain("admin@placet.test");
    });

    it("issues no session, so an intercepted token yields no live access", async () => {
      const issued = await invite("p2-nosession@placet.test");
      const accepted = await api.post<Record<string, unknown>>(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      expect(accepted.status).toBe(201);
      expect(Object.keys(accepted.body)).not.toContain("token");
      expect(JSON.stringify(accepted.body)).not.toContain("expiresAt");
    });

    it("refuses a replay of an accepted token", async () => {
      const issued = await invite("p2-replay@placet.test");
      const first = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      expect(first.status).toBe(201);

      const second = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: NEW_PASSWORD },
        { auth: null },
      );
      expect(second.status).toBe(400);
    });

    it("lets exactly one of several simultaneous acceptances win", async () => {
      /*
       * The claim is an atomic conditional UPDATE, not a read-then-write. Without
       * that, two concurrent acceptances would both see `consumed_at IS NULL` and
       * both grant a membership. Five in flight at once is enough to expose a
       * read-then-write on SQLite.
       */
      const issued = await invite("p2-race@placet.test");
      const attempts = await Promise.all(
        [1, 2, 3, 4, 5].map(() =>
          api.post<Record<string, unknown>>(
            "/api/invitations/accept",
            { token: issued.token, password: ADMIN_PASSWORD },
            { auth: null },
          ),
        ),
      );
      expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
      expect(attempts.filter((r) => r.status === 400)).toHaveLength(4);
    });

    it("refuses an expired token", async () => {
      const issued = identityTokenStore.create({
        organizationId: ORG,
        purpose: "invite",
        email: "p2-expired@placet.test",
        role: "viewer",
        createdBy: "test",
        ttlMs: 60_000,
      });
      // Expired by moving the row's own expiry into the past, not by waiting: the
      // predicate under test is `expires_at > ?`, and the clock is not the subject.
      rawDb
        .prepare(`UPDATE identity_tokens SET expires_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 1000).toISOString(), issued.record.id);

      const res = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      expect(res.status).toBe(400);
      expect(userStore.findByEmail("p2-expired@placet.test")).toBeNull();
    });

    it("refuses a revoked token", async () => {
      const issued = await invite("p2-revoked@placet.test");
      const revoked = await api.del(`/api/invitations/${issued.invitation.id}`, asAdmin());
      expect(revoked.status).toBe(200);

      const res = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      expect(res.status).toBe(400);
      expect(userStore.findByEmail("p2-revoked@placet.test")).toBeNull();
    });

    it("refuses a real id carrying a wrong secret, and says nothing about which", async () => {
      const issued = await invite("p2-tampered@placet.test");
      const parts = splitToken(issued.token)!;

      const wrongSecret = await api.post<{ error: string }>(
        "/api/invitations/accept",
        { token: `${parts.id}.${"A".repeat(parts.secret.length)}`, password: ADMIN_PASSWORD },
        { auth: null },
      );
      const unknownId = await api.post<{ error: string }>(
        "/api/invitations/accept",
        { token: `idt_${"0".repeat(24)}.${parts.secret}`, password: ADMIN_PASSWORD },
        { auth: null },
      );

      expect(wrongSecret.status).toBe(400);
      expect(unknownId.status).toBe(400);
      // Identical answers. A different message for "that id exists" would let an
      // anonymous caller enumerate outstanding invitations.
      expect(wrongSecret.body.error).toBe(unknownId.body.error);
      // And the real token still works, so a failed attempt does not burn it.
      const accepted = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      expect(accepted.status).toBe(201);
    });

    it("refuses a weak password without consuming the token", async () => {
      const issued = await invite("p2-weak@placet.test");
      const weak = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: "short" },
        { auth: null },
      );
      expect(weak.status).toBe(400);

      // The invitation survives: burning a single-use token on a typo would force
      // the recipient to ask for another one for no reason.
      const good = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      expect(good.status).toBe(201);
    });

    it("throttles an address after ten refusals, and counts only refusals", async () => {
      /*
       * Both halves matter, and the second is why the first-cut middleware was
       * replaced. These routes are public, so the budget is keyed by address: at a
       * company whose staff all redeem their invitations from one office address,
       * counting successes would answer 429 to the eleventh new colleague. So:
       * refusals accumulate, valid redemptions never do.
       */
      resetRateLimits();
      const bad = { token: `idt_${"0".repeat(24)}.not-a-real-secret`, password: ADMIN_PASSWORD };
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const res = await api.post("/api/invitations/accept", bad, { auth: null });
        expect(res.status).toBe(400);
      }
      const eleventh = await api.post("/api/invitations/accept", bad, { auth: null });
      expect(eleventh.status).toBe(429);
      expect(eleventh.headers.get("retry-after")).not.toBeNull();

      // Twelve consecutive SUCCESSFUL redemptions, from the same address, with the
      // budget freshly cleared: every one of them is served.
      resetRateLimits();
      for (let n = 0; n < 12; n += 1) {
        const issued = await invite(`p2-office-${n}@placet.test`);
        const res = await api.post(
          "/api/invitations/accept",
          { token: issued.token, password: ADMIN_PASSWORD },
          { auth: null },
        );
        expect(res.status).toBe(201);
      }
    });

    it("stops working when the organization is suspended", async () => {
      const suspendedOrg = organizationId("org_identity_p2_off");
      organizationStore.ensure(suspendedOrg, "Suspended Org");
      const issued = identityTokenStore.create({
        organizationId: suspendedOrg,
        purpose: "invite",
        email: "p2-suspended-org@placet.test",
        role: "viewer",
        createdBy: "test",
      });
      organizationStore.setActive(suspendedOrg, false);

      const res = await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      expect(res.status).toBe(400);
      expect(userStore.findByEmail("p2-suspended-org@placet.test")).toBeNull();
    });
  });

  /* ------------------------------- Resets ------------------------------ */

  describe("password reset", () => {
    it("replaces the password and ends every session the account held", async () => {
      const email = "p2-reset@placet.test";
      const invited = await invite(email);
      await api.post(
        "/api/invitations/accept",
        { token: invited.token, password: ADMIN_PASSWORD },
        { auth: null },
      );

      const before = await api.post<LoginBody>(
        "/api/auth/login",
        { email, password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(before.status).toBe(200);

      const issued = await api.post<IssueBody>(
        "/api/invitations",
        { email, purpose: "reset" },
        asAdmin(),
      );
      expect(issued.status).toBe(201);

      const redeemed = await api.post<{ sessionsRevoked: number }>(
        "/api/auth/password/reset",
        { token: issued.body.token, password: NEW_PASSWORD },
        { auth: null },
      );
      expect(redeemed.status).toBe(200);
      expect(redeemed.body.sessionsRevoked).toBeGreaterThan(0);

      // The old session is dead server-side, not merely expired.
      const stale = await api.get("/api/auth/session", { auth: before.body.token });
      expect(stale.status).toBe(401);

      // The old password no longer works; the new one does.
      const oldPass = await api.post(
        "/api/auth/login",
        { email, password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(oldPass.status).toBe(401);
      const newPass = await api.post(
        "/api/auth/login",
        { email, password: NEW_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(newPass.status).toBe(200);
    });

    it("cannot be issued for somebody who is not a member of this organization", async () => {
      /*
       * `users` is deployment-wide by design, so without this check an
       * administrator of one tenant could mint a password change for an account
       * belonging to another — a tenant boundary crossed through the identity
       * layer rather than through a query.
       */
      const res = await api.post(
        "/api/invitations",
        { email: "admin@placet.test", purpose: "reset" },
        asAdmin(),
      );
      expect(res.status).toBe(404);
      // And nothing was written, so the absence is not observable by listing either.
      const list = await api.get<ListBody>("/api/invitations", asAdmin());
      expect(list.body.invitations.some((i) => i.email === "admin@placet.test")).toBe(false);
    });

    it("is refused after the member is suspended, even if issued before", async () => {
      const email = "p2-reset-suspended@placet.test";
      const invited = await invite(email);
      await api.post(
        "/api/invitations/accept",
        { token: invited.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      const user = userStore.findByEmail(email)!;

      const issued = await api.post<IssueBody>(
        "/api/invitations",
        { email, purpose: "reset" },
        asAdmin(),
      );
      expect(issued.status).toBe(201);

      const suspended = await api.patch(`/api/members/${user.id}`, { suspended: true }, asAdmin());
      expect(suspended.status).toBe(200);

      const res = await api.post(
        "/api/auth/password/reset",
        { token: issued.body.token, password: NEW_PASSWORD },
        { auth: null },
      );
      expect(res.status).toBe(400);
    });

    it("revokes outstanding tokens when a member is suspended", async () => {
      const email = "p2-token-sweep@placet.test";
      const invited = await invite(email);
      await api.post(
        "/api/invitations/accept",
        { token: invited.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      const user = userStore.findByEmail(email)!;

      const issued = await api.post<IssueBody>(
        "/api/invitations",
        { email, purpose: "reset" },
        asAdmin(),
      );
      await api.patch(`/api/members/${user.id}`, { suspended: true }, asAdmin());

      const token = identityTokenStore.findIn(ORG, issued.body.invitation.id);
      expect(token?.revokedAt).not.toBeNull();
    });
  });

  /* -------------------------- Member lifecycle ------------------------- */

  describe("member lifecycle", () => {
    /** Invites, accepts, and returns the new member's user id. */
    async function member(email: string, role = "viewer"): Promise<{ id: string; token: string }> {
      const invited = await invite(email, role);
      const accepted = await api.post(
        "/api/invitations/accept",
        { token: invited.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      expect(accepted.status).toBe(201);
      const signedIn = await api.post<LoginBody>(
        "/api/auth/login",
        { email, password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(signedIn.status).toBe(200);
      return { id: userStore.findByEmail(email)!.id, token: signedIn.body.token };
    }

    it("suspends a live session on its NEXT request, not at its next sign-in", async () => {
      const who = await member("p2-live-suspend@placet.test");
      const before = await api.get("/api/auth/session", { auth: who.token });
      expect(before.status).toBe(200);

      const patched = await api.patch<{ member: { membershipStatus: string } }>(
        `/api/members/${who.id}`,
        { suspended: true },
        asAdmin(),
      );
      expect(patched.status).toBe(200);
      expect(patched.body.member.membershipStatus).toBe("suspended");

      // The token was valid a moment ago and is refused now. Nothing was revoked:
      // `credentialStillValid` re-reads the membership on every request.
      const after = await api.get("/api/auth/session", { auth: who.token });
      expect(after.status).toBe(401);
    });

    it("refuses a suspended member's sign-in, then restores their role on reinstatement", async () => {
      const who = await member("p2-reinstate@placet.test", "approver");
      await api.patch(`/api/members/${who.id}`, { suspended: true }, asAdmin());

      const refused = await api.post(
        "/api/auth/login",
        { email: "p2-reinstate@placet.test", password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(refused.status).toBe(401);

      const restored = await api.patch(`/api/members/${who.id}`, { suspended: false }, asAdmin());
      expect(restored.status).toBe(200);

      const again = await api.post<LoginBody>(
        "/api/auth/login",
        { email: "p2-reinstate@placet.test", password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(again.status).toBe(200);
      // The role they had, not one an administrator had to remember. This is why the
      // membership row is suspended rather than deleted.
      expect(again.body.identity.role).toBe("approver");
    });

    it("suspends in one organization without touching another", async () => {
      /*
       * The reason suspension lives on the membership and not on `users.status`.
       * The same account is a member of two organizations; one suspends them, and
       * the other must be unaffected — otherwise one customer's decision reaches
       * into another customer's console.
       */
      const email = "p2-two-orgs@placet.test";
      const who = await member(email);
      const other = organizationId("org_identity_p2_two");
      organizationStore.ensure(other, "Second Org");
      userStore.grant(other, who.id, "viewer");

      await api.patch(`/api/members/${who.id}`, { suspended: true }, asAdmin());

      const here = await api.post(
        "/api/auth/login",
        { email, password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(here.status).toBe(401);

      const there = await api.post<LoginBody>(
        "/api/auth/login",
        { email, password: ADMIN_PASSWORD, organization: other },
        { auth: null },
      );
      expect(there.status).toBe(200);
      expect(there.body.identity.organizationId).toBe(other);
    });

    it("changes a role, and the change bites on the next request", async () => {
      const who = await member("p2-role-change@placet.test", "viewer");
      // A viewer cannot read the key inventory: `manage` is required.
      expect((await api.get("/api/keys", { auth: who.token })).status).toBe(403);

      const patched = await api.patch(`/api/members/${who.id}`, { role: "admin" }, asAdmin());
      expect(patched.status).toBe(200);

      /*
       * The old session is bound to the role it was opened with, and
       * `credentialStillValid` refuses one whose role no longer matches — so the
       * widening does NOT silently apply to a live token. It applies at the next
       * sign-in. That is the safe direction, and it is asserted rather than assumed.
       */
      expect((await api.get("/api/keys", { auth: who.token })).status).toBe(401);

      const again = await api.post<LoginBody>(
        "/api/auth/login",
        { email: "p2-role-change@placet.test", password: ADMIN_PASSWORD, organization: ORG },
        { auth: null },
      );
      expect(again.body.identity.role).toBe("admin");
      expect((await api.get("/api/keys", { auth: again.body.token })).status).toBe(200);

      // Put it back so the last-admin count below is not perturbed by this test.
      await api.patch(`/api/members/${who.id}`, { role: "viewer" }, asAdmin());
    });

    it("removes a member and ends their sessions in this organization only", async () => {
      const email = "p2-removed@placet.test";
      const who = await member(email);
      const other = organizationId("org_identity_p2_keep");
      organizationStore.ensure(other, "Keep Org");
      userStore.grant(other, who.id, "viewer");
      const elsewhere = await api.post<LoginBody>(
        "/api/auth/login",
        { email, password: ADMIN_PASSWORD, organization: other },
        { auth: null },
      );
      expect(elsewhere.status).toBe(200);

      const removed = await api.del(`/api/members/${who.id}`, asAdmin());
      expect(removed.status).toBe(200);

      expect((await api.get("/api/auth/session", { auth: who.token })).status).toBe(401);
      // The other organization's session survives: revoking it would be one tenant
      // signing somebody out of another's console.
      expect((await api.get("/api/auth/session", { auth: elsewhere.body.token })).status).toBe(200);
      // The user row survives too — the audit trail names this person as an actor.
      expect(userStore.findByEmail(email)).not.toBeNull();
      expect(userStore.membership(ORG, who.id)).toBeNull();
    });

    it("refuses to suspend, demote or remove the last active administrator", async () => {
      /*
       * All three, in one test, against the same subject: they share the guard, and
       * asserting only one would leave the other two able to reach a state no
       * tenant-facing endpoint can recover from — recovering it requires an admin.
       */
      expect(userStore.hasAnotherActiveAdmin(ORG, adminUserId)).toBe(false);

      const suspended = await api.patch(
        `/api/members/${adminUserId}`,
        { suspended: true },
        asAdmin(),
      );
      expect(suspended.status).toBe(409);

      const demoted = await api.patch(`/api/members/${adminUserId}`, { role: "viewer" }, asAdmin());
      expect(demoted.status).toBe(409);

      const removed = await api.del(`/api/members/${adminUserId}`, asAdmin());
      expect(removed.status).toBe(409);

      // Still able to administer, which is the point of the refusals.
      expect((await api.get("/api/invitations", asAdmin())).status).toBe(200);
    });

    it("allows the same three once a second administrator exists", async () => {
      const second = await member("p2-second-admin@placet.test", "admin");
      expect(userStore.hasAnotherActiveAdmin(ORG, adminUserId)).toBe(true);

      // Demote the SECOND one, not the first: this file's other tests need the
      // original admin to keep working.
      const demoted = await api.patch(`/api/members/${second.id}`, { role: "viewer" }, asAdmin());
      expect(demoted.status).toBe(200);
    });

    it("reports 404, never 403, for a member of another organization", async () => {
      const stranger = userStore.findByEmail("admin@placet.test");
      expect(stranger).not.toBeNull();
      const res = await api.patch(
        `/api/members/${stranger!.id}`,
        { suspended: true },
        asAdmin(),
      );
      // 403 would confirm that the guessed id exists somewhere in the deployment.
      expect(res.status).toBe(404);
      expect(userStore.membership(organizationId("org_default"), stranger!.id)).not.toBeNull();
    });
  });

  /* ----------------------------- Isolation ----------------------------- */

  describe("multi-tenant isolation of identity tokens", () => {
    it("does not list one organization's invitations to another's admin", async () => {
      const issued = await invite("p2-not-yours@placet.test");
      const theirs = await api.get<ListBody>("/api/invitations", { auth: OTHER_ORG_KEYS.admin });
      expect(theirs.status).toBe(200);
      expect(theirs.body.invitations.map((i) => i.id)).not.toContain(issued.invitation.id);
      expect(theirs.body.invitations.some((i) => i.email === "p2-not-yours@placet.test")).toBe(false);
    });

    it("makes a foreign token unreadable and unrevocable through the scoped store", async () => {
      const issued = await invite("p2-foreign@placet.test");
      const rival = organizationId("org_rival_corp");
      expect(identityTokenStore.findIn(rival, issued.invitation.id)).toBeUndefined();
      expect(identityTokenStore.revoke(rival, issued.invitation.id, "rival admin")).toBe(false);
      // Untouched, and still usable by its real recipient.
      expect(identityTokenStore.findIn(ORG, issued.invitation.id)?.revokedAt).toBeNull();
    });

    it("binds a redeemed invitation to the organization that issued it, and no other", async () => {
      const email = "p2-bound@placet.test";
      const issued = await invite(email, "operator");
      await api.post(
        "/api/invitations/accept",
        { token: issued.token, password: ADMIN_PASSWORD },
        { auth: null },
      );
      const user = userStore.findByEmail(email)!;
      /*
       * The organization is read out of the token row, never from the request. There
       * is no field an anonymous caller could set to land in a different tenant, so
       * the assertion is that exactly one membership exists.
       */
      expect(userStore.membershipsOf(user.id).map((m) => m.organizationId)).toEqual([ORG]);
    });
  });

  /* ------------------- What Phase 4 still has to build ------------------ */

  describe("agent identity — measured, not assumed", () => {
    it("enforces agent status through the policy engine: active acts, paused cannot", async () => {
      /*
       * Requested cases 5 and 6. This is a real lifecycle gate and it already
       * exists — in `shared/policy/engine.ts`, ahead of every policy rule — so it
       * is asserted here rather than rebuilt. The vocabulary is `paused`, not
       * `SUSPENDED`; Phase 4's renaming is a renaming, not a new mechanism.
       */
      const create = await api.post<{ id: string }>(
        "/api/agents",
        {
          id: "agt_p2_lifecycle",
          name: "P2 Lifecycle Agent",
          description: "Created by identity-lifecycle.test.ts",
          provider: "openai",
          model: "gpt-4o",
          status: "active",
          owner: "P2 Admin",
          mandate: {
            maxTransactionAmount: 100,
            allowedCategories: [],
            blockedCategories: [],
            allowedDomains: [],
          },
          permissions: [
            {
              scope: "read:database",
              label: "Read the datastore",
              description: "Granted so the ALLOW below proves the status gate, not a missing scope",
              granted: true,
              risk: "low",
            },
          ],
          policyIds: [],
          tags: [],
          riskLevel: "low",
        },
        asAdmin(),
      );
      expect(create.status).toBe(201);

      const allowed = await api.post<{ decision: string }>(
        "/api/evaluate",
        { agentId: "agt_p2_lifecycle", action: "access", target: "warehouse.dim_customer" },
        asAdmin(),
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body.decision).toBe("ALLOW");

      const paused = await api.patch(
        "/api/agents/agt_p2_lifecycle",
        { status: "paused" },
        asAdmin(),
      );
      expect(paused.status).toBe(200);

      const blocked = await api.post<{ decision: string; reason: string }>(
        "/api/evaluate",
        { agentId: "agt_p2_lifecycle", action: "access", target: "warehouse.dim_customer" },
        asAdmin(),
      );
      expect(blocked.body.decision).toBe("BLOCK");
      expect(blocked.body.reason).toContain("paused");
    });

    it("has no REVOKED agent state — pinned so adding one breaks this test", async () => {
      /*
       * Requested case 7. `AgentStatus` is `active | paused | draft | review`, and
       * the route's enum is the same four. There is no terminal, irreversible state,
       * so "revoked" today means "paused, and reversible by anyone with `manage`".
       * Phase 4 has to add it. This assertion exists so that the day it is added,
       * this test fails and the transition report stops being out of date.
       */
      const res = await api.patch(
        "/api/agents/agt_p2_lifecycle",
        { status: "revoked" },
        asAdmin(),
      );
      expect(res.status).toBe(400);
    });

    it("now issues credentials bound to an agent — the P2 pin, updated in P6", async () => {
      /*
       * Requested cases 1, 2 and 11 — REWRITTEN IN PHASE 6, and this note records
       * why, because a test whose assertions were inverted is exactly the kind of
       * edit that should not pass unexplained.
       *
       * As written in P2 this test asserted the *absence* of the feature: an API
       * key carried `organization_id`, `name` and `role` and nothing naming an
       * agent, `POST /api/keys` refused an `agentId` with a 400, and the resolved
       * identity had no agent-shaped field. Its own purpose was to fail the day
       * that changed, so the transition report could not quietly go stale. P6
       * added the binding (migration 010, `server/identity/agent-binding.ts`), so
       * it failed, exactly as designed — it was not modified to make a new feature
       * look green.
       *
       * What it pins now is the new shape, plus the part that did NOT change:
       * `Identity` has an `agentId`, and for a console session it is `null`,
       * because a human is not confined to one agent. The claim "an agent
       * authenticates as itself" is still not true and is still not asserted — a
       * bound *credential* acting as one agent is a narrower thing, and the two
       * should not be conflated in either direction.
       */
      const bound = await api.post<{ key: { agentId: string | null } }>(
        "/api/keys",
        { name: "P6 agent-bound key", role: "operator", agentId: "agt_p2_lifecycle" },
        asAdmin(),
      );
      expect(bound.status).toBe(201);
      expect(bound.body.key.agentId).toBe("agt_p2_lifecycle");

      // An agent id that is not this organization’s is refused at issue time,
      // rather than producing a key that authenticates and then fails on use.
      const foreign = await api.post(
        "/api/keys",
        { name: "P6 foreign binding", role: "operator", agentId: "agt_sales" },
        asAdmin(),
      );
      expect(foreign.status).toBe(400);

      const session = await api.get<{ identity: Record<string, unknown> }>(
        "/api/auth/session",
        asAdmin(),
      );
      expect(session.status).toBe(200);
      expect(Object.keys(session.body.identity).sort()).toEqual(
        ["agentId", "id", "kind", "name", "organizationId", "role", "sessionId"].sort(),
      );
      // A session is a person, so it is deliberately unbound — null, not absent.
      expect(session.body.identity.agentId).toBeNull();
      // Still two kinds, and neither of them is an agent.
      expect(["user", "service"]).toContain(session.body.identity.kind);
    });

    it("keeps every session of this organization visible to its own admin only", async () => {
      /*
       * The audit-adjacent half of case 10: attribution is only useful if the list
       * of live actors is itself scoped. Asserted here because these tests created
       * a genuinely separate tenant, which is the condition under which the
       * assertion means something.
       */
      const mine = await api.get<{ sessions: { id: string }[] }>("/api/auth/sessions", asAdmin());
      expect(mine.status).toBe(200);
      const ids = new Set(mine.body.sessions.map((s) => s.id));
      for (const session of sessionStore.list(organizationId("org_default"), 200)) {
        expect(ids.has(session.id)).toBe(false);
      }
    });
  });
});
