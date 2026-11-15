/**
 * ORGANIZATION & MEMBER SURFACES
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Settings page used to render an organization profile ("Acme Corp / Enterprise /
 * 42 seats / eu-west-1") and a five-person roster from a fixture file, behind a
 * "Demo data" badge. §15 forbids exactly that shape: a screen that looks like a
 * feature and is not one. The organization has been a real row since P0-1 and users
 * have been real rows since P0-2, so the fixtures were replaced by `GET
 * /api/organization` and `GET /api/members`.
 *
 * The interesting risk in these two routes is not "does it return data" — it is that
 * they are the first routes to expose *user* records over HTTP. Two things must hold:
 * a roster must never cross a tenant boundary, and it must never carry a password
 * hash. Both are asserted below against a live server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OTHER_ORG_KEYS,
  ROLE_KEYS,
  TEST_CONSOLE_EMAIL,
  TEST_CONSOLE_PASSWORD,
  startTestServer,
  type TestClient,
} from "./harness";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";

interface OrgBody {
  id: string;
  name: string;
  createdAt: string;
  active: boolean;
  memberCount: number;
  adminCount: number;
}

interface MembersBody {
  total: number;
  members: {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    createdAt: string;
    lastLoginAt: string | null;
    passwordSource: string;
  }[];
}

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

describe("GET /api/organization", () => {
  it("refuses an unauthenticated caller", async () => {
    const res = await client.get<OrgBody>("/api/organization", { auth: null });
    expect(res.status).toBe(401);
  });

  it("returns the caller's own tenant", async () => {
    const res = await client.get<OrgBody>("/api/organization");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(DEFAULT_ORGANIZATION_ID);
    expect(res.body.active).toBe(true);
    // A real timestamp, not a formatted fixture like "2025-11-02".
    expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false);
  });

  it("counts members and admins from the user table, not from a constant", async () => {
    const org = await client.get<OrgBody>("/api/organization");
    const roster = await client.get<MembersBody>("/api/members");
    expect(org.body.memberCount).toBe(roster.body.total);
    expect(org.body.adminCount).toBe(
      roster.body.members.filter((m) => m.role === "admin").length,
    );
    expect(org.body.memberCount).toBeGreaterThan(0);
  });

  it("does not invent a plan, a seat count or a region", async () => {
    // The three fields the fixture used to carry. Oathrion stores none of them; returning
    // them here would just move the fabrication one layer down.
    const res = await client.get<Record<string, unknown>>("/api/organization");
    expect(res.body).not.toHaveProperty("plan");
    expect(res.body).not.toHaveProperty("seats");
    expect(res.body).not.toHaveProperty("region");
  });

  it("shows a different tenant its own organization, never the other one", async () => {
    const mine = await client.get<OrgBody>("/api/organization");
    const theirs = await client.get<OrgBody>("/api/organization", {
      auth: OTHER_ORG_KEYS.admin,
    });
    expect(theirs.status).toBe(200);
    expect(theirs.body.id).toBe("org_rival_corp");
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.body.name).not.toBe(mine.body.name);
  });

  it("is readable by a viewer — it is the tenant's own identity card", async () => {
    const res = await client.get<OrgBody>("/api/organization", { auth: ROLE_KEYS.viewer });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/members", () => {
  it("refuses an unauthenticated caller", async () => {
    const res = await client.get<MembersBody>("/api/members", { auth: null });
    expect(res.status).toBe(401);
  });

  it("returns the real console users, with the fields the roster displays", async () => {
    const res = await client.get<MembersBody>("/api/members");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(res.body.members.length);

    const admin = res.body.members.find((m) => m.email === TEST_CONSOLE_EMAIL);
    expect(admin).toBeDefined();
    expect(admin?.role).toBe("admin");
    expect(admin?.status).toBe("active");
    expect(Number.isNaN(Date.parse(admin!.createdAt))).toBe(false);
  });

  it("never carries a password hash, a salt or a secret", async () => {
    const res = await client.get<MembersBody>("/api/members");
    const serialised = JSON.stringify(res.body);
    for (const forbidden of ["passwordHash", "password_hash", "salt", "scrypt", "$"]) {
      expect(serialised).not.toContain(forbidden);
    }
    // Structural, not textual: the type returned by `listMembers` has no hash field, so
    // the keys are enumerable and can be pinned.
    for (const member of res.body.members) {
      expect(Object.keys(member).sort()).toEqual(
        [
          "createdAt",
          "email",
          "id",
          "lastLoginAt",
          // P2 identity: this person's standing in THIS organization, which is a
          // different question from the deployment-wide `status` next to it. Both
          // are pinned deliberately, so a future field cannot slip in unreviewed.
          "membershipStatus",
          "name",
          "passwordSource",
          "role",
          "status",
          "suspendedAt",
        ].sort(),
      );
    }
  });

  it("does not leak the roster across a tenant boundary", async () => {
    const mine = await client.get<MembersBody>("/api/members");
    const theirs = await client.get<MembersBody>("/api/members", {
      auth: OTHER_ORG_KEYS.admin,
    });
    expect(theirs.status).toBe(200);

    const myEmails = new Set(mine.body.members.map((m) => m.email));
    for (const member of theirs.body.members) {
      expect(myEmails.has(member.email)).toBe(false);
    }
    // And the reverse direction, so the test fails if scoping is dropped on either side.
    const theirEmails = new Set(theirs.body.members.map((m) => m.email));
    for (const member of mine.body.members) {
      expect(theirEmails.has(member.email)).toBe(false);
    }
  });

  it("reflects a real sign-in in lastLoginAt", async () => {
    const before = await client.get<MembersBody>("/api/members");
    const admin = before.body.members.find((m) => m.email === TEST_CONSOLE_EMAIL);
    expect(admin).toBeDefined();

    const login = await client.post<{ token: string }>(
      "/api/auth/login",
      { email: TEST_CONSOLE_EMAIL, password: TEST_CONSOLE_PASSWORD },
      { auth: null },
    );
    expect(login.status).toBe(200);

    const after = await client.get<MembersBody>("/api/members");
    const updated = after.body.members.find((m) => m.email === TEST_CONSOLE_EMAIL);
    expect(updated?.lastLoginAt).not.toBeNull();
    // Either it was null before and is set now, or it moved forward.
    if (admin?.lastLoginAt) {
      expect(Date.parse(updated!.lastLoginAt!)).toBeGreaterThanOrEqual(
        Date.parse(admin.lastLoginAt),
      );
    }
  });
});
