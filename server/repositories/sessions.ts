/**
 * Session store — server-side, revocable, restart-proof.
 *
 * The token handed to a browser is `<sessionId>.<hmac>`. The signature makes it
 * unforgeable; the row makes it *revocable*. A stateless JWT cannot be taken
 * away before it expires, which is the whole reason this table exists.
 *
 * Rows are never deleted on revoke. "Who was signed in, from when to when, and
 * who cut them off" is audit material.
 */

import crypto from "node:crypto";
import { rawDb } from "../db";
import { isRole, type Role } from "@shared/roles";
import { organizationId, type OrganizationId } from "@shared/tenancy";

export interface SessionRecord {
  id: string;
  /**
   * The organization this session belongs to, fixed at sign-in from the credential.
   * Every tenant-scoped session operation is filtered by it; `find` and
   * `resolveActive` are not, because they are the token-resolution primitives that
   * *produce* the organization — there is nothing to filter by yet at that point.
   */
  organizationId: OrganizationId;
  subject: string;
  name: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  /**
   * Fingerprint of the secret this session was opened with, so a rotated or
   * deleted credential invalidates it. Computed and checked in server/auth.ts;
   * this store only carries it. Null on rows written before the column existed.
   */
  credentialFp: string | null;
}

interface Row {
  id: string;
  organization_id: string;
  subject: string;
  name: string;
  role: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  credential_fp: string | null;
}

function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    // Validated rather than cast. A row whose discriminator is malformed must not
    // become a usable scope: `organizationId()` throws, the session resolution fails
    // closed, and the caller is treated as unauthenticated.
    organizationId: organizationId(row.organization_id),
    subject: row.subject,
    name: row.name,
    // A row whose role no longer exists is degraded to the least privilege
    // rather than trusted: an unknown role must never widen access.
    role: isRole(row.role) ? row.role : "viewer",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    credentialFp: row.credential_fp ?? null,
  };
}

const insertStmt = rawDb.prepare(
  `INSERT INTO sessions (id, organization_id, subject, name, role, created_at, expires_at, last_seen_at, credential_fp)
   VALUES (@id, @organization_id, @subject, @name, @role, @created_at, @expires_at, @last_seen_at, @credential_fp)`,
);
const findStmt = rawDb.prepare(`SELECT * FROM sessions WHERE id = ?`);
const findInStmt = rawDb.prepare(`SELECT * FROM sessions WHERE organization_id = ? AND id = ?`);
const touchStmt = rawDb.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`);
/*
 * Every statement below is tenant-scoped. Revoking and listing sessions are
 * administrative actions exposed over the API, so without the discriminator an
 * admin in one organization could end another organization's sessions — a denial of
 * service against a different customer — or read the names of its users.
 */
const revokeStmt = rawDb.prepare(
  `UPDATE sessions SET revoked_at = ?, revoked_by = ?
    WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`,
);
const rebindStmt = rawDb.prepare(
  `UPDATE sessions SET credential_fp = ?
    WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`,
);
const revokeSubjectStmt = rawDb.prepare(
  `UPDATE sessions SET revoked_at = ?, revoked_by = ?
    WHERE organization_id = ? AND subject = ? AND revoked_at IS NULL`,
);
const listStmt = rawDb.prepare(
  `SELECT * FROM sessions WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`,
);
const listSubjectStmt = rawDb.prepare(
  `SELECT * FROM sessions WHERE organization_id = ? AND subject = ? ORDER BY created_at DESC LIMIT ?`,
);

export const sessionStore = {
  create(input: {
    organizationId: OrganizationId;
    subject: string;
    name: string;
    role: Role;
    ttlMs: number;
    credentialFp: string;
  }): SessionRecord {
    const now = new Date();
    const record: SessionRecord = {
      id: `ses_${crypto.randomBytes(16).toString("hex")}`,
      organizationId: input.organizationId,
      subject: input.subject,
      name: input.name,
      role: input.role,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      lastSeenAt: now.toISOString(),
      revokedAt: null,
      revokedBy: null,
      credentialFp: input.credentialFp,
    };
    insertStmt.run({
      id: record.id,
      organization_id: record.organizationId,
      subject: record.subject,
      name: record.name,
      role: record.role,
      created_at: record.createdAt,
      expires_at: record.expiresAt,
      last_seen_at: record.lastSeenAt,
      credential_fp: record.credentialFp,
    });
    return record;
  },

  /**
   * Unscoped lookup — reserved for token resolution, which runs before any
   * organization is known. Anything reachable from a route must use `findIn`.
   */
  find(id: string): SessionRecord | null {
    const row = findStmt.get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  },

  /**
   * Tenant-scoped lookup. A session belonging to another organization reads as
   * absent, so a caller cannot use a 404-versus-403 difference to confirm that a
   * session id exists somewhere else in the deployment.
   */
  findIn(org: OrganizationId, id: string): SessionRecord | null {
    const row = findInStmt.get(org, id) as Row | undefined;
    return row ? toRecord(row) : null;
  },

  /**
   * Returns the session only when it is genuinely usable right now — present,
   * not revoked, not expired — and stamps `last_seen_at` on the way through.
   */
  resolveActive(id: string, now = new Date()): SessionRecord | null {
    const record = this.find(id);
    if (!record) return null;
    if (record.revokedAt) return null;
    if (Date.parse(record.expiresAt) <= now.getTime()) return null;
    touchStmt.run(now.toISOString(), id);
    return { ...record, lastSeenAt: now.toISOString() };
  },

  /**
   * Idempotent: revoking an already-revoked session reports `false`, not an error.
   * A session id from another organization also reports `false` — indistinguishable
   * from "already revoked", which is the correct answer to give a caller who should
   * not learn that the session exists.
   */
  revoke(id: string, revokedBy: string, org: OrganizationId): boolean {
    return revokeStmt.run(new Date().toISOString(), revokedBy, org, id).changes > 0;
  },

  /** Cuts every live session of one subject — the "sign out everywhere" primitive. */
  revokeAllFor(subject: string, revokedBy: string, org: OrganizationId): number {
    return revokeSubjectStmt.run(new Date().toISOString(), revokedBy, org, subject).changes;
  },

  /**
   * Re-binds one live session to a new credential fingerprint.
   *
   * Needed when a user changes their own password: every session is bound to the
   * credential that opened it, so the change would otherwise sign the person out of
   * the very tab they used to make it. Scoped to the organization and to a session
   * that is still live, so it cannot resurrect a revoked one.
   */
  rebind(org: OrganizationId, id: string, credentialFp: string): boolean {
    return rebindStmt.run(credentialFp, org, id).changes > 0;
  },

  list(org: OrganizationId, limit = 100): SessionRecord[] {
    return (listStmt.all(org, limit) as Row[]).map(toRecord);
  },

  listFor(org: OrganizationId, subject: string, limit = 100): SessionRecord[] {
    return (listSubjectStmt.all(org, subject, limit) as Row[]).map(toRecord);
  },
};
