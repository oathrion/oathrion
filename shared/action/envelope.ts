/**
 * The first-class Action (Phase 10).
 *
 * WHY AN ACTION IS NOT AN EXECUTION
 * ---------------------------------
 * Phase 9's unit of authorization was an Execution: `{ agentId, action, target,
 * metadata }`. `metadata` was a free bag, `target` was a string, and the verdict
 * was recorded against them — but nothing pinned *which exact* arguments the
 * verdict had been reached for. Approving "refund 75 EUR" and executing "refund
 * 750 EUR" were two rows that agreed on every field the system compared.
 *
 * An Action fixes that by being canonical and hashed. The envelope below is the
 * only shape the authorization plane accepts, and every field in it is either
 * derived server-side or normalised before it is hashed.
 *
 * WHAT THE CLIENT MAY AND MAY NOT SUPPLY
 * --------------------------------------
 * The client supplies the *intent*: verb, arguments, destination id, and
 * optionally a request id and an idempotency key. It does NOT supply:
 *
 *   - `tenantId` — taken from the authenticated credential, always;
 *   - `actionHash` — computed by Oathrion from the canonical form. A client-supplied
 *                  hash is refused, never trusted: a hash the caller chooses is
 *                  a verdict the caller chooses;
 *   - `decision`, `grantId`, `approved`, `actor` — outputs of the system, not
 *                  inputs to it.
 *
 * `agentId` is the one identity field a caller may *name*, and the rule is the
 * Phase 9 rule kept verbatim: a credential bound to an agent wins over anything
 * the body says (a mismatch is refused, not overwritten), and an unbound
 * credential must name the agent because Oathrion authorizes per agent and has no
 * default. The resolution happens in `resolveActingAgent`; the envelope is built
 * from what that returns, never from the body's own value.
 *
 * `AUTHORITATIVE_FIELDS` names the fields refused outright, so the refusal and
 * this documentation cannot drift apart.
 */

import { z } from "zod";

/** Fields Oathrion derives itself and therefore refuses to be told. */
export const AUTHORITATIVE_FIELDS = [
  "tenantId",
  "tenant_id",
  "organizationId",
  "organisationId",
  "agent_id",
  "actionHash",
  "action_hash",
  "decision",
  "grantId",
  "grant_id",
  "approved",
  "actor",
] as const;

/**
 * Argument values Oathrion will canonicalise.
 *
 * Deliberately not `unknown`: an argument that cannot be represented
 * deterministically cannot be hashed deterministically, and an action whose hash
 * depends on JavaScript's serialisation of a `Date` or a `Map` is not an
 * identity. Functions, symbols and undefined are rejected by the schema rather
 * than dropped, because dropping a field changes the action silently.
 */
export type ActionArgumentValue =
  | string
  | number
  | boolean
  | null
  | ActionArgumentValue[]
  | { [key: string]: ActionArgumentValue };

const argumentValue: z.ZodType<ActionArgumentValue> = z.lazy(() =>
  z.union([
    z.string(),
    // Finite only: NaN and Infinity have no canonical JSON representation, so a
    // hash over them would depend on the serialiser rather than on the action.
    z.number().refine(Number.isFinite, "Numeric arguments must be finite."),
    z.boolean(),
    z.null(),
    z.array(argumentValue),
    z.record(z.string(), argumentValue),
  ]),
);

/** Verb shape: `namespace.verb` or a bare verb. No whitespace, no wildcards. */
export const ACTION_NAME_PATTERN = /^[a-z0-9][a-z0-9_]*(\.[a-z0-9][a-z0-9_]*)*$/;

/** Destination ids are server-registered identifiers, never URLs. */
export const DESTINATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

/** What a caller is allowed to send. */
export const actionRequestSchema = z.strictObject({
  action: z
    .string()
    .min(1)
    .max(120)
    .regex(
      ACTION_NAME_PATTERN,
      'An action name is lowercase, dot-separated, e.g. "stripe.refund".',
    ),
  arguments: z.record(z.string(), argumentValue).default({}),
  destinationId: z
    .string()
    .regex(DESTINATION_ID_PATTERN, "destinationId is a registered destination identifier, not a URL."),
  requestId: z.string().min(1).max(200).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  /**
   * The agent the caller claims to be acting as.
   *
   * Optional, and only ever a *request*: it is passed to `resolveActingAgent`,
   * which returns the bound agent for a bound credential and refuses a
   * contradiction. The envelope is then built from the resolved id.
   */
  agentId: z.string().min(1).max(120).optional(),
});

export type ActionRequest = z.infer<typeof actionRequestSchema>;

/**
 * The server-side envelope. Construction is the responsibility of
 * `server/action/canonical.ts`; nothing else may build one, because building one
 * is exactly the act of deciding who the caller is.
 */
export interface ActionEnvelope {
  tenantId: string;
  agentId: string;
  action: string;
  arguments: Record<string, ActionArgumentValue>;
  destinationId: string;
  requestId: string | null;
  idempotencyKey: string | null;
  /** The canonical serialisation the hash is taken over. */
  canonical: string;
  /** `sha256` of `canonical`, hex. Computed by Oathrion, never accepted from a caller. */
  actionHash: string;
}
