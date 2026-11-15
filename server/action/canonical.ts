/**
 * Deterministic action canonicalisation and hashing (Phase 10).
 *
 * WHAT "CANONICAL" HAS TO MEAN HERE
 * --------------------------------
 * Two requests that mean the same action must produce the same bytes, and two
 * requests that differ in any way a policy could care about must produce
 * different bytes. `JSON.stringify` gives neither guarantee: key order follows
 * insertion order, so `{amount:1,currency:"EUR"}` and `{currency:"EUR",amount:1}`
 * serialise differently and would hash to two different actions — which means an
 * approval for one would not match the other, and a caller could dodge an
 * idempotency check by reordering a body.
 *
 * The rules, stated because a hash is only as trustworthy as its rules:
 *
 *   - objects  → keys sorted by UTF-16 code unit, recursively;
 *   - arrays   → order PRESERVED. Order is meaning in an argument list; sorting
 *                would make `["a","b"]` and `["b","a"]` the same action;
 *   - strings  → JSON-escaped, unchanged otherwise. No trimming, no case folding:
 *                a policy comparing `currency == "EUR"` must not be satisfiable
 *                by `"eur "`, so normalisation happens in the policy layer's own
 *                comparison rules, never silently here;
 *   - numbers  → `-0` normalised to `0`, integral floats emitted without a
 *                trailing `.0`, everything else via the shortest round-trip
 *                representation JavaScript produces. NaN and Infinity are
 *                refused upstream by the schema, so they cannot reach this code;
 *   - null     → `null`. Distinct from an absent key, and deliberately so: a
 *                policy may care about an explicitly cleared field;
 *   - undefined → refused. A key whose value is undefined is dropped by
 *                `JSON.stringify`, which is a silent change of the action.
 *
 * The tenant, agent, verb and destination are hashed along with the arguments.
 * Hashing the arguments alone would let one grant be presented for a different
 * agent or a different destination, which is precisely what §12 forbids.
 */

import { createHash } from "node:crypto";
import {
  actionRequestSchema,
  AUTHORITATIVE_FIELDS,
  type ActionArgumentValue,
  type ActionEnvelope,
  type ActionRequest,
} from "@shared/action/envelope";

export class ActionCanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionCanonicalizationError";
  }
}

/** The canonical form's version tag. Hashed, so a rule change cannot be silent. */
export const CANONICAL_FORM_VERSION = "placet.action.v1";

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ActionCanonicalizationError(
      "A non-finite number has no canonical representation and cannot identify an action.",
    );
  }
  // `-0` and `0` are the same amount, and a policy comparing `amount <= 0`
  // cannot distinguish them. Emitting two different canonical forms for one
  // amount would mean two different action hashes for one action.
  const normalised = value === 0 ? 0 : value;
  return Number.isInteger(normalised) ? normalised.toFixed(0) : String(normalised);
}

function canonicalValue(value: ActionArgumentValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const entry = (value as Record<string, ActionArgumentValue>)[key];
      if (entry === undefined) {
        throw new ActionCanonicalizationError(
          `Argument "${key}" is undefined. An undefined value is dropped by JSON serialisation, ` +
            `which would change the action without changing its hash. Send null to mean "no value".`,
        );
      }
      parts.push(`${JSON.stringify(key)}:${canonicalValue(entry)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new ActionCanonicalizationError(
    `Argument of type "${typeof value}" cannot be canonicalised deterministically.`,
  );
}

/** The canonical serialisation of one whole action. Stable across processes. */
export function canonicalizeAction(input: {
  tenantId: string;
  agentId: string;
  action: string;
  arguments: Record<string, ActionArgumentValue>;
  destinationId: string;
}): string {
  return canonicalValue({
    v: CANONICAL_FORM_VERSION,
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    action: input.action,
    destination_id: input.destinationId,
    arguments: input.arguments,
  });
}

/** `sha256` over the canonical form, hex. The project's existing hash choice. */
export function hashCanonicalAction(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Refuses a body that tries to supply an identity, a verdict or a hash.
 *
 * Refused rather than ignored. Ignoring means an integration that believes it is
 * pinning the agent id keeps believing it, and the day the field starts being
 * read is the day the belief becomes a vulnerability.
 */
export function assertNoAuthoritativeFields(body: unknown, where: string): void {
  if (typeof body !== "object" || body === null) return;
  for (const field of AUTHORITATIVE_FIELDS) {
    if (field in (body as Record<string, unknown>)) {
      throw new ActionCanonicalizationError(
        `"${field}" is an authoritative field and is not accepted in ${where}. Oathrion derives the ` +
          `tenant from the presented credential, computes the action hash itself, and takes the ` +
          `decision from policy. None of those can be supplied by a caller. (The acting agent may ` +
          `be named as "agentId"; a credential bound to an agent still wins.)`,
      );
    }
  }
}

/**
 * Builds the authoritative envelope.
 *
 * `tenantId` and `agentId` are parameters, not body fields — the two places they
 * can legitimately come from are the credential and the binding resolution, and
 * both are the caller of this function's responsibility to have done.
 */
export function buildActionEnvelope(input: {
  tenantId: string;
  agentId: string;
  request: ActionRequest;
}): ActionEnvelope {
  const request = actionRequestSchema.parse(input.request);
  const canonical = canonicalizeAction({
    tenantId: input.tenantId,
    agentId: input.agentId,
    action: request.action,
    arguments: request.arguments,
    destinationId: request.destinationId,
  });
  return {
    tenantId: input.tenantId,
    agentId: input.agentId,
    action: request.action,
    arguments: request.arguments,
    destinationId: request.destinationId,
    requestId: request.requestId ?? null,
    idempotencyKey: request.idempotencyKey ?? null,
    canonical,
    actionHash: hashCanonicalAction(canonical),
  };
}

/** Hash of a downstream result, for the receipt. Never the result itself. */
export function hashResult(value: unknown): string {
  const canonical =
    value === undefined ? "null" : canonicalValue(JSON.parse(JSON.stringify(value)) as ActionArgumentValue);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
