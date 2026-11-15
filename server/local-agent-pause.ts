/**
 * METTRE UN AGENT EN PAUSE, COMME UN ANTIVIRUS MET EN QUARANTAINE (demandé par l'utilisateur
 * le 10 novembre : « Oui, en pause »). Un agent qui tourne hors d'une prison d'Oathrion, et que
 * la personne n'a pas autorisé là, est figé aussitôt ; il ne perd rien, et ne peut plus rien
 * faire, jusqu'à ce qu'elle décide.
 *
 * Comment : le GEL des groupes de processus de Linux (cgroup v2, `cgroup.freeze`). L'agent et
 * ses enfants sont déplacés dans un groupe à nous (`oathrion-paused-<pid>`, créé sous le leur,
 * ce que systemd délègue à la personne) puis gelés. Un `SIGSTOP` ferait reprendre la main au
 * shell (« Stopped »), et l'agent reparti resterait en arrière-plan ; le gel, le shell ne le
 * voit pas. Sans gel possible (pas de cgroup v2, pas de délégation) : `SIGSTOP` quand même, en
 * le disant.
 *
 * Rien n'est gardé en mémoire : un agent est en pause si son groupe s'appelle
 * `oathrion-paused-…` (lu dans `/proc/<pid>/cgroup`). Un pivot relancé le retrouve.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const CGROUP_ROOT = "/sys/fs/cgroup";
const PREFIX = "oathrion-paused-";

/** Le groupe (cgroup v2) d'un processus, en chemin absolu, ou `null`. */
export function cgroupOf(pid: number, root = CGROUP_ROOT, proc = "/proc"): string | null {
  try {
    const line = readFileSync(join(proc, String(pid), "cgroup"), "utf8").match(/^0::(.*)$/m);
    return line ? join(root, line[1]!) : null;
  } catch {
    return null;
  }
}

/** Les descendants d'un processus (ses enfants, leurs enfants…). */
export function descendants(pid: number, proc = "/proc"): number[] {
  const parentOf = new Map<number, number>();
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(join(proc, entry, "stat"), "utf8");
      parentOf.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      /* parti entre-temps */
    }
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [child, parent] of parentOf) {
      if (parent !== current) continue;
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export type PauseHow = "frozen" | "stopped";

/** Ce processus est-il en pause par Oathrion ? (Son groupe, ou son état « arrêté » par nous.) */
export function pausedHow(pid: number, proc = "/proc"): PauseHow | null {
  const group = cgroupOf(pid, CGROUP_ROOT, proc);
  if (group && basename(group).startsWith(PREFIX)) return "frozen";
  return stoppedByUs.has(pid) ? "stopped" : null;
}

/* Les agents arrêtés par `SIGSTOP` (le repli) : ceux-là, seule la mémoire du pivot les connaît. */
const stoppedByUs = new Set<number>();
/* Les groupes de pause créés par ce pivot : un agent tué de dehors pendant sa pause laisse le sien vide. */
const groupsMade = new Set<string>();

/** Retire les groupes de pause vides (à chaque balayage de la veille). */
export function sweepPauseGroups(): void {
  for (const dir of groupsMade) {
    try {
      if (readFileSync(join(dir, "cgroup.procs"), "utf8").trim() === "") rmdirSync(dir);
      groupsMade.delete(dir);
    } catch {
      if (!existsSync(dir)) groupsMade.delete(dir);
    }
  }
}

/** Figer un agent et ses enfants. `null` s'il n'a pas pu l'être. */
export function pauseAgent(pid: number): PauseHow | null {
  const already = pausedHow(pid);
  if (already) return already;
  const group = cgroupOf(pid);
  if (group && !basename(group).startsWith(PREFIX)) {
    const dir = join(group, `${PREFIX}${String(pid)}`);
    try {
      mkdirSync(dir);
      for (const member of [pid, ...descendants(pid)]) {
        try {
          writeFileSync(join(dir, "cgroup.procs"), String(member));
        } catch {
          /* un enfant d'un autre groupe, ou parti : on gèle le reste */
        }
      }
      writeFileSync(join(dir, "cgroup.freeze"), "1");
      groupsMade.add(dir);
      return "frozen";
    } catch {
      /* pas de gel ici : on remet en place, puis le repli */
      try {
        for (const member of readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean)) writeFileSync(join(group, "cgroup.procs"), member);
        rmdirSync(dir);
      } catch {
        /* rien à défaire */
      }
    }
  }
  try {
    for (const member of [pid, ...descendants(pid)]) process.kill(member, "SIGSTOP");
    stoppedByUs.add(pid);
    return "stopped";
  } catch {
    return null;
  }
}

/*
 * Un agent en pause à qui l'on a demandé de s'arrêter (`kill`, `pkill`, Ctrl+C dans son terminal) :
 * un processus gelé ne reçoit ce signal qu'au dégel ; il restait donc figé pour toujours (essai
 * réel du 11 novembre, deux `agy` gelés depuis des heures). Le signal en attente se lit dans
 * `/proc/<pid>/status` (SigPnd, ShdPnd) : SIGHUP, SIGINT, SIGTERM.
 */
const STOP_SIGNALS = (1n << 0n) | (1n << 1n) | (1n << 14n);

export function stopRequested(pid: number, proc = "/proc"): boolean {
  try {
    const status = readFileSync(join(proc, String(pid), "status"), "utf8");
    for (const field of ["SigPnd", "ShdPnd"]) {
      const value = status.match(new RegExp(`^${field}:\\s+([0-9a-f]+)$`, "m"))?.[1];
      if (value && (BigInt(`0x${value}`) & STOP_SIGNALS) !== 0n) return true;
    }
  } catch {
    /* parti */
  }
  return false;
}

/** Reprendre : dégeler, remettre chacun dans son groupe d'origine, retirer le nôtre. */
export function resumeAgent(pid: number): boolean {
  const group = cgroupOf(pid);
  if (group && basename(group).startsWith(PREFIX)) {
    try {
      writeFileSync(join(group, "cgroup.freeze"), "0");
      const origin = dirname(group);
      for (const member of readFileSync(join(group, "cgroup.procs"), "utf8").split("\n").filter(Boolean)) writeFileSync(join(origin, "cgroup.procs"), member);
      rmdirSync(group);
      return true;
    } catch {
      return false;
    }
  }
  if (stoppedByUs.has(pid)) {
    stoppedByUs.delete(pid);
    try {
      for (const member of [pid, ...descendants(pid)]) process.kill(member, "SIGCONT");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Arrêter un agent, en pause ou non : tout son groupe gelé d'un coup, sinon le signal habituel. */
export function stopAgent(pid: number): boolean {
  const group = cgroupOf(pid);
  if (group && basename(group).startsWith(PREFIX) && existsSync(join(group, "cgroup.kill"))) {
    try {
      writeFileSync(join(group, "cgroup.kill"), "1");
      /* Le groupe vide se retire ensuite. */
      setTimeout(() => {
        try {
          rmdirSync(group);
        } catch {
          /* déjà retiré, ou pas encore vide */
        }
      }, 1_000).unref();
      return true;
    } catch {
      /* le repli ci-dessous */
    }
  }
  /* Sans groupe : lui et ce qu'il a lancé, relevés avant le signal (ensuite ils changent de parent). */
  const members = [pid, ...descendants(pid)];
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  stoppedByUs.delete(pid);
  for (const member of members.slice(1)) {
    try {
      process.kill(member, "SIGTERM");
    } catch {
      /* déjà parti */
    }
  }
  /* Arrêté par signal (par nous ou par Ctrl+Z), il ne lirait la demande qu'au réveil : on le réveille. */
  for (const member of members) {
    try {
      process.kill(member, "SIGCONT");
    } catch {
      /* déjà parti */
    }
  }
  return true;
}

/**
 * Le dire dans le terminal de l'agent, s'il en a un : la personne voit pourquoi il s'est figé.
 * Écrit seulement sur un terminal (`/dev/pts/…`), jamais dans un fichier ou un tuyau.
 */
export function tellInTerminal(pid: number, text: string, proc = "/proc"): boolean {
  for (const fd of ["2", "1"]) {
    try {
      const link = readlinkSync(join(proc, String(pid), "fd", fd));
      if (/^\/dev\/pts\/\d+$/.test(link)) {
        writeFileSync(link, `\r\n\x1b[1;33m${text}\x1b[0m\r\n`, { flag: "a" });
        return true;
      }
    } catch {
      /* pas de terminal à qui le dire */
    }
  }
  return false;
}
