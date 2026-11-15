/**
 * Public types for the Oathrion TypeScript SDK.
 *
 * Re-exported from `shared/api/evaluate-contract.ts` rather than restated here.
 * That indirection is the point: the server validates requests and builds
 * responses against those same definitions, so the SDK cannot drift from the
 * service it talks to. A hand-copied duplicate would compile forever while
 * slowly ceasing to describe reality.
 */

export type {
  AgentAction,
  ApiErrorResponse,
  Decision,
  DecisionResponse,
} from "@shared/api/evaluate-contract";

export { DECISIONS, isAllowed, isBlocked, needsApproval } from "@shared/api/evaluate-contract";
