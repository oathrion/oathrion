/**
 * Le journal des actions de Claude Code : ce que son hook a jugé, et ce qui s'est passé ensuite.
 *
 * SÉPARÉ DES REÇUS D'OATHRION, et c'est voulu (décision du 5 novembre). La chaîne de reçus prouve
 * ce qu'Oathrion a lui-même exécuté. Ici, c'est Claude Code qui exécute, et il peut encore
 * refuser après le hook : ces lignes disent « Claude Code a demandé, Oathrion a jugé, Claude
 * Code a fait », jamais « Oathrion a fait ».
 *
 *   · un fichier JSON Lines, `~/.oathrion/_local/claude-code/journal.jsonl` (0600) ;
 *   · chaque ligne porte l'empreinte de la précédente : modifier, retirer ou réordonner une ligne
 *     casse la chaîne, et `oathrion receipts verify` le dit ;
 *   · JAMAIS le contenu d'un fichier ni la sortie d'une commande : une empreinte SHA-256 et une
 *     taille. La commande elle-même est gardée (c'est l'action), coupée à 1 000 caractères ;
 *   · plusieurs outils peuvent finir en même temps : un verrou (création exclusive) protège
 *     l'ajout. S'il ne peut être pris, la ligne n'est pas écrite plutôt que de casser la chaîne.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { HUB_DIRNAME } from "./hub";
import { stateRoot } from "./launch";

export interface JournalRecord {
  phase: "pre" | "post";
  session: string | null;
  toolUseId: string | null;
  tool: string;
  action: string;
  target: string;
  /** Avant l'outil : le verdict d'Oathrion (`none` : rien à redire, Claude Code décide). */
  verdict?: "deny" | "ask" | "none" | "allow";
  /** En mode automatique : ce qu'a répondu la personne interrogée DANS Oathrion. */
  person?: "approved" | "rejected" | "expired" | "pending" | "unreachable";
  rule?: string | null;
  /** Le mode de Claude Code (`default`, `auto`…) : une question n'est posée que s'il y a quelqu'un. */
  mode?: string;
  command?: string;
  /** L'empreinte de ce qui est écrit, jamais le contenu. */
  digest?: string;
  size?: number;
  /** Après l'outil : ce que Claude Code rapporte, sans la sortie. */
  outcome?: Record<string, unknown>;
  /** Une lecture de contenu non fiable (« WebFetch example.com ») : la session est marquée. */
  untrusted?: string;
  /** Une suppression refusée : ce qu'elle aurait effacé (`cli/wrap/impact.ts`). */
  impact?: { files: number; bytes: number; truncated: boolean };
}

export interface JournalEntry extends JournalRecord {
  seq: number;
  at: string;
  prev: string | null;
  hash: string;
}

export const journalDir = (env: NodeJS.ProcessEnv) => join(stateRoot(env), HUB_DIRNAME, "claude-code");
export const journalPath = (env: NodeJS.ProcessEnv) => join(journalDir(env), "journal.jsonl");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** L'empreinte d'une ligne : celle de la précédente, puis la ligne sans son propre `hash`. */
export function entryHash(entry: Omit<JournalEntry, "hash">): string {
  return sha256(`${entry.prev ?? ""}\n${JSON.stringify(entry)}`);
}

export const digestOf = (text: string) => `sha256:${sha256(text)}`;

/** La dernière ligne du fichier, sans le relire en entier. */
function lastLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    let window = Math.min(size, 8_192);
    for (;;) {
      const buffer = Buffer.alloc(window);
      readSync(fd, buffer, 0, window, size - window);
      const lines = buffer.toString("utf8").split("\n").filter((l) => l.trim() !== "");
      if (lines.length > 1 || window === size) return lines[lines.length - 1] ?? null;
      window = Math.min(size, window * 4);
    }
  } finally {
    closeSync(fd);
  }
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Ajoute une ligne chaînée. Rend `false` si le verrou n'a pas pu être pris. */
export function appendJournal(env: NodeJS.ProcessEnv, record: JournalRecord, now: Date = new Date()): boolean {
  const dir = journalDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = journalPath(env);
  const lock = `${path}.lock`;
  let fd: number | null = null;
  for (let attempt = 0; attempt < 200 && fd === null; attempt += 1) {
    try {
      fd = openSync(lock, "wx");
    } catch {
      /* Un verrou de plus de 5 s est celui d'un processus mort : on le retire. */
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5_000) unlinkSync(lock);
      } catch {
        /* déjà retiré */
      }
      pause(10);
    }
  }
  if (fd === null) return false;
  try {
    const last = lastLine(path);
    const previous = last ? (JSON.parse(last) as JournalEntry) : null;
    const body: Omit<JournalEntry, "hash"> = { seq: (previous?.seq ?? 0) + 1, at: now.toISOString(), ...record, prev: previous?.hash ?? null };
    const entry: JournalEntry = { ...body, hash: entryHash(body) };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

export interface JournalVerdict {
  ok: boolean;
  entries: number;
  brokenAt: number | null;
  reason: string | null;
  last: string | null;
}

/** Relit toute la chaîne. */
export function verifyJournal(path: string): JournalVerdict {
  if (!existsSync(path)) return { ok: true, entries: 0, brokenAt: null, reason: null, last: null };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  let prev: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(lines[i]!) as JournalEntry;
    } catch {
      return { ok: false, entries: lines.length, brokenAt: i, reason: "a line is not readable JSON", last: null };
    }
    const { hash, ...body } = entry;
    if (entry.seq !== i + 1) return { ok: false, entries: lines.length, brokenAt: i, reason: `line ${String(i + 1)} carries number ${String(entry.seq)}: a line was removed or moved`, last: null };
    if (entry.prev !== prev) return { ok: false, entries: lines.length, brokenAt: i, reason: `line ${String(i + 1)} does not follow the previous one`, last: null };
    if (entryHash(body) !== hash) return { ok: false, entries: lines.length, brokenAt: i, reason: `line ${String(i + 1)} was changed after it was written`, last: null };
    prev = hash;
  }
  const lastEntry = lines.length > 0 ? (JSON.parse(lines[lines.length - 1]!) as JournalEntry) : null;
  return { ok: true, entries: lines.length, brokenAt: null, reason: null, last: lastEntry?.at ?? null };
}
