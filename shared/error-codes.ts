/**
 * P1-3 — stable machine-readable error codes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every error the API returned carried a human sentence and nothing else:
 *
 *     { "error": "Role \"viewer\" cannot manage. Required capability: manage." }
 *
 * A client that needs to behave differently for "your credential expired" than for
 * "your role is too low" has exactly one way to tell them apart: match that string.
 * Both are 403 in some paths, both are prose written for a person, and both are the
 * kind of text that gets reworded — so any integration built on them breaks on a
 * copy-edit, silently, in the client's code rather than ours. Message text is not an
 * API contract and must not be forced to act as one.
 *
 * WHAT A CODE PROMISES
 * --------------------
 * The code is the contract; the message is not. A code is never renamed or re-pointed
 * at a different meaning once released — a client keying on it must keep working. New
 * codes may be added, so a client must treat an unknown code as "an error of this HTTP
 * status" rather than a crash. That is why every code is at least as specific as its
 * status and never contradicts it.
 *
 * WHY THE SET IS SMALL
 * --------------------
 * It covers what the server actually distinguishes today, and nothing else. Codes for
 * conditions no route raises would be an invented contract: they would be documented,
 * clients would branch on them, and nothing would ever emit them. Later phases add
 * codes as they add the conditions — an idempotency conflict in P4, a quota refusal in
 * P3 — rather than reserving names now for behaviour that does not exist.
 */

/**
 * Fallback codes, derived from the HTTP status.
 *
 * A generic code is not a placeholder to be tightened later; it is the honest answer
 * when the server genuinely knows no more than the status. This mapping is what lets
 * every one of the ~34 routes gain a code without editing each handler to guess at a
 * classification it does not have — an edit that would have been a large diff over
 * working code, mostly wrong, to add precision that was never measured.
 */
export const STATUS_ERROR_CODES: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable_entity",
  429: "rate_limited",
  500: "internal_error",
  503: "unavailable",
};

/**
 * Codes for conditions the server distinguishes on purpose, beyond what the status says.
 *
 * Each of these exists because a client has a different correct reaction, not because a
 * finer name was available:
 *
 *  - `unauthenticated` / `invalid_credentials` — both 401, but the first means "you sent
 *    no bearer credential" (re-authenticate) and the second "the one you sent is not
 *    valid" (stop retrying with it). The response message deliberately stays vague for
 *    login itself; these two are the transport-level distinction the gate already makes
 *    in `server/auth.ts`, and it discloses nothing about whether an account exists.
 *  - `forbidden_capability` — the credential is valid and the role is too low. A client
 *    must not retry this; nothing about the request will change the outcome. It is the
 *    one 403 whose remedy is "ask an administrator", not "fix the request".
 *  - `rate_limited` / `login_throttled` — both 429. The first is the shared request
 *    limiter and a caller should back off and retry. The second is the per-IP login
 *    throttle: retrying the same password is what caused it.
 *  - `not_ready` — 503 from the readiness probe. Distinct from `unavailable` so a probe
 *    consumer can tell "this instance is deliberately not taking traffic" from any
 *    other 503.
 */
export const ERROR_CODES = {
  unauthenticated: "unauthenticated",
  invalidCredentials: "invalid_credentials",
  /**
   * Une requête qui modifie, authentifiée par le seul cookie de session de la console, sans
   * l'en-tête `X-Oathrion-Console` : la seconde protection contre la requête forgée
   * (`server/session-cookie.ts`). La console le pose toujours ; un autre site ne le peut pas.
   */
  consoleHeaderRequired: "console_header_required",
  forbiddenCapability: "forbidden_capability",
  notFound: "not_found",
  badRequest: "bad_request",
  rateLimited: "rate_limited",
  loginThrottled: "login_throttled",
  internalError: "internal_error",
  notReady: "not_ready",
  /**
   * The path carried an `/api/v<n>` prefix for a version this build does not serve (P2).
   *
   * Distinct from `not_found` on purpose. "That version does not exist here" and "that
   * resource does not exist" call for different reactions: the first is fixed by changing
   * one constant in the client, the second is not fixable by the client at all. Without
   * the distinction, a caller pinned to a version this deployment predates sees the same
   * 404 as a typo and has no way to tell that its own configuration is the problem.
   *
   * It discloses only what README §12 already states publicly, and nothing about which
   * paths exist — the answer is identical for `/api/v9/agents` and `/api/v9/nonsense`.
   */
  unsupportedApiVersion: "unsupported_api_version",
  /**
   * The organization has reached a per-tenant ceiling (P3).
   *
   * Distinct from `rate_limited`, and the distinction is the whole reason this code
   * exists rather than reusing the 429 the limiter already sends. `rate_limited` means
   * "you are going too fast" and the correct reaction is to back off and repeat the
   * identical request. `quota_exceeded` means "your tenant holds as many of these as
   * it may" and backing off changes nothing: the caller has to delete something, or
   * its operator has to raise the ceiling. A client that could not tell them apart
   * would retry forever against a wall.
   *
   * Carried on two statuses on purpose — 409 for a ceiling on live rows, 429 with
   * `Retry-After` for a ceiling on events in a period, because only the second is
   * resolved by waiting. The body always names `counter`, `limit`, `used` and
   * `resetAt`, so which one it is never has to be inferred from the status.
   */
  quotaExceeded: "quota_exceeded",
  /**
   * L'instance a atteint son plafond de requêtes en cours (`OATHRION_MAX_IN_FLIGHT`) et
   * refuse aussitôt, avec `Retry-After`. Distinct de `unavailable` (base injoignable) et
   * de `not_ready` (instance en vidange) : ici rien n'est en panne, il y a trop de monde,
   * et réessayer une seconde plus tard est exactement la bonne réaction.
   */
  overloaded: "overloaded",
  /**
   * The credential is bound to one agent and the request named a different one (P6).
   *
   * A 403, and distinct from `forbidden_capability`, because the two have opposite
   * remedies. `forbidden_capability` means "your role is too low" and the fix is to
   * ask an administrator for a wider role. This means "your credential is the wrong
   * one for this agent", and a wider role would not help at all — the caller needs a
   * credential issued for that agent, or it needs to stop naming an agent that is not
   * its own. A client that could not tell them apart would escalate a privilege
   * request for a problem that is not about privilege.
   *
   * Also raised when a bound credential tries to retry an execution belonging to a
   * different agent, which is the same violation reached without naming an agent.
   */
  agentBindingViolation: "agent_binding_violation",
  /**
   * The deployment requires bound credentials and this one is not bound (P6).
   *
   * Separate from `agent_binding_violation` because the remedy is different again:
   * nothing about the request is wrong, and no other agent id would work. The
   * credential itself has to be reissued with a binding. Reporting this as a
   * violation would send an integrator hunting for a mismatched agent id that does
   * not exist.
   */
  agentBindingRequired: "agent_binding_required",
  /**
   * No agent was named and the credential is not bound to one (P6).
   *
   * 400, not 403: the request is incomplete rather than refused. Oathrion authorises per
   * agent and has no default, so there is nothing to fall back to.
   */
  agentNotDeclared: "agent_not_declared",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * The code for a status when the caller supplied none.
 *
 * An unmapped status falls back by class rather than to a single catch-all: a future
 * 402 or 451 should not be reported to a client as `internal_error`, which would be a
 * false statement about whose fault it is.
 */
export function codeForStatus(status: number): string {
  const known = STATUS_ERROR_CODES[status];
  if (known) return known;
  if (status >= 500) return "internal_error";
  if (status >= 400) return "bad_request";
  // Not an error status at all. Reached only by a caller misusing the error builder;
  // naming that plainly beats inventing a code that would look like a real condition.
  return "unknown";
}

/**
 * The shape of every error body the API returns.
 *
 * `error` and `message` carry the same sentence. That duplication is not an oversight
 * and is not transitional:
 *
 *  - `error` is what every existing response has used and what the test suite and any
 *    current integration reads. Removing it would break them for cosmetic gain.
 *  - `message` is what `client/src/lib/queryClient.ts` reads — and, because the server
 *    only ever sent `error`, the console fell through to its raw-text fallback and
 *    displayed the literal JSON `{"error":"Authentication required"}` in the UI for
 *    every 400, 401, 403 and 404. The last-resort 500 handler in `server/index.ts` was
 *    the only path that sent `message`, so the one error the console rendered properly
 *    was the one with the least to say.
 *
 * Both keys, populated identically, fix the console without breaking a caller.
 */
export interface ApiErrorBody {
  /** Human-readable, for a person. Not a contract: may be reworded at any time. */
  error: string;
  /** The same sentence, under the key the web console reads. */
  message: string;
  /** Machine-readable and stable. This is the contract. */
  code: string;
  /** Correlation id of the request that failed, for quoting in a support request. */
  requestId?: string;
}
