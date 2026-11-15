/**
 * Typed failures for the Oathrion client.
 *
 * THE ONE RULE THIS FILE ENFORCES
 * -------------------------------
 * A failure is never a decision. Every error here is thrown; none of them
 * carries a `decision` field, and there is no code path in this SDK that turns
 * a thrown error into ALLOW, BLOCK or APPROVAL_REQUIRED.
 *
 * That asymmetry is deliberate and it is the whole safety argument for the
 * client. If a network timeout produced a synthesised BLOCK, the SDK would be
 * quietly answering authorization questions on its own — and the day someone
 * decided the synthesised default should be ALLOW "so the agent keeps working
 * during an outage", the change would look like a one-word edit rather than
 * like the removal of the control plane. Making a failure structurally
 * incapable of being a decision closes that door.
 *
 * The caller therefore has exactly two outcomes to handle: a `DecisionResult`
 * that Oathrion produced, or an exception. There is no third state.
 */

import type { ApiErrorResponse } from "./types";

/** Base class, so callers can `catch (e) { if (e instanceof OathrionError) ... }`. */
export class OathrionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The request never produced an HTTP response: DNS failure, refused connection,
 * TLS failure, or an aborted timeout.
 */
export class OathrionConnectionError extends OathrionError {
  /** The underlying failure, kept for diagnosis rather than re-thrown raw. */
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** The request exceeded the client's timeout and was aborted. */
export class OathrionTimeoutError extends OathrionConnectionError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(
      `Oathrion did not answer within ${timeoutMs}ms. No decision was received, so the action is NOT authorised.`,
      cause,
    );
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Oathrion answered, and the answer was not a decision.
 *
 * 401/403 (credential), 400 (payload), 429 (rate limit or quota), 5xx. The
 * status and the server's error code are exposed so a caller can branch, but no
 * branch of that decision tree may end in "proceed anyway".
 */
export class OathrionHttpError extends OathrionError {
  readonly status: number;
  /** Oathrion's stable error code, e.g. `agent_binding_violation`. */
  readonly code: string;
  /** Correlation id for the server logs, when the server supplied one. */
  readonly requestId?: string;
  readonly body?: ApiErrorResponse;

  constructor(status: number, body: ApiErrorResponse | undefined, fallbackMessage: string) {
    super(body?.message ?? body?.error ?? fallbackMessage);
    this.status = status;
    this.code = body?.code ?? `http_${status}`;
    this.requestId = body?.requestId;
    this.body = body;
  }

  /** True for 401/403: the credential, not the request, is the problem. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** True for 400: Oathrion could not interpret the request. */
  get isRequestInvalid(): boolean {
    return this.status === 400;
  }
}

/**
 * Oathrion answered 200 with a body this SDK cannot interpret as a decision.
 *
 * Raised rather than coerced. A 200 whose `decision` is missing or is a value
 * outside the known three is a version skew or a proxy rewriting responses, and
 * the safe reading of "I do not understand the answer" is not to pick one.
 */
export class OathrionProtocolError extends OathrionError {
  readonly payload: unknown;

  constructor(message: string, payload: unknown) {
    super(message);
    this.payload = payload;
  }
}

/**
 * Thrown by `requireAllow()` when the decision was not ALLOW.
 *
 * The decision is attached, so a caller can inspect the reason, the policy, and
 * the approval id without a second call.
 */
export class OathrionNotAllowedError extends OathrionError {
  readonly decision: "BLOCK" | "APPROVAL_REQUIRED";
  readonly reason: string;
  readonly policyId: string | null;
  readonly approvalId: string | null;

  constructor(result: {
    decision: "BLOCK" | "APPROVAL_REQUIRED";
    reason: string;
    policyId: string | null;
    approvalId: string | null;
  }) {
    super(
      result.decision === "APPROVAL_REQUIRED"
        ? `Action held for human approval and NOT authorised: ${result.reason}`
        : `Action blocked: ${result.reason}`,
    );
    this.decision = result.decision;
    this.reason = result.reason;
    this.policyId = result.policyId;
    this.approvalId = result.approvalId;
  }
}
