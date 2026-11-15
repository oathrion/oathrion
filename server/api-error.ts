/**
 * One place that writes an error response.
 *
 * WHY THIS EXISTS
 * ---------------
 * Error bodies were produced in five unrelated places, and they did not agree:
 *
 *     server/routes.ts        fail()                → { error }
 *     server/auth.ts          401 / 403             → { error } (+ role on the 403)
 *     server/rate-limit/      429                   → { error }
 *     server/routes.ts:1252   unmatched /api        → { message }
 *     server/index.ts         last-resort handler   → { message }
 *
 * A client therefore had to read two different keys depending on which layer refused
 * it, and no layer sent a code or a correlation id. Centralising it here is what makes
 * "every error carries a stable code" true for the whole surface instead of true for
 * the handlers someone remembered to edit.
 *
 * This module deliberately depends on almost nothing — the code registry and the
 * request context — so it can be imported by the authentication gate and the rate
 * limiter without creating an import cycle through `routes.ts`.
 */

import type { Response } from "express";
import { type ApiErrorBody, codeForStatus } from "../shared/error-codes";
import { currentRequestId } from "./request-context";

/**
 * Builds the body. Separate from sending it so a test can assert the shape without an
 * HTTP round trip, and so a route needing to add a field (the 403 adds `role`) can
 * spread this rather than reconstructing it and drifting.
 */
export function apiErrorBody(status: number, message: string, code?: string): ApiErrorBody {
  const body: ApiErrorBody = {
    error: message,
    message,
    code: code ?? codeForStatus(status),
  };
  /*
   * Omitted rather than sent as null when there is no context. A response produced
   * outside a request — a startup failure, a test calling this directly — has no id to
   * report, and `"requestId": null` would invite a client to display an empty field or
   * quote the word "null" in a support ticket.
   */
  const requestId = currentRequestId();
  if (requestId) body.requestId = requestId;
  return body;
}

/**
 * Sends an error response.
 *
 * `extra` exists for the one field a caller legitimately adds: the capability gate
 * returns the caller's own role alongside its 403, which the console uses to explain
 * the refusal. It is spread *after* the standard fields deliberately — a caller must
 * be able to override nothing important by accident, and if a future caller does pass
 * `code`, the explicit `code` argument is the one that was reviewed. So `extra` is
 * applied first, then the standard body overwrites it.
 */
export function sendApiError(
  res: Response,
  status: number,
  message: string,
  code?: string,
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({ ...extra, ...apiErrorBody(status, message, code) });
}
