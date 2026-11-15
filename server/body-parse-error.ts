/**
 * Turns a body-parser rejection into Oathrion's JSON error envelope.
 *
 * THE DEFECT THIS CLOSES (Phase 8, P8-2)
 * --------------------------------------
 * `express.json()` rejects a malformed or non-object body before any route
 * runs, and its default handler answers with Express's built-in HTML error
 * page. The status was already correct — 400, fail-closed, no decision reached
 * the engine — so this is not a security hole. It is a contract hole, and it
 * lands squarely on the audience Phase 8 exists for.
 *
 * Every other non-2xx on this API returns `{ error, message, code, requestId }`.
 * A client written against that contract — including both SDKs in this
 * repository — parses the body to build a typed error. Handed `<!DOCTYPE html>`
 * it throws a `SyntaxError: Unexpected token '<'` from inside its own JSON
 * parsing, which is the least informative possible way to be told "your
 * payload was not an object", and it loses the request id that would let anyone
 * find the event in the logs.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not accept anything the parser refused, and it does not soften a
 * status. A body Oathrion cannot read is a body Oathrion will not act on; the only
 * thing that changes is that the refusal is now legible.
 *
 * Mounted immediately after `express.json()` in BOTH `server/index.ts` and the
 * test harness. Anything production mounts and the harness does not is, by
 * construction, untestable.
 */

import type { NextFunction, Request, Response } from "express";
import { sendApiError } from "./api-error";

/** Express marks body-parser failures with a `type` and an HTTP `status`. */
interface BodyParseError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

function isBodyParseError(error: unknown): error is BodyParseError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as BodyParseError;
  return typeof candidate.type === "string" && candidate.type.startsWith("entity.");
}

/**
 * Human-readable cause, chosen from the parser's own classification.
 *
 * The raw parser message is not forwarded: for a syntax error it embeds a
 * fragment of the offending body, and a body sent to an authorization endpoint
 * may contain exactly the values an operator should not find echoed back in a
 * log or a shared terminal.
 */
function describe(error: BodyParseError): string {
  switch (error.type) {
    case "entity.parse.failed":
      return "Request body must be valid JSON, and must be a JSON object.";
    case "entity.too.large":
      return "Request body is too large.";
    case "encoding.unsupported":
      return "Request body uses an unsupported content encoding.";
    default:
      return "Request body could not be read.";
  }
}

export function bodyParseErrorHandler() {
  return (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!isBodyParseError(error)) return next(error);
    if (res.headersSent) return next(error);

    /*
     * No explicit `code`: it is derived from the status, which is honest about
     * the fact that this handler knows no more than the status. Inventing a
     * finer classification here would claim a precision nobody measured.
     */
    sendApiError(res, error.status ?? error.statusCode ?? 400, describe(error));
  };
}
