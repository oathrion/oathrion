/**
 * `npx oathrion` — mettre Oathrion devant TOUS les serveurs MCP de la machine, en une commande
 * et une réponse.
 *
 * `oathrion install <client>` demandait de savoir quel client, quel fichier, quelles options ;
 * et il ne voyait pas les serveurs ajoutés par `claude mcp add`, la façon la plus courante, qui
 * vivent dans `~/.claude.json` (essai du 28 octobre 2026, STRESS-TEST-LOG §5.62). Ici, rien à
 * savoir :
 *
 *   · Cursor : `~/.cursor/mcp.json` et `.cursor/mcp.json` du dossier courant ;
 *   · Claude Code : `.mcp.json` du dossier courant, et dans `~/.claude.json` les serveurs de
 *     la personne (portée `user`) et ceux de CHAQUE projet (portée `local`) ;
 *   · Claude Desktop : `claude_desktop_config.json`, à l'endroit propre à chaque système
 *     (`claudeDesktopConfig`). Ajouté le 5 novembre : le premier testeur utilise Claude Desktop
 *     sous Windows, et le client a le même format (`mcpServers`).
 *
 * `~/.claude.json` est le fichier où Claude Code garde tout son état, et il le réécrit en
 * marche : on n'y écrit pas soi-même, on passe par ses commandes (`claude mcp remove`, puis
 * `claude mcp add-json` ; l'original est remis si l'ajout échoue). Une copie du fichier est
 * gardée d'abord. Les autres fichiers sont écrits directement, avec leur copie.
 *
 * Rien ne change sans la réponse de la personne (Entrée = oui, la liste est sous ses yeux) ;
 * `npx oathrion --annuler` remet chaque serveur comme il était.
 *
 * Codes de sortie : 0 · 1 refusé, ou personne pour répondre · 2 une partie n'a pas pu être
 * changée · 3 usage.
 */
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { LocalPrograms, programId } from "../../server/local-programs";

import { HOOK_MATCHER, TAINT_MATCHER } from "./claude-hook-rules";
import { sha256OfFile } from "./client-identity";
import { stateRoot } from "./launch";

/*
 * Le hook voit AUSSI le web et les outils MCP : après, pour marquer la session qui lit du contenu
 * non fiable ; avant, pour refuser un leurre ou dire quel secret sortirait (`claude-hook-rules.ts`).
 */
const POST_MATCHER = `${HOOK_MATCHER}|${TAINT_MATCHER}`;
import { backupFile, flagName, launcherFor, planChanges, show, wrapNameFor, wrapServer, type Change, type InstallIo } from "./install";
import { forgetSealed, sealConfig, secretEntries, unsealConfig } from "./server-secrets";
import { isJailShim, type JailAlwaysInstaller } from "./jail-always";
import type { JailReadiness } from "./jail";
import type { WatchInstaller } from "./watch";
import { OutsideAllowances } from "../../server/local-agent-watch";

export { launcherFor };

export const SETUP_USAGE = `
npx oathrion [--undo] [--except <name>]… [--approval console] [--keep-claude-prompts] [--yes]

  Finds the MCP servers of Claude Code, Claude Desktop and Cursor on this machine, shows them to you, and
  puts Oathrion in front of each one once you agree. A copy of every file is kept.

  --undo                 put every server back as it was before Oathrion
  --except <name>        leave this server as it is (repeatable)
  --approval console     decide only in the console (default: in the client when it can
                         ask, otherwise in the console)
  --keep-claude-prompts  let Claude Code also ask its own permission (default: Oathrion
                         alone decides for the servers it protects)
  --yes                  apply without asking
`;

/* Les options anglaises, et leurs anciens noms français, toujours compris (`FLAG_ALIASES`). */
export const SETUP_FLAGS = new Set(["--undo", "--except", "--approval", "--keep-claude-prompts", "--yes", "--annuler", "--sauf", "--approbation", "--garder-questions-claude", "--oui"]);

/** Les raisons de `planChanges`, en une colonne. */
const SHORT: Record<string, string> = {
  "already behind Oathrion.": "already protected",
  "remote server with no token in the configuration — its sign-in (OAuth) is handled by the client, left as is.": "remote, sign-in handled by the client (OAuth): left as is",
  "no command, left as is.": "no command: left as is",
  "unrecognised shape, left as is.": "unrecognised shape: left as is",
  "excluded (--except), left as is.": "excluded (--except): left as is",
};

type Servers = Record<string, Record<string, unknown>>;

/** Un endroit où un client garde des serveurs. */
export type Source =
  | { kind: "file"; client: "Cursor" | "Claude Code" | "Claude Desktop"; label: string; path: string; config: { mcpServers: Servers } & Record<string, unknown> }
  | { kind: "claude"; client: "Claude Code"; label: string; scope: "user" | "local"; cwd: string; servers: Servers };

/** Lance `claude` ; `code` -1 s'il est introuvable. */
export type ClaudeRunner = (args: string[], cwd: string) => Promise<{ code: number; out: string }>;

export interface SetupIo extends InstallIo {
  claude?: ClaudeRunner;
  version: string;
  /** La veille des agents en permanence (`watch.ts`) ; absente, `npx oathrion` n'y touche pas (les essais). */
  watch?: WatchInstaller;
  /** L'agent d'IA depuis lequel `npx oathrion` est lancé (Claude Code…) : autorisé d'avance hors de la prison. */
  launchingAgent?: () => { agent: string; exe: string } | null;
  /** La prison par défaut (`jail-always.ts`), et si elle peut démarrer ici ; absente, rien n'y est touché. */
  jail?: { installer: JailAlwaysInstaller; readiness: () => JailReadiness };
  /** Le parcours guidé suit (`onboarding.ts`) : la démo y est proposée, pas seulement nommée. */
  guided?: boolean;
  /** Les clients à relancer pour que la protection prenne (le parcours guidé attend qu'ils reviennent). */
  onRestart?: (clients: string[]) => void;
}

const tilde = (path: string, home: string) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

function readJson(path: string): Record<string, unknown> | string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : "not a JSON object";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const serversOf = (value: unknown): Servers => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Servers) : {});

/** Le fichier de configuration de Claude Desktop, là où l'application le lit sur ce système. */
export function claudeDesktopConfig(home: string, platform: NodeJS.Platform = process.platform, appData = process.env.APPDATA): string {
  if (platform === "win32") return join(appData && appData.trim() !== "" ? appData : join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** Tous les endroits où Claude Code, Claude Desktop et Cursor gardent des serveurs, sur cette machine. */
export function findSources(home: string, cwd: string, desktopConfig = claudeDesktopConfig(home)): { sources: Source[]; notes: string[] } {
  const sources: Source[] = [];
  const notes: string[] = [];
  const file = (client: "Cursor" | "Claude Code" | "Claude Desktop", label: string, path: string) => {
    if (!existsSync(path) || sources.some((s) => s.kind === "file" && s.path === path)) return;
    const parsed = readJson(path);
    if (typeof parsed === "string") notes.push(`${tilde(path, home)} unreadable (${parsed}): left as is.`);
    else sources.push({ kind: "file", client, label, path, config: { ...parsed, mcpServers: serversOf(parsed.mcpServers) } });
  };
  file("Claude Code", `Claude Code · ${tilde(cwd, home)} (.mcp.json)`, resolve(cwd, ".mcp.json"));
  file("Cursor", "Cursor · all your projects", join(home, ".cursor", "mcp.json"));
  file("Cursor", `Cursor · ${tilde(cwd, home)}`, resolve(cwd, ".cursor", "mcp.json"));
  file("Claude Desktop", "Claude Desktop", desktopConfig);

  const claudeJson = join(home, ".claude.json");
  if (existsSync(claudeJson)) {
    const parsed = readJson(claudeJson);
    if (typeof parsed === "string") notes.push(`~/.claude.json unreadable (${parsed}): left as is.`);
    else {
      const user = serversOf(parsed.mcpServers);
      if (Object.keys(user).length > 0) sources.push({ kind: "claude", client: "Claude Code", label: "Claude Code · all your projects", scope: "user", cwd: home, servers: user });
      for (const [project, settings] of Object.entries(serversOf(parsed.projects))) {
        const servers = serversOf((settings as { mcpServers?: unknown }).mcpServers);
        if (Object.keys(servers).length === 0) continue;
        if (!existsSync(project)) {
          notes.push(`Claude Code · ${tilde(project, home)}: this folder no longer exists, left as is.`);
          continue;
        }
        sources.push({ kind: "claude", client: "Claude Code", label: `Claude Code · ${tilde(project, home)}`, scope: "local", cwd: project, servers });
      }
    }
  }
  return { sources, notes };
}

/**
 * La commande de la console, telle que la personne la tapera : `oathrion console` quand elle a
 * lancé la commande installée (`…/bin/oathrion`), `npx oathrion@<version> console` par npx, le
 * fichier lui-même sinon (une copie de développement).
 */
export function consoleCommandFor(script: string | undefined, version: string, viaNpx: boolean): string {
  if (viaNpx || !script) return `npx oathrion@${version} console`;
  if (/^oathrion(\.cmd|\.ps1)?$/i.test(script.split(/[\\/]/).pop() ?? "")) return "oathrion console";
  return `node ${script} console`;
}

export const spawnClaude: ClaudeRunner = (args, cwd) =>
  new Promise((done) => {
    let out = "";
    /*
     * Le vrai Claude Code, pas le lanceur de la prison par défaut : `claude mcp add` est un
     * réglage qu'Oathrion fait lui-même, pas une session d'agent (11 novembre, parcours sur un
     * compte neuf : passé par le lanceur, il partait en prison et attendait une confirmation).
     */
    const real = claudeOnPath(process.env.PATH ?? "");
    /* Pas de vrai `claude` trouvé : le lanceur, mais qui exécute le programme sans la prison (`shimScript`). */
    const child = spawn(real ?? "claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: real ? process.env : { ...process.env, OATHRION_JAILED: "1" } });
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (error) => done({ code: -1, out: error.message }));
    child.on("exit", (code) => done({ code: code ?? 1, out }));
  });

/**
 * UNE SEULE QUESTION PAR ACTION. Claude Code demande sa propre permission avant chaque outil
 * MCP ; derrière Oathrion, c'est une seconde question pour la même action (les lectures
 * passent, les écritures sont demandées par Oathrion, les destructions bloquées). Une règle
 * `mcp__<serveur>` dans ses réglages lui dit qu'Oathrion décide. Elle n'est posée que pour un
 * serveur RÉELLEMENT sous Oathrion après l'application, et `--annuler` la retire :
 *
 *   · portée `user` : `~/.claude/settings.json` ;
 *   · portée `local`, et `.mcp.json` : `<projet>/.claude/settings.local.json`, le fichier
 *     personnel du projet (jamais partagé avec l'équipe).
 */
export const claudeRule = (server: string) => `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const names = (rules: string[]) => rules.map((rule) => rule.replace(/^mcp__/, "")).join(", ");

export function permissionFile(source: Source, home: string): string | null {
  if (source.kind === "claude") return source.scope === "user" ? join(home, ".claude", "settings.json") : join(source.cwd, ".claude", "settings.local.json");
  return source.client === "Claude Code" ? join(dirname(source.path), ".claude", "settings.local.json") : null;
}

/**
 * LES HOOKS CLAUDE CODE (décision du 5 novembre, `notes/CONCEPTION-HOOK-CLAUDE-CODE.md`) : le
 * shell et les écritures de fichiers de Claude Code passent par `oathrion hook claude-code`.
 * Posés dans le même fichier que les règles, reconnus à leur commande : `--undo` retire les
 * nôtres et rien d'autre. Lancés par `node` et le fichier même qui tourne : un appel par outil,
 * `npx` serait trop lent ; par `npx` seulement si Oathrion n'est pas installé.
 */
const OUR_HOOK = /\boathrion\b.*\bclaude-code (pre|post)\b/;
type HookEntry = { matcher?: unknown; hooks?: { type?: unknown; command?: unknown }[] } & Record<string, unknown>;

export function hookCommand(phase: "pre" | "post", script: string | undefined, version: string, node = process.execPath): string {
  if (script && !/[\\/]_npx[\\/]/.test(script)) {
    /* Le petit fichier du hook, s'il est à côté de la commande RÉELLE (pas du lien de `bin/`). */
    let real = script;
    try {
      real = realpathSync(script);
    } catch {
      /* chemin tel quel */
    }
    const light = join(dirname(real), "oathrion-hook.mjs");
    return existsSync(light) ? `"${node}" "${light}" claude-code ${phase}` : `"${node}" "${script}" hook claude-code ${phase}`;
  }
  return `npx -y oathrion@${version} hook claude-code ${phase}`;
}

/** Les hooks d'Oathrion sont-ils dans ce fichier (`all` : les trois ; `any` : au moins un) ? `null` s'il est illisible. */
export function hooksPresent(path: string, which: "all" | "any" = "all"): boolean | null {
  if (!existsSync(path)) return false;
  const parsed = readJson(path);
  if (typeof parsed === "string") return null;
  const hooks = (parsed.hooks ?? {}) as Record<string, unknown>;
  const entriesOf = (event: string) => (Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : []).filter((entry) => (entry.hooks ?? []).some((h) => typeof h.command === "string" && OUR_HOOK.test(h.command)));
  const ours = (event: string) => entriesOf(event).length > 0;
  const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];
  if (which === "any") return events.some(ours);
  /*
   * Les trois, ET à jour : une installation d'avant `PostToolUseFailure` est refaite (pour
   * journaliser les échecs), et une d'avant la session à risque aussi (pour voir les lectures).
   */
  /* … et une d'avant les leurres, dont `pre` ne voyait ni le web ni les outils MCP ; et une d'avant l'audit, sans `SECRET_READ_DENY`. */
  const deny = (parsed.permissions as { deny?: unknown } | undefined)?.deny;
  const denied = Array.isArray(deny) && SECRET_READ_DENY.every((rule) => deny.includes(rule));
  return events.every(ours) && events.every((event) => entriesOf(event).some((entry) => entry.matcher === POST_MATCHER)) && denied;
}

/*
 * LES SECRETS D'OATHRION, ILLISIBLES PAR CLAUDE CODE (audit du 8 novembre). Le hook ne voit pas
 * les lectures de fichiers (`Read`, `Grep`, `Glob`) : un agent manipulé pouvait lire le secret du
 * pivot, ouvrir la console et approuver ses propres demandes. Ces règles de Claude Code lui-même
 * le lui refusent, sans coût : posées avec le hook, retirées avec lui, rien d'autre n'est touché.
 */
export const SECRET_READ_DENY = [
  "Read(~/.oathrion/**/session.secret)",
  "Read(~/.oathrion/**/*.pem)",
  "Read(~/.oathrion/**/decoys.json)",
  "Read(~/.oathrion/**/*.db)",
  "Read(~/.oathrion/**/server-secrets/**)",
] as const;

/** Pose (ou retire) les deux hooks, en gardant tous les autres ; une copie d'abord. */
function writeHooks(path: string, install: boolean, commands: { pre: string; post: string }, now: Date): void {
  const current = existsSync(path) ? readJson(path) : {};
  if (typeof current === "string") return;
  if (existsSync(path)) backupFile(path, now);
  else mkdirSync(dirname(path), { recursive: true });
  const hooks = { ...((current.hooks as Record<string, unknown> | undefined) ?? {}) };
  for (const [event, command] of [["PreToolUse", commands.pre], ["PostToolUse", commands.post], ["PostToolUseFailure", commands.post]] as const) {
    const kept = (Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : [])
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !(typeof h.command === "string" && OUR_HOOK.test(h.command))) }))
      .filter((entry) => entry.hooks.length > 0);
    /* 120 s pour `pre` : en mode automatique, il peut lancer le pivot puis attendre une personne (50 s). */
    if (install) kept.push({ matcher: POST_MATCHER, hooks: [{ type: "command", command, ...(event === "PreToolUse" ? { timeout: 120 } : {}) }] });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  const next: Record<string, unknown> = { ...current, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  /* Les interdictions de lecture vont et viennent avec le hook ; celles de la personne restent. */
  const permissions = { ...((current.permissions as Record<string, unknown> | undefined) ?? {}) };
  const ours = new Set<string>(SECRET_READ_DENY);
  const deny = (Array.isArray(permissions.deny) ? (permissions.deny as unknown[]) : []).filter((rule) => !ours.has(rule as string));
  if (install) deny.push(...SECRET_READ_DENY);
  if (deny.length > 0) permissions.deny = deny;
  else delete permissions.deny;
  if (Object.keys(permissions).length > 0) next.permissions = permissions;
  else delete next.permissions;
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Le programme Claude Code de cette machine, confirmé d'avance (voir `runSetup`). Le binaire natif
 * (`claude` → `…/claude.exe`) ; une installation JavaScript (`#!/usr/bin/env node`) est identifiée
 * par Node et son script, comme le relais la verra. Rend le chemin confirmé, ou `null`.
 */
/** Le `claude` du PATH, en passant les lanceurs de la prison (`isJailShim`) : le vrai programme. */
export function claudeOnPath(pathEnv: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const name = platform === "win32" ? "claude.exe" : "claude";
  const runnable = (file: string) => {
    try {
      accessSync(file, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  return pathEnv.split(delimiter).map((d) => join(d, name)).find((candidate) => runnable(candidate) && !isJailShim(candidate));
}

function trustClaudeCode(dir: string): string | null {
  const onPath = (name: string) => (process.env.PATH ?? "").split(delimiter).map((d) => join(d, name)).find((candidate) => existsSync(candidate));
  const found = claudeOnPath(process.env.PATH ?? "");
  if (!found) return null;
  try {
    const target = realpathSync(found);
    const head = readFileSync(target).subarray(0, 64).toString("utf8");
    const script = head.startsWith("#!") && /node/.test(head.split("\n")[0] ?? "") ? target : null;
    const node = script ? onPath("node") : undefined;
    const exe = script ? (node ? realpathSync(node) : null) : target;
    if (!exe) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const identity = { exe, script, sha256: sha256OfFile(exe), platform: process.platform };
    const programs = new LocalPrograms(dir);
    /* Déjà confirmé (ou bloqué par la personne) : rien à redire. */
    if (programs.list().some((p) => p.id === programId("Claude Code", identity) && p.status !== "pending")) return null;
    programs.trust("Claude Code", identity, "npx oathrion, run by you");
    return script ?? exe;
  } catch {
    return null;
  }
}

/** Les règles d'un fichier de réglages ; `null` s'il est illisible (on n'y touche pas). */
function allowedRules(path: string): string[] | null {
  if (!existsSync(path)) return [];
  const parsed = readJson(path);
  if (typeof parsed === "string") return null;
  const allow = (parsed.permissions as { allow?: unknown } | undefined)?.allow;
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === "string") : [];
}

/** Ajoute ou retire des règles, en gardant tout le reste du fichier ; une copie d'abord. */
function writeRules(path: string, add: string[], remove: string[], now: Date): void {
  const current = existsSync(path) ? readJson(path) : {};
  if (typeof current === "string") return;
  if (existsSync(path)) backupFile(path, now);
  else mkdirSync(dirname(path), { recursive: true });
  const permissions = { ...((current.permissions as Record<string, unknown> | undefined) ?? {}) };
  const allow = (Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : []).filter((r) => !remove.includes(r as string));
  for (const rule of add) if (!allow.includes(rule)) allow.push(rule);
  /* Rien de vide laissé derrière : `--undo` remet le fichier comme avant (essai du 8 novembre). */
  if (allow.length > 0) permissions.allow = allow;
  else delete permissions.allow;
  const next: Record<string, unknown> = { ...current, permissions };
  if (Object.keys(permissions).length === 0) delete next.permissions;
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** Un serveur changé par les commandes de Claude Code ; l'original est remis si l'ajout échoue. */
async function changeWithClaude(source: Extract<Source, { kind: "claude" }>, change: Change, claude: ClaudeRunner): Promise<string | null> {
  const scope = ["-s", source.scope];
  const removed = await claude(["mcp", "remove", change.key, ...scope], source.cwd);
  if (removed.code !== 0) return removed.code === -1 ? 'the "claude" command was not found' : removed.out.trim().split("\n")[0] || "claude mcp remove failed";
  const added = await claude(["mcp", "add-json", change.key, JSON.stringify(change.after), ...scope], source.cwd);
  if (added.code === 0) return null;
  const restored = await claude(["mcp", "add-json", change.key, JSON.stringify(change.before), ...scope], source.cwd);
  const why = added.out.trim().split("\n")[0] || "claude mcp add-json failed";
  return restored.code === 0 ? `${why} (put back as before)` : `${why}; WARNING, it could not be put back: ${show(change.before)}`;
}

export async function runSetup(argv: readonly string[], io: SetupIo): Promise<number> {
  let undo = false;
  let yes = false;
  let consoleOnly = false;
  let keepClaudeQuestions = false;
  const excluded = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = flagName(argv[i]);
    if (flag === "--undo") undo = true;
    else if (flag === "--except" && argv[i + 1] !== undefined) excluded.add(String(argv[++i]));
    else if (flag === "--keep-claude-prompts") keepClaudeQuestions = true;
    else if (flag === "--yes") yes = true;
    else if (flag === "--approval" && (argv[i + 1] === "console" || argv[i + 1] === "client")) {
      /* « client » est le défaut : accepté, sans effet. */
      consoleOnly = argv[i + 1] === "console";
      i += 1;
    } else {
      io.err(`Unknown option: ${String(argv[i])}.${SETUP_USAGE}`);
      return 3;
    }
  }
  const home = io.home ?? homedir();
  /* Le dossier du pivot : le coffre des jetons de serveurs, les programmes connus (jamais le vrai `~/.oathrion` dans un essai). */
  const vaultDir = io.home ? join(io.home, ".oathrion", "_local") : join(stateRoot(process.env), "_local");
  const launcher = launcherFor(io.script, io.version);
  const viaNpx = launcher.prefix.includes(`oathrion@${io.version}`);
  const consoleCommand = consoleCommandFor(io.script, io.version, viaNpx);
  const { sources, notes } = findSources(home, io.cwd);

  const plans = sources.map((source) => {
    const servers = source.kind === "file" ? source.config.mcpServers : source.servers;
    const plan = planChanges(servers, undo, (key, server) => wrapServer(key, server, consoleOnly, launcher), {
      restore: (key, server) => unsealConfig(vaultDir, wrapNameFor(key), server),
      hasSecrets: (server) => server.env !== null && typeof server.env === "object" && Object.keys(secretEntries(server.env as Record<string, unknown>)).length > 0,
    });
    /* `--sauf` : la personne garde ce serveur tel quel ; il est nommé, pas changé. */
    for (const change of plan.changes.filter((c) => excluded.has(c.key))) plan.notes.push({ key: change.key, reason: "excluded (--except), left as is." });
    return { source, changes: plan.changes.filter((c) => !excluded.has(c.key)), notes: plan.notes };
  });
  const total = plans.reduce((n, p) => n + p.changes.length, 0);
  const seen = plans.reduce((n, p) => n + p.changes.length + p.notes.length, 0);

  /*
   * Les règles de Claude Code : à poser pour les serveurs qui seront sous Oathrion (changés,
   * ou déjà protégés), à retirer pour ceux dont on retire Oathrion.
   */
  const rules = new Map<string, { label: string; add: string[]; remove: string[] }>();
  if (undo || !keepClaudeQuestions) {
    for (const { source, changes, notes: kept } of plans) {
      const path = permissionFile(source, home);
      if (!path) continue;
      const present = allowedRules(path);
      if (present === null) {
        notes.push(`${tilde(path, home)} unreadable: Claude Code will keep asking its own permission for these servers.`);
        continue;
      }
      const entry = rules.get(path) ?? { label: tilde(path, home), add: [], remove: [] };
      if (undo) for (const { key } of changes) entry.remove.push(...[claudeRule(key)].filter((r) => present.includes(r)));
      else {
        const protectedNames = [...changes.map((c) => c.key), ...kept.filter((n) => n.reason === "already behind Oathrion.").map((n) => n.key)];
        entry.add.push(...protectedNames.map(claudeRule).filter((r) => !present.includes(r) && !present.includes(`${r}__*`)));
      }
      if (entry.add.length + entry.remove.length > 0) rules.set(path, entry);
    }
  }
  const ruleCount = [...rules.values()].reduce((n, r) => n + r.add.length + r.remove.length, 0);

  /*
   * Les hooks : UN SEUL, dans `~/.claude/settings.json`, pour tous les projets — posé dès que
   * Claude Code est sur la machine, même sans aucun serveur MCP (son shell et ses écritures
   * agissent quand même). Un hook de plus dans un projet ferait juger chaque commande deux fois,
   * et demander deux fois à la personne en mode automatique : ceux d'une installation
   * précédente y sont retirés (`install: false`). `--undo` les retire tous.
   */
  const hookFiles = new Map<string, { label: string; install: boolean }>();
  let hooksAlready = false;
  const userSettings = join(home, ".claude", "settings.json");
  const claudeHere = existsSync(join(home, ".claude")) || existsSync(join(home, ".claude.json"));
  const projectFiles = [...new Set(plans.filter(({ source }) => source.client === "Claude Code").map(({ source }) => permissionFile(source, home)))].filter(
    (path): path is string => path !== null && path !== userSettings,
  );
  const userPresent = claudeHere || undo ? hooksPresent(userSettings, undo ? "any" : "all") : false;
  if (userPresent === null) notes.push(`${tilde(userSettings, home)} unreadable: Claude Code's own shell and file edits stay outside Oathrion.`);
  else if (undo) {
    if (userPresent) hookFiles.set(userSettings, { label: "Claude Code · all your projects", install: false });
  } else if (claudeHere) {
    if (userPresent) hooksAlready = true;
    else hookFiles.set(userSettings, { label: "Claude Code · all your projects", install: true });
  }
  for (const path of projectFiles) {
    if (hooksPresent(path, "any") === true && (undo || claudeHere)) hookFiles.set(path, { label: tilde(path, home), install: false });
  }
  const hookInstalls = [...hookFiles.values()].filter((h) => h.install);
  const hookMoves = undo ? [] : [...hookFiles.values()].filter((h) => !h.install);
  const hookCommands = { pre: hookCommand("pre", io.script, io.version), post: hookCommand("post", io.script, io.version) };

  /* La veille des agents (Linux) : posée avec le reste, retirée avec le reste. */
  const watch = process.platform === "linux" ? io.watch : undefined;
  const watchChange = watch ? (undo ? watch.installed() : !watch.installed()) : false;
  /*
   * La prison par défaut (Linux) : les agents tapés dans un terminal y démarrent. Si elle ne peut
   * pas démarrer ici (bubblewrap absent, AppArmor d'Ubuntu), on le dit tout de suite, avec la
   * commande à taper, au lieu de laisser l'agent y buter (essai réel du 10 novembre).
   */
  const jail = process.platform === "linux" ? io.jail : undefined;
  const jailWanted = jail && !undo && !jail.installer.installed();
  const jailReady = jailWanted ? jail.readiness() : null;
  const jailChange = jail ? (undo ? jail.installer.present() : Boolean(jailWanted && jailReady?.ready)) : false;
  const jailBlocked = jailReady && !jailReady.ready ? jailReady : null;

  io.out(undo ? "Oathrion · remove Oathrion from your MCP servers" : "Oathrion · protect your agents' MCP servers");
  io.out("");
  /*
   * Aucun serveur MCP, rien pour Claude Code : sous Linux, la veille et la prison protègent quand
   * même (12 novembre : on s'arrêtait là, sans elles). Ailleurs, rien à poser : on le dit, et la
   * démo montre ce qu'Oathrion fera.
   */
  if (seen === 0 && !undo && hookInstalls.length === 0 && !watchChange && !jailChange) {
    io.out("No AI agent setup to protect yet: Oathrion found no MCP server for Claude Code or Cursor here.");
    io.out(`When you add one to your agent, run ${viaNpx ? "npx oathrion" : "oathrion"} again: one Enter protects it.`);
    for (const note of notes) io.out(`  ${note}`);
    return 0;
  }
  for (const { source, changes, notes: kept } of plans) {
    if (changes.length + kept.length === 0) continue;
    io.out(`  ${source.label}`);
    /* La commande d'origine : avant pour protéger, après pour annuler. */
    for (const { key, before, after, sealOnly } of changes) io.out(`    ${key.padEnd(18)} ${undo ? "to remove " : sealOnly ? "move token " : "to protect"}   ${sealOnly ? "its tokens leave this file for Oathrion's vault" : show(undo ? after : before)}`);
    for (const { key, reason } of kept) io.out(`    ${key.padEnd(18)} ${SHORT[reason] ?? reason}`);
  }
  for (const note of notes) io.out(`  ${note}`);
  if (rules.size > 0) {
    io.out(undo ? "  Claude Code will ask its own permission again for:" : "  One question per action: Claude Code will let Oathrion ask you, for:");
    for (const { label, add, remove } of rules.values()) io.out(`    ${names(undo ? remove : add)}   (${label})`);
  }
  if (hookFiles.size > 0) {
    io.out(undo ? "  Claude Code's own shell and file edits: no longer checked by Oathrion, in:" : "  Claude Code's own shell and file edits: checked by Oathrion's rules, in:");
    for (const { label } of undo ? hookFiles.values() : hookInstalls) io.out(`    ${label}`);
    if (hookInstalls.length === 0 && hookMoves.length > 0) io.out("    Claude Code · all your projects (already)");
    for (const { label } of hookMoves) io.out(`    (the earlier one in ${label} is removed: one check per command)`);
  }
  if (jailChange) {
    if (undo) io.out("  The jail by default: removed (agents start as before).");
    else {
      io.out(`  The jail, by default: ${jail!.installer.available().join(", ")} typed in a terminal start where they cannot go`);
      io.out("    around Oathrion (your secrets hidden, only your servers, only their AI provider).");
    }
  }
  if (jailBlocked) {
    io.out("  The jail, by default, needs one step from you first:");
    for (const line of jailBlocked.message.split("\n")) io.out(`    ${line}`);
    io.out(`    Then run « ${viaNpx ? "npx oathrion" : "oathrion"} » again.`);
  }
  if (watchChange) {
    io.out(undo ? "  The agent watch: turned off." : "  The agent watch, like an antivirus for AI agents: an agent that runs outside Oathrion's");
    if (!undo) io.out("    protection, you are told. It runs with your session, and starts again if it stops.");
  }
  io.out("");

  /* Claude Code confirmé d'avance (voir plus bas) : aussi quand tout le reste est déjà en place (9 novembre). */
  const confirmClaudeCode = () => {
    const confirmed = trustClaudeCode(vaultDir);
    if (confirmed) io.out(`  ✓ Claude Code is a program Oathrion knows (${tilde(confirmed, home)}); any other program is confirmed in the console the first time`);
  };
  /*
   * L'agent depuis lequel la personne lance cette commande : la veille le mettrait en pause dans
   * les secondes qui suivent (essai réel du 10 novembre, la conversation même). Elle l'a lancé
   * elle-même : autorisé d'avance hors de la prison, et dit. Aussi quand tout est déjà en place.
   */
  const allowLaunchingAgent = () => {
    if (!watch || (!watchChange && !watch.installed())) return;
    const parent = io.launchingAgent?.();
    if (!parent) return;
    const allowances = new OutsideAllowances(vaultDir);
    if (allowances.has(parent.exe)) return;
    mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    allowances.allow(parent.exe, parent.agent, "npx oathrion (run from this agent)");
    io.out(`  ✓ ${parent.agent}, from which you ran this, is allowed outside the jail: the agent watch will not pause it (« Stop allowing » in the console undoes it)`);
  };
  if (total === 0 && ruleCount === 0 && hookFiles.size === 0 && !watchChange && !jailChange) {
    if (!undo) allowLaunchingAgent();
    if (!undo && claudeHere) confirmClaudeCode();
    io.out(undo ? "No server behind Oathrion: nothing to remove." : "Everything is already behind Oathrion.");
    if (!undo) io.out(`Your console: ${consoleCommand}`);
    return 0;
  }
  /* Ce paragraphe parle des serveurs MCP : sans eux (la veille et la prison seules), il égarerait. */
  if (!undo && (total > 0 || ruleCount > 0 || hookFiles.size > 0)) {
    io.out("With Oathrion: reads go through; writes wait for your approval; deletions and");
    io.out("payments are blocked. A tool its server declares destructive (write_file can");
    io.out("overwrite a file) stays hidden until you allow it in the console; each call then");
    io.out("waits for your approval. Every file is copied before it is changed, and");
    io.out(`"${viaNpx ? "npx oathrion" : "oathrion"} --undo" puts everything back as before.`);
    io.out("");
  }
  if (!yes) {
    const question = undo
      ? `Remove Oathrion from ${String(total)} server(s)?`
      : total > 0
        ? `Protect ${String(total)} server(s)?`
        : ruleCount > 0
          ? "Let Oathrion alone ask for your approval for these servers?"
          : hookFiles.size > 0
            ? "Let Oathrion check Claude Code's own shell and file edits?"
            : `Turn on ${[jailChange ? "the jail for your agents" : null, watchChange ? "the agent watch" : null].filter(Boolean).join(" and ")}?`;
    const answer = await io.confirm(`${question} [Y/n] `, true);
    if (answer === null) {
      io.err("No terminal to ask you: run again with --yes to apply. Nothing was changed.");
      return 1;
    }
    if (!answer) {
      io.out("Nothing was changed.");
      return 1;
    }
  }

  const now = io.now?.() ?? new Date();
  const claude = io.claude ?? spawnClaude;
  const failures: string[] = [];
  const clients = new Set<string>();
  let claudeBackedUp = false;
  /* Les serveurs RÉELLEMENT changés, par fichier de réglages : une règle n'est posée que pour eux. */
  const applied = new Map<string, Set<string>>();
  const markApplied = (source: Source, keys: string[]) => {
    const path = permissionFile(source, home);
    if (path) applied.set(path, new Set([...(applied.get(path) ?? []), ...keys.map(claudeRule)]));
  };
  for (const { source, changes } of plans) {
    if (changes.length === 0) continue;
    if (source.kind === "file") {
      backupFile(source.path, now);
      const next = { ...source.config, mcpServers: { ...source.config.mcpServers } };
      /* Les jetons quittent le fichier pour le coffre d'Oathrion ; `--undo` les y remet (`server-secrets.ts`). */
      for (const { key, after } of changes) next.mcpServers[key] = undo ? after : sealConfig(vaultDir, wrapNameFor(key), after);
      writeFileSync(source.path, `${JSON.stringify(next, null, 2)}\n`);
      if (undo) for (const { key } of changes) forgetSealed(vaultDir, wrapNameFor(key));
      io.out(`  ✓ ${source.label}: ${changes.map((c) => c.key).join(", ")}`);
      clients.add(source.client);
      markApplied(source, changes.map((c) => c.key));
      continue;
    }
    if (!claudeBackedUp) {
      backupFile(join(home, ".claude.json"), now);
      claudeBackedUp = true;
    }
    const done: string[] = [];
    for (const change of changes) {
      const sealed = undo ? change : { ...change, after: sealConfig(vaultDir, wrapNameFor(change.key), change.after) };
      const failure = await changeWithClaude(source, sealed, claude);
      /* Aucun `claude` qui s'exécute (une installation cassée) : le dire, et quoi faire. */
      const broken = failure && process.platform !== "win32" && !claudeOnPath(process.env.PATH ?? "") ? ' — Claude Code\'s "claude" command does not run on this machine: repair Claude Code (check: claude --version), then run this again' : "";
      if (failure) failures.push(`${source.label} · ${change.key}: ${failure}${broken}`);
      else {
        done.push(change.key);
        if (undo) forgetSealed(vaultDir, wrapNameFor(change.key));
      }
    }
    if (done.length > 0) {
      io.out(`  ✓ ${source.label}: ${done.join(", ")}`);
      clients.add(source.client);
    }
    markApplied(source, done);
  }
  for (const [path, { label, add, remove }] of rules) {
    /* Une règle pour un serveur dont le changement a échoué : jamais. Les déjà protégés n'ont rien à appliquer. */
    const wrappedNow = applied.get(path) ?? new Set<string>();
    const planned = new Set(plans.flatMap((p) => (permissionFile(p.source, home) === path ? p.changes.map((c) => claudeRule(c.key)) : [])));
    const safeAdd = add.filter((rule) => !planned.has(rule) || wrappedNow.has(rule));
    if (safeAdd.length + remove.length === 0) continue;
    writeRules(path, safeAdd, remove, now);
    io.out(`  ✓ ${undo ? "Claude Code will ask its permission again" : "One question per action"}: ${names(undo ? remove : safeAdd)} (${label})`);
    clients.add("Claude Code");
  }
  for (const [path, { label, install }] of hookFiles) {
    writeHooks(path, install, hookCommands, now);
    io.out(
      `  ✓ ${install ? "Claude Code's own shell and file edits: checked by Oathrion" : undo ? "Claude Code's own shell and file edits: no longer checked" : "Earlier project hook removed, all your projects are checked"} (${label})`,
    );
    clients.add("Claude Code");
  }
  if (jailChange && jail) {
    if (undo) {
      jail.installer.remove();
      io.out("  ✓ Agents start as before, outside the jail (open a new terminal)");
    } else {
      const done = jail.installer.install();
      io.out(`  ✓ In the jail by default: ${done.map((d) => d.split(" ")[0]).join(", ")} (open a new terminal for it to apply)`);
    }
  }
  if (!undo) allowLaunchingAgent();
  if (watchChange && watch) {
    if (undo) {
      watch.remove();
      io.out("  ✓ The agent watch is off");
    } else {
      const how = watch.install();
      io.out(`  ✓ The agent watch is on (${how === "systemd" ? "a service of your session, started again if it stops" : "with your desktop session, and now"})`);
    }
  }
  /*
   * Claude Code, trouvé sur la machine par la personne elle-même (elle lance cette commande) :
   * confirmé d'avance comme programme connu. Les autres programmes le seront dans la console,
   * à leur première connexion (`server/local-programs.ts`).
   */
  if (!undo && claudeHere) confirmClaudeCode();
  for (const failure of failures) io.err(`  ✗ ${failure}`);
  if (clients.size > 0) {
    io.out("");
    const their = clients.size > 1 ? "their" : "its";
    const listed = [...clients];
    const named = listed.length > 1 ? `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}` : listed[0];
    /* Guidé : l'étape « relance » du parcours le dit, et attend le client ; pas deux fois. */
    if (undo || !io.guided) io.out(`Restart ${named}: ${undo ? `${their} servers no longer go through Oathrion.` : `${their} calls now go through Oathrion.`}`);
    if (!undo) io.onRestart?.(listed);
    /* Fermer sa fenêtre ne l'arrête pas : il reste dans la barre des tâches, avec ses anciens serveurs. */
    if (clients.has("Claude Desktop")) io.out("Claude Desktop: quit it completely (its icon by the clock → Quit on Windows, Cmd+Q on macOS), then open it again.");
    if (!undo && io.guided) {
      /*
       * Le parcours guidé suit (12 novembre) : l'essentiel en deux lignes, à l'endroit où l'attention
       * est la plus précieuse. Ce qu'Oathrion ne voit pas reste dit (décision du 5 novembre) ; le
       * détail est dans la console (« Protection »).
       */
      io.out("At your agent's first write, Oathrion asks you: in its chat, or by a notification.");
      if (clients.has("Claude Code")) io.out("Claude Code's own file reads are not checked by Oathrion: the console shows what is covered.");
    } else if (!undo) {
      io.out("At your agent's first write, you will be asked to approve: in your client when it can");
      io.out("ask (Claude Code), otherwise through a notification.");
      /*
       * Décision du 5 novembre (notes/DECISION-OUTILS-INTEGRES-CLAUDE-CODE.md) : le dire. Essayé
       * de bout en bout, Claude Code a listé un dossier avec ses propres outils, et Oathrion n'a
       * rien vu. Tant qu'aucun hook ne les gouverne, la personne doit le savoir ici.
       */
      if (clients.has("Claude Code") && (hookFiles.size > 0 || hooksAlready)) {
        io.out("Claude Code's own shell and file edits are checked by Oathrion's local rules: a few");
        io.out("dangerous commands refused, a push or a publish asked, everything kept in a journal");
        io.out('("oathrion receipts verify"). Its file reads are not checked; but once it has read a');
        io.out("web page, a search, an issue or a message, what its session sends out asks you first.");
      } else if (clients.has("Claude Code")) {
        io.out("Claude Code's own tools (shell, reading and editing files) are not MCP servers: they");
        io.out('stay under Claude Code\'s permissions, not Oathrion\'s. Name the server ("with the files');
        io.out('server") when you want an action to go through Oathrion.');
      }
      io.out(`The console, which opens already signed in: ${consoleCommand}`);
      /* Le moment « waouh » sans attendre qu'un agent agisse (11 novembre). */
      if (!io.guided) io.out(`See what Oathrion shows when an agent acts without permission: ${viaNpx ? "npx oathrion demo" : "oathrion demo"}`);
      /* Une ligne, pas une publicité : ce que la version équipe ajoute, et où le lire (9 novembre). */
      io.out('For a team (someone else approves, receipts for your auditor or bank): « Your team » in the console.');
    }
  }
  return failures.length > 0 ? 2 : 0;
}
