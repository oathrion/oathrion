/**
 * `oathrion watch` — LA VEILLE DES AGENTS, EN PERMANENCE (10 novembre : « comme un antivirus,
 * mais pour les agents d'IA »).
 *
 * La veille tourne dans le pivot local (`server/local-agent-watch.ts`), qui s'arrête quand plus
 * rien n'y est rattaché. `oathrion watch` s'y rattache et le relance s'il s'arrête.
 *
 *   · `oathrion watch --always` (et `npx oathrion`, sous Linux) en fait un SERVICE de la session
 *     (systemd, `~/.config/systemd/user/oathrion-watch.service`) : démarré avec la session, même
 *     sans bureau, et relancé par systemd s'il s'arrête ou est tué. Sans systemd : le démarrage
 *     automatique du bureau, et lancé tout de suite. `--undo` retire l'un et l'autre ;
 *   · Oathrion mis à jour : il le voit (son propre fichier a changé) et se relance avec la
 *     nouvelle version ; il n'attache jamais un pivot plus ancien que le paquet installé.
 *
 * Ce qui l'arrête pour de bon : `systemctl --user disable --now oathrion-watch` — ce qu'un agent
 * qui tourne HORS d'une prison, avec les droits de la personne, peut faire ; un agent enfermé
 * ne le peut pas (il n'a pas accès au bus de la session).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OutsideAllowances } from "../../server/local-agent-watch";
import { LocalEvents } from "../../server/local-events";
import { ensureHub, hubDir, hubIsStale, HubSession } from "./hub";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const quote = (text: string) => `"${text.replace(/(["\\$`])/g, "\\$1")}"`;

/** Le fichier de démarrage automatique du bureau (la norme XDG, que GNOME, KDE et les autres suivent). */
export function autostartEntry(node: string, script: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Oathrion watch",
    "Comment=Tells you when an AI agent runs outside Oathrion's protection",
    `Exec=${quote(node)} ${quote(script)} watch`,
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Le service systemd de la session : relancé s'il s'arrête, démarré avec la session. */
export function serviceUnit(node: string, script: string, path: string): string {
  return [
    "[Unit]",
    "Description=Oathrion agent watch: tells you when an AI agent runs outside Oathrion's protection",
    "",
    "[Service]",
    `ExecStart=${quote(node)} ${quote(script)} watch`,
    "Restart=always",
    "RestartSec=5",
    `Environment=${quote(`PATH=${path}`)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export const SERVICE_NAME = "oathrion-watch.service";

/** Poser, retirer, savoir : la veille permanente. `systemctl` est injectable (les essais n'y touchent jamais). */
export interface WatchInstaller {
  installed(): boolean;
  /** « systemd » (un service relancé) ou « autostart » (le démarrage du bureau, lancé tout de suite). */
  install(): "systemd" | "autostart";
  remove(): void;
}

export function watchInstaller(options: {
  home: string;
  script: string;
  env: NodeJS.ProcessEnv;
  systemctl?: (args: string[]) => boolean;
  startNow?: (node: string, script: string) => void;
}): WatchInstaller {
  const unitFile = join(options.home, ".config", "systemd", "user", SERVICE_NAME);
  const autostart = join(options.home, ".config", "autostart", "oathrion-watch.desktop");
  const systemctl = options.systemctl ?? ((args: string[]) => spawnSync("systemctl", ["--user", ...args], { stdio: "ignore", timeout: 20_000 }).status === 0);
  const startNow =
    options.startNow ??
    ((node: string, script: string) => {
      spawn(node, [script, "watch"], { detached: true, stdio: "ignore", env: options.env }).unref();
    });
  /* Le gestionnaire de services de la session répond-il ? (Sans lui : le démarrage du bureau.) */
  const systemdHere = () => systemctl(["show-environment"]);
  return {
    /*
     * Posée : le service ; ou, sans systemd, le démarrage du bureau. Un ancien démarrage du bureau
     * (la première version de `--always`) là où systemd répond n'est pas la veille permanente :
     * `npx oathrion` la propose, et le remplace par le service (essai réel du 10 novembre).
     */
    installed: () => existsSync(unitFile) || (existsSync(autostart) && !systemdHere()),
    install: () => {
      const script = realpathSync(options.script);
      mkdirSync(join(options.home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(unitFile, serviceUnit(process.execPath, script, options.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"), { mode: 0o644 });
      if (systemctl(["daemon-reload"]) && systemctl(["enable", "--now", SERVICE_NAME])) {
        rmSync(autostart, { force: true });
        return "systemd";
      }
      /* Pas de systemd pour la session : le démarrage automatique du bureau, et tout de suite. */
      rmSync(unitFile, { force: true });
      mkdirSync(join(options.home, ".config", "autostart"), { recursive: true });
      writeFileSync(autostart, autostartEntry(process.execPath, script), { mode: 0o644 });
      startNow(process.execPath, script);
      return "autostart";
    },
    remove: () => {
      if (existsSync(unitFile)) {
        systemctl(["disable", "--now", SERVICE_NAME]);
        rmSync(unitFile, { force: true });
        systemctl(["daemon-reload"]);
      }
      rmSync(autostart, { force: true });
    },
  };
}

export async function runWatch(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void; env: NodeJS.ProcessEnv; home: string; script: string; installer?: WatchInstaller },
): Promise<number> {
  /*
   * `oathrion watch --forget <agent>` : retirer l'autorisation d'un agent hors de la prison, sans
   * console (11 novembre : l'autorisation donnée d'un clic restait, et la personne ne trouvait
   * pas où la retirer). Son prochain lancement dehors est de nouveau mis en pause.
   */
  const forgetAt = argv.indexOf("--forget");
  if (forgetAt !== -1) {
    const name = argv[forgetAt + 1];
    const allowances = new OutsideAllowances(hubDir(io.env));
    const listed = allowances.list();
    if (!name) {
      const entries = Object.entries(listed);
      io.out(entries.length === 0 ? "No agent is allowed outside the jail." : "Allowed outside the jail:");
      for (const [exe, a] of entries) io.out(`  ${a.agent}  ${exe}  (by ${a.by}, ${a.at.slice(0, 16).replace("T", " ")})`);
      if (entries.length > 0) io.out("« oathrion watch --forget <agent> » removes one.");
      return 0;
    }
    const matching = Object.entries(listed).filter(([exe, a]) => a.agent === name || exe === name || exe.endsWith(`/${name}`));
    if (matching.length === 0) {
      io.err(`${name} is not allowed outside the jail. « oathrion watch --forget » lists those that are.`);
      return 2;
    }
    for (const [exe] of matching) allowances.revoke(exe);
    new LocalEvents(hubDir(io.env)).record({ kind: "forgotten", agent: name, by: "you, oathrion watch --forget" });
    io.out(`Oathrion · ${name} is no longer allowed outside the jail: started outside it, it is paused, and you are asked.`);
    return 0;
  }
  if (argv.includes("--always")) {
    if (process.platform !== "linux") {
      io.err("The agent watch works on Linux for now.");
      return 2;
    }
    const installer = io.installer ?? watchInstaller({ home: io.home, script: io.script, env: io.env });
    if (argv.includes("--undo")) {
      installer.remove();
      io.out("Oathrion · the agent watch is off, and no longer starts with your session.");
      return 0;
    }
    const how = installer.install();
    io.out("Oathrion · the agent watch is on, for good: an AI agent running outside Oathrion's jail, you are told.");
    io.out(how === "systemd" ? "  It runs as a service of your session: started with it, and started again if it stops." : "  It starts with your desktop session, and runs now.");
    io.out("  « oathrion watch --always --undo » turns it off.");
    return 0;
  }
  if (process.platform !== "linux") {
    io.err("The agent watch works on Linux for now.");
    return 2;
  }

  const script = realpathSync(io.script);
  const printOf = () => {
    try {
      const stat = statSync(script);
      return `${String(stat.size)}:${String(stat.mtimeMs)}`;
    } catch {
      return "";
    }
  };
  const startedWith = printOf();
  const dir = hubDir(io.env);

  io.out("Oathrion · watching for AI agents running outside Oathrion's protection. Ctrl+C stops it.");
  for (;;) {
    /* Jamais rattaché à un pivot plus ancien que le paquet installé : on attend qu'il s'arrête. */
    if (existsSync(join(dir, "port")) && hubIsStale(io.env, dir)) {
      const conn = await ensureHub(io.env, { log: () => undefined }).catch(() => null);
      if (conn?.wasRunning && hubIsStale(io.env, dir)) {
        /*
         * Il laisse la place tout de suite s'il ne sert aucun agent (pas de trou d'une demi-minute
         * après une mise à jour, essai réel du 10 novembre) ; sinon on attend qu'il s'arrête.
         */
        const asked = await conn.op({ op: "retire" }).catch(() => null);
        if (asked?.status !== 202) {
          await wait(10_000);
          continue;
        }
        /* Qu'il ait libéré son port : le neuf le reprend, et la console déjà ouverte le retrouve. */
        for (let i = 0; i < 40 && (await conn.op({ op: "status" }).catch(() => null)) !== null; i += 1) await wait(250);
        continue;
      }
    }
    const conn = await ensureHub(io.env, { log: () => undefined });
    const holder = new HubSession(conn, "console", io.env);
    await holder.attach();
    holder.startHeartbeat(() => undefined);
    /* Toutes les minutes : Oathrion a-t-il été mis à jour ? Alors on se relance avec la nouvelle version. */
    for (;;) {
      await wait(Number(io.env.OATHRION_WATCH_CHECK_MS) || 60_000);
      if (printOf() !== startedWith) {
        await holder.detach();
        /* Sous systemd, il le relance lui-même (avec le nouveau fichier) ; sinon, on se relance. */
        if (!io.env.INVOCATION_ID) spawn(process.execPath, [script, "watch"], { detached: true, stdio: "ignore", env: io.env }).unref();
        io.out("Oathrion · updated: the agent watch starts again with the new version.");
        return 0;
      }
    }
  }
}
