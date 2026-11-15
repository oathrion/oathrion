/**
 * LA VEILLE DES AGENTS (demandée par l'utilisateur le 10 novembre : « détecter l'intrusion d'un
 * nouvel agent qui tente d'agir sur la machine sans autorisation »).
 *
 * Toutes les deux secondes, le pivot lit les processus de la personne (`/proc`, sans droit
 * particulier) et y reconnaît les agents connus par leur VRAI fichier (`AGENT_SIGNATURES`), pas
 * par le nom qu'ils se donnent. Un agent est protégé s'il descend d'une prison ouverte par
 * `oathrion jail` (le pivot connaît le processus de chaque prison : lancer soi-même `bwrap` ne
 * suffit pas). Un agent qui tourne HORS de la prison est signalé — une notification, et la
 * console — sauf si la personne l'a autorisé là (`agents-outside.json`, par fichier).
 *
 * Ce que ça ne fait pas : reconnaître un agent dont on ne connaît pas la signature ; voir
 * ailleurs que sous Linux (pour l'instant) ; empêcher un agent de démarrer (la console propose
 * de l'arrêter). Un programme d'un autre compte n'est pas lu.
 */
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  exe: string;
  args: string[];
  /** Le moment du démarrage, en tops d'horloge depuis le démarrage de la machine (`/proc/<pid>/stat`). */
  start: number;
}

export interface RunningAgent {
  pid: number;
  /** Le nom de l'agent (« claude », « cursor-agent », « agy »…). */
  agent: string;
  exe: string;
  script: string | null;
  jailed: boolean;
  /** Une clé stable d'un lancement : le même processus n'est signalé qu'une fois. */
  launch: string;
  /** Mis en pause par Oathrion (`local-agent-pause.ts`) : gelé, ou arrêté par signal ; sinon `null`. */
  paused?: "frozen" | "stopped" | null;
}

const lower = (text: string) => text.toLowerCase();

/** Reconnaître un agent par son exécutable et ses arguments (le script d'un interpréteur). */
export const AGENT_SIGNATURES: { agent: string; matches: (exe: string, args: readonly string[]) => boolean }[] = [
  { agent: "claude", matches: (exe, args) => /^claude(\.exe)?$/.test(basename(exe)) || [exe, ...args.slice(0, 2)].some((a) => a.includes("@anthropic-ai/claude-code")) },
  { agent: "cursor-agent", matches: (exe, args) => [exe, ...args.slice(0, 2)].some((a) => a.includes("/cursor-agent/versions/")) || basename(exe) === "cursor-agent" },
  { agent: "agy", matches: (exe) => basename(exe) === "agy" },
  { agent: "codex", matches: (exe, args) => basename(exe) === "codex" || [exe, ...args.slice(0, 2)].some((a) => a.includes("@openai/codex")) },
  { agent: "gemini", matches: (exe, args) => basename(exe) === "gemini" || [exe, ...args.slice(0, 2)].some((a) => a.includes("@google/gemini-cli")) },
  { agent: "aider", matches: (exe, args) => basename(exe) === "aider" || args.slice(0, 2).some((a) => basename(a) === "aider") },
  { agent: "goose", matches: (exe) => basename(exe) === "goose" },
  { agent: "opencode", matches: (exe) => basename(exe) === "opencode" },
  /* Les applications de bureau : leur agent tourne dans l'application. */
  { agent: "Cursor (app)", matches: (exe) => /^cursor$/.test(lower(basename(exe))) || /cursor[^/]*\.appimage$/.test(lower(exe)) },
  { agent: "Antigravity (app)", matches: (exe) => /^antigravity$/.test(lower(basename(exe))) || /antigravity[^/]*\.appimage$/.test(lower(exe)) },
];

/**
 * L'agent d'IA dont ce processus descend (le premier en remontant), ou `null` : celui depuis
 * lequel la personne a lancé `npx oathrion` (10 novembre : sinon la veille le mettait en pause
 * aussitôt, la conversation même où elle installait Oathrion).
 */
export function launchingAgent(start: number = process.ppid, procRoot = "/proc"): { agent: string; exe: string } | null {
  const byPid = new Map(readProcesses(procRoot).map((p) => [p.pid, p]));
  let current = byPid.get(start);
  for (let depth = 0; current && depth < 64; depth += 1) {
    const agent = AGENT_SIGNATURES.find((s) => s.matches(current!.exe, current!.args))?.agent;
    if (agent) return { agent, exe: current.exe };
    current = byPid.get(current.ppid);
  }
  return null;
}

/** Les processus du compte courant, lus dans `/proc`. Ceux qu'on ne peut pas lire sont passés. */
export function readProcesses(procRoot = "/proc"): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const dir = join(procRoot, entry);
      let exe = readlinkSync(join(dir, "exe")).replace(/ \(deleted\)$/, "");
      /* Une AppImage (Cursor sous Linux) se monte à un endroit nouveau à chaque lancement. */
      if (/[\\/]\.mount_[^\\/]+[\\/]/.test(exe)) {
        const appimage = readFileSync(join(dir, "environ"), "utf8").split("\0").find((e) => e.startsWith("APPIMAGE="));
        if (appimage) exe = appimage.slice("APPIMAGE=".length);
      }
      const args = readFileSync(join(dir, "cmdline"), "utf8").split("\0").filter((a) => a !== "");
      const stat = readFileSync(join(dir, "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.push({ pid: Number(entry), ppid: Number(fields[1]), exe, args, start: Number(fields[19]) });
    } catch {
      /* un processus parti entre-temps, ou d'un autre compte */
    }
  }
  return out;
}

const signatureOf = (proc: ProcessInfo) => AGENT_SIGNATURES.find((s) => s.matches(proc.exe, proc.args))?.agent ?? null;

/** Le paquet npm de chaque agent qui s'installe par npm : ce qu'on reconnaît dans une installation. */
const AGENT_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
};

const INSTALL_COMMANDS = /^(install|i|add|ci|update|up|upgrade|uninstall|un|remove|rm|r|rebuild)$/;
const PACKAGE_MANAGER = (word: string) =>
  /^(npm|pnpm|yarn|bun)(\.cmd|\.exe)?$/.test(basename(word)) || /(npm-cli|pnpm|yarn)\.c?js$/.test(basename(word));

/**
 * Les paquets que nomme une installation (`npm install -g @anthropic-ai/claude-code@latest`), ou
 * `null` si ce processus n'en est pas une. npm réécrit souvent sa ligne de commande en une seule
 * chaîne (« npm install -g … ») : on la redécoupe.
 */
function installedPackages(proc: ProcessInfo): string[] | null {
  const words = proc.args.flatMap((a) => a.split(/\s+/)).filter((w) => w !== "");
  const at = words.findIndex(PACKAGE_MANAGER);
  if (at < 0) return null;
  const rest = words.slice(at + 1).filter((w) => !w.startsWith("-"));
  if (rest.length === 0 || !INSTALL_COMMANDS.test(rest[0]!)) return null;
  return rest.slice(1);
}

/**
 * Ce processus fait partie de l'installation de SON PROPRE agent : npm lui-même, ou le script
 * d'installation du paquet, qui lance le programme de l'agent (11 novembre : la veille mettait en
 * pause l'installeur de Claude Code, et la mise à jour échouait). Seule l'installation qui NOMME le
 * paquet de cet agent compte : un paquet quelconque dont le script lancerait un agent pour agir
 * reste signalé.
 */
function partOfOwnInstall(proc: ProcessInfo, agent: string, chain: readonly ProcessInfo[]): boolean {
  if (installedPackages(proc) !== null) return true;
  const pkg = AGENT_PACKAGES[agent];
  if (!pkg) return false;
  return chain.some((p) => (installedPackages(p) ?? []).some((name) => name === pkg || name.startsWith(`${pkg}@`)));
}

/**
 * Les agents qui tournent : le processus le plus haut de chacun (un agent lance des enfants, un
 * interpréteur, des outils : on ne le compte qu'une fois), protégé ou non par une prison.
 */
export function findAgents(processes: readonly ProcessInfo[], jailPids: ReadonlySet<number>): RunningAgent[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const ancestors = (proc: ProcessInfo): ProcessInfo[] => {
    const chain: ProcessInfo[] = [];
    let current = byPid.get(proc.ppid);
    for (let depth = 0; current && depth < 64; depth += 1) {
      chain.push(current);
      current = byPid.get(current.ppid);
    }
    return chain;
  };
  const agents: RunningAgent[] = [];
  for (const proc of processes) {
    const agent = signatureOf(proc);
    if (!agent) continue;
    const chain = ancestors(proc);
    /*
     * Un parent est déjà LE MÊME agent : c'est un de ses enfants (son interpréteur, ses outils),
     * compté une fois. Un AUTRE agent lancé par un agent est compté à part : sinon, un agent
     * autorisé hors de la prison (Claude Code) lancerait un agent (agy) que personne ne verrait
     * (essai réel du 10 novembre).
     */
    if (chain.some((p) => signatureOf(p) === agent)) continue;
    if (partOfOwnInstall(proc, agent, chain)) continue;
    const jailed = jailPids.has(proc.pid) || chain.some((p) => jailPids.has(p.pid));
    const interpreted = /^(node|nodejs|bun|python3?|deno)$/.test(basename(proc.exe));
    const script = interpreted ? (proc.args.slice(1).find((a) => !a.startsWith("-")) ?? null) : null;
    agents.push({ pid: proc.pid, agent, exe: proc.exe, script, jailed, launch: `${String(proc.pid)}:${String(proc.start)}` });
  }
  return agents;
}

/** Les agents que la personne a autorisés hors de la prison, par fichier. */
export class OutsideAllowances {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "agents-outside.json");
  }

  list(): Record<string, { agent: string; by: string; at: string }> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, { agent: string; by: string; at: string }>) : {};
    } catch {
      return {};
    }
  }

  allow(exe: string, agent: string, by: string, now = new Date()): void {
    const next = { ...this.list(), [exe]: { agent, by, at: now.toISOString() } };
    writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  revoke(exe: string): void {
    const next = this.list();
    delete next[exe];
    writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  has(exe: string): boolean {
    return exe in this.list();
  }
}

/**
 * La veille : un balayage toutes les `intervalMs`. Un agent hors de la prison, non autorisé là,
 * est signalé une fois par lancement (`onOutside`).
 */
export class AgentWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly signalled = new Set<string>();
  private readonly seenOnce = new Set<string>();
  /* Les lancements repris « pour cette fois » (depuis la notification) : laissés tranquilles tant qu'ils tournent. */
  private readonly allowedOnce = new Set<string>();
  private last: RunningAgent[] = [];

  constructor(
    private readonly options: {
      jailPids: () => ReadonlySet<number>;
      allowances: OutsideAllowances;
      onOutside: (agent: RunningAgent) => void;
      read?: () => ProcessInfo[];
      intervalMs?: number;
    },
  ) {}

  /** Un balayage : les agents qui tournent, et le signalement des nouveaux hors de la prison. */
  scan(): RunningAgent[] {
    const agents = findAgents((this.options.read ?? readProcesses)(), this.options.jailPids());
    const live = new Set(agents.map((a) => a.launch));
    for (const key of this.signalled) if (!live.has(key)) this.signalled.delete(key);
    for (const key of this.seenOnce) if (!live.has(key)) this.seenOnce.delete(key);
    for (const key of this.allowedOnce) if (!live.has(key)) this.allowedOnce.delete(key);
    for (const agent of agents) {
      if (agent.jailed || this.signalled.has(agent.launch) || this.allowedOnce.has(agent.launch) || this.options.allowances.has(agent.exe)) {
        this.seenOnce.delete(agent.launch);
        continue;
      }
      /*
       * Vu une première fois hors prison : on attend le balayage suivant. `oathrion jail` déclare
       * sa prison juste APRÈS l'avoir lancée ; un balayage tombé entre les deux ne doit pas crier.
       */
      if (!this.seenOnce.has(agent.launch)) {
        this.seenOnce.add(agent.launch);
        continue;
      }
      this.seenOnce.delete(agent.launch);
      this.signalled.add(agent.launch);
      this.options.onOutside(agent);
    }
    this.last = agents;
    return agents;
  }

  /**
   * Repris « pour cette fois » : ce lancement-là est laissé tranquille ; le prochain lancement du
   * même programme sera mis en pause de nouveau (11 novembre : un seul clic sur « Resume »
   * autorisait l'agent pour toujours, et la personne ne recevait plus rien).
   */
  allowOnce(launch: string): void {
    this.allowedOnce.add(launch);
  }

  isAllowedOnce(launch: string): boolean {
    return this.allowedOnce.has(launch);
  }

  /** Les lancements de ce programme déjà signalés sont oubliés : ils le seront de nouveau. */
  forget(exe: string): void {
    for (const agent of this.last) if (agent.exe === exe) this.signalled.delete(agent.launch);
  }

  /** Ce que la console montre : le dernier balayage. */
  running(): RunningAgent[] {
    return this.last;
  }

  start(): void {
    if (this.timer || process.platform !== "linux") return;
    this.scan();
    /* Toutes les 2 s : un agent dehors est mis en pause 2 à 4 s après son lancement (deux balayages). */
    this.timer = setInterval(() => this.scan(), this.options.intervalMs ?? 2_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
