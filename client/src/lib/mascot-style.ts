/**
 * La couleur d'une mascotte dans la console (11 novembre : l'allure des notifications) : son
 * halo (`.oath-glow`, `--glow`) et sa teinte, depuis `shared/mascots.ts`.
 */
import type { CSSProperties } from "react";

import { DANGER_ACCENT, MASCOT_ACCENTS, type MascotId } from "@shared/mascots";

const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(" ");

export function accentOf(mascotId: string, danger = false) {
  return danger ? DANGER_ACCENT : (MASCOT_ACCENTS[mascotId as MascotId] ?? MASCOT_ACCENTS.warden);
}

/** Le style d'un élément qui luit de la couleur de sa mascotte (avec la classe `oath-glow`). */
export function glowOf(mascotId: string, danger = false): CSSProperties {
  return { "--glow": rgb(accentOf(mascotId, danger).main) } as CSSProperties;
}
