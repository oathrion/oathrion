/**
 * The granted-permission projection, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `server/services/decision-service.ts` reduces an agent's `Permission[]` to the
 * list of scope strings the engine checks against, with
 * `permissions.filter((p) => p.granted).map((p) => p.scope)`. The `granted` flag
 * matters: a `Permission` row can be present and switched off, and the engine
 * must treat that as not held.
 *
 * The MCP gateway needs the same answer, because `tools/list` must not advertise
 * a tool that the engine would then refuse at the permission barrier. Copying
 * the one-liner would have created two definitions of "the agent holds this
 * scope" that can drift — and the dangerous direction of drift is obvious: a
 * listing that forgets `.filter((p) => p.granted)` would advertise revoked
 * capabilities to an LLM as if they were available.
 *
 * So both callers now import from here. Pure and synchronous, no framework.
 */

import { lookupAction, normalizeActionName } from "./policy/actions";
import type { Permission } from "./types";

/** The subset of an Agent this module needs. Keeps it usable on projections. */
export interface ScopedAgent {
  permissions: Permission[];
}

/** Scope strings the agent actually holds — revoked rows excluded. */
export function grantedScopes(agent: ScopedAgent): string[] {
  return agent.permissions.filter((permission) => permission.granted).map((p) => p.scope);
}

/**
 * Whether the agent would clear the engine's permission barrier for this verb.
 *
 * Mirrors `evaluateAction`'s first check
 * (`requiredScope && !agent.permissions.includes(requiredScope)` → BLOCK), and
 * exists so `tools/list` can answer "may this agent even attempt this?" without
 * restating the rule.
 *
 * IMPORTANT: clearing this barrier is NOT permission to act. It only means the
 * request is allowed to reach the policy engine, which may still block it, hold
 * it for approval, or refuse it on the agent's mandate. `tools/list` advertises
 * reachability, never an outcome — see `server/mcp/tool-catalog.ts`.
 */
export function clearsPermissionBarrier(agent: ScopedAgent, action: string): boolean {
  const descriptor = lookupAction(normalizeActionName(action));
  // An uncatalogued verb is not dispatchable at all; `ToolRegistry` refuses to
  // wire one. Reporting `false` keeps it out of any listing.
  if (!descriptor) return false;
  if (!descriptor.requiredScope) return true;
  return grantedScopes(agent).includes(descriptor.requiredScope);
}
