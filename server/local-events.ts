/**
 * LE JOURNAL DES ÉVÉNEMENTS DU PIVOT (11 novembre, le fil d'actualité de la console) : ce
 * qu'Oathrion a fait et ce que la personne a décidé, hors des exécutions — un agent mis en
 * pause, repris, arrêté, autorisé ; un programme jamais vu, confirmé ou bloqué ; un leurre lu.
 * Une ligne JSON par événement (`events.jsonl`, 0600), jamais réécrite ; les mille dernières sont
 * lues pour le fil.
 *
 * `detail` est PRIVÉ (un chemin, un numéro de processus) : montré à la personne dans sa console,
 * jamais dans ce qu'elle partage (`local-feed.ts`).
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LocalEventKind =
  | "paused"
  | "reported"
  | "resumed-once"
  | "allowed"
  | "forgotten"
  | "stopped"
  | "new-agent"
  | "trusted"
  | "blocked"
  | "decoy";

export interface LocalEvent {
  id: string;
  at: string;
  kind: LocalEventKind;
  /** L'agent (« agy », « claude ») ou le programme ; « decoy » pour un leurre. */
  agent: string;
  /** Qui a décidé (« you, from the notification », « you, from the console »), s'il y a lieu. */
  by?: string;
  /** Privé : un chemin, un numéro de processus. */
  detail?: string;
}

export const EVENTS_FILE = "events.jsonl";

export class LocalEvents {
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(stateDir, EVENTS_FILE);
  }

  record(event: Omit<LocalEvent, "id" | "at">): LocalEvent {
    const full: LocalEvent = { id: `evt_${randomBytes(6).toString("base64url")}`, at: this.now().toISOString(), ...event };
    try {
      appendFileSync(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    } catch {
      /* le fil n'est qu'un récit : on ne bloque rien pour lui */
    }
    return full;
  }

  /** Les derniers événements, le plus récent d'abord. */
  list(limit = 1_000): LocalEvent[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean).slice(-limit);
    const out: LocalEvent[] = [];
    for (const line of lines.reverse()) {
      try {
        out.push(JSON.parse(line) as LocalEvent);
      } catch {
        /* une ligne abîmée n'empêche pas les autres */
      }
    }
    return out;
  }
}
