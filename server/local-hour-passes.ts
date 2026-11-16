/**
 * « ALLOW 1 HOUR » (16 novembre, retour des premiers testeurs : « Oathrion envoie beaucoup de
 * notifications, alors on approuve sans regarder »). Un troisième bouton sur la demande : cet
 * agent, cet outil, pendant une heure, sans redemander.
 *
 * Rien ne change dans les règles : la demande suit son chemin (la règle, l'approbation, le reçu
 * signé), puis le pivot l'approuve lui-même, au nom de cette permission, et ne dérange personne.
 * Une permission expirée ne vaut plus rien, même lue après un redémarrage. La première brique du
 * mandat (`notes/CONCEPTION-MANDAT.md`) : une confiance bornée, dans le temps et dans l'objet.
 *
 * Seulement pour l'outil d'un serveur derrière Oathrion (`mcp.<serveur>.<outil>`) : pas pour les
 * commandes de Claude Code, où une heure de « shell » ouvrirait tout.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HOUR_PASS_MS = 60 * 60_000;
const FILE = "hour-passes.json";

export interface HourPass {
  agentId: string;
  action: string;
  grantedAt: string;
  until: string;
}

/*
 * Seulement une ÉCRITURE (recette du 16 novembre) : un outil destructif est demandé à chaque fois,
 * comme « Approve, don't ask again » le refuse déjà (`LocalHub.grantAlways`). Le pivot dit la classe
 * de chaque outil (`judgeHourPassesBy`) ; tant qu'il ne l'a pas dite, ou pour un outil qu'il ne
 * connaît pas, aucune permission d'une heure.
 */
let toolClassOf: ((action: string) => string | null) | null = null;

/** Le pivot donne la classe de ses outils (`server/local-entry.ts`). */
export function judgeHourPassesBy(classify: ((action: string) => string | null) | null): void {
  toolClassOf = classify;
}

/** L'outil d'ÉCRITURE d'un serveur derrière Oathrion, et pas une commande de Claude Code. */
export function passable(action: unknown): action is string {
  const match = /^mcp\.([a-z0-9][a-z0-9_-]*)\.(.+)$/.exec(String(action ?? ""));
  if (match === null || match[1] === "claude-code") return false;
  return toolClassOf === null || toolClassOf(match[0]) === "write";
}

export class HourPasses {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): HourPass[] {
    const file = join(this.dir, FILE);
    if (!existsSync(file)) return [];
    try {
      const passes = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return Array.isArray(passes) ? passes.filter((p): p is HourPass => typeof p?.agentId === "string" && typeof p?.action === "string" && typeof p?.until === "string") : [];
    } catch {
      return [];
    }
  }

  /** Les permissions encore valables ; les autres sont oubliées. */
  active(): HourPass[] {
    return this.read().filter((pass) => Date.parse(pass.until) > this.now());
  }

  grant(agentId: string, action: string): HourPass {
    if (!passable(action)) throw new Error("Only a write tool of a server behind Oathrion can be allowed for an hour; a destructive one is asked every time.");
    const pass: HourPass = { agentId, action, grantedAt: new Date(this.now()).toISOString(), until: new Date(this.now() + HOUR_PASS_MS).toISOString() };
    const kept = this.active().filter((p) => !(p.agentId === agentId && p.action === action));
    writeFileSync(join(this.dir, FILE), JSON.stringify([...kept, pass], null, 2), { mode: 0o600 });
    return pass;
  }

  covers(agentId: string, action: unknown): HourPass | null {
    if (!passable(action)) return null;
    return this.active().find((pass) => pass.agentId === agentId && pass.action === action) ?? null;
  }
}

/** « 14:32 » : l'heure de fin, comme la personne la lit. */
export function untilClock(pass: HourPass): string {
  return new Date(pass.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
