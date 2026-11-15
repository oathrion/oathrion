/**
 * LA MASCOTTE ET LE NOM QUE LA PERSONNE DONNE À CHACUN DE SES AGENTS (11 novembre : « l'expérience
 * de choix et de personnalisation de mascotte, en choisissant un nom pour l'agent »). Par famille
 * d'agents (`agentFamily`) : « Claude Code » et « claude » sont le même agent. Sans choix, la
 * mascotte d'office (`defaultMascot`).
 *
 * Gardé dans `mascot-choices.json` (0600), relu quand il change : la notification, le fil et la
 * console montrent aussitôt le nouveau visage.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentFamily, CHOOSABLE_MASCOTS, cleanAgentNickname, MASCOT_NAMES, type MascotId } from "@shared/mascots";

import { defaultMascot } from "./local-mascots";

export const MASCOT_CHOICES_FILE = "mascot-choices.json";

export interface MascotChoice {
  mascot: MascotId;
  /** Le nom donné à l'agent ; sans lui, celui de la mascotte. */
  nickname?: string;
  at: string;
}

export class MascotChoices {
  private cache: { mtime: number; choices: Record<string, MascotChoice> } | null = null;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get path(): string {
    return join(this.dir, MASCOT_CHOICES_FILE);
  }

  /** Tous les choix, par famille. */
  list(): Record<string, MascotChoice> {
    let mtime = -1;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch {
      return {};
    }
    if (this.cache?.mtime === mtime) return this.cache.choices;
    const choices: Record<string, MascotChoice> = {};
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Partial<MascotChoice>>;
      for (const [family, choice] of Object.entries(raw)) {
        if (!choice || !CHOOSABLE_MASCOTS.includes(choice.mascot as MascotId)) continue;
        const nickname = cleanAgentNickname(choice.nickname);
        choices[family] = { mascot: choice.mascot as MascotId, ...(nickname ? { nickname } : {}), at: String(choice.at ?? "") };
      }
    } catch {
      /* un fichier illisible : les mascottes d'office */
    }
    this.cache = { mtime, choices };
    return choices;
  }

  /** Donner une mascotte (et un nom) à un agent. Rend le choix enregistré, ou une erreur dite. */
  choose(agent: string, mascot: unknown, nickname: unknown): MascotChoice | string {
    if (!CHOOSABLE_MASCOTS.includes(mascot as MascotId)) return `The mascot is one of: ${CHOOSABLE_MASCOTS.join(", ")}.`;
    const name = nickname === undefined || nickname === "" ? null : cleanAgentNickname(nickname);
    if (nickname !== undefined && nickname !== "" && name === null) return "The name is 1 to 24 characters, without < > & or quotes.";
    const choices = { ...this.list() };
    const choice: MascotChoice = { mascot: mascot as MascotId, ...(name ? { nickname: name } : {}), at: this.now().toISOString() };
    choices[agentFamily(agent)] = choice;
    writeFileSync(this.path, `${JSON.stringify(choices, null, 2)}\n`, { mode: 0o600 });
    this.cache = null;
    return choice;
  }

  /** Le visage d'un agent : sa mascotte (image) et le nom à afficher. */
  of(agent: string): { id: MascotId; name: string } {
    const choice = this.list()[agentFamily(agent)];
    if (choice) return { id: choice.mascot, name: choice.nickname ?? MASCOT_NAMES[choice.mascot] };
    const mascot = defaultMascot(agent);
    return { id: mascot.id as MascotId, name: mascot.name };
  }
}
