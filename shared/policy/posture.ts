/**
 * Default posture for an action nobody declared.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Until Phase 8 the engine's answer to "a verb that is in no catalog and in no
 * policy" was ALLOW, with one mitigation: `isDangerousActionName`, a heuristic
 * over the verb's own spelling, escalated `bulk_payout_v2` to a human.
 *
 * That was defensible while Oathrion governed a closed catalog inside a console its
 * operators controlled. Phase 8 invites arbitrary agents, written against
 * arbitrary frameworks, to send arbitrary verb names. The heuristic only knows
 * the words it lists, so under the old default these all returned ALLOW:
 *
 *     crm.update_record        email.send_bulk
 *     k8s.scale_down           s3.putObject
 *
 * An authorization layer that answers ALLOW to a verb it has never heard of is
 * not permissive, it is misleading: it returns the *word* ALLOW, with all the
 * authority that word carries in an audit log, for a request nobody assessed.
 * The failure mode is not an outage, it is false assurance — the worst kind for
 * this product.
 *
 * So the default is now BLOCK. An unknown verb is refused.
 *
 * WHAT "UNDECLARED" MEANS, PRECISELY
 * ----------------------------------
 * A verb is undeclared when it is absent from `shared/policy/actions.ts` AND no
 * enabled, applicable policy *names* it (see `hasExplicitActionPolicy` in
 * `engine.ts`). The second half matters: writing a policy whose condition lists
 * `crm.*` is exactly how an operator takes responsibility for a verb Oathrion does
 * not ship. Once they have, the verb is governed and the policy decides — that
 * is the supported path to running your own vocabulary, and it is why a
 * fail-closed default does not make Oathrion a closed catalog.
 *
 * WHY THE OTHER TWO MODES STILL EXIST
 * -----------------------------------
 * `approval` routes unknown verbs to a human instead of refusing them, which is
 * the honest posture while an operator is still discovering what their agents
 * actually call. `allow` restores the pre-Phase-8 behaviour exactly, for an
 * existing deployment that needs a migration window.
 *
 * Neither is the default, and both have to be typed out by name in the
 * environment. That is the whole point: a permissive posture should be a
 * decision somebody made and can be shown to have made, not the consequence of
 * never having configured anything.
 */

/** Posture applied to a verb that is in no catalog and named by no policy. */
export type UndeclaredActionPosture = "block" | "approval" | "allow";

/**
 * Fail closed. Changing this constant changes the security posture of every
 * deployment that has not set the variable, which is why it is stated once here
 * rather than defaulted at each call site.
 */
export const DEFAULT_UNDECLARED_ACTION_POSTURE: UndeclaredActionPosture = "block";

/** Name of the environment variable that overrides the default. */
export const UNDECLARED_ACTION_ENV = "OATHRION_UNDECLARED_ACTION";

const VALID: readonly UndeclaredActionPosture[] = ["block", "approval", "allow"];

/**
 * Resolve the posture from an environment mapping.
 *
 * Takes the environment as an argument rather than reading `process.env`, so it
 * stays usable from `shared/` and testable without mutating global state.
 *
 * An unrecognised value throws rather than falling back. This follows the
 * convention already set by `RATE_LIMIT_FAIL_MODE` and `OATHRION_QUOTA_MODE`, for
 * the same reason: a typo (`OATHRION_UNDECLARED_ACTION=blok`) must not silently
 * select a posture the operator did not choose. Refusing to boot is loud;
 * quietly running permissive is not.
 */
export function resolveUndeclaredActionPosture(
  env: Record<string, string | undefined> = {},
): UndeclaredActionPosture {
  const raw = env[UNDECLARED_ACTION_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_UNDECLARED_ACTION_POSTURE;
  if ((VALID as readonly string[]).includes(raw)) return raw as UndeclaredActionPosture;
  throw new Error(
    `${UNDECLARED_ACTION_ENV} is "${raw}", which is not one of "block", "approval" or "allow". ` +
      `An unrecognised value is refused rather than defaulted, because the three answers differ by ` +
      `whether an action Oathrion has never heard of reaches your systems.`,
  );
}
