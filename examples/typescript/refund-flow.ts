/**
 * Oathrion from TypeScript: the three answers, and what to do with each.
 *
 *   npx tsx examples/typescript/refund-flow.ts
 *
 * Expects OATHRION_URL and OATHRION_API_KEY, and an agent and policy that already
 * exist. `bash examples/quickstart/quickstart.sh` creates exactly those, and
 * this file is the same journey written as an application rather than as curl.
 *
 * The shape to take away is the `switch`. There are three decisions, and code
 * that handles two of them has an unhandled case that executes by default.
 */

/* eslint-disable no-console -- printing the decisions IS the deliverable here. */

import { OathrionClient, OathrionError } from "../../sdk/typescript/src";

const BASE_URL = process.env.OATHRION_URL ?? "http://127.0.0.1:5000";
const API_KEY = process.env.OATHRION_API_KEY;
const AGENT_ID = process.env.OATHRION_AGENT_ID ?? "agt_support_bot";

if (API_KEY === undefined || API_KEY === "") {
  console.error("Set OATHRION_API_KEY. Run examples/quickstart/quickstart.sh first if you need a server.");
  process.exit(3);
}

const placet = new OathrionClient({ baseUrl: BASE_URL, apiKey: API_KEY, agentId: AGENT_ID });

/** Stands in for the thing that actually moves money. */
async function issueRefund(customer: string, amount: number): Promise<void> {
  console.log(`      -> refund of ${amount} EUR issued to ${customer}`);
}

async function attemptRefund(customer: string, amount: number): Promise<void> {
  console.log(`\n  ${amount} EUR to ${customer}`);

  let decision;
  try {
    decision = await placet.evaluate({
      action: "stripe.refund",
      target: customer,
      input: { amount, currency: "EUR", category: "refunds" },
      // A real refund is about to happen, so this is not a "what would you say
      // if" question. Without persist the decision is not recorded and an
      // APPROVAL_REQUIRED files no approval for anyone to act on.
      persist: true,
    });
  } catch (error) {
    /*
     * Reaching Oathrion failed. This is NOT a BLOCK, and the difference matters:
     * a block is an answer, this is the absence of one. Nothing may proceed —
     * "the authorization service was down" has never been a good reason for an
     * agent to have moved money on its own judgement.
     */
    if (error instanceof OathrionError) {
      console.log(`      NO DECISION — ${error.message}`);
      console.log(`      the refund does NOT happen; nothing authorized it.`);
      return;
    }
    throw error;
  }

  /*
   * Three decisions, three branches, and a default that refuses. Writing this
   * as `if (decision.allowed) { ... } else { ... }` would work today and would
   * quietly do the wrong thing the day a fourth decision is added.
   */
  switch (decision.decision) {
    case "ALLOW":
      console.log(`      ALLOW — ${decision.reason}`);
      await issueRefund(customer, amount);
      break;

    case "APPROVAL_REQUIRED":
      // Not a failure, and not permission either. Someone has to answer.
      console.log(`      APPROVAL_REQUIRED — ${decision.reason}`);
      console.log(`      approval ${decision.approvalId ?? "(none filed)"} is waiting for a human.`);
      break;

    case "BLOCK":
      console.log(`      BLOCK — ${decision.reason}`);
      console.log(`      policy: ${decision.policyName ?? "unnamed"}`);
      break;

    default: {
      // Unreachable today. Present because "we did not recognise the answer"
      // must never fall through to the permissive branch.
      const unexpected: never = decision.decision;
      throw new Error(`unhandled decision: ${String(unexpected)}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`Oathrion at ${BASE_URL}, acting as ${AGENT_ID}`);

  await attemptRefund("cus_12345", 75); // under the ceiling
  await attemptRefund("cus_12345", 750); // over it

  /*
   * `requireAllow` is the same call for places where continuing without
   * permission is not a meaningful option. It throws on BLOCK *and* on
   * APPROVAL_REQUIRED, so forgetting to check is impossible rather than merely
   * discouraged.
   */
  console.log(`\n  requireAllow on a 900 EUR refund`);
  try {
    await placet.requireAllow({
      action: "stripe.refund",
      target: "cus_12345",
      input: { amount: 900, currency: "EUR", category: "refunds" },
      persist: true,
    });
    console.log(`      allowed`);
  } catch (error) {
    console.log(`      threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
