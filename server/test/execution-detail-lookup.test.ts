/**
 * La page de détail d'une exécution ne conclut pas « introuvable » depuis le seul cache.
 *
 * Relevé en répétant la recette utilisateur (docs/PILOTE-RECETTE-UTILISATEUR.md, étape 8) :
 * le lien « Reçu d'audit » du démarrage guidé menait à « Execution not found » pour une
 * exécution qui venait d'avoir lieu. La page ne cherchait que dans la liste chargée à la
 * connexion, sans jamais demander au serveur.
 *
 * Le client n'a pas de banc DOM ; comme les autres gardes de l'interface, ce test lit la
 * source. Il fige les trois propriétés : le serveur est consulté, « introuvable » n'est
 * dit que sur un 404, et une panne réseau n'est pas présentée comme une absence. La
 * preuve de bout en bout est le parcours rejoué dans un navigateur (STRESS-TEST-LOG §5.5).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src", "pages", "execution-detail.tsx"),
  "utf8",
);

describe("détail d'une exécution absente du cache", () => {
  it("demande l'exécution au serveur", () => {
    expect(source).toMatch(/api\.getExecution\(id\)/);
  });

  it("ne dit « introuvable » que sur un 404 du serveur", () => {
    expect(source).toMatch(/failure instanceof ApiError && failure\.status === 404 \? "missing" : "unreachable"/);
  });

  it("une panne réseau est dite comme telle, pas comme une absence", () => {
    expect(source).toMatch(/verdict === "unreachable"[\s\S]{0,80}ErrorState/);
  });

  it("attend la réponse du serveur avant de conclure", () => {
    expect(source).toMatch(/if \(loading \|\| \(mustAsk && verdict === null\)\)/);
  });
});
