/**
 * LE FIL-PIÈGE DES LEURRES (10 novembre, la dernière pièce de « l'antivirus des agents »).
 *
 * Les leurres posés par `oathrion decoys plant` (`cli/wrap/decoys.ts`) n'ont aucun lecteur
 * honnête : un programme qui en lit un, agent reconnu ou non, dans la prison ou dehors, s'est
 * trahi. Sans droits d'administrateur, Linux ne prévient pas d'une lecture ; mais il note la
 * date d'accès d'un fichier quand elle est antérieure à sa date de modification (`relatime`,
 * le réglage par défaut). Le fil-piège la recule donc sous la date de modification (« armé ») ;
 * une lecture la fait avancer ; on la voit au balayage suivant, on prévient, on réarme.
 *
 * Seulement les leurres, pas les vrais secrets : `ssh` lit vos clés à chaque `git push`, et
 * Linux ne dit pas QUI a lu. Ne voit rien sur un système monté en `noatime`.
 */
import { statSync, utimesSync } from "node:fs";

export interface TripEvent {
  path: string;
  at: string;
}

/** Armer un fichier : sa date d'accès passe sous sa date de modification (qui ne bouge pas). */
export function arm(path: string): void {
  const stat = statSync(path);
  utimesSync(path, new Date(stat.mtimeMs - 1_000), stat.mtime);
}

/** A-t-il été lu depuis qu'il a été armé ? */
export function wasRead(path: string): boolean {
  const stat = statSync(path);
  return stat.atimeMs > stat.mtimeMs;
}

export class Tripwire {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly armed = new Set<string>();
  private readonly recent: TripEvent[] = [];

  constructor(
    private readonly options: {
      /** Les leurres à surveiller, relus à chaque balayage (posés ou retirés entre-temps). */
      files: () => string[];
      onTrip: (event: TripEvent) => void;
      intervalMs?: number;
      now?: () => Date;
    },
  ) {}

  /** Un balayage : un leurre lu est signalé, puis réarmé. Un leurre nouveau est armé sans bruit. */
  check(): TripEvent[] {
    const tripped: TripEvent[] = [];
    const files = this.options.files();
    for (const path of files) {
      try {
        if (!this.armed.has(path)) {
          arm(path);
          this.armed.add(path);
          continue;
        }
        if (!wasRead(path)) continue;
        const event = { path, at: (this.options.now?.() ?? new Date()).toISOString() };
        tripped.push(event);
        this.recent.unshift(event);
        this.recent.splice(20);
        this.options.onTrip(event);
        arm(path);
      } catch {
        /* un leurre retiré entre-temps */
        this.armed.delete(path);
      }
    }
    for (const path of this.armed) if (!files.includes(path)) this.armed.delete(path);
    return tripped;
  }

  /** Les dernières lectures (vingt au plus), la plus récente d'abord. */
  events(): TripEvent[] {
    return [...this.recent];
  }

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.options.intervalMs ?? 2_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
