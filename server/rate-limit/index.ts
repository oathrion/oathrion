/**
 * The rate-limit service: store selection, fail mode, and the Express middleware.
 *
 * ## Architecture
 *
 *   route handler
 *      -> rateLimit(scope, max, windowMs)      <- the middleware, engine-agnostic
 *           -> QuotaStore.consume(...)          <- one atomic operation
 *                -> MemoryQuotaStore   (one instance)
 *                -> PostgresQuotaStore (many instances, one counter)
 *
 * Nothing above this line knows which store is in use, and nothing below it knows
 * what an HTTP request is. The routes were not changed by P0-7: they still call
 * `rateLimit("write", 30, RATE_WINDOW_MS)` with the same scopes, the same limits and
 * the same window, because the identity and the dimensions the product limits on
 * were already correct — what was wrong was that the counter was local.
 */

import type { NextFunction, Request, Response } from "express";
import { MemoryQuotaStore, type QuotaStore } from "./store";
import { PostgresQuotaStore } from "./postgres-store";
import { sendApiError } from "../api-error";
import { ERROR_CODES } from "@shared/error-codes";
import { parseRateLimits, type RateLimits, type RateLimitScope } from "./limits";
import { increment, noteRateLimitStore } from "../observability/metrics";

export {
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_SCOPES,
  describeRateLimits,
  rateLimitConfigProblems,
  rateLimitVariable,
  type RateLimitScope,
  type RateLimits,
} from "./limits";
import "../env-compat";
import { timed } from "../observability/timing";

export type { QuotaDecision, QuotaStore } from "./store";
export { MemoryQuotaStore } from "./store";
export { PostgresQuotaStore } from "./postgres-store";

/**
 * What happens when the shared store cannot be reached.
 *
 * `closed` (the default) refuses the request with 503. `open` lets it through.
 *
 * The default is closed, and this is a security decision rather than a preference.
 * These limiters guard the decision endpoint, the write endpoints, the approval
 * endpoints and — through the login throttle — password verification. If an
 * unreachable counter meant "allow", then an attacker who can disrupt the store
 * (or who simply picks the moment it is being restarted) has removed the brute-force
 * protection on the sign-in endpoint by making an *infrastructure* component fail.
 * A limiter outage that silently becomes a security bypass is worse than an outage
 * that is visible.
 *
 * `open` exists because for a limiter that only protects capacity, availability may
 * legitimately matter more than the ceiling — but it has to be chosen explicitly,
 * by name, in the environment, and it is reported at boot.
 */
export type FailMode = "closed" | "open";

export function resolveFailMode(env: NodeJS.ProcessEnv = process.env): FailMode {
  const raw = env.RATE_LIMIT_FAIL_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "closed";
  if (raw === "closed" || raw === "open") return raw;
  throw new Error(
    `RATE_LIMIT_FAIL_MODE is "${raw}", which is neither "closed" nor "open". ` +
      `An unrecognised value is refused rather than defaulted, because the two answers differ by ` +
      `whether a store outage removes your brute-force protection.`,
  );
}

/* ----------------------------- store selection ---------------------------- */

let store: QuotaStore | undefined;
let failMode: FailMode | undefined;
let limits: RateLimits | undefined;

/**
 * Les plafonds en vigueur, mémorisés après la première lecture — comme le store et le
 * mode d'échec juste au-dessus, et pour la même raison : relire l'environnement à chaque
 * requête du chemin chaud serait un coût gratuit, et une valeur qui change en cours de
 * vie du processus n'aurait aucun sens pour un réglage de déploiement.
 */
export function activeRateLimits(): RateLimits {
  limits ??= parseRateLimits();
  return limits;
}

/**
 * Selects the store from the environment, explicitly.
 *
 * `RATE_LIMIT_STORE` is read on its own and is never inferred from
 * `DATABASE_DRIVER`: the two are independent on purpose, because the supported
 * production shape today is application data on SQLite with a shared limiter on
 * PostgreSQL. Deriving one from the other would make that shape unreachable, and
 * deriving it from the mere presence of `DATABASE_URL` would let a variable
 * inherited from a platform's defaults quietly change how the limiter behaves.
 */
export function resolveStore(env: NodeJS.ProcessEnv = process.env): QuotaStore {
  const raw = env.RATE_LIMIT_STORE?.trim().toLowerCase();

  if (raw === undefined || raw === "" || raw === "memory") {
    return new MemoryQuotaStore();
  }

  if (raw === "postgres" || raw === "postgresql") {
    const url = env.DATABASE_URL?.trim();
    if (url === undefined || url === "") {
      throw new Error(
        `RATE_LIMIT_STORE is "postgres" but DATABASE_URL is not set. The shared limiter has no ` +
          `default connection: a limiter that silently fell back to a process-local counter would ` +
          `report a shared limit it is not enforcing.`,
      );
    }
    return new PostgresQuotaStore(url);
  }

  throw new Error(
    `RATE_LIMIT_STORE is "${raw}", which is not a store Oathrion supports. Valid values: memory, postgres.`,
  );
}

/** The active store, created on first use. */
export function quotaStore(): QuotaStore {
  store ??= resolveStore();
  return store;
}

/**
 * La posture en vigueur, mémoïsée. Exportée depuis l'étape 7 pour que la page de
 * métriques puisse l'ANNONCER : `RATE_LIMIT_FAIL_MODE=open` est légal, et c'est
 * précisément pour cela qu'un exploitant doit pouvoir le voir sur un tableau de bord
 * plutôt que de le déduire d'une ligne de démarrage vieille de trois semaines.
 *
 * Exportée et non recalculée côté métriques : la posture mémoïsée ici est celle que le
 * limiteur applique réellement, et un second lecteur de `RATE_LIMIT_FAIL_MODE`
 * afficherait la configuration au lieu du comportement — l'écart exact que
 * `securityPostureNotices` a déjà connu avec la liaison d'agent dans le bundle.
 */
export function activeFailMode(): FailMode {
  failMode ??= resolveFailMode();
  return failMode;
}

/**
 * Test seam: installs a specific store and fail mode. Never called by the server.
 *
 * This is what lets the multi-instance tests build two independent limiter
 * "instances" over one store — the thing that is impossible to test with a module
 * that reaches for a private `Map`.
 */
export function configureRateLimit(next: { store?: QuotaStore; failMode?: FailMode }): void {
  if (next.store !== undefined) store = next.store;
  if (next.failMode !== undefined) failMode = next.failMode;
}

/** Test seam: forgets the selection so the next call re-reads the environment. */
export function resetRateLimitConfig(): void {
  store = undefined;
  failMode = undefined;
  limits = undefined;
}

/**
 * Test seam: clears every bucket in the active store. Never called by the server.
 *
 * Returns `void`, not a promise, and the existing synchronous call sites in the
 * suites are why. `MemoryQuotaStore.reset()` empties its map in the synchronous part
 * of its body — before the promise it returns is even created — so an unawaited call
 * has already taken effect by the time it returns. That is true only for the memory
 * store; with the PostgreSQL store this is fire-and-forget, which is why the shared
 * tests call `store.reset()` directly and await it instead of going through here.
 */
export function resetRateLimits(): void {
  void quotaStore().reset();
}

/** Called from the graceful-shutdown path, alongside `closeDatabase()`. */
export async function closeRateLimitStore(): Promise<void> {
  if (store === undefined) return;
  await store.close();
}

/* -------------------------------- middleware ------------------------------- */

export function quotaKey(req: Request, scope: string): string {
  /*
   * The authenticated identity, not the IP — unchanged from the previous limiter and
   * deliberately preserved. Every route this guards runs after `authenticate()`, so
   * budgets are per credential: a shared office address behind one proxy never makes
   * two different API keys share a budget. The IP is a defensive fallback only.
   */
  const identity = (req as Request & { identity?: { id: string } }).identity;
  const subject = identity?.id ?? req.ip ?? "unknown";
  return `${scope}:${subject}`;
}

/**
 * Builds a middleware allowing `max` requests per `windowMs` for a route scope,
 * keyed by the authenticated caller. Must be mounted after `authenticate()`.
 *
 * Asynchronous now, because the store may be. Express 5 forwards a rejected promise
 * from a middleware to the error handler, but this one never rejects: a store
 * failure is turned into an explicit, tested decision here rather than into a
 * generic 500, because "the limiter broke" and "your request was invalid" must not
 * look the same to the caller or to the operator reading the logs.
 */
export function rateLimit(scope: RateLimitScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = quotaKey(req, scope);

    /*
     * Le plafond est lu ICI, et non figé à la construction du middleware. Les trois
     * valeurs étaient des littéraux dans `routes.ts`, donc inajustables sans recompiler ;
     * les lire par la même voie que `quotaStore()` et `activeFailMode()` les rend
     * configurables sans ajouter un second chemin de lecture.
     */
    const { perScope, windowMs } = activeRateLimits();
    const max = perScope[scope];

    let decision;
    try {
      decision = await timed("ratelimit", () => quotaStore().consume(key, max, windowMs));
    } catch (error) {
      const mode = activeFailMode();
      console.error(
        `[rate-limit] the quota store failed for scope "${scope}" (fail mode: ${mode}):`,
        error instanceof Error ? error.message : String(error),
      );
      /*
       * Les trois issues sont comptées ICI, au point unique où elles se décident.
       * `store_unavailable` est celle qui doit réveiller quelqu'un : en posture
       * `closed` elle refuse du trafic client légitime, et en posture `open` elle a
       * retiré la protection anti-force-brute de la page de connexion sans que rien
       * ne le dise.
       */
      noteRateLimitStore(false);
      increment("oathrion_rate_limit_outcomes_total", { scope, outcome: "store_unavailable" });
      if (mode === "open") {
        next();
        return;
      }
      /*
       * 503 and not 429: the caller did nothing wrong and their quota is not
       * exhausted, so telling them to slow down would be false and would make them
       * back off for a window that does not exist. 503 is the accurate answer — the
       * server cannot serve this right now — and `Retry-After` gives a short,
       * honest interval.
       */
      res.setHeader("Retry-After", "5");
      sendApiError(
        res,
        503,
        "The request could not be rate-limited right now, so it was not accepted. Try again shortly.",
      );
      return;
    }

    noteRateLimitStore(true);

    if (!decision.allowed) {
      increment("oathrion_rate_limit_outcomes_total", { scope, outcome: "rejected" });
      const retryAfterSec = Math.ceil((decision.resetAt - Date.now()) / 1000);
      res.setHeader("Retry-After", String(Math.max(retryAfterSec, 1)));
      sendApiError(
        res,
        429,
        "Too many requests. Slow down and try again shortly.",
        ERROR_CODES.rateLimited,
      );
      return;
    }

    increment("oathrion_rate_limit_outcomes_total", { scope, outcome: "allowed" });
    next();
  };
}
