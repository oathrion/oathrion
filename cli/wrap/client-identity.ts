/**
 * QUI EST LE CLIENT, VRAIMENT ? (demandé par l'utilisateur le 9 novembre : « un programme encore
 * inconnu sur la machine doit être bloqué jusqu'à confirmation de son identité »).
 *
 * Un client MCP se présente par un nom (`clientInfo.name` : « Claude Code », « Cursor ») qu'il
 * choisit lui-même : n'importe quel programme peut se dire « Claude Code ». Le relais
 * (`oathrion wrap`) est lancé PAR le client : il remonte ses processus parents jusqu'au premier
 * qui n'est ni un shell ni un lanceur (`npx`, `npm exec`, `sh -c`, `env`), et en relève
 * l'exécutable réel, le script quand c'est un interpréteur (`node app.js`), et l'empreinte
 * SHA-256 du fichier. C'est cette identité que la personne confirme dans la console ; un
 * programme jamais vu n'a pas de clé (`server/local-programs.ts`).
 *
 * Linux (`/proc`) et macOS (`ps`). Ailleurs (Windows) : pas d'identité, et le pivot retombe sur
 * le nom déclaré, ce que la documentation dit. Rien ici ne lit autre chose que les métadonnées
 * des processus de la personne elle-même, et l'exécutable pour le hacher.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export interface ClientProgram {
  /** Le chemin réel de l'exécutable (`/usr/bin/cursor`, `…/claude.exe`, `…/bin/node`). */
  exe: string;
  /** Le script, quand l'exécutable est un interpréteur (`node /chemin/app.js`). */
  script: string | null;
  /** SHA-256 du fichier exécutable. */
  sha256: string;
  /** Le système : l'identité ne se compare qu'avec une identité du même système. */
  platform: NodeJS.Platform;
}

/* Ce qui n'est qu'un intermédiaire entre le client et le relais : on remonte au-delà. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "env", "sudo", "doas", "timeout", "nohup", "cmd.exe", "cmd", "powershell", "pwsh"]);
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "ruby", "perl"]);
const LAUNCHER_SCRIPTS = /(?:^|[\\/])(?:npm-cli\.js|npx-cli\.js|npm|npx|pnpm|pnpx|yarn|corepack|bunx|uvx|pipx)$/;

interface ProcessInfo {
  pid: number;
  ppid: number;
  exe: string;
  args: string[];
}

function linuxProcess(pid: number): ProcessInfo | null {
  try {
    let exe = readlinkSync(`/proc/${String(pid)}/exe`);
    /*
     * Une AppImage (Cursor sous Linux) se monte à un endroit nouveau à chaque lancement
     * (`/tmp/.mount_CursorXXXX/…`) : on l'identifie par le fichier AppImage lui-même, que
     * l'AppImage déclare dans son environnement.
     */
    if (/[\\/]\.mount_[^\\/]+[\\/]/.test(exe)) {
      const appimage = readFileSync(`/proc/${String(pid)}/environ`, "utf8").split("\0").find((entry) => entry.startsWith("APPIMAGE="));
      if (appimage) exe = appimage.slice("APPIMAGE=".length);
    }
    const args = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0").filter((a) => a !== "");
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return { pid, ppid, exe, args };
  } catch {
    return null;
  }
}

function macProcess(pid: number): ProcessInfo | null {
  try {
    const line = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim();
    const [ppidText, ...comm] = line.split(/\s+/);
    const args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim().split(/\s+/);
    return { pid, ppid: Number(ppidText), exe: comm.join(" "), args };
  } catch {
    return null;
  }
}

/** Le hachage d'un fichier, lu par morceaux (un exécutable peut peser des centaines de Mo). */
export function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; read = readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/*
 * Hacher Claude Code (plus de 300 Mo) prend environ une seconde, à chaque lancement d'un
 * serveur. L'empreinte est gardée par chemin, taille et date de modification : un fichier
 * changé est haché à nouveau.
 */
function cachedHash(exe: string, cacheFile: string | undefined): string {
  if (!cacheFile) return sha256OfFile(exe);
  const stat = statSync(exe);
  const key = `${exe}|${String(stat.size)}|${String(stat.mtimeMs)}`;
  let cache: Record<string, string> = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, string>;
  } catch {
    /* pas encore de cache */
  }
  const known = cache[key];
  if (typeof known === "string" && /^[0-9a-f]{64}$/.test(known)) return known;
  const hash = sha256OfFile(exe);
  try {
    const kept = Object.fromEntries(Object.entries(cache).filter(([k]) => !k.startsWith(`${exe}|`)).slice(-50));
    writeFileSync(cacheFile, `${JSON.stringify({ ...kept, [key]: hash })}\n`, { mode: 0o600 });
  } catch {
    /* le cache n'est qu'une économie */
  }
  return hash;
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Le programme qui a lancé ce relais, ou `null` si ce système ne permet pas de le savoir.
 * `start` : le processus d'où remonter (par défaut, le parent du relais).
 */
export function clientProgram(start: number = process.ppid, platform: NodeJS.Platform = process.platform, cacheFile?: string): ClientProgram | null {
  const hashOf = (exe: string) => cachedHash(exe, cacheFile);
  const read = platform === "linux" ? linuxProcess : platform === "darwin" ? macProcess : null;
  if (!read) return null;
  let pid = start;
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    const info = read(pid);
    if (!info) return null;
    const exe = real(info.exe);
    const base = basename(exe).toLowerCase();
    const script = INTERPRETERS.has(base.replace(/[0-9.]+$/, "")) ? (info.args.slice(1).find((a) => !a.startsWith("-")) ?? null) : null;
    const launcher = SHELLS.has(base) || (script !== null && LAUNCHER_SCRIPTS.test(script)) || LAUNCHER_SCRIPTS.test(base);
    if (!launcher) {
      if (!existsSync(exe) || !statSync(exe).isFile()) return null;
      return { exe, script: script !== null && existsSync(script) ? real(script) : script, sha256: hashOf(exe), platform };
    }
    pid = info.ppid;
  }
  return null;
}

/**
 * Le programme qu'une commande va lancer, relevé AVANT de la lancer (`oathrion jail`, dehors) :
 * le fichier trouvé dans le PATH, son chemin réel, et le script quand c'est un interpréteur.
 * `null` si on ne le trouve pas.
 */
export function commandProgram(command: readonly string[], pathEnv: string, platform: NodeJS.Platform = process.platform): ClientProgram | null {
  const name = command[0];
  if (!name) return null;
  const candidates = name.includes("/") ? [name] : pathEnv.split(":").filter(Boolean).map((dir) => `${dir}/${name}`);
  const found = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  if (!found) return null;
  const exe = real(found);
  const script = INTERPRETERS.has(basename(exe).toLowerCase().replace(/[0-9.]+$/, "")) ? (command.slice(1).find((a) => !a.startsWith("-")) ?? null) : null;
  return { exe, script: script !== null && existsSync(script) ? real(script) : script, sha256: sha256OfFile(exe), platform };
}

/** Une ligne lisible : « claude.exe (/home/…/claude.exe) » ou « node app.js (/…/app.js) ». */
export function describeProgram(program: ClientProgram): string {
  return program.script ? `${basename(program.exe)} ${basename(program.script)} (${program.script})` : `${basename(program.exe)} (${program.exe})`;
}
