/**
 * Approval time-to-live — how long a held action stays approvable.
 *
 * ## Why this exists
 *
 * Before this module an approval had no deadline. A request raised by
 * `APPROVAL_REQUIRED` sat in the queue as a *standing authorisation*: an
 * approver arriving three weeks later could release a 750 EUR refund into a
 * tool, and the release was as effective as it would have been in the first
 * minute. That is the wrong security property. The reason a human is asked at
 * all is that the action needs judgement about a situation, and a situation
 * decays. The approver who clicks three weeks late is not approving what the
 * requester asked; they are approving a sentence they can no longer verify.
 *
 * An authorisation that never decays is also the ideal target for an attacker
 * with patience: park a high-value request, wait for a distracted or newly
 * onboarded approver, collect. Bounding the window does not stop a careless
 * approval, but it stops the *accumulation* of releasable actions.
 *
 * ## Where the deadline is actually enforced
 *
 * NOT here. This module only computes and classifies. The enforcement lives in
 * the conditional `UPDATE ... WHERE` in `server/repositories/sqlite.ts`, next to
 * the tenant and `status = 'pending'` guards that were already there, because a
 * check performed *before* a write is a time-of-check/time-of-use race: the read
 * says "not expired", the clock advances, the write lands anyway. Making the
 * deadline part of the same indivisible statement removes the window rather than
 * narrowing it.
 *
 * Read `isExpired` as a *reporting* helper and the SQL as the security boundary.
 * They are deliberately two different things, and the tests assert the SQL one.
 *
 * ## Fail-closed
 *
 * `deadlineOf` treats an absent or unparseable `expiresAt` as **already
 * expired**, not as "no deadline". A row with no deadline can only come from a
 * write path that forgot to stamp one, and the safe reading of "I do not know
 * when this stops being valid" is "it is not valid", never "it is valid
 * forever". Migration 9 backfills every pre-existing row precisely so that this
 * strictness costs no legitimate approval.
 */

/**
 * Default window: one hour.
 *
 * Chosen as the shortest span that still spans a normal human interruption —
 * a meeting, a commute — because the cost of expiry is low (the requester
 * re-submits and a fresh decision is made on fresh facts) while the cost of an
 * over-long window is a releasable high-value action nobody is thinking about.
 * It is not a claim about what any particular deployment should use, which is
 * why it is overridable.
 */
export const DEFAULT_APPROVAL_TTL_MS = 60 * 60 * 1000;

/** Floor of one minute: a sub-minute TTL expires requests faster than a human can read them. */
export const MIN_APPROVAL_TTL_MS = 60 * 1000;

/** Ceiling of 30 days, so a typo of an extra zero cannot silently restore "never expires". */
export const MAX_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The configured window, read from the environment on every call.
 *
 * Read per call rather than captured at import time for the same reason
 * `allowedOrigins()` is: a value frozen at module load cannot be changed by a
 * test without reaching into module internals, and a security control that is
 * awkward to test is a security control that ends up untested.
 *
 * An unparseable, non-positive or out-of-range value falls back to the default
 * rather than throwing. A malformed TTL must not be able to take the API down,
 * and it must not be able to widen the window either — the fallback is a bounded
 * value, not "no limit".
 */
export function approvalTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OATHRION_APPROVAL_TTL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_APPROVAL_TTL_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_APPROVAL_TTL_MS;
  if (parsed < MIN_APPROVAL_TTL_MS || parsed > MAX_APPROVAL_TTL_MS) return DEFAULT_APPROVAL_TTL_MS;
  return parsed;
}

/**
 * The instant an approval requested at `requestedAt` stops being releasable.
 *
 * Returns an ISO string so it round-trips through both SQLite `TEXT` and
 * PostgreSQL `timestamptz` unchanged, matching how every other instant in this
 * schema is stored.
 *
 * An unparseable `requestedAt` falls back to *now* as the base, which yields the
 * shortest defensible deadline rather than an `Invalid Date` that would compare
 * false against everything and therefore behave like "never expires".
 */
export function approvalDeadline(requestedAt: string, env?: NodeJS.ProcessEnv): string {
  const base = Date.parse(requestedAt);
  const from = Number.isFinite(base) ? base : Date.now();
  return new Date(from + approvalTtlMs(env)).toISOString();
}

/**
 * Whether a deadline has passed at `now`.
 *
 * Fail-closed on absent or unparseable input — see the module note. The
 * comparison is `<=`, so an approval is expired *at* its deadline rather than
 * one millisecond after it; a boundary that grants the action is the wrong
 * boundary to guess at.
 */
export function isExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt.trim() === "") return true;
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return true;
  return deadline <= now;
}

/** Milliseconds left before the deadline; `0` once it has passed or cannot be read. */
export function msRemaining(expiresAt: string | null | undefined, now: number = Date.now()): number {
  if (isExpired(expiresAt, now)) return 0;
  return Date.parse(expiresAt as string) - now;
}
