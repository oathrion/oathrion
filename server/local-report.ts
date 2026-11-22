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
import { REPORT_TYPE, type SignedDocument } from "@shared/receipt-share";
import { redactSecrets } from "@shared/secrets";

import type { ActivityEntry, ActivityOutcome } from "./local-activity";
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
}

export interface ReportStatement extends SignedDocument {
  type: typeof REPORT_TYPE;
  /** Pour qui le rapport est émis, tel que la personne l'a écrit (`--for`) : déclaré, pas prouvé. */
  subject: string | null;
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
}): ReportStatement {
  const clean = (text: string) => redactSecrets(withoutHome(text, input.home));
  const inPeriod = input.entries.filter((entry) => entry.at >= input.since && entry.at <= input.until);
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
  const first = input.entries.reduce<string | null>((earliest, entry) => (earliest === null || entry.at < earliest ? entry.at : earliest), null);
  return {
    type: REPORT_TYPE,
    issuedAt: input.issuedAt,
    issuer: input.issuer,
    subject: input.subject,
    period: { since: input.since, until: input.until },
    summary: {
      total: inPeriod.length,
      passed: count((outcome) => BUCKET[outcome] === "passed"),
      asked: count((outcome) => BUCKET[outcome] === "asked"),
      approvedByPerson: count((outcome) => outcome.startsWith("approved-")),
      refusedByPerson: count((outcome) => outcome === "refused-by-person"),
      waiting: count((outcome) => outcome === "waiting"),
      blocked: blocked.length,
    },
    outcomes,
    agents: [...agents].map(([agent, counts]) => ({ agent, ...counts })).sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent)),
    rules: [...rules].map(([rule, counts]) => ({ rule, ...counts })).sort((a, b) => b.blocked + b.asked - (a.blocked + a.asked) || a.rule.localeCompare(b.rule)),
    saves: input.countsOnly
      ? null
      : blocked.slice(0, max).map((entry) => ({ at: entry.at, agent: entry.agent, what: clean(entry.action), rule: ruleOf(entry, clean), impact: entry.impact ?? null, ref: entry.ref })),
    savesTruncated: input.countsOnly ? 0 : Math.max(0, blocked.length - max),
    coverage: { recordStarts: first, partial: input.partial },
    evidence: {
      receipts: { chain: "Receipts of the actions that went through Oathrion", intact: input.receipts.ok, entries: input.receipts.entries, head: input.receipts.head },
      journal: { chain: "Claude Code journal kept by Oathrion's hook", intact: input.journal.ok, entries: input.journal.entries, head: input.journal.head },
      intact: input.receipts.ok && input.journal.ok,
    },
    limits: [
      "Only the agents protected by Oathrion on this machine: what went through Oathrion, and what Claude Code ran through Oathrion's hook. Actions outside Oathrion are not in it.",
      "It is what Oathrion recorded, signed by this machine's key: the fingerprint names the key, not the person or the team. The subject is declared by whoever issued the report.",
      input.countsOnly ? "Counts only: no command is in this report." : "Secrets recognisable in commands are redacted before signing; the home folder is written ~.",
      ...(input.partial ? ["Oathrion could not read its whole record for this period: the counts may be lower than what happened."] : []),
    ],
  };
}
