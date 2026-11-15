/**
 * L'intitulé et la description d'une permission, tels que la console les affiche.
 *
 * Chaque agent garde en base une COPIE des intitulés de sa permission, écrite au moment de sa
 * création : en français pour les agents locaux créés avant le 4 novembre 2026, quand la
 * console était en français. L'affichage part donc de la PORTÉE, la seule clé stable, et lit
 * le texte anglais du catalogue partagé (`shared/seed/agents.ts`). Une portée inconnue garde
 * son texte d'origine.
 */
import { PERMISSION_CATALOG } from "@shared/seed/agents";
import type { Permission } from "@shared/types";

const BY_SCOPE = new Map(PERMISSION_CATALOG.map((entry) => [entry.scope, entry]));

export function permissionText(permission: Pick<Permission, "scope" | "label" | "description">): { label: string; description: string } {
  const known = BY_SCOPE.get(permission.scope);
  return known ? { label: known.label, description: known.description } : { label: permission.label, description: permission.description };
}
