/**
 * Le lanceur des VRAIS hooks : chaque action du corpus (`corpus.ts`) est envoyée à un hook comme
 * Claude Code l'enverrait (`PreToolUse`, en JSON sur l'entrée standard), et son verdict est noté,
 * avec le temps qu'il a pris. Rien n'est exécuté : un hook JUGE une commande, il ne la lance pas.
 *
 *   npx tsx script/bench/vrais-hooks.ts --nom <nom> --config <settings.json|hooks.json> \
 *     [--racine-plugin <dossier>] [--mode bypassPermissions] [--preparer] [--sous <dossier>] \
 *     --sortie <fichier.json>
 *
 *   · `--config` : un fichier au format de Claude Code (`hooks.PreToolUse`, et `permissions.deny`) ;
 *     `${CLAUDE_PLUGIN_ROOT}` y vaut `--racine-plugin`.
 *   · `--preparer` : crée la machine supposée par le corpus (le projet, un dépôt git, un autre
 *     projet), propre pour la session type, avec du travail en cours pour le corpus large.
 *   · `--sous` : place cette machine dans un dossier jetable (les chemins `/home/dev` du corpus y
 *     sont déplacés). Sans lui, il faut une machine où `/home/dev` est jetable : le conteneur de
 *     `script/bench/concurrents.Dockerfile`.
 *
 * Le code d'un hook concurrent ne se lance que dans une machine jetable (`script/bench/LISEZMOI.md`).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HOME, LARGE, PROJET, SESSION, type Cas } from "./corpus";

export type VerdictObserve = "passe" | "demande" | "refuse" | "erreur";
export interface Observation {
  id: string;
  verdict: VerdictObserve;
  par?: string;
  raison?: string;
  ms: number;
}
export interface Releve {
  nom: string;
  config: string;
  mode: string;
  date: string;
  node: string;
  resultats: Observation[];
}

interface HookCmd {
  type?: string;
  command: string;
  args?: string[];
  timeout?: number;
}
interface Config {
  hooks?: { PreToolUse?: { matcher?: string; hooks: HookCmd[] }[] };
  permissions?: { deny?: string[] };
}

const argv = process.argv.slice(2);
const opt = (nom: string) => {
  const i = argv.indexOf(`--${nom}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/* Les règles `permissions.deny` de Claude Code, telles que sa documentation les décrit. */
function glob(motif: string, home: string): RegExp {
  const m = motif.replace(/^~(?=\/)/, home);
  const re = m
    .split("")
    .map((ch, i, all) => {
      if (ch === "*" && all[i + 1] === "*") return "\u0000";
      if (ch === "*" && all[i - 1] === "*") return "";
      if (ch === "*") return "[^/]*";
      return /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    })
    .join("")
    .replace(/\u0000\//g, "(?:.*/)?")
    .replace(/\u0000/g, ".*");
  return new RegExp(`${m.startsWith("/") ? "^" : "(?:^|/)"}${re}$`);
}
function sousCommandes(commande: string): string[] {
  return commande.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}
export function refusParRegles(cas: Cas, deny: readonly string[], home: string): string | null {
  for (const regle of deny) {
    const m = /^(\w+)\((.*)\)$/.exec(regle);
    if (!m) continue;
    const [, outil, motif] = m as unknown as [string, string, string];
    if (outil === "Bash" && cas.call.tool === "Bash") {
      const prefixe = motif.replace(/:?\*$/, "").replace(/ $/, "");
      const ouvert = /\*$/.test(motif);
      if (sousCommandes(String(cas.call.input.command ?? "")).some((s) => (ouvert ? s === prefixe || s.startsWith(`${prefixe} `) : s === motif))) return regle;
    }
    const fichier = String(cas.call.input.file_path ?? "");
    const ecrit = ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(cas.call.tool);
    if (fichier && ((outil === "Edit" && ecrit) || outil === cas.call.tool) && glob(motif, home).test(fichier)) return regle;
  }
  return null;
}

function lancer(h: HookCmd, payload: string, env: NodeJS.ProcessEnv, racinePlugin: string): Promise<{ code: number | null; out: string; err: string }> {
  const sub = (s: string) => s.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, racinePlugin);
  const proc = h.args ? spawn(sub(h.command), h.args.map(sub), { env }) : spawn("sh", ["-c", sub(h.command)], { env });
  let out = "";
  let err = "";
  proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
  proc.stderr.on("data", (c: Buffer) => (err += c.toString()));
  proc.stdin.end(payload);
  const limite = setTimeout(() => proc.kill("SIGKILL"), (h.timeout ?? 60) * 1000);
  return new Promise((done) => proc.on("close", (code) => (clearTimeout(limite), done({ code, out, err }))));
}

/** Le verdict d'un hook, lu comme Claude Code le lit. */
export function lireVerdict(code: number | null, out: string): { verdict: VerdictObserve; raison?: string } {
  if (code === 2) return { verdict: "refuse" };
  if (code === null) return { verdict: "erreur", raison: "délai dépassé" };
  const texte = out.trim();
  if (!texte.startsWith("{")) return { verdict: "passe" };
  try {
    const j = JSON.parse(texte) as { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    const d = j.hookSpecificOutput?.permissionDecision;
    const raison = j.hookSpecificOutput?.permissionDecisionReason ?? j.reason;
    if (d === "deny" || j.decision === "block") return { verdict: "refuse", raison };
    if (d === "ask") return { verdict: "demande", raison };
    return { verdict: "passe", raison };
  } catch {
    return { verdict: "passe" };
  }
}

/** La machine supposée par le corpus. `sale` : du travail non commité et des fichiers non suivis. */
function preparer(home: string, sale: boolean): void {
  const projet = join(home, "app");
  const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid", ...a], { cwd, stdio: "ignore" });
  for (const d of [join(projet, "src", "invoices"), join(projet, "dist"), join(projet, "scripts"), join(home, "other-project", "src"), join(home, "Documents"), join(home, ".ssh")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(projet, "package.json"), '{ "name": "app", "version": "1.0.0" }\n');
  writeFileSync(join(projet, ".gitignore"), "node_modules\ndist\n.env\n");
  writeFileSync(join(projet, "src", "index.ts"), "export const total = 1;\n");
  writeFileSync(join(projet, "README.md"), "# app\n");
  writeFileSync(join(projet, "dist", "index.js"), "1\n");
  writeFileSync(join(home, "other-project", "src", "index.ts"), "x\n");
  writeFileSync(join(home, "Documents", "note.txt"), "x\n");
  for (const dir of [projet, join(home, "other-project")]) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init", "--allow-empty");
  }
  git(projet, "checkout", "-q", "-B", "fix/invoice-rounding");
  if (sale) {
    writeFileSync(join(projet, "src", "index.ts"), "export const total = 2;\n");
    writeFileSync(join(projet, "brouillon.txt"), "en cours\n");
  } else {
    git(projet, "checkout", "-q", "--", ".");
    spawnSync("rm", ["-f", join(projet, "brouillon.txt")]);
  }
}

/** Les chemins du corpus, déplacés sous `sous`. */
function deplacer(c: Cas, sous: string | undefined): Cas {
  if (!sous) return c;
  const texte = JSON.stringify(c.call).split(HOME).join(join(sous, HOME));
  return { ...c, call: JSON.parse(texte) as Cas["call"] };
}

export async function releve(nom: string, configPath: string, options: { mode: string; racinePlugin: string; preparerMachine: boolean; sous?: string }): Promise<Releve> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  const home = options.sous ? join(options.sous, HOME) : HOME;
  const projet = options.sous ? join(options.sous, PROJET) : PROJET;
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: projet, CLAUDE_PLUGIN_ROOT: options.racinePlugin };
  const entrees = config.hooks?.PreToolUse ?? [];
  const deny = config.permissions?.deny ?? [];
  const resultats: Observation[] = [];
  for (const [jeu, liste, sale] of [["session", SESSION, false], ["large", LARGE, true]] as const) {
    if (options.preparerMachine) preparer(home, sale);
    for (const brut of liste) {
      const c = deplacer(brut, options.sous);
      const id = jeu === "large" ? `large-${brut.id}` : brut.id;
      const t0 = performance.now();
      const regle = refusParRegles(c, deny, home);
      if (regle) {
        resultats.push({ id, verdict: "refuse", par: "permissions.deny", raison: regle, ms: performance.now() - t0 });
        continue;
      }
      const payload = JSON.stringify({ session_id: `bench-${nom}`, transcript_path: "/dev/null", cwd: projet, permission_mode: options.mode, hook_event_name: "PreToolUse", tool_name: c.call.tool, tool_input: c.call.input, tool_use_id: `toolu_${id}` });
      const verdicts: { verdict: VerdictObserve; par: string; raison?: string }[] = [];
      for (const entree of entrees) {
        if (entree.matcher && entree.matcher !== "*" && !new RegExp(`^(?:${entree.matcher})$`).test(c.call.tool)) continue;
        for (const h of entree.hooks) {
          const { code, out } = await lancer(h, payload, env, options.racinePlugin);
          verdicts.push({ ...lireVerdict(code, out), par: h.args?.join(" ") ?? h.command });
        }
      }
      const pire = verdicts.find((v) => v.verdict === "refuse") ?? verdicts.find((v) => v.verdict === "demande") ?? verdicts.find((v) => v.verdict === "erreur");
      resultats.push({ id, verdict: pire?.verdict ?? "passe", par: pire?.par, raison: pire?.raison?.slice(0, 300), ms: performance.now() - t0 });
    }
  }
  return { nom, config: configPath, mode: options.mode, date: new Date().toISOString(), node: process.version, resultats };
}

if (process.argv[1]?.endsWith("vrais-hooks.ts")) {
  const nom = opt("nom");
  const config = opt("config");
  const sortie = opt("sortie");
  if (!nom || !config || !sortie) {
    console.error("Usage : --nom <nom> --config <fichier> --sortie <fichier.json> [--racine-plugin <dossier>] [--mode bypassPermissions] [--preparer] [--sous <dossier>]");
    process.exit(3);
  }
  const r = await releve(nom, config, { mode: opt("mode") ?? "bypassPermissions", racinePlugin: opt("racine-plugin") ?? dirname(config), preparerMachine: argv.includes("--preparer"), sous: opt("sous") });
  mkdirSync(dirname(sortie), { recursive: true });
  writeFileSync(sortie, `${JSON.stringify(r, null, 1)}\n`);
  const compte = (v: string) => r.resultats.filter((x) => x.verdict === v).length;
  console.log(`${nom} : ${String(r.resultats.length)} actions — ${String(compte("refuse"))} refusées, ${String(compte("demande"))} demandées, ${String(compte("erreur"))} erreurs → ${sortie}`);
}
