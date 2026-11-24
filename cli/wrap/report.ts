/**
 * `oathrion receipt report` — le rapport signé d'une période (`server/local-report.ts`).
 *
 * Demandé au pivot local (`report`), écrit dans un fichier JSON que la personne lit, puis remet
 * elle-même à qui le lui demande (un client, un auditeur, un assureur). Il se vérifie sans
 * Oathrion, et avec : `oathrion receipt verify <fichier>`.
 */
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { ReportStatement } from "../../server/local-report";
import { statementHtml } from "../../server/statement-html";
import { verifyPhoneApproval } from "@shared/phone-approval";
import type { ReceiptCheck, Signed } from "@shared/receipt-share";

import { ensureHub } from "./hub";
import { nameProblem } from "./name";

export const REPORT_USAGE = `
oathrion receipt report [--days <n> | --since <date> [--until <date>]] [--for <name>] [--counts-only] [--out <file>]
                        [--project <folder>] [--server <name>]...

  Signs what the agents protected by Oathrion did on this machine over a period (default: the
  last 30 days): how many actions went through, asked a person, were approved or refused by a
  person, were blocked, by which agent and under which rule, and whether both records are
  intact. Written to a JSON file that anyone can check with: oathrion receipt verify <file>.
  Nothing is sent: you read it, then give it to whoever asked for it.
  --for          who the report is for, as you want it written (e.g. your team's name)
  --counts-only  numbers only: no command in the report
  --project      a statement for a client: only what Claude Code did in this folder (and below)
  --server       ... and what went through this MCP server (repeat for several)
  With --project or --server, or --out ending in .html, it writes a page that checks itself in
  any browser, with each decision a person signed on their phone.
`;

export interface ReportIo {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Le pivot : son opération `report`. Par défaut, le pivot local (lancé s'il ne tourne pas). */
  hub?: () => Promise<{ op<T>(body: Record<string, unknown>): Promise<{ status: number; body: T | null }> }>;
  now?: () => Date;
}

const DAY_MS = 24 * 3_600_000;

export async function runReport(argv: readonly string[], io: ReportIo): Promise<number> {
  const now = io.now?.() ?? new Date();
  let days: number | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let subject: string | null = null;
  let countsOnly = false;
  let outFile: string | null = null;
  let project: string | null = null;
  const servers: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--days" && value) {
      days = Number(value);
      i += 1;
    } else if (argv[i] === "--since" && value) since = argv[++i]!;
    else if (argv[i] === "--until" && value) until = argv[++i]!;
    else if (argv[i] === "--for" && value) subject = argv[++i]!;
    else if (argv[i] === "--out" && value) outFile = argv[++i]!;
    else if (argv[i] === "--project" && value) project = resolve(io.cwd, argv[++i]!);
    else if (argv[i] === "--server" && value) servers.push(argv[++i]!);
    else if (argv[i] === "--counts-only") countsOnly = true;
    else {
      io.err(`Unknown option: ${String(argv[i])}.${REPORT_USAGE}`);
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

  const badServer = servers.find((server) => nameProblem(server));
  if (badServer !== undefined) {
    io.err(`--server refused: ${String(nameProblem(badServer))}`);
    return 3;
  }
  const scope = project !== null || servers.length > 0 ? { project, servers } : null;

  let answer: { status: number; body: Signed<ReportStatement> | null };
  try {
    const hub = await (io.hub ?? (() => ensureHub(io.env)))();
    answer = await hub.op<Signed<ReportStatement>>({ op: "report", since: start.toISOString(), until: end.toISOString(), subject, countsOnly, ...(scope ? { scope } : {}) });
  } catch (error) {
    io.err(`The local Oathrion could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }
  if (answer.status !== 200 || !answer.body?.statement) {
    io.err(`The local Oathrion refused the report (${String(answer.status)}).`);
    return 4;
  }
  const { statement } = answer.body;
  const day = (iso: string) => iso.slice(0, 10);
  const slug = (statement.subject ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const html = outFile === null ? scope !== null : /\.html?$/i.test(outFile);
  const name = html ? `oathrion-statement-${slug ? `${slug}-` : ""}${day(statement.period.since)}-to-${day(statement.period.until)}.html` : `oathrion-report-${day(statement.period.since)}-to-${day(statement.period.until)}.json`;
  const file = resolve(io.cwd, outFile ?? name);
  writeFileSync(file, html ? statementHtml(answer.body) : `${JSON.stringify(answer.body, null, 2)}\n`);

  for (const line of reportBody(statement)) io.out(line);
  io.out(`  Signed by ${statement.issuer.name} · fingerprint ${statement.issuer.fingerprint}`);
  io.out("");
  io.out(`Written to ${relative(io.cwd, file) || file}. Nothing was sent: read it, then give it to whoever asked for it.`);
  io.out(`They check it with: npx oathrion receipt verify ${relative(io.cwd, file) || file}`);
  return 0;
}

/** Ce que dit un rapport, en quelques lignes : à sa création, et à sa vérification. */
export function reportBody(statement: ReportStatement): string[] {
  const { summary, period } = statement;
  const day = (iso: string) => iso.slice(0, 10);
  const scope = statement.scope;
  const decisions = statement.decisions ?? [];
  return [
    `Oathrion ${scope ? "statement" : "report"}${statement.subject ? ` for ${statement.subject}` : ""}, ${day(period.since)} to ${day(period.until)}:`,
    ...(scope ? [`  Scope: ${scope.project ?? "no project folder"}${scope.servers.length > 0 ? ` + MCP servers ${scope.servers.join(", ")}` : ""}`] : []),
    `  ${String(summary.total)} action(s) · ${String(summary.passed)} went through · ${String(summary.asked)} asked a person (${String(summary.approvedByPerson)} approved, ${String(summary.refusedByPerson)} refused, ${String(summary.waiting)} waiting) · ${String(summary.blocked)} blocked`,
    ...statement.agents.slice(0, 5).map((agent) => `  ${agent.agent}: ${String(agent.total)} action(s), ${String(agent.asked)} asked, ${String(agent.blocked)} blocked`),
    ...(summary.signedByPhone ? [`  📱 ${String(summary.signedByPhone)} decision(s) signed on a person's own phone`] : []),
    ...decisions.filter((decision) => decision.approval).slice(0, 5).map((decision) => `  📱 ${decision.outcomeLabel}, signed on ${decision.approval!.device.label || "a paired phone"}: ${decision.what}`),
    ...(statement.saves ?? []).slice(0, 5).map((save) => `  ✋ ${save.what}${save.impact ? ` — would have deleted ${save.impact}` : ""}`),
    statement.evidence.intact
      ? `  Both records intact: ${String(statement.evidence.receipts.entries)} receipt(s), ${String(statement.evidence.journal.entries)} journal line(s).`
      : `  ⚠ NOT intact when signed:${statement.evidence.receipts.intact ? "" : " Oathrion's receipts"}${!statement.evidence.receipts.intact && !statement.evidence.journal.intact ? " and" : ""}${statement.evidence.journal.intact ? "" : " Claude Code's journal"}.`,
    ...(statement.coverage.partial ? ["  ⚠ Partial: Oathrion could not read its whole record for this period."] : []),
    ...(summary.total === 0 ? ["  Nothing recorded in this period: is Oathrion protecting your agents (npx oathrion)?"] : []),
  ];
}

/** `oathrion receipt verify` sur un rapport : un rapport altéré n'est pas montré comme crédible. */
export function reportLines(report: Signed<ReportStatement>, check: ReceiptCheck, pinned: boolean | null): string[] {
  if (!check.ok) return [`✗ NOT VALID: ${check.reason}. Its content cannot be trusted, so it is not shown.`];
  if (pinned === false) return ["✗ NOT VALID: it is signed by a fingerprint that is not in OATHRION_TRUSTED_FINGERPRINTS."];
  const badPhones = (report.statement.decisions ?? []).filter((decision) => decision.approval && !verifyPhoneApproval(decision.approval).ok).length;
  if (badPhones > 0) return [`✗ NOT VALID: it is signed, but ${String(badPhones)} phone approval(s) inside it do not check. Its content cannot be trusted, so it is not shown.`];
  return [
    `✓ Verified ${report.statement.scope ? "statement" : "report"}: not a single character has changed since it was signed${(report.statement.summary.signedByPhone ?? 0) > 0 ? ", and each phone's own signature checks" : ""}.`,
    ...reportBody(report.statement),
    `  Signed by ${report.statement.issuer.name} on ${report.statement.issuedAt} · fingerprint ${check.fingerprint}`,
  ];
}
