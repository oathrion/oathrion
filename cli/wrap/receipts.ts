/**
 * `oathrion receipts verify [--name <nom>]` — vérifier la chaîne de reçus d'un ou de tous les
 * Oathrion locaux (`~/.oathrion/<nom>/oathrion.db`).
 *
 * La vérification est COMPLÈTE (toute la chaîne est relue) et faite par le paquet local en
 * lecture seule (`server/local-verify.ts`) : elle marche que `oathrion wrap` tourne ou non.
 *
 * Codes de sortie : 0 toutes les chaînes sont intactes · 1 au moins une est rompue ou a un
 * trou · 3 usage, ou aucun Oathrion local · 4 la vérification n'a pas pu s'exécuter.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { BUNDLE_TYPE, PASSPORT_TYPE, REPORT_TYPE, extractShared, verifyShared, type SharedReceipt, type Signed } from "@shared/receipt-share";

import type { BundleStatement } from "../../server/local-bundle";
import type { PassportStatement } from "../../server/local-passport";
import type { ReportStatement } from "../../server/local-report";

import { bundleLines, bundleMarkdown, bundleVerdict, noReceiptMarkdown, runGit, type Git } from "./bundle";
import { journalPath, verifyJournal } from "./claude-journal";
import { HUB_DIRNAME } from "./hub";
import { localBundle, stateRoot } from "./launch";
import { nameProblem } from "./name";
import { passportLines } from "./passport";
import { reportLines } from "./report";

interface Verdict {
  ok: boolean;
  entries: number;
  headHash: string | null;
  brokenAt: number | null;
  reason: string | null;
  lastExecutedAt: string | null;
  consumedWithoutReceipt: number;
}

export const RECEIPTS_USAGE = `
oathrion receipts verify [--name <name>]

  Re-reads the whole receipt chain of a local Oathrion (all of them, without --name) and
  says whether it is intact. Changing, deleting or reordering a receipt breaks it.
`;

export function runReceipts(argv: readonly string[], env: NodeJS.ProcessEnv, out: (l: string) => void, err: (l: string) => void): number {
  if (argv[0] !== "verify") {
    err(RECEIPTS_USAGE);
    return 3;
  }
  let name: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--name") name = argv[++i];
    else {
      err(`Unknown option: ${String(argv[i])}.${RECEIPTS_USAGE}`);
      return 3;
    }
  }
  if (name !== undefined && nameProblem(name)) {
    err(`--name refused: ${String(nameProblem(name))}`);
    return 3;
  }

  const root = stateRoot(env);
  /*
   * Le pivot local tient UNE chaîne pour tous ses serveurs (`_local/oathrion.db`) ; les anciens
   * dossiers par serveur gardent la leur et restent vérifiés. `--name` désigne un serveur : son
   * ancien dossier s'il en a un, ET le pivot, s'il le connaît.
   *
   * Les DEUX, et c'est une correction. La première version prenait l'ancien dossier dès qu'il
   * existait. Chez qui avait installé la préversion d'avant le pivot, `--name notes` relisait
   * donc la chaîne figée du 28 octobre, intacte, et taisait celle où s'écrivent les actions
   * d'aujourd'hui : un « chain intact » vrai, sur la mauvaise chaîne.
   */
  const hubKnows = (server: string) => existsSync(join(root, HUB_DIRNAME, "serveurs", server)) && existsSync(join(root, HUB_DIRNAME, "oathrion.db"));
  const names = name
    ? [
        ...(hubKnows(name) ? [HUB_DIRNAME] : []),
        ...(existsSync(join(root, name, "oathrion.db")) ? [name] : []),
      ]
    : existsSync(root)
      ? readdirSync(root).filter((entry) => existsSync(join(root, entry, "oathrion.db"))).sort()
      : [];
  /* Le journal des actions de Claude Code (son hook) : vérifié avec le reste, nommé à part. */
  const journal = name === undefined && existsSync(journalPath(env)) ? journalPath(env) : null;
  if (names.length === 0 && journal === null) {
    err(`No local Oathrion${name ? ` named "${name}"` : ""} in ${root}.`);
    return 3;
  }

  /* À côté du pivot, un dossier par serveur est un reste d'avant lui : le dire, pour qu'on ne lise pas sa date comme la dernière action. */
  const withHub = names.includes(HUB_DIRNAME);
  let worst = 0;
  for (const entry of names) {
    const dir = join(root, entry);
    const server = entry === HUB_DIRNAME ? "local hub (all servers)" : withHub ? `${entry} (older folder, from before the local hub)` : entry;
    const run = spawnSync(process.execPath, [localBundle(env), "--verify-receipts"], {
      cwd: dir,
      env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "", OATHRION_DB: join(dir, "oathrion.db") },
      encoding: "utf8",
      timeout: 600_000,
    });
    const last = (run.stdout ?? "").trim().split("\n").pop() ?? "";
    let verdict: Verdict | null = null;
    try {
      verdict = JSON.parse(last) as Verdict;
    } catch {
      verdict = null;
    }
    if (!verdict || typeof verdict.ok !== "boolean") {
      err(`✗ ${server} — the verification could not run. ${(run.stderr ?? "").trim().split("\n").slice(-3).join(" ")}`);
      worst = Math.max(worst, 4);
      continue;
    }
    if (verdict.ok) {
      out(
        `✓ ${server} — chain intact: ${String(verdict.entries)} receipt(s)` +
          (verdict.lastExecutedAt ? `, last action on ${verdict.lastExecutedAt}` : "") +
          (verdict.headHash ? `, head ${verdict.headHash.slice(0, 16)}…` : ""),
      );
    } else {
      out(
        `✗ ${server} — BROKEN: ${verdict.reason ?? "unknown reason"}` +
          (verdict.brokenAt !== null ? ` (receipt #${String(verdict.brokenAt + 1)} of ${String(verdict.entries)})` : ""),
      );
      worst = Math.max(worst, 1);
    }
  }
  if (journal !== null) {
    const verdict = verifyJournal(journal);
    if (verdict.ok) {
      out(`✓ Claude Code's own actions (journal, not receipts) — chain intact: ${String(verdict.entries)} line(s)` + (verdict.last ? `, last on ${verdict.last}` : ""));
    } else {
      out(`✗ Claude Code's own actions (journal) — BROKEN: ${verdict.reason ?? "unknown reason"}`);
      worst = Math.max(worst, 1);
    }
  }
  return worst;
}

export const RECEIPT_USAGE = `
oathrion receipt bundle [--base <ref>]          sign what Claude Code did on this branch, for the PR
oathrion receipt report [--days <n>]            sign what your agents did over a period, to give on request
oathrion receipt passport [--agent <name>]      sign an agent's passport: who it is, what it may do, what it did
oathrion receipt verify <file|folder>... [--github] [--require]

  Checks receipts, branch receipts, reports and passports someone shared with you (the .html
  file, or the JSON), offline and without trusting the page: the signature, and the fingerprint
  that signed.
  --github   in a GitHub Action: writes the pull request's summary, says which commits the
             receipt does not cover, and accepts only OATHRION_TRUSTED_FINGERPRINTS if set.
  --require  fail when there is no receipt at all.
`;

/** Les fichiers à vérifier : ceux nommés, et les .json/.html des dossiers nommés. */
function receiptFiles(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    /* Un dossier absent (`.oathrion/receipts` d'une PR sans reçu) : aucun reçu, pas une erreur. */
    if (!existsSync(path)) return /\.(json|html)$/.test(path) ? [path] : [];
    if (statSync(path).isDirectory()) return readdirSync(path).filter((name) => /\.(json|html)$/.test(name)).sort().map((name) => join(path, name));
    return [path];
  });
}

export interface ReceiptContext {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  git?: Git;
}

/** `oathrion receipt verify <fichier|dossier>…` — vérifier des reçus et des paquets partagés, sans réseau et sans le vérificateur de la page. */
export function runReceipt(argv: readonly string[], out: (l: string) => void, err: (l: string) => void, context: ReceiptContext = {}): number {
  const github = argv.includes("--github");
  const require = argv.includes("--require");
  const paths = argv.slice(1).filter((arg) => arg !== "--github" && arg !== "--require");
  if (argv[0] !== "verify" || paths.length === 0) {
    err(RECEIPT_USAGE);
    return 3;
  }
  const env = context.env ?? process.env;
  const trusted = (env.OATHRION_TRUSTED_FINGERPRINTS ?? "")
    .split(",")
    .map((value) => value.replace(/\s+/g, "").toLowerCase())
    .filter(Boolean);
  const files = receiptFiles(paths);
  const reports: string[] = [];
  let code = 0;
  if (files.length === 0) {
    out(github ? "No Oathrion receipt in this pull request." : "No receipt found.");
    if (github) reports.push(noReceiptMarkdown(require));
    code = require ? 1 : 0;
  }
  for (const [index, file] of files.entries()) {
    if (files.length > 1) out(`${index > 0 ? "\n" : ""}${file}`);
    let shared: unknown;
    try {
      shared = extractShared(readFileSync(file, "utf8"));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      err(missing ? `No file here: ${file}. Download a receipt from the console first (Activity → Receipt).` : `This file cannot be read as an Oathrion receipt: ${error instanceof Error ? error.message : String(error)}`);
      code = Math.max(code, 3);
      continue;
    }
    const check = verifyShared(shared);
    const statement = (shared as { statement?: { type?: string } }).statement;
    if (statement?.type === BUNDLE_TYPE) {
      const bundle = shared as Signed<BundleStatement>;
      const pinned = trusted.length === 0 ? null : check.ok && trusted.includes(check.fingerprint.replace(/\s+/g, "").toLowerCase());
      const coverage = github && check.ok ? commitsAfter(bundle.statement.scope.head, context) : null;
      const verdict = bundleVerdict(check, pinned, coverage);
      for (const line of bundleLines(bundle, check, verdict)) out(line);
      if (github) reports.push(bundleMarkdown(bundle, check, verdict, pinned, coverage, file));
      if (!verdict.ok) code = Math.max(code, 1);
      continue;
    }
    if (statement?.type === REPORT_TYPE || statement?.type === PASSPORT_TYPE) {
      const pinned = trusted.length === 0 ? null : check.ok && trusted.includes(check.fingerprint.replace(/\s+/g, "").toLowerCase());
      const lines = statement.type === REPORT_TYPE ? reportLines(shared as Signed<ReportStatement>, check, pinned) : passportLines(shared as Signed<PassportStatement>, check, pinned);
      for (const line of lines) out(line);
      if (!check.ok || pinned === false) code = Math.max(code, 1);
      continue;
    }
    if (!check.ok) {
      out(`✗ NOT VALID: ${check.reason}.`);
      code = Math.max(code, 1);
      continue;
    }
    const { action, issuer, issuedAt } = (shared as SharedReceipt).statement;
    out("✓ Verified: not a single character has changed since this receipt was signed.");
    out(`  ${action.agent} · ${action.what}`);
    out(`  ${action.outcomeLabel}${action.impact ? ` — would have deleted ${action.impact}` : ""} · ${action.at}`);
    out(`  Signed by ${issuer.name} on ${issuedAt}`);
    out(`  Fingerprint: ${check.fingerprint}`);
  }
  if (github && env.GITHUB_STEP_SUMMARY && reports.length > 0) appendFileSync(env.GITHUB_STEP_SUMMARY, `${reports.join("\n\n")}\n`);
  if (files.length > 0) out("Compare the fingerprint with the one the sender published: it names who signed.");
  return code;
}

/** Les commits de la PR que le paquet ne couvre pas (arrivés après lui), ou null sans git. */
function commitsAfter(head: string | null, context: ReceiptContext): { after: number; ancestor: boolean } | null {
  if (!head) return null;
  const git = context.git ?? runGit;
  const cwd = context.cwd ?? process.cwd();
  if (git(["cat-file", "-e", `${head}^{commit}`], cwd).code !== 0) return { after: 0, ancestor: false };
  const ancestor = git(["merge-base", "--is-ancestor", head, "HEAD"], cwd).code === 0;
  /* Le commit qui ajoute le reçu lui-même ne compte pas : seuls ceux qui changent autre chose. */
  const count = Number(git(["rev-list", "--count", `${head}..HEAD`, "--", ".", ":(exclude).oathrion/receipts"], cwd).out);
  return { after: Number.isFinite(count) ? count : 0, ancestor };
}
