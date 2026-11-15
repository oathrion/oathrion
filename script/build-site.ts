/**
 * Le site public, en fichiers statiques autonomes.
 *
 * ## Pourquoi ce script existe
 *
 * `npm run build` produit UN dossier qui contient deux applications : le site public et
 * la console. Elles partagent `dist/public/assets/`, et le `index.html` de la racine est
 * celui de la **console** — c'est `server/static.ts` qui aiguille, à l'exécution.
 *
 * Publier ce dossier tel quel sur un hébergeur statique a deux défauts. L'adresse `/`
 * servirait la console au lieu du site, et on mettrait en ligne 790 Ko de code de console
 * — une application d'administration — sans aucune raison, pour un lancement où aucun
 * locataire n'existe encore.
 *
 * Ce script sort donc le site SEUL, avec son `index.html` à la racine, et ne copie que
 * les fragments que son point d'entrée atteint réellement.
 *
 * ## Comment il sait quoi copier
 *
 * Il suit le graphe, il ne devine pas. Il part des fichiers cités par le HTML, puis
 * remonte les `from"./x.js"` et les `import("./x.js")` de proche en proche. Une liste
 * écrite à la main se périmerait au premier changement de découpage de Vite, et
 * silencieusement : le site partirait en ligne avec un fragment manquant.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

//
// `fileURLToPath(import.meta.url)` plutôt que `import.meta.dirname`, qui n'existe qu'à
// partir de Node 20.11. Le dépôt déclare `node >= 20` et l'emploie partout ailleurs,
// mais un script de PUBLICATION est exactement celui qu'on lance un soir, depuis le
// shell qu'on avait sous la main — il doit échouer sur une version trop vieille en le
// DISANT, pas avec un `ERR_INVALID_ARG_TYPE` dans `path.resolve`.
//
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major! < 20 || (major === 20 && minor! < 11)) {
  console.error(
    `\n  ✗ Node ${process.versions.node} est trop ancien. Ce dépôt demande Node 20 ou plus` +
    `\n    (package.json, champ "engines"). Avec nvm :  nvm use\n`,
  );
  process.exit(1);
}
const BUILT = path.join(ROOT, "dist", "public");
const OUT = path.join(ROOT, "dist", "site");

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const entryHtml = path.join(BUILT, "site", "index.html");
if (!fs.existsSync(entryHtml)) {
  fail("dist/public/site/index.html est absent — lancez d'abord `npm run build`.");
}

/* ------------------------------------------------- le graphe des fragments */

let html = fs.readFileSync(entryHtml, "utf8");

/* ------------------------------------------------------------- le domaine */

/*
 * L'adresse publique, posée au build.
 *
 * `canonical`, `og:url`, `og:image`, `twitter:image` et le JSON-LD doivent porter une URL
 * ABSOLUE : un chemin relatif fonctionne dans le navigateur et échoue silencieusement
 * chez tous les lecteurs d'aperçu, qui ne connaissent pas la page d'origine. Elles
 * portaient un domaine en dur. Le gabarit cite desormais `example.invalid`, reserve par
 * la RFC 2606 : il ne resoudra jamais, et personne ne peut le prendre pour un choix
 * delibere. Un gabarit qui cite un vrai domaine est pire -- il peut appartenir a
 * quelqu'un d'autre, et une erreur d'oubli devient alors un lien vers un inconnu.
 *
 * Le script ne refuse pas de construire sans la variable : on doit pouvoir regarder le
 * site chez soi avant d'avoir acheté quoi que ce soit. Mais il le DIT, et fort, parce
 * qu'un canonical pointant vers un domaine qu'on ne possède pas est le genre d'erreur
 * qu'on ne voit jamais soi-même : elle ne se manifeste que dans un moteur de recherche et
 * dans les aperçus de lien que les autres partagent.
 */
const PLACEHOLDER = "https://example.invalid";
const origin = (process.env.OATHRION_SITE_ORIGIN ?? "").trim().replace(/\/+$/, "");
const warnings: string[] = [];

if (origin) {
  if (!/^https:\/\/[^/\s]+$/.test(origin)) {
    fail(`OATHRION_SITE_ORIGIN doit être une origine https sans chemin — reçu : ${origin}`);
  }
  const before = html;
  html = html.split(PLACEHOLDER).join(origin);
  if (before === html) {
    fail(`aucune occurrence de ${PLACEHOLDER} dans le HTML — le gabarit a changé, ce script ne sait plus où écrire le domaine.`);
  }
} else if (html.includes(PLACEHOLDER)) {
  warnings.push(
    `Le domaine est resté ${PLACEHOLDER}, qui n'est pas acquis.\n` +
    `    canonical, og:url, og:image et le JSON-LD pointent donc dans le vide.\n` +
    `    Reconstruisez avec :  OATHRION_SITE_ORIGIN=https://votre-domaine npm run build:site`,
  );
}
const assetsDir = path.join(BUILT, "assets");

const seen = new Set<string>();
const queue: string[] = [];

for (const m of html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)) {
  queue.push(m[1]!);
}
if (queue.length === 0) {
  fail("le HTML du site ne référence aucun fragment — le build a-t-il abouti ?");
}

while (queue.length > 0) {
  const name = queue.shift()!;
  if (seen.has(name)) continue;
  seen.add(name);
  const file = path.join(assetsDir, name);
  if (!fs.existsSync(file)) fail(`fragment introuvable : assets/${name}`);
  if (!name.endsWith(".js")) continue;
  const code = fs.readFileSync(file, "utf8");
  //
  // Les deux formes que Vite émet : l'import statique et l'import dynamique.
  //
  // Le filtre sur l'extension n'est pas de la prudence, c'est une correction. Le site
  // AFFICHE du code : la page développeurs contient, dans une chaîne de caractères,
  // `import { withOathrion } from "./with-placet"`. Un relevé qui lit le fichier comme du
  // texte ne distingue pas un vrai import d'un exemple montré au lecteur. Seuls les noms
  // en `.js` ou `.css` sont des fragments ; tout le reste est du contenu.
  //
  for (const m of code.matchAll(/(?:from\s*"\.\/|import\(\s*"\.\/)([^"]+)"/g)) {
    const ref = m[1]!;
    if (ref.endsWith(".js") || ref.endsWith(".css")) queue.push(ref);
  }
}

/* --------------------------------------------------------------- la sortie */

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });

// Le HTML du site devient la racine : c'est tout l'intérêt de l'opération.
fs.writeFileSync(path.join(OUT, "index.html"), html);

let bytes = 0;
for (const name of seen) {
  const from = path.join(assetsDir, name);
  fs.copyFileSync(from, path.join(OUT, "assets", name));
  bytes += fs.statSync(from).size;
}

function copyDir(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let total = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) total += copyDir(a, b);
    else { fs.copyFileSync(a, b); total += fs.statSync(a).size; }
  }
  return total;
}
const imgBytes = copyDir(path.join(BUILT, "img"), path.join(OUT, "img"));
for (const f of ["favicon.png"]) {
  const src = path.join(BUILT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, f));
}

/*
 * Les règles de réécriture, écrites pour les deux hébergeurs qui les lisent
 * automatiquement. Le site route par CHEMIN (`/product`, `/pilot`) côté navigateur :
 * sans réécriture, l'hébergeur renvoie 404 sur tout rechargement d'une page profonde —
 * c'est le piège classique, et il ne se voit qu'après la mise en ligne, quand quelqu'un
 * partage un lien direct.
 */
fs.writeFileSync(path.join(OUT, "_redirects"), "/*    /index.html   200\n");
fs.writeFileSync(path.join(OUT, "vercel.json"),
  JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/index.html" }] }, null, 2) + "\n");

/*
 * `robots.txt` : il manquait, et sans lui une page de conditions ou une page 404 se
 * retrouve indexée aussi bien que l'accueil.
 */
const ROUTES = [
  "/", "/product", "/how-it-works", "/use-cases", "/agent-payments", "/developers", "/pricing",
  "/pilot", "/waitlist", "/about", "/roadmap", "/security", "/contact",
  "/terms", "/privacy",
];

fs.writeFileSync(
  path.join(OUT, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /console\n` +
    (origin ? `\nSitemap: ${origin}/sitemap.xml\n` : ""),
);

/*
 * Le plan du site n'est écrit QUE si le domaine est connu : une URL de sitemap doit être
 * absolue, et sans domaine il n'y a rien de valide à écrire. Un sitemap faux est pire
 * qu'absent — il demande à un moteur d'indexer des adresses qui n'existent pas.
 */
if (origin) {
  const urls = ROUTES.map(
    (r) => `  <url><loc>${origin}${r}</loc><changefreq>weekly</changefreq></url>`,
  ).join("\n");
  fs.writeFileSync(
    path.join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
}

const kb = (n: number) => `${Math.round(n / 1024)} Ko`;
console.log(`
  Site statique écrit dans dist/site/

    ${seen.size} fragments               ${kb(bytes)}
    images                       ${kb(imgBytes)}
    réécritures                  _redirects + vercel.json
    robots.txt                   la console est exclue de l'indexation

    domaine                      ${origin || PLACEHOLDER + "  (non défini)"}

  Déposez CE dossier chez l'hébergeur. Rien d'autre n'est nécessaire :
  ni Node, ni base de données, ni variable d'environnement.
`);

for (const w of warnings) {
  console.warn(`  ⚠  ${w}\n`);
}
