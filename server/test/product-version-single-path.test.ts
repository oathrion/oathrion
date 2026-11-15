/**
 * La version du produit vient d'UN seul endroit, et ce endroit survit au bundle.
 *
 * ## Le défaut que ce fichier empêche de revenir
 *
 * `PRODUCT_VERSION` lisait `package.json` par `fileURLToPath(import.meta.url)`. Sous
 * `tsx` — développement, tests, démarrage rapide — cela marche. Dans `dist/index.cjs`,
 * qui est du CommonJS, `import.meta` n'existe pas : l'appel échouait, le repli rendait
 * « unknown », et CHAQUE retour produit d'une installation livrée était daté « unknown ».
 * Le champ censé relier une plainte à une livraison ne reliait rien.
 *
 * **Aucun test ne pouvait l'attraper**, et c'est le point de ce fichier : la suite tourne
 * sous `tsx`, où le chemin défaillant n'est jamais emprunté. Le défaut a été trouvé en
 * regardant l'écran d'une instance livrée, où la ligne affichait « version unknown ».
 *
 * ## Ce qui est asserté, et pourquoi pas autre chose
 *
 * On ne peut pas exécuter le bundle depuis ici sans base de données ni port. On asserte
 * donc les deux moitiés du contrat, par lecture de source :
 *
 *   1. le build SCELLE la version dans le binaire ;
 *   2. le serveur PRÉFÈRE la valeur scellée à sa propre lecture de fichier.
 *
 * Retirer l'une ou l'autre fait réapparaître « unknown » en production, et fait tomber
 * ce fichier.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("la version du produit survit au bundle", () => {
  it("le build scelle la version dans le binaire", () => {
    const build = read("script/build.ts");
    expect(build).toContain('"process.env.OATHRION_BUILD_VERSION"');
    // Scellée depuis package.json, pas depuis une valeur écrite à la main.
    expect(build).toMatch(/readFileSync\("package\.json"/);
  });

  it("le serveur préfère la valeur scellée à sa lecture de fichier", () => {
    const routes = read("server/routes.ts");
    const sealed = routes.indexOf("process.env.OATHRION_BUILD_VERSION");
    const fallback = routes.indexOf("fileURLToPath(import.meta.url)");

    expect(sealed).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(-1);
    /*
     * L'ORDRE est l'assertion. Le repli par lecture de fichier doit rester APRÈS la
     * valeur scellée : inversé, le bundle reprendrait le chemin qui échoue et le défaut
     * reviendrait sans que rien d'autre ne change.
     */
    expect(sealed).toBeLessThan(fallback);
  });

  it("le repli est `unknown`, pas une version inventée", () => {
    const routes = read("server/routes.ts");
    /*
     * Mieux vaut l'avouer que mentir : une version plausible mais fausse ferait croire
     * qu'un problème est corrigé alors qu'on regarde la mauvaise livraison.
     */
    expect(routes).toContain('return "unknown";');
  });
});
