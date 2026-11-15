/**
 * Ce que les tests de bout en bout du pivot local partagent : un dossier jetable, des durées
 * courtes, la vraie commande compilée, et le repérage des processus de CE pivot — ceux dont le
 * dossier de travail est `<dossier>/_local`, et leur descendance. Rien d'autre n'est touché.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { LocalPrograms } from "../../server/local-programs";
import { clientProgram, sha256OfFile } from "./client-identity";
import { localBundle } from "./launch";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE = join(ROOT, "server", "test", "fixtures", "fake-stdio-mcp-server.cjs");
export const CLI = join(ROOT, "dist", "oathrion.mjs");
export const ready = existsSync(CLI) && existsSync(localBundle({})) && existsSync("/proc/self/stat");

/** Des durées courtes : un porteur muet est détaché en 2 s, le pivot sans porteur s'arrête en 1 s. */
export const FAST = {
  OATHRION_LOCAL_HUB_HOLDER_TIMEOUT_MS: "2000",
  OATHRION_LOCAL_HUB_IDLE_MS: "1000",
  OATHRION_LOCAL_HUB_SWEEP_MS: "200",
  OATHRION_LOCAL_HUB_BEAT_MS: "500",
  /* Pas de notification sur le bureau de la personne pendant les tests. */
  OATHRION_LOCAL_NOTIFY_DESKTOP: "0",
  /* Le lien de la console sans terminal : les tests le lisent (cli/wrap/console.ts). */
  OATHRION_CONSOLE_LIEN: "1",
};

export function freshHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  trustTestRunner(home);
  /*
   * Ni veille permanente ni prison par défaut : `npx oathrion` les poserait dans la vraie session ;
   * et pas de veille des agents dans les pivots d'essai : elle verrait (et mettrait en pause) les
   * vrais agents de la machine ; et jamais notre fenêtre de notification, qui s'afficherait sur
   * l'écran de la personne (10 novembre).
   */
  return { PATH: process.env.PATH ?? "", HOME: home, OATHRION_WRAP_HOME: home, OATHRION_NO_SESSION_CHANGES: "1", OATHRION_LOCAL_AGENT_WATCH: "0", OATHRION_LOCAL_NOTIFY_POPUP: "0", ...FAST, ...extra };
}

/*
 * Les relais de ces essais sont lancés par le programme de test : le pivot ne le connaîtrait
 * pas (`server/local-programs.ts`), et l'environnement du pivot est filtré (aucune variable ne
 * peut lever la quarantaine). On le confirme donc d'avance dans le dossier du pivot, comme
 * `npx oathrion` le fait pour Claude Code.
 */
export function trustTestRunner(home: string, launcherScript?: string): void {
  const program = clientProgram(process.pid);
  if (!program) return;
  const dir = join(home, "_local");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const programs = new LocalPrograms(dir);
  programs.trust("test runner", { ...program }, "hub-test-kit");
  /* Un relais lancé par un lanceur (`node tsx/dist/cli.mjs …`) a ce lanceur pour parent. */
  if (launcherScript) programs.trust("test launcher", { exe: realpathSync(process.execPath), script: realpathSync(launcherScript), sha256: sha256OfFile(realpathSync(process.execPath)), platform: process.platform }, "hub-test-kit");
}

const ppidOf = (pid: number): number | null => {
  try {
    const text = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return Number(text.slice(text.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return null;
  }
};

export const alive = (pid: number): boolean => {
  try {
    const text = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const state = text.slice(text.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
};

export const cmdline = (pid: number): string => {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
};

function allPids(): number[] {
  return readdirSync("/proc").filter((e) => /^\d+$/.test(e)).map(Number);
}

export function descendants(root: number): number[] {
  const pids = allPids();
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const pid of pids) {
      if (ppidOf(pid) !== parent) continue;
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/** Le pivot de ce dossier (et sa descendance), repéré par son dossier de travail. */
export function hubTree(home: string): number[] {
  const dir = join(home, "_local");
  const hubs = allPids().filter((pid) => {
    try {
      return readlinkSync(`/proc/${String(pid)}/cwd`) === dir && cmdline(pid).includes("oathrion-local.cjs");
    } catch {
      return false;
    }
  });
  return hubs.flatMap((pid) => [pid, ...descendants(pid)]);
}

/** Attend que la condition soit vraie, ou échoue en le disant. */
export async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

export interface Cli {
  proc: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: () => Promise<number | null>;
}

export function cli(home: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Cli {
  const proc = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd, env: envFor(home, options.env), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout!.on("data", (c: Buffer) => (out += c.toString()));
  proc.stderr!.on("data", (c: Buffer) => (err += c.toString()));
  return {
    proc,
    stdout: () => out,
    stderr: () => err,
    exited: () => new Promise((done) => (proc.exitCode !== null || proc.signalCode !== null ? done(proc.exitCode) : proc.once("exit", (code) => done(code)))),
  };
}

/** Un client MCP : la vraie commande `wrap`, à qui l'on parle en stdio. */
export function mcpClient(home: string, name: string, client: string, options: { args?: string[]; cwd?: string; env?: Record<string, string>; wrapArgs?: string[] } = {}) {
  const run = cli(home, ["wrap", "--name", name, "--attendre", "0", ...(options.wrapArgs ?? []), "--", ...(options.args ?? [process.execPath, FAKE])], options);
  const answers = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: run.proc.stdout! }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (typeof message.id === "number") answers.get(message.id)?.(message as Record<string, unknown>);
  });
  let next = 1;
  const ask = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((done) => {
      const id = next++;
      answers.set(id, done);
      run.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    ...run,
    ask,
    initialize: () => ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1" } }),
    async toolNames(): Promise<string[]> {
      const listed = (await ask("tools/list")) as { result?: { tools?: { name: string }[] } };
      return (listed.result?.tools ?? []).map((t) => t.name).sort();
    },
    async close(): Promise<number | null> {
      run.proc.stdin!.end();
      return run.exited();
    },
  };
}
