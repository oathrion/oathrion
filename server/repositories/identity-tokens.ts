/**
 * One-shot identity tokens — the P2 identity half.
 *
 * Two things use the same machinery, because they are the same mechanism with two
 * outcomes: an **invitation** (this address may join this organization with this
 * role) and a **reset** (this address may replace its password once). Both are
 * single use, both expire, both are hashed at rest, both belong to exactly one
 * organization, and both are revocable. Only `consume` branches on the purpose,
 * and it does so in the route, not here.
 *
 * ## The token, and why the id is in it
 *
 * The string handed to a person is `<id>.<secret>`. The lookup is by `id`, and the
 * secret is then compared against the stored digest in constant time. The
 * alternative — storing an indexed digest and querying `WHERE secret_hash = ?`,
 * which is what `apiKeyStore.resolve` does — would work, and is not used here for
 * one reason: an API key is presented thousands of times and needs a single
 * indexed read on the hot path, whereas a token is presented once in its life. A
 * primary-key read plus one comparison is the same cost, and it keeps the digest
 * column unindexed and unsearchable, so no code path anywhere can ask "does a
 * token with this hash exist".
 *
 * ## Why `consume` is a conditional UPDATE and not a read-then-write
 *
 * Single use has to survive two people, or two tabs, presenting the same token at
 * the same instant. `SELECT` then `UPDATE` leaves a window in which both callers
 * see `consumed_at IS NULL` and both proceed — and for an invitation that means
 * two memberships, for a reset it means the second password wins over the first.
 * The claim is therefore one atomic `UPDATE ... WHERE consumed_at IS NULL`, and
 * the caller acts only if it changed a row. This is the same technique the Gateway
 * uses to guarantee a tool runs at most once per execution.
 *
 * ## What this store deliberately cannot do
 *
 * There is no method that returns a secret, and no update path for `secret_hash`.
 * A lost token is replaced by issuing a new one and revoking the old, which keeps
 * the record of who was invited when, by whom, and whether they ever accepted.
 */

import { randomBytes } from "node:crypto";
import { rawDb } from "../db";
import { hashKey, keyHashEquals } from "../api-keys";
import { isRole, type Role } from "@shared/roles";
import { organizationId, type OrganizationId } from "@shared/tenancy";

/** What a token is for. Decides what consuming it does — nothing else. */
export type TokenPurpose = "invite" | "reset";

/** How long a token lives when the caller does not say. */
export const DEFAULT_TOKEN_TTL_MS = 7 * 86_400_000;

/**
 * The ceiling on a token's lifetime.
 *
 * A token is an authentication bypass by design: whoever holds it can obtain
 * access without knowing a password. Thirty days is not a security boundary, it is
 * a bound that keeps a mistyped or over-generous lifetime from producing a
 * credential that outlives the reason it was issued.
 */
export const MAX_TOKEN_TTL_MS = 30 * 86_400_000;

/** 32 bytes from the system CSPRNG. See `server/api-keys.ts` on why no KDF. */
const SECRET_BYTES = 32;

export interface IdentityTokenRecord {
  id: string;
  organizationId: OrganizationId;
  purpose: TokenPurpose;
  email: string;
  role: Role;
  secretHash: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

/**
 * What may leave the server. Has no `secretHash` field *by construction*, so a
 * route cannot leak the digest by spreading a record into a response — the same
 * technique that keeps password hashes out of `PublicUser` and key digests out of
 * `PublicApiKey`.
 */
export interface PublicIdentityToken {
  id: string;
  purpose: TokenPurpose;
  email: string;
  role: Role;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  /** Computed, not stored: four states an inventory has to tell apart. */
  status: "pending" | "accepted" | "revoked" | "expired";
}

interface TokenRow {
  id: string;
  organization_id: string;
  purpose: string;
  email: string;
  role: string;
  secret_hash: string;
  created_at: string;
  created_by: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

function toToken(row: TokenRow): IdentityTokenRecord {
  return {
    id: row.id,
    organizationId: organizationId(row.organization_id),
    // An unreadable purpose resolves to `reset`, the narrower of the two: a reset
    // grants no new access, while an invitation creates a membership. Corrupt data
    // must fail towards less access, never towards more.
    purpose: row.purpose === "invite" ? "invite" : "reset",
    email: row.email,
    // Same rule as `apiKeyStore`: an unreadable role reads as `viewer`, so a bad
    // write cannot mint an admin.
    role: isRole(row.role) ? row.role : "viewer",
    secretHash: row.secret_hash,
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedBy: row.consumed_by,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

export function isTokenExpired(token: IdentityTokenRecord, now = Date.now()): boolean {
  const at = Date.parse(token.expiresAt);
  // An unparseable expiry is treated as expired, exactly as for an API key: a
  // credential whose lifetime cannot be determined is refused, not granted an
  // unlimited one.
  return Number.isNaN(at) || at <= now;
}

export function toPublicToken(
  token: IdentityTokenRecord,
  now = Date.now(),
): PublicIdentityToken {
  /*
   * Order matters and is not arbitrary. "Accepted" is checked first because a
   * token that was used and has since passed its expiry is historically an
   * acceptance, not an expiry — reporting it as expired would tell an
   * administrator that an invitation was never taken up when in fact it was.
   */
  const status: PublicIdentityToken["status"] = token.consumedAt
    ? "accepted"
    : token.revokedAt
      ? "revoked"
      : isTokenExpired(token, now)
        ? "expired"
        : "pending";
  return {
    id: token.id,
    purpose: token.purpose,
    email: token.email,
    role: token.role,
    createdAt: token.createdAt,
    createdBy: token.createdBy,
    expiresAt: token.expiresAt,
    consumedAt: token.consumedAt,
    consumedBy: token.consumedBy,
    revokedAt: token.revokedAt,
    revokedBy: token.revokedBy,
    status,
  };
}

/** A newly minted token. The plaintext exists only inside this object, once. */
export interface IssuedToken {
  record: IdentityTokenRecord;
  /** `<id>.<secret>`. Returned once, to the issuer, and never recoverable. */
  token: string;
}

export interface CreateTokenInput {
  organizationId: OrganizationId;
  purpose: TokenPurpose;
  email: string;
  role: Role;
  createdBy: string;
  ttlMs?: number;
}

/**
 * Splits a presented token into its two halves.
 *
 * Returns `null` for anything that is not exactly `<id>.<secret>` with both parts
 * non-empty, so a malformed value is refused before it reaches the database
 * rather than producing a lookup on a fragment.
 */
export function splitToken(presented: string): { id: string; secret: string } | null {
  if (typeof presented !== "string") return null;
  const dot = presented.indexOf(".");
  if (dot <= 0 || dot === presented.length - 1) return null;
  // A second separator means this is not our format. Refused rather than
  // interpreted, because guessing which dot was meant is how a parser becomes a
  // vulnerability.
  if (presented.indexOf(".", dot + 1) !== -1) return null;
  return { id: presented.slice(0, dot), secret: presented.slice(dot + 1) };
}

export const identityTokenStore = {
  /**
   * The resolution path. Unscoped by necessity: the row is what TELLS the server
   * which organization the token concerns, so it cannot be filtered by the answer
   * it produces — the same exception, for the same reason, as
   * `sessionStore.find` and `apiKeyStore.resolve`.
   *
   * Narrow on purpose: it verifies the secret and nothing else. Expiry,
   * revocation, single use and organization status are the caller's business, so
   * that the tests which guard them can see them.
   */
  resolve(presented: string): IdentityTokenRecord | undefined {
    const parts = splitToken(presented);
    if (!parts) return undefined;
    const row = rawDb
      .prepare<[string], TokenRow>(`SELECT * FROM identity_tokens WHERE id = ?`)
      .get(parts.id);
    if (!row) return undefined;
    const token = toToken(row);
    if (!keyHashEquals(token.secretHash, hashKey(parts.secret))) return undefined;
    return token;
  },

  findIn(organization: OrganizationId, id: string): IdentityTokenRecord | undefined {
    const row = rawDb
      .prepare<[string, string], TokenRow>(
        `SELECT * FROM identity_tokens WHERE organization_id = ? AND id = ?`,
      )
      .get(organization, id);
    return row ? toToken(row) : undefined;
  },

  list(organization: OrganizationId): IdentityTokenRecord[] {
    return rawDb
      .prepare<[string], TokenRow>(
        `SELECT * FROM identity_tokens WHERE organization_id = ? ORDER BY created_at DESC, id`,
      )
      .all(organization)
      .map(toToken);
  },

  /**
   * Is there already a live token of this purpose for this address?
   *
   * Used to refuse a duplicate invitation rather than accumulate several valid
   * tokens for one person: each extra live token is another credential that can
   * leak, and an administrator who cannot see how many exist cannot revoke them
   * all. Scoped, so one organization's outstanding invitation is invisible to
   * another's.
   */
  livePending(
    organization: OrganizationId,
    purpose: TokenPurpose,
    email: string,
    now = Date.now(),
  ): IdentityTokenRecord | undefined {
    return this.list(organization).find(
      (t) =>
        t.purpose === purpose &&
        t.email === email &&
        !t.consumedAt &&
        !t.revokedAt &&
        !isTokenExpired(t, now),
    );
  },

  create(input: CreateTokenInput): IssuedToken {
    const now = new Date().toISOString();
    const ttl = Math.min(
      Math.max(input.ttlMs ?? DEFAULT_TOKEN_TTL_MS, 60_000),
      MAX_TOKEN_TTL_MS,
    );
    const id = `idt_${randomBytes(12).toString("hex")}`;
    // base64url for the same reason as an API key: the value survives a URL, a
    // shell argument and a copy-paste out of a chat window without quoting.
    const secret = randomBytes(SECRET_BYTES).toString("base64url");

    rawDb
      .prepare(
        `INSERT INTO identity_tokens
           (id, organization_id, purpose, email, role, secret_hash,
            created_at, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.organizationId,
        input.purpose,
        input.email,
        input.role,
        hashKey(secret),
        now,
        input.createdBy,
        new Date(Date.now() + ttl).toISOString(),
      );

    const created = this.findIn(input.organizationId, id);
    if (!created) {
      // Unreachable unless the INSERT silently did nothing. Failing loudly beats
      // returning a fabricated record whose token nobody can ever use.
      throw new Error(`identity token ${id} disappeared immediately after insert`);
    }
    return { record: created, token: `${id}.${secret}` };
  },

  /**
   * Claims a token, atomically and at most once.
   *
   * Returns `true` only for the caller that actually moved the row from unused to
   * used. Every other caller — a replay, a concurrent second tab, a token already
   * revoked — gets `false` and must refuse. The expiry is part of the predicate
   * rather than a prior read, so a token cannot be claimed by a request that
   * checked the clock before it lapsed and wrote after.
   */
  consume(id: string, by: string, now = new Date()): boolean {
    const at = now.toISOString();
    const result = rawDb
      .prepare(
        `UPDATE identity_tokens
            SET consumed_at = ?, consumed_by = ?
          WHERE id = ?
            AND consumed_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > ?`,
      )
      .run(at, by, id, at);
    return result.changes > 0;
  },

  /**
   * Revocation is scoped, and only bites while the token is still live.
   *
   * `revoked_at IS NULL AND consumed_at IS NULL` in the predicate is not a
   * nicety. Without the first, revoking twice would overwrite the first
   * revocation's actor — the thing a review reads. Without the second, revoking
   * an already-accepted invitation would rewrite history into "this was never
   * accepted", while the membership it created would still exist.
   */
  revoke(organization: OrganizationId, id: string, by: string): boolean {
    const result = rawDb
      .prepare(
        `UPDATE identity_tokens
            SET revoked_at = ?, revoked_by = ?
          WHERE organization_id = ? AND id = ?
            AND revoked_at IS NULL AND consumed_at IS NULL`,
      )
      .run(new Date().toISOString(), by, organization, id);
    return result.changes > 0;
  },

  /**
   * Revokes every live token of one purpose for one address.
   *
   * Called when a reset is issued or a membership is removed: an outstanding token
   * for somebody who is being cut off, or whose password is being replaced, is a
   * live bypass that nobody would think to look for. Scoped.
   */
  revokeAllFor(
    organization: OrganizationId,
    email: string,
    by: string,
    purpose?: TokenPurpose,
  ): number {
    let revoked = 0;
    for (const token of this.list(organization)) {
      if (token.email !== email) continue;
      if (purpose && token.purpose !== purpose) continue;
      if (token.consumedAt || token.revokedAt) continue;
      if (this.revoke(organization, token.id, by)) revoked += 1;
    }
    return revoked;
  },
};
