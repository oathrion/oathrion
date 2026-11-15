/**
 * `oathrion install <cursor|claude-code>` — mettre Oathrion devant les serveurs MCP d'un
 * client, sans éditer son JSON à la main.
 *
 * Le parcours d'une personne qui découvre Oathrion commençait par une édition de JSON
 * (STRESS-TEST-LOG §5.57) : remplacer la commande de chaque serveur par
 * `oathrion wrap -- <la même commande>`, sans se tromper, et sans laisser le serveur d'origine
 * ailleurs — sinon l'agent passe à côté. Cette commande le fait, et seulement avec l'accord de
 * la personne :
 *
 *   · elle MONTRE chaque changement avant de l'appliquer, et demande ;
 *   · elle garde une copie du fichier (`<fichier>.avant-oathrion-<date>`), jamais écrasée ;
 *   · elle laisse tels quels un serveur distant (URL : `wrap` ne gouverne que les serveurs
 *     lancés en local) et un serveur déjà sous Oathrion ;
 *   · elle prévient si le même serveur est encore déclaré ailleurs, sans Oathrion ;
 *   · `--annuler` remet chaque serveur comme il était.
 *
 * Codes de sortie : 0 · 1 refusé par la personne · 3 usage ou fichier illisible.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const INSTALL_USAGE = `
oathrion install <cursor|claude-code> [--global] [--file <path>] [--approval console] [--yes] [--undo]

  Puts Oathrion in front of every MCP server in the client's configuration: each command
  becomes "npx -y oathrion@<this version> wrap --name <name> -- <the same command>" (or,
  when Oathrion is installed, this installation run by node). Shows the changes,
  asks for your approval, and keeps a copy of the file.

  cursor        .cursor/mcp.json in the current folder (--global: ~/.cursor/mcp.json)
  claude-code   .mcp.json in the current folder
  --file        another configuration file (same shape: { "mcpServers": { … } })
  --approval console  decide only in the console (default: in the client when it can
                      ask, otherwise in the console)
  --yes         apply without asking (otherwise: a question, or a refusal outside a terminal)
  --undo        put every server back as it was before Oathrion
`;

/*
 * Les options en anglais depuis le 2 novembre 2026 ; les anciennes, en français, restent
 * comprises : des configurations écrites par la préversion 0 portent `--approbation`.
 */
export const FLAG_ALIASES: Readonly<Record<string, string>> = {
  "--annuler": "--undo",
  "--sauf": "--except",
  "--approbation": "--approval",
  "--garder-questions-claude": "--keep-claude-prompts",
  "--oui": "--yes",
  "--fichier": "--file",
  "--attendre": "--wait",
  "--sans-navigateur": "--no-browser",
};

/** Le nom anglais d'une option, qu'elle soit écrite en anglais ou en français. */
export const flagName = (flag: string | undefined): string | undefined => (flag === undefined ? undefined : (FLAG_ALIASES[flag] ?? flag));

interface ServerConfig {
  command?: unknown;
  args?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Un nom de serveur utilisable par `wrap`, tiré de sa clé dans la configuration. */
export function wrapNameFor(key: string): string {
  const name = key.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 63);
  return NAME.test(name) ? name : "server";
}

/** Le serveur passe-t-il déjà par Oathrion ? */
export function isWrapped(server: ServerConfig): boolean {
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  const words = [String(server.command ?? ""), ...args];
  return words.some((word) => /(^|[\\/@])oathrion(\.mjs)?$|^oathrion@/.test(word)) && args.includes("wrap");
}

/** Comment le client lancera Oathrion : `npx -y oathrion…`, ou le fichier même qui tourne. */
export interface Launcher {
  command: string;
  prefix: string[];
}

export const NPX_LAUNCHER: Launcher = { command: "npx", prefix: ["-y", "oathrion"] };

/**
 * Le client lancera la MÊME Oathrion que celle qui tourne : par `npx`, à la version exacte
 * (aucun paquet changé en douce, et le cache de npx suffit) ; installée ou construite, par son
 * chemin.
 */
export function launcherFor(script: string | undefined, version: string, node = process.execPath, platform: NodeJS.Platform = process.platform): Launcher {
  if (!script || /[\\/]_npx[\\/]/.test(script)) {
    /* Windows (hors WSL) : `npx` est un script `.cmd`, qu'un client ne lance que par `cmd /c` (documentation de Claude Code). */
    return platform === "win32" ? { command: "cmd", prefix: ["/c", "npx", "-y", `oathrion@${version}`] } : { command: "npx", prefix: ["-y", `oathrion@${version}`] };
  }
  return { command: node, prefix: [script] };
}

/** Les en-têtes d'un serveur distant, passés au pont (`cli/wrap/bridge.ts`), jamais en argument. */
const REMOTE_HEADERS = "MCP_REMOTE_HEADERS";

const hasHeaders = (server: ServerConfig) => server.headers !== null && typeof server.headers === "object" && Object.keys(server.headers as object).length > 0;

/**
 * La commande d'un serveur, mise derrière Oathrion. Un serveur distant (`url`) devient un
 * serveur local : `oathrion wrap --url …`, ses en-têtes dans l'environnement ; un `type`
 * (`http`, `sse` : Claude Code) devient `stdio`.
 */
export function wrapServer(key: string, server: ServerConfig, consoleOnly: boolean, launcher: Launcher = NPX_LAUNCHER): ServerConfig {
  const head = [...launcher.prefix, "wrap", "--name", wrapNameFor(key), ...(consoleOnly ? ["--approval", "console"] : [])];
  if (typeof server.url === "string") {
    const { url, headers, type, ...rest } = server;
    const env = { ...((rest.env as Record<string, string> | undefined) ?? {}), ...(hasHeaders(server) ? { [REMOTE_HEADERS]: JSON.stringify(headers) } : {}) };
    return {
      ...rest,
      ...(type !== undefined ? { type: "stdio" } : {}),
      command: launcher.command,
      args: [...head, "--url", url, "--transport", type === "sse" ? "sse" : "http"],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  return { ...server, command: launcher.command, args: [...head, "--", String(server.command), ...args] };
}

/** L'inverse : la commande d'origine, lue après « -- », ou le serveur distant de `--url`. `null` si la forme n'est pas reconnue. */
export function unwrapServer(server: ServerConfig): ServerConfig | null {
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  const urlAt = args.indexOf("--url");
  if (urlAt !== -1 && urlAt < args.length - 1 && !args.includes("--")) {
    const transport = args[args.indexOf("--transport") + 1] === "sse" ? "sse" : "http";
    const { command: _command, args: _args, env, type, ...rest } = server;
    const { [REMOTE_HEADERS]: rawHeaders, ...otherEnv } = (env as Record<string, string> | undefined) ?? {};
    let headers: unknown;
    try {
      headers = rawHeaders === undefined ? undefined : (JSON.parse(rawHeaders) as unknown);
    } catch {
      return null;
    }
    return {
      ...rest,
      ...(type !== undefined ? { type: transport } : {}),
      url: args[urlAt + 1],
      ...(headers !== undefined ? { headers } : {}),
      ...(Object.keys(otherEnv).length > 0 ? { env: otherEnv } : {}),
    };
  }
  const separator = args.indexOf("--");
  if (separator === -1 || separator === args.length - 1) return null;
  const [command, ...rest] = args.slice(separator + 1) as [string, ...string[]];
  return { ...server, command, args: rest };
}

export interface Change {
  key: string;
  before: ServerConfig;
  after: ServerConfig;
  /** Un serveur déjà protégé dont les jetons sont encore dans la configuration : on les déplace (`server-secrets.ts`). */
  sealOnly?: boolean;
}

/**
 * Ce qui changerait dans une liste de serveurs : mettre Oathrion devant (`wrap`), ou l'en
 * retirer (`undo`). Les serveurs laissés tels quels sont dits dans `notes`, avec la raison.
 */
export function planChanges(
  servers: Record<string, ServerConfig>,
  undo: boolean,
  wrap: (key: string, server: ServerConfig) => ServerConfig,
  /** Le coffre : rendre ses jetons à un serveur avant de le défaire (`--undo`), et repérer ceux encore à déplacer. */
  vault?: { restore: (key: string, server: ServerConfig) => ServerConfig; hasSecrets: (server: ServerConfig) => boolean },
): { changes: Change[]; notes: { key: string; reason: string }[] } {
  const changes: Change[] = [];
  const notes: { key: string; reason: string }[] = [];
  for (const [key, server] of Object.entries(servers)) {
    if (server === null || typeof server !== "object") continue;
    if (undo) {
      if (!isWrapped(server)) continue;
      const original = unwrapServer(vault ? vault.restore(key, server) : server);
      if (original) changes.push({ key, before: server, after: original });
      else notes.push({ key, reason: "unrecognised shape, left as is." });
      continue;
    }
    if (typeof server.url === "string" && !hasHeaders(server)) {
      notes.push({ key, reason: "remote server with no token in the configuration — its sign-in (OAuth) is handled by the client, left as is." });
      continue;
    }
    if (typeof server.url !== "string" && (typeof server.command !== "string" || server.command === "")) {
      notes.push({ key, reason: "no command, left as is." });
      continue;
    }
    if (isWrapped(server)) {
      if (vault?.hasSecrets(server)) changes.push({ key, before: server, after: server, sealOnly: true });
      else notes.push({ key, reason: "already behind Oathrion." });
      continue;
    }
    changes.push({ key, before: server, after: wrap(key, server) });
  }
  return { changes, notes };
}

/** Une copie du fichier avant d'y toucher, jamais écrasée, lisible par la seule personne (des jetons peuvent y être). */
export function backupFile(path: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let backup = `${path}.before-oathrion-${stamp}`;
  for (let n = 2; existsSync(backup); n += 1) backup = `${path}.before-oathrion-${stamp}-${String(n)}`;
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  return backup;
}

export const show = (server: ServerConfig) => {
  /*
   * Un serveur DISTANT n'a pas de commande, mais une adresse : la liste montrait une colonne vide
   * (vu le 9 novembre avec `placet-local`). L'adresse est montrée sans identifiants, requête ni
   * fragment, qui peuvent porter un jeton.
   */
  if (server.command === undefined && typeof server.url === "string") {
    try {
      const url = new URL(server.url);
      return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return "(remote server)";
    }
  }
  return [String(server.command ?? ""), ...(Array.isArray(server.args) ? server.args.map(String) : [])].join(" ");
};

export interface InstallIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Pose la question ; `null` quand personne ne peut répondre (pas de terminal). Entrée seule : `defaultYes`. */
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean | null>;
  cwd: string;
  home?: string;
  now?: () => Date;
  /** Le fichier de la commande qui tourne (`process.argv[1]`). */
  script?: string;
  /**
   * La version qui tourne. Avec elle, le client lance CETTE Oathrion (`launcherFor`), comme
   * après `npx oathrion`. Sans elle, `npx -y oathrion` sans version : ce que faisait
   * `oathrion install` jusqu'au 5 novembre, relevé en essayant le paquet sur la machine de
   * l'utilisateur — le client serait allé chercher sur npm une autre version que celle
   * installée, et l'aurait téléchargée à son premier lancement.
   */
  version?: string;
}

export async function runInstall(argv: readonly string[], io: InstallIo): Promise<number> {
  const [client, ...flags] = argv;
  let global = false;
  let file: string | undefined;
  let yes = false;
  let undo = false;
  let consoleOnly = false;
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flagName(flags[i]);
    if (flag === "--global") global = true;
    else if (flag === "--file") file = flags[++i];
    else if (flag === "--yes") yes = true;
    else if (flag === "--undo") undo = true;
    else if (flag === "--approval" && (flags[i + 1] === "console" || flags[i + 1] === "client")) {
      /* « client » est le défaut : accepté, sans effet. */
      consoleOnly = flags[i + 1] === "console";
      i += 1;
    }
    else {
      io.err(`Unknown option: ${String(flags[i])}.${INSTALL_USAGE}`);
      return 3;
    }
  }
  const home = io.home ?? homedir();
  if (client !== "cursor" && client !== "claude-code") {
    io.err(INSTALL_USAGE);
    return 3;
  }
  if (client === "claude-code" && global && !file) {
    io.err("For Claude Code, only the project configuration (.mcp.json) is supported; --global is not supported yet.");
    return 3;
  }
  const path = resolve(io.cwd, file ?? (client === "cursor" ? (global ? join(home, ".cursor", "mcp.json") : join(".cursor", "mcp.json")) : ".mcp.json"));
  if (!existsSync(path)) {
    io.err(`No MCP configuration in ${path}. Add your servers to your client first, or name the file with --file.`);
    return 3;
  }
  let config: { mcpServers?: Record<string, ServerConfig> };
  try {
    config = JSON.parse(readFileSync(path, "utf8")) as typeof config;
  } catch (error) {
    io.err(`${path} is not readable JSON (${error instanceof Error ? error.message : String(error)}): nothing was changed.`);
    return 3;
  }
  const servers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};

  const launcher = io.version === undefined ? NPX_LAUNCHER : launcherFor(io.script, io.version);
  const { changes, notes } = planChanges(servers, undo, (key, server) => wrapServer(key, server, consoleOnly, launcher));
  for (const { key, reason } of notes) io.out(`  ${key}: ${reason}`);

  if (changes.length === 0) {
    io.out(undo ? `No server behind Oathrion in ${path}.` : `Nothing to change in ${path}.`);
    return 0;
  }
  io.out(`${undo ? "Remove Oathrion from" : "Put Oathrion in front of"} ${String(changes.length)} server(s), in ${path}:`);
  for (const { key, before, after } of changes) {
    io.out(`  ${key}`);
    io.out(`    before: ${show(before)}`);
    io.out(`    after:  ${show(after)}`);
  }

  /* L'autre configuration de Cursor, chargée elle aussi : le même serveur, sans Oathrion, y laisserait une porte. */
  if (client === "cursor" && !undo) {
    const other = global ? resolve(io.cwd, ".cursor", "mcp.json") : join(home, ".cursor", "mcp.json");
    if (other !== path && existsSync(other)) {
      try {
        const otherServers = (JSON.parse(readFileSync(other, "utf8")) as { mcpServers?: Record<string, ServerConfig> }).mcpServers ?? {};
        for (const { key, before } of changes) {
          const twin = Object.entries(otherServers).find(([k, s]) => !isWrapped(s) && (k === key || show(s) === show(before)));
          if (twin) io.out(`  ! "${twin[0]}" is also declared in ${other}, without Oathrion: your agent could go around it. Run the installation for that file too.`);
        }
      } catch {
        /* illisible : ce n'est pas le fichier qu'on modifie */
      }
    }
  }

  if (!yes) {
    const answer = await io.confirm("Apply these changes? [y/N] ");
    if (answer === null) {
      io.err("No terminal to ask you: run again with --yes to apply. Nothing was changed.");
      return 1;
    }
    if (!answer) {
      io.out("Nothing was changed.");
      return 1;
    }
  }

  const backup = backupFile(path, io.now?.() ?? new Date());
  const next = { ...config, mcpServers: { ...servers } };
  for (const { key, after } of changes) next.mcpServers[key] = after;
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);

  io.out(`Done. Copy of the previous file: ${backup}`);
  if (!undo) {
    io.out(`Restart ${client === "cursor" ? "Cursor" : "Claude Code"}: every call now goes through Oathrion.`);
    io.out(`The console: "npx -y oathrion console --name ${wrapNameFor(changes[0]!.key)}" — it opens already signed in.`);
  }
  return 0;
}
