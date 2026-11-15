/**
 * LA PRISON PAR DÉFAUT — `oathrion jail --always [agent…]` et `oathrion jail --always --undo`.
 *
 * La prison n'enferme que l'agent qu'on y lance. Pour qu'elle ne dépende plus d'une habitude :
 * un petit lanceur par agent (`~/.oathrion/bin/cursor-agent`, `~/.oathrion/bin/claude`,
 * `~/.oathrion/bin/agy`) qui relance la commande dans `oathrion jail`, et ce dossier en tête du
 * `PATH`, par un bloc balisé
 * dans `~/.bashrc`, `~/.profile` et `~/.zshrc` (copiés avant d'être changés). Taper
 * `cursor-agent` l'enferme. Dans la prison, `~/.oathrion` est masqué : les lanceurs n'y sont
 * pas, et l'agent ne peut pas les retirer (le dossier personnel y est en lecture seule).
 *
 * Ce que ça ne fait pas : une application de bureau (Cursor, Claude Desktop) lancée par son
 * icône n'est pas enfermée ; un agent lancé par son chemin complet non plus.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ALWAYS_AGENTS = ["cursor-agent", "claude", "agy"];
const BEGIN = "# >>> oathrion jail >>>";
const END = "# <<< oathrion jail <<<";
const RC_FILES = [".bashrc", ".profile", ".zshrc"];

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Le vrai programme, dans le PATH, en dehors des lanceurs d'Oathrion. */
export function realAgent(name: string, pathEnv: string, shimDir: string): string | null {
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    if (dir === shimDir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      /* pas ici */
    }
  }
  return null;
}

/**
 * Le lanceur : dans la prison déjà, le vrai programme ; sinon, `oathrion jail` autour. Le vrai
 * programme est cherché dans le PATH À CHAQUE LANCEMENT (hors du dossier des lanceurs) : un agent
 * mis à jour change souvent de chemin (`cursor-agent/versions/<version>/…`), et un chemin noté à
 * l'installation ne mènerait plus nulle part. `fallback` sert si le PATH ne le donne pas.
 */
/**
 * Un lanceur posé par `oathrion jail --always` (`shimScript`), et non l'agent lui-même : ce qui
 * tourne vraiment est le programme qu'il lance (11 novembre, parcours sur un compte neuf :
 * `npx oathrion` confirmait le lanceur, et Claude Code, lancé par lui, était refusé).
 */
export function isJailShim(file: string): boolean {
  try {
    return /^#!\/bin\/sh\n# Oathrion: .+ always runs in the jail\./.test(readFileSync(file).subarray(0, 300).toString("utf8"));
  } catch {
    return false;
  }
}

export function shimScript(options: { name: string; fallback: string; shimDir: string; node: string; script: string }): string {
  return [
    "#!/bin/sh",
    `# Oathrion: ${options.name} always runs in the jail. « oathrion jail --always --undo » removes this.`,
    `real=''`,
    `old_ifs=$IFS; IFS=:`,
    `for d in $PATH; do`,
    `  [ "$d" = ${quote(options.shimDir)} ] && continue`,
    `  if [ -f "$d/${options.name}" ] && [ -x "$d/${options.name}" ]; then real="$d/${options.name}"; break; fi`,
    `done`,
    `IFS=$old_ifs`,
    `[ -n "$real" ] || real=${quote(options.fallback)}`,
    `if [ -n "$OATHRION_JAILED" ]; then exec "$real" "$@"; fi`,
    `exec ${quote(options.node)} ${quote(options.script)} jail -- "$real" "$@"`,
    "",
  ].join("\n");
}

/** Le texte d'un fichier de démarrage du shell, avec le bloc d'Oathrion (ou sans, pour `--undo`). */
export function withBlock(text: string, add: boolean): string {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  const without = start !== -1 && end > start ? `${text.slice(0, start).replace(/\n+$/, "\n")}${text.slice(end + END.length).replace(/^\n+/, "")}` : text;
  if (!add) return without;
  const base = without === "" || without.endsWith("\n") ? without : `${without}\n`;
  return `${base}${BEGIN}\n# Agents run in Oathrion's jail (oathrion jail --always --undo removes this).\nexport PATH="$HOME/.oathrion/bin:$PATH"\n${END}\n`;
}

/** La prison par défaut : poser, retirer, savoir (pour `oathrion jail --always` et `npx oathrion`). */
export interface JailAlwaysInstaller {
  /** Les agents installés sur cette machine, parmi ceux qu'on sait enfermer. */
  available(): string[];
  /** Chaque agent installé a son lanceur, et le PATH du shell y mène. */
  installed(): boolean;
  /** Quelque chose en a été posé (un lanceur, le bloc du PATH) : `--undo` a de quoi retirer. */
  present(): boolean;
  /** Les agents désormais enfermés par défaut (« nom (chemin) »). */
  install(): string[];
  remove(): void;
}

export function jailAlwaysInstaller(options: { home: string; script: string; env: NodeJS.ProcessEnv; agents?: readonly string[] }): JailAlwaysInstaller {
  const shimDir = join(options.home, ".oathrion", "bin");
  const agents = options.agents && options.agents.length > 0 ? options.agents : ALWAYS_AGENTS;
  const available = () => agents.filter((name) => realAgent(name, options.env.PATH ?? "", shimDir) !== null);
  const blockPresent = () => RC_FILES.some((rc) => existsSync(join(options.home, rc)) && readFileSync(join(options.home, rc), "utf8").includes(BEGIN));
  return {
    available,
    installed: () => {
      const found = available();
      /* Un lanceur de l'ancien format (un chemin de version fixe, avant le 10 novembre au soir) est à refaire. */
      const current = (name: string) => existsSync(join(shimDir, name)) && readFileSync(join(shimDir, name), "utf8").includes("for d in $PATH");
      return found.length === 0 || (blockPresent() && found.every(current));
    },
    present: () => blockPresent() || agents.some((name) => existsSync(join(shimDir, name))),
    install: () => {
      mkdirSync(shimDir, { recursive: true, mode: 0o700 });
      const script = realpathSync(options.script);
      const done: string[] = [];
      for (const name of agents) {
        const real = realAgent(name, options.env.PATH ?? "", shimDir);
        if (!real) continue;
        const shim = join(shimDir, name);
        writeFileSync(shim, shimScript({ name, fallback: real, shimDir, node: process.execPath, script }), { mode: 0o755 });
        chmodSync(shim, 0o755);
        done.push(`${name} (${real})`);
      }
      if (done.length === 0) return done;
      for (const rc of RC_FILES) {
        const file = join(options.home, rc);
        if (rc === ".zshrc" && !existsSync(file)) continue;
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        const next = withBlock(text, true);
        if (next === text) continue;
        if (existsSync(file) && !existsSync(`${file}.oathrion-backup`)) copyFileSync(file, `${file}.oathrion-backup`);
        writeFileSync(file, next);
      }
      return done;
    },
    remove: () => {
      for (const name of agents) rmSync(join(shimDir, name), { force: true });
      for (const rc of RC_FILES) {
        const file = join(options.home, rc);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, "utf8");
        const next = withBlock(text, false);
        if (next !== text) writeFileSync(file, next);
      }
    },
  };
}

export function runJailAlways(argv: readonly string[], io: { out: (line: string) => void; err: (line: string) => void; env: NodeJS.ProcessEnv; home: string; script: string }): number {
  const names = argv.filter((a) => !a.startsWith("--"));
  const installer = jailAlwaysInstaller({ home: io.home, script: io.script, env: io.env, agents: names });
  if (argv.includes("--undo")) {
    installer.remove();
    io.out("Oathrion · agents start as before, outside the jail. Open a new terminal for it to apply.");
    return 0;
  }
  const wanted = names.length > 0 ? names : ALWAYS_AGENTS;
  for (const name of wanted.filter((n) => !installer.available().includes(n))) io.out(`  ${name}: not installed here, left out.`);
  const done = installer.install();
  if (done.length === 0) {
    io.err("No agent to put in the jail: none of them is installed in your PATH.");
    return 2;
  }
  io.out("Oathrion · these agents now always start in the jail:");
  for (const line of done) io.out(`  ${line}`);
  io.out("Open a new terminal for it to apply. « oathrion jail --always --undo » puts things back.");
  io.out("Not covered: a desktop app started from its icon (Cursor, Claude Desktop), or an agent started by its full path.");
  return 0;
}
