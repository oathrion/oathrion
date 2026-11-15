/**
 * LES JETONS DES SERVEURS PROTÉGÉS, DEVENUS DES PIÈGES (demandé par l'utilisateur le 10 novembre,
 * après l'essai réel : `cursor-agent`, ne trouvant pas un serveur, lisait sa configuration, y
 * trouvait le jeton, et voulait appeler le service directement — en contournant Oathrion).
 *
 * Quand `oathrion wrap` lance un serveur, il relève les jetons qu'on lui donne (les variables
 * d'environnement dont le nom dit « token », « key », « secret », « password », les en-têtes
 * d'autorisation, et ce qui en a la forme dans ses arguments) et n'en garde que l'EMPREINTE
 * (SHA-256), avec le nom du serveur — jamais le jeton lui-même. Si l'un d'eux apparaît ensuite
 * dans ce que l'agent fait hors de ce serveur (une commande, une écriture, l'appel d'un autre
 * outil), c'est qu'il passe à côté d'Oathrion : refusé, et dit (`claude-hook-rules.ts`, règle
 * `server-token` ; le relais MCP aussi).
 *
 * Ce que ça ne fait pas : le shell d'un client autre que Claude Code n'a pas de hook ; un jeton
 * transformé (encodé, découpé) n'est pas reconnu. L'agent enfermé (`oathrion jail`) ferme le reste.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { findSecrets } from "@shared/secrets";

import { HUB_DIRNAME } from "./hub";
import { stateRoot } from "./launch";

export interface GuardedTokens {
  /** Empreinte SHA-256 du jeton → le serveur, et d'où vient le jeton (le nom de la variable). */
  byHash: Readonly<Record<string, { server: string; from: string }>>;
}

export const guardedTokensPath = (env: NodeJS.ProcessEnv) => join(stateRoot(env), HUB_DIRNAME, "guarded-tokens.json");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/* Un nom de variable qui porte un secret ; jamais les variables ordinaires. */
export const SECRET_ENV_NAME = /token|secret|passw|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|bearer|cookie|session|headers?$/i;
const ORDINARY = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "PWD", "TERM", "TMPDIR", "XDG_SESSION_TYPE", "SSH_AUTH_SOCK", "XAUTHORITY", "GPG_AGENT_INFO"]);

/**
 * Les morceaux d'un texte qui peuvent être un jeton : assez longs, faits des caractères d'un
 * jeton, avec des lettres ET des chiffres (un chemin ou un mot n'en est pas un).
 */
export function tokenCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_\-.~+=]{20,}/g)) {
    /* `T=ghp_…` : le jeton est après le `=` ; un jeton en base64 garde, lui, son `=` final. */
    for (const piece of [match[0], ...match[0].split(/=(?=[^=])/)]) {
      const candidate = piece.replace(/^[.=~+-]+|[.~+-]+$/g, "");
      if (candidate.length >= 20 && /[0-9]/.test(candidate) && /[A-Za-z]/.test(candidate)) out.add(candidate);
      const trimmed = candidate.replace(/=+$/, "");
      if (trimmed !== candidate && trimmed.length >= 20) out.add(trimmed);
    }
  }
  return [...out];
}

/** Les jetons qu'un serveur reçoit, d'après son environnement et ses arguments. */
export function serverTokens(env: NodeJS.ProcessEnv, args: readonly string[]): { value: string; from: string }[] {
  const found: { value: string; from: string }[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || ORDINARY.has(key) || !SECRET_ENV_NAME.test(key)) continue;
    for (const candidate of tokenCandidates(value)) found.push({ value: candidate, from: key });
  }
  args.forEach((arg, index) => {
    if (findSecrets(arg).length === 0) return;
    for (const candidate of tokenCandidates(arg)) found.push({ value: candidate, from: `argument ${String(index + 1)}` });
  });
  return found;
}

/** Inscrit les empreintes des jetons d'un serveur (0600). Rien d'autre que des empreintes. */
export function recordServerTokens(env: NodeJS.ProcessEnv, server: string, tokens: readonly { value: string; from: string }[]): void {
  if (tokens.length === 0) return;
  const path = guardedTokensPath(env);
  const current = loadGuardedTokens(env)?.byHash ?? {};
  const next: Record<string, { server: string; from: string }> = { ...current };
  for (const token of tokens) next[sha256(token.value)] = { server, from: token.from };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ byHash: next }, null, 2)}\n`, { mode: 0o600 });
}

export function loadGuardedTokens(env: NodeJS.ProcessEnv): GuardedTokens | null {
  const path = guardedTokensPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GuardedTokens;
    return parsed && typeof parsed.byHash === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Ce que l'agent lit quand il emploie le jeton d'un serveur protégé hors de ce serveur. */
export function serverTokenReason(stolen: { server: string; from: string }): string {
  return `Oathrion refuses: this carries the token given to the "${stolen.server}" server it protects (${stolen.from}). Using it directly would go around Oathrion. Use that server's tools instead, and tell the person what you were trying to do.`;
}

/** Ce texte porte-t-il le jeton d'un serveur protégé ? Le serveur et l'origine, ou `null`. */
export function guardedTokenIn(text: string, guarded: GuardedTokens | null | undefined): { server: string; from: string } | null {
  if (!guarded) return null;
  for (const candidate of tokenCandidates(text)) {
    const hit = guarded.byHash[sha256(candidate)];
    if (hit) return hit;
  }
  return null;
}
