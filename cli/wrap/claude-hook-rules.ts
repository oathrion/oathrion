/**
 * Les règles du hook Claude Code : juger un appel d'outil INTÉGRÉ avant qu'il s'exécute.
 *
 * Décidé le 5 novembre 2026 (`notes/CONCEPTION-HOOK-CLAUDE-CODE.md`) : Claude Code exécute son
 * shell et ses écritures de fichiers lui-même, sans passer par MCP, donc sans Oathrion. Son hook
 * `PreToolUse` appelle `oathrion hook claude-code pre`, qui rend l'un de trois verdicts :
 *
 *   · `deny`  — l'outil ne s'exécute pas, et l'agent lit le motif ;
 *   · `ask`   — Claude Code pose SA question, avec le motif d'Oathrion ;
 *   · `null`  — rien : Claude Code applique ses permissions habituelles.
 *
 * JAMAIS `allow` : un `allow` ferait sauter les permissions de Claude Code (observé le
 * 5 novembre). Oathrion ajoute des garde-fous, il n'en retire aucun.
 *
 * Ce module est une fonction PURE : le système de fichiers et git lui sont passés
 * (`RuleContext`). Elle juge la ligne de commande telle qu'écrite, pas ce qu'elle fera : un
 * script peut cacher un `rm`. Ce n'est pas un bac à sable, et la documentation le dit.
 */

import { isAbsolute, relative, resolve } from "node:path";

import { findSecrets, redactSecrets } from "@shared/secrets";

import { carriesDecoy, type Decoys } from "./decoys";
import { guardedTokenIn, serverTokenReason, type GuardedTokens } from "./guarded-tokens";

/** `allow` n'est jamais rendu par les règles : seulement après l'approbation explicite d'une personne (`claude-hook.ts`). */
export type HookVerdict = "deny" | "ask" | "allow" | null;

/** Les outils intégrés que le hook juge. Les lectures ne sont pas interceptées. */
export const GOVERNED_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"] as const;
export const HOOK_MATCHER = GOVERNED_TOOLS.join("|");

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface RuleContext {
  /** Le dossier du projet de la session (`CLAUDE_PROJECT_DIR`, sinon le dossier courant). */
  projectDir: string;
  home: string;
  /** Les dossiers temporaires où l'agent peut écrire librement (le dossier temporaire, son brouillon). */
  scratchDirs: string[];
  exists: (path: string) => boolean;
  /** `true` suivi par git, `false` non suivi, `null` pas de dépôt git. */
  tracked: (path: string) => boolean | null;
  /** Les règles que la personne a désactivées, par identifiant. */
  disabled?: ReadonlySet<string>;
  /** Ses motifs à elle, sur les commandes du shell. */
  extraDeny?: readonly { id: string; pattern: RegExp; reason: string }[];
  extraAsk?: readonly { id: string; pattern: RegExp; reason: string }[];
  /** La session a lu du contenu non fiable (`untrustedSource`) : ses sorties demandent une personne. */
  taint?: Taint | null;
  /** Les leurres posés (`oathrion decoys`) : une valeur qui apparaît est refusée. */
  decoys?: Decoys | null;
  /** Les empreintes des jetons des serveurs protégés (`guarded-tokens.ts`). */
  guarded?: GuardedTokens | null;
}

/** Ce que la session a lu de non fiable, et quand : la PREMIÈRE lecture, qui la marque. */
export interface Taint {
  source: string;
  at: string;
}

export interface Judgement {
  verdict: HookVerdict;
  /** L'identifiant de la règle qui a jugé, ou `null`. */
  rule: string | null;
  reason: string | null;
  action: "claude.shell" | "claude.file.write" | "claude.tool";
  /** `shell://<projet>`, `file://<chemin absolu>` ou `tool://<outil>`. */
  target: string;
  /** Une suppression refusée : les chemins absolus qu'elle visait, pour dire ce qu'elle aurait effacé. */
  deleting?: string[];
  /** Un appel d'outil (le web, un serveur MCP) : ce qu'il fait, secrets masqués, pour le journal. */
  description?: string;
}

/** Les identifiants des règles livrées, pour `disable`. */
export const RULE_IDS = [
  "rm-outside-project",
  "git-force-push",
  "pipe-to-shell",
  "chmod-777-recursive",
  "write-outside-project",
  "protect-guard-files",
  "git-push",
  "package-publish",
  "overwrite-untracked",
  "tainted-session",
  "decoy",
  "server-token",
  "rsync-delete",
  "docker-prune",
  "rm-git-history",
  "git-discard",
  "sql-destroy",
  "script-delete",
  "rm-unreadable-path",
  "gh-publish",
  "secret-egress",
  "cloud-destroy",
  "infra-destroy",
  "db-reset",
  "api-destroy",
] as const;

const PREFIX = "Oathrion";

/**
 * Coupe une ligne de commande en commandes simples. Au-delà de `;`, `&&`, `||`, `|` et des
 * retours à la ligne, elle respecte les guillemets, ouvre les sous-shells et les groupes
 * (`( … )`, `{ … }`), sépare l'arrière-plan (`&`), et DESCEND dans ce qui relance un shell —
 * `bash -c "…"`, `sh -c '…'`, `eval …`, `xargs …`, `timeout … bash -c …`. Sans quoi une commande
 * dangereuse emboîtée (`bash -c 'rm -rf ~'`) passait sans être vue (audit du 8 novembre).
 *
 * Ce n'est toujours PAS un analyseur de shell : une commande dont le programme vient d'une
 * substitution (`` `echo rm` ``, `$(…)`) reste illisible. `judgeShell` la traite à part.
 */
export function splitCommands(command: string): string[] {
  const { rest, bodies } = heredocs(command);
  return [...expandCommands(rest, 0), ...bodies.filter((b) => SHELL_PROGRAMS.has(b.program)).flatMap((b) => expandCommands(b.body, 1))];
}

/*
 * LES HEREDOCS (`<<EOF … EOF`) : leur contenu n'est des commandes que s'il va à un shell
 * (`bash <<EOF`). Passé à un interpréteur (`python3 - <<EOF`), c'est du code, où l'on cherche
 * le réseau ; sinon (`cat > f <<EOF`), de la donnée. Vu le 9 novembre : la chaîne `"http"` d'un
 * script Python était lue comme la commande réseau `http`, et un heredoc qui ne faisait que
 * CONTENIR « curl … | sh » était refusé comme s'il le lançait.
 */
const INTERPRETERS = new Set(["python", "python3", "node", "deno", "bun", "ruby", "perl", "php"]);

function heredocs(command: string): { rest: string; bodies: { program: string; body: string }[] } {
  const lines = command.split("\n");
  const kept: string[] = [];
  const bodies: { program: string; body: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    kept.push(line);
    const opened = /(?:^|[^<])<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (!opened) continue;
    const [, dash, , delimiter] = opened;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const candidate = dash ? lines[j]!.replace(/^\t+/, "") : lines[j]!;
      if (candidate.trim() === delimiter) break;
      body.push(lines[j]!);
    }
    const before = line.slice(0, opened.index + (opened[0].startsWith("<") ? 0 : 1));
    const parts = topLevelParts(before);
    const owner = program(words(parts[parts.length - 1] ?? ""))[0]?.split("/").pop() ?? "";
    bodies.push({ program: owner, body: body.join("\n") });
    i = j;
  }
  return { rest: kept.join("\n"), bodies };
}

/** Du code envoyé à un interpréteur qui parle au réseau. */
const NETWORK_CODE = /https?:\/\/|requests|urllib|fetch\(|http\.|socket|LWP|Net::/i;

const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);

/** Les commandes simples d'une ligne, guillemets respectés, en descendant dans les shells imbriqués. */
function expandCommands(command: string, depth: number): string[] {
  const out: string[] = [];
  for (const { part, from } of withPipes(command)) {
    const tokens = program(words(part));
    out.push(part);
    if (depth >= 4) continue;
    const base = tokens[0]?.split("/").pop();
    /* `bash -c "…"`, `sh -c '…'` : le vrai travail est dans l'argument de `-c`. */
    if (base !== undefined && SHELL_PROGRAMS.has(base)) {
      const flag = tokens.indexOf("-c");
      if (flag >= 0 && tokens[flag + 1] !== undefined) out.push(...expandCommands(tokens[flag + 1]!, depth + 1));
      /* `printf 'rm -rf ~' | sh` : le script arrive par le tube (banc comparatif du 18 novembre). */
      const script = from !== null && tokens.slice(1).every((t) => t.startsWith("-")) ? printed(from) : null;
      if (script !== null) out.push(...expandCommands(script, depth + 1));
    } else if (base === "eval") {
      /* `eval '…'` : ses arguments, mis bout à bout, sont une commande. */
      const rest = tokens.slice(1).join(" ");
      if (rest !== "") out.push(...expandCommands(rest, depth + 1));
    } else if (base === "xargs" || base === "watch" || base === "entr") {
      /* `xargs -n1 rm -rf` : après ses propres options, le reste est la commande qu'il lance. */
      const valued = new Set(["-I", "-i", "-n", "-L", "-l", "-P", "-s", "-d", "-E", "-e", "-a", "-c", "--max-args", "--max-procs", "--delimiter", "--arg-file"]);
      let i = 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) i += valued.has(tokens[i]!) ? 2 : 1;
      /* `echo ~/autre | xargs rm -rf` : ce qu'`echo` écrit devient les arguments de la commande. */
      const fed = base === "xargs" && from !== null ? printed(from) : null;
      const rest = [...tokens.slice(i).map((t) => (/\s/.test(t) ? `'${t}'` : t)), ...(fed !== null ? [fed.replace(/\s+/g, " ")] : [])].join(" ");
      if (rest !== "") out.push(...expandCommands(base === "xargs" ? rest : (tokens[i] ?? ""), depth + 1));
    }
  }
  return out;
}

/** Les commandes de haut niveau, chacune avec celle qui l'alimente par un tube (dans `a | b`, b reçoit a). */
function withPipes(command: string): { part: string; from: string | null }[] {
  const parts = topLevelParts(command);
  let at = 0;
  let previousEnd = -1;
  return parts.map((part, i) => {
    const start = command.indexOf(part, at);
    const piped = i > 0 && start >= 0 && previousEnd >= 0 && /^\s*\|(?!\|)\s*$/.test(command.slice(previousEnd, start));
    if (start >= 0) at = previousEnd = start + part.length;
    else previousEnd = -1;
    return { part, from: piped ? parts[i - 1]! : null };
  });
}

/** Ce qu'`echo` ou `printf` écrit, ou `null` pour toute autre commande. */
function printed(part: string): string | null {
  const [cmd, ...args] = program(words(part));
  const base = cmd?.split("/").pop();
  if (base === "echo") {
    while (args.length > 0 && /^-[neE]+$/.test(args[0]!)) args.shift();
    return args.join(" ");
  }
  if (base === "printf" && args[0] !== undefined) {
    const values = args.slice(1);
    return args[0].replace(/%s/g, () => values.shift() ?? "").replace(/\\n/g, "\n");
  }
  return null;
}

/** Coupe sur les opérateurs de haut niveau (hors guillemets) et ouvre les sous-shells et les groupes. */
function topLevelParts(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && next !== undefined) { current += next; i += 1; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "\\" && next !== undefined) { current += next; i += 1; continue; }
    /* `(`, `)`, `{`, `}`, `;`, `&`, `|`, `\n` et les doublés `&&` `||` : des frontières. */
    if (ch === "\n" || ch === ";" || ch === "(" || ch === ")" || ch === "{" || ch === "}") { parts.push(current); current = ""; continue; }
    /* Mais pas les redirections `2>&1`, `&>fichier`, `>|fichier`, qui ne séparent rien. */
    const prev = command[i - 1];
    if ((ch === "&" && (prev === ">" || next === ">")) || (ch === "|" && prev === ">")) { current += ch; continue; }
    if (ch === "&" || ch === "|") { parts.push(current); current = ""; if (next === ch) i += 1; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "" && part !== "-");
}

/**
 * Découpe une commande simple en mots, comme le shell : les guillemets simples et doubles, les
 * barres obliques inverses, et les morceaux accolés qui forment UN mot (`r''m` est `rm`,
 * `"a"b` est `ab` ; audit du 8 novembre).
 */
export function words(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && next !== undefined && '"\\$`'.includes(next)) { current += next; i += 1; }
      else current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(current);
      current = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "\\" && next !== undefined) { current += next; i += 1; }
    else current += ch;
  }
  if (inWord) out.push(current);
  return out;
}

/*
 * Les préfixes qui lancent la VRAIE commande après eux, avec leurs options. Leurs options qui
 * prennent une valeur sont sautées avec elle : `sudo -u root rm …` est un `rm`, `timeout 5 rm …`
 * aussi (audit du 8 novembre : leurs options faisaient croire que le programme était « -u »).
 */
const WRAPPERS: Record<string, { valued: readonly string[]; positional?: number }> = {
  sudo: { valued: ["-u", "-g", "-p", "-C", "-h", "-U", "-r", "-t", "-D"] },
  doas: { valued: ["-u", "-C"] },
  env: { valued: ["-u", "-C", "-S", "--unset", "--chdir"] },
  nice: { valued: ["-n", "--adjustment"] },
  ionice: { valued: ["-c", "-n", "-p", "-P", "-u"] },
  timeout: { valued: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  stdbuf: { valued: ["-i", "-o", "-e"] },
  chrt: { valued: [], positional: 1 },
  taskset: { valued: [], positional: 1 },
  command: { valued: [] },
  /* Les mots du shell devant une commande : `if`, `then rm …`, `do rm …`, `! rm …`. */
  if: { valued: [] },
  then: { valued: [] },
  else: { valued: [] },
  elif: { valued: [] },
  do: { valued: [] },
  while: { valued: [] },
  until: { valued: [] },
  "!": { valued: [] },
  builtin: { valued: [] },
  exec: { valued: ["-a"] },
  nohup: { valued: [] },
  time: { valued: ["-f", "-o"] },
  setsid: { valued: [] },
  unbuffer: { valued: [] },
};

/** Les mots d'une commande sans ses préfixes (`sudo -u x`, `env -i A=b`, `timeout 5`, `nice -n 3`…). */
function program(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    const base = token.split("/").pop() ?? token;
    const wrapper = WRAPPERS[base];
    if (wrapper) {
      i += 1;
      let positional = wrapper.positional ?? 0;
      while (i < tokens.length) {
        const arg = tokens[i]!;
        if (arg === "--") { i += 1; break; }
        if (wrapper.valued.includes(arg)) { i += 2; continue; }
        if (arg.startsWith("-") && arg.length > 1) { i += 1; continue; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { i += 1; continue; }
        if (positional > 0) { positional -= 1; i += 1; continue; }
        break;
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) i += 1;
    else break;
  }
  return tokens.slice(i);
}

const under = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function expandHome(path: string, home: string): string {
  if (path === "~" || path === "$HOME" || path === "${HOME}") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  if (path.startsWith("$HOME/")) return resolve(home, path.slice(6));
  if (path.startsWith("${HOME}/")) return resolve(home, path.slice(8));
  return path;
}

/**
 * Un chemin que l'agent peut librement toucher : dans le projet, ou dans un dossier temporaire.
 * Jamais le projet lui-même, ni le dossier personnel, ni un dossier qui contient l'un des deux,
 * où qu'ils soient (un projet ou un dossier personnel peut vivre sous `/tmp`).
 */
function freeToTouch(path: string, ctx: RuleContext, cwd: string): boolean {
  const absolute = resolve(cwd, expandHome(path, ctx.home));
  if (under(resolve(ctx.projectDir), absolute) || under(resolve(ctx.home), absolute)) return false;
  return under(absolute, ctx.projectDir) || ctx.scratchDirs.some((dir) => under(absolute, dir));
}

function judgeShell(command: string, ctx: RuleContext): { verdict: HookVerdict; rule: string; reason: string; deleting?: string[] } | null {
  const on = (id: string) => !ctx.disabled?.has(id);
  /*
   * Les variables posées plus tôt sur la ligne, à une valeur écrite en clair (`D=~; rm -rf "$D"`) :
   * elles sont remplacées par leur valeur, comme le fera le shell (banc comparatif du 18 novembre).
   */
  const vars = new Map<string, string>();
  const substitute = (token: string) => token.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (all, a?: string, b?: string) => vars.get(a ?? b ?? "") ?? all);
  const parts: string[][] = [];
  for (const part of splitCommands(command)) {
    const tokens = words(part);
    const declared = ["export", "local", "declare", "readonly", "typeset"].includes(tokens[0] ?? "") ? tokens.slice(1).filter((t) => !t.startsWith("-")) : tokens;
    if (declared.length > 0 && declared.every((t) => /^[A-Za-z_]\w*=/.test(t))) {
      for (const t of declared) {
        const [name, ...value] = t.split("=");
        const text = value.join("=");
        if (text.includes("$(") || text.includes("`")) vars.delete(name!);
        else vars.set(name!, substitute(text));
      }
    }
    parts.push(program(tokens.map(substitute)));
  }

  if (on("secret-egress")) {
    const sent = secretSent(command);
    if (sent) return { verdict: "ask", rule: "secret-egress", reason: `${PREFIX}: this sends ${sent} out of the machine, and it holds secrets. Allow it?` };
  }
  /* Le dossier où chaque commande s'exécute : `cd ~ && rm -rf *` vise le dossier personnel. */
  let cwd = ctx.projectDir;

  for (const [cmd, ...args] of parts) {
    if (cmd === undefined) continue;
    const base = cmd.split("/").pop();

    if (base === "cd" || base === "pushd") {
      const to = args.find((a) => !a.startsWith("-"));
      cwd = to === undefined ? ctx.home : resolve(cwd, expandHome(to, ctx.home));
      continue;
    }

    if (on("protect-guard-files")) {
      const guarded = guardTarget(base ?? "", args, ctx, cwd);
      if (guarded) return { verdict: "deny", rule: "protect-guard-files", reason: `${PREFIX} refuses that the agent changes the files that guard it, or reads its secrets (${guarded}).` };
    }

    if (on("rm-outside-project") && base === "rm") {
      const flags = args.filter((a) => a.startsWith("-") && a !== "--");
      const recursive = flags.some((f) => f === "--recursive" || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)));
      const targets = args.filter((a) => !a.startsWith("-"));
      const outside = targets.find((t) => t === "/" || t === "/*" || !freeToTouch(t, ctx, cwd));
      if (recursive && outside !== undefined) {
        /* « dossier/* » vise le contenu du dossier : on mesure le dossier. */
        const deleting = targets.map((t) => resolve(cwd, expandHome(t.replace(/\/?\*$/, "") || "/", ctx.home)));
        return { verdict: "deny", rule: "rm-outside-project", reason: `${PREFIX} refuses a recursive delete outside the project (${outside}).`, deleting };
      }
    }

    /*
     * Une suppression récursive d'un chemin qu'Oathrion ne peut pas lire (banc comparatif du
     * 18 novembre) : `rm -rf "$BUILD_DIR/"` efface depuis la racine si la variable est vide. Comme
     * pour rsync, une personne décide. `${X:?}` (le shell s'arrête si X est vide) et `$(mktemp -d)`
     * (jamais vide) restent libres.
     */
    if (on("rm-unreadable-path") && base === "rm") {
      const recursive = args.some((a) => a === "--recursive" || (/^-[a-zA-Z]+$/.test(a) && /[rR]/.test(a)));
      const unreadable = args.find((t) => /^(?:\$\{?[A-Za-z_]\w*\}?|\$\([^)]*\)|`[^`]*`)(?:\/\*?)?$/.test(t) && !/^\$\{?(HOME|PWD)\b/.test(t) && !/^(?:\$\(|`)\s*mktemp\b/.test(t));
      if (recursive && unreadable !== undefined) {
        return { verdict: "ask", rule: "rm-unreadable-path", reason: `${PREFIX}: rm -rf ${unreadable}, a path Oathrion cannot read. If it is empty, this deletes from the root of the disk. Allow it?` };
      }
    }

    /*
     * Effacer l'historique git du projet (16 novembre, d'après un vrai signalement :
     * anthropics/claude-code#107274, « 12+ months of git history lost »). Le `.git` est DANS le
     * projet, donc libre pour `rm-outside-project` ; rien ne le restaure. Un fichier sous `.git`
     * (`rm .git/index.lock`) reste ordinaire.
     */
    if (on("rm-git-history") && base === "rm") {
      const recursive = args.some((a) => a === "--recursive" || (/^-[a-zA-Z]+$/.test(a) && /[rR]/.test(a)));
      const history = args.filter((a) => !a.startsWith("-")).find((t) => t.replace(/\/+$/, "").split("/").pop() === ".git");
      if (recursive && history !== undefined) {
        return { verdict: "ask", rule: "rm-git-history", reason: `${PREFIX}: this deletes the project's git history (${history}), which nothing can restore. Allow it?` };
      }
    }

    /*
     * `rsync --delete` (16 novembre, d'après anthropics/claude-code#109735 : une destination en
     * variable, vide, et rsync a synchronisé dans `/`, effaçant un disque entier). Comme `rm -rf` :
     * la racine ou hors du projet est refusé, avec ce qui serait effacé ; une destination
     * qu'Oathrion ne peut pas lire (`$DEST`, `` `…` ``) demande une personne, puisqu'elle peut
     * être vide. Une destination distante (`hôte:chemin`) relève des règles de ce qui sort.
     */
    if (on("rsync-delete") && base === "rsync" && args.some((a) => /^--del(ete)?(-[a-z-]+)?$/.test(a))) {
      const positional = args.filter((a) => !a.startsWith("-"));
      const destination = positional.length >= 2 ? positional[positional.length - 1]! : undefined;
      const remote = destination !== undefined && (/^[^/\s]+:/.test(destination) || destination.startsWith("rsync://"));
      if (destination !== undefined && !remote) {
        if (destination.includes("$") || destination.includes("`")) {
          return { verdict: "ask", rule: "rsync-delete", reason: `${PREFIX}: rsync --delete into ${destination}, a path Oathrion cannot read. If it is empty, rsync deletes from the root of the disk. Allow it?` };
        }
        const target = destination.replace(/\/+$/, "") || "/";
        if (target === "/" || !freeToTouch(target, ctx, cwd)) {
          return { verdict: "deny", rule: "rsync-delete", reason: `${PREFIX} refuses rsync --delete outside the project (${destination}): it deletes what the source does not have.`, deleting: [resolve(cwd, expandHome(target, ctx.home))] };
        }
      }
    }

    /*
     * Les données de Docker effacées pour de bon (16 novembre, d'après
     * anthropics/claude-code#107655 : un « volume prune » a détruit la base d'un autre projet).
     * `prune`, `volume rm`, `compose down -v` : demandés, car ils touchent aussi ce qui n'appartient
     * pas à la tâche.
     */
    if (on("docker-prune") && (base === "docker" || base === "podman" || base === "docker-compose")) {
      const positional = args.filter((a) => !a.startsWith("-"));
      /* La sous-commande connue, où qu'elle soit : `docker --context prod volume rm` (« prod » est la valeur d'une option). */
      const at = positional.findIndex((a) => ["system", "volume", "container", "image", "network", "builder", "compose"].includes(a));
      const [first, second] = base === "docker-compose" ? ["compose", positional[0]] : at < 0 ? [undefined, undefined] : [positional[at], positional[at + 1]];
      const prune = (first === "system" || first === "volume" || first === "container" || first === "image" || first === "network" || first === "builder") && second === "prune";
      const volumeRm = first === "volume" && (second === "rm" || second === "remove");
      const composeDown = first === "compose" && second === "down" && args.some((a) => a === "-v" || a === "--volumes");
      if (prune || volumeRm || composeDown) {
        return { verdict: "ask", rule: "docker-prune", reason: `${PREFIX}: this deletes Docker data for good${prune || composeDown ? ", including data that may belong to other projects" : ""}. Allow it?` };
      }
    }

    /* `find … -delete`, `find … -exec rm` : une suppression récursive, elle aussi. */
    if (on("rm-outside-project") && base === "find") {
      const firstExpr = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
      const roots = (firstExpr < 0 ? args : args.slice(0, firstExpr)).filter((a) => a !== "");
      const exec = args.flatMap((a, i) => (["-exec", "-execdir", "-ok", "-okdir"].includes(a) ? [args[i + 1]?.split("/").pop()] : []));
      const deletes = args.includes("-delete") || exec.some((program) => program === "rm" || program === "shred" || program === "unlink");
      /* `find . -name '*.log' -delete` dans le projet est ordinaire : le projet lui-même est permis comme racine. */
      const inProject = (root: string) => resolve(cwd, expandHome(root, ctx.home)) === resolve(ctx.projectDir);
      const outside = (roots.length > 0 ? roots : ["."]).find((root) => !inProject(root) && !freeToTouch(root, ctx, cwd));
      if (deletes && outside !== undefined) {
        const deleting = (roots.length > 0 ? roots : ["."]).map((root) => resolve(cwd, expandHome(root, ctx.home)));
        return { verdict: "deny", rule: "rm-outside-project", reason: `${PREFIX} refuses a recursive delete outside the project (find ${outside}).`, deleting };
      }
    }

    /*
     * Défaire du travail que rien ne sauvegarde (18 novembre, banc des raisons d'adoption :
     * `git reset --hard` et `git clean -fdx` passaient). Le premier jette les modifications non
     * commitées, le second les fichiers non suivis : aucun n'a de corbeille. `git clean -n`
     * (un essai à blanc) reste libre.
     */
    if (on("git-discard") && base === "git") {
      const sub = gitSubcommand(args);
      if (sub[0] === "reset" && sub.includes("--hard")) {
        return { verdict: "ask", rule: "git-discard", reason: `${PREFIX}: git reset --hard throws away uncommitted changes, which nothing can restore. Allow it?` };
      }
      const cleanFlags = sub.slice(1).filter((a) => a.startsWith("-"));
      const forced = cleanFlags.some((f) => f === "--force" || (/^-[a-zA-Z]+$/.test(f) && f.includes("f")));
      const dryRun = cleanFlags.some((f) => f === "--dry-run" || (/^-[a-zA-Z]+$/.test(f) && f.includes("n")));
      if (sub[0] === "clean" && forced && !dryRun) {
        const ignored = cleanFlags.some((f) => /^-[a-zA-Z]+$/.test(f) && /[xX]/.test(f));
        return { verdict: "ask", rule: "git-discard", reason: `${PREFIX}: git clean deletes the files git does not track${ignored ? ", ignored ones included (.env, local data)" : ""}, with no recycle bin. Allow it?` };
      }
      /* Forcer la suppression de la branche principale (banc comparatif du 18 novembre). `git branch -d` refuse déjà une branche non fusionnée. */
      if (sub[0] === "branch") {
        const flags = sub.slice(1).filter((a) => a.startsWith("-"));
        const deletes = flags.some((f) => f === "--delete" || /^-[a-zA-Z]*[dD]/.test(f));
        const forcedDelete = flags.some((f) => f === "--force" || /^-[a-zA-Z]*[Df]/.test(f));
        const main = sub.slice(1).find((a) => /^(main|master|trunk|develop|production)$/.test(a));
        if (deletes && forcedDelete && main !== undefined) {
          return { verdict: "ask", rule: "git-discard", reason: `${PREFIX}: git branch -D ${main} deletes the main branch, and its commits that are nowhere else. Allow it?` };
        }
      }
    }

    /*
     * Effacer des données d'une base, par son client en ligne de commande (même banc : un
     * `psql -c "DROP TABLE …"` passait). DROP, TRUNCATE, un DELETE sans WHERE, et leurs
     * équivalents MongoDB. Une requête dans un fichier (`-f`) reste illisible : la base doit garder
     * ses propres sauvegardes.
     */
    if (on("sql-destroy") && ["psql", "mysql", "mariadb", "sqlite3", "mongosh", "mongo", "clickhouse-client", "duckdb"].includes(base ?? "")) {
      const text = args.join(" ");
      const destroys =
        /\bdrop\s+(table|database|schema|collection|view|index)\b/i.test(text) ||
        /\btruncate\b/i.test(text) ||
        (/\bdelete\s+from\b/i.test(text) && !/\bwhere\b/i.test(text)) ||
        /\.(drop|dropDatabase)\s*\(/.test(text) ||
        /\.deleteMany\(\s*\{\s*\}\s*\)/.test(text);
      if (destroys) {
        return { verdict: "ask", rule: "sql-destroy", reason: `${PREFIX}: this deletes data from a database for good. Allow it?` };
      }
    }

    const production = destroysProduction(base ?? "", args);
    if (production && on(production.rule)) return { verdict: "ask", rule: production.rule, reason: production.reason };

    /*
     * Une suppression écrite en script, dans la ligne de commande (même banc :
     * `python3 -c "shutil.rmtree('~/autre-projet')"` et `node -e "fs.rmSync(…)"` passaient, là
     * où `rm -rf` est refusé). Un chemin écrit en clair hors du projet est refusé, avec ce qui
     * serait effacé ; un script qui supprime sans chemin lisible demande une personne.
     */
    if (on("script-delete") && /^(python[0-9.]*|node|deno|bun|ruby|perl)$/.test(base ?? "")) {
      const at = args.findIndex((a) => a === "-c" || a === "-e" || a === "--eval" || a === "-p" || a === "--print");
      const code = at >= 0 ? (args[at + 1] ?? "") : "";
      const deletes = /\b(shutil\.rmtree|os\.(remove|unlink|rmdir|removedirs)|\.unlink\(|\.rmdir\(|rmSync|rmdirSync|unlinkSync|fs\.(rm|rmdir|unlink)\b|fs\.promises\.(rm|rmdir|unlink)|rimraf|FileUtils\.(rm_rf|rm_r|rm|remove_dir)|\brmtree\b|Deno\.remove)/.test(code);
      if (deletes) {
        // Paths that look like paths anywhere, plus a bare name given straight to a delete call.
        const literals = [
          ...[...code.matchAll(/(['"`])((?:~|\/|\.\.?\/|\$HOME|\$\{HOME\})[^'"`]*)\1/g)].map((m) => m[2]!),
          ...[...code.matchAll(/(?:rmtree|remove|unlink|rmdir|removedirs|rmSync|rmdirSync|unlinkSync|rm|rm_rf|rm_r|remove_dir|rimraf|rimraf\.sync)\s*\(\s*(['"`])([^'"`$]+)\1/g)].map((m) => m[2]!),
        ];
        const outside = literals.find((p) => p === "/" || !freeToTouch(p, ctx, cwd));
        if (outside !== undefined) {
          return { verdict: "deny", rule: "script-delete", reason: `${PREFIX} refuses a delete written in a script outside the project (${outside}).`, deleting: [resolve(cwd, expandHome(outside, ctx.home))] };
        }
        if (literals.length === 0) {
          return { verdict: "ask", rule: "script-delete", reason: `${PREFIX}: this script deletes files at a path Oathrion cannot read. Allow it?` };
        }
      }
    }

    if (base === "git" && gitSubcommand(args)[0] === "push") {
      const push = gitSubcommand(args);
      if (on("git-force-push") && push.some((a) => a === "--force" || a === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || /^\+/.test(a))) {
        return { verdict: "deny", rule: "git-force-push", reason: `${PREFIX} refuses a forced push: it can erase other people's commits.` };
      }
      if (on("git-push")) {
        return { verdict: "ask", rule: "git-push", reason: `${PREFIX}: a push publishes your commits. Allow it?` };
      }
    }

    if (on("chmod-777-recursive") && base === "chmod") {
      const recursive = args.some((a) => a === "--recursive" || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(a));
      if (recursive && args.some((a) => a === "777" || a === "a+rwx" || a === "ugo+rwx")) {
        return { verdict: "deny", rule: "chmod-777-recursive", reason: `${PREFIX} refuses making a whole tree writable by everyone (chmod -R 777).` };
      }
    }

    /*
     * GitHub, au nom de la personne et pour tout le monde (banc comparatif du 18 novembre) :
     * fusionner une PR, publier ou supprimer une version, supprimer ou archiver un dépôt.
     */
    if (on("gh-publish") && base === "gh") {
      const positional = args.filter((a) => !a.startsWith("-"));
      const acts = ["pr merge", "release create", "release delete", "release upload", "repo delete", "repo archive", "repo rename", "repo transfer"].find((pair) => {
        const [noun, verb] = pair.split(" ");
        const at = positional.indexOf(noun!);
        return at >= 0 && positional[at + 1] === verb;
      });
      if (acts !== undefined) {
        return { verdict: "ask", rule: "gh-publish", reason: `${PREFIX}: gh ${acts} acts on GitHub in your name, for everyone. Allow it?` };
      }
    }

    if (on("package-publish") && ((["npm", "pnpm", "yarn"].includes(base ?? "") && args[0] === "publish") || (base === "cargo" && args[0] === "publish"))) {
      return { verdict: "ask", rule: "package-publish", reason: `${PREFIX}: publishing a package makes it public. Allow it?` };
    }
  }

  /* Le texte d'un heredoc qui n'est que de la donnée ne « lance » rien ; celui qui va à un shell, si. */
  const { rest, bodies } = heredocs(command);
  const runnable = [rest, ...bodies.filter((b) => SHELL_PROGRAMS.has(b.program)).map((b) => b.body)].join("\n");
  if (on("pipe-to-shell") && runsFromNetwork(runnable)) {
    return { verdict: "deny", rule: "pipe-to-shell", reason: `${PREFIX} refuses running a script straight from the network (curl … | sh).` };
  }

  /*
   * Une commande dont le PROGRAMME sort d'une substitution (`` `…` ``, `$(…)`, `$VAR`) : Oathrion
   * ne peut pas savoir ce qu'elle lance. Dans une session à risque, elle demande une personne.
   */
  if (on("tainted-session") && ctx.taint && parts.some(([cmd]) => cmd !== undefined && (cmd.startsWith("$") || cmd.includes("`")))) {
    return { verdict: "ask", rule: "tainted-session", reason: `${PREFIX}: this session read untrusted content (${ctx.taint.source}, at ${ctx.taint.at.slice(11, 16)} UTC), and this command runs a program Oathrion cannot read. It needs a person. Allow it?` };
  }

  for (const extra of ctx.extraDeny ?? []) {
    if (extra.pattern.test(command)) return { verdict: "deny", rule: extra.id, reason: `${PREFIX}: ${extra.reason}` };
  }
  for (const extra of ctx.extraAsk ?? []) {
    if (extra.pattern.test(command)) return { verdict: "ask", rule: extra.id, reason: `${PREFIX}: ${extra.reason}` };
  }
  return null;
}

/*
 * DÉTRUIRE LA PRODUCTION (22 novembre, d'après l'incident PocketOS d'avril 2026,
 * `notes/SYNTHESE-5-INCIDENTS.md`, incident 5) : un agent a effacé le volume de la base de
 * production d'UN appel à l'API de Railway, avec un jeton qui avait tous les droits, en neuf
 * secondes. Ni `rm` ni git : la CLI d'un hébergeur (`cloud-destroy`), un outil d'infrastructure
 * (`infra-destroy`), la remise à zéro d'une base par son outil (`db-reset`), ou un appel d'API
 * direct (`api-destroy`). Chacun demande une personne, et la question dit ce qui serait détruit.
 * Les lectures (`terraform plan`, `kubectl get`, `railway logs`, un `curl` sans méthode) restent
 * libres. Les sous-commandes sont celles des documentations, vérifiées le 22 novembre.
 */
type Destroys = { rule: "cloud-destroy" | "infra-destroy" | "db-reset" | "api-destroy"; reason: string };

/* Les options qui prennent une valeur, communes aux CLI des hébergeurs : leur valeur n'est pas une sous-commande. */
const CLOUD_VALUED = new Set([
  "-p", "--project", "-s", "--service", "-e", "--environment", "-v", "--volume", "--2fa-code", "-a", "--app", "-r", "--remote", "--confirm",
  "--scope", "--team", "--token", "-t", "--region", "--profile", "--output", "-o", "--endpoint-url", "--query", "--context", "--kube-context",
  "-n", "--namespace", "-g", "--resource-group", "--name", "--subscription", "--org", "--access-token", "-h", "--host", "--port", "-U", "--username", "--db-url",
]);
const DELETE_VERBS = new Set(["delete", "rm", "remove"]);

/** Les mots qui ne sont pas des options, sans les valeurs des options qui en prennent une. */
function positionals(args: readonly string[], valued: ReadonlySet<string> = CLOUD_VALUED): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("-") && arg.length > 1) {
      if (valued.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** La valeur d'une option : `--name x`, `--name=x`, `-n x`. */
function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    for (const name of names) {
      if (args[i] === name) return args[i + 1];
      if (args[i]!.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
    }
  }
  return undefined;
}

/** `npx prisma …`, `pnpm exec prisma …`, `bundle exec rails …`, `uv run python manage.py …` : le vrai programme. */
function viaRunner(base: string, args: readonly string[]): [string, string[]] {
  let current = base;
  let rest = [...args];
  for (let depth = 0; depth < 4; depth += 1) {
    let i = 0;
    while (i < rest.length && rest[i]!.startsWith("-")) i += ["-p", "--package"].includes(rest[i]!) ? 2 : 1;
    const next = rest[i];
    if (next === undefined) break;
    const script = next.split("/").pop()!;
    if (["npx", "bunx", "pnpx"].includes(current)) [current, rest] = [script, rest.slice(i + 1)];
    else if (["pnpm", "yarn", "bun", "bundle", "uv", "poetry", "pipenv"].includes(current)) {
      const sub = ["exec", "dlx", "x", "run"].includes(next) ? 1 : 0;
      const program = rest[i + sub];
      if (program === undefined) break;
      [current, rest] = [program.split("/").pop()!, rest.slice(i + sub + 1)];
    } else if (/^python[0-9.]*$/.test(current) && script === "manage.py") [current, rest] = [script, rest.slice(i + 1)];
    else if (current === "php" && script === "artisan") [current, rest] = [script, rest.slice(i + 1)];
    else break;
  }
  return [current, rest];
}

const named = (name: string | undefined) => (name !== undefined && name !== "" ? ` ${name}` : "");
const destroyed = (what: string, provider: string) => `${PREFIX}: this destroys ${what} on ${provider}, and whatever data it holds, for good. Allow it?`;

/* Les CLI qui suivent toutes la même forme : `<outil> <nom…> delete <ressource>`. */
const GENERIC_CLOUD: Record<string, { provider: string; verbs: ReadonlySet<string> }> = {
  gcloud: { provider: "Google Cloud", verbs: new Set(["delete"]) },
  az: { provider: "Azure", verbs: new Set(["delete", "delete-batch", "purge"]) },
  doctl: { provider: "DigitalOcean", verbs: new Set(["delete", "rm"]) },
  neonctl: { provider: "Neon", verbs: new Set(["delete"]) },
  neon: { provider: "Neon", verbs: new Set(["delete"]) },
  pscale: { provider: "PlanetScale", verbs: new Set(["delete"]) },
  turso: { provider: "Turso", verbs: new Set(["destroy"]) },
  wrangler: { provider: "Cloudflare", verbs: new Set(["delete"]) },
};

/* Les API des hébergeurs, où une méthode DELETE ou une mutation de suppression détruit pour de bon. */
const HOSTING_APIS: readonly [RegExp, string][] = [
  [/^backboard\.railway\.(app|com)$/, "Railway"],
  [/^api\.fly\.io$|^api\.machines\.dev$/, "Fly.io"],
  [/^api\.heroku\.com$/, "Heroku"],
  [/^api\.vercel\.com$/, "Vercel"],
  [/^api\.render\.com$/, "Render"],
  [/^api\.digitalocean\.com$/, "DigitalOcean"],
  [/^api\.netlify\.com$/, "Netlify"],
  [/^api\.supabase\.(com|io)$/, "Supabase"],
  [/^console\.neon\.tech$/, "Neon"],
  [/^api\.planetscale\.com$/, "PlanetScale"],
  [/^api\.cloudflare\.com$/, "Cloudflare"],
  [/^api\.turso\.tech$/, "Turso"],
  [/^api\.linode\.com$/, "Linode"],
  [/^api\.hetzner\.cloud$/, "Hetzner"],
  [/^management\.azure\.com$/, "Azure"],
  [/(^|\.)googleapis\.com$/, "Google Cloud"],
  [/(^|\.)amazonaws\.com$/, "AWS"],
];

/** Une mutation GraphQL qui supprime (`volumeDelete`, `serviceDelete`, `projectDelete` chez Railway), ou `null`. */
function deletingMutation(text: string): string | null {
  if (!/\bmutation\b/.test(text)) return null;
  return /\b([a-z][A-Za-z]*(?:Delete|Destroy|Remove|Purge|Wipe|Reset))\b/.exec(text)?.[1] ?? null;
}

function destroysProduction(base0: string, args0: readonly string[]): Destroys | null {
  const [base, args] = viaRunner(base0, args0);
  const pos = positionals(args);
  const cloud = (what: string, provider: string): Destroys => ({ rule: "cloud-destroy", reason: destroyed(what, provider) });

  /* ─── Les hébergeurs ─── */
  if (base === "railway") {
    const [first, second, third] = pos;
    if (DELETE_VERBS.has(first ?? "")) return { rule: "cloud-destroy", reason: `${PREFIX}: this deletes the Railway project${named(optionValue(args, ["-p", "--project"]))}, with all its services, deployments and data, for good. Allow it?` };
    if (first === "down") return { rule: "cloud-destroy", reason: `${PREFIX}: railway down removes the latest deployment of${named(optionValue(args, ["-s", "--service"])) || " the linked service"}: it stops serving until someone deploys again. Allow it?` };
    if ((first === "volume" || first === "volumes") && DELETE_VERBS.has(second ?? "")) return cloud(`the volume${named(optionValue(args, ["-v", "--volume"]))}`, "Railway");
    if ((first === "volume" || first === "volumes") && second === "files" && DELETE_VERBS.has(third ?? "")) return cloud(`files on a volume (${pos[3] ?? "?"})`, "Railway");
    if ((first === "environment" || first === "env") && DELETE_VERBS.has(second ?? "")) return cloud(`the environment${named(third)} and its services`, "Railway");
    if ((first === "service" || first === "bucket") && DELETE_VERBS.has(second ?? "")) return cloud(`the ${first}${named(third ?? optionValue(args, ["-s", "--service"]))}`, "Railway");
    const mutation = first === "api" ? deletingMutation(args.join(" ")) : null;
    if (mutation) return { rule: "api-destroy", reason: `${PREFIX}: this sends the GraphQL mutation ${mutation} to Railway: it destroys a resource for good. One call like this wiped a production database in 9 seconds (PocketOS, April 2026). Allow it?` };
  }
  if (base === "fly" || base === "flyctl") {
    const nouns: Record<string, string> = { apps: "app", app: "app", volumes: "volume", volume: "volume", vol: "volume", machine: "machine", machines: "machine", m: "machine", postgres: "Postgres cluster", pg: "Postgres cluster", mpg: "Postgres cluster" };
    const at = pos.findIndex((w, i) => w === "destroy" || (DELETE_VERBS.has(w) && i > 0 && nouns[pos[i - 1]!] !== undefined));
    if (at >= 0) return cloud(`the ${at === 0 ? "app" : (nouns[pos[at - 1]!] ?? pos[at - 1]!)}${named(pos[at + 1] ?? optionValue(args, ["-a", "--app"]))}`, "Fly.io");
  }
  if (base === "heroku") {
    const app = named(pos[1] ?? optionValue(args, ["-a", "--app"]));
    const what: Record<string, string> = {
      "apps:destroy": `the app${app} and its add-ons`,
      destroy: `the app${app} and its add-ons`,
      "pg:reset": `every table of the Postgres database${app}`,
      "addons:destroy": `the add-on${app}`,
      "addons:remove": `the add-on${app}`,
      "pg:backups:delete": `the database backup${app}`,
      "spaces:destroy": `the private space${app}`,
      "pipelines:destroy": `the pipeline${app}`,
    };
    if (what[pos[0] ?? ""] !== undefined) return cloud(what[pos[0]!]!, "Heroku");
  }
  if (base === "vercel" || base === "vc") {
    if (pos[0] === "remove" || pos[0] === "rm") return cloud(`the deployments of${named(pos[1]) || " a project"}`, "Vercel");
    if ((pos[0] === "project" || pos[0] === "projects") && DELETE_VERBS.has(pos[1] ?? "")) return cloud(`the project${named(pos[2])} and all its deployments`, "Vercel");
    if ((pos[0] === "domains" || pos[0] === "domain") && DELETE_VERBS.has(pos[1] ?? "")) return cloud(`the domain${named(pos[2])}`, "Vercel");
  }
  if (base === "netlify" && (pos[0] === "sites:delete" || (pos[0] === "sites" && pos[1] === "delete"))) return cloud(`the site${named(pos[pos[0] === "sites" ? 2 : 1])}`, "Netlify");
  /* Render ne supprime qu'avec `--confirm` : sans, la commande montre ce qu'elle ferait (sa documentation). */
  if (base === "render" && args.includes("--confirm")) {
    const rp = positionals(args, new Set(["-o", "--output", "--environment", "--project"]));
    const at = rp.indexOf("delete");
    const nouns: Record<string, string> = { services: "service", pg: "Postgres database", kv: "Key Value instance", snapshots: "snapshot", "sandbox-groups": "sandbox group" };
    if (at > 0) return cloud(`the ${nouns[rp[at - 1]!] ?? rp[at - 1]!}${named(rp[at + 1])}`, "Render");
  }
  if (base === "supabase") {
    if ((pos[0] === "projects" || pos[0] === "branches") && DELETE_VERBS.has(pos[1] ?? "")) return cloud(`the ${pos[0] === "projects" ? "project" : "branch"}${named(pos[2])} and its database`, "Supabase");
    if (pos[0] === "db" && pos[1] === "reset") {
      const remote = args.some((a) => a === "--linked" || a === "--db-url" || a.startsWith("--db-url="));
      return { rule: "db-reset", reason: `${PREFIX}: supabase db reset deletes every table and all the data of ${remote ? "the LINKED remote database" : "your local Supabase database"}, then rebuilds it from the migrations. Allow it?` };
    }
  }
  if (base === "aws") {
    if (args.includes("--dry-run")) return null;
    if (pos[0] === "s3" && pos[1] === "rm") return cloud(`${args.includes("--recursive") ? "every object under" : "the object"}${named(pos[2])}`, "AWS S3");
    if (pos[0] === "s3" && pos[1] === "rb") return cloud(`the bucket${named(pos[2])}${args.includes("--force") ? " and every object in it" : ""}`, "AWS S3");
    if (pos[0] === "s3" && pos[1] === "sync" && args.includes("--delete") && (pos[3] ?? "").startsWith("s3://")) return cloud(`the objects in ${pos[3]!} that ${pos[2] ?? "the source"} does not have`, "AWS S3");
    const op = args.findIndex((a) => /^(delete|terminate)-[a-z0-9-]+$/.test(a));
    if (op >= 0) {
      const id = args.slice(op + 1).findIndex((a, i, rest) => a.startsWith("--") && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("-"));
      const which = id >= 0 ? ` ${args[op + 2 + id]!}` : "";
      return cloud(`the ${pos[0] ?? ""} ${args[op]!.replace(/^(delete|terminate)-/, "")}${which}`.replace(/\s+/g, " "), "AWS");
    }
  }
  /* Ici, `-r` est la récursion, pas une option qui prend une valeur. */
  const storage = positionals(args, new Set(["-p", "--project"]));
  if (base === "gsutil" && (storage[0] === "rb" || (storage[0] === "rm" && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a))))) return cloud(`${storage[0] === "rb" ? "the bucket" : "every object under"}${named(storage[1])}`, "Google Cloud Storage");
  if (base === "gcloud" && storage[0] === "storage" && storage[1] === "rm" && args.some((a) => a === "--recursive" || /^-[a-zA-Z]*r/.test(a))) return cloud(`every object under${named(storage[2])}`, "Google Cloud Storage");
  const generic = GENERIC_CLOUD[base];
  if (generic) {
    const at = pos.findIndex((w, i) => generic.verbs.has(w) && (i > 0 || base === "wrangler"));
    if (at >= 0) {
      /* « sql instances » → « sql instance » : la question nomme UNE ressource. */
      const noun = pos.slice(Math.max(0, at - 2), at).join(" ").replace(/sses$/, "ss").replace(/([^s])s$/, "$1") || "Worker";
      return cloud(`the ${noun}${named(pos[at + 1] ?? optionValue(args, ["--name", "-n"]))}`, generic.provider);
    }
  }

  /* ─── L'infrastructure ─── */
  if (base === "terraform" || base === "tofu" || base === "terragrunt") {
    const sub = positionals(args, new Set());
    const target = optionValue(args, ["-target", "--target"]);
    const scope = target !== undefined ? ` (target ${target})` : "";
    const destroy = sub.includes("destroy") || (sub.includes("apply") && args.some((a) => a === "-destroy" || a === "--destroy"));
    if (destroy) return { rule: "infra-destroy", reason: `${PREFIX}: ${base} destroy deletes every resource this configuration manages${scope}, and the data they hold, for good. Allow it?` };
    if (sub.includes("apply") && args.some((a) => a === "-auto-approve" || a === "--auto-approve")) {
      return { rule: "infra-destroy", reason: `${PREFIX}: ${base} apply -auto-approve changes the real infrastructure without showing the plan to anyone: it can replace or destroy what this configuration manages. Allow it?` };
    }
  }
  if (base === "pulumi") {
    const stack = named(optionValue(args, ["-s", "--stack"]));
    if (pos[0] === "destroy" || pos[0] === "down") return { rule: "infra-destroy", reason: `${PREFIX}: pulumi destroy deletes every resource of the stack${stack}, and the data they hold, for good. Allow it?` };
    if (pos[0] === "stack" && pos[1] === "rm") return { rule: "infra-destroy", reason: `${PREFIX}: pulumi stack rm deletes the stack${named(pos[2]) || stack} and its state. Allow it?` };
  }
  if (base === "kubectl" || base === "oc") {
    const valued = new Set(["-n", "--namespace", "--context", "--cluster", "--kubeconfig", "-l", "--selector", "-f", "--filename", "-o", "--output", "--user", "-s", "--server", "--grace-period", "--timeout", "-k", "--kustomize", "--field-selector", "--as", "--replicas"]);
    const kp = positionals(args, valued);
    const namespace = optionValue(args, ["-n", "--namespace"]);
    const context = optionValue(args, ["--context"]);
    const where = [namespace !== undefined ? `namespace ${namespace}` : null, context !== undefined ? `context ${context}` : null].filter(Boolean).join(", ");
    const located = where !== "" ? ` (${where})` : "";
    if (kp[0] === "delete") {
      const all = args.some((a) => a === "--all" || a === "-A" || a === "--all-namespaces");
      const file = optionValue(args, ["-f", "--filename", "-k", "--kustomize"]);
      const object = kp[1] ?? "";
      const [kind, name] = object.includes("/") ? object.split("/") : [kp[1], kp[2]];
      const k = (kind ?? "").toLowerCase().split(",")[0]!;
      /* Un pod, un job, un événement : le contrôleur le recrée, c'est un redémarrage ordinaire. */
      if (["pod", "pods", "po", "job", "jobs", "event", "events", "ev"].includes(k) && !all && file === undefined) return null;
      const what =
        file !== undefined ? `everything defined in ${file}`
        : ["namespace", "namespaces", "ns"].includes(k) ? `the namespace${named(name)} and everything in it: its workloads, volume claims and secrets`
        : ["pvc", "persistentvolumeclaim", "persistentvolumeclaims"].includes(k) ? `the volume claim${named(name)}, and its data if the volume goes with it`
        : ["pv", "persistentvolume", "persistentvolumes"].includes(k) ? `the persistent volume${named(name)}, and possibly its data`
        : all ? `all the ${kind ?? "resources"}`
        : `the ${kind ?? "resource"}${named(name)}`;
      return { rule: "infra-destroy", reason: `${PREFIX}: kubectl delete removes ${what}${located}, for good. Allow it?` };
    }
    const replicas = optionValue(args, ["--replicas"]);
    if (kp[0] === "scale" && replicas === "0" && /prod/i.test(where)) {
      return { rule: "infra-destroy", reason: `${PREFIX}: kubectl scale --replicas=0 takes ${kp.slice(1).join(" ") || "this workload"} down${located}: it stops serving. Allow it?` };
    }
  }
  if (base === "helm" && ["uninstall", "delete", "del", "un"].includes(pos[0] ?? "")) {
    const namespace = optionValue(args, ["-n", "--namespace"]);
    return { rule: "infra-destroy", reason: `${PREFIX}: helm uninstall deletes the release${named(pos[1])} and every Kubernetes resource it installed${namespace !== undefined ? ` (namespace ${namespace})` : ""}. Allow it?` };
  }

  /* ─── Les bases, remises à zéro par leur propre outil (`sql-destroy` lit déjà les requêtes de psql, mysql, mongosh…) ─── */
  const reset = (what: string): Destroys => ({ rule: "db-reset", reason: `${PREFIX}: this deletes ${what}, for good. Allow it?` });
  if (base === "prisma") {
    if (pos[0] === "migrate" && pos[1] === "reset") return reset("every table and all the data of the database Prisma points to (DATABASE_URL)");
    if (pos[0] === "db" && pos[1] === "push" && args.includes("--force-reset")) return reset("every table and all the data of the database Prisma points to (DATABASE_URL)");
    if (pos[0] === "db" && pos[1] === "push" && args.includes("--accept-data-loss")) return reset("the columns and tables the schema no longer has, with their data");
  }
  if (base === "rails" || base === "rake") {
    const task = pos.find((w) => /^db:(drop(:all)?|reset|purge(:all)?|truncate_all|schema:load|migrate:reset)$/.test(w));
    if (task !== undefined) return reset(`the data of the database of the current environment (${base} ${task})`);
  }
  if ((base === "manage.py" || base === "django-admin") && (pos[0] === "flush" || pos[0] === "reset_db")) return reset(`all the data in the Django database (${pos[0]})`);
  if (base === "artisan" && /^(migrate:(fresh|reset|refresh)|db:wipe)$/.test(pos[0] ?? "")) return reset(`every table of the Laravel database and its data (artisan ${pos[0]!})`);
  if (base === "mix" && /^ecto\.(drop|reset)$/.test(pos[0] ?? "")) return reset(`the Ecto database and its data (mix ${pos[0]!})`);
  if ((base === "sequelize" || base === "sequelize-cli") && pos[0] === "db:drop") return reset("the Sequelize database and its data");
  if (base === "typeorm" && pos[0] === "schema:drop") return reset("every table of the TypeORM database and its data");
  if (base === "dropdb") return reset(`the PostgreSQL database${named(pos[pos.length - 1])} and all its data`);
  if (base === "mysqladmin" && pos[0] === "drop") return reset(`the MySQL database${named(pos[1])} and all its data`);
  if (["redis-cli", "valkey-cli", "keydb-cli"].includes(base)) {
    const flush = args.find((a) => /^flush(all|db)$/i.test(a));
    if (flush !== undefined) return reset(flush.toLowerCase() === "flushall" ? "every key in every database of this Redis server (FLUSHALL)" : "every key in the current Redis database (FLUSHDB)");
  }

  /* ─── Un appel direct à l'API d'un hébergeur : l'incident PocketOS lui-même ─── */
  if (["curl", "wget", "http", "https", "xh", "xhs"].includes(base)) {
    const urls = args.flatMap((a) => {
      for (const text of [a, /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(a) ? `https://${a}` : null]) {
        if (text === null) continue;
        try {
          const url = new URL(text);
          if (url.protocol === "https:" || url.protocol === "http:") return [url];
        } catch { /* pas une adresse */ }
      }
      return [];
    });
    const hit = urls.map((url) => ({ url, provider: HOSTING_APIS.find(([host]) => host.test(url.hostname))?.[1] })).find((x) => x.provider !== undefined);
    if (hit) {
      const fused = args.find((a) => /^-X[A-Za-z]+$/.test(a))?.slice(2);
      const leading = base === "curl" || base === "wget" ? undefined : positionals(args, new Set())[0];
      const method = (optionValue(args, ["-X", "--request", "--method"]) ?? fused ?? leading ?? "").toUpperCase();
      const address = `${hit.url.hostname}${hit.url.pathname === "/" ? "" : hit.url.pathname.slice(0, 80)}`;
      if (method === "DELETE") return { rule: "api-destroy", reason: `${PREFIX}: this sends a DELETE to ${address}, the ${hit.provider!} API: it destroys what that address names, and whatever data it holds, for good. Allow it?` };
      const mutation = deletingMutation(args.join(" "));
      if (mutation) return { rule: "api-destroy", reason: `${PREFIX}: this sends the GraphQL mutation ${mutation} to ${hit.url.hostname}, the ${hit.provider!} API: it destroys a resource for good. One call like this wiped a production database in 9 seconds (PocketOS, April 2026). Allow it?` };
    }
  }
  return null;
}

/** Les fichiers qui gardent Oathrion et Claude Code eux-mêmes : l'agent n'y écrit pas. */
function guardFile(path: string, ctx: RuleContext): boolean {
  const absolute = resolve(path);
  const home = resolve(ctx.home);
  const name = absolute.split(/[\\/]/).pop() ?? "";
  return (
    (/[\\/]\.claude[\\/](settings|settings\.local)\.json$/.test(absolute)) ||
    name === ".mcp.json" ||
    absolute === resolve(home, ".claude.json") ||
    under(absolute, resolve(home, ".oathrion"))
  );
}

/** Un secret d'Oathrion, sous `~/.oathrion` : ce que l'agent ne doit même pas lire. */
function oathrionSecret(absolute: string, ctx: RuleContext): boolean {
  if (!under(absolute, resolve(ctx.home, ".oathrion"))) return false;
  const name = absolute.split(/[\\/]/).pop() ?? "";
  /* Le coffre des jetons de serveurs (`server-secrets.ts`) : tout ce qui est dessous. */
  if (under(absolute, resolve(ctx.home, ".oathrion", "_local", "server-secrets"))) return true;
  return ["session.secret", "receipt-signing-key.pem", "decoys.json"].includes(name) || /\.(db|sqlite|sqlite3)(-wal|-shm)?$/.test(name) || /\.pem$/.test(name);
}

/* Les programmes qui ne font que LIRE les chemins qu'on leur donne (hors redirection). */
const READ_ONLY = new Set(["cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "jq", "yq", "ls", "stat", "file", "wc", "diff", "cmp", "md5sum", "sha1sum", "sha256sum", "shasum", "test", "[", "readlink", "realpath", "du", "find", "bat", "od", "xxd", "hexdump", "oathrion"]);

/**
 * LES FICHIERS DE GARDE, PAR LE SHELL AUSSI (audit du 8 novembre). L'outil d'écriture de Claude
 * Code ne pouvait pas toucher `~/.claude/settings.json` ni `~/.oathrion`, mais une redirection,
 * `sed -i`, `cp`, `mv` ou `rm` le pouvaient : un agent manipulé retirait le hook avant d'agir.
 * Une redirection vers un fichier de garde est refusée ; un autre programme qui en NOMME un aussi,
 * sauf s'il ne fait que lire (`cat`, `grep`, `jq`… ; `sed` et `perl` sans `-i`).
 */
function guardTarget(base: string, args: readonly string[], ctx: RuleContext, cwd: string): string | null {
  const guarded = (token: string) => {
    const path = token.replace(/^--?[A-Za-z0-9-]+=/, "");
    if (path === "" || !(/[\\/]/.test(path) || path.startsWith("~") || path.startsWith("$HOME") || path.startsWith("${HOME}") || path === ".mcp.json" || path === ".claude.json")) return null;
    return guardFile(resolve(cwd, expandHome(path, ctx.home)), ctx) ? path : null;
  };
  /*
   * Les SECRETS d'Oathrion (le secret de session du pivot, la clé qui signe les reçus, le registre
   * des leurres, la base) : même les lire est refusé. Avec le premier, un agent ouvrait la console
   * et approuvait ses propres demandes ; avec le registre, il savait quels secrets sont des leurres.
   */
  const secret = args.map((a) => a.replace(/^(?:\d*|&)?[<>]{1,2}\|?/, "").replace(/^--?[A-Za-z0-9-]+=/, "")).find((a) => a !== "" && oathrionSecret(resolve(cwd, expandHome(a, ctx.home)), ctx));
  if (secret) return secret;
  const inPlace = (base === "sed" || base === "perl") && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
  const readOnly = (READ_ONLY.has(base) || base === "sed" || base === "perl" || base === "awk") && !inPlace;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    /* `> f`, `>> f`, `2> f`, `&> f`, `>| f`, et collés : `>f`. */
    const redirect = /^(?:\d*|&)>>?\|?(.*)$/.exec(arg);
    if (redirect) {
      const target = redirect[1] !== "" ? redirect[1]! : (args[i + 1] ?? "");
      if (target !== "" && guarded(target)) return target;
      continue;
    }
    if (!readOnly) {
      const hit = guarded(arg);
      if (hit) return hit;
    }
  }
  return null;
}

/** Les options globales de git avant la sous-commande (`git -C . push`, `git -c a=b push`). */
function gitSubcommand(args: readonly string[]): string[] {
  const valued = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += valued.has(args[i]!) ? 2 : 1;
  return args.slice(i);
}

/**
 * Un script lancé directement depuis le réseau : téléchargé et passé à un shell ou à un
 * interpréteur par un tube, par une substitution de processus (`<(…)`), ou par `-c "$(…)"`.
 */
function runsFromNetwork(command: string): boolean {
  const fetcher = String.raw`\b(?:curl|wget)\b`;
  const runner = String.raw`(?:(?:ba|z|da|k|fi|a)?sh|python[0-9.]*|perl|ruby|node|php|deno|bun)`;
  return (
    new RegExp(String.raw`${fetcher}[^|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+)?${runner}\b`).test(command) ||
    new RegExp(String.raw`(?:\b${runner}|\bsource|(?:^|\s)\.)\s+(?:-\S+\s+)*<\(\s*${fetcher}`).test(command) ||
    new RegExp(String.raw`(?:\b${runner}|\beval)\b[^;&|]*(?:\$\(|\x60)\s*${fetcher}`).test(command)
  );
}

/**
 * La mémoire de Claude Code POUR CE PROJET (`~/.claude/projects/<projet encodé>/memory`) : c'est
 * Claude Code qui y tient ses notes d'une session à l'autre. Refusée comme « hors du projet »,
 * elle bloquait tout utilisateur qui l'a activée (vu le 6 novembre sur la session de travail
 * d'Oathrion même ; autorisée par l'utilisateur). Seulement CE projet, et seulement ce dossier :
 * les réglages de Claude Code restent protégés (`guardFile`).
 */
export function claudeMemoryDir(ctx: Pick<RuleContext, "home" | "projectDir">): string {
  return resolve(ctx.home, ".claude", "projects", resolve(ctx.projectDir).replace(/[^a-zA-Z0-9]/g, "-"), "memory");
}

function judgeWrite(tool: string, filePath: string, ctx: RuleContext): { verdict: HookVerdict; rule: string; reason: string } | null {
  const on = (id: string) => !ctx.disabled?.has(id);
  const absolute = resolve(ctx.projectDir, expandHome(filePath, ctx.home));
  if (on("protect-guard-files") && guardFile(absolute, ctx)) {
    return { verdict: "deny", rule: "protect-guard-files", reason: `${PREFIX} refuses that the agent edits the files that guard it (${absolute}).` };
  }
  const memory = under(absolute, claudeMemoryDir(ctx));
  if (on("write-outside-project") && !memory && !freeToTouch(absolute, ctx, ctx.projectDir)) {
    return { verdict: "deny", rule: "write-outside-project", reason: `${PREFIX} refuses a write outside the project (${absolute}).` };
  }
  /* Un fichier DU PROJET ne profite jamais de l'exemption des dossiers temporaires (un projet peut vivre sous /tmp). */
  const scratch = !under(absolute, ctx.projectDir) && ctx.scratchDirs.some((dir) => under(absolute, dir));
  if (on("overwrite-untracked") && tool === "Write" && ctx.exists(absolute) && ctx.tracked(absolute) !== true && !scratch && !memory) {
    return { verdict: "ask", rule: "overwrite-untracked", reason: `${PREFIX}: this replaces an existing file that git does not track, so it cannot be restored. Allow it?` };
  }
  return null;
}

/**
 * UNE QUESTION QUE PERSONNE NE VERRA DEVIENT UN REFUS (essai du 5 novembre).
 *
 * `ask` laisse Claude Code poser SA question. Mais en mode automatique (« auto mode on »), c'est
 * un classifieur qui y répond, pas une personne : l'utilisateur a vu `git push` partir sans qu'on
 * lui demande rien. Ici, une question n'a de sens que si quelqu'un la lit. Les modes où Claude
 * Code demande à une personne : `default`, `manual`, `plan` ; `acceptEdits` accepte seul les
 * écritures de fichiers, pas le shell. Tout autre mode — `auto`, `bypassPermissions`, `dontAsk`,
 * ou un mode encore inconnu — ne demande à personne : la question devient un refus, et le motif
 * dit comment faire passer l'action.
 */
export function personIsAsked(mode: string | undefined, tool: string): boolean {
  if (mode === undefined || mode === "" || mode === "default" || mode === "manual" || mode === "plan") return true;
  if (mode === "acceptEdits") return !["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool);
  return false;
}

export function forMode(judgement: Judgement, mode: string | undefined, tool: string): Judgement {
  if (judgement.verdict !== "ask" || personIsAsked(mode, tool)) return judgement;
  const why = (judgement.reason ?? `${PREFIX}: this action`).replace(/\s*Allow it\?$/, "");
  return {
    ...judgement,
    verdict: "deny",
    reason: `${why} A person must say yes, and Claude Code is in "${String(mode)}" mode, which asks no one: refused. Switch to the default mode (Shift+Tab) and ask again, or run it yourself.`,
  };
}

/*
 * LA SESSION À RISQUE (décision du 7 novembre) — Oathrion ne devine pas une injection de
 * consignes (prompt injection) : il sait d'où vient ce que l'agent a lu. Une page web, une
 * recherche, un ticket, un e-mail ou un message lus par un outil MCP sont du contenu NON FIABLE :
 * quelqu'un d'autre l'a écrit, et il peut contenir des consignes. Dès la première lecture, la
 * session est marquée ; jusqu'à sa fin, ce qui peut faire SORTIR quelque chose (le réseau, une
 * publication, un push, un message) ou s'installer pour plus tard (un workflow de CI, un hook
 * git) demande une personne, et la question dit pourquoi. La provenance peut se perdre (un
 * contenu recopié dans un fichier qu'une autre session relira) : c'est dit dans la doc.
 */
export const TAINT_MATCHER = "WebFetch|WebSearch|mcp__.*";
const UNTRUSTED_NAME = /fetch|brows|web|url|search|scrap|crawl|issue|pull_?request|comment|discussion|mail|inbox|message|slack|discord|teams|notion|jira|linear|ticket|rss|feed|tweet|post/i;
const READ_VERB = /^(get|read|list|search|fetch|browse|view|show|find|query|retrieve|download|navigate|open|scrape|crawl|lookup)/i;

/** Une lecture de contenu écrit par d'autres : sa description (« WebFetch example.com »), ou null. */
export function untrustedSource(tool: string, input: Record<string, unknown>): string | null {
  if (tool === "WebFetch") {
    try {
      return `WebFetch ${new URL(String(input.url ?? "")).host}`;
    } catch {
      return "WebFetch";
    }
  }
  if (tool === "WebSearch") return "WebSearch";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp && READ_VERB.test(mcp[2]!) && (UNTRUSTED_NAME.test(mcp[1]!) || UNTRUSTED_NAME.test(mcp[2]!))) return `${mcp[1]!} ${mcp[2]!}`;
  return null;
}

/* Le réseau, y compris ce qui sort par une requête DNS ou un écho (`dig $(…).domaine`) : audit du 8 novembre. */
const NETWORK = new Set([
  "curl", "wget", "http", "https", "xh", "nc", "ncat", "netcat", "telnet", "socat", "scp", "sftp", "ftp", "tftp", "lftp", "ssh", "mail", "mailx", "sendmail", "mutt", "aria2c",
  "dig", "nslookup", "host", "drill", "kdig", "whois", "ping", "ping6", "traceroute", "tracepath", "smbclient", "ldapsearch",
]);
const GH_WRITES = /^(create|comment|edit|close|reopen|merge|review|delete|api|upload|fork|set|sync|transfer|archive|rename)$/;

/** Une commande qui peut faire SORTIR quelque chose de la machine, ou s'installer pour plus tard. */
export function isEgress(command: string): boolean {
  /* Du code réseau passé à un interpréteur par un heredoc (`python3 - <<EOF … requests.post … EOF`). */
  if (heredocs(command).bodies.some((b) => INTERPRETERS.has(b.program) && NETWORK_CODE.test(b.body))) return true;
  return splitCommands(command).some((part) => {
    const [cmd, ...args] = program(words(part));
    const base = cmd?.split("/").pop() ?? "";
    if (NETWORK.has(base)) return true;
    if (base === "rsync") return args.some((a) => /^[^/\s]+:/.test(a) || a.startsWith("rsync://"));
    if (base === "openssl") return ["s_client", "s_time"].includes(args[0] ?? "");
    if (base === "git") {
      const sub = gitSubcommand(args);
      return ["push", "send-email", "request-pull"].includes(sub[0] ?? "") || (sub[0] === "remote" && ["add", "set-url"].includes(sub[1] ?? ""));
    }
    if (base === "gh") return ["release", "gist", "secret", "api"].includes(args[0] ?? "") || args.slice(1, 3).some((a) => GH_WRITES.test(a));
    if (["npm", "pnpm", "yarn", "bun"].includes(base)) return args[0] === "publish";
    if (base === "docker" || base === "podman") return args[0] === "push" || args[0] === "login";
    if (base === "aws" || base === "gsutil" || base === "rclone") return args.some((a) => /^(s3|gs|[a-z0-9_-]+):\/\//i.test(a) || /^[a-z0-9_-]+:/i.test(a));
    if (INTERPRETERS.has(base)) return args.some((a) => NETWORK_CODE.test(a));
    return false;
  });
}

/** Un fichier qui agira plus tard, ailleurs : un workflow de CI, un hook git. */
function persistent(absolute: string): boolean {
  return /[\\/]\.github[\\/]workflows[\\/]/.test(absolute) || /[\\/]\.git[\\/]hooks[\\/]/.test(absolute) || /[\\/]\.husky[\\/]/.test(absolute);
}

function taintReason(taint: Taint, what: string): string {
  return `${PREFIX}: this session read untrusted content (${taint.source}, at ${taint.at.slice(11, 16)} UTC), which may contain instructions written by someone else. ${what} needs a person. Allow it?`;
}

/*
 * LES LEURRES ET LES SECRETS QUI SORTIRAIENT (décision du 7 novembre).
 *
 * Un leurre (`decoys.ts`) est un faux secret qu'aucune tâche honnête n'emploie : sa VALEUR dans une
 * commande, une écriture ou l'appel d'un outil est refusée, toujours. Le NOM d'un fichier leurre
 * l'est quand la commande fait sortir quelque chose, ou que la session est à risque : le lire seul
 * ne nuit à rien (il est faux), et la doc d'Oathrion le nomme.
 *
 * Dans une session à risque, ce qui sort dit précisément CE qui sortirait : un jeton GitHub, le
 * contenu de `~/.ssh`. Le web et les outils MCP sont jugés aussi, mais seulement quand ils portent
 * un secret reconnaissable ou un leurre : le reste passe sans rien coûter.
 */
const SENSITIVE_PATH = /(?:^|[\s'"=:/@<])(\.env(?:\.[\w.-]+)?|\.ssh\/[\w.-]*|id_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws\/[\w.-]*|\.netrc|\.npmrc|\.pgpass|\.docker\/config\.json|\.kube\/config)/;

/*
 * UN SECRET ENVOYÉ DEHORS, même hors d'une session à risque (banc comparatif du 18 novembre) :
 * `curl -d @.env https://…`, `cat ~/.ssh/id_rsa | curl -d @- …`, `scp .env hôte:`. Demandé et non
 * refusé : `scp .env deploy@serveur:` est aussi une vraie façon de déployer. Seuls les
 * programmes qui envoient des données comptent, et la clé passée à `-i` (`scp -i ~/.ssh/clé`) ou un
 * fichier reçu (`curl -o .env`) n'est pas un envoi. Les modèles (`.env.example`) restent libres.
 */
const SENDERS = new Set(["curl", "wget", "http", "https", "xh", "nc", "ncat", "netcat", "socat", "telnet", "scp", "sftp", "ftp", "lftp", "tftp", "rsync", "mail", "mailx", "sendmail", "mutt", "aws", "gsutil", "rclone"]);
const TEMPLATE_ENV = /^\.env\.(example|sample|template|schema|defaults|dist)$/;

function secretIn(text: string): string | null {
  const cleaned = text.replace(/(^|\s)(-i|-o|-O|--output|--output-document)\s+\S+/g, " ").replace(/IdentityFile=\S+/g, " ");
  for (const m of cleaned.matchAll(new RegExp(SENSITIVE_PATH.source, "g"))) if (!TEMPLATE_ENV.test(m[1]!)) return m[1]!;
  return null;
}

function secretSent(command: string): string | null {
  for (const { part, from } of withPipes(heredocs(command).rest)) {
    const base = program(words(part))[0]?.split("/").pop() ?? "";
    if (!SENDERS.has(base)) continue;
    const sent = secretIn(part) ?? (from !== null ? secretIn(from) : null);
    if (sent) return sent;
  }
  return null;
}

function decoyReason(what: string, taint: Taint | null): string {
  const read = taint ? ` This session read untrusted content (${taint.source}, at ${taint.at.slice(11, 16)} UTC).` : "";
  return `${PREFIX} refuses: this carries ${what}, one of the decoys planted by « oathrion decoys ». No honest task uses it: your agent was most likely tricked by something it read.${read} Look at what it read before going on.`;
}

/** Ce qui sortirait, dit en clair : « with a GitHub token in it », « with the content of .ssh/id_rsa ». */
function leaving(text: string): string {
  const kinds = findSecrets(text);
  const path = SENSITIVE_PATH.exec(text)?.[1];
  const parts = [kinds.length > 0 ? `${kinds.join(", ")} in it` : null, path ? `${path} in it` : null].filter(Boolean);
  return parts.length > 0 ? ` (with ${parts.join(", and ")})` : "";
}

function describeTool(call: ToolCall): string {
  if (call.tool === "WebFetch") return `WebFetch ${String(call.input.url ?? "")}`;
  if (call.tool === "WebSearch") return `WebSearch ${String(call.input.query ?? "")}`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(call.tool);
  return `${mcp ? `${mcp[1]!} ${mcp[2]!}` : call.tool} ${JSON.stringify(call.input)}`;
}

/**
 * Juge un appel d'outil intégré. Un outil non gouverné n'est pas jugé (`null`).
 * Le web et les outils MCP ne le sont que s'ils portent un secret ou un leurre.
 */
export function judge(call: ToolCall, ctx: RuleContext): Judgement | null {
  const tainted = ctx.taint && !ctx.disabled?.has("tainted-session") ? ctx.taint : null;
  /* Le jeton d'un serveur protégé, employé hors de ce serveur : un contournement d'Oathrion. */
  const stolenText = call.tool === "Bash" && typeof call.input.command === "string" ? call.input.command : JSON.stringify(call.input);
  const stolen = ctx.disabled?.has("server-token") ? null : guardedTokenIn(stolenText, ctx.guarded);
  if (call.tool === "Bash") {
    const command = typeof call.input.command === "string" ? call.input.command : "";
    let found = judgeShell(command, ctx);
    const egress = isEgress(command);
    /* Un refus reste un refus ; sinon, ce qui peut sortir demande une personne, et dit pourquoi. */
    if (tainted && found?.verdict !== "deny" && egress) {
      found = { verdict: "ask", rule: "tainted-session", reason: taintReason(tainted, `Sending something out now${leaving(command)}`) };
    }
    const decoy = !ctx.disabled?.has("decoy") ? carriesDecoy(command, ctx.decoys, egress || tainted !== null) : null;
    if (decoy) found = { verdict: "deny", rule: "decoy", reason: decoyReason(decoy, tainted) };
    else if (stolen && found?.verdict !== "deny") found = { verdict: "deny", rule: "server-token", reason: serverTokenReason(stolen) };
    return {
      verdict: found?.verdict ?? null,
      rule: found?.rule ?? null,
      reason: found?.reason ?? null,
      action: "claude.shell",
      target: `shell://${resolve(ctx.projectDir)}`,
      ...(found?.deleting ? { deleting: found.deleting } : {}),
    };
  }
  if ((GOVERNED_TOOLS as readonly string[]).includes(call.tool)) {
    const raw = call.input.file_path ?? call.input.notebook_path;
    const filePath = typeof raw === "string" && raw !== "" ? raw : "";
    if (filePath === "") return { verdict: null, rule: null, reason: null, action: "claude.file.write", target: "file://" };
    const absolute = resolve(ctx.projectDir, expandHome(filePath, ctx.home));
    let found = judgeWrite(call.tool, filePath, ctx);
    if (tainted && found?.verdict !== "deny" && persistent(absolute)) {
      found = { verdict: "ask", rule: "tainted-session", reason: taintReason(tainted, "Changing a file that runs later (CI, git hooks)") };
    }
    /* La valeur d'un leurre dans ce qui est écrit, ou le fichier leurre lui-même. */
    const name = absolute.split(/[\\/]/).pop() ?? "";
    const decoy = ctx.disabled?.has("decoy") ? null : (carriesDecoy(JSON.stringify(call.input), ctx.decoys, false) ?? (ctx.decoys?.names.includes(name) && under(absolute, ctx.home) ? `the decoy file ${name}` : null));
    if (decoy) found = { verdict: "deny", rule: "decoy", reason: decoyReason(decoy, tainted) };
    else if (stolen && found?.verdict !== "deny") found = { verdict: "deny", rule: "server-token", reason: serverTokenReason(stolen) };
    return { verdict: found?.verdict ?? null, rule: found?.rule ?? null, reason: found?.reason ?? null, action: "claude.file.write", target: `file://${absolute}` };
  }
  if (call.tool === "WebFetch" || call.tool === "WebSearch" || call.tool.startsWith("mcp__")) {
    const text = describeTool(call);
    const decoy = ctx.disabled?.has("decoy") ? null : carriesDecoy(text, ctx.decoys, true);
    const secrets = findSecrets(text);
    if (!decoy && !stolen && secrets.length === 0) return null;
    const judged = { action: "claude.tool" as const, target: `tool://${call.tool}`, description: redactSecrets(text).slice(0, 1_000) };
    if (decoy) return { ...judged, verdict: "deny", rule: "decoy", reason: decoyReason(decoy, tainted) };
    if (stolen) return { ...judged, verdict: "deny", rule: "server-token", reason: serverTokenReason(stolen) };
    if (tainted) return { ...judged, verdict: "ask", rule: "tainted-session", reason: taintReason(tainted, `Sending ${secrets.join(", ")} through ${call.tool.startsWith("mcp__") ? text.split(" ").slice(0, 2).join(" ") : call.tool}`) };
    return { ...judged, verdict: null, rule: null, reason: null };
  }
  return null;
}
