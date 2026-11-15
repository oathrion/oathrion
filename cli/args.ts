/**
 * Flag parsing and configuration resolution for the Oathrion CLI.
 *
 * Separate from `main.ts` so it can be tested without a process, and separate
 * from the SDK because the SDK must stay framework-agnostic and transport-only.
 *
 * The parser is strict: an unrecognised flag is an error, not a shrug. A
 * silently-ignored `--ammount` would evaluate a money movement with no amount
 * against rules written to bound the amount — the same reasoning that makes the
 * HTTP contract a strict schema.
 */

import type { AgentAction } from "../sdk/typescript/src/types";

export type Command = "health" | "evaluate" | "config" | "help" | "version";

export interface ParsedArgs {
  command: Command;
  flags: Record<string, string | boolean>;
}

const KNOWN_FLAGS = new Set([
  "url",
  "api-key",
  "agent",
  "action",
  "target",
  "amount",
  "currency",
  "category",
  "input",
  "persist",
  "json",
  "timeout",
  "help",
  "version",
]);

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Parses `argv` (without node and script). Throws `UsageError` on anything unknown. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let command: Command | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (token === "--version" || token === "-v") {
      flags.version = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);

      if (!KNOWN_FLAGS.has(name)) {
        throw new UsageError(
          `Unknown flag --${name}. Run \`oathrion --help\` for the supported flags.`,
        );
      }

      if (eq !== -1) {
        flags[name] = body.slice(eq + 1);
        continue;
      }

      // `--persist` and `--json` are switches; everything else takes a value.
      if (name === "persist" || name === "json") {
        flags[name] = true;
        continue;
      }

      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`Flag --${name} needs a value.`);
      }
      flags[name] = value;
      i += 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      throw new UsageError(`Unknown flag ${token}. Run \`oathrion --help\`.`);
    }

    if (command !== null) {
      throw new UsageError(`Unexpected argument "${token}". One command at a time.`);
    }

    if (token === "health" || token === "evaluate" || token === "config") {
      command = token;
    } else {
      throw new UsageError(
        `Unknown command "${token}". Available: health, evaluate, config.`,
      );
    }
  }

  if (flags.version) return { command: "version", flags };
  if (command === null || flags.help) return { command: command ?? "help", flags };
  return { command, flags };
}

export interface Config {
  baseUrl: string;
  apiKey: string;
  agentId?: string;
  timeoutMs: number;
}

/**
 * Resolves configuration from flags, then environment. Flags win.
 *
 * `--api-key` is accepted but the help text steers to `OATHRION_API_KEY`, because a
 * credential on the command line lands in the shell history file and in the
 * process list where any other user on the box can read it. Accepting it is
 * pragmatic; recommending it would not be.
 */
export function resolveConfig(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): Config {
  const baseUrl = str(flags.url) ?? env.OATHRION_URL;
  const apiKey = str(flags["api-key"]) ?? env.OATHRION_API_KEY;

  if (!baseUrl) {
    throw new UsageError(
      "No Oathrion URL. Set OATHRION_URL, or pass --url http://127.0.0.1:5000.",
    );
  }
  if (!apiKey) {
    throw new UsageError(
      "No credential. Set OATHRION_API_KEY (preferred — a key passed as a flag is " +
        "recorded in your shell history and visible in the process list), or " +
        "pass --api-key.",
    );
  }

  const rawTimeout = str(flags.timeout);
  let timeoutMs = 10_000;
  if (rawTimeout !== undefined) {
    const parsed = Number(rawTimeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new UsageError(`--timeout must be a positive number of milliseconds.`);
    }
    timeoutMs = parsed;
  }

  return {
    baseUrl,
    apiKey,
    agentId: str(flags.agent) ?? env.OATHRION_AGENT_ID,
    timeoutMs,
  };
}

/**
 * Builds the action from flags.
 *
 * Returns a real `AgentAction`, not a `Record<string, unknown>` that `main.ts`
 * then casts. The cast was a lie the compiler had already objected to: it
 * asserted a type whose two required fields the record could not be known to
 * carry, which is precisely the check worth keeping on the payload of an
 * authorization request.
 *
 * `--input` accepts a JSON object for anything the dedicated flags do not
 * cover. Malformed JSON is a usage error rather than a silently empty input:
 * evaluating with no input against rules that read the input is how a caller
 * ends up with an answer to a question they did not ask.
 */
export function buildAction(
  flags: Record<string, string | boolean>,
  config: Config,
): AgentAction {
  const action = str(flags.action);
  const target = str(flags.target);

  if (!action) throw new UsageError("--action is required, e.g. --action stripe.refund.");
  if (!target) {
    throw new UsageError(
      "--target is required: Oathrion authorises an action on a specific resource, " +
        "and omitting it would evaluate against no target-scoped rule.",
    );
  }

  const body: AgentAction = { action, target };
  if (config.agentId) body.agentId = config.agentId;

  const rawInput = str(flags.input);
  if (rawInput !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      throw new UsageError(`--input must be valid JSON. Received: ${rawInput}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UsageError("--input must be a JSON object, e.g. --input '{\"amount\":75}'.");
    }
    // Narrowed to `object` above; the record shape is what the contract wants.
    body.input = parsed as Record<string, unknown>;
  }

  const amount = str(flags.amount);
  if (amount !== undefined) {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric)) {
      throw new UsageError(`--amount must be a number. Received: ${amount}`);
    }
    body.amount = numeric;
  }

  const currency = str(flags.currency);
  if (currency !== undefined) body.currency = currency;

  const category = str(flags.category);
  if (category !== undefined) body.category = category;

  if (flags.persist === true) body.persist = true;

  return body;
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Masks a credential for display. Never prints enough to reuse. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}
