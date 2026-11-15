/**
 * Les secrets reconnaissables à leur forme — UNE définition, pour deux usages :
 *
 *   · masquer avant de publier (le reçu d'une branche, `server/local-bundle.ts`) ;
 *   · dire ce qui partirait (la session à risque, `cli/wrap/claude-hook-rules.ts`) :
 *     « ce curl enverrait ce qui ressemble à une clé AWS ».
 *
 * Ce n'est pas une garantie : un mot de passe en clair n'a pas de forme. C'est dit où c'est utilisé.
 */
const SECRETS: { kind: string; pattern: RegExp }[] = [
  { kind: "a GitHub token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,})/g },
  { kind: "a GitHub token", pattern: /\b(github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "an AI provider key", pattern: /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g },
  { kind: "a Slack token", pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g },
  { kind: "an AWS access key", pattern: /\b(AKIA[0-9A-Z]{16})\b/g },
  { kind: "a Google API key", pattern: /\b(AIza[0-9A-Za-z_-]{30,})/g },
  { kind: "an npm token", pattern: /\b(npm_[A-Za-z0-9]{30,})/g },
  { kind: "a bearer token", pattern: /(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi },
  { kind: "a password or key", pattern: /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi },
  { kind: "a password in an address", pattern: /(:\/\/[^:/\s@]+:)([^@\s]+)(@)/g },
];

/** Les sortes de secrets qu'un texte contient, sans les répéter (« an AWS access key »…). */
export function findSecrets(text: string): string[] {
  return [...new Set(SECRETS.filter(({ pattern }) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text)).map(({ kind }) => kind))];
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern } of SECRETS) {
    out = out.replace(pattern, (...groups: string[]) => {
      const parts = groups.slice(1, -2).filter((part): part is string => typeof part === "string");
      /* Une seule capture : le secret entier. Plusieurs : le préfixe reste, la valeur est masquée, le suffixe reste. */
      if (parts.length === 1) return "«redacted»";
      return `${parts[0]!}«redacted»${parts.length > 2 ? parts.slice(2).join("") : ""}`;
    });
  }
  return out;
}
