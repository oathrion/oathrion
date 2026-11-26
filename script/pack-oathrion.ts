/**
 * Prépare le paquet npm `oathrion` — SANS le publier.
 *
 *   npm run build
 *   npm run pack:oathrion            # → dist-npm/oathrion/ et dist-npm/oathrion-<version>.tgz
 *
 * Le paquet contient la commande compilée (`oathrion.mjs`), le serveur local
 * (`oathrion-local.cjs`), la console (`public/`), la licence et `docs/wrap.md` comme README.
 * Ses dépendances sont les SEULES que le serveur local charge à l'exécution — relevées dans le
 * paquet compilé, pas supposées : `better-sqlite3` et `pg`. Si le paquet compilé en réclame
 * une autre, ce script refuse plutôt que de livrer un paquet qui échouerait au démarrage.
 *
 * Publier (`npm publish`) demande le compte npm de l'utilisateur et son accord explicite, au
 * moment de le faire. Ce script ne publie rien et n'ouvre aucune connexion.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "dist-npm", "oathrion");
const VERSION =
  process.env.OATHRION_PACK_VERSION?.trim() ||
  (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
const RUNTIME_DEPENDENCIES = ["better-sqlite3", "pg"];

/*
 * L'adresse de contact et le dépôt public (`shared/contact.ts`) : `--contact <adresse>` et
 * `--repo https://github.com/<compte>/<dépôt>`. Sans eux, un paquet partirait avec des
 * emplacements — `oathrion retour` et la console enverraient la personne nulle part. Refusé,
 * sauf `--brouillon` (un paquet d'essai, jamais publié).
 */
const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const CONTACT = arg("contact");
const REPO = arg("repo")?.replace(/\/+$/, "");
const DRAFT = process.argv.includes("--brouillon");
if (CONTACT !== undefined && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(CONTACT)) {
  console.error(`[pack] --contact n'est pas une adresse : « ${CONTACT} ».`);
  process.exit(2);
}
if (REPO !== undefined && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPO)) {
  console.error("[pack] --repo doit être https://github.com/<compte>/<dépôt>.");
  process.exit(2);
}

const NODE_BUILTINS = new Set([
  "async_hooks", "buffer", "child_process", "crypto", "dns", "events", "fs", "http", "https", "net", "os", "path",
  "readline", "stream", "string_decoder", "tls", "tty", "url", "util", "worker_threads", "zlib", "perf_hooks", "querystring",
  "assert", "constants", "diagnostics_channel", "module", "process", "timers", "v8", "vm",
]);

for (const file of ["dist/oathrion.mjs", "dist/oathrion-hook.mjs", "dist/oathrion-local.cjs", "dist/public/index.html"]) {
  if (!existsSync(join(ROOT, file))) {
    console.error(`[pack] ${file} manque : lancez d'abord npm run build.`);
    process.exit(2);
  }
}

/* Ce que le serveur local charge vraiment, relevé dans le paquet compilé. */
const bundle = readFileSync(join(ROOT, "dist/oathrion-local.cjs"), "utf8");
const required = new Set(
  [...bundle.matchAll(/require\("([^"./][^"]*)"\)/g)]
    .map((match) => match[1]!.replace(/^node:/, ""))
    .filter((name) => !NODE_BUILTINS.has(name.split("/")[0]!)),
);
const unexpected = [...required].filter((name) => !RUNTIME_DEPENDENCIES.includes(name));
if (unexpected.length > 0) {
  console.error(`[pack] le serveur local réclame aussi : ${unexpected.join(", ")}. Ajoutez-les à RUNTIME_DEPENDENCIES ou inlinez-les.`);
  process.exit(1);
}

const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
const dependencies = Object.fromEntries(RUNTIME_DEPENDENCIES.map((name) => [name, root.dependencies[name]!]));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, "dist/oathrion.mjs"), join(OUT, "oathrion.mjs"));
cpSync(join(ROOT, "dist/oathrion-hook.mjs"), join(OUT, "oathrion-hook.mjs"));
cpSync(join(ROOT, "dist/oathrion-local.cjs"), join(OUT, "oathrion-local.cjs"));
cpSync(join(ROOT, "dist/public"), join(OUT, "public"), { recursive: true });
/* Le paquet est aussi un plugin Claude Code (26 novembre) : son manifeste et ses hooks, à la racine. */
cpSync(join(ROOT, "plugin/.claude-plugin"), join(OUT, ".claude-plugin"), { recursive: true });
cpSync(join(ROOT, "plugin/hooks"), join(OUT, "hooks"), { recursive: true });
/* La version du plugin est celle du paquet, posée ici : le dépôt n'en porte pas, pour ne pas la figer à côté. */
const pluginManifest = JSON.parse(readFileSync(join(OUT, ".claude-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
writeFileSync(join(OUT, ".claude-plugin/plugin.json"), `${JSON.stringify({ name: pluginManifest.name, version: VERSION, ...pluginManifest }, null, 2)}\n`);
/*
 * La CONSOLE seulement : ce que `public/index.html` charge, en suivant les imports. Le site
 * vitrine n'a rien à faire dans `oathrion wrap` (la racine y mène à la console) — et le
 * 28 octobre 2026, son code embarquait deux identifiants privés et une adresse @gmail.com,
 * vus par la vérification ci-dessous juste avant une première publication (§5.57).
 */
{
  const publicDir = join(OUT, "public");
  /* Les mascottes des agents : la fenêtre de notification et la console les montrent (11 novembre). */
  const reachable = new Set<string>([
    "index.html",
    "favicon.png",
    ...(existsSync(join(publicDir, "mascots")) ? readdirSync(join(publicDir, "mascots")).filter((f) => f.endsWith(".png")).map((f) => `mascots/${f}`) : []),
    /* L'identité sonore : jouée par le pivot (.wav), envoyée au téléphone (.mp3). */
    ...(existsSync(join(publicDir, "sounds")) ? readdirSync(join(publicDir, "sounds")).filter((f) => /\.(wav|mp3)$/.test(f)).map((f) => `sounds/${f}`) : []),
  ]);
  const queue = ["index.html"];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const text = readFileSync(join(publicDir, file), "utf8");
    /* Les polices (16 novembre) : le CSS les charge par `url(/assets/….woff2)`. Gardées, jamais relues. */
    for (const match of text.matchAll(/(?:\/|\.\/)?(assets\/[\w.-]+\.(?:js|css|woff2))|["'`]\.\/([\w.-]+\.(?:js|css))["'`]/g)) {
      const target = match[1] ?? (file.startsWith("assets/") ? `assets/${match[2]!}` : match[2]!);
      if (!reachable.has(target) && existsSync(join(publicDir, target))) {
        reachable.add(target);
        if (!target.endsWith(".woff2")) queue.push(target);
      }
    }
  }
  const walk = (dir: string, prefix = ""): string[] =>
    readdirSync(dir).flatMap((entry) => (statSync(join(dir, entry)).isDirectory() ? walk(join(dir, entry), `${prefix}${entry}/`) : [`${prefix}${entry}`]));
  for (const file of walk(publicDir)) if (!reachable.has(file)) rmSync(join(publicDir, file));
  for (const dir of ["site", "img"]) if (existsSync(join(publicDir, dir)) && walk(join(publicDir, dir)).length === 0) rmSync(join(publicDir, dir), { recursive: true });
  console.log(`[pack] console : ${String(reachable.size)} fichier(s) gardé(s) ; le site vitrine est laissé de côté.`);
}

cpSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));
cpSync(join(ROOT, "NOTICE"), join(OUT, "NOTICE"));
/* Le README du paquet est `docs/wrap.md`, tel quel : depuis la publication, il n'a plus rien de faux à retirer. */
const readme = readFileSync(join(ROOT, "docs/wrap.md"), "utf8");
writeFileSync(join(OUT, "README.md"), readme);

writeFileSync(
  join(OUT, "package.json"),
  `${JSON.stringify(
    {
      name: "oathrion",
      version: VERSION,
      description: "Govern any MCP server with one command: reads pass, writes wait for your approval, destructive tools are blocked, every executed call leaves a receipt in a tamper-evident chain.",
      license: "Apache-2.0",
      bin: { oathrion: "oathrion.mjs" },
      files: ["oathrion.mjs", "oathrion-hook.mjs", "oathrion-local.cjs", "public", ".claude-plugin", "hooks", "LICENSE", "NOTICE", "README.md"],
      engines: { node: ">=22" },
      keywords: ["mcp", "model-context-protocol", "ai-agents", "governance", "approval", "audit"],
      /* Les liens de la page npm : sans eux, rien n'y mène au dépôt ni au site. */
      ...(REPO ? { homepage: "https://oathrion.com", repository: { type: "git", url: `git+${REPO}.git` }, bugs: { url: `${REPO}/issues` } } : {}),
      dependencies,
    },
    null,
    2,
  )}\n`,
);

/* Les emplacements de contact, remplacés dans chaque fichier texte du paquet ; refusé s'il en reste. */
{
  const stillThere: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (!/\.(png|jpe?g|gif|webp|ico)$/i.test(entry)) {
        let text = readFileSync(path, "utf8");
        const before = text;
        /* esbuild écrit le tiret « — » `\u2014` dans `oathrion.mjs` : les deux formes. */
        if (CONTACT) for (const dash of ["—", "\\u2014"]) text = text.split(`[contact address ${dash} set before publication]`).join(CONTACT);
        if (REPO) text = text.split("https://github.com/OWNER/REPO").join(REPO);
        if (text !== before) writeFileSync(path, text);
        if (/set before publication|github\.com\/OWNER\/REPO/.test(text)) stillThere.push(path.slice(OUT.length + 1));
      }
    }
  };
  visit(OUT);
  if (stillThere.length > 0 && !DRAFT) {
    console.error(`[pack] REFUSÉ : l'adresse de contact ou le dépôt public manquent (--contact, --repo) dans :\n  ${stillThere.join("\n  ")}\n  Pour un paquet d'essai jamais publié : --brouillon.`);
    process.exit(1);
  }
  if (stillThere.length > 0) console.log(`[pack] BROUILLON : emplacements de contact laissés (${String(stillThere.length)} fichier(s)) — ne pas publier.`);
}

/*
 * Le garde-fou : rien de privé dans le paquet. Les identifiants de `notes/identifiants-prives.txt`
 * (absent de l'arbre public, d'où le test de présence) et toute adresse @gmail.com.
 */
{
  const privateFile = join(ROOT, "notes", "identifiants-prives.txt");
  const literals = existsSync(privateFile)
    ? readFileSync(privateFile, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")).map((line) => line.split("=>")[0]!.trim()).filter(Boolean)
    : [];
  const leaks: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) scan(path);
      else if (!/\.(png|jpe?g|gif|webp|ico)$/i.test(entry)) {
        const text = readFileSync(path, "utf8");
        literals.forEach((literal, index) => {
          if (text.includes(literal)) leaks.push(`${path.slice(OUT.length + 1)} (identifiant privé n° ${String(index + 1)})`);
        });
        if (/[\w.%+-]+@gmail\.com/.test(text)) leaks.push(`${path.slice(OUT.length + 1)} (adresse @gmail.com)`);
      }
    }
  };
  scan(OUT);
  if (leaks.length > 0) {
    console.error(`[pack] REFUSÉ : des identifiants privés sont dans le paquet (valeurs non affichées) :\n  ${leaks.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[pack] aucun identifiant privé dans le paquet (${String(literals.length)} recherché(s), plus toute adresse @gmail.com).`);
}

/* `npm pack` : une archive locale, aucune connexion. */
/* Sous Windows, `npm` est un `npm.cmd` : il ne se lance que par le shell, chemin entre guillemets (tâche `visitor` de la CI, 12 novembre). */
const onWindows = process.platform === "win32";
const destination = join(ROOT, "dist-npm");
const tarball = execFileSync("npm", ["pack", "--pack-destination", onWindows ? `"${destination}"` : destination], { cwd: OUT, encoding: "utf8", shell: onWindows }).trim().split("\n").pop();
console.log(`[pack] dist-npm/oathrion/ prêt ; archive : dist-npm/${String(tarball)}`);
console.log(`[pack] dépendances : ${Object.entries(dependencies).map(([n, v]) => `${n}@${v}`).join(", ")}`);
console.log("[pack] RIEN n'a été publié. npm publish demande le compte et l'accord de l'utilisateur.");
