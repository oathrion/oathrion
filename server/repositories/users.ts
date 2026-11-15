/**
 * User accounts and organization memberships — P0-2.
 *
 * ## Two unscoped reads, and why exactly two
 *
 * `findByEmail` and `findById` take no organization, for the same reason
 * `sessionStore.find` does not: they run *before* the tenant is known, and they are
 * what determines it. Everything else here is scoped — `listMembers`,
 * `membership`, `setRole`, `removeMember` all take an `OrganizationId` and none of
 * them will read or write a row belonging to another tenant.
 *
 * The password hash is part of the record because verification happens in
 * `server/auth.ts` and hiding it behind a `verify(email, password)` method on the
 * store would put the authentication decision in the data layer, where the tests
 * that guard it do not look. It is never serialised to a response: routes return
 * `PublicUser`, and the type system enforces that rather than a review habit.
 *
 * Prepared statements, like the session and organization stores: these run on the
 * authentication path.
 */

import { rawDb } from "../db";
import { isRole, type Role } from "@shared/roles";
import { organizationId, type OrganizationId } from "@shared/tenancy";

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  passwordUpdatedAt: string;
  passwordSource: "config" | "user";
  status: "active" | "suspended";
  createdAt: string;
  lastLoginAt: string | null;
}

/** What may leave the server. Deliberately has no hash field at all. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * The DEPLOYMENT-WIDE account status, from `users.status`. Unchanged in meaning
   * by P2: it is not the field a customer changes to remove somebody from their
   * own organization.
   */
  status: "active" | "suspended";
  createdAt: string;
  lastLoginAt: string | null;
  passwordSource: "config" | "user";
  /**
   * This person's standing in THIS organization, from `memberships.suspended_at`.
   * Added rather than folded into `status` because the two answer different
   * questions, and one field holding both would make "suspended" ambiguous
   * precisely where an administrator is deciding whether they can act.
   */
  membershipStatus: "active" | "suspended";
  suspendedAt: string | null;
}

export interface Membership {
  organizationId: OrganizationId;
  userId: string;
  role: Role;
  createdAt: string;
  /**
   * Set when this person is barred from THIS organization only — P2 identity.
   * Distinct from `UserRecord.status`, which is deployment-wide: suspending the
   * user would cut them off from every organization they belong to, which is one
   * tenant reaching into another.
   */
  suspendedAt: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  password_updated_at: string;
  password_source: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
}

interface MembershipRow {
  organization_id: string;
  user_id: string;
  role: string;
  created_at: string;
  suspended_at: string | null;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    passwordUpdatedAt: row.password_updated_at,
    // Anything unrecognised is treated as owned by the user, which is the
    // conservative direction: it stops the environment from overwriting a hash whose
    // provenance this build does not understand.
    passwordSource: row.password_source === "config" ? "config" : "user",
    // Same principle applied to status: an unknown value is not "active".
    status: row.status === "active" ? "active" : "suspended",
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function toMembership(row: MembershipRow): Membership {
  if (!isRole(row.role)) {
    // A membership with an unreadable role cannot be silently downgraded to viewer —
    // that would be inventing an authorisation decision — nor widened. It is a
    // corrupted row and the caller must not receive a guess.
    throw new Error(`membership ${row.user_id}@${row.organization_id} has an unusable role`);
  }
  return {
    organizationId: organizationId(row.organization_id),
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    // A column added by migration 8. `?? null` rather than a truthiness test so an
    // empty string — which a hand-written UPDATE could leave — reads as "not
    // suspended" only if it really is empty, and never as a suspension timestamp.
    suspendedAt: row.suspended_at ?? null,
  };
}

const byEmail = rawDb.prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`);
const byId = rawDb.prepare(`SELECT * FROM users WHERE id = ?`);
// `OR IGNORE` (`ON CONFLICT DO NOTHING` on PostgreSQL): two instances starting together both
// see no row in `ensure`, and both insert it. The loser then reads the winner's row back
// instead of failing a request with a duplicate key (CI, 15 November).
const insertUser = rawDb.prepare(
  `INSERT OR IGNORE INTO users (id, email, name, password_hash, password_updated_at, password_source,
     status, created_at, last_login_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
);
const updateHash = rawDb.prepare(
  `UPDATE users SET password_hash = ?, password_updated_at = ?, password_source = ? WHERE id = ?`,
);
const selectBySource = rawDb.prepare(
  `SELECT * FROM users WHERE password_source = ? ORDER BY email`,
);

const updateName = rawDb.prepare(`UPDATE users SET name = ? WHERE id = ?`);
const updateStatus = rawDb.prepare(`UPDATE users SET status = ? WHERE id = ?`);
const touchLogin = rawDb.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`);

const membershipStmt = rawDb.prepare(
  `SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?`,
);
const membershipsForUser = rawDb.prepare(
  `SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC, organization_id ASC`,
);
const upsertMembership = rawDb.prepare(
  `INSERT INTO memberships (organization_id, user_id, role, created_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT (organization_id, user_id) DO UPDATE SET role = excluded.role`,
);
const deleteMembership = rawDb.prepare(
  `DELETE FROM memberships WHERE organization_id = ? AND user_id = ?`,
);
const suspendMembership = rawDb.prepare(
  `UPDATE memberships SET suspended_at = ?
     WHERE organization_id = ? AND user_id = ? AND suspended_at IS NULL`,
);
const reinstateMembership = rawDb.prepare(
  `UPDATE memberships SET suspended_at = NULL
     WHERE organization_id = ? AND user_id = ? AND suspended_at IS NOT NULL`,
);
const membersOf = rawDb.prepare(
  `SELECT m.role AS role, m.created_at AS m_created_at, m.suspended_at AS m_suspended_at, u.*
     FROM memberships m
     JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ?
    ORDER BY u.email ASC`,
);
const countAdmins = rawDb.prepare(
  `SELECT COUNT(*) AS n
     FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND m.role = 'admin' AND u.status = 'active'
      AND m.suspended_at IS NULL AND u.id <> ?`,
);

/** Stable id from the address, so re-adopting a configured user does not duplicate it. */
export function userIdFor(email: string): string {
  const normalised = normaliseEmail(email);
  let hash = 0;
  for (let i = 0; i < normalised.length; i += 1) {
    // A short deterministic suffix keeps the id readable while still separating two
    // addresses whose local parts slugify identically (a.b@x and a-b@x).
    hash = (hash * 31 + normalised.charCodeAt(i)) >>> 0;
  }
  const slug = normalised.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `usr_${slug}_${hash.toString(36)}`;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const userStore = {
  /** Unscoped by necessity: this call is what resolves which tenants apply. */
  findByEmail(email: string): UserRecord | null {
    if (typeof email !== "string" || email.trim() === "") return null;
    const row = byEmail.get(normaliseEmail(email)) as UserRow | undefined;
    return row ? toUser(row) : null;
  },

  findById(id: string): UserRecord | null {
    const row = byId.get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  },

  /**
   * Creates a user, or returns the existing one for that address.
   *
   * Never overwrites a password on the "already exists" path. Adoption at boot calls
   * this for every configured console user on every start, so an overwrite here would
   * reset a real password to the environment's value each time the server restarts.
   */
  ensure(input: {
    email: string;
    name: string;
    passwordHash: string;
    passwordSource: "config" | "user";
  }): UserRecord {
    const existing = this.findByEmail(input.email);
    if (existing) return existing;

    const now = new Date().toISOString();
    const email = normaliseEmail(input.email);
    insertUser.run(
      userIdFor(email),
      email,
      input.name,
      input.passwordHash,
      now,
      input.passwordSource,
      "active",
      now,
    );
    const created = this.findByEmail(email);
    if (!created) throw new Error(`user "${email}" could not be created or read back`);
    return created;
  },

  /**
   * Replaces the password hash.
   *
   * `source` records who set it. Once it is `user`, configuration stops overriding
   * it — see `adoptConfiguredUsers` in `server/auth.ts`.
   */
  setPassword(id: string, passwordHash: string, source: "config" | "user"): boolean {
    return updateHash.run(passwordHash, new Date().toISOString(), source, id).changes > 0;
  },

  /**
   * Every account whose password came from a given source.
   *
   * Used by configuration reconciliation: an operator who deletes a line from
   * `OATHRION_CONSOLE_USERS` expects that person to lose access, which requires knowing
   * which stored accounts the configuration owns. Accounts whose password was set by
   * their owner are not the configuration's to reconcile.
   */
  listBySource(source: "config" | "user"): UserRecord[] {
    return (selectBySource.all(source) as UserRow[]).map(toUser);
  },

  rename(id: string, name: string): boolean {
    return updateName.run(name, id).changes > 0;
  },

  setStatus(id: string, status: "active" | "suspended"): boolean {
    return updateStatus.run(status, id).changes > 0;
  },

  recordLogin(id: string): void {
    touchLogin.run(new Date().toISOString(), id);
  },

  /** The role this user holds in this organization, or `null` when they hold none. */
  membership(org: OrganizationId, userId: string): Membership | null {
    const row = membershipStmt.get(org, userId) as MembershipRow | undefined;
    return row ? toMembership(row) : null;
  },

  /** Every organization this user may act within. Unscoped by definition. */
  membershipsOf(userId: string): Membership[] {
    return (membershipsForUser.all(userId) as MembershipRow[]).map(toMembership);
  },

  grant(org: OrganizationId, userId: string, role: Role): Membership {
    upsertMembership.run(org, userId, role, new Date().toISOString());
    const created = this.membership(org, userId);
    if (!created) throw new Error(`membership ${userId}@${org} could not be created`);
    return created;
  },

  revokeMembership(org: OrganizationId, userId: string): boolean {
    return deleteMembership.run(org, userId).changes > 0;
  },

  /**
   * Bars a person from one organization without touching the others.
   *
   * The row is kept rather than deleted, for two reasons. Reinstating restores the
   * role they actually had instead of one an administrator has to remember, and the
   * distinction between "was suspended" and "was never a member" is exactly the
   * question a review asks. `suspended_at IS NULL` in the predicate means a second
   * suspension cannot overwrite the first timestamp.
   *
   * It takes effect on the NEXT REQUEST, not at the next sign-in:
   * `credentialStillValid` in `server/auth.ts` re-reads the membership on every
   * authenticated call.
   */
  suspendMembership(org: OrganizationId, userId: string, at = new Date()): boolean {
    return suspendMembership.run(at.toISOString(), org, userId).changes > 0;
  },

  /** Lifts a suspension. Returns false when there was none, so a route can say so. */
  reinstateMembership(org: OrganizationId, userId: string): boolean {
    return reinstateMembership.run(org, userId).changes > 0;
  },

  /** Members of one organization. Scoped, and joined so a caller sees no foreign user. */
  listMembers(org: OrganizationId): PublicUser[] {
    const rows = membersOf.all(org) as (UserRow & {
      role: string;
      m_suspended_at: string | null;
    })[];
    return rows.map((row) => {
      if (!isRole(row.role)) throw new Error(`membership ${row.id}@${org} has an unusable role`);
      const user = toUser(row);
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: row.role,
        status: user.status,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        passwordSource: user.passwordSource,
        membershipStatus: row.m_suspended_at ? "suspended" : "active",
        suspendedAt: row.m_suspended_at ?? null,
      };
    });
  },

  /**
   * Whether this organization would still have an active admin if `excluding` were
   * removed or demoted.
   *
   * The last admin must not be able to lock their own organization out — a state no
   * tenant-facing endpoint could recover from, because recovering it requires an
   * admin. This is the check that makes user management safe to expose.
   */
  hasAnotherActiveAdmin(org: OrganizationId, excluding: string): boolean {
    const row = countAdmins.get(org, excluding) as { n: number };
    return row.n > 0;
  },
};
