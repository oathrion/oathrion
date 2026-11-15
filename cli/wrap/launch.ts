/**
 * Le lancement de l'Oathrion local pour `oathrion wrap`.
 *
 * Ce module prépare le dossier d'état (`~/.oathrion/<serveur>/`), choisit un port, crée la
 * clé de l'agent, puis lance `dist/oathrion-local.cjs` — le serveur en mode local, qui lance
 * lui-même le serveur MCP enveloppé (`server/local-entry.ts`). Il attend `/api/ready` :
 * quand cette route répond, l'enfant est inscrit, l'agent et sa clé existent, les règles
 * sont posées.
 *
 * ## Ce qui reste d'un lancement à l'autre
 *
 *   · la base (`oathrion.db`) : reçus, règles, approbations ;
 *   · le secret de session (`session.secret`), pour qu'une console ouverte reste ouverte ;
 *   · le port (`port`), pour que le lien d'invitation et la console gardent leur adresse.
 *
 * La clé de l'agent, elle, est nouvelle à chaque lancement et ne touche jamais le disque :
 * elle ne vit que dans ce processus et dans l'environnement du serveur local.
 *
 * Le journal complet du serveur local va dans `oathrion.log` ; seules ses lignes
 * `[oathrion wrap]` et ses erreurs remontent sur la sortie d'erreur.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const READY_TIMEOUT_MS = 180_000;

export interface LaunchOptions {
  name: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  port?: number;
  /** Préparer une clé d'approbation pour le relais (`--approbation client`). */
  approveInClient?: boolean;
  /** Le dossier où lancer le serveur enveloppé ; absent, le dossier courant. */
  cwd?: string;
  /** Qui lance : le client (`wrap`, prioritaire) ou la console de repli. */
  kind?: LauncherKind;
}

export interface LocalOathrion {
  endpoint: string;
  baseUrl: string;
  key: string;
  /** La clé d'approbation du relais, seulement avec `approveInClient`. */
  approverKey: string | null;
  stateDir: string;
  process: ChildProcess;
  /** Se résout quand le serveur local s'arrête, avec son code de sortie. */
  exited: Promise<number | null>;
  stop(): void;
}

/** `~/.oathrion`, ou `OATHRION_WRAP_HOME` (les tests y mettent un dossier jetable). */
export function stateRoot(env: NodeJS.ProcessEnv): string {
  return env.OATHRION_WRAP_HOME?.trim() || join(homedir(), ".oathrion");
}

/**
 * Le paquet du serveur local, `oathrion-local.cjs` :
 *   · `OATHRION_LOCAL_BUNDLE` s'il est donné ;
 *   · à côté de ce fichier — c'est le cas de la commande compilée (`dist/oathrion.mjs`) et
 *     du paquet npm, où les deux voyagent ensemble ;
 *   · sinon dans `dist/` du dépôt, quand la commande tourne depuis les sources (`tsx`).
 */
export function localBundle(env: NodeJS.ProcessEnv): string {
  const override = env.OATHRION_LOCAL_BUNDLE?.trim();
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join(here, "oathrion-local.cjs");
  return existsSync(beside) ? beside : resolve(here, "..", "..", "dist", "oathrion-local.cjs");
}

/*
 * UN SEUL LANCEMENT À LA FOIS PAR SERVEUR. Trouvé le 28 octobre 2026 dans l'essai réel
 * (STRESS-TEST-LOG §5.54) : Cursor lançait `wrap`, dont le serveur local attendait encore
 * `npx` ; `oathrion console`, lancée pendant ce temps, voyait le port muet, croyait le client
 * fermé et démarrait SON serveur sur le même port ; le relais de Cursor, voyant le port
 * répondre, parlait à ce serveur-là avec une clé qu'il ne connaissait pas — 401 sur tout.
 *
 * Le verrou est un fichier créé en exclusivité (`wx`) qui porte le PID du lanceur et sa
 * nature (`wrap` ou `console`). Un PID mort, ou qui n'est plus un `node` d'Oathrion, est un
 * verrou abandonné : on le reprend.
 *
 * LE CLIENT A LA PRIORITÉ. `oathrion console` n'est qu'un repli, quand le client est fermé ;
 * un `wrap` qui la trouve en place lui demande de s'arrêter (SIGTERM), attend qu'elle rende le
 * verrou, puis démarre. Sans cela, une console restée ouverte coupait le client de son
 * serveur — vu dans le même essai, §5.55.
 */
export const LOCK_FILE = "lancement.pid";

function isLauncherAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return /oathrion/.test(readFileSync(`/proc/${String(pid)}/cmdline`, "utf8"));
  } catch {
    /* Pas de /proc (macOS, Windows) : le signal 0 a répondu, on le croit vivant. */
    return true;
  }
}

export type LauncherKind = "wrap" | "console";

/** Qui tient le serveur de ce dossier, s'il est vivant ; sinon `null`. */
export function lockInfo(stateDir: string): { pid: number; kind: LauncherKind } | null {
  try {
    const [pidText, kindText] = readFileSync(join(stateDir, LOCK_FILE), "utf8").trim().split(/\s+/);
    const pid = Number(pidText);
    if (!isLauncherAlive(pid) || pid === process.pid) return null;
    return { pid, kind: kindText === "console" ? "console" : "wrap" };
  } catch {
    return null;
  }
}

/** Le PID du lanceur qui tient le serveur de ce dossier, s'il est vivant ; sinon `null`. */
export function lockHolder(stateDir: string): number | null {
  return lockInfo(stateDir)?.pid ?? null;
}

/** Prend le verrou, ou dit qui le tient. Rend la fonction qui le relâche. */
async function acquireLock(stateDir: string, name: string, kind: LauncherKind, log: (line: string) => void): Promise<() => void> {
  const file = join(stateDir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${String(process.pid)} ${kind}`);
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, "utf8").trim().split(/\s+/)[0] === String(process.pid)) unlinkSync(file);
        } catch {
          /* déjà parti */
        }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = lockInfo(stateDir);
      if (holder !== null && kind === "wrap" && holder.kind === "console") {
        /* Le client revient : la console de repli lui rend le serveur. */
        log(`[oathrion wrap] "oathrion console" was holding "${name}" (process ${String(holder.pid)}): it is closed, your client takes over.`);
        try {
          process.kill(holder.pid, "SIGTERM");
        } catch {
          /* déjà partie */
        }
        const deadline = Date.now() + 20_000;
        while (lockInfo(stateDir) !== null && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
        continue;
      }
      if (holder !== null) {
        throw new Error(
          `"${name}" is already running (process ${String(holder.pid)}): another "oathrion wrap", or "oathrion console". ` +
            `Only one at a time per server: they would share the same receipt chain. An open console closes with Ctrl+C in its terminal.`,
        );
      }
      /* Abandonné : son lanceur est mort. On le retire, puis on réessaie une fois. */
      try {
        unlinkSync(file);
      } catch {
        /* un autre l'a retiré entre-temps */
      }
    }
  }
  throw new Error(`The lock for "${name}" could not be taken (${file}).`);
}

/** La commande du dernier lancement, gardée dans le dossier d'état. */
export const COMMAND_FILE = "commande.json";

/** La commande enregistrée par le dernier `oathrion wrap` de ce serveur, ou `null`. */
export function readSavedCommand(stateDir: string): { command: string; args: string[]; cwd?: string } | null {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, COMMAND_FILE), "utf8")) as { command?: unknown; args?: unknown; cwd?: unknown };
    if (typeof saved.command !== "string" || saved.command === "") return null;
    if (!Array.isArray(saved.args) || !saved.args.every((arg) => typeof arg === "string")) return null;
    return { command: saved.command, args: saved.args as string[], ...(typeof saved.cwd === "string" && saved.cwd !== "" ? { cwd: saved.cwd } : {}) };
  } catch {
    return null;
  }
}

function readOrCreate(file: string, make: () => string): string {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const value = make();
  writeFileSync(file, value, { mode: 0o600 });
  return value;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

export async function launchLocalOathrion(options: LaunchOptions): Promise<LocalOathrion> {
  const bundle = localBundle(options.env);
  if (!existsSync(bundle)) {
    throw new Error(`The local server was not found (${bundle}). Build it first: npm run build.`);
  }
  const stateDir = join(stateRoot(options.env), options.name);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireLock(stateDir, options.name, options.kind ?? "wrap", options.log);
  try {
    return await launchLocked(options, bundle, stateDir, releaseLock);
  } catch (error) {
    releaseLock();
    throw error;
  }
}

async function launchLocked(options: LaunchOptions, bundle: string, stateDir: string, releaseLock: () => void): Promise<LocalOathrion> {

  const secret = readOrCreate(join(stateDir, "session.secret"), () => randomBytes(48).toString("base64url"));
  const portFile = join(stateDir, "port");
  let port = options.port ?? (existsSync(portFile) ? Number(readFileSync(portFile, "utf8").trim()) : 0);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) port = await freePort();
  if (!(await portIsFree(port))) {
    throw new Error(
      `Port ${String(port)} is already taken — probably another "oathrion wrap", or "oathrion console", ` +
        `for "${options.name}". Only one at a time per server: they would share the same receipt chain. ` +
        `An open console closes with Ctrl+C in its terminal.`,
    );
  }
  writeFileSync(portFile, String(port), { mode: 0o600 });
  /* La commande, pour qu'`oathrion console` puisse relancer le même serveur sans le client. */
  const childCwd = options.cwd ?? process.cwd();
  writeFileSync(join(stateDir, COMMAND_FILE), `${JSON.stringify({ command: options.command, args: options.args, cwd: childCwd })}\n`, { mode: 0o600 });

  const key = `oathrion_${randomBytes(32).toString("base64url")}`;
  const approverKey = options.approveInClient ? `oathrion_${randomBytes(32).toString("base64url")}` : null;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const logFile = createWriteStream(join(stateDir, "oathrion.log"), { flags: "a", mode: 0o600 });

  const child = spawn(process.execPath, [bundle], {
    cwd: stateDir,
    env: {
      ...options.env,
      PORT: String(port),
      OATHRION_HOST: "127.0.0.1",
      OATHRION_DB: join(stateDir, "oathrion.db"),
      OATHRION_ACCOUNTS: "database",
      OATHRION_SESSION_SECRET: secret,
      OATHRION_WRAP_NAME: options.name,
      OATHRION_WRAP_COMMAND: JSON.stringify([options.command, ...options.args]),
      OATHRION_LOCAL_AGENT_KEY: key,
      ...(approverKey ? { OATHRION_LOCAL_APPROVER_KEY: approverKey } : {}),
      OATHRION_LOCAL_STATE_DIR: stateDir,
      OATHRION_WRAP_CWD: childCwd,
      /* L'entrée reste ouverte et muette : sa fermeture dit au serveur local que ce relais a disparu. */
      OATHRION_LOCAL_PARENT_PIPE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.on("error", () => undefined);

  /*
   * Tout au journal ; les lignes qui comptent pour la personne, sur la sortie d'erreur.
   * Et le signal de disponibilité : NOTRE serveur dit qu'il écoute. Un port qui répond ne
   * suffit pas — ce pourrait être un autre serveur (§5.54).
   */
  let pending = "";
  let listening = false;
  const listeningLine = `listening on 127.0.0.1:${String(port)}`;
  const forward = (chunk: Buffer) => {
    logFile.write(chunk);
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.includes(listeningLine)) listening = true;
      if (/^\[oathrion wrap\]|^\s+http:\/\/127\.0\.0\.1|cannot start|^\S*Error\b/.test(line)) options.log(line);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);

  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  let stopped = false;
  void exited.then(() => {
    stopped = true;
    logFile.end();
    releaseLock();
  });

  const started = Date.now();
  for (;;) {
    if (stopped) throw new Error(`The local server stopped while starting. Log: ${join(stateDir, "oathrion.log")}`);
    if (Date.now() - started > READY_TIMEOUT_MS) {
      child.kill("SIGTERM");
      throw new Error(`The local server is not ready after ${String(READY_TIMEOUT_MS / 1000)} s. Log: ${join(stateDir, "oathrion.log")}`);
    }
    try {
      if (listening && (await fetch(`${baseUrl}/api/ready`)).status === 200) break;
    } catch {
      /* pas encore à l'écoute */
    }
    await new Promise((done) => setTimeout(done, 250));
  }

  return {
    endpoint: `${baseUrl}/api/mcp`,
    baseUrl,
    key,
    approverKey,
    stateDir,
    process: child,
    exited,
    stop: () => {
      if (!stopped) child.kill("SIGTERM");
    },
  };
}
