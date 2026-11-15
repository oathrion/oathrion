/**
 * Prépare l'arbre du DÉPÔT PUBLIC d'Oathrion — tâche C8 du plan de publication
 * (`notes/PUBLICATION-10-NOVEMBRE.md`). Ne publie rien, n'envoie rien.
 *
 *   npm run public:prepare -- --brouillon                       # essai : les emplacements restent
 *   npm run public:prepare -- --contact contact@… --security security@… --repo https://github.com/<org>/oathrion
 *   … --verify                                                  # + typage, lint, build, tests sur l'arbre produit
 *
 * Produit `dist-public/oathrion/`, un dépôt git dont l'index contient l'arbre public. La première
 * fois, le dépôt est NEUF ; ensuite son `.git` (historique, `origin`) est gardé, et l'index ne
 * porte que ce qui a changé : un commit puis un push ordinaires, jamais forcés. Les commits sont
 * laissés à la personne : son nom et son adresse publics ne sont pas ceux de ce dépôt de travail.
 *
 * ## Ce qui sort, et ce qui reste
 *
 *   · seuls les fichiers SUIVIS par git sortent, et la liste de refus de la livraison
 *     (`release-manifest.ts` : `.env`, bases, clés…) s'applique comme pour `npm run package` ;
 *   · restent en plus : `notes/`, et les rapports internes à la racine
 *     (`ARIA-*`, `PHASE-*`, `AUDIT-*`, `RAPPORT-*`). L'historique complet reste privé.
 *
 * ## Les identifiants retirés
 *
 * La liste vit dans `notes/identifiants-prives.txt`, que ce script ne publie jamais, plus les
 * valeurs NON SECRÈTES de `~/.config/placet/*-test.env` (dépôt GitHub de test et son
 * propriétaire, canal Slack de test), lues à l'exécution. Aucune valeur n'est jamais affichée :
 * le rapport dit « identifiant n° 3 : 2 remplacement(s) dans docs/… ». Après remplacement, une
 * seule occurrence restante est un refus.
 *
 * ## Les emplacements à remplacer
 *
 * Les adresses de contact et de sécurité et l'adresse du dépôt public n'existent pas encore.
 * Sans `--contact`, `--security` et `--repo`, l'arbre est produit en BROUILLON (option
 * `--brouillon`) et le script finit en le disant — sinon il refuse.
 *
 * ## Ce qui est signalé sans être retiré
 *
 * Le nom du titulaire des droits figure dans `NOTICE`, les licences et les pages légales du
 * site : c'est voulu. Le rapport en liste les fichiers, pour une relecture humaine.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { manifestProblems } from "./release-manifest";

const ROOT = process.cwd();
const OUT = join(ROOT, "dist-public", "oathrion");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const say = (line: string) => console.log(`[public] ${line}`);
function fail(message: string): never {
  console.error(`\n[public] REFUS : ${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------- 1. l'arbre suivi, propre */
const git = (gitArgs: string[], cwd = ROOT) => execFileSync("git", gitArgs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const dirtyTree = git(["status", "--porcelain"]).trim() !== "";
if (dirtyTree && !flag("brouillon")) fail("l'arbre de travail a des modifications : l'arbre public doit venir d'un commit.");
if (dirtyTree) say("BROUILLON sur un arbre de travail MODIFIÉ : le contenu copié n'est celui d'aucun commit.");
const commit = git(["rev-parse", "--short", "HEAD"]).trim();
const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);

const forbidden = manifestProblems(tracked);
if (forbidden.length > 0) fail(`${String(forbidden.length)} fichier(s) suivi(s) ne doivent jamais sortir :\n${forbidden.map((p) => `  ${p}`).join("\n")}`);

const PRIVATE_PATH = /^(notes\/|(ARIA|PHASE|AUDIT|RAPPORT)-[^/]*\.md$)/;
const published = tracked.filter((path) => !PRIVATE_PATH.test(path));
say(`commit ${commit} : ${String(tracked.length)} fichiers suivis, ${String(published.length)} publiés, ${String(tracked.length - published.length)} gardés privés (notes/, rapports internes)`);

/* ----------------------------------------------------- 2. les identifiants à retirer */
const privateFile = join(ROOT, "notes", "identifiants-prives.txt");
if (!existsSync(privateFile)) fail("notes/identifiants-prives.txt manque : sans liste, rien ne garantit que l'arbre est propre.");
const literals: { value: string; replacement: string }[] = readFileSync(privateFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((value) => ({ value, replacement: value.includes("@") ? "<adresse personnelle retirée>" : "<identifiant retiré>" }));

function testEnv(file: string, key: string): string | null {
  const path = join(homedir(), ".config", "placet", file);
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && line.slice(0, at).trim() === key) return line.slice(at + 1).trim().replace(/^"|"$/g, "") || null;
  }
  return null;
}
const repo = testEnv("github-test.env", "PLACET_GITHUB_TEST_REPO");
if (repo?.includes("/")) {
  literals.push({ value: repo, replacement: "<compte-de-test>/<dépôt-de-test>" });
  literals.push({ value: repo.split("/")[0]!, replacement: "<compte-de-test>" });
}
const channel = testEnv("slack-test.env", "PLACET_SLACK_TEST_CHANNEL");
if (channel && channel.length >= 6) literals.push({ value: channel, replacement: "<canal-de-test>" });
/* Les plus longues d'abord : « compte/dépôt » avant « compte ». */
literals.sort((a, b) => b.value.length - a.value.length);
say(`${String(literals.length)} identifiant(s) privé(s) à retirer (valeurs non affichées)`);

/* ----------------------------------------------------- 3. les emplacements à remplacer */
const contact = option("contact");
const security = option("security");
const repoUrl = option("repo")?.replace(/\/+$/, "");
const draft = flag("brouillon");
const placeholders: { file: string; pattern: RegExp; value: string | undefined; label: string }[] = [
  { file: "SECURITY.md", pattern: /\[security contact address — set before publication\]/g, value: security, label: "--security" },
  { file: "CODE_OF_CONDUCT.md", pattern: /\[contact address — set before publication\]/g, value: contact, label: "--contact" },
  { file: ".github/ISSUE_TEMPLATE/config.yml", pattern: /https:\/\/github\.com\/OWNER\/REPO/g, value: repoUrl, label: "--repo" },
  { file: "README.md", pattern: /<this repository>/g, value: repoUrl, label: "--repo" },
  { file: "README.md", pattern: /\[contact address — set before publication\]/g, value: contact, label: "--contact" },
  { file: "client/site/lib/submit.ts", pattern: /(export const CONTACT_EMAIL = ")[^"]*(";)/g, value: contact, label: "--contact" },
  /* La commande et la console (`oathrion retour`, « Votre équipe ») lisent ces deux-là. */
  { file: "shared/contact.ts", pattern: /\[contact address — set before publication\]/g, value: contact, label: "--contact" },
  { file: "shared/contact.ts", pattern: /https:\/\/github\.com\/OWNER\/REPO/g, value: repoUrl, label: "--repo" },
  /* L'exemple de l'action GitHub : `uses: <compte>/<dépôt>/action/verify@v0` (15 novembre, relevé au premier vrai essai). */
  { file: "action/verify/README.md", pattern: /OWNER\/REPO(\/action\/verify@v0)\s+# set before publication/g, value: repoUrl === undefined ? undefined : `${repoUrl.replace("https://github.com/", "")}$1`, label: "--repo" },
];
for (const [label, value] of [["--contact", contact], ["--security", security]] as const) {
  if (value !== undefined && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value)) fail(`${label} n'est pas une adresse : « ${value} ».`);
}
if (repoUrl !== undefined && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoUrl)) fail(`--repo doit être https://github.com/<compte>/<dépôt>.`);
const missing = [...new Set(placeholders.filter((p) => p.value === undefined).map((p) => p.label))];
if (missing.length > 0 && !draft) fail(`il manque ${missing.join(", ")}. Ajoutez-les, ou produisez un --brouillon.`);

/* ----------------------------------------------------------------- 4. copier, nettoyer */
/* Déjà poussé : on garde son `.git`, le reste est refait. */
const keptGit = existsSync(join(OUT, ".git"));
if (keptGit) for (const entry of readdirSync(OUT)) if (entry !== ".git") rmSync(join(OUT, entry), { recursive: true, force: true });
if (!keptGit) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const report = new Map<number, Map<string, number>>();
const isText = (path: string) => !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|db|sqlite)$/i.test(path);
for (const path of published) {
  const target = join(OUT, path);
  mkdirSync(dirname(target), { recursive: true });
  if (!isText(path)) {
    cpSync(join(ROOT, path), target);
    continue;
  }
  let text = readFileSync(join(ROOT, path), "utf8");
  for (const placeholder of placeholders) {
    if (placeholder.file !== path || placeholder.value === undefined) continue;
    text = placeholder.file === "client/site/lib/submit.ts"
      ? text.replace(placeholder.pattern, `$1${placeholder.value}$2`)
      : text.replace(placeholder.pattern, placeholder.value);
  }
  literals.forEach(({ value, replacement }, index) => {
    const count = text.split(value).length - 1;
    if (count === 0) return;
    text = text.split(value).join(replacement);
    const perFile = report.get(index + 1) ?? new Map<string, number>();
    perFile.set(path, count);
    report.set(index + 1, perFile);
  });
  writeFileSync(target, text);
}
for (const [index, files] of report) {
  say(`identifiant n° ${String(index)} : ${[...files].map(([f, n]) => `${String(n)} dans ${f}`).join(", ")}`);
}

/* ------------------------------------------------- 5. revérifier l'arbre PRODUIT, relu */
const leaks: string[] = [];
const stillPlaceholders: string[] = [];
const reviewName: string[] = [];
for (const path of published.filter(isText)) {
  const text = readFileSync(join(OUT, path), "utf8");
  literals.forEach(({ value }, index) => {
    if (text.includes(value)) leaks.push(`identifiant n° ${String(index + 1)} dans ${path}`);
  });
  /* Une ADRESSE (quelque chose avant le @), comme le garde-fou du paquet : parler d'« une adresse @gmail.com » n'en est pas une. */
  if (/[\w.%+-]+@gmail\.com/i.test(text)) leaks.push(`une adresse @gmail.com dans ${path}`);
  /* Ces deux outils CHERCHENT les emplacements : leurs motifs ne sont pas des emplacements oubliés. */
  const searchesPlaceholders = path === "script/prepare-public.ts" || path === "script/pack-oathrion.ts";
  if (!searchesPlaceholders && /set before publication|github\.com\/OWNER\/REPO|<this repository>/.test(text)) stillPlaceholders.push(path);
  if (/Abdoulaye|Diallo/.test(text) && !/Awa Diallo/.test(text)) reviewName.push(path);
}
if (leaks.length > 0) fail(`des identifiants privés restent dans l'arbre produit :\n  ${leaks.join("\n  ")}`);
say(`aucun identifiant privé dans l'arbre produit (${String(literals.length)} recherché(s), plus toute adresse @gmail.com)`);
if (reviewName.length > 0) say(`À RELIRE — le nom du titulaire figure dans : ${reviewName.join(", ")} (voulu pour NOTICE, licences, pages légales)`);

/* ------------------------------------------- 6. un dépôt (neuf la première fois), sans commit */
if (!keptGit) git(["init", "-q", "-b", "main"], OUT);
git(["add", "-A"], OUT);
if (keptGit) {
  const changed = git(["status", "--short"], OUT).split("\n").filter(Boolean).length;
  say(`dist-public/oathrion/ : historique gardé, ${String(changed)} fichier(s) changé(s) dans l'index, AUCUN commit (à faire par vous, sous votre nom public)`);
} else {
  say(`dist-public/oathrion/ : dépôt git neuf, ${String(published.length)} fichiers dans l'index, AUCUN commit (à faire par vous, sous votre nom public)`);
}

/* ------------------------------------------------------------------ 7. --verify */
if (flag("verify")) {
  symlinkSync(join(ROOT, "node_modules"), join(OUT, "node_modules"), "dir");
  for (const [label, command, commandArgs] of [
    ["typage", "npx", ["tsc", "--noEmit"]],
    ["lint", "npx", ["eslint", "."]],
    ["build", "npm", ["run", "build"]],
    ["tests", "npx", ["vitest", "run"]],
  ] as const) {
    const run = spawnSync(command, [...commandArgs], { cwd: OUT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, DATABASE_URL: "" } });
    const tail = `${run.stdout}\n${run.stderr}`.trim().split("\n").filter((l) => /Tests |Test Files|error|✖|problem/i.test(l)).slice(-3).join(" | ");
    if (run.status !== 0) fail(`${label} échoue sur l'arbre public. ${tail}`);
    say(`${label} : ✓ ${tail}`);
  }
  rmSync(join(OUT, "node_modules"));
}

if (stillPlaceholders.length > 0) {
  say(`BROUILLON — emplacements encore présents dans : ${stillPlaceholders.join(", ")}. Non publiable tel quel.`);
} else {
  say("Prêt à relire. Rien n'a été publié : le dépôt GitHub, le commit et l'envoi restent à faire, par vous.");
}
