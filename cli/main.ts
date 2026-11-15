/**
 * The Oathrion CLI.
 *
 *     oathrion health
 *     oathrion evaluate --action stripe.refund --target cus_1 --amount 75 --currency EUR
 *     oathrion config
 *
 * A THIN LAYER, DELIBERATELY
 * --------------------------
 * Every command here is a wrapper over the TypeScript SDK, which is itself a
 * wrapper over `POST /api/evaluate`. The CLI contains no rule evaluation, no
 * cache, no local allow-list and no default decision. It cannot: the decision
 * arrives from the server or the command fails.
 *
 * There is no `oathrion protect`. The brief asked for one only if a matching server
 * route existed, and none does — inventing a command whose behaviour lives
 * entirely in the client would be exactly the second decision engine this
 * project must not grow.
 *
 * ON EXIT CODES
 * -------------
 * `ALLOW` is the only 0. See `exit-codes.ts` for why that single fact is the
 * security contract of the whole tool.
 */

import { OathrionClient } from "../sdk/typescript/src/client";
import {
  OathrionConnectionError,
  OathrionHttpError,
  OathrionProtocolError,
  OathrionTimeoutError,
} from "../sdk/typescript/src/errors";
import { buildAction, maskKey, parseArgs, resolveConfig, UsageError } from "./args";
import { EXIT, exitCodeForDecision, type ExitCode } from "./exit-codes";

/** Injected in tests so no real process or stream is needed. */
export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Overridable so tests can drive the SDK against a stub transport. */
  makeClient?: (config: {
    baseUrl: string;
    apiKey: string;
    agentId?: string;
    timeoutMs: number;
  }) => OathrionClient;
}

/* La version du produit (`package.json`) ; `version-coherence.test.ts` refuse qu'elle diverge. */
export const VERSION = "0.1.0-preview.1";

const HELP = `Oathrion — runtime authorization for AI agents.

  AI can act. You decide what it can do.

PUT OATHRION IN FRONT OF YOUR AGENTS' MCP SERVERS
  npx oathrion                    Find the MCP servers of Claude Code, Claude Desktop
                                  and Cursor, show them, protect them all after one
                                  answer.
  npx oathrion --undo             Put every server back as it was.
  oathrion demo                   See Oathrion's notification in ten seconds, on a
                                  pretend agent: nothing real is paused.
  oathrion console                Open the local console, already signed in.
  oathrion phone telegram         Approve from your phone, anywhere: requests arrive
                                  on Telegram with Approve and Reject.
  oathrion decoys plant           Plant fake secrets: one in what your agent sends,
                                  and Oathrion refuses it.
  oathrion wrap -- <command>      Govern one MCP server (what the clients run).
  oathrion jail -- <agent>        Run an agent where it cannot go around Oathrion
                                  (Linux): secrets hidden, only your servers.
  oathrion watch --always         Be told when an AI agent runs outside Oathrion's
                                  protection (Linux), from every session.
  oathrion watch --forget <agent> No longer allow an agent outside the jail
                                  (without a name: list those allowed).
  oathrion feedback [message]     Tell us what works and what breaks.

USAGE
  oathrion <command> [flags]

COMMANDS
  evaluate    Ask Oathrion whether an action is permitted.
  health      Check that Oathrion is reachable and healthy.
  config      Show the resolved configuration (the credential is masked).

EVALUATE FLAGS
  --action <verb>        Required. e.g. stripe.refund
  --target <resource>    Required. What the action acts on.
  --agent <id>           Agent identity. Defaults to OATHRION_AGENT_ID.
  --amount <number>      Amount, for money-movement policies.
  --currency <code>      e.g. EUR
  --category <name>      Free-form category.
  --input '<json>'       A JSON object for anything else the policies read.
  --persist              Record the evaluation and act on it. See below.
  --json                 Emit the raw decision as JSON.

GLOBAL FLAGS
  --url <url>            Oathrion base URL. Defaults to OATHRION_URL.
  --api-key <key>        Credential. Prefer OATHRION_API_KEY: a key passed as a
                         flag is saved in your shell history and is visible in
                         the process list.
  --timeout <ms>         Request timeout. Default 10000.
  -h, --help             This text.
  -v, --version          Version.

EXIT CODES — the point of this tool
  0  ALLOW              permitted. THE ONLY ZERO.
  1  BLOCK              policy refused it.
  2  APPROVAL_REQUIRED  a human must decide. NOT permission.
  3  usage              bad flags or missing configuration. Nothing was asked.
  4  unreachable        Oathrion could not be reached. NOTHING decided anything.
  5  http               Oathrion answered, but not with a decision (401/403/400/5xx).
  6  protocol           the answer could not be read as a decision.

  So this is safe, and is the intended shape:

      oathrion evaluate --action stripe.refund --target cus_1 --amount 75 \\
        && ./issue-refund.sh

  The refund runs only on ALLOW. A block, a hold, an expired key or a network
  timeout all stop the chain.

ON --persist
  Without it, evaluate is a DRY RUN: Oathrion reports what it would decide and
  records nothing. A dry-run APPROVAL_REQUIRED therefore files no approval, so
  nobody can approve it and nothing is waiting in a queue. Pass --persist when
  the action is real and a human is expected to answer.

ENVIRONMENT
  OATHRION_URL, OATHRION_API_KEY, OATHRION_AGENT_ID
`;

/**
 * Runs the CLI and RETURNS an exit code rather than calling `process.exit`.
 *
 * That is what makes every exit code assertable in-process. A tool whose
 * security contract is its exit codes should not have those codes reachable
 * only by spawning it.
 */
export async function run(argv: string[], io: Io): Promise<ExitCode> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`oathrion: ${error.message}`);
      return EXIT.USAGE;
    }
    throw error;
  }

  if (parsed.command === "version") {
    io.out(VERSION);
    return EXIT.ALLOW;
  }

  if (parsed.command === "help") {
    // Help on an explicit --help is success; help because no command was given
    // is a usage error, so `oathrion` alone in a script does not look like an ALLOW.
    io.out(HELP);
    return parsed.flags.help === true ? EXIT.ALLOW : EXIT.USAGE;
  }

  let config;
  try {
    config = resolveConfig(parsed.flags, io.env);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`oathrion: ${error.message}`);
      return EXIT.USAGE;
    }
    throw error;
  }

  if (parsed.command === "config") {
    io.out(`url         ${config.baseUrl}`);
    io.out(`api-key     ${maskKey(config.apiKey)}`);
    io.out(`agent       ${config.agentId ?? "(none — pass --agent or set OATHRION_AGENT_ID)"}`);
    io.out(`timeout     ${config.timeoutMs}ms`);
    return EXIT.ALLOW;
  }

  const client =
    io.makeClient?.(config) ??
    new OathrionClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      agentId: config.agentId,
      timeoutMs: config.timeoutMs,
    });

  if (parsed.command === "health") {
    try {
      const health = await client.health();
      /*
       * Two different "ok"s have to agree: the HTTP layer reached the server,
       * AND the server's own body reports itself healthy. A 200 carrying
       * `status: "degraded"` is a reachable server that is telling you it is
       * not well, and a health check that exits 0 for it is a health check in
       * name only.
       *
       * `httpStatus` is deliberately not called `status` in the SDK: that name
       * collides with the `status` field inside this body, and comparing the
       * wrong one to "ok" is silently always false. See `OathrionClient.health`.
       */
      const reported =
        typeof health.body === "object" && health.body !== null
          ? (health.body as { status?: unknown }).status
          : undefined;

      io.out(
        parsed.flags.json === true
          ? JSON.stringify(health.body)
          : `Oathrion is ${typeof reported === "string" ? reported : "unreachable"}.`,
      );

      return health.ok && reported === "ok" ? EXIT.ALLOW : EXIT.HTTP;
    } catch (error) {
      return reportFailure(error, io);
    }
  }

  let body;
  try {
    body = buildAction(parsed.flags, config);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`oathrion: ${error.message}`);
      return EXIT.USAGE;
    }
    throw error;
  }

  try {
    const decision = await client.evaluate(body);

    if (parsed.flags.json === true) {
      io.out(JSON.stringify(decision));
    } else {
      io.out(`${decision.decision}  ${decision.reason}`);
      if (decision.policyId) io.out(`policy      ${decision.policyId}`);
      if (decision.requestId) io.out(`request     ${decision.requestId}`);
      if (decision.pendingApproval) {
        io.out(
          decision.approvalId
            ? `approval    ${decision.approvalId} — a human must act on this`
            : `approval    not filed: this was a dry run. Re-run with --persist ` +
                `if a human is meant to see it.`,
        );
      }
    }

    return exitCodeForDecision(decision.decision);
  } catch (error) {
    return reportFailure(error, io);
  }
}

/**
 * Turns a thrown SDK error into a message and a code.
 *
 * Every branch is non-zero. There is deliberately no fallback that returns
 * ALLOW: an error this function does not recognise still must not authorise
 * anything, so the default is a protocol failure.
 */
function reportFailure(error: unknown, io: Io): ExitCode {
  if (error instanceof OathrionTimeoutError) {
    io.err(
      `oathrion: Oathrion did not answer in time. No decision was received, so the ` +
        `action is NOT authorised.`,
    );
    return EXIT.UNREACHABLE;
  }
  if (error instanceof OathrionConnectionError) {
    io.err(
      `oathrion: could not reach Oathrion. No decision was received, so the action is ` +
        `NOT authorised. (${error.message})`,
    );
    return EXIT.UNREACHABLE;
  }
  if (error instanceof OathrionHttpError) {
    if (error.isAuthFailure) {
      io.err(`oathrion: Oathrion refused the credential (HTTP ${error.status}). ${error.message}`);
    } else if (error.isRequestInvalid) {
      io.err(`oathrion: Oathrion rejected the request (HTTP 400). ${error.message}`);
    } else {
      io.err(`oathrion: Oathrion returned HTTP ${error.status}. ${error.message}`);
    }
    if (error.requestId) io.err(`oathrion: request ${error.requestId}`);
    return EXIT.HTTP;
  }
  if (error instanceof OathrionProtocolError) {
    io.err(`oathrion: could not read Oathrion's answer as a decision. ${error.message}`);
    return EXIT.PROTOCOL;
  }
  io.err(`oathrion: unexpected failure. ${error instanceof Error ? error.message : String(error)}`);
  return EXIT.PROTOCOL;
}
