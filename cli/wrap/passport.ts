/**
 * `oathrion receipt passport` — le passeport signé d'un agent (`server/local-passport.ts`).
 *
 * Demandé au pivot local (`passport`), écrit dans un fichier JSON que la personne lit, puis remet
 * elle-même à qui le lui demande. Il se vérifie sans Oathrion, et avec :
 * `oathrion receipt verify <fichier>`.
 */
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { PassportStatement } from "../../server/local-passport";
import type { ReceiptCheck, Signed } from "@shared/receipt-share";

import { ensureHub } from "./hub";

export const PASSPORT_USAGE = `
oathrion receipt passport [--agent <name>] [--days <n> | --since <date> [--until <date>]] [--for <name>] [--out <file>]

  Signs an agent's passport: who it is (the program a person admitted, its fingerprint), what
  it may do (the tools it reached, the rules in force), and what it did over a period (default:
  the last 30 days): how many actions went through, asked a person, were blocked, and the last
  one Oathrion stopped. Facts counted by Oathrion, not a rating. Written to a JSON file that
  anyone can check with: oathrion receipt verify <file>. Nothing is sent.
  --agent  the agent, as Oathrion's activity names it (default: the most active one)
  --for    who the passport is for, as you want it written
`;

export interface PassportIo {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  hub?: () => Promise<{ op<T>(body: Record<string, unknown>): Promise<{ status: number; body: T | null }> }>;
  now?: () => Date;
}

const DAY_MS = 24 * 3_600_000;

export async function runPassport(argv: readonly string[], io: PassportIo): Promise<number> {
  const now = io.now?.() ?? new Date();
  let agent: string | null = null;
  let days: number | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let subject: string | null = null;
  let outFile: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--agent" && value) agent = argv[++i]!;
    else if (argv[i] === "--days" && value) {
      days = Number(value);
      i += 1;
    } else if (argv[i] === "--since" && value) since = argv[++i]!;
    else if (argv[i] === "--until" && value) until = argv[++i]!;
    else if (argv[i] === "--for" && value) subject = argv[++i]!;
    else if (argv[i] === "--out" && value) outFile = argv[++i]!;
    else {
      io.err(`Unknown option: ${String(argv[i])}.${PASSPORT_USAGE}`);
      return 3;
    }
  }
  if (days !== null && (since !== null || !Number.isInteger(days) || days < 1 || days > 3_660)) {
    io.err(since !== null ? "Choose --days or --since, not both." : "--days: a whole number of days, from 1.");
    return 3;
  }
  const end = until === null ? now : new Date(until);
  const start = since === null ? new Date(end.getTime() - (days ?? 30) * DAY_MS) : new Date(since);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    io.err("--since and --until: dates such as 2026-11-01, the first before the second.");
    return 3;
  }

  let answer: { status: number; body: (Signed<PassportStatement> & { error?: string; agents?: string[] }) | null };
  try {
    const hub = await (io.hub ?? (() => ensureHub(io.env)))();
    answer = await hub.op<Signed<PassportStatement> & { error?: string; agents?: string[] }>({ op: "passport", agent, since: start.toISOString(), until: end.toISOString(), subject });
  } catch (error) {
    io.err(`The local Oathrion could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }
  if (answer.status === 404) {
    io.err(answer.body?.error ?? "No such agent in Oathrion's record.");
    if (answer.body?.agents?.length) io.err(`Agents Oathrion knows: ${answer.body.agents.map((name) => `"${name}"`).join(", ")}. Choose one with --agent.`);
    else io.err("Nothing recorded yet: is Oathrion protecting your agents (npx oathrion)?");
    return 3;
  }
  if (answer.status !== 200 || !answer.body?.statement) {
    io.err(`The local Oathrion refused the passport (${String(answer.status)}).`);
    return 4;
  }
  const { statement } = answer.body;
  const slug = statement.agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const file = resolve(io.cwd, outFile ?? `oathrion-passport-${slug}-${statement.period.until.slice(0, 10)}.json`);
  writeFileSync(file, `${JSON.stringify(answer.body, null, 2)}\n`);

  for (const line of passportBody(statement)) io.out(line);
  io.out(`  Signed by ${statement.issuer.name} · fingerprint ${statement.issuer.fingerprint}`);
  io.out("");
  io.out(`Written to ${relative(io.cwd, file) || file}. Nothing was sent: read it, then give it to whoever asked for it.`);
  io.out(`They check it with: npx oathrion receipt verify ${relative(io.cwd, file) || file}`);
  return 0;
}

/** Ce que dit un passeport, en quelques lignes : à sa création, et à sa vérification. */
export function passportBody(statement: PassportStatement): string[] {
  const { agent, record, period } = statement;
  const day = (iso: string) => iso.slice(0, 10);
  const sha = agent.program?.sha256;
  return [
    `Agent passport: ${agent.name}${statement.subject ? ` · ${statement.subject}` : ""}, ${day(period.since)} to ${day(period.until)}`,
    agent.program && sha
      ? `  Program ${agent.program.executable} · fingerprint ${sha.slice(0, 4)} ${sha.slice(4, 8)} … ${sha.slice(-4)}${agent.program.admittedAt ? ` · admitted by a person on ${day(agent.program.admittedAt)}` : ""}`
      : "  Program: not read by Oathrion (the name is the one the agent gives itself)",
    ...(agent.firstSeen ? [`  Protected by Oathrion since ${day(agent.firstSeen)}`] : []),
    `  ${String(record.total)} action(s) · ${String(record.passed)} went through · ${String(record.asked)} asked a person (${String(record.approvedByPerson)} approved, ${String(record.refusedByPerson)} refused) · ${String(record.blocked)} blocked`,
    ...(statement.tools.length > 0 ? [`  Tools: ${statement.tools.slice(0, 6).map((t) => `${t.tool} (${String(t.total)})`).join(", ")}`] : []),
    ...(statement.hookRules ? [`  Rules in force: ${String(statement.hookRules.inForce.length)}${statement.hookRules.off.length > 0 ? ` · turned off: ${statement.hookRules.off.join(", ")}` : ""}`] : []),
    ...(statement.lastStopped ? [`  ✋ Last stopped: ${statement.lastStopped.what}${statement.lastStopped.impact ? ` — would have deleted ${statement.lastStopped.impact}` : ""}`] : []),
    statement.evidence.intact ? "  Both records intact." : "  ⚠ NOT intact when signed: the check will say so.",
  ];
}

/** `oathrion receipt verify` sur un passeport : un passeport altéré n'est pas montré comme crédible. */
export function passportLines(passport: Signed<PassportStatement>, check: ReceiptCheck, pinned: boolean | null): string[] {
  if (!check.ok) return [`✗ NOT VALID: ${check.reason}. Its content cannot be trusted, so it is not shown.`];
  if (pinned === false) return ["✗ NOT VALID: it is signed by a fingerprint that is not in OATHRION_TRUSTED_FINGERPRINTS."];
  return [
    "✓ Verified passport: not a single character has changed since it was signed.",
    ...passportBody(passport.statement),
    `  Signed by ${passport.statement.issuer.name} on ${passport.statement.issuedAt} · fingerprint ${check.fingerprint}`,
  ];
}
