/**
 * LE PASSEPORT D'UN AGENT — qui il est, ce qu'il a le droit de faire, ce qu'il a fait
 * (`notes/CONCEPTION-PASSEPORT-AGENT.md`, idée du 23 novembre).
 *
 * Le rapport d'une période (`server/local-report.ts`), mais pour UN agent, avec ce qu'Oathrion
 * sait de lui : le programme qu'une personne a admis (son empreinte, quand), les outils qu'il a
 * atteints et ce qui s'y est passé, les règles en vigueur pour Claude Code, la dernière action
 * arrêtée. Signé (`shared/receipt-share.ts`), il se vérifie sans Oathrion.
 *
 * Ce n'est PAS une note de confiance : des faits comptés, signés (décision du 22 novembre). Le
 * nom de l'agent est celui qu'il se donne ; ce qui l'identifie, c'est l'empreinte de son
 * programme, quand Oathrion l'a lue.
 *
 * Fonction pure : l'opération `passport` du pivot lui passe la chronologie, les programmes, les
 * règles et la clé.
 */
import { PASSPORT_TYPE, type SignedDocument } from "@shared/receipt-share";

import type { ActivityEntry } from "./local-activity";
import type { KnownProgram } from "./local-programs";
import { reportStatement, type ReportChain, type ReportSave, type ReportStatement } from "./local-report";
import { BUCKET } from "./local-summary";

export interface PassportStatement extends SignedDocument {
  type: typeof PASSPORT_TYPE;
  subject: string | null;
  agent: {
    /** Le nom que l'agent se donne : une déclaration. */
    name: string;
    firstSeen: string | null;
    lastSeen: string | null;
    /** Le programme qu'une personne a admis, quand Oathrion l'a lu (agents MCP) ; null sinon. */
    program: { executable: string; sha256: string; platform: string; admittedAt: string | null; updates: number } | null;
  };
  period: { since: string; until: string };
  record: ReportStatement["summary"];
  /** Ce que l'agent a atteint : un serveur MCP, le shell, les fichiers ; et ce qui s'y est passé. */
  tools: { tool: string; total: number; asked: number; blocked: number }[];
  /** Pourquoi une de ses actions a été demandée ou bloquée : la règle, comptée. */
  rules: ReportStatement["rules"];
  /** Pour Claude Code : les règles du hook en vigueur et celles que la personne a coupées. */
  hookRules: { inForce: string[]; off: string[]; extraDeny: number; extraAsk: number } | null;
  lastStopped: ReportSave | null;
  evidence: { receipts: ReportChain; journal: ReportChain; intact: boolean };
  limits: string[];
}

/** Ce qu'une action a atteint : `mcp.<serveur>.<verbe>` → le serveur ; le hook → le shell ou les fichiers. */
export function toolOf(entry: ActivityEntry): string {
  if (entry.source === "oathrion") return /^mcp\.([^.]+)\./.exec(entry.action)?.[1] ?? entry.action.split(".")[0] ?? entry.action;
  if (entry.target.startsWith("file://")) return "files";
  if (entry.action.startsWith("read untrusted content")) return "untrusted content";
  return "shell";
}

export function passportStatement(input: {
  agent: string;
  entries: readonly ActivityEntry[];
  programs: readonly KnownProgram[];
  hookRules: { all: readonly string[]; disabled: ReadonlySet<string>; extraDeny: number; extraAsk: number } | null;
  since: string;
  until: string;
  subject: string | null;
  home: string;
  partial: boolean;
  receipts: { ok: boolean; entries: number; head: string | null };
  journal: { ok: boolean; entries: number; head: string | null };
  issuer: SignedDocument["issuer"];
  issuedAt: string;
}): PassportStatement {
  const mine = input.entries.filter((entry) => entry.agent === input.agent);
  const report = reportStatement({ ...input, entries: mine, countsOnly: false, maxSaves: 1 });
  const inPeriod = mine.filter((entry) => entry.at >= input.since && entry.at <= input.until);
  const tools = new Map<string, { total: number; asked: number; blocked: number }>();
  for (const entry of inPeriod) {
    const tool = toolOf(entry);
    const counts = tools.get(tool) ?? { total: 0, asked: 0, blocked: 0 };
    counts.total += 1;
    if (BUCKET[entry.outcome] === "asked") counts.asked += 1;
    if (BUCKET[entry.outcome] === "blocked") counts.blocked += 1;
    tools.set(tool, counts);
  }
  const sorted = mine.map((entry) => entry.at).sort();
  /* Le programme admis sous ce nom, le plus récemment vu : un autre programme qui prend ce nom est un autre programme. */
  const program = input.programs.filter((p) => p.name === input.agent && p.status === "trusted" && p.identity).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
  const home = input.home.replace(/\/+$/, "");
  const withoutHome = (path: string) => (home && home !== "/" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);
  const isClaudeCode = input.agent === "Claude Code" && mine.some((entry) => entry.source === "claude-code");
  return {
    type: PASSPORT_TYPE,
    issuedAt: input.issuedAt,
    issuer: input.issuer,
    subject: input.subject,
    agent: {
      name: input.agent,
      firstSeen: sorted[0] ?? null,
      lastSeen: sorted.at(-1) ?? null,
      program: program?.identity
        ? { executable: withoutHome(program.identity.script ?? program.identity.exe), sha256: program.identity.sha256, platform: program.identity.platform, admittedAt: program.decidedAt, updates: program.previousSha256.length }
        : null,
    },
    period: report.period,
    record: report.summary,
    tools: [...tools].map(([tool, counts]) => ({ tool, ...counts })).sort((a, b) => b.total - a.total || a.tool.localeCompare(b.tool)),
    rules: report.rules,
    hookRules:
      isClaudeCode && input.hookRules
        ? { inForce: input.hookRules.all.filter((id) => !input.hookRules!.disabled.has(id)), off: input.hookRules.all.filter((id) => input.hookRules!.disabled.has(id)), extraDeny: input.hookRules.extraDeny, extraAsk: input.hookRules.extraAsk }
        : null,
    lastStopped: report.saves?.[0] ?? null,
    evidence: report.evidence,
    limits: [
      "Only what this agent did through Oathrion on this machine. Actions outside Oathrion are not in it.",
      "The agent's name is the one it gives itself; what identifies it is its program's fingerprint, when Oathrion could read it.",
      "Facts counted by Oathrion, not a rating. The fingerprint of the signature names this machine's key, not a person.",
      "Secrets recognisable in commands are redacted before signing; the home folder is written ~.",
      ...(input.partial ? ["Oathrion could not read its whole record for this period: the counts may be lower than what happened."] : []),
    ],
  };
}
