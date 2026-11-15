/**
 * Exit codes for the Oathrion CLI.
 *
 * THE ONE PROPERTY THAT MATTERS
 * -----------------------------
 * `ALLOW` is 0. Everything else — every decision that is not ALLOW, and every
 * failure of any kind — is non-zero.
 *
 * That is not a stylistic choice, it is the whole security contract of a
 * command-line authorization tool, because this is how people will use it:
 *
 *     oathrion evaluate --action stripe.refund --target cus_1 --amount 75 \
 *       && ./issue-refund.sh
 *
 * The shell runs the right-hand side if and only if the left-hand side exits 0.
 * So a CLI that exits 0 on a BLOCK, or 0 on a timeout, or 0 on an expired
 * credential, silently authorises the action it was asked to guard. A `&&` chain
 * is a fail-open waiting for an outage.
 *
 * Two consequences are deliberate and must survive future edits:
 *
 *  1. `APPROVAL_REQUIRED` is non-zero. A held action is waiting for a human and
 *     has not been permitted. Exiting 0 there would make every approval gate in
 *     every shell script decorative.
 *
 *  2. Failures are non-zero and DISTINCT from decisions. A network timeout is
 *     not a BLOCK — nothing decided anything — but it must not be 0 either. It
 *     gets its own code so an operator can tell "policy refused this" from
 *     "I could not ask", which are entirely different incidents.
 *
 * The codes below 8 are the reserved region; new decision outcomes must be
 * added as non-zero and never by renumbering ALLOW.
 */
export const EXIT = {
  /** The action is permitted. THE ONLY ZERO. */
  ALLOW: 0,
  /** Policy refused the action. */
  BLOCK: 1,
  /** A human must decide. NOT permission. */
  APPROVAL_REQUIRED: 2,
  /** Bad flags, missing configuration, no credential. Nothing was asked. */
  USAGE: 3,
  /** Oathrion could not be reached, or did not answer in time. Nothing decided. */
  UNREACHABLE: 4,
  /** Oathrion answered, and the answer was not a decision: 401, 403, 400, 5xx. */
  HTTP: 5,
  /** A 200 the client cannot interpret as a decision. */
  PROTOCOL: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Maps a decision to its exit code. Exhaustive on purpose — see below. */
export function exitCodeForDecision(decision: string): ExitCode {
  switch (decision) {
    case "ALLOW":
      return EXIT.ALLOW;
    case "BLOCK":
      return EXIT.BLOCK;
    case "APPROVAL_REQUIRED":
      return EXIT.APPROVAL_REQUIRED;
    default:
      /*
       * A decision string this build has never heard of. The safe reading of "I
       * do not recognise the answer" is not to pick the permissive one, so an
       * unknown decision is a protocol failure rather than a default of ALLOW.
       */
      return EXIT.PROTOCOL;
  }
}
