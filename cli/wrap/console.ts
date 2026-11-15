/**
 * `oathrion console [--name <serveur>] [--sans-navigateur]` — la console du pivot local.
 *
 * Un seul Oathrion par machine (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`), donc une seule
 * console, pour tous les serveurs et tous les clients. Elle s'ouvre DÉJÀ CONNECTÉE : un lien à
 * ticket signé, de deux minutes, à usage unique (`shared/local-login-ticket.ts`).
 *
 *   · un client tourne déjà : la commande donne un lien neuf, ouvre le navigateur, et rend la
 *     main ;
 *   · aucun client : elle lance le pivot, y relance les serveurs déjà connus (leur commande,
 *     l'environnement de ce terminal) pour qu'une action approuvée s'exécute vraiment, et reste
 *     attachée jusqu'à Ctrl+C. Un client qui arrive pendant ce temps partage simplement le
 *     pivot : plus de « reprise », plus de refus.
 *
 * Codes de sortie : 0 · 3 usage · 4 le pivot n'a pas pu être lancé.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { mintLocalLoginTicket } from "@shared/local-login-ticket";

import { ensureHub, HubSession } from "./hub";
import { nameProblem } from "./name";

export const CONSOLE_USAGE = `
oathrion console [--name <server>] [--no-browser]

  Opens Oathrion's console, already signed in: approve what is waiting, grant a
  permission, change a rule. If your client is closed, it restarts the servers it already
  knows (--name: just one), with this terminal's environment, and stays open until Ctrl+C.

  --no-browser   prints the sign-in link without opening the browser. The link works once,
                 for two minutes; the command gives a new one each time.

  The link grants full rights: it is printed, and the browser opened, only in a terminal.
  Run without a terminal (by an agent's tool, for example), the command only gives the
  console's address, which asks you to run it in your terminal.
`;

/** Ouvre le lien dans le navigateur de la personne ; un échec n'est pas une erreur, le lien est imprimé. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const opener = spawn(command, args as string[], { detached: true, stdio: "ignore" });
    opener.on("error", () => undefined);
    opener.unref();
  } catch {
    /* le lien est imprimé : la personne l'ouvrira */
  }
}

/** Les serveurs que le pivot a déjà lancés une fois, avec leur commande. */
function knownServers(dir: string): { name: string; command: string; args: string[]; cwd?: string }[] {
  const root = join(dir, "serveurs");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    try {
      const saved = JSON.parse(readFileSync(join(root, name, "commande.json"), "utf8")) as { command?: unknown; args?: unknown; cwd?: unknown };
      if (typeof saved.command !== "string" || !Array.isArray(saved.args)) return [];
      return [{ name, command: saved.command, args: saved.args.map(String), ...(typeof saved.cwd === "string" ? { cwd: saved.cwd } : {}) }];
    } catch {
      return [];
    }
  });
}

export async function runConsole(argv: readonly string[], env: NodeJS.ProcessEnv, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  let name: string | undefined;
  let browser = true;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--name") name = argv[++i];
    else if (argv[i] === "--no-browser" || argv[i] === "--sans-navigateur") browser = false;
    else {
      err(`Unknown option: ${String(argv[i])}.${CONSOLE_USAGE}`);
      return 3;
    }
  }
  if (name !== undefined && nameProblem(name)) {
    err(`--name refused: ${String(nameProblem(name))}`);
    return 3;
  }

  let session: HubSession;
  try {
    const conn = await ensureHub(env, { log: err });
    session = new HubSession(conn, "console", env);
    await session.attach();
  } catch (error) {
    err(`[oathrion console] ${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }
  const hub = session.connection;
  const link = () => `${hub.base}/console#/connexion-locale?ticket=${mintLocalLoginTicket(hub.secret)}`;
  /*
   * LE LIEN NE SORT QUE DANS UN TERMINAL (décision B, notes/DECISION-AUTO-APPROBATION.md). Il
   * ouvre une session d'administration : l'outil Bash d'un agent n'a pas de terminal, et il
   * ne doit pas lire ce lien pour approuver sa propre demande — ni ouvrir un navigateur qu'un
   * agent qui pilote le navigateur pourrait cliquer. Ce n'est pas une frontière contre un
   * agent déterminé qui a un terminal libre (il lit le secret, la base, les jetons) : c'est
   * le chemin naturel qui est fermé. `OATHRION_CONSOLE_LIEN=1` : pour les tests et les bancs.
   */
  const interactive = process.stdout.isTTY === true || env.OATHRION_CONSOLE_LIEN === "1";
  const offer = () => {
    if (!interactive) {
      out("The sign-in link is only given in a terminal: it opens the console with full rights.");
      out('Run "oathrion console" in your terminal, or use the "Decide" button of a notification.');
      return;
    }
    const url = link();
    out(`Direct sign-in (works once, for two minutes): ${url}`);
    if (browser) openBrowser(url);
  };
  const status = await session.status();

  /* Un client tourne : le pivot sert déjà ses serveurs. Un lien, et la main rendue. */
  if (hub.wasRunning && status.servers.length > 0) {
    await session.detach();
    out(`The console is already open (your client is running): ${hub.base}/console`);
    offer();
    return 0;
  }

  /* Aucun client : relancer les serveurs connus, pour qu'une action approuvée s'exécute. */
  const known = knownServers(hub.dir).filter((server) => name === undefined || server.name === name);
  if (name !== undefined && known.length === 0) {
    err(`"${name}" is not known: start it once with "oathrion wrap" from your client.`);
  }
  for (const server of known) {
    if (status.servers.includes(server.name)) continue;
    try {
      await session.attachServer({ ...server, env });
      out(`"${server.name}" restarted: an action approved here will run.`);
    } catch (error) {
      err(`"${server.name}" could not be restarted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (known.length === 0 && name === undefined) out("No server yet: start your client once, and it will register them.");

  out(`Console: ${hub.base}/console`);
  offer();
  out("Ctrl+C to close. Your client, if it starts, shares this same Oathrion.");

  session.startHeartbeat(() => undefined);
  /* Les battements ne retiennent pas le processus : ceci le garde ouvert jusqu'à Ctrl+C. */
  const keepOpen = setInterval(() => undefined, 1 << 30);
  await new Promise<void>((done) => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => done());
  });
  clearInterval(keepOpen);
  await session.detach();
  out("Console closed.");
  return 0;
}
