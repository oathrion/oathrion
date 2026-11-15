import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";
import { isLocalMode } from "./local-mode";

/*
 * The client bundle sits next to the server bundle, so the path is resolved
 * from this module's own location rather than the working directory: `npm
 * start` must behave the same whether it is run from the project root or from
 * a service manager with an unrelated cwd.
 *
 * `__dirname` is a CommonJS global. The build emits CommonJS, so it resolves
 * there, and that is the supported production path. Running this file directly
 * under `tsx` is ESM, where `__dirname` does not exist: that threw
 * `ReferenceError: __dirname is not defined` and the server died before binding
 * a port. The fallback covers that case from the working directory, which is
 * where `dist/public` sits when the project is run from its own root.
 */
function clientBundleDir(): string {
  if (typeof __dirname === "string") return path.resolve(__dirname, "public");
  return path.resolve(process.cwd(), "dist/public");
}

/**
 * `bundleDir` is an override for tests, which need to point the middleware at a
 * fixture directory. Production always calls this with no argument.
 */
export function serveStatic(app: Express, bundleDir?: string) {
  const distPath = bundleDir ?? clientBundleDir();
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  /*
   * `index: false` — l'index automatique est désactivé, et c'est ce qui rend les deux
   * surfaces possibles sur un même domaine.
   *
   * Par défaut, `express.static` répond `dist/public/index.html` pour `/`, c'est-à-dire la
   * CONSOLE. Depuis que le site public existe, la racine lui appartient : c'est le routage
   * explicite plus bas qui décide, pas un comportement implicite du middleware de
   * fichiers.
   */
  app.use(express.static(distPath, { index: false }));

  /*
   * A missing build asset must fail as a missing asset.
   *
   * The catch-all below exists so a deep link like `/agents/agt_x` reaches the
   * SPA, but it used to answer *everything*, including a request for a
   * JavaScript or CSS file that is not in the bundle. The browser then received
   * `index.html` with a 200 and a `text/html` type where it expected a script,
   * and reported a syntax error in place of the 404 that actually happened — the
   * hardest possible way to notice a stale or misresolved asset URL.
   */
  /*
   * DEUX DOCUMENTS, DEUX SURFACES.
   *
   *   /console…  → la console d'exploitation (`dist/public/index.html`)
   *   tout le reste → le site public (`dist/public/site/index.html`)
   *
   * La console est routée par HASH (`/console#/dashboard`), donc le serveur ne voit
   * jamais sa route interne : un seul préfixe suffit à la servir en entier, et aucune de
   * ses URL ne peut entrer en collision avec un chemin du site.
   *
   * La console était à la racine avant que le site existe. C'est un changement
   * d'adresse pour un exploitant, et les deux bancs qui l'affirmaient
   * (`e2e-enterprise`, `smoke`) ont été corrigés pour vérifier les DEUX surfaces —
   * sinon ils seraient passés sur la page marketing sans rien prouver.
   */
  const siteHtml = path.resolve(distPath, "site", "index.html");
  /*
   * Relatif à `root`, jamais un chemin absolu : `res.sendFile` refuse par défaut tout chemin qui
   * traverse un dossier caché, et une installation par nvm vit sous `~/.nvm/…`. La console y
   * répondait 404 « Not Found » (vu le 5 novembre, première installation globale réelle).
   */
  const sendPage = (res: express.Response, page: "index.html" | "site/index.html") => res.sendFile(page, { root: distPath });

  app.use("/{*path}", (req, res, next) => {
    // `originalUrl`, not `path`: this middleware is mounted on a pattern, so
    // Express has already stripped the matched prefix from `req.url`.
    const pathname = req.originalUrl.split("?")[0] ?? "/";
    if (/\.(js|mjs|css|map|json|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|eot)$/i.test(pathname)) {
      return next();
    }
    if (pathname === "/console" || pathname.startsWith("/console/")) {
      return sendPage(res, "index.html");
    }
    /*
     * En mode local (`oathrion wrap`), il n'y a pas de site : la racine montrait la page
     * vitrine (« Become a Pilot ») sur la machine même de la personne. Tout mène à la console.
     */
    if (isLocalMode()) return res.redirect(302, "/console");
    /*
     * Le site est servi s'il a été construit. Sinon la console reprend la racine : une
     * installation bâtie avant l'existence du site continue de fonctionner au lieu de
     * répondre 404 à tout, ce qui serait une panne totale pour une fonctionnalité
     * absente.
     */
    sendPage(res, fs.existsSync(siteHtml) ? "site/index.html" : "index.html");
  });

  app.use("/{*path}", (_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });
}
