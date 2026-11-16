import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { readFileSync } from "node:fs";
import { copyFile, rm, readFile } from "node:fs/promises";

/*
 * Server dependencies to bundle into `dist/index.cjs`, to reduce openat(2)
 * syscalls and help cold-start time. Everything else stays external and is
 * resolved from `node_modules` at runtime.
 *
 * This list used to name two dozen packages this project has never depended on
 * (stripe, passport, jsonwebtoken, ws, xlsx, multer, openai…), inherited from a
 * template. Dead entries are harmless to esbuild but they misdescribe the
 * deployment: someone reading them would reasonably conclude the server talks to
 * a payment provider. Only real, server-side dependencies are listed now.
 *
 * `better-sqlite3` is deliberately absent: it is a native addon and must be
 * loaded from `node_modules`, never bundled.
 */
const allowlist = ["cross-spawn", "dotenv", "drizzle-orm", "drizzle-zod", "express", "zod"];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  // A name in the allowlist that is not an actual dependency silently does
  // nothing, which is how the stale template list survived unnoticed.
  const unknown = allowlist.filter((dep) => !allDeps.includes(dep));
  if (unknown.length > 0) {
    console.warn(`warning: allowlist names packages that are not dependencies: ${unknown.join(", ")}`);
  }

  /* Les mêmes définitions pour le serveur et pour son point d'entrée local (oathrion wrap). */
  const serverDefine = {
    "process.env.NODE_ENV": '"production"',
    /*
     * La version du produit, scellée ici plutôt que lue au démarrage.
     *
     * Le serveur la lisait depuis `package.json` par `fileURLToPath(import.meta.url)`.
     * Dans le bundle CJS, `import.meta` n'existe pas : l'appel échouait, le repli
     * rendait « unknown », et CHAQUE retour produit d'une installation livrée était
     * daté « unknown » — c'est-à-dire que le champ censé relier une plainte à une
     * livraison ne reliait rien. Trouvé en regardant l'écran, pas en lisant le code :
     * les tests tournent sous `tsx`, où `import.meta` existe et où le repli ne se
     * déclenche jamais.
     *
     * Scellée au build, la valeur est la même pour tous les chemins d'exécution et
     * ne peut plus dépendre de la façon dont le processus a été démarré.
     */
    "process.env.OATHRION_BUILD_VERSION": JSON.stringify(
      // `npm run build` s'exécute depuis la racine : le chemin relatif suffit, comme
      // pour `entryPoints` juste au-dessus.
      String(
        (JSON.parse(readFileSync("package.json", "utf8")) as { version?: string }).version ?? "unknown",
      ),
    ),
    /*
     * `import.meta.url` dans un paquet CJS : vide, et esbuild avertissait à chaque construction
     * (vu par l'utilisateur le 8 novembre, qui s'en inquiétait). Il vaut maintenant l'adresse
     * du fichier lui-même, calculée par `script/import-meta-url.js`, injecté : correct, et silencieux.
     */
    "import.meta.url": "__oathrion_import_meta_url",
  };

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: serverDefine,
    inject: ["script/import-meta-url.js"],
    minify: true,
    external: externals,
    logLevel: "info",
  });

  /*
   * `oathrion wrap` : le MÊME serveur, par un point d'entrée qui active le mode local
   * (`server/local-mode.ts`) avant de le charger. Un fichier à part, et c'est la garantie :
   * `dist/index.cjs` ne contient pas `local-entry.ts`, donc aucune configuration ne peut
   * faire basculer le paquet serveur en mode local.
   */
  console.log("building local entry (oathrion wrap)...");
  await esbuild({
    entryPoints: ["server/local-entry.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/oathrion-local.cjs",
    define: serverDefine,
    inject: ["script/import-meta-url.js"],
    minify: true,
    /* Le QR code de l'appairage du téléphone dans la console (`server/local-phone-pairing.ts`) : son cœur, du JavaScript pur, intégré comme dans `oathrion.mjs`. */
    external: externals.filter((dep) => dep !== "qrcode"),
    logLevel: "info",
  });

  /*
   * `oathrion` : la commande (cli/bin.ts) compilée en UN fichier, à côté de
   * `oathrion-local.cjs`. Constaté en lançant `wrap` depuis Cursor (STRESS-TEST-LOG §5.40) :
   * depuis les sources, `tsx` ne résout les alias du dépôt (`@shared/…`) que s'il est lancé
   * depuis le dépôt, et un client MCP lance la commande depuis SON dossier. Compilée, elle
   * ne dépend plus d'où on la lance. En ESM, pour que `import.meta.url` désigne ce fichier
   * (c'est ainsi que `wrap` trouve le serveur local, juste à côté).
   */
  console.log("building oathrion command...");
  await esbuild({
    entryPoints: ["cli/bin.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/oathrion.mjs",
    /* Pas de `banner` : `cli/bin.ts` porte déjà son `#!/usr/bin/env node`, qu'esbuild garde. */
    minify: true,
    logLevel: "info",
  });

  /* Le hook Claude Code seul : appelé deux fois par outil, il doit charger vite (cli/hook-entry.ts). */
  console.log("building claude code hook...");
  await esbuild({
    entryPoints: ["cli/hook-entry.ts"],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: "dist/oathrion-hook.mjs",
    minify: true,
    logLevel: "info",
  });

  /*
   * PHASE 12. Le pont d'identité PostgreSQL exécute un worker_thread depuis un fichier
   * sur disque : ce n'est pas un import que esbuild peut inliner, c'est un chemin résolu
   * à l'exécution. Sans cette copie, un déploiement qui n'expédie que `dist/` démarrerait
   * avec `OATHRION_IDENTITY_PLANE=postgres` et échouerait au premier accès à l'identité —
   * donc le fichier voyage avec le bundle, à côté de lui.
   */
  console.log("copying identity worker...");
  await copyFile("server/identity/sync-postgres-worker.cjs", "dist/sync-postgres-worker.cjs");

  /*
   * PHASE 13. Le serveur refuse de démarrer sur une base PostgreSQL non migrée (voulu :
   * les migrations passent AVANT les répliques). Mais `npm run migrate:postgres` exige
   * tsx et `script/`, absents de l'image Docker et de toute installation `--omit=dev` :
   * une installation neuve depuis l'image ne pouvait donc pas initialiser sa base.
   * Le même script, bundlé, voyage dans `dist/` : `node dist/migrate.cjs`.
   */
  console.log("building migration CLI...");
  await esbuild({
    entryPoints: ["script/migrate-postgres.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/migrate.cjs",
    minify: true,
    external: externals,
    logLevel: "info",
  });

  /*
   * La création d'un espace client, pour la même raison que la migration : `npm run
   * workspace:create` exige tsx et `script/`, absents de l'image, et la base n'est pas
   * publiée hors de la pile de production. Sans ce bundle, un exploitant ne pouvait PAS
   * inviter un client sur un déploiement réel. Il fait désormais :
   *   docker compose exec placet node dist/workspace-create.cjs --org "Acme" --email a@acme.com
   * Le fichier est à côté de `index.cjs`, donc il résout le worker d'identité de la même façon.
   */
  console.log("building workspace CLI...");
  await esbuild({
    entryPoints: ["script/workspace-create.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/workspace-create.cjs",
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
