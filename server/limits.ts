/**
 * Operational ceilings.
 *
 * These live in their own module, above both the repository and the gateway, so
 * that the storage layer can enforce a limit without importing the gateway and
 * the gateway can report the same number without duplicating it. A limit that is
 * declared twice is a limit that will eventually disagree with itself.
 */

/**
 * How many times a single execution's tool may ever be invoked, across every
 * path — first dispatch, retry, re-approval, stale-run recovery.
 *
 * WHY THERE IS A CEILING AT ALL
 * -----------------------------
 * `attempts` was incremented and never read, so any `failed` execution could be
 * re-dispatched without limit. The tools here are the side-effecting edge of the
 * system (`purchase`, `payment`, `refund`, `transfer`), and a tool can fail
 * *after* the provider accepted the request — a timeout on a charge is the
 * textbook case. Unbounded retry on that shape means spending money N times while
 * the audit trail shows N failures. It is also an amplification vector: one
 * execution, unlimited outbound calls, and the per-identity rate limiter does not
 * help because each retry is a separate legitimate request.
 *
 * WHY 5
 * -----
 * Large enough to ride out the transient failures a retry exists for (a blip, a
 * provider restart, a brief DNS failure), small enough that the worst case is
 * bounded and obvious. An operator who has burned five attempts has a real
 * outage, not a flake, and should look at it rather than keep clicking.
 *
 * Overridable with `OATHRION_MAX_TOOL_ATTEMPTS` for a deployment whose tools are
 * genuinely idempotent. Read once at module load: this is a deployment decision,
 * not something a request may influence. An unparseable or out-of-range value
 * falls back to the default rather than disabling the ceiling, because a typo in
 * an env var must never silently remove a safety limit.
 */
const DEFAULT_MAX_TOOL_ATTEMPTS = 5;
/** A ceiling above this is not a ceiling; refuse it rather than honour it. */
const HARD_MAX_TOOL_ATTEMPTS = 20;

export const MAX_TOOL_ATTEMPTS: number = readAttemptCeiling();

function readAttemptCeiling(): number {
  const raw = process.env.OATHRION_MAX_TOOL_ATTEMPTS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_TOOL_ATTEMPTS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > HARD_MAX_TOOL_ATTEMPTS) {
    console.warn(
      `[limits] OATHRION_MAX_TOOL_ATTEMPTS="${raw}" is not an integer between 1 and ` +
        `${HARD_MAX_TOOL_ATTEMPTS}. Falling back to ${DEFAULT_MAX_TOOL_ATTEMPTS}.`,
    );
    return DEFAULT_MAX_TOOL_ATTEMPTS;
  }
  return parsed;
}

/**
 * How many **resolved** approvals `GET /api/approvals` returns. Pending approvals
 * are never subject to this cap.
 *
 * WHY THERE IS A CEILING AT ALL
 * -----------------------------
 * `script/pilot-sim.ts` aged a database to ninety days of one pilot company's
 * traffic and asked for what the console asks for. `/api/executions` returned 300
 * rows and `/api/audit` 200 — both already capped — while `/api/approvals`
 * returned 5 760 rows and 2.1 MB in a single response, on every page load. The
 * approvals repository was simply the one list that had never been given a limit.
 *
 * WHY THE CAP APPLIES ONLY TO RESOLVED ROWS
 * -----------------------------------------
 * `client/src/components/layout/Sidebar.tsx` and `shared/metrics.ts` both count
 * pending approvals by filtering this response. A plain "newest N" cap would drop
 * old pending rows and make both counters understate the queue silently — the
 * operator sees a badge of 300 while 1 400 requests wait. Resolved history is the
 * half that grows without bound and that nothing counts, so that is the half that
 * is trimmed.
 *
 * WHY 300
 * -------
 * The number `GET /api/executions` already uses. A second, different ceiling for
 * the same kind of list would be a number to remember for no reason.
 */
export const DEFAULT_RESOLVED_APPROVAL_LIMIT = 300;
