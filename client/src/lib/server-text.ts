/**
 * Les phrases fixes du serveur, telles que la console les affiche.
 *
 * Le serveur les écrit en anglais : c'est ce que lisent les agents et les scripts par l'API.
 * La console les traduisait en français ; depuis le 4 novembre 2026 elle est en anglais, et
 * montre donc la phrase du serveur telle quelle. Les fonctions restent : les écrans passent
 * par elles, et une décision s'affiche en capitales lisibles plutôt qu'en identifiant.
 */

const DECISIONS: Readonly<Record<string, string>> = {
  allow: "ALLOWED",
  block: "BLOCKED",
  require_approval: "APPROVAL REQUIRED",
};

export function decisionLabel(decision: string): string {
  return DECISIONS[decision] ?? decision.replace("_", " ").toUpperCase();
}

export function resultLabel(result: string): string {
  return result;
}

export function reasonLabel(reason: string): string {
  return reason;
}

export function contextLabel(label: string): string {
  return label;
}

export function retryReasonLabel(reason: string): string {
  return reason;
}
