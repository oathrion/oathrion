/**
 * `pilot:down` CONSERVE LES DONNÉES ; `pilot:destroy` LES SUPPRIME. Partout.
 *
 * L'audit de 9fb5091 a relevé des instructions contradictoires : `package.json` et
 * `deploy/README.md` disaient « conservées », `docs/QUICKSTART-PILOT.md`, le README et
 * l'en-tête de `docker-compose.local.yml` disaient « SUPPRIME le volume ». Une personne
 * qui suit la mauvaise ligne pour « tout supprimer » garde ses données ; celle qui la
 * suit pour « arrêter un moment » croit les avoir perdues. Ce test relit la commande ET
 * tous les textes qui la nomment.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function textFiles(): string[] {
  const docs = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => join("docs", f));
  return ["README.md", "deploy/README.md", "deploy/docker-compose.local.yml", "deploy/scripts/pilot-up.sh", ...docs];
}

describe("les commandes de la pile pilote", () => {
  it("pilot:down n'efface pas le volume, pilot:destroy si", () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["pilot:down"]).toMatch(/ down$/);
    expect(scripts["pilot:down"]).not.toMatch(/-v\b/);
    expect(scripts["pilot:destroy"]).toMatch(/ down -v$/);
  });

  it("aucun texte n'attribue la suppression des données à pilot:down", () => {
    const offending: string[] = [];
    for (const file of textFiles()) {
      readFileSync(join(ROOT, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (!line.includes("pilot:down") || line.includes("pilot:destroy")) return;
          /* La phrase historique de PILOT-READINESS raconte le défaut corrigé : elle le dit au passé. */
          if (/détruisait|exécutait/.test(line)) return;
          if (/suppr|efface|détrui|destroy|-v\b/i.test(line) && !/conserv/i.test(line)) offending.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        });
    }
    expect(offending).toEqual([]);
  });
});
