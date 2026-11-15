/**
 * L'AGENT ENFERMÉ — `oathrion jail [--keep-env NOM]… -- <agent> [arguments]` (pièce J3 de
 * `notes/CONCEPTION-JAIL.md`, Linux, bubblewrap).
 *
 * Un agent qui tourne librement sous le compte de la personne peut passer à côté d'Oathrion (lire
 * une configuration, y trouver un jeton, appeler le service). Dans la prison :
 *
 *   · le système est en LECTURE SEULE ; seuls le dossier du projet, `/tmp` et les dossiers d'état
 *     des agents (`~/.cursor`, `~/.claude`, les caches) s'écrivent ;
 *   · `~/.oathrion` est MASQUÉ : n'y restent que le port du pivot, le secret RELAIS de cette
 *     prison (qui ne permet ni d'ouvrir la console ni de décider, et porte l'identité de l'agent
 *     relevée dehors), les empreintes des jetons protégés, et le marqueur ;
 *   · les secrets de la personne sont MASQUÉS (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`,
 *     `~/.netrc`, `~/.npmrc`…), sauf les leurres, laissés visibles exprès ;
 *   · les variables d'environnement qui portent un secret sont RETIRÉES (`--keep-env` en garde
 *     une, par exemple la clé de l'agent lui-même) ;
 *   · ses processus ne voient pas ceux du dehors, et meurent avec lui.
 *
 * Le pivot tourne DEHORS, près du coffre des jetons : il lance les serveurs avec leurs jetons,
 * mais seulement ceux configurés par la personne, à leur commande exacte (`server/routes.ts`).
 * Le réseau (pièce J4, `jail-net.ts`) : aucun, sauf le pivot et un mandataire qui n'ouvre que
 * les hôtes permis (le fournisseur d'IA de l'agent, et ceux de `--allow-host`).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { commandProgram } from "./client-identity";
import { decoyRegistryPath, type DecoyRegistry } from "./decoys";
import { SECRET_ENV_NAME } from "./guarded-tokens";
import { ensureHub, HubSession, hubIsStale, JAIL_MARKER, RELAY_SECRET_FILE, STALE_HUB_TEXT } from "./hub";
import { runJailAlways } from "./jail-always";
import { DEFAULT_HOSTS, proxyEnvironment, startGate } from "./jail-net";
import { isWrapped, unwrapServer } from "./install";
import { stateRoot } from "./launch";
import { secretEntries } from "./server-secrets";

export const JAIL_USAGE = `
oathrion jail [--keep-env NAME]... [--allow-host HOST]... [--show-project-secrets] -- <agent> [arguments]

  Runs an agent (cursor-agent, claude, …) where it cannot go around Oathrion: your secrets and
  Oathrion's files are invisible to it, the system is read-only outside the project, and its
  MCP servers can only be the ones you configured, through Oathrion. Linux, with bubblewrap.

  --keep-env NAME          keep one secret environment variable the agent itself needs (its own API key)
  --show-project-secrets   do not hide the project's .env files and keys (shown empty otherwise)
  --allow-host HOST        let the agent reach HOST over HTTPS (its AI provider is allowed already:
                           cursor-agent, claude, codex, gemini, agy)
  --network open           give the agent the whole network (it can then send what it reads anywhere)

oathrion jail --always [agent]...   cursor-agent, claude and agy always start in the jail, from any terminal
oathrion jail --always --undo       they start as before
`;

interface ServerLike {
  command?: unknown;
  args?: unknown;
  url?: unknown;
  env?: unknown;
  [key: string]: unknown;
}

/** Les serveurs des clients, tels que leurs fichiers les déclarent. */
function clientServers(home: string, cwd: string): { file: string; name: string; config: ServerLike }[] {
  const out: { file: string; name: string; config: ServerLike }[] = [];
  const read = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const add = (file: string, servers: unknown) => {
    if (servers === null || typeof servers !== "object") return;
    for (const [name, config] of Object.entries(servers as Record<string, ServerLike>)) if (config && typeof config === "object") out.push({ file, name, config });
  };
  for (const file of [join(home, ".cursor", "mcp.json"), join(cwd, ".cursor", "mcp.json"), join(cwd, ".mcp.json"), join(home, ".config", "Claude", "claude_desktop_config.json"), join(home, ".gemini", "config", "mcp_config.json")]) add(file, read(file)?.mcpServers);
  const claude = read(join(home, ".claude.json"));
  if (claude) {
    add(join(home, ".claude.json"), claude.mcpServers);
    for (const project of Object.values((claude.projects ?? {}) as Record<string, { mcpServers?: unknown }>)) add(join(home, ".claude.json"), project?.mcpServers);
  }
  return out;
}

/**
 * La commande exacte que `oathrion wrap` enverra au pivot pour ce serveur : celle d'origine
 * (après « -- »), ou le pont d'un serveur distant. `null` si on ne peut pas la prévoir.
 */
export function expectedSpec(config: ServerLike): { name: string; command: string; args: string[] } | null {
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const name = args[args.indexOf("--name") + 1];
  if (!isWrapped(config) || !name) return null;
  const urlAt = args.indexOf("--url");
  if (urlAt !== -1 && !args.includes("--")) {
    const script = args[0];
    if (typeof config.command !== "string" || !script || script === "-y") return null;
    return { name, command: config.command, args: [script, "bridge", "--url", args[urlAt + 1]!, "--transport", args[args.indexOf("--transport") + 1] === "sse" ? "sse" : "http"] };
  }
  const original = unwrapServer(config);
  if (!original || typeof original.command !== "string") return null;
  return { name, command: original.command, args: Array.isArray(original.args) ? original.args.map(String) : [] };
}

/** Les montages de bubblewrap. */
export function jailArguments(options: {
  home: string;
  cwd: string;
  stateDir: string;
  marker: string;
  relaySecret: string;
  runtimeDir?: string;
  /** Les fichiers secrets du projet, montrés vides (`projectSecretFiles`). */
  hiddenFiles?: readonly string[];
  /** Les leurres posés par `oathrion decoys plant` : visibles, exprès. */
  decoys?: readonly string[];
  /** Sans réseau (J4, `jail-net.ts`) : seulement les passages ouverts dehors. */
  network?: boolean;
  exists: (path: string) => boolean;
}): string[] {
  const { home, cwd, stateDir, marker, relaySecret, runtimeDir, hiddenFiles = [], decoys = [], network = false, exists } = options;
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", "/tmp", "/tmp", "--unshare-pid", "--die-with-parent"];
  if (network) args.push("--unshare-net");
  /* Ce que l'agent écrit : le projet, et ses propres dossiers d'état. */
  for (const path of [cwd, join(home, ".cursor"), join(home, ".claude"), join(home, ".claude.json"), join(home, ".cache"), join(home, ".npm"), join(home, ".local", "share"), join(home, ".local", "state"), join(home, ".config"), join(home, ".gemini")]) {
    if (exists(path)) args.push("--bind", path, path);
  }
  /* Les secrets de la personne : masqués (un dossier vide, un fichier vide). */
  const secretDirs = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".azure", ".docker", ".kube", ".password-store", ".config/op"];
  const secretFiles = [".netrc", ".npmrc", ".git-credentials", ".pgpass", ".pypirc"];
  for (const dir of secretDirs) if (exists(join(home, dir))) args.push("--tmpfs", join(home, dir));
  for (const file of secretFiles) if (exists(join(home, file))) args.push("--ro-bind", "/dev/null", join(home, file));
  /*
   * Les prises de la session de bureau (`/run/user/<uid>`) : l'agent SSH, celui de GPG, et D-Bus,
   * par lequel le trousseau, déverrouillé à la connexion, rend les mots de passe gardés. Masquées.
   */
  if (runtimeDir && exists(runtimeDir)) args.push("--tmpfs", runtimeDir);
  /* Les secrets du projet (`.env`, clés) : montrés vides ; le reste du projet s'écrit. */
  for (const file of hiddenFiles) args.push("--ro-bind", "/dev/null", file);
  /*
   * Les leurres restent visibles, exprès : un agent qui les emporte se trahit. En lecture-écriture :
   * sur un montage en lecture seule, Linux ne note pas la date d'accès, et le fil-piège
   * (`server/local-tripwire.ts`) ne verrait pas la lecture.
   */
  for (const decoy of decoys) if (exists(decoy)) args.push("--bind", decoy, decoy);
  for (const decoy of [join(home, ".aws", "credentials.backup")]) if (exists(decoy)) args.push("--bind", decoy, decoy);
  /* Oathrion : masqué, sauf ce qu'un relais enfermé doit lire. */
  args.push("--tmpfs", stateDir.replace(/[\\/]_local$/, ""));
  for (const name of ["port", "guarded-tokens.json"]) {
    const path = join(stateDir, name);
    if (exists(path)) args.push("--ro-bind", path, path);
  }
  args.push("--ro-bind", relaySecret, join(stateDir, RELAY_SECRET_FILE));
  args.push("--ro-bind", marker, join(stateDir, JAIL_MARKER));
  args.push("--chdir", cwd, "--setenv", "OATHRION_JAILED", "1");
  return args;
}

/* Un fichier du projet qui porte des secrets ; jamais un modèle (`.env.example`). */
const PROJECT_SECRET = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|service-account.*\.json|.+\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const SECRET_TEMPLATE = /\.(?:example|sample|template|dist|defaults?)$/i;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".venv", "venv", "vendor", "target", "__pycache__", ".cache"]);

/**
 * Les fichiers secrets du projet (`.env`, `.env.local`, clés, `credentials.json`…), jusqu'à
 * quatre niveaux, sans les dossiers de dépendances. Les leurres n'en sont pas : ils restent visibles.
 */
export function projectSecretFiles(cwd: string, decoys: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || found.length >= 200) return;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path, depth + 1);
      } else if (entry.isFile() && PROJECT_SECRET.test(entry.name) && !SECRET_TEMPLATE.test(entry.name) && !decoys.has(path)) {
        found.push(path);
      }
    }
  };
  walk(cwd, 0);
  return found.sort();
}

/* Des noms de la session de bureau, qui disent « session » ou « auth » sans rien porter de secret. */
const DESKTOP_NAMES = /^(SESSION_MANAGER|DESKTOP_SESSION|GDMSESSION|XDG_SESSION_\w+|GNOME_DESKTOP_SESSION_ID|GNOME_SHELL_SESSION_MODE|XAUTHORITY)$/;
/* Des variables qui mènent à des clés sans en porter : l'agent SSH, celui de GPG, D-Bus (le trousseau). */
const KEY_SOCKETS: Record<string, string> = { SSH_AUTH_SOCK: "your SSH agent", GPG_AGENT_INFO: "your GPG agent", DBUS_SESSION_BUS_ADDRESS: "your desktop's D-Bus (and its keyring)" };

/** L'environnement de l'agent enfermé : sans les secrets, ni ce qui mène à des clés. */
export function jailEnvironment(source: NodeJS.ProcessEnv, keep: ReadonlySet<string>): { env: NodeJS.ProcessEnv; removed: string[]; sockets: string[] } {
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  const sockets: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (keep.has(key)) env[key] = value;
    else if (KEY_SOCKETS[key]) sockets.push(KEY_SOCKETS[key]!);
    else if (SECRET_ENV_NAME.test(key) && !DESKTOP_NAMES.test(key)) removed.push(key);
    else env[key] = value;
  }
  return { env, removed, sockets };
}

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

/**
 * Ubuntu 23.10 et suivants refusent les espaces de noms utilisateur aux programmes sans profil
 * AppArmor qui les permet : bubblewrap n'en a pas sur Ubuntu 24.04. C'est un réglage de sécurité
 * du système : la personne le change elle-même, Oathrion ne le fait jamais.
 */
export function userNamespaceHelp(restricted: string | null): string {
  if (restricted !== "1") return "Your system does not let bubblewrap create its namespaces: check that unprivileged user namespaces are allowed (sysctl user.max_user_namespaces).";
  return [
    "Ubuntu only lets programs with an AppArmor profile create user namespaces, and bubblewrap has none here.",
    "To give it one (this changes your system's security settings: do it yourself, once):",
    "",
    "  sudo tee /etc/apparmor.d/bwrap >/dev/null <<'END'",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "profile bwrap /usr/bin/bwrap flags=(unconfined) {",
    "  userns,",
    "  include if exists <local/bwrap>",
    "}",
    "END",
    "  sudo apparmor_parser -r /etc/apparmor.d/bwrap",
    "",
    "Then start the jail again. To undo: sudo apparmor_parser -R /etc/apparmor.d/bwrap, then sudo rm /etc/apparmor.d/bwrap.",
  ].join("\n");
}

/*
 * Ce qui surprend un agent la première fois qu'il est enfermé. `agy` garde sa connexion dans le
 * trousseau du bureau, que la prison cache : il se dit déconnecté (essai réel du 10 novembre).
 */
export const FIRST_TIME_HINTS: Record<string, string> = {
  agy: "if agy says you are signed out, that is because its login is in your desktop keyring, which the jail hides. Sign in once here (Google OAuth: open the link, paste the code); it then keeps its login in its own folder, ~/.gemini, never in your keyring.",
  claude: "if Claude Code asks you to sign in, do it once here; its login stays in its own folder, ~/.claude.",
};

/** L'indication de la première fois, une seule fois par agent (`jail-agents.json`), ou `null`. */
export function firstTimeHint(stateDir: string, agent: string): string | null {
  const file = join(stateDir, "jail-agents.json");
  let seen: string[] = [];
  try {
    seen = JSON.parse(readFileSync(file, "utf8")) as string[];
  } catch {
    /* aucun agent encore enfermé */
  }
  if (!Array.isArray(seen) || seen.includes(agent)) return null;
  try {
    writeFileSync(file, `${JSON.stringify([...seen, agent])}\n`, { mode: 0o600 });
  } catch {
    /* l'indication n'est qu'une aide */
  }
  return FIRST_TIME_HINTS[agent] ?? null;
}

/* L'attente d'une décision : toutes les deux secondes (plus vite dans les essais). */
const jailPollMs = (env: NodeJS.ProcessEnv) => Number(env.OATHRION_JAIL_POLL_MS) || 2_000;

/**
 * La prison peut-elle démarrer ici ? Sinon : pourquoi, et quoi faire (pour `oathrion jail`, et
 * pour `npx oathrion`, qui le dit AVANT qu'un agent n'y bute, 10 novembre).
 */
export type JailReadiness = { ready: true } | { ready: false; reason: "platform" | "no-bwrap" | "apparmor" | "refused"; message: string };

export function jailReadiness(): JailReadiness {
  if (process.platform !== "linux") {
    return { ready: false, reason: "platform", message: "oathrion jail works on Linux for now (bubblewrap). On this system, keep your agent's shell under your client's own approval." };
  }
  if (spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status !== 0) {
    return { ready: false, reason: "no-bwrap", message: "oathrion jail needs bubblewrap: install it (sudo apt install bubblewrap, or your distribution's package), then try again." };
  }
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--unshare-net", "--", "true"], { encoding: "utf8" });
  if (probe.status === 0) return { ready: true };
  const restricted = readText("/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
  const why = `bubblewrap cannot start here: ${(probe.stderr ?? "").trim().replace(/\.+$/, "") || "it was refused"}.`;
  return { ready: false, reason: restricted === "1" ? "apparmor" : "refused", message: `${why}\n${userNamespaceHelp(restricted)}` };
}

export interface JailIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  home?: string;
  /** Le script `oathrion` lui-même (le petit relais du dedans est lancé avec). */
  script?: string;
}

/**
 * Le nom de l'agent, depuis le chemin de son programme : celui qui choisit les adresses qu'il peut
 * joindre (`DEFAULT_HOSTS`). Claude Code installé par npm est un binaire `claude.exe`, même sous
 * Linux : sans ce nom ramené à « claude », la prison ne lui ouvrait pas Anthropic, et il ne
 * démarrait pas (tournage du 11 novembre).
 */
export function agentName(program: string): string {
  return basename(program).replace(/\.(exe|cmd|bat|js|mjs|cjs)$/i, "");
}

export async function runJail(argv: readonly string[], io: JailIo): Promise<number> {
  if (argv[0] === "--always") {
    return runJailAlways(argv.slice(1), { out: io.out, err: io.err, env: io.env, home: io.home ?? io.env.HOME ?? homedir(), script: io.script ?? process.argv[1] ?? "" });
  }
  const separator = argv.indexOf("--");
  const command = separator === -1 ? [...argv] : argv.slice(separator + 1);
  const options = separator === -1 ? [] : argv.slice(0, separator);
  const keep = new Set(options.flatMap((option, i) => (option === "--keep-env" && options[i + 1] ? [options[i + 1]!] : [])));
  const showProjectSecrets = options.includes("--show-project-secrets");
  const openNetwork = options.some((option, i) => option === "--network" && options[i + 1] === "open");
  const allowedHosts = [...(DEFAULT_HOSTS[agentName(command[0] ?? "")] ?? []), ...options.flatMap((option, i) => (option === "--allow-host" && options[i + 1] ? [options[i + 1]!] : []))];
  if (command.length === 0) {
    io.err(JAIL_USAGE);
    return 3;
  }
  const readiness = jailReadiness();
  if (!readiness.ready) {
    io.err(readiness.message);
    return 2;
  }
  const home = io.home ?? io.env.HOME ?? homedir();
  const stateDir = join(stateRoot(io.env), "_local");

  /* Aucun jeton ne doit rester dans une configuration de client : sinon, l'agent le lirait. */
  const servers = clientServers(home, io.cwd);
  const leaking = servers.filter(({ config }) => config.env !== null && typeof config.env === "object" && Object.keys(secretEntries(config.env as Record<string, unknown>)).length > 0);
  if (leaking.length > 0) {
    io.err(`These servers still keep a token in your clients' configuration, where the agent would read it: ${leaking.map((s) => s.name).join(", ")}.`);
    io.err("Run « npx oathrion » once (it moves them into Oathrion's vault), then start the jail again.");
    return 2;
  }

  /* Le pivot, dehors, gardé vivant pendant toute la session ; il connaît les serveurs configurés. */
  const conn = await ensureHub(io.env, { log: () => undefined });
  /* Un pivot d'avant la mise à jour n'a pas les protections que la prison promet : on ne démarre pas. */
  if (conn.wasRunning && hubIsStale(io.env, conn.dir)) {
    io.err(STALE_HUB_TEXT);
    /* Ce qui le garde allumé : sans ça, la personne ne sait pas quoi quitter (10 novembre). */
    const status = await conn.op<{ holders?: number }>({ op: "status" }).catch(() => null);
    const holders = status?.body?.holders ?? 0;
    if (holders > 0) io.err(`  Still attached to it: ${String(holders)} (agents, consoles). The agents started in a jail: pgrep -af "oathrion.mjs jail"`);
    io.err("  Once they are all closed, check that it stopped (pgrep -af oathrion-local shows nothing), then start the jail again.");
    return 2;
  }
  const holder = new HubSession(conn, "console", io.env);
  await holder.attach();
  holder.startHeartbeat(() => undefined);
  const registryFile = join(stateDir, "servers.json");
  let registry: Record<string, { command: string; args: string[] }> = {};
  try {
    registry = JSON.parse(readFileSync(registryFile, "utf8")) as typeof registry;
  } catch {
    /* pas encore de registre */
  }
  for (const { config } of servers) {
    const spec = expectedSpec(config);
    if (spec) registry[spec.name] = { command: spec.command, args: spec.args };
  }
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });

  /*
   * Qui est l'agent : relevé ICI, dehors, avant de le lancer. Le pivot crée pour cette prison un
   * secret relais lié à cette identité ; dedans, ce que le relais déclare de lui-même est ignoré.
   */
  const program = commandProgram(command, io.env.PATH ?? "");
  if (!program) {
    io.err(`${command[0]!}: not found in your PATH.`);
    await holder.detach();
    return 2;
  }
  /*
   * Un agent jamais vu ne démarre pas : le pivot prévient la personne (notification), et on
   * attend sa décision dans la console. Bloqué : il ne démarre pas du tout.
   */
  type Opened = { relaySecret?: string; quarantined?: "pending" | "blocked"; program?: string };
  const open = () => conn.op<Opened>({ op: "jail-open", program, name: basename(command[0]!) });
  let opened = await open();
  if (opened.body?.quarantined === "pending") {
    io.out(`Oathrion has never seen this agent: ${opened.body.program ?? basename(command[0]!)}.`);
    io.out("  It does not start until you confirm it is yours: a notification was sent, or open « oathrion console » → Approvals.");
    io.out("  Waiting for your decision… (Ctrl+C to give up)");
    while (opened.status === 200 && opened.body?.quarantined === "pending") {
      await new Promise((done) => setTimeout(done, jailPollMs(io.env)));
      opened = await open();
    }
  }
  if (opened.body?.quarantined === "blocked") {
    io.err(`A person blocked this agent in Oathrion's console: it does not start. (${opened.body.program ?? command[0]!})`);
    await holder.detach();
    return 2;
  }
  if (opened.status !== 200 || !opened.body?.relaySecret) {
    io.err(`The local hub refuses to open a jail (${String(opened.status)}).`);
    await holder.detach();
    return 2;
  }
  const relaySecret = opened.body.relaySecret;
  const jailDir = mkdtempSync(join(tmpdir(), "oathrion-jail-"));
  const marker = join(jailDir, JAIL_MARKER);
  writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o400 });
  const relaySecretFile = join(jailDir, RELAY_SECRET_FILE);
  writeFileSync(relaySecretFile, relaySecret, { mode: 0o400 });
  const runtimeDir = io.env.XDG_RUNTIME_DIR?.trim() || (typeof process.getuid === "function" ? `/run/user/${String(process.getuid())}` : undefined);
  let decoys: string[] = [];
  try {
    decoys = (JSON.parse(readFileSync(decoyRegistryPath(io.env), "utf8")) as DecoyRegistry).files.map((f) => f.path);
  } catch {
    /* pas de leurres posés */
  }
  const hiddenFiles = showProjectSecrets ? [] : projectSecretFiles(io.cwd, new Set(decoys));
  const bwrap = jailArguments({ home, cwd: io.cwd, stateDir, marker, relaySecret: relaySecretFile, runtimeDir, hiddenFiles, decoys, network: !openNetwork, exists: existsSync });

  /*
   * Le réseau (J4) : dedans, aucun ; dehors, deux passages, le pivot et un mandataire qui
   * n'ouvre que les hôtes permis. Le petit relais du dedans les relie, puis lance l'agent.
   */
  const refusedHosts: string[] = [];
  const hubPort = Number(new URL(conn.base).port);
  const gate = openNetwork ? null : await startGate({ dir: jailDir, hubPort, allowed: allowedHosts, onRefused: (host) => refusedHosts.push(host) });
  const script = realpathSync(io.script ?? process.argv[1] ?? "");
  const inner = openNetwork ? command : [process.execPath, script, "__jail-inside", jailDir, String(hubPort), "--", ...command];

  const { env: cleaned, removed, sockets } = jailEnvironment(io.env, keep);
  const env = openNetwork ? cleaned : { ...cleaned, ...proxyEnvironment() };
  io.out(`Oathrion · ${agentName(command[0]!)} runs in a jail: your secrets and Oathrion's files are out of its reach.`);
  if (removed.length > 0) io.out(`  Secret variables kept out: ${removed.join(", ")} (--keep-env NAME keeps one the agent needs).`);
  if (sockets.length > 0) io.out(`  Kept out too: ${sockets.join(", ")}.`);
  if (hiddenFiles.length > 0) {
    const shown = hiddenFiles.slice(0, 6).map((f) => relative(io.cwd, f));
    io.out(`  Shown empty in the project: ${shown.join(", ")}${hiddenFiles.length > 6 ? ` and ${String(hiddenFiles.length - 6)} more` : ""} (--show-project-secrets shows them).`);
  }
  if (openNetwork) io.out("  Network: open (--network open). The agent can send what it reads anywhere.");
  else if (allowedHosts.length > 0) io.out(`  Network: only HTTPS to ${allowedHosts.join(", ")} (--allow-host HOST adds one).`);
  else io.out(`  Network: none, Oathrion apart. ${agentName(command[0]!)} may need its provider: --allow-host HOST.`);
  /* La première fois d'un agent dans la prison : ce qui va le surprendre, dit avant (10 novembre). */
  const hint = firstTimeHint(stateDir, agentName(command[0]!));
  if (hint) io.out(`  First time in the jail: ${hint}`);

  const code = await new Promise<number>((done) => {
    const child = spawn("bwrap", [...bwrap, "--", ...inner], { stdio: "inherit", env });
    /* Le processus de la prison, au pivot : la veille des agents sait que ce qui en descend est enfermé. */
    if (child.pid) void conn.op({ op: "jail-started", relaySecret, pid: child.pid }).catch(() => null);
    child.on("exit", (status, signal) => done(status ?? (signal ? 128 : 1)));
    child.on("error", () => done(2));
  });
  /* La prison refermée : son secret ne vaut plus rien, ses relais sont détachés. */
  await gate?.close();
  await conn.op({ op: "jail-close", relaySecret }).catch(() => null);
  rmSync(jailDir, { recursive: true, force: true });
  await holder.detach();
  if (refusedHosts.length > 0) {
    io.out(`Oathrion · the jail refused to reach: ${refusedHosts.join(", ")}.`);
    io.out(`  If the agent needed one: oathrion jail ${refusedHosts.map((h) => `--allow-host ${h}`).join(" ")} -- ${command.join(" ")}`);
  }
  /*
   * L'agent n'a même pas pu démarrer (126 : pas exécutable ; 127 : introuvable). Sans ce mot, on
   * revenait à l'invite en silence (tournage du 11 novembre : le `claude` de npm était un fichier
   * d'attente, son binaire jamais installé).
   */
  if (code === 126 || code === 127) {
    io.err(`Oathrion · ${agentName(command[0]!)} could not start: ${command[0]} is ${code === 127 ? "not found" : "not executable"}.`);
    io.err(`  Check that it runs outside the jail: ${command[0]} --version`);
  }
  return code;
}
