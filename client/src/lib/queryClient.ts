import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { versionedPath } from "@shared/api-version";

/**
 * P2 — the console pins the API version, and does it at the single fetch boundary below.
 *
 * Every request the console makes goes through `apiRequest` or `getQueryFn`, so applying
 * `versionedPath` in those two places sends the whole console to `/api/v1/...` without
 * editing the ~35 literal paths in `client/src/lib/api.ts`.
 *
 * WHY NOT EDIT THOSE PATHS. Those strings are not only URLs — they are also React Query
 * cache keys (`queryKey: ["/api/keys"]`, then `invalidateQueries({ queryKey: ["/api/keys"] })`
 * after a mutation). Rewriting them by hand means changing dozens of identities that have
 * to keep matching each other across files, and a missed one does not fail loudly: the
 * fetch still works, the invalidation simply stops matching, and a panel quietly shows
 * stale data after a successful write. Applying the prefix at the transport boundary
 * leaves every cache key exactly as it was, so the request is versioned and the cache
 * identity is untouched.
 *
 * `versionedPath` is idempotent and returns anything that is not an `/api` path unchanged,
 * so a caller passing an already-versioned or non-API URL is unaffected.
 */

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/**
 * The session token lives in module memory only.
 *
 * It is deliberately never written to localStorage, sessionStorage or a cookie:
 * those are blocked in the sandboxed preview, and keeping the credential out of
 * persistent storage means closing the tab revokes this browser's access. No
 * API key is ever compiled into the bundle — the console exchanges a password
 * for a short-lived token at runtime.
 */
let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

/**
 * A 401 after the console is already signed in means the session died
 * server-side (expired, revoked, or the server restarted and forgot it) —
 * not that this particular request was malformed. Whoever owns the sign-in
 * state registers a handler here once, so any request layer that hits a 401
 * can fall back to the sign-in screen instead of leaving the app stuck on a
 * stale, unauthenticated view.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/*
 * `X-Oathrion-Console` sur CHAQUE requête : quand la session n'est portée que par le
 * cookie protégé (après un rechargement de page), le serveur refuse une requête qui
 * modifie sans cet en-tête — un autre site ne peut pas le poser (`server/session-cookie.ts`).
 */
function authHeaders(): Record<string, string> {
  return authToken
    ? { Authorization: `Bearer ${authToken}`, "X-Oathrion-Console": "1" }
    : { "X-Oathrion-Console": "1" };
}

/**
 * La session portée par le cookie protégé, s'il y en a une : ce qui permet à un
 * rechargement de page de ne plus déconnecter. Une requête directe, hors du gestionnaire
 * de 401 — « pas de session » est ici une réponse normale, pas une session perdue.
 */
export async function restoreSession<T>(): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${versionedPath("/api/auth/session")}`, { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Turns a failed response into an Error whose message is fit to show a user.
 *
 * This used to throw `new Error(`${status}: ${text}`)` with `text` being the raw
 * response body, so a toast rendered `409: {"message":"This execution has used its
 * 5 permitted tool attempts…"}` — JSON braces, quotes and a status code included.
 * Every API failure in this codebase answers `{ message }`, and that message is
 * written for the caller; the wrapper was hiding it inside a serialised object.
 *
 * Falls back to the raw text, then to the status line, so a response from something
 * that is not our API (a proxy error page, a gateway timeout) still produces
 * something rather than an empty message. The status is kept on the error object for
 * code that needs to branch on it, without being pasted into human-readable text.
 *
 * ## The claim above was false, and this is the correction (P1-3)
 *
 * "Every API failure in this codebase answers `{ message }`" was not true when it was
 * written. Exactly two paths did — the unmatched-path 404 and the last-resort 500 — and
 * every deliberate refusal (401, 403, 404-from-a-route, 400 validation, 429) answered
 * `{ error }`. So `parsed.message` was `undefined` for all of them and this function
 * fell through to the raw-text fallback, putting the literal string
 * `{"error":"Authentication required"}` in front of the user. The one error rendered
 * correctly was the generic 500, which has the least to say.
 *
 * The server now sends both keys. This function reads `error` as well, so the console
 * is not silently dependent on that: a single shape on the server and a tolerant
 * reader on the client are two independent reasons the user sees a sentence.
 */
export class ApiError extends Error {
  readonly status: number;
  /**
   * Stable machine-readable classification, when the server sent one. Prefer this over
   * matching `message`, which is prose and may be reworded. Undefined for a response
   * that did not come from Oathrion — a proxy error page, a gateway timeout.
   */
  readonly code?: string;
  /**
   * Correlation id of the failed request. Worth showing to the user for a 500: it is
   * the key an operator searches the server log with, and without it a support request
   * begins with "roughly when did it happen?".
   */
  readonly requestId?: string;

  constructor(status: number, message: string, code?: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();

    const text = await res.text().catch(() => "");
    let message = text || res.statusText || `Request failed with status ${res.status}`;
    let code: string | undefined;
    let requestId: string | undefined;
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          message?: unknown;
          error?: unknown;
          code?: unknown;
          requestId?: unknown;
        };
        /*
         * `message` first, `error` second. Both are sent by the server today; reading
         * either means an older or newer server, or a response from a layer that was
         * missed, still yields a sentence instead of raw JSON.
         */
        for (const candidate of [parsed.message, parsed.error]) {
          if (typeof candidate === "string" && candidate.trim().length > 0) {
            message = candidate;
            break;
          }
        }
        if (typeof parsed.code === "string") code = parsed.code;
        if (typeof parsed.requestId === "string") requestId = parsed.requestId;
      } catch {
        // Not JSON — keep the raw text, which is better than nothing.
      }
    }

    /*
     * The header is the fallback for the id: a response whose body is not ours (a proxy
     * 502) can still have passed through Oathrion, and the header is set before any handler
     * runs, so it survives a failure that produced no JSON body.
     */
    requestId ??= res.headers.get("x-request-id") ?? undefined;

    throw new ApiError(res.status, message, code, requestId);
  }
}

/**
 * Plus de réponse du tout (« Failed to fetch »). En local : Oathrion s'est arrêté avec le dernier
 * client (vu le 6 novembre), ou il redémarre, le temps de quelques secondes, après une mise à jour
 * (la veille des agents le relance : essai réel du 10 novembre). On dit les deux.
 */
function notAnswering(): string {
  const session = queryClient.getQueryData(["/api/auth/session", "mode"]) as { localMode?: boolean } | undefined;
  return session?.localMode
    ? "Oathrion is not answering. It may be restarting (a few seconds after an update): try again. If it stays down, start it again with: oathrion console"
    : "Oathrion is not answering. Check your connection, then try again.";
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${versionedPath(url)}`, {
      method,
      headers: data
        ? { "Content-Type": "application/json", ...authHeaders() }
        : authHeaders(),
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch {
    throw new Error(notAnswering());
  }

  await throwIfResNotOk(res);
  return res;
}

/**
 * Comme `apiRequest`, mais SANS lever sur un statut d'échec.
 *
 * Il existe un cas où le corps d'une réponse en échec est l'information utile et non une
 * erreur à signaler : `POST /api/connectors/:id/connect` rend un 422 quand LE SERVICE
 * tiers a refusé le credential, avec le code et le message du fournisseur. Un appelant
 * doit pouvoir les afficher.
 *
 * Écrit ici et non dans `api.ts` pour que l'en-tête d'autorisation, le préfixe de version
 * et `API_BASE` restent décidés en un seul endroit. Un `fetch` local dans un module de
 * données serait un second client HTTP qui prendrait du retard sur celui-ci.
 */
export async function apiRequestAllowingFailure(
  method: string,
  url: string,
  data?: unknown,
): Promise<Response> {
  return fetch(`${API_BASE}${versionedPath(url)}`, {
    method,
    headers: data ? { "Content-Type": "application/json", ...authHeaders() } : authHeaders(),
    body: data ? JSON.stringify(data) : undefined,
  });
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    /*
     * The key is joined first and versioned second. React Query keys stay in their
     * unversioned form — which is what keeps `invalidateQueries` matching — and only the
     * URL that goes on the wire carries the prefix.
     */
    const res = await fetch(`${API_BASE}${versionedPath(queryKey.join("/"))}`, {
      headers: authHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      onUnauthorized?.();
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
