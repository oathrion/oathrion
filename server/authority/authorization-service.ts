/**
 * The authorization decision for a first-class action (Phase 10, §§11-12).
 *
 * WHAT THIS COMPONENT IS
 * ----------------------
 * Given an authenticated tenant, a resolved agent and a caller's intent, it
 * produces exactly one of ALLOW, APPROVAL_REQUIRED or BLOCK, persists the action
 * it decided about, and — for the two non-BLOCK outcomes — issues an Action Grant
 * bound to that exact action.
 *
 * It does NOT execute anything. Execution is `enforcement-point.ts`, and the
 * split matters: a component that both decides and dispatches is a component
 * where a refactor can accidentally move the dispatch above the decision.
 *
 * FAIL-CLOSED IS THE DEFAULT, NOT A SETTING
 * -----------------------------------------
 * Three separate paths end in BLOCK with no grant issued:
 *
 *   1. No policy matches. The absence of a rule is not permission. A system whose
 *      default is ALLOW protects only the actions someone remembered to write a
 *      rule for, and the interesting actions are the ones nobody anticipated.
 *   2. The destination id is not registered. There is no default destination.
 *   3. The action cannot be canonicalised, or the request is malformed.
 *
 * Because a BLOCK issues no grant, the enforcement point has nothing to present,
 * and the downstream is unreachable by construction rather than by a check that
 * could be forgotten.
 *
 * RULE SELECTION IS DETERMINISTIC AND ORDERED
 * -------------------------------------------
 * Rules are ordered by `priority` descending, then by `id` ascending — the second
 * key exists so that two rules at the same priority resolve the same way on every
 * instance and after every restart, rather than following whatever order the
 * database felt like returning. The first rule whose action, destination and
 * constraints all match decides. Not "the most restrictive wins", not "any BLOCK
 * anywhere wins": first-match, so an operator reading the list top-to-bottom
 * reaches the same verdict Oathrion does.
 */

import { randomUUID } from "node:crypto";
import type { ActionEnvelope } from "@shared/action/envelope";
import { evaluateConstraints, type ConstraintSubject } from "@shared/policy/constraints";
import type { OrganizationId } from "@shared/tenancy";
import { isRegisteredDestination } from "./destinations";
import type {
  ActionAuthorityStore,
  ActionDecision,
  ActionPolicyRecord,
  ActionRecord,
  GrantRecord,
} from "./store";

/** How long an issued grant may be presented for. Short by design. */
export function grantTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OATHRION_GRANT_TTL_MS ?? "");
  /*
   * Two minutes. A grant is a licence to perform one irreversible thing, so its
   * lifetime should be the time an agent needs to act on it and no more. An hour
   * would mean a grant leaked from a log is usable for an hour.
   */
  if (!Number.isFinite(raw) || raw < 1_000 || raw > 3_600_000) return 120_000;
  return Math.floor(raw);
}

/** How long a human has to approve before the request expires. */
export function approvalTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OATHRION_ACTION_APPROVAL_TTL_MS ?? "");
  if (!Number.isFinite(raw) || raw < 1_000 || raw > 7 * 24 * 3_600_000) return 15 * 60_000;
  return Math.floor(raw);
}

export interface AuthorizationOutcome {
  decision: ActionDecision;
  reason: string;
  action: ActionRecord;
  /** Present for ALLOW and APPROVAL_REQUIRED. Absent for BLOCK, always. */
  grant: GrantRecord | null;
  policyId: string | null;
  /** Set when APPROVAL_REQUIRED: the id a human decision must reference. */
  approvalId: string | null;
}

interface Verdict {
  decision: ActionDecision;
  reason: string;
  policyId: string | null;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/** Does this rule address this action's verb? `*` means any verb. */
function verbMatches(policy: ActionPolicyRecord, action: string): boolean {
  return policy.action === "*" || policy.action === action;
}

/** Does this rule address this destination? A null destination means any. */
function destinationMatches(policy: ActionPolicyRecord, destinationId: string): boolean {
  return policy.destinationId === null || policy.destinationId === destinationId;
}

export class AuthorizationService {
  constructor(
    private readonly store: ActionAuthorityStore,
    private readonly org: OrganizationId,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Selects the governing rule and returns its effect, or the fail-closed BLOCK.
   *
   * Exported behaviour, separate method: it is pure with respect to the store,
   * which lets the tests assert the decision table without persisting anything.
   */
  evaluate(envelope: ActionEnvelope, policies: readonly ActionPolicyRecord[]): Verdict {
    if (!isRegisteredDestination(envelope.destinationId, this.env, String(this.org))) {
      return {
        decision: "BLOCK",
        reason:
          `Destination "${envelope.destinationId}" is not registered for this tenant. ` +
          "Oathrion does not dispatch to unregistered destinations and has no default.",
        policyId: null,
      };
    }

    const subject: ConstraintSubject = {
      action: envelope.action,
      destinationId: envelope.destinationId,
      agentId: envelope.agentId,
      arguments: envelope.arguments,
    };

    const ordered = [...policies]
      .filter((policy) => policy.status === "active")
      .sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const policy of ordered) {
      if (!verbMatches(policy, envelope.action)) continue;
      if (!destinationMatches(policy, envelope.destinationId)) continue;
      const outcome = evaluateConstraints(subject, policy.constraints);
      if (!outcome.satisfied) continue;
      return {
        decision: policy.effect,
        reason: `Rule "${policy.name}" (${policy.id}) matched: ${policy.effect}.`,
        policyId: policy.id,
      };
    }

    return {
      decision: "BLOCK",
      reason:
        `No active rule authorizes "${envelope.action}" on destination ` +
        `"${envelope.destinationId}". Oathrion blocks by default: an action nobody wrote a rule ` +
        "for is not an authorized action.",
      policyId: null,
    };
  }

  /**
   * Decides, persists the action, and issues a grant for the non-BLOCK outcomes.
   *
   * The persisted action carries the canonical form and the hash Oathrion computed,
   * so the record of what was decided is the record of what was decided *about*.
   */
  async authorize(envelope: ActionEnvelope, now: Date = new Date()): Promise<AuthorizationOutcome> {
    const policies = await this.store.listPolicies();
    const verdict = this.evaluate(envelope, policies);

    const { action, replayed } = await this.store.createAction({
      id: id("act"),
      agentId: envelope.agentId,
      action: envelope.action,
      arguments: envelope.arguments,
      destinationId: envelope.destinationId,
      canonical: envelope.canonical,
      actionHash: envelope.actionHash,
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      decision: verdict.decision,
      reason: verdict.reason,
      policyId: verdict.policyId,
      createdAt: now.toISOString(),
    });

    /*
     * An idempotent retry resolves to the FIRST action, and therefore to the
     * first decision — including the first grant, if one is still live. Deciding
     * again would let a caller retry a request until a policy change made it
     * pass, and would issue a second single-use grant for one action, which is
     * exactly the double-execution the exactly-once contract forbids.
     */
    if (replayed) {
      const existingGrant = (await this.store.findGrantsForAction(action.id))[0];
      if (existingGrant) {
        return {
          decision: action.decision,
          reason: `${action.reason} (idempotent replay of action ${action.id})`,
          action,
          grant: existingGrant,
          policyId: action.policyId,
          approvalId: existingGrant.approvalId,
        };
      }
    }

    if (verdict.decision === "BLOCK") {
      // No grant. Nothing to present, so nothing can be executed.
      return {
        decision: "BLOCK",
        reason: verdict.reason,
        action,
        grant: null,
        policyId: verdict.policyId,
        approvalId: null,
      };
    }

    const approvalRequired = verdict.decision === "APPROVAL_REQUIRED";
    const ttl = approvalRequired ? approvalTtlMs(this.env) : grantTtlMs(this.env);
    const grant = await this.store.createGrant({
      id: id("grant"),
      actionId: action.id,
      agentId: envelope.agentId,
      action: envelope.action,
      // The binding. Everything the enforcement point re-checks is here, taken
      // from the server-computed envelope rather than from the request.
      actionHash: envelope.actionHash,
      destinationId: envelope.destinationId,
      decision: verdict.decision,
      state: approvalRequired ? "pending_approval" : "issued",
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      policyId: verdict.policyId,
      createdAt: now.toISOString(),
      issuedAt: approvalRequired ? null : now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      consumedAt: null,
      consumedBy: null,
      approvalId: approvalRequired ? id("appr") : null,
      approvedAt: null,
      approvedBy: null,
      revokedAt: null,
      revokedReason: null,
    });

    return {
      decision: verdict.decision,
      reason: verdict.reason,
      action,
      grant,
      policyId: verdict.policyId,
      approvalId: grant.approvalId,
    };
  }

  /**
   * Applies a human approval to a pending grant.
   *
   * `expectedActionHash` is the hash the approver was shown. It is required, and
   * it is checked inside the UPDATE, because that is the whole of §15: an
   * approval for "refund 75 EUR" must not be applicable to "refund 750 EUR", and
   * the only way to guarantee that is for the approval to name the action it is
   * for and for the write to refuse when the row says something else.
   *
   * Replay is impossible rather than detected: the second attempt finds no row in
   * `pending_approval` and claims nothing.
   */
  async approve(input: {
    grantId: string;
    expectedActionHash: string;
    approvedBy: string;
    now?: Date;
  }): Promise<{ ok: boolean; reason: string; grant: GrantRecord | null }> {
    const now = input.now ?? new Date();
    const before = await this.store.findGrant(input.grantId);
    if (!before) {
      // Not found, not "forbidden": the store is tenant-scoped, so another
      // tenant's grant id is invisible here and cannot be probed for existence.
      return { ok: false, reason: `Grant "${input.grantId}" was not found.`, grant: null };
    }
    if (before.actionHash !== input.expectedActionHash) {
      return {
        ok: false,
        reason:
          "The approval names a different action than the grant holds. An approval authorizes " +
          "one exact action; it cannot be transferred to another.",
        grant: before,
      };
    }

    const result = await this.store.approveGrant({
      id: input.grantId,
      expectedActionHash: input.expectedActionHash,
      approvedBy: input.approvedBy,
      at: now.toISOString(),
      // A fresh, short execution window starts at approval. The pending window
      // was the human's deadline; it is not the agent's.
      expiresAt: new Date(now.getTime() + grantTtlMs(this.env)).toISOString(),
      notBefore: now.toISOString(),
    });

    if (!result.claimed) {
      const state = result.grant?.state ?? "unknown";
      return {
        ok: false,
        reason:
          `Grant "${input.grantId}" is in state "${state}" and cannot be approved. ` +
          "Only a grant still awaiting approval, and not yet expired, can be approved — an " +
          "already-approved, consumed, revoked or expired grant is final.",
        grant: result.grant ?? before,
      };
    }
    return { ok: true, reason: "Approved.", grant: result.grant ?? null };
  }

  /** Rejects a pending grant. The action never becomes executable. */
  async reject(input: {
    grantId: string;
    rejectedBy: string;
    reason?: string;
    now?: Date;
  }): Promise<{ ok: boolean; reason: string; grant: GrantRecord | null }> {
    const now = input.now ?? new Date();
    const result = await this.store.rejectGrant({
      id: input.grantId,
      rejectedBy: input.rejectedBy,
      at: now.toISOString(),
      reason: input.reason ?? "Rejected by approver.",
    });
    if (!result.claimed) {
      return {
        ok: false,
        reason: `Grant "${input.grantId}" is not awaiting approval.`,
        grant: result.grant ?? null,
      };
    }
    return { ok: true, reason: "Rejected.", grant: result.grant ?? null };
  }
}
