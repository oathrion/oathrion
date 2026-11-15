/**
 * LA VERSION DE POSTGRESQL EST DÉCLARÉE À PLUSIEURS ENDROITS. ILS DOIVENT S'ACCORDER.
 *
 * ## Le défaut que ce fichier empêche de revenir
 *
 * `deploy/docker-compose.yml` épinglait `postgres:17`. La CI employait `postgres:16`. Le
 * banc de reprise après sinistre démarrait sa machine de remplacement en
 * `postgres:16-alpine`. Et `docs/QUICKSTART-PILOT.md` recommandait la 16.
 *
 * Trois conséquences, de la moins grave à la pire :
 *
 *   · chaque exécution verte de la CI était une exécution verte sur une version majeure
 *     DIFFÉRENTE de celle qui servira réellement ;
 *   · la page d'installation envoyait l'exploitant monter une base qu'il devrait migrer ;
 *   · **l'exercice de reprise ne restaurait pas.**
 *
 * Ce dernier mérite d'être écrit en entier, parce qu'il explique pourquoi cette parité
 * n'est pas une coquetterie. `pg_dump` et `pg_restore` sont compatibles **vers l'avant
 * seulement**. Une archive écrite par un PostgreSQL 17 ne se restaure pas sur un 16 :
 *
 *     pg_restore: error: unsupported version (1.16) in file header
 *
 * Et ce n'était pas un artefact de banc. Un exploitant qui reconstruit un hôte avec une
 * version majeure plus ancienne que celle qui a produit sa sauvegarde rencontre
 * exactement ce mur — le jour où il n'a plus que la sauvegarde.
 *
 * ## Pourquoi un test et pas une relecture
 *
 * Les quatre valeurs sont loin les unes des autres : un fichier de compose, un workflow
 * GitHub, un script TypeScript, une page de documentation. Personne ne les relit
 * ensemble, et la dérive s'est installée sans que rien ne la signale — elle n'a été
 * trouvée qu'en EXÉCUTANT le banc de reprise, c'est-à-dire par chance.
 *
 * Le compose est la source : c'est lui qu'on déploie. Tout le reste doit le suivre.
 *
 * `verify-disaster-recovery.ts` n'est pas vérifié ici par une chaîne, mais parce qu'il
 * LIT déjà le compose à l'exécution — il ne peut plus diverger par construction, ce qui
 * est strictement mieux qu'un test.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

/** La version majeure déclarée par une image `postgres:<major>…`, ou null. */
function majorOf(image: string): string | null {
  const match = /^postgres:(\d+)/.exec(image.trim());
  return match ? match[1]! : null;
}

/**
 * Les images `postgres:*` RÉELLEMENT DÉCLARÉES, et rien d'autre.
 *
 * Le motif naïf `postgres:[A-Za-z0-9._-]+` est faux, et il l'est de façon instructive :
 * il attrape `@postgres:5432/placet` dans une chaîne de connexion (nom de service, port)
 * et `postgres:verify` dans un mot de passe de démonstration. Écrit d'abord ainsi, ce
 * fichier rapportait treize écarts dont aucun n'en était un.
 *
 * Une image ne se reconnaît donc pas à sa forme mais à son CONTEXTE : une clé `image:`
 * en YAML, ou le dernier argument d'un `docker run` dans la documentation.
 */
function postgresImages(content: string): string[] {
  const found: string[] = [];
  for (const m of content.matchAll(/^\s*image:\s*(postgres:[^\s#]+)/gm)) found.push(m[1]!);
  for (const m of content.matchAll(/docker run[^\n]*?\s(postgres:[^\s\n]+)/g)) found.push(m[1]!);
  return found;
}

/*
 * LA SOURCE. C'est ce fichier qu'on déploie ; tout le reste le suit.
 *
 * Calculée SANS `expect`, et c'est délibéré. Une assertion au niveau du module lève
 * pendant la collecte, et vitest rapporte alors « no tests » : l'échec est réel mais
 * illisible, et il ne dit pas lequel des cinq contrôles a cédé. Un `null` propre, affirmé
 * par le premier test, échoue en nommant la cause.
 */
const DEPLOYED: string | null = (() => {
  const images = postgresImages(read("deploy/docker-compose.yml"));
  return images.length > 0 ? majorOf(images[0]!) : null;
})();

describe("la version majeure de PostgreSQL est la même partout", () => {
  it("le compose de déploiement déclare une version majeure épinglée", () => {
    /*
     * `postgres:latest` changerait la base sous la suite sans qu'un commit le dise.
     * L'épinglage est une propriété à part entière, indépendamment de sa valeur — et
     * c'est lui qui rend les quatre tests suivants possibles, puisqu'ils comparent à
     * cette valeur.
     */
    const images = postgresImages(read("deploy/docker-compose.yml"));
    expect(images.length, "aucune image postgres dans le compose de déploiement").toBeGreaterThan(0);
    for (const image of images) {
      expect(image, `${image} n'est pas épinglé à une version majeure`).toMatch(/^postgres:\d+/);
    }
    expect(DEPLOYED, "la majeure déployée n'a pas pu être lue").not.toBeNull();
  });

  it("le compose local emploie la même majeure que le compose de déploiement", () => {
    for (const image of postgresImages(read("deploy/docker-compose.local.yml"))) {
      expect(majorOf(image), `${image} ≠ postgres:${DEPLOYED}`).toBe(DEPLOYED);
    }
  });

  it("la CI valide sur la majeure qui servira réellement", () => {
    /*
     * LE TEST QUI COMPTE LE PLUS DE CE FICHIER. Une suite verte sur une autre version
     * majeure que la production n'est pas une preuve de production — c'est une preuve
     * sur un système voisin.
     */
    const images = postgresImages(read(".github/workflows/ci.yml"));
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(majorOf(image), `la CI emploie ${image}, le déploiement postgres:${DEPLOYED}`).toBe(
        DEPLOYED,
      );
    }
  });

  it("la page d'installation du pilote ne recommande pas une autre majeure", () => {
    /*
     * Une page d'installation qui fait monter une 16 quand le compose déploie une 17
     * fabrique précisément la situation où une sauvegarde ne se restaure pas.
     */
    for (const image of postgresImages(read("docs/QUICKSTART-PILOT.md"))) {
      expect(majorOf(image), `QUICKSTART recommande ${image}`).toBe(DEPLOYED);
    }
  });

  it("aucun fichier livrable ne reste sur une majeure plus ancienne", () => {
    /*
     * Le filet large. Les quatre tests ci-dessus nomment les endroits connus ; celui-ci
     * attrape le cinquième, écrit demain, que personne n'aura pensé à ajouter ici.
     *
     * `notes/` est exclu : ce sont des journaux de chantier datés, qui décrivent ce qui
     * a été fait à un moment donné. Les réécrire falsifierait un compte rendu.
     */
    const fichiers = [
      "deploy/docker-compose.yml",
      "deploy/docker-compose.local.yml",
      ".github/workflows/ci.yml",
      "docs/QUICKSTART-PILOT.md",
      "deploy/README.md",
      "docs/OPERATIONS.md",
      "docs/OPERATIONS-RUNBOOK.md",
    ];
    const ecarts: string[] = [];
    for (const fichier of fichiers) {
      let contenu: string;
      try {
        contenu = read(fichier);
      } catch {
        continue;
      }
      for (const image of postgresImages(contenu)) {
        if (majorOf(image) !== DEPLOYED) ecarts.push(`${fichier} → ${image}`);
      }
    }
    expect(ecarts, `déploiement en postgres:${DEPLOYED}`).toEqual([]);
  });
});
