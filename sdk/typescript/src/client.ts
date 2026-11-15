/**
 * The Oathrion client.
 *
 * WHAT IT IS
 * ----------
 * A thin, typed HTTP client for one endpoint: `POST /api/evaluate`. It manages
 * the base URL, the credential, serialisation, timeouts and error typing, and
 * it does nothing else.
 *
 * WHAT IT IS FORBIDDEN FROM BEING
 * -------------------------------
 * A second policy engine. There is no rule evaluation in this file, no cache of
 * previous decisions, no local allow-list, no "offline mode", and no default
 * decision of any kind. Everything that decides lives on the server:
 *
 *     your agent -> OathrionClient -> POST /api/evaluate -> Oathrion decision engine
 *
 * Three specific temptations are closed off deliberately, because each one has
 * shipped in real authorization clients and each one is a fail-open:
 *
 *   1. Turning a transport failure into a decision. A timeout means Oathrion did
 *      not answer. It does not mean yes, and it does not mean no. It throws.
 *   2. Turning APPROVAL_REQUIRED into ALLOW. A held action has NOT been
 *      authorised; `isAllowed()` is true only for ALLOW, and `requireAllow()`
 *      throws on a hold exactly as it throws on a block.
 *   3. Caching an ALLOW. Policies, mandates, daily spend counters and agent
 *      status all change between calls; a cached yes is a decision made under
 *      conditions that no longer hold.
 *
 * A DECISION IS NOT ENFORCEMENT — READ THIS BEFORE RELYING ON IT
 * --------------------------------------------------------------
 * When you call Oathrion over HTTP and then act on the answer yourself, Oathrion cannot
 * physically prevent your process from ignoring the answer. What it guarantees
 * is that the decision is authoritative, attributable and recorded: a BLOCK you
 * chose to override is a BLOCK in the audit log. If you need Oathrion to sit
 * physically between the agent and the tool, use the MCP gateway, where it is
 * the thing holding the connection. `docs/concepts.md` states both guarantees
 * side by side rather than letting the stronger one be assumed.
 */

import {
  OathrionConnectionError,
  OathrionHttpError,
  OathrionNotAllowedError,
  OathrionProtocolError,
  OathrionTimeoutError,
} from "./errors";
import type { AgentAction, ApiErrorResponse, Decision, DecisionResponse } from "./types";
import { DECISIONS } from "./types";

export interface OathrionClientOptions {
  /** e.g. `https://placet.internal` or `http://127.0.0.1:5000`. */
  baseUrl: string;

  /** An Oathrion API key. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;

  /**
   * Abort and throw after this many milliseconds. Default 10 000.
   *
   * There is no "no timeout" setting. A request that hangs forever is an agent
   * that hangs forever, and the operator response to that is usually to remove
   * the authorization call.
   */
  timeoutMs?: number;

  /**
   * Default agent for calls that do not name one. Convenience only — the server
   * still decides which agent a credential may act as, and a credential bound
   * to another agent is refused no matter what is set here.
   */
  agentId?: string;

  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** What `evaluate()` returns: Oathrion's decision, with helpers attached. */
export interface DecisionResult extends DecisionResponse {
  /** True only for ALLOW. APPROVAL_REQUIRED is not permission. */
  readonly allowed: boolean;
  /** True only for BLOCK. */
  readonly blocked: boolean;
  /** True only for APPROVAL_REQUIRED. */
  readonly pendingApproval: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class OathrionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly defaultAgentId?: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OathrionClientOptions) {
    if (!options?.baseUrl) throw new TypeError("OathrionClient requires a baseUrl.");
    if (!options.apiKey) throw new TypeError("OathrionClient requires an apiKey.");

    // Normalised once so `new URL(path, baseUrl)` cannot silently drop a path
    // segment of the base when the caller omits the trailing slash.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultAgentId = options.agentId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("No fetch implementation available; pass one via options.fetch.");
    }
  }

  /**
   * Submits an action for a decision.
   *
   * Resolves ONLY when Oathrion returned a decision. Anything else throws — see
   * `./errors.ts` for why a failure is structurally incapable of being a
   * decision in this SDK.
   *
   * ## `persist` — read this if you are building an approval flow
   *
   * `persist` defaults to `false`, which makes the call a DRY RUN: Oathrion
   * evaluates the action, records nothing, and reports what it *would* decide.
   *
   * The consequence is easy to miss. A dry run returning `APPROVAL_REQUIRED`
   * files **no approval record**, so nothing reaches a review queue and there
   * is nothing for a human to approve. Code that reads that decision, tells the
   * user "waiting for approval" and waits will wait forever, because the
   * request was never filed. `approvalId` is `null` on a dry run for precisely
   * this reason, and that null is the signal to check.
   *
   * Pass `persist: true` when the action is real: the evaluation is recorded, an
   * ALLOW is dispatched through the gateway, and an APPROVAL_REQUIRED files a
   * real approval whose `approvalId` a reviewer can act on.
   *
   * The default suits exploring rules. Anything a human is expected to answer
   * needs `persist: true`.
   */
  async evaluate(action: AgentAction): Promise<DecisionResult> {
    if (!action?.action) throw new TypeError("evaluate() requires an `action` verb.");
    /*
     * Checked client-side because the alternative is a confusing 400 from a
     * strict schema, and because `target` is load-bearing: a policy authorises
     * an action *on something*, and an omitted target matches no target-scoped
     * rule. This is a shape check, never an authorization check.
     */
    if (!action.target) {
      throw new TypeError(
        "evaluate() requires a `target`: Oathrion authorises an action on a specific resource, and omitting it would evaluate against no target-scoped rule.",
      );
    }

    const agentId = action.agentId ?? this.defaultAgentId;
    const body: Record<string, unknown> = { ...action };
    if (agentId !== undefined) body.agentId = agentId;

    const payload = await this.post("/api/evaluate", body);
    return decorate(this.parseDecision(payload));
  }

  /**
   * Evaluates, and throws `OathrionNotAllowedError` unless the decision is ALLOW.
   *
   * For call sites where continuing without permission is not a meaningful
   * option, so that forgetting to check the result is impossible rather than
   * merely discouraged. Note that it throws on APPROVAL_REQUIRED too: a held
   * action has not been authorised, and treating "waiting for a human" as
   * permission is the single most likely way to misuse this client.
   */
  async requireAllow(action: AgentAction): Promise<DecisionResult> {
    const result = await this.evaluate(action);
    if (result.decision !== "ALLOW") {
      throw new OathrionNotAllowedError({
        decision: result.decision,
        reason: result.reason,
        policyId: result.policyId,
        approvalId: result.approvalId,
      });
    }
    return result;
  }

  /**
   * Liveness check.
   *
   * `httpStatus`, not `status`. It used to be `status`, which collided with the
   * `status` field INSIDE the health body — one name for the HTTP code (a
   * number, 200) and for the server's self-report (a string, "ok") — and
   * `health.status === "ok"` therefore compared a number to a string and was
   * quietly always false. I wrote that bug in the CLI while building it, which
   * is about as clear a demonstration as a footgun can offer.
   *
   * `ok` covers the common case without anyone having to know either name.
   */
  async health(): Promise<{ ok: boolean; httpStatus: number; body: unknown }> {
    const url = new URL("/api/health", this.baseUrl);
    const { response, payload } = await this.send(url, { method: "GET" });
    return { ok: response.ok, httpStatus: response.status, body: payload };
  }

  /* --------------------------------------------------------------------- */

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    const { response, payload } = await this.send(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new OathrionHttpError(
        response.status,
        isErrorBody(payload) ? payload : undefined,
        `Oathrion returned HTTP ${response.status}.`,
      );
    }
    return payload;
  }

  private async send(url: URL, init: RequestInit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: { ...init.headers, authorization: `Bearer ${this.apiKey}` },
      });
    } catch (error) {
      if (controller.signal.aborted) throw new OathrionTimeoutError(this.timeoutMs, error);
      throw new OathrionConnectionError(
        `Could not reach Oathrion at ${this.baseUrl}. No decision was received, so the action is NOT authorised.`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }

    /*
     * The body is read as text and parsed defensively. A proxy or gateway in
     * front of Oathrion can return HTML for a 502, and `response.json()` would
     * throw a bare SyntaxError that tells the caller nothing about what
     * actually happened.
     */
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }
    return { response, payload };
  }

  /**
   * Validates that a 200 body really is a decision.
   *
   * Refuses to guess. A missing or unrecognised `decision` means this client
   * and that server disagree about the contract, and the only safe reading of
   * "I do not understand the answer" is to raise, not to pick one.
   */
  private parseDecision(payload: unknown): DecisionResponse {
    if (typeof payload !== "object" || payload === null) {
      throw new OathrionProtocolError("Oathrion returned a 200 with no JSON body.", payload);
    }
    const candidate = payload as Partial<DecisionResponse>;
    if (!isDecision(candidate.decision)) {
      throw new OathrionProtocolError(
        `Oathrion returned a 200 whose "decision" is ${JSON.stringify(candidate.decision)}, which is not one of ${DECISIONS.join(", ")}.`,
        payload,
      );
    }
    return candidate as DecisionResponse;
  }
}

function isDecision(value: unknown): value is Decision {
  return typeof value === "string" && (DECISIONS as readonly string[]).includes(value);
}

function isErrorBody(payload: unknown): payload is ApiErrorResponse {
  return typeof payload === "object" && payload !== null;
}

/**
 * Attaches the three booleans.
 *
 * Defined exhaustively against the decision rather than as negations of one
 * another: `blocked = !allowed` would have quietly made a hold look like a
 * block, and `allowed = !blocked` would have made a hold look like permission.
 */
function decorate(response: DecisionResponse): DecisionResult {
  return {
    ...response,
    allowed: response.decision === "ALLOW",
    blocked: response.decision === "BLOCK",
    pendingApproval: response.decision === "APPROVAL_REQUIRED",
  };
}
