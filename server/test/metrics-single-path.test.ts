/**
 * Un nom de métrique n'existe qu'à UN endroit.
 *
 * ## Pourquoi un test qui lit des fichiers
 *
 * Parce que la faute qu'il empêche ne produit aucune erreur. Une métrique incrémentée
 * sous un nom presque identique à celui qui est déclaré compile, passe, et rend un
 * tableau de bord faux : le compteur qu'on regarde n'est pas celui qui monte. Aucun test
 * de comportement ne voit cela, parce que chaque moitié se comporte correctement.
 *
 * Le dépôt applique déjà ce raisonnement à la liaison d'agent
 * (`agent-binding-single-path.test.ts`), à la devise (`currency-single-path.test.ts`) et
 * à la passerelle MCP (`mcp-single-path.test.ts`). Les métriques entrent dans la même
 * catégorie, pour la même raison.
 *
 * ## Ce que ce test NE cherche pas, et pourquoi
 *
 * Pas « toute chaîne commençant par `oathrion_` ». Mon premier jet le faisait et a listé
 * vingt-deux faux positifs en une exécution : les bases jetables des bancs s'appellent
 * `oathrion_obs`, `oathrion_mt`, `oathrion_bk_src`, et `shared/schema.ts` donne `oathrion_ab12cd` en
 * exemple de clé d'API. Le préfixe `oathrion_` n'appartient pas aux métriques — il appartient
 * au produit.
 *
 * Ce qui identifie une métrique n'est donc pas son préfixe mais son CONTEXTE : le
 * littéral passé à `increment(...)`, et la liste des jauges rendues par le registre. Un
 * test qui aurait fallu assouplir pour passer aurait fini par ne plus rien interdire.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COUNTERS } from "../observability/metrics";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const REGISTRY = path.join("server", "observability", "metrics.ts");

/** Les jauges rendues par `renderDeploymentMetrics`, nommées ici pour être surveillées. */
const GAUGES = [
  "oathrion_up",
  "oathrion_ready",
  "oathrion_database_reachable",
  "oathrion_draining",
  "oathrion_rate_limit_store_reachable",
  "oathrion_rate_limit_fail_closed",
  "oathrion_uptime_seconds",
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const relative = path.join(dir, entry);
    if (statSync(path.join(ROOT, relative)).isDirectory()) sources(relative, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(relative);
  }
  return out;
}

/** Le produit. `script/` est exclu : un banc lit légitimement la page par ses noms. */
const PRODUCT = ["server", "shared", "cli"].flatMap((dir) => sources(dir));
const ALL = [...PRODUCT, ...sources("script")];

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

describe("les compteurs", () => {
  it("ne sont incrémentés que sous un nom DÉCLARÉ", () => {
    const declared = new Set(Object.keys(COUNTERS));
    const offenders: string[] = [];
    for (const file of ALL) {
      for (const match of read(file).matchAll(/increment\(\s*["'`]([^"'`]+)["'`]/g)) {
        const name = match[1];
        if (name !== undefined && !declared.has(name)) offenders.push(`${file} : ${name}`);
      }
    }
    expect(offenders, `incrémentés sous un nom non déclaré :\n${offenders.join("\n")}`).toEqual([]);
  });

  it("ne sont jamais nommés par une chaîne construite", () => {
    /*
     * `increment(\`placet_${x}\`)` serait un nom calculé à l'exécution : impossible à
     * énumérer, donc impossible à borner, et invisible pour le test ci-dessus. C'est la
     * forme exacte que prend une explosion de cardinalité.
     */
    const offenders = ALL.filter((file) => /increment\(\s*`[^`]*\$\{/.test(read(file)));
    expect(offenders, `nom de métrique construit dynamiquement :\n${offenders.join("\n")}`).toEqual([]);
  });

  it("sont tous réellement incrémentés quelque part", () => {
    /*
     * Le sens inverse, et il compte autant. Un compteur déclaré que personne
     * n'incrémente rend une série éternellement à zéro — qui se lit « rien ne s'est
     * passé » et non « personne ne compte ». C'est la panne que toute cette étape
     * cherche à éviter, et elle s'introduit en retirant un appel sans retirer la
     * déclaration.
     *
     * Le registre lui-même est inclus dans le balayage : il incrémente légitimement le
     * compteur de violations d'étiquette, qu'aucun appelant ne nomme.
     */
    const used = new Set<string>();
    for (const file of ALL) {
      for (const match of read(file).matchAll(/increment\(\s*["'`]([^"'`]+)["'`]/g)) {
        if (match[1] !== undefined) used.add(match[1]);
      }
    }
    const orphans = Object.keys(COUNTERS).filter((name) => !used.has(name));
    expect(orphans, `déclarés mais jamais incrémentés :\n${orphans.join("\n")}`).toEqual([]);
  });
});

describe("les jauges", () => {
  it("ne sont nommées que par le registre, dans le produit", () => {
    /*
     * Une jauge rendue depuis deux endroits produirait DEUX lignes du même nom dans la
     * page, ce que Prometheus accepte en silence en n'en gardant qu'une — laquelle,
     * personne ne le sait.
     */
    const offenders: string[] = [];
    for (const file of PRODUCT) {
      if (file === REGISTRY) continue;
      const text = read(file);
      for (const gauge of GAUGES) {
        if (new RegExp(`["'\`]${gauge}["'\`]`).test(text)) offenders.push(`${file} : ${gauge}`);
      }
    }
    expect(offenders, `une jauge nommée hors du registre :\n${offenders.join("\n")}`).toEqual([]);
  });

  it("la liste de ce test est à jour avec ce que le registre rend", () => {
    /*
     * Ce test porte une liste écrite à la main, donc elle peut dériver — et une liste
     * incomplète rendrait le test ci-dessus vide sans que rien ne le dise. On vérifie
     * donc qu'elle couvre exactement les jauges que le registre émet.
     */
    const rendered = read(REGISTRY);
    const emitted = [...rendered.matchAll(/gauge\("(oathrion_[a-z0-9_]+)"/g)].map((m) => m[1]);
    expect([...emitted].sort()).toEqual([...GAUGES].sort());
  });
});
