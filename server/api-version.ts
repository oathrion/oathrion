/**
 * P2 — resolves the `/api/v<n>` prefix into the single, unversioned set of route handlers.
 *
 * ## The choice that shapes this file
 *
 * There were two ways to serve `/api/v1/…`:
 *
 * 1. **Register every route twice** — mount a `Router` at `/api` and again at `/api/v1`.
 * 2. **Rewrite the URL once**, before anything reads it, and keep one set of handlers.
 *
 * (1) was rejected after inspecting the code rather than on taste. The 30 API paths in
 * `server/routes.ts` are registered directly on `app` — there is no `express.Router` to
 * re-mount — so option (1) means either a large refactor of the file that holds the whole
 * governed surface, or a literal second registration. A second registration creates two
 * routing tables that must agree forever: the day someone adds a route to one and not the
 * other, a path exists under `/api` and 404s under `/api/v1`, or worse, a route that was
 * meant to be capability-checked is reachable under a prefix where the check was not
 * copied. That is a security divergence waiting to happen, and nothing in the test suite
 * would catch it by construction.
 *
 * (2) has exactly one routing table. A route added tomorrow is automatically served under
 * both prefixes with the same capability checks, the same rate-limit scope and the same
 * tenancy scoping, because it *is* the same handler. The parity tests in
 * `server/test/api-version.test.ts` assert that, and they cannot silently pass by
 * checking nothing.
 *
 * ## Why it must run before the authentication gate
 *
 * `authenticate()` (server/auth.ts) decides on `req.path`: it lets anything outside
 * `/api` through untouched, then consults `PUBLIC_API_PATHS`, a `Set` of four exact
 * strings — `/api/auth/login`, `/api/health`, `/api/live`, `/api/ready`.
 *
 * Both failure modes of getting this order wrong are real:
 *
 *  - Rewriting **after** the gate: `/api/v1/live` is not in the set, so a Kubernetes
 *    liveness probe using the versioned path gets 401, is read as "container dead", and
 *    the orchestrator restarts healthy replicas. `/api/v1/auth/login` would 401 too,
 *    making it impossible to obtain the credential needed to authenticate.
 *  - Making the gate itself version-aware instead: the public set is the single most
 *    security-sensitive list in the codebase. Turning four exact-string comparisons into
 *    pattern matching, to serve a routing concern, is the kind of change that adds an
 *    accidentally-public path. §14 of the brief — *no action may bypass the policy
 *    engine* — argues for touching that comparison as little as possible.
 *
 * Rewriting first means the gate keeps its four exact strings and its exact-match
 * semantics, and has no idea versions exist. **The gate was not modified in this phase.**
 *
 * ## What is deliberately preserved
 *
 * `req.originalUrl` is set by Express before any middleware and is not touched here, so
 * the versioned form a caller actually used stays available for diagnostics even after
 * `req.url` is rewritten. `req.apiVersion` records the version explicitly, which is what
 * lets an operator measure how many callers are still unversioned before a v2 is
 * contemplated.
 */

import type { Express, Request, RequestHandler } from "express";
import { ERROR_CODES } from "@shared/error-codes";
import {
  CURRENT_API_VERSION,
  SUPPORTED_API_VERSIONS,
  apiVersionOf,
  isSupportedApiVersion,
  unversionedPath,
} from "@shared/api-version";
import { sendApiError } from "./api-error";

declare module "express-serve-static-core" {
  interface Request {
    /**
     * The version the caller pinned, or `undefined` when the caller used the
     * unversioned `/api/…` form.
     *
     * Not defaulted to `CURRENT_API_VERSION`: "did not ask" is a different fact from
     * "asked for v1", and only the first identifies a caller a future version bump will
     * silently affect.
     */
    apiVersion?: number;
  }
}

/**
 * Rewrites `/api/v<n>/…` to `/api/…` for a supported `n`, and refuses an unsupported one.
 *
 * ### Why an unsupported version is answered here rather than by the 404 catch-all
 *
 * Left alone, `/api/v9/agents` would reach `authenticate()`, be treated as a normal
 * closed API path, and answer 401 without a credential or `not_found` with one. Both are
 * misleading in the same expensive way: a caller pinned to a version this deployment does
 * not serve is told "wrong credential" or "no such resource" when the truth is "wrong
 * version", and will look for the fault in the wrong place.
 *
 * This does answer before authentication, so an anonymous caller learns which versions
 * exist. That is information README §12 publishes on purpose, and it is not a path
 * oracle: the reply is byte-identical for `/api/v9/agents` and `/api/v9/does-not-exist`,
 * so it cannot be used to enumerate the surface. It carries no `Allow`-style hint and no
 * detail about the request.
 *
 * 404 rather than 400: the resource identified by that URL genuinely does not exist on
 * this server. A 400 would suggest the request was malformed, which it was not — the same
 * request will succeed verbatim against a deployment that serves that version.
 */
export function apiVersioning(): RequestHandler {
  return (req: Request, res, next) => {
    const requested = apiVersionOf(req.path);

    if (requested === undefined) {
      /*
       * No version segment. Left completely untouched — including non-API paths, which
       * must reach the console's static handler exactly as before. The unversioned form
       * remains a supported alias of the current version, so `req.apiVersion` stays
       * `undefined` rather than being back-filled.
       */
      return next();
    }

    if (!isSupportedApiVersion(requested)) {
      return sendApiError(res, 404, versionRefusalMessage(requested), ERROR_CODES.unsupportedApiVersion, {
        requestedVersion: requested,
        supportedVersions: [...SUPPORTED_API_VERSIONS],
      });
    }

    req.apiVersion = requested;

    /*
     * The rewrite itself.
     *
     * `req.url` is what Express routes on and what `req.path` is derived from, so
     * replacing the prefix here makes every downstream reader — the gate, the routing
     * table, the 404 catch-all — see the unversioned path with no knowledge of versions.
     *
     * The query string is preserved because only the leading path segment is replaced;
     * `unversionedPath` is anchored at the start of the string and stops at the first
     * `/` or end-of-segment, so `?limit=50` and any `#`-free remainder survive intact.
     * Losing the query string would silently break the paginated audit endpoint, whose
     * bounds arrive that way.
     */
    const [pathname, ...rest] = req.url.split("?");
    const query = rest.length > 0 ? `?${rest.join("?")}` : "";
    req.url = `${unversionedPath(pathname)}${query}`;

    next();
  };
}

function versionRefusalMessage(requested: number): string {
  const supported = SUPPORTED_API_VERSIONS.map((version) => `v${version}`).join(", ");
  return `API version v${requested} is not served by this deployment. Supported: ${supported}. Unversioned /api paths are served by v${CURRENT_API_VERSION}.`;
}

/**
 * Mounts the rewrite. A named function rather than an inline `app.use` so
 * `server/index.ts`, the test harness and any future entrypoint mount it identically —
 * a middleware that production has and the tests do not is untestable by construction,
 * which is precisely how §14's redaction went unprotected for hundreds of tests.
 */
export function applyApiVersioning(app: Express): void {
  app.use(apiVersioning());
}
