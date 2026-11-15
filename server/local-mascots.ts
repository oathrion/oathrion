/**
 * LES MASCOTTES (10 et 11 novembre, `notes/CONCEPTION-MASCOTTES.md` § 2) : les illustrations
 * livrées avec Oathrion (`client/public/mascots/<id>.png`, découpées d'une planche par
 * `script/mascots-from-sheet.py`), et, si l'une manque, ces dessins provisoires, à nous,
 * dessinées en SVG par ce fichier — jamais un logo d'éditeur (Claude, Cursor, Gemini…). Une par
 * famille d'agents, pour reconnaître d'un coup d'œil QUI est bloqué. Elles tiennent la place des
 * dessins commandés (droits cédés), qui viendront en packs ; la personne choisira la mascotte de
 * chacun de ses agents.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mascotIdFor } from "@shared/mascots";

export interface Mascot {
  id: string;
  name: string;
  /** La couleur du corps, celle de l'ombre, et celle du détail (antenne, joues). */
  body: string;
  shade: string;
  accent: string;
  /** La tête : ronde, carrée arrondie, ou en goutte. */
  head: "round" | "square" | "drop";
  /** Ce qui la surmonte. */
  crown: "antenna" | "ears" | "spark" | "horns" | "none";
  /** Les yeux. */
  eyes: "dots" | "wide" | "visor" | "sleepy";
}

export const MASCOTS: Mascot[] = [
  { id: "ember", name: "Ember", body: "#f08a4b", shade: "#c8642a", accent: "#ffd166", head: "round", crown: "spark", eyes: "dots" },
  { id: "pixel", name: "Pixel", body: "#4f8ef7", shade: "#2f63c2", accent: "#9fd3ff", head: "square", crown: "antenna", eyes: "visor" },
  { id: "nova", name: "Nova", body: "#8b6cf0", shade: "#5f45c0", accent: "#f7b2ff", head: "drop", crown: "spark", eyes: "wide" },
  { id: "bolt", name: "Bolt", body: "#3fbf7f", shade: "#25935c", accent: "#d4ff7a", head: "square", crown: "horns", eyes: "dots" },
  { id: "echo", name: "Echo", body: "#2fb5c4", shade: "#1d8794", accent: "#b6f4ff", head: "round", crown: "ears", eyes: "wide" },
  { id: "orbit", name: "Orbit", body: "#e0b33a", shade: "#b0861c", accent: "#fff3b0", head: "round", crown: "antenna", eyes: "sleepy" },
  { id: "shade", name: "Shade", body: "#7b7f8c", shade: "#565a66", accent: "#c9ccd6", head: "drop", crown: "none", eyes: "sleepy" },
  { id: "warden", name: "Warden", body: "#5b5bd6", shade: "#3d3da8", accent: "#a5b4fc", head: "square", crown: "ears", eyes: "wide" },
];

/** La mascotte d'office d'un agent, par famille ; « shade » pour un programme inconnu, « warden » pour Oathrion lui-même. */
export function defaultMascot(agent: string): Mascot {
  const id = mascotIdFor(agent);
  return MASCOTS.find((m) => m.id === id)!;
}

/** Le dessin, en SVG 128×128, fond transparent. */
export function mascotSvg(m: Mascot): string {
  const head =
    m.head === "round"
      ? `<circle cx="64" cy="70" r="44" fill="${m.body}"/><ellipse cx="64" cy="98" rx="34" ry="12" fill="${m.shade}" opacity=".35"/>`
      : m.head === "square"
        ? `<rect x="20" y="28" width="88" height="84" rx="26" fill="${m.body}"/><rect x="28" y="92" width="72" height="16" rx="8" fill="${m.shade}" opacity=".35"/>`
        : `<path d="M64 22 C96 48 110 70 108 86 C106 106 88 116 64 116 C40 116 22 106 20 86 C18 70 32 48 64 22Z" fill="${m.body}"/><ellipse cx="64" cy="104" rx="32" ry="9" fill="${m.shade}" opacity=".35"/>`;
  const crown =
    m.crown === "antenna"
      ? `<line x1="64" y1="28" x2="64" y2="10" stroke="${m.shade}" stroke-width="5" stroke-linecap="round"/><circle cx="64" cy="9" r="7" fill="${m.accent}"/>`
      : m.crown === "ears"
        ? `<path d="M30 40 L24 14 L48 30Z" fill="${m.shade}"/><path d="M98 40 L104 14 L80 30Z" fill="${m.shade}"/>`
        : m.crown === "spark"
          ? `<path d="M64 4 L69 18 L83 20 L71 28 L74 42 L64 33 L54 42 L57 28 L45 20 L59 18Z" fill="${m.accent}"/>`
          : m.crown === "horns"
            ? `<path d="M36 34 Q26 16 38 10 Q36 22 46 30Z" fill="${m.accent}"/><path d="M92 34 Q102 16 90 10 Q92 22 82 30Z" fill="${m.accent}"/>`
            : "";
  const eyes =
    m.eyes === "visor"
      ? `<rect x="34" y="56" width="60" height="22" rx="11" fill="#1c1c2a"/><circle cx="50" cy="67" r="5" fill="${m.accent}"/><circle cx="78" cy="67" r="5" fill="${m.accent}"/>`
      : m.eyes === "wide"
        ? `<circle cx="48" cy="66" r="12" fill="#fff"/><circle cx="80" cy="66" r="12" fill="#fff"/><circle cx="50" cy="68" r="6" fill="#1c1c2a"/><circle cx="82" cy="68" r="6" fill="#1c1c2a"/><circle cx="52" cy="65" r="2" fill="#fff"/><circle cx="84" cy="65" r="2" fill="#fff"/>`
        : m.eyes === "sleepy"
          ? `<path d="M38 68 Q48 60 58 68" stroke="#1c1c2a" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M70 68 Q80 60 90 68" stroke="#1c1c2a" stroke-width="5" fill="none" stroke-linecap="round"/>`
          : `<circle cx="48" cy="66" r="7" fill="#1c1c2a"/><circle cx="80" cy="66" r="7" fill="#1c1c2a"/><circle cx="50" cy="64" r="2.5" fill="#fff"/><circle cx="82" cy="64" r="2.5" fill="#fff"/>`;
  const cheeks = `<circle cx="36" cy="84" r="6" fill="${m.accent}" opacity=".7"/><circle cx="92" cy="84" r="6" fill="${m.accent}" opacity=".7"/>`;
  const mouth = `<path d="M54 88 Q64 96 74 88" stroke="#1c1c2a" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">${crown}${head}${eyes}${cheeks}${mouth}</svg>\n`;
}

/**
 * Écrit les mascottes provisoires dans `<dossier>/mascots/` (une fois par démarrage du pivot) ;
 * rend le chemin de la mascotte d'un agent : l'illustration livrée avec Oathrion
 * (`<images>/<id>.png`, `client/public/mascots/`, 11 novembre) quand elle existe, sinon le
 * dessin provisoire.
 */
export function writeMascots(stateDir: string, imagesDir?: string): (agent: string) => { path: string; name: string; id: string } {
  const dir = join(stateDir, "mascots");
  mkdirSync(dir, { recursive: true });
  for (const m of MASCOTS) writeFileSync(join(dir, `${m.id}.svg`), mascotSvg(m));
  return (agent) => {
    const m = defaultMascot(agent);
    const drawn = imagesDir ? join(imagesDir, `${m.id}.png`) : null;
    return { path: drawn && existsSync(drawn) ? drawn : join(dir, `${m.id}.svg`), name: m.name, id: m.id };
  };
}
