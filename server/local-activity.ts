/**
 * LA CHRONOLOGIE UNIQUE : tout ce que les agents ont fait, sur un seul fil.
 *
 * Deux sources, qui ne prouvent pas la même chose et restent nommées comme telles :
 *
 *   · `oathrion` — les exécutions passées PAR Oathrion (serveurs MCP enveloppés) : la décision,
 *     l'approbation éventuelle, l'issue de l'outil. Leurs reçus forment la chaîne d'Oathrion ;
 *   · `claude-code` — le journal du hook (`cli/wrap/claude-journal.ts`) : ce que Claude Code a
 *     exécuté LUI-MÊME (shell, écritures), ce qu'Oathrion en a jugé, et la réponse de la personne.
 *
 * Les demandes `mcp.claude-code.*` (le passage de relais du hook) ne sont pas répétées : la
 * ligne du journal porte déjà la réponse de la personne.
 *
 * Fonctions pures : la route (`/api/local/activity`) leur passe les exécutions et les lignes.
 */

import type { Execution } from "@shared/types";

import type { JournalEntry } from "../cli/wrap/claude-journal";
import { describeImpact } from "../cli/wrap/impact";

export type ActivityOutcome =
  | "done"
  | "failed"
  | "refused"
  | "waiting"
  | "asked-done"
  | "asked-failed"
  | "asked-not-run"
  | "approved-done"
  | "approved-failed"
  | "refused-by-person"
  | "approved-not-run"
  | "not-run"
  | "running";

export interface ActivityEntry {
  at: string;
  source: "oathrion" | "claude-code";
  agent: string;
  /** Ce que l'agent a fait, lisible : la commande, « write <chemin> », ou le verbe MCP. */
  action: string;
  target: string;
  outcome: ActivityOutcome;
  /** La règle ou la raison, quand il y en a une. */
  detail: string | null;
  /** L'exécution (`exe_…`) ou l'appel d'outil (`toolu_…`). */
  ref: string;
  /** Une suppression refusée : ce qu'elle aurait effacé (« 48,312 files (3.2 GB) »). */
  impact?: string;
}

const HANDOFF_PREFIX = "mcp.claude-code.";

export function fromExecution(execution: Execution): ActivityEntry | null {
  if (execution.action.startsWith(HANDOFF_PREFIX)) return null;
  const run = execution.runState;
  /*
   * RETENUE POUR UNE PERSONNE : après sa réponse, la décision devient `allow` ou `block` et le
   * lien vers l'approbation peut être vide (vu sur une vraie base, le 5 novembre) ; l'historique
   * de l'exécution, lui, garde « Approval requested », puis « granted » ou « rejected ».
   */
  const events = new Set((execution.audit ?? []).map((entry) => entry.event));
  const held = execution.decision === "require_approval" || Boolean(execution.approvalId) || events.has("Approval requested");
  let outcome: ActivityOutcome;
  if (events.has("Approval rejected")) outcome = "refused-by-person";
  else if (held && execution.status === "pending") outcome = "waiting";
  else if (held && (execution.status === "blocked" || execution.decision === "block")) outcome = "refused-by-person";
  else if (execution.decision === "block") outcome = "refused";
  else if (run === "failed" || execution.status === "failed") outcome = held ? "approved-failed" : "failed";
  else if (run === "succeeded") outcome = held ? "approved-done" : "done";
  else if (run === "pending" || run === "running") outcome = "running";
  else outcome = held ? "approved-done" : "done";
  return {
    at: execution.timestamp,
    source: "oathrion",
    agent: execution.agentName,
    action: execution.action,
    target: execution.target,
    outcome,
    detail: outcome === "done" ? null : execution.decisionReason || null,
    ref: execution.id,
  };
}

/** Ce qu'est devenue la demande faite à une personne pour une commande du hook (mode automatique). */
export type HandoffAnswer = (target: string, command: string | undefined) => "approved" | "rejected" | "pending" | null;

/** Les demandes `mcp.claude-code.*` : la dernière réponse de la personne, par cible et commande. */
export function handoffAnswers(executions: readonly Execution[]): HandoffAnswer {
  const answers = new Map<string, "approved" | "rejected" | "pending">();
  const sorted = [...executions].filter((e) => e.action.startsWith(HANDOFF_PREFIX)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const execution of sorted) {
    const events = new Set((execution.audit ?? []).map((entry) => entry.event));
    const command = typeof execution.input?.command === "string" ? execution.input.command : "";
    answers.set(`${execution.target}\n${command}`, events.has("Approval rejected") ? "rejected" : events.has("Approval granted") || execution.decision === "allow" ? "approved" : "pending");
  }
  return (target, command) => answers.get(`${target}\n${command ?? ""}`) ?? null;
}

/** Réunit les lignes « avant » et « après » d'un même appel d'outil. */
export function fromJournal(lines: readonly JournalEntry[], answer: HandoffAnswer = () => null): ActivityEntry[] {
  const calls = new Map<string, { pre?: JournalEntry; post?: JournalEntry }>();
  lines.forEach((line, index) => {
    const key = line.toolUseId ?? `ligne-${String(index)}`;
    const call = calls.get(key) ?? {};
    if (line.phase === "pre") call.pre = line;
    else call.post = line;
    calls.set(key, call);
  });
  const entries: ActivityEntry[] = [];
  for (const [ref, { pre, post }] of calls) {
    const first = pre ?? post!;
    const failed = post?.outcome?.failed === true;
    const ran = post !== undefined && !failed;
    const verdict = pre?.verdict ?? "none";
    let outcome: ActivityOutcome;
    /*
     * Envoyée à une personne (mode automatique) sans réponse à temps : la ligne du journal ne
     * connaît que ce moment-là ; la demande du pivot connaît la suite.
     */
    const later = pre?.person === "pending" ? answer(first.target, first.command) : null;
    if (pre?.person === "pending") outcome = later === "approved" ? "approved-not-run" : later === "rejected" ? "refused-by-person" : "waiting";
    else if (verdict === "deny") outcome = pre?.person === "rejected" ? "refused-by-person" : "refused";
    else if (verdict === "allow") outcome = failed ? "approved-failed" : ran ? "approved-done" : "not-run";
    else if (verdict === "ask") outcome = failed ? "asked-failed" : ran ? "asked-done" : "asked-not-run";
    else outcome = failed ? "failed" : ran ? "done" : "not-run";

    const kind = typeof post?.outcome?.kind === "string" ? post.outcome.kind : null;
    const action =
      first.command ??
      (first.untrusted ? `read untrusted content: ${first.untrusted}` : `${kind === "created" ? "create" : kind === "replaced" ? "replace" : "write"} ${first.target.replace(/^file:\/\//, "")}`);
    const exitCode = typeof post?.outcome?.exitCode === "number" ? `exit code ${String(post.outcome.exitCode)}` : null;
    entries.push({
      at: first.at,
      source: "claude-code",
      agent: "Claude Code",
      action,
      target: first.target,
      outcome,
      detail:
        [pre?.rule ? `rule ${pre.rule}` : null, pre?.person ? `person: ${pre.person}` : null, pre?.mode && pre.mode !== "default" ? `mode ${pre.mode}` : null, exitCode].filter(Boolean).join(" · ") ||
        (first.untrusted ? "the session is now marked: what it sends out next asks a person" : null),
      ref,
      ...(pre?.impact ? { impact: describeImpact(pre.impact) } : {}),
    });
  }
  return entries;
}

/** Le fil complet, du plus récent au plus ancien. */
export function timeline(executions: readonly Execution[], journal: readonly JournalEntry[], options: { agent?: string; limit?: number } = {}): ActivityEntry[] {
  const all = [...executions.map(fromExecution).filter((e): e is ActivityEntry => e !== null), ...fromJournal(journal, handoffAnswers(executions))];
  const filtered = options.agent ? all.filter((entry) => entry.agent === options.agent) : all;
  return filtered.sort((a, b) => b.at.localeCompare(a.at)).slice(0, options.limit ?? 300);
}
