/**
 * LE PAQUET DE REÇUS D'UNE BRANCHE — « No receipt, no merge » (`notes/CONCEPTION-RECU-PR.md`).
 *
 * Ce qu'un agent a fait DANS un dépôt, depuis le point de départ d'une branche : chaque action,
 * l'issue, la règle, la réponse d'une personne, les empreintes de ses lignes dans le journal
 * chaîné ; le résumé ; l'état de la chaîne. Signé (`shared/receipt-share.ts`), il se vérifie
 * sans Oathrion : c'est ce qu'une GitHub Action lit dans la pull request.
 *
 * Il finit dans un dépôt, parfois public : il ne doit RIEN divulguer d'autre.
 *   · seulement les actions de CE dépôt (le journal du hook, dont les cibles nomment le dépôt) ;
 *     pas les actions MCP, qui ne sont rattachées à aucun dépôt ;
 *   · pas de chemin personnel : le dépôt devient « . », le dossier personnel « ~ » ;
 *   · pas de secret reconnaissable dans une commande, masqué AVANT la signature.
 *
 * Fonctions pures : l'opération `bundle` du pivot leur passe le journal et la clé.
 */
import type { PhoneApproval } from "@shared/phone-approval";
import { BUNDLE_TYPE, type SignedDocument } from "@shared/receipt-share";

import type { JournalEntry } from "../cli/wrap/claude-journal";
import { fromJournal, withPhoneApprovals, type HandoffAnswer, type HandoffDecision } from "./local-activity";
import { OUTCOME_LABEL } from "./local-receipt";
import { summarize, type ChainVerdict } from "./local-summary";

export interface BundleScope {
  /** « owner/repo », lu de l'adresse du dépôt distant (sans identifiants), ou null. */
  repository: string | null;
  branch: string | null;
  /** Le commit d'où part la branche, et le dernier commit au moment du paquet. */
  base: string | null;
  head: string | null;
  since: string;
  until: string;
}

export interface BundleAction {
  at: string;
  agent: string;
  what: string;
  outcome: string;
  outcomeLabel: string;
  detail: string | null;
  impact: string | null;
  ref: string;
  /** Les lignes de cette action dans le journal chaîné : position et empreinte. */
  entries: { seq: number; hash: string }[];
  /** La réponse de la personne, signée par son téléphone (`shared/phone-approval.ts`). */
  approval?: PhoneApproval;
}

export interface BundleStatement extends SignedDocument {
  type: typeof BUNDLE_TYPE;
  scope: BundleScope;
  summary: { total: number; passed: number; asked: number; blocked: number; refusedByPerson: number; waiting: number; signedByPhone?: number };
  actions: BundleAction[];
  /** Plus d'actions que le paquet n'en garde : il le dit. */
  truncated: number;
  evidence: { chain: string; intact: boolean; entries: number; head: string | null };
  /** Ce que le paquet ne couvre pas : dit dans le paquet même. */
  limits: string[];
}

/* Les secrets reconnaissables à leur forme : une définition commune (`shared/secrets.ts`). */
export { redactSecrets } from "@shared/secrets";
import { redactSecrets } from "@shared/secrets";

/** Le dépôt devient « . », le dossier personnel « ~ » : aucun chemin de la machine ne sort. */
export function relativize(text: string, project: string, home: string): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = text.replace(new RegExp(`file://${escape(project)}(?=/|$)`, "g"), ".").replace(new RegExp(`${escape(project)}(?=/|\\b|$)`, "g"), ".");
  if (home && home !== "/") out = out.replace(new RegExp(`${escape(home)}(?=/|\\b|$)`, "g"), "~");
  return out;
}

/** Une ligne du journal appartient-elle à ce dépôt ? Sa cible le nomme. */
export function inProject(target: string, project: string): boolean {
  return target === `shell://${project}` || target.startsWith(`shell://${project}/`) || target.startsWith(`file://${project}/`);
}

export const MAX_BUNDLE_ACTIONS = 2_000;

export function bundleStatement(input: {
  lines: readonly JournalEntry[];
  project: string;
  home: string;
  scope: BundleScope;
  journal: ChainVerdict & { head: string | null };
  issuer: SignedDocument["issuer"];
  issuedAt: string;
  maxActions?: number;
  /** Les réponses des personnes (passage de relais du hook) et les accords signés par leur téléphone. */
  answers?: HandoffAnswer;
  decisions?: HandoffDecision;
  approvals?: ReadonlyMap<string, PhoneApproval>;
}): BundleStatement {
  const project = input.project.replace(/\/+$/, "");
  const lines = input.lines.filter((line) => inProject(line.target, project));
  const entries = withPhoneApprovals(fromJournal(lines, input.answers, input.decisions), input.approvals).filter((entry) => entry.at >= input.scope.since && entry.at <= input.scope.until);
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const max = input.maxActions ?? MAX_BUNDLE_ACTIONS;
  const hashes = new Map<string, { seq: number; hash: string }[]>();
  for (const line of lines) {
    if (!line.toolUseId) continue;
    hashes.set(line.toolUseId, [...(hashes.get(line.toolUseId) ?? []), { seq: line.seq, hash: line.hash }]);
  }
  const clean = (text: string) => redactSecrets(relativize(text, project, input.home));
  const summary = summarize(entries, { since: input.scope.since, until: input.scope.until, receipts: { ok: true, entries: 0, reason: null }, journal: input.journal });
  return {
    type: BUNDLE_TYPE,
    issuedAt: input.issuedAt,
    issuer: input.issuer,
    scope: input.scope,
    summary: {
      total: summary.total,
      passed: summary.passed,
      asked: summary.asked,
      blocked: summary.blocked,
      refusedByPerson: summary.refusedByPerson,
      waiting: summary.waiting,
      ...(input.approvals ? { signedByPhone: entries.filter((entry) => entry.phone).length } : {}),
    },
    actions: sorted.slice(-max).map((entry) => ({
      at: entry.at,
      agent: entry.agent,
      what: clean(entry.action),
      outcome: entry.outcome,
      outcomeLabel: OUTCOME_LABEL[entry.outcome],
      detail: entry.detail ? clean(entry.detail) : null,
      impact: entry.impact ?? null,
      ref: entry.ref,
      entries: hashes.get(entry.ref) ?? [],
      ...(entry.phone ? { approval: entry.phone } : {}),
    })),
    truncated: Math.max(0, sorted.length - max),
    evidence: { chain: "Claude Code journal kept by Oathrion's hook", intact: input.journal.ok, entries: input.journal.entries, head: input.journal.head },
    limits: [
      "Only what Claude Code did in this repository, through Oathrion's hook. Actions outside Oathrion are not in it.",
      "Secrets recognisable in commands are redacted before signing; paths are relative to the repository.",
    ],
  };
}
