/**
 * P1-2 — request correlation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this module the request log line was `GET /api/agents 401 in 0ms`. Nothing
 * tied it to anything else. Under any concurrency at all — which is the only regime
 * that matters in production — the consequences are concrete:
 *
 *  - Two callers hitting the same route at the same time produce two indistinguishable
 *    log lines. An operator investigating "my request failed" cannot tell which line
 *    is the one to read.
 *  - `console.error("[api]", method, path, err)` inside `handle()` and the last-resort
 *    handler in `index.ts` emit a *separate* line from the request line. There was no
 *    key joining the two, so the stack trace and the status code that caused it were
 *    already unrelatable in a log aggregator.
 *  - A user reporting a failure has nothing to quote. The support path was "tell me
 *    roughly when it happened", against a log with no identifier to search for.
 *
 * DESIGN
 * ------
 * The id is stored in an `AsyncLocalStorage`, not threaded through every function
 * signature. That choice is deliberate and has a cost worth stating: reading it is
 * implicit, so a caller cannot tell from a signature that the value is available, and
 * it is lost across a boundary that breaks async context (a raw `EventEmitter`
 * listener registered outside the request, a `setImmediate` chain started elsewhere).
 * The alternative — passing a context object into the repository, service, policy and
 * gateway layers — would touch every module in the server to add a parameter used for
 * logging alone. That is a large edit to working code for a diagnostic, so the
 * implicit read wins here. `currentRequestId()` returns `undefined` rather than
 * throwing when there is no context, so background work logs without an id instead of
 * failing.
 *
 * SECURITY
 * --------
 * An inbound `X-Request-Id` is *not* trusted. It is accepted only if it matches a
 * strict pattern, and replaced with a fresh id otherwise. This is not pedantry: the
 * value is written into log lines and echoed in a response header. Without the
 * pattern a caller could send an id containing `\n` and forge whole log lines —
 * inventing a plausible `[lifecycle] SIGTERM received` entry, or pushing the real
 * line out of a bounded log. The pattern excludes every control character, excludes
 * the comma (so a duplicated header, which Express joins with commas, is rejected
 * rather than accepted as one long value), and caps the length so a caller cannot
 * push 8 KB of padding into every log line.
 *
 * Accepting a caller-supplied id at all is what makes a trace stitchable across a
 * reverse proxy or a calling service that already assigns one. The trade-off is that
 * the id is then attacker-chosen: two different callers may deliberately send the
 * same id. So the id is a correlation key, never an authentication or uniqueness
 * claim, and nothing in the system may use it to make a decision.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { withTimings } from "./observability/timing";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** The header read on the way in and written on the way out. Lower-case: Node normalises. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * What an inbound id may contain.
 *
 * Unreserved URL characters plus `:` — the shapes real infrastructure emits (a UUID, a
 * W3C `traceparent` segment, an nginx `$request_id`, an AWS `X-Amzn-Trace-Id` value).
 * No whitespace, no control characters, no comma. The 8-character floor rejects a
 * useless `1`, which would collide across every caller and make the field worse than
 * empty; the 64 ceiling keeps a log line a log line.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * Normalises an inbound header value, or returns `undefined` if it may not be trusted.
 *
 * Returning `undefined` for a bad value — rather than cleaning it up by stripping the
 * offending characters — is the safer failure. A sanitised id silently means something
 * different from what the caller sent, so a trace stitched on it would join the wrong
 * records with no sign anything happened. A rejected id produces a fresh one, and the
 * break in the trace is visible.
 */
export function sanitiseRequestId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * A fresh id.
 *
 * `randomUUID` rather than a counter: a counter restarts at 1 on every deploy, so ids
 * collide across restarts in exactly the window an operator is most likely to be
 * reading logs. The `req_` prefix makes the value recognisable in a log line without
 * needing the surrounding context, and the result satisfies REQUEST_ID_PATTERN — so
 * an id this server generated survives being passed to another Oathrion instance.
 */
export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "")}`;
}

interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The id of the request being served on this async stack, if there is one. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Runs `fn` inside a context. Exported for tests and for non-HTTP entry points. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/**
 * Prefixes a log message with the current id, or returns it unchanged outside a
 * request. Used by the error paths so a stack trace and the status line that
 * accompanies it share a searchable key.
 */
export function tagged(message: string): string {
  const id = currentRequestId();
  return id ? `[${id}] ${message}` : message;
}

/**
 * Express glue. Must be mounted before anything that logs or answers — including the
 * authentication gate, whose 401 is one of the responses an operator most often needs
 * to correlate.
 *
 * The response header is set immediately rather than at `finish`: a caller has to be
 * able to read the id even from a response the server never finished writing, and
 * headers cannot be added once they are sent.
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = sanitiseRequestId(req.headers[REQUEST_ID_HEADER]);
    const requestId = inbound ?? newRequestId();

    // Recorded on the request too, so a handler can read it without an async hop and
    // so the error builder can find it even if async context has been lost.
    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    /*
     * Le contexte de durées s'ouvre ICI, et pas dans la route du pare-feu : une bonne
     * partie du coût d'un appel est dépensée AVANT qu'une route soit atteinte —
     * l'authentification et le limiteur de débit, qui parlent tous deux à la base. Les
     * mesurer depuis la route les rendait invisibles, et un total inexpliqué invite à
     * optimiser au hasard.
     *
     * Éteint — le défaut — `withTimings` appelle `next` sans rien allouer.
     */
    withRequestId(requestId, () => withTimings(next));
  };
}

/*
 * Augmented through "express-serve-static-core" rather than the global `Express`
 * namespace, matching how `server/auth.ts` adds `req.identity`. With Express 5 types
 * the global namespace is not the one the request type is drawn from, so declaring it
 * there compiles and then silently fails to apply.
 */
declare module "express-serve-static-core" {
  interface Request {
    /** Set by `requestContext()` for every request, trusted only as a log key. */
    requestId?: string;
  }
}
