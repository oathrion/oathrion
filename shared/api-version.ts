/**
 * P2 — the API's version prefix, in one place that the client, the server and the tests
 * all read.
 *
 * ## Why a version prefix at all
 *
 * Until now every route lived at `/api/…` with no version. That is fine while the only
 * caller is the console shipped in the same bundle: client and server are deployed
 * together, so a breaking change is never observed. It stops being fine the moment a
 * customer's agent authenticates with an API key, because then the API is a contract with
 * somebody who upgrades on their own schedule. Without a version there is no way to make
 * a breaking change without breaking them, and therefore no way to make one at all.
 *
 * ## Why the version lives in the path and not in a header
 *
 * A header (`Accept: application/vnd.placet.v1+json`) is more theoretically correct — the
 * resource is the same, only its representation changes. It is also invisible in a log
 * line, absent from a `curl` a customer pastes into a support ticket, easy to drop at a
 * proxy, and impossible to open in a browser. A path prefix is legible in every one of
 * those places. The cost of the path is that the version is entangled with routing; the
 * benefit is that a human can always see which contract was used.
 *
 * ## Why both prefixes are served
 *
 * `/api/…` keeps working, unchanged, and is not deprecated in this phase. Serving only
 * `/api/v1/…` would break every existing deployment, every operator runbook, the Docker
 * HEALTHCHECK, and the 32 test files and 7 scripts that call the unversioned paths — for
 * no benefit, since the two prefixes reach the *same* handlers. The unversioned prefix is
 * an implicit alias for the current version; `SUPPORTED_API_VERSIONS` and the deprecation
 * policy are documented in README §12.
 *
 * The rule that makes this safe: the version prefix is resolved **before** the
 * authentication gate and then removed, so exactly one set of handlers exists. There is
 * no second copy of a route that could drift, and no route that could be reachable under
 * one prefix and not the other.
 */

/**
 * Versions this build serves. A list rather than a single number because adding v2 must
 * not mean *removing* v1: the whole point of a version is that two contracts can be live
 * at once while callers migrate.
 */
export const SUPPORTED_API_VERSIONS = [1] as const;

export type ApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];

/**
 * The version an unversioned `/api/…` request is served by, and the one the console uses.
 * Callers that pin a version get a stable contract; callers that do not are implicitly on
 * this one and will be the ones affected by a future bump.
 */
export const CURRENT_API_VERSION: ApiVersion = 1;

/** `/api/v1` — the prefix the console and documented integrations use. */
export const API_VERSION_PREFIX = `/api/v${CURRENT_API_VERSION}`;

/**
 * Matches a version segment at the start of a path, and only there.
 *
 * Anchored with `^` and closed with a lookahead for `/` or end-of-string, which together
 * rule out the shapes that would otherwise be mis-read:
 *
 *  - `/api/v1agents` — not a version segment, must stay a (nonexistent) path;
 *  - `/api/agents/v1` — a version-looking string deeper in the path is data, not routing;
 *  - `/api/v1/v1/agents` — one segment is stripped, so this becomes `/api/v1/agents`,
 *    which is a path that does not exist rather than a second rewrite. Stripping
 *    repeatedly would let `/api/v1/v1/v1/health` reach a real handler, giving one
 *    resource infinitely many URLs — bad for caching, for logs, and for any rate limit
 *    or audit that is ever keyed on a path.
 *
 * `\d+` rather than `\d`: `/api/v10/…` must be recognised as *a version that does not
 * exist* and answered as such, not silently treated as unversioned and served.
 */
const VERSION_SEGMENT = /^\/api\/v(\d+)(?=\/|$)/;

/**
 * The version a path asks for: a number for `/api/v<n>/…`, `undefined` for an
 * unversioned `/api/…` path or for anything outside the API.
 *
 * Returning `undefined` rather than defaulting to `CURRENT_API_VERSION` is deliberate:
 * "asked for nothing" and "asked for the current version" are different facts. Only the
 * first is a caller that a future version bump will silently affect, and an operator
 * measuring migration progress needs to tell them apart.
 */
export function apiVersionOf(pathname: string): number | undefined {
  const match = VERSION_SEGMENT.exec(pathname);
  return match ? Number(match[1]) : undefined;
}

export function isSupportedApiVersion(version: number): version is ApiVersion {
  return (SUPPORTED_API_VERSIONS as readonly number[]).includes(version);
}

/**
 * Strips a leading version segment, so `/api/v1/agents` and `/api/agents` become the same
 * string. Anything without one is returned untouched.
 *
 * Used by the routing rewrite and, just as importantly, by anything that inspects a path
 * to make a decision — the request logger's "is this an auth response?" check being the
 * one that would otherwise have become wrong the moment a version prefix existed.
 */
export function unversionedPath(pathname: string): string {
  return pathname.replace(VERSION_SEGMENT, "/api");
}

/**
 * Adds the current version prefix to an unversioned `/api/…` path. Idempotent, and a
 * no-op for a path that already carries any version or is not an API path at all.
 *
 * The console calls this at its single fetch boundary. Doing it there rather than editing
 * the ~35 literal paths in `client/src/lib/api.ts` keeps React Query's cache keys
 * unchanged: those strings are also cache identities, and a key that no longer matches
 * the one an invalidation uses does not fail loudly — it just stops refreshing the view.
 */
export function versionedPath(pathname: string): string {
  if (!pathname.startsWith("/api/") && pathname !== "/api") return pathname;
  if (apiVersionOf(pathname) !== undefined) return pathname;
  return `${API_VERSION_PREFIX}${pathname.slice("/api".length)}`;
}
