/**
 * `oathrion receipt bundle` — « No receipt, no merge » (`notes/CONCEPTION-RECU-PR.md`).
 *
 * Dans un dépôt git : la portée de la branche (le dépôt, la branche, le commit d'où elle part,
 * le dernier commit), puis le paquet signé de ce que Claude Code y a fait, demandé au pivot
 * local (`bundle`). Il est écrit dans `.oathrion/receipts/<branche>.json` ; la personne le lit
 * et le committe elle-même. La GitHub Action d'Oathrion le vérifie dans la pull request.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { BundleStatement } from "../../server/local-bundle";
import type { ReceiptCheck, Signed } from "@shared/receipt-share";

import { ensureHub } from "./hub";

export const BUNDLE_USAGE = `
oathrion receipt bundle [--base <ref>] [--out <file>]

  In a git repository: signs what Claude Code did in it since this branch started, and writes
  it to .oathrion/receipts/<branch>.json, to commit with your branch. Oathrion's GitHub Action
  checks it in the pull request. --base: where the branch starts (default: origin/main,
  origin/master, main or master).
`;

export type Git = (args: string[], cwd: string) => { code: number; out: string };
export const runGit: Git = (args, cwd) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: result.status ?? 1, out: (result.stdout ?? "").trim() };
};

/** « owner/repo » depuis l'adresse du dépôt distant, sans jamais garder d'identifiant. */
export function repositoryOf(remote: string): string | null {
  const ssh = /^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?\/?$/.exec(remote);
  if (ssh) return ssh[1] === "github.com" ? ssh[2]! : `${ssh[1]!}/${ssh[2]!}`;
  try {
    const url = new URL(remote);
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
    if (!path) return null;
    return url.hostname === "github.com" ? path : `${url.hostname}/${path}`;
  } catch {
    return null;
  }
}

export interface BundleIo {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  git?: Git;
  /** Le pivot : son opération `bundle`. Par défaut, le pivot local (lancé s'il ne tourne pas). */
  hub?: () => Promise<{ op<T>(body: Record<string, unknown>): Promise<{ status: number; body: T | null }> }>;
  now?: () => Date;
}

export async function runBundle(argv: readonly string[], io: BundleIo): Promise<number> {
  let base: string | null = null;
  let outFile: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1]) base = argv[++i]!;
    else if (argv[i] === "--out" && argv[i + 1]) outFile = argv[++i]!;
    else {
      io.err(`Unknown option: ${String(argv[i])}.${BUNDLE_USAGE}`);
      return 3;
    }
  }
  const git = io.git ?? runGit;
  const root = git(["rev-parse", "--show-toplevel"], io.cwd);
  if (root.code !== 0 || !root.out) {
    io.err("Run this inside a git repository: the receipt covers what was done in it.");
    return 3;
  }
  const project = root.out;
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], project).out || null;
  const head = git(["rev-parse", "HEAD"], project).out || null;
  const candidates = base ? [base] : ["origin/main", "origin/master", "main", "master"];
  const baseRef = candidates.find((ref) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], project).code === 0);
  if (!baseRef) {
    io.err(`No base found (${candidates.join(", ")}). Name where this branch starts: --base <ref>.`);
    return 3;
  }
  const mergeBase = git(["merge-base", "HEAD", baseRef], project).out;
  const sinceRaw = mergeBase ? git(["show", "-s", "--format=%cI", mergeBase], project).out : "";
  const since = Number.isNaN(Date.parse(sinceRaw)) ? null : new Date(sinceRaw).toISOString();
  if (!mergeBase || !since) {
    io.err(`This branch shares no history with ${baseRef}. Name where it starts: --base <ref>.`);
    return 3;
  }
  const remote = git(["remote", "get-url", "origin"], project);
  const scope = {
    repository: remote.code === 0 ? repositoryOf(remote.out) : null,
    branch,
    base: mergeBase,
    head,
    since,
    until: (io.now?.() ?? new Date()).toISOString(),
  };

  let answer: { status: number; body: Signed<BundleStatement> | null };
  try {
    const hub = await (io.hub ?? (() => ensureHub(io.env)))();
    answer = await hub.op<Signed<BundleStatement>>({ op: "bundle", project, scope });
  } catch (error) {
    io.err(`The local Oathrion could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }
  if (answer.status !== 200 || !answer.body?.statement) {
    io.err(`The local Oathrion refused the receipt (${String(answer.status)}).`);
    return 4;
  }
  const { statement } = answer.body;
  const file = outFile ?? join(project, ".oathrion", "receipts", `${(branch ?? "HEAD").replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(answer.body, null, 2)}\n`);

  const { summary } = statement;
  io.out(`Oathrion receipt for ${branch ?? "this branch"}${scope.repository ? ` (${scope.repository})` : ""}, since ${baseRef}:`);
  io.out(`  ${String(summary.total)} action(s) by Claude Code in this repository · ${String(summary.passed)} went through · ${String(summary.asked)} asked a person · ${String(summary.blocked)} blocked`);
  for (const action of statement.actions.filter((a) => a.outcome === "refused").slice(-5)) {
    io.out(`  ✋ ${action.what}${action.impact ? ` — would have deleted ${action.impact}` : ""}`);
  }
  if (!statement.evidence.intact) io.out("  ⚠ The journal's chain is NOT intact: the check will say so.");
  if (summary.total === 0) io.out("  Nothing recorded yet for this branch: is Oathrion's hook installed (npx oathrion)?");
  io.out(`  Signed by ${statement.issuer.name} · fingerprint ${statement.issuer.fingerprint}`);
  io.out("");
  io.out(`Written to ${relative(io.cwd, file) || file}. Read it, then commit it with your branch:`);
  io.out(`  git add ${relative(project, file)} && git commit -m "Oathrion receipt"`);
  return 0;
}

/* ── La vérification d'un paquet : en ligne de commande, et dans la pull request ──────────── */

export interface BundleVerdict {
  ok: boolean;
  /** Ce qui fait échouer la vérification. */
  problems: string[];
  /** Ce qu'il faut savoir, sans échouer. */
  notes: string[];
}

/**
 * Le paquet passe si sa signature tient, si son empreinte est épinglée (quand une liste est
 * donnée), et si son dernier commit fait partie de la PR. Des commits arrivés APRÈS lui ne
 * sont pas couverts : c'est dit, sans échouer (version 0).
 */
export function bundleVerdict(check: ReceiptCheck, pinned: boolean | null, coverage: { after: number; ancestor: boolean } | null): BundleVerdict {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!check.ok) problems.push(check.reason);
  if (pinned === false) problems.push("it is signed by a fingerprint that is not in OATHRION_TRUSTED_FINGERPRINTS");
  if (coverage && !coverage.ancestor) problems.push("the commit it covers is not part of this pull request");
  if (coverage && coverage.ancestor && coverage.after > 0) notes.push(`${String(coverage.after)} commit(s) after the receipt are not covered by it`);
  if (pinned === null && check.ok) notes.push("the fingerprint is not pinned: set trusted-fingerprints to require yours");
  return { ok: problems.length === 0, problems, notes };
}

export function bundleLines(bundle: Signed<BundleStatement>, check: ReceiptCheck, verdict: BundleVerdict): string[] {
  const { statement } = bundle;
  const { summary, scope } = statement;
  const lines = [
    verdict.ok ? "✓ Verified branch receipt: not a single character has changed since it was signed." : `✗ NOT VALID: ${verdict.problems.join("; ")}.`,
    `  ${scope.branch ?? "branch"}${scope.repository ? ` · ${scope.repository}` : ""} · up to ${scope.head?.slice(0, 7) ?? "?"}`,
    `  ${String(summary.total)} action(s) by Claude Code · ${String(summary.passed)} went through · ${String(summary.asked)} asked a person · ${String(summary.blocked)} blocked`,
    ...statement.actions.filter((a) => a.outcome === "refused").slice(-5).map((a) => `  ✋ ${a.what}${a.impact ? ` — would have deleted ${a.impact}` : ""}`),
    ...(statement.evidence.intact ? [] : ["  ⚠ The journal's chain was not intact when this receipt was signed."]),
    ...(check.ok ? [`  Signed by ${statement.issuer.name} · fingerprint ${check.fingerprint}`] : []),
    ...verdict.notes.map((note) => `  Note: ${note}.`),
  ];
  return lines;
}

/** Un texte sûr dans un tableau Markdown, entre accents graves. */
const cell = (text: string) => text.replace(/`/g, "ʼ").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 160);

export function bundleMarkdown(
  bundle: Signed<BundleStatement>,
  check: ReceiptCheck,
  verdict: BundleVerdict,
  pinned: boolean | null,
  coverage: { after: number; ancestor: boolean } | null,
  file: string,
): string {
  const { statement } = bundle;
  const { summary, scope } = statement;
  const notable = statement.actions.filter((a) => a.outcome !== "done" && a.outcome !== "not-run").slice(-20);
  const icon = (outcome: string) => (outcome === "refused" || outcome === "refused-by-person" ? "✋" : outcome.includes("failed") ? "⚠️" : "🙋");
  return [
    `### ${verdict.ok ? "✅" : "❌"} Oathrion — no receipt, no merge`,
    "",
    ...(check.ok
      ? [`**${scope.branch ?? "This branch"}**${scope.repository ? ` · ${scope.repository}` : ""} · **${String(summary.total)}** action(s) by Claude Code: ${String(summary.passed)} went through · ${String(summary.asked)} asked a person · **${String(summary.blocked)} blocked**`, ""]
      : []),
    ...(verdict.ok ? [] : [`> **Not valid:** ${verdict.problems.join("; ")}.`, ""]),
    /* Un reçu altéré : son contenu n'est pas montré comme s'il était crédible. */
    ...(!check.ok
      ? ["Its content cannot be trusted, so it is not shown here.", ""]
      : notable.length > 0
      ? ["| | Action | Outcome |", "|---|---|---|", ...notable.map((a) => `| ${icon(a.outcome)} | \`${cell(a.what)}\` | ${cell(a.outcomeLabel)}${a.impact ? ` — would have deleted ${cell(a.impact)}` : ""}${a.detail ? ` · ${cell(a.detail)}` : ""} |`), ""]
      : ["Nothing was asked or blocked: every action stayed within the rules.", ""]),
    `Signed by ${statement.issuer.name} · \`${check.ok ? check.fingerprint : statement.issuer.fingerprint}\` ${pinned === true ? "· pinned ✓" : pinned === false ? "· **not trusted**" : "· not pinned"}  `,
    `Covers commits up to \`${scope.head?.slice(0, 7) ?? "?"}\`${coverage && coverage.after > 0 ? ` · **${String(coverage.after)} later commit(s) not covered**` : ""} · journal chain ${statement.evidence.intact ? "intact" : "**not intact**"} · \`${file}\``,
    "",
    `<sub>${statement.limits.map(cell).join(" ")}</sub>`,
  ].join("\n");
}

export function noReceiptMarkdown(required: boolean): string {
  return [
    `### ${required ? "❌" : "⚪"} Oathrion — no receipt in this pull request`,
    "",
    required
      ? "This repository asks for an Oathrion receipt with changes made by an AI agent. Run `oathrion receipt bundle` on your branch and commit the file it writes."
      : "No `.oathrion/receipts` file. If an AI agent worked on this branch, `oathrion receipt bundle` signs what it did.",
  ].join("\n");
}
