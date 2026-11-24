/**
 * LE RAPPORT SIGNÉ D'UNE PÉRIODE — la fondation du score et du dossier d'audit
 * (`notes/CONCEPTION-RAPPORT-PERIODE.md`).
 *
 * Ce que les agents de cette machine ont fait sur une période : combien d'actions, combien sont
 * passées seules, combien ont été demandées à une personne (approuvées, refusées, en attente),
 * combien Oathrion a bloquées, par quel agent, sous quelle règle ; les actions bloquées ; l'état
 * des DEUX chaînes (reçus d'Oathrion, journal du hook de Claude Code). Signé
 * (`shared/receipt-share.ts`), il se vérifie sans Oathrion : c'est ce qu'une équipe remet à un
 * client, un auditeur ou un assureur qui le lui demande.
 *
 * Calculé sur la machine, remis par la personne : rien ne part tout seul.
 * Il sort de la machine : il ne doit rien divulguer d'autre.
 *   · pas de chemin personnel : le dossier personnel devient « ~ » ;
 *   · pas de secret reconnaissable dans une commande, masqué AVANT la signature ;
 *   · `countsOnly` : seulement des nombres, aucune commande.
 *
 * Ce n'est PAS une note de risque : des faits comptés, signés. Une note viendra par-dessus, quand
 * un client la demandera, et pourra être recalculée par celui qui la lit.
 *
 * Fonction pure : l'opération `report` du pivot lui passe la chronologie, les verdicts et la clé.
 */
import type { PhoneApproval } from "@shared/phone-approval";
import { plainStep, type StepKey } from "@shared/plain-step";
import { REPORT_TYPE, type SignedDocument } from "@shared/receipt-share";
import { redactSecrets } from "@shared/secrets";

import type { ActivityEntry, ActivityOutcome } from "./local-activity";
import { inProject, relativize } from "./local-bundle";
import { OUTCOME_LABEL } from "./local-receipt";
import { BUCKET } from "./local-summary";

export interface ReportChain {
  /** Ce que cette chaîne enregistre. */
  chain: string;
  intact: boolean;
  entries: number;
  head: string | null;
}

export interface ReportSave {
  at: string;
  agent: string;
  what: string;
  rule: string | null;
  impact: string | null;
  ref: string;
  /** Ce qui a été arrêté, en mots simples (« delete files »). */
  todo?: string;
}

/** Une décision d'une personne : l'action retenue pour elle, sa réponse, et l'accord signé par son téléphone s'il y en a un. */
export interface ReportDecision {
  at: string;
  agent: string;
  what: string;
  outcome: ActivityOutcome;
  outcomeLabel: string;
  ref: string;
  approval: PhoneApproval | null;
  /** Ce qui a été demandé, en mots simples (« publish the code to the shared repository »). */
  todo?: string;
}

/** Une étape du relevé d'un client, en mots simples ; la commande exacte reste à côté. */
export interface ReportStep {
  at: string;
  agent: string;
  what: string;
  /** « Ran the tests ». */
  done: string;
  key: StepKey;
  detail: string | null;
  outcome: ActivityOutcome;
  ref: string;
}

/** Le périmètre d'un relevé de client : un dossier (le journal du hook) et des serveurs MCP nommés. */
export interface ReportScope {
  project: string | null;
  servers: string[];
}

export interface ReportStatement extends SignedDocument {
  type: typeof REPORT_TYPE;
  /** Pour qui le rapport est émis, tel que la personne l'a écrit (`--for`) : déclaré, pas prouvé. */
  subject: string | null;
  /** Le relevé d'un client : seulement ce dossier et ces serveurs ; absent, toute la machine. */
  scope?: ReportScope;
  period: { since: string; until: string };
  summary: {
    total: number;
    passed: number;
    asked: number;
    /** Parmi les demandes : approuvées par une personne, refusées par une personne, encore en attente. */
    approvedByPerson: number;
    refusedByPerson: number;
    waiting: number;
    blocked: number;
    /** Parmi les réponses des personnes : celles signées par leur téléphone. */
    signedByPhone?: number;
  };
  /** Chaque issue rencontrée, comptée : le détail derrière le résumé. */
  outcomes: Partial<Record<ActivityOutcome, number>>;
  agents: { agent: string; total: number; asked: number; blocked: number }[];
  /** Pourquoi une action a été demandée ou bloquée : la règle, comptée. */
  rules: { rule: string; asked: number; blocked: number }[];
  /** Les actions bloquées par Oathrion, les plus récentes d'abord ; null si le rapport ne garde que des nombres. */
  saves: ReportSave[] | null;
  /** Plus d'actions bloquées que le rapport n'en garde : il le dit. */
  savesTruncated: number;
  /** Les réponses des personnes, les plus récentes d'abord ; null si le rapport ne garde que des nombres. */
  decisions?: ReportDecision[] | null;
  decisionsTruncated?: number;
  /** Le relevé d'un client : toutes les étapes du projet, de la plus ancienne à la plus récente (les plus récentes si trop nombreuses). */
  steps?: ReportStep[];
  stepsTruncated?: number;
  coverage: {
    /** La première action enregistrée sur cette machine, toutes périodes confondues. */
    recordStarts: string | null;
    /** Le pivot n'a pas pu tout relire : le rapport est peut-être incomplet, et il le dit. */
    partial: boolean;
  };
  evidence: { receipts: ReportChain; journal: ReportChain; intact: boolean };
  limits: string[];
}

export const MAX_REPORT_SAVES = 200;
export const MAX_REPORT_DECISIONS = 200;
export const MAX_REPORT_STEPS = 2_000;

/** Les réponses d'une personne : approuvée, refusée, ou demandée puis tranchée dans le client. */
const PERSON_DECIDED: ReadonlySet<ActivityOutcome> = new Set(["approved-done", "approved-failed", "approved-not-run", "refused-by-person", "asked-done", "asked-failed", "asked-not-run"]);

/** Les étapes d'un relevé de client : en mots simples, dans l'ordre ; les plus récentes si elles sont trop nombreuses. */
function stepsOf(entries: readonly ActivityEntry[], clean: (text: string) => string): { steps: ReportStep[]; stepsTruncated: number } {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const kept = sorted.slice(-MAX_REPORT_STEPS);
  return {
    steps: kept.map((entry) => {
      const what = clean(entry.action);
      const step = plainStep(what, entry.target);
      return { at: entry.at, agent: entry.agent, what, done: step.done, key: step.key, detail: step.detail, outcome: entry.outcome, ref: entry.ref };
    }),
    stepsTruncated: sorted.length - kept.length,
  };
}

/** Le serveur MCP d'une action passée par Oathrion (`mcp.<serveur>.<verbe>`). */
export function serverOf(entry: ActivityEntry): string | null {
  return entry.source === "oathrion" ? (/^mcp\.([^.]+)\./.exec(entry.action)?.[1] ?? null) : null;
}

/** Ce qu'un relevé de client garde : les actions du dossier, et celles des serveurs nommés. */
export function inScope(entry: ActivityEntry, scope: ReportScope): boolean {
  if (entry.source === "claude-code") return scope.project !== null && inProject(entry.target, scope.project.replace(/\/+$/, ""));
  const server = serverOf(entry);
  return server !== null && scope.servers.includes(server);
}

/** Le dossier personnel devient « ~ » : aucun chemin de la machine ne sort. */
function withoutHome(text: string, home: string): string {
  if (!home || home === "/") return text;
  const escaped = home.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`file://${escaped}(?=/|$)`, "g"), "~").replace(new RegExp(`${escaped}(?=/|\\b|$)`, "g"), "~");
}

/** La règle d'une action : « rule <id> » dans le journal du hook, sinon la raison donnée par Oathrion. */
function ruleOf(entry: ActivityEntry, clean: (text: string) => string): string | null {
  if (!entry.detail) return null;
  const named = /\brule ([a-z0-9][a-z0-9-]*)/i.exec(entry.detail);
  if (named) return named[1]!;
  return clean(entry.detail).slice(0, 120);
}

export function reportStatement(input: {
  entries: readonly ActivityEntry[];
  since: string;
  until: string;
  subject: string | null;
  home: string;
  countsOnly: boolean;
  partial: boolean;
  receipts: { ok: boolean; entries: number; head: string | null };
  journal: { ok: boolean; entries: number; head: string | null };
  issuer: SignedDocument["issuer"];
  issuedAt: string;
  maxSaves?: number;
  scope?: ReportScope | null;
}): ReportStatement {
  const scope = input.scope ?? null;
  const project = scope?.project ? scope.project.replace(/\/+$/, "") : null;
  /* Le dossier du client devient « . » dans ce qui sort, comme dans le paquet d'une PR. */
  const clean = (text: string) => redactSecrets(project ? relativize(text, project, input.home) : withoutHome(text, input.home));
  const entries = scope ? input.entries.filter((entry) => inScope(entry, scope)) : input.entries;
  const inPeriod = entries.filter((entry) => entry.at >= input.since && entry.at <= input.until);
  const outcomes: Partial<Record<ActivityOutcome, number>> = {};
  const agents = new Map<string, { total: number; asked: number; blocked: number }>();
  const rules = new Map<string, { asked: number; blocked: number }>();
  for (const entry of inPeriod) {
    outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    const bucket = BUCKET[entry.outcome];
    const agent = agents.get(entry.agent) ?? { total: 0, asked: 0, blocked: 0 };
    agent.total += 1;
    if (bucket === "asked") agent.asked += 1;
    if (bucket === "blocked") agent.blocked += 1;
    agents.set(entry.agent, agent);
    const rule = bucket === "passed" ? null : ruleOf(entry, clean);
    if (rule) {
      const counted = rules.get(rule) ?? { asked: 0, blocked: 0 };
      if (bucket === "asked") counted.asked += 1;
      else counted.blocked += 1;
      rules.set(rule, counted);
    }
  }
  const count = (predicate: (outcome: ActivityOutcome) => boolean) => inPeriod.filter((entry) => predicate(entry.outcome)).length;
  const blocked = inPeriod.filter((entry) => entry.outcome === "refused").sort((a, b) => b.at.localeCompare(a.at));
  const max = input.maxSaves ?? MAX_REPORT_SAVES;
  const decided = inPeriod.filter((entry) => PERSON_DECIDED.has(entry.outcome)).sort((a, b) => b.at.localeCompare(a.at));
  const first = entries.reduce<string | null>((earliest, entry) => (earliest === null || entry.at < earliest ? entry.at : earliest), null);
  return {
    type: REPORT_TYPE,
    issuedAt: input.issuedAt,
    issuer: input.issuer,
    subject: input.subject,
    ...(scope ? { scope: { project: project ? withoutHome(project, input.home) : null, servers: [...scope.servers].sort() } } : {}),
    period: { since: input.since, until: input.until },
    summary: {
      total: inPeriod.length,
      passed: count((outcome) => BUCKET[outcome] === "passed"),
      asked: count((outcome) => BUCKET[outcome] === "asked"),
      approvedByPerson: count((outcome) => outcome.startsWith("approved-")),
      refusedByPerson: count((outcome) => outcome === "refused-by-person"),
      waiting: count((outcome) => outcome === "waiting"),
      blocked: blocked.length,
      signedByPhone: decided.filter((entry) => entry.phone).length,
    },
    outcomes,
    agents: [...agents].map(([agent, counts]) => ({ agent, ...counts })).sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent)),
    rules: [...rules].map(([rule, counts]) => ({ rule, ...counts })).sort((a, b) => b.blocked + b.asked - (a.blocked + a.asked) || a.rule.localeCompare(b.rule)),
    saves: input.countsOnly
      ? null
      : blocked.slice(0, max).map((entry) => ({ at: entry.at, agent: entry.agent, what: clean(entry.action), rule: ruleOf(entry, clean), impact: entry.impact ?? null, ref: entry.ref, todo: plainStep(entry.action, entry.target).todo })),
    savesTruncated: input.countsOnly ? 0 : Math.max(0, blocked.length - max),
    decisions: input.countsOnly
      ? null
      : decided.slice(0, MAX_REPORT_DECISIONS).map((entry) => ({ at: entry.at, agent: entry.agent, what: clean(entry.action), outcome: entry.outcome, outcomeLabel: OUTCOME_LABEL[entry.outcome], ref: entry.ref, approval: entry.phone ?? null, todo: plainStep(entry.action, entry.target).todo })),
    decisionsTruncated: input.countsOnly ? 0 : Math.max(0, decided.length - MAX_REPORT_DECISIONS),
    /* Seulement pour un client (un dossier, des serveurs) : tout ce qui s'est fait chez lui, en mots simples. */
    ...(scope && !input.countsOnly ? stepsOf(inPeriod, clean) : {}),
    coverage: { recordStarts: first, partial: input.partial },
    evidence: {
      receipts: { chain: "Receipts of the actions that went through Oathrion", intact: input.receipts.ok, entries: input.receipts.entries, head: input.receipts.head },
      journal: { chain: "Claude Code journal kept by Oathrion's hook", intact: input.journal.ok, entries: input.journal.entries, head: input.journal.head },
      intact: input.receipts.ok && input.journal.ok,
    },
    limits: [
      "Only the agents protected by Oathrion on this machine: what went through Oathrion, and what Claude Code ran through Oathrion's hook. Actions outside Oathrion are not in it.",
      ...(scope
        ? [
            `Only this scope: ${project ? "what Claude Code did in the project folder (written .)" : "no project folder"}${scope.servers.length > 0 ? `, and the MCP servers ${[...scope.servers].sort().join(", ")}` : ", and no MCP server"}. Other work on this machine is left out.`,
          ]
        : []),
      "A decision signed on a phone carries that phone's own signature: it proves a paired phone gave this answer to the text it showed, not who held the phone. Other decisions carry no phone signature: made on this computer, or before the phone signed its answers.",
      "It is what Oathrion recorded, signed by this machine's key: the fingerprint names the key, not the person or the team. The subject is declared by whoever issued the report.",
      input.countsOnly ? "Counts only: no command is in this report." : "Secrets recognisable in commands are redacted before signing; the home folder is written ~.",
      ...(input.partial ? ["Oathrion could not read its whole record for this period: the counts may be lower than what happened."] : []),
    ],
  };
}
