/**
 * Oathrion roles and capabilities.
 *
 * Four roles, one capability matrix. The matrix — not the route list — is the
 * source of truth, so adding a route means picking a capability rather than
 * re-deciding who is allowed to do what.
 *
 * A role is *always* derived server-side from the presented credential. There
 * is no request field, header or token claim a client can set to change it.
 */

export const ROLES = ["viewer", "operator", "approver", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * - `read`    — see agents, policies, executions, approvals, the audit trail.
 * - `execute` — ask the control plane to run an action (which may still be
 *               blocked or held; `execute` is the right to *ask*, never to bypass).
 * - `approve` — resolve a pending approval, releasing or denying a held action.
 * - `manage`  — change the rules themselves: agents, policies, integrations,
 *               and other people's sessions.
 */
export const CAPABILITIES = ["read", "execute", "approve", "manage"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Separation of duties is the point of the matrix: an `operator` can trigger
 * actions but cannot approve their own held action, and an `approver` can
 * release actions but cannot originate them. Only `admin` holds both.
 */
const MATRIX: Record<Role, readonly Capability[]> = {
  viewer: ["read"],
  operator: ["read", "execute"],
  approver: ["read", "approve"],
  admin: ["read", "execute", "approve", "manage"],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, capability: Capability): boolean {
  return MATRIX[role].includes(capability);
}

export function capabilitiesOf(role: Role): Capability[] {
  return [...MATRIX[role]];
}

/**
 * True when `candidate` grants nothing that `holder` does not already grant.
 *
 * Compared as capability sets, not as positions in `ROLES`. The order of that array
 * looks like a hierarchy but is not one: `operator` and `approver` are siblings by
 * design — separation of duties means neither contains the other — so an index
 * comparison would answer "is approver at most operator?" with a number that means
 * nothing. Only `admin` is above both.
 *
 * Used when issuing a credential: a principal must not be able to mint one that is more
 * powerful than itself, which would be privilege escalation with an audit trail that
 * looks like ordinary administration.
 */
export function roleAtMost(candidate: Role, holder: Role): boolean {
  return MATRIX[candidate].every((capability) => MATRIX[holder].includes(capability));
}

/** Human-readable refusal, used verbatim in 403 bodies. */
export function denialMessage(role: Role, capability: Capability): string {
  return `Role "${role}" cannot ${capability}. Required capability: ${capability}.`;
}
