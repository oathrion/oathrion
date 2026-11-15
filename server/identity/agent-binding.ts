/**
 * Which agent a request is allowed to act as.
 *
 * WHY THIS IS ONE FUNCTION IN ONE FILE
 * ------------------------------------
 * There are five ways into the engine — `/api/decision`, `/api/execute`,
 * `/api/evaluate` with `persist`, `POST /api/executions`, and the MCP
 * `tools/call` — plus `POST /api/executions/:id/retry`, which re-dispatches one
 * that already exists. Before this module, each of the first five read the agent
 * straight out of the request it was handed, in five separate places.
 *
 * A rule written in six places is a rule that will eventually be enforced in
 * five. And the failure is silent: a route that forgets the check keeps working
 * perfectly, it just stops being a boundary. So the answer to "which agent may
 * this caller act as?" is computed here, once, and every entry point calls it.
 * `server/test/agent-binding-single-path.test.ts` asserts textually that no
 * route reads a caller-supplied agent id without going through this function.
 *
 * THE RULE
 * --------
 * A credential may carry a binding: the id of the one agent it speaks for. When
 * it does, that agent is the answer, and any agent the caller names must equal
 * it exactly or the request is refused. The caller cannot widen this by changing
 * a header, a body field, a route, or by retrying somebody else's execution.
 *
 * Note the direction: the caller-supplied value is never *used* when a binding
 * exists — it is only *compared*. That distinction is the whole point. A
 * implementation that read the header and then checked it would be one missing
 * branch away from reading the header and using it; this one has nowhere to put
 * the caller's value even if the comparison were deleted, which is why mutation
 * M1 in `script/phase6-mutations.sh` cannot be made to pass by accident.
 *
 * WHAT AN UNBOUND CREDENTIAL MEANS, HONESTLY
 * ------------------------------------------
 * `agentId: null` means the credential is not pinned. Two very different callers
 * land there, and they are treated differently:
 *
 *   - **A console session** (`kind: "user"`). A human administrator. Pinning a
 *     person to a single agent is not a security property — an operator has to
 *     be able to submit, inspect and retry across the agents they administer,
 *     and their authority is already bounded by role capabilities and by the
 *     tenant. Sessions are therefore never subject to binding, by design and not
 *     by omission.
 *
 *   - **An unpinned API key** (`kind: "service"`). This is an agent runtime
 *     whose credential was issued before bindings existed, or issued without
 *     one. It can still name any agent in its own organisation. That is the
 *     residual gap, it is stated in PHASE-6-REPORT.md §18, and it is not
 *     described anywhere as closed.
 *
 * `OATHRION_REQUIRE_AGENT_BINDING=true` closes it: an unpinned service credential is
 * then refused outright rather than allowed to choose.
 *
 * PHASE 9: THE DEFAULT NOW DEPENDS ON `NODE_ENV`
 * ----------------------------------------------
 * Through Phase 8 this switch was off by default *everywhere*, on the argument
 * that turning it on would stop every existing API key from executing anything
 * with no migration path. That argument is sound for a development machine and
 * wrong for a deployment: it made the residual gap — an unpinned machine
 * credential choosing its own agent — the shipped production posture, reachable
 * by an operator who simply never read the limitations page.
 *
 * So the default is now split:
 *
 *   - `NODE_ENV=production` → **required**. Doing nothing fails closed. An
 *     unpinned service credential cannot execute anything, and the refusal names
 *     the switch so the operator knows what to do about it.
 *   - anything else (development, test) → **not required**, exactly as before,
 *     so the existing suite, the quickstart and every local run are unchanged.
 *
 * The escape hatch survives, deliberately and in one direction only: an explicit
 * `OATHRION_REQUIRE_AGENT_BINDING=false` still turns the requirement off, including
 * in production, for the operator mid-migration who has to keep pre-binding keys
 * working for one more deploy. The difference from Phase 8 is which way the
 * *absence* of a decision falls. Silence used to mean permissive; it now means
 * closed, and relaxing it takes a typed word that shows up in a diff and in the
 * boot log (see `server/config-check.ts`).
 *
 * Read per call, not captured at import, for the reason given below.
 *
 * FAIL-CLOSED
 * -----------
 * Every ambiguous case refuses:
 *
 *   - a binding naming an agent that does not exist, or exists in another
 *     tenant: the lookup is tenant-scoped, so it simply is not found, and the
 *     request is refused rather than falling back to the caller's value;
 *   - a bound credential whose caller names a different agent: refused, even
 *     though the bound agent is perfectly well known and could have been used;
 *   - an unbound credential naming no agent: refused, as before;
 *   - a retry of an execution belonging to a different agent: refused.
 *
 * No path returns "I could not decide, carry on".
 */

import type { Identity } from "../auth";

/** Why a request was refused. Mapped to HTTP by the caller. */
export type BindingRefusal =
  | "agent_not_declared"
  | "agent_binding_violation"
  | "agent_binding_required";

export interface BindingRefused {
  ok: false;
  refusal: BindingRefusal;
  /** Operator-facing sentence. Never names another tenant's data. */
  reason: string;
}

export interface BindingResolved {
  ok: true;
  /** The agent this request acts as. Derived, not accepted. */
  agentId: string;
  /** True when the id came from the credential rather than from the request. */
  bound: boolean;
}

export type BindingOutcome = BindingResolved | BindingRefused;

/**
 * Whether an unpinned *service* credential may still choose its agent.
 *
 * Read per call rather than captured at module load, matching
 * `allowedOrigins()`: a test can set it without fighting module caching, and an
 * operator changing it does not have to reason about when the module was first
 * imported.
 *
 * Only the exact string `"true"` enables it and only the exact string `"false"`
 * disables it. `"1"`, `"yes"`, `"TRUE"`, `"0"`, `"no"` and `"False"` are all
 * unrecognised — not to be awkward, but because this switch decides whether a
 * credential can act as an agent it was not issued for, and a shell quirk must
 * not be able to move it. An unrecognised value falls through to the
 * environment default, which in production is **required**. So the failure
 * direction of a typo is "stayed closed" wherever it matters.
 *
 * Phase 9 changed which way silence falls. See the module header.
 */
/**
 * Why the requirement is on or off, for the boot banner.
 *
 * ## The defect this exists to close
 *
 * `server/config-check.ts` used to re-derive the posture from the environment it was
 * handed, and describe *that*. Under `tsx` the two agreed, so every test passed. In the
 * shipped bundle they did not: `script/build.ts` compiles with
 * `define: { "process.env.NODE_ENV": '"production"' }`, so the read below is replaced by
 * the literal `"production"` and the requirement is permanently ON in `dist/index.cjs` —
 * while the banner, which reads a real environment object, announced "not required".
 *
 * An operator starting the bundle outside production was therefore told the opposite of
 * what the API would do, and `/api/evaluate` refused their unbound credentials with no
 * explanation they could act on. The enforcement direction was safe; the description was
 * false, which is its own defect in a security control.
 *
 * So the banner no longer derives anything: it reports what this function returns, which
 * is the function the request path actually calls. The two cannot disagree again, in
 * either the source or the bundle.
 *
 * Deliberately NOT fixed by making the read survive bundling: that would let
 * `NODE_ENV=development node dist/index.cjs` switch the requirement off, which is a new
 * way to disable a security control. The artefact stays closed; only the description
 * changed.
 */
export function agentBindingPosture(): { required: boolean; reason: string } {
  /*
   * One read of the variable, as `agent-binding-single-path.test.ts` asserts
   * structurally: a security switch read in two places is a switch that ends up
   * enabled on one code path and not another. That test counts the environment
   * accesses to this variable in this file and requires exactly one, which is
   * why this function takes no `env` parameter: threading one through would
   * either add a second reader or move the read out of the file the test
   * inspects. It also means this comment must not spell the access out.
   *
   * This is why the function returns the REASON as well as the answer. The banner
   * needs to explain the posture, and the only way to do that without becoming a
   * second reader is to be told by the one reader there is.
   */
  const raw = process.env.OATHRION_REQUIRE_AGENT_BINDING;

  // Only the exact string enables it; see above for why `"1"`/`"yes"` do not.
  if (raw === "true") return { required: true, reason: "OATHRION_REQUIRE_AGENT_BINDING=true" };

  /*
   * The one explicit way out, and it has to be the exact string too. A typo
   * (`"False"`, `"0"`, `"no"`) therefore does NOT disable the requirement in
   * production — it falls through to the production default, which is closed.
   * The failure direction of a mistyped opt-out is "stayed safe".
   */
  if (raw === "false") return { required: false, reason: "OATHRION_REQUIRE_AGENT_BINDING=false" };

  /*
   * Unset, empty, or any unrecognised value: the environment decides.
   *
   * In the shipped bundle this comparison is not evaluated at runtime at all —
   * `script/build.ts` replaces the read with the literal `"production"`, so the
   * requirement is permanently ON in `dist/index.cjs`. That is the fail-closed
   * direction and it stays; what the header above describes is making the banner
   * say so instead of guessing otherwise.
   */
  return process.env.NODE_ENV?.trim() === "production"
    ? { required: true, reason: "production default" }
    : { required: false, reason: `NODE_ENV=${process.env.NODE_ENV ?? "unset"}, not production` };
}

/** The enforcing predicate. Derived from the single reader above, never re-derived. */
export function requiresAgentBinding(): boolean {
  return agentBindingPosture().required;
}

/**
 * The chokepoint. Returns the agent this request may act as, or a refusal.
 *
 * `requested` is whatever the caller supplied — a body field, a header — or
 * `null` when they supplied nothing. It is never trusted; at most it is
 * compared.
 */
export function resolveActingAgent(identity: Identity, requested: string | null): BindingOutcome {
  const bound = identity.agentId ?? null;
  const asked = requested && requested.trim().length > 0 ? requested.trim() : null;

  if (bound) {
    /*
     * A bound credential that names nothing is fine, and is the shape a
     * well-configured agent runtime should use: the credential already says who
     * it is, so repeating it in every request adds nothing but a chance to get
     * it wrong.
     */
    if (asked === null || asked === bound) {
      return { ok: true, agentId: bound, bound: true };
    }

    /*
     * Refused rather than ignored.
     *
     * Silently substituting the bound agent would be "safe" in the narrow sense
     * that the wrong agent never acts. It is the wrong answer anyway: a caller
     * that believes it is acting as `agt_finance` and is in fact acting as
     * `agt_billing` produces an audit trail that is correct and a client that is
     * confused, and it hides a misconfigured integration for as long as nobody
     * reads the trail. The refusal names both ids because both are already the
     * caller's own tenant's data and the caller supplied one of them.
     */
    return {
      ok: false,
      refusal: "agent_binding_violation",
      reason:
        `This credential is bound to agent "${bound}" and cannot act as "${asked}". ` +
        `The agent is derived from the credential; naming a different one in a header or ` +
        `body does not change it. Use a credential issued for "${asked}".`,
    };
  }

  if (identity.kind === "service" && requiresAgentBinding()) {
    return {
      ok: false,
      refusal: "agent_binding_required",
      reason:
        "This deployment requires every machine credential to be bound to one agent. " +
        "This credential is not bound, so it cannot act as any agent. Issue a key bound to " +
        "the agent it speaks for. " +
        "In production this is the default (fail closed); it can be relaxed for a migration " +
        "with OATHRION_REQUIRE_AGENT_BINDING=false, which is recorded in the boot log.",
    };
  }

  if (asked === null) {
    return {
      ok: false,
      refusal: "agent_not_declared",
      reason:
        "No agent declared. Oathrion authorises actions per agent, so there is no default. " +
        "Name the agent in the request, or present a credential bound to one.",
    };
  }

  return { ok: true, agentId: asked, bound: false };
}

/**
 * Whether a bound credential may touch an execution that already exists.
 *
 * This is the case the five entry points cannot cover, because a retry names no
 * agent at all — it names an execution, and the agent comes from the stored row.
 * Without this check a credential bound to `agt_billing` could retry
 * `agt_finance`'s failed 50,000 EUR transfer: it never has to *say* the word
 * `agt_finance`, so nothing in `resolveActingAgent` would ever see it.
 *
 * An unbound credential is unaffected, for the same reason it is unaffected
 * elsewhere: it was never confined to begin with, and pretending otherwise here
 * would refuse every console retry in the product.
 */
export function mayActOnExecution(
  identity: Identity,
  executionAgentId: string,
): BindingOutcome {
  const bound = identity.agentId ?? null;
  if (!bound) return { ok: true, agentId: executionAgentId, bound: false };

  if (bound !== executionAgentId) {
    return {
      ok: false,
      refusal: "agent_binding_violation",
      reason:
        `This credential is bound to agent "${bound}" and cannot act on an execution ` +
        `belonging to "${executionAgentId}".`,
    };
  }

  return { ok: true, agentId: bound, bound: true };
}

/**
 * The HTTP status for a refusal.
 *
 * A binding violation is 403, not 404. That is the opposite of the rule the rest
 * of this codebase follows for cross-tenant reads, where a foreign id must read
 * as absent so that 403 does not confirm the row exists — and the difference is
 * deliberate. Here the caller has named an agent **in their own organisation**,
 * which they can already list through `GET /api/agents`. There is no existence
 * to leak, and answering 404 would tell an integrator "that agent is gone" when
 * the truth is "your credential is not the right one", sending them to fix the
 * wrong thing.
 *
 * A missing declaration is 400: the request is malformed, not forbidden.
 */
export function statusFor(refusal: BindingRefusal): number {
  return refusal === "agent_not_declared" ? 400 : 403;
}
