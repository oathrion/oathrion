/**
 * THE PUBLIC AUTHORIZATION CONTRACT.
 *
 * One definition of what an agent sends to Oathrion and what Oathrion answers, shared
 * by the server route, both SDKs, the CLI, the examples and the documentation.
 * It lives in `shared/` for a specific reason: the moment the SDK owns its own
 * copy of these shapes, the SDK's copy and the server's copy drift, and the
 * failure mode of that drift is a client that believes it received a decision
 * it did not receive.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It is not a second authorization engine, and nothing here may ever become
 * one. There is exactly one decision path in Oathrion — `evaluateAction()` in
 * `shared/policy/engine.ts`, reached through `server/services/decision-service`
 * — and this module only describes the envelope around it. No code in this file
 * may compute, infer, soften or default a decision. In particular a client-side
 * validation failure is reported as a *transport/validation* error, never as an
 * ALLOW, and never as a BLOCK either: a BLOCK is a statement that Oathrion assessed
 * the action, and pretending to have assessed it locally would be a lie of the
 * same family as a fail-open.
 *
 * FRAMEWORK-AGNOSTIC BY CONSTRUCTION
 * ----------------------------------
 * The central noun is `AgentAction`, not `LangChainAction` or `McpAction`. The
 * core reasons about Agent -> Action -> Policy -> Decision -> Approval ->
 * Execution -> Audit; every framework is an adapter that builds an AgentAction.
 * Nothing in this file may import from a framework, and nothing in it may name
 * one in a type.
 */

import { z } from "zod";
import { agentIdSchema } from "../validation";

/* ========================================================================== */
/* Decisions                                                                  */
/* ========================================================================== */

/**
 * The three answers Oathrion can give. There is no fourth, and there is no
 * "unknown" or "error" member on purpose: a transport failure is not a
 * decision, and giving it a slot in this union is how software ends up treating
 * a timeout as permission.
 */
export const DECISIONS = ["ALLOW", "BLOCK", "APPROVAL_REQUIRED"] as const;

export type Decision = (typeof DECISIONS)[number];

export const decisionSchema = z.enum(DECISIONS);

/* ========================================================================== */
/* Request                                                                    */
/* ========================================================================== */

/**
 * An action an agent wants to take, in the vocabulary a developer thinks in.
 *
 * ON `target` BEING REQUIRED
 * --------------------------
 * A policy authorizes an action *on something*: `targetMatches` conditions are
 * the mechanism by which "may refund customer X" differs from "may refund
 * anyone". If `target` were optional, a request that omitted it would silently
 * fail to match every target-scoped rule and could come back ALLOW under a
 * ruleset whose author believed it was restrictive. That is a fail-open
 * produced by a convenience default, so the field is required and the caller
 * must say what it is acting on.
 */
export interface AgentAction {
  /**
   * Which agent is acting. Optional on the wire: a credential bound to a single
   * agent supplies it, and in that case sending a *different* id is refused
   * rather than honoured (see `OATHRION_REQUIRE_AGENT_BINDING` and
   * `resolveActingAgent`). Client-supplied, 3-64 chars of `[A-Za-z0-9._-]`.
   */
  agentId?: string;

  /**
   * The action verb, arbitrary and free-form: `refund`, `stripe.refund`,
   * `my.internal.operation`. Oathrion does not require your verbs to come from a
   * fixed list — but a verb that is neither catalogued nor named by any policy
   * is UNDECLARED, and an undeclared action is BLOCKed by default. Declaring
   * your own vocabulary is done by writing a policy that names it, not by
   * relaxing the posture.
   */
  action: string;

  /** What the action acts on: `customer_123`, `customer:cus_10429`, a URL, an ARN. */
  target: string;

  /**
   * The action's parameters. This is the `input` of the developer-facing
   * `AgentAction` concept and is merged into the metadata bag the policy engine
   * reads, so a policy can be written against any key you send here.
   */
  input?: Record<string, unknown>;

  /** Amount of money involved, promoted to the top level because policies key on it. */
  amount?: number | string;

  /** ISO currency for `amount`. The engine will not compare sums without it. */
  currency?: string;

  /** Free-form classification a policy may match on. */
  category?: string;

  /** Surrounding circumstances: a string note, or key/values merged into metadata. */
  context?: string | Record<string, unknown>;

  /**
   * Write the decision, and act on it, instead of dry-running.
   *
   * DEFAULT FALSE, AND THAT MATTERS. A dry run answers the question "what would
   * you decide?" and touches nothing: no Execution, no Approval, no audit entry,
   * no downstream. Persisting is asking the control plane to *act*, which is why
   * it requires the `execute` capability while a dry run needs only `read`.
   */
  persist?: boolean;
}

/**
 * Wire aliases accepted on input, mapped to the canonical field.
 *
 * Two names, both of which appear in real integration code and in Oathrion's own
 * introductory examples. They are normalised at the edge so that exactly one
 * spelling reaches the engine, the audit log and the SDKs.
 *
 * Sending BOTH spellings of the same slot is a 400 rather than a precedence
 * rule. A precedence rule is a thing an integrator has to remember correctly
 * under pressure, and getting it wrong here means acting on a different target
 * than the one you thought you sent.
 */
export const FIELD_ALIASES: Readonly<Record<string, keyof AgentAction>> = {
  agent: "agentId",
  resource: "target",
};

/**
 * Zod schema for the request body, after alias normalisation.
 *
 * Strict: an unrecognised key is a 400, not a shrug. A typo'd `amont` that was
 * silently dropped would evaluate a money movement with no amount, against
 * rules written to bound the amount.
 */
export const agentActionSchema = z.strictObject({
  /*
   * The documented agent id grammar, enforced HERE and not only where agents
   * are created.
   *
   * It used to be `z.string().min(1)`, which meant the authorization entry
   * point accepted any non-empty string — including one that could never name a
   * real agent — and carried it into a registry lookup, answering 404 after the
   * round trip. Three things were wrong with that. The grammar published in the
   * docs was not the grammar the SDK-facing endpoint applied, so the contract
   * was documented in one place and enforced in another. An unbounded string
   * reached a query on the strength of `min(1)` alone. And a caller could not
   * tell "this id is impossible" from "this id is fine but unknown here", which
   * are a client bug and a configuration gap respectively.
   *
   * Rejecting a syntactically impossible id is a 400 before any lookup. An id
   * that is well-formed but names no agent stays a 404. Neither is a decision.
   */
  agentId: agentIdSchema.optional(),
  action: z.string().min(1),
  target: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  currency: z.string().min(1).optional(),
  category: z.string().optional(),
  context: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  persist: z.boolean().default(false),
});

/** Raised by `normalizeAgentAction` when a body cannot be interpreted unambiguously. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/**
 * Rewrites accepted aliases onto their canonical field names.
 *
 * Runs BEFORE schema validation, so the schema can stay strict and still accept
 * the documented alternative spellings. Refuses rather than guesses when both
 * spellings of one slot are present, and refuses `input` together with
 * `metadata` for the same reason: they are one slot under two names, and
 * merging them would need a precedence rule nobody should have to memorise.
 */
export function normalizeAgentAction(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ContractError("Request body must be a JSON object.");
  }

  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    const canonical = FIELD_ALIASES[key] ?? key;
    if (canonical !== key && key in source && canonical in source) {
      throw new ContractError(
        `Send either "${key}" or "${canonical}", not both — they are the same field and Oathrion will not guess which one you meant.`,
      );
    }
    out[canonical] = value;
  }

  if (out.input !== undefined && out.metadata !== undefined) {
    throw new ContractError(
      'Send either "input" or "metadata", not both — they are the same field and Oathrion will not guess which one you meant.',
    );
  }

  return out;
}

/**
 * Folds the developer-facing body into the single metadata bag the engine reads.
 *
 * `input` and `metadata` are the same slot (the normaliser has already refused
 * bodies that set both), and the promoted scalars are copied in last so that
 * `amount: 75` at the top level and `input.amount` cannot disagree about which
 * one the policy sees.
 */
export function toEngineMetadata(action: {
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  amount?: number | string;
  currency?: string;
  category?: string;
  context?: string | Record<string, unknown>;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(action.input ?? action.metadata ?? {}) };
  if (action.amount !== undefined) metadata.amount = action.amount;
  if (action.currency !== undefined) metadata.currency = action.currency;
  if (action.category !== undefined) metadata.category = action.category;
  if (action.context !== undefined) {
    if (typeof action.context === "string") {
      if (action.context.trim()) metadata.context = action.context.trim();
    } else {
      Object.assign(metadata, action.context);
    }
  }
  return metadata;
}

/* ========================================================================== */
/* Response                                                                   */
/* ========================================================================== */

/**
 * What `POST /api/evaluate` answers with HTTP 200.
 *
 * ALL THREE DECISIONS ARE HTTP 200, AND THAT IS DELIBERATE. A BLOCK is Oathrion
 * working correctly: the question was asked and answered. Mapping BLOCK to 403
 * would put a successful authorization decision in the same bucket as "your API
 * key is wrong", and the overwhelmingly common client idiom — retry or throw on
 * non-2xx — would turn a considered refusal into a transport error, or worse,
 * into a retry loop against a rule that will never change its mind.
 *
 * A non-200 therefore means Oathrion did NOT decide. That is the invariant every
 * client in this repository relies on, and it is why the SDKs raise on non-200
 * instead of synthesising a decision.
 */
export interface DecisionResponse {
  decision: Decision;

  /** Human-readable justification, safe to show an operator or log. */
  reason: string;

  /** The rule responsible, or null when no named rule matched. */
  policyId: string | null;
  policyName: string | null;

  /** `low` | `medium` | `high` | `critical`, lowercased. */
  risk: string;

  /** False for a dry run: the call left no trace in the registry. */
  persisted: boolean;

  /**
   * ATTEMPTED, not succeeded. Kept under the older name for compatibility; read
   * `succeeded` or `runState` to learn whether the side effect happened.
   */
  executed: boolean;

  /** Whether the downstream tool was invoked at all. */
  attempted: boolean;

  /** Whether the side effect completed. Never inferred from `attempted`. */
  succeeded: boolean;

  /** Persisted run state, or null for a dry run. */
  runState: string | null;

  executionId: string | null;

  /** Present when the decision is APPROVAL_REQUIRED and the call was persisted. */
  approvalId: string | null;

  toolId: string | null;
  toolResult: Record<string, unknown> | null;

  /** Every rule that matched, in evaluation order. */
  matched: unknown[];

  /**
   * Correlation id, also sent as the `X-Request-Id` header.
   *
   * Added in Phase 8. It was header-only, which was enough for a human running
   * curl and not enough for an SDK: a caller holding a parsed decision had no
   * id to quote when asking why that decision was reached, while the error
   * envelope already carried one — so failures were traceable and decisions
   * were not.
   */
  requestId: string;
}

/** The error body Oathrion returns for any non-200 on this endpoint. */
export interface ApiErrorResponse {
  error: string;
  message: string;
  code: string;
  requestId?: string;
}

/* ========================================================================== */
/* Narrowing helpers                                                          */
/* ========================================================================== */

/**
 * Helpers for branching on a decision.
 *
 * `isAllowed` exists so that integrators write `if (isAllowed(d))` rather than
 * `if (d.decision !== "BLOCK")`, which is the single most likely way to get
 * this wrong: it treats APPROVAL_REQUIRED — an action that has NOT been
 * authorised and whose downstream must not run — as permission to proceed.
 */
export function isAllowed(response: Pick<DecisionResponse, "decision">): boolean {
  return response.decision === "ALLOW";
}

export function isBlocked(response: Pick<DecisionResponse, "decision">): boolean {
  return response.decision === "BLOCK";
}

export function needsApproval(response: Pick<DecisionResponse, "decision">): boolean {
  return response.decision === "APPROVAL_REQUIRED";
}
