/**
 * Le registre d'effacement ne doit jamais devenir une table « du locataire ».
 *
 * ## Le défaut que ce fichier rend impossible
 *
 * `tenant-export.ts` et `tenant-purge.ts` découvrent les tables d'une organisation en
 * interrogeant le schéma : **toute table portant une colonne `organization_id`** en fait
 * partie. C'est délibéré — une liste écrite à la main oublie la table suivante, et une
 * table oubliée par la purge, ce sont des données qu'on a promis d'effacer et qui restent.
 *
 * Mais la découverte est aveugle. Si le registre d'effacement portait une colonne
 * `organization_id`, la purge le ramasserait avec le reste et **effacerait sa propre
 * preuve**, dans la même transaction, sans qu'aucune erreur ne soit levée. Le résultat
 * serait un effacement parfaitement silencieux : plus de données, et plus de trace qu'il
 * y a eu un effacement. C'est exactement ce qu'un auditeur cherche à exclure.
 *
 * La colonne s'appelle donc `purged_organization_id`. Ce fichier interdit de la renommer.
 *
 * ## Pourquoi une lecture de source et pas une base de test
 *
 * Le défaut n'est pas un comportement, c'est un NOM. Monter une base, migrer, insérer et
 * purger pour constater qu'une ligne a disparu coûterait des secondes à chaque exécution
 * et attraperait la même chose. La campagne `e2e:multitenant` fait la démonstration sur
 * un PostgreSQL réel ; ce fichier-ci garde l'invariant à coût nul, dans la suite que tout
 * le monde lance.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("le registre d'effacement survit à la purge", () => {
  const migration = read("server/migrations/020-tenant-erasure.ts");

  it("nomme sa colonne `purged_organization_id`", () => {
    expect(migration).toContain("purged_organization_id");
  });

  it("ne déclare aucune colonne `organization_id`", () => {
    /*
     * La limite de mot est nécessaire : `purged_organization_id` contient la sous-chaîne
     * `organization_id`, et une recherche naïve passerait toujours.
     */
    const declarations = migration.match(/(^|[\s(,])organization_id\s+TEXT/gm) ?? [];
    expect(declarations).toEqual([]);
  });

  it("la purge découvre les tables par cette colonne, donc le nom est bien le garde", () => {
    const purge = read("script/lib/tenant-purge.ts");
    // Si cette requête changeait de critère, le raisonnement ci-dessus cesserait de tenir.
    expect(purge).toContain("c.column_name = 'organization_id'");
    expect(purge).toContain("DELETE FROM ${quote(table)} WHERE organization_id = $1");
  });

  it("l'organisation est supprimée en DERNIER, pour que la purge reste reprenable", () => {
    const purge = read("script/lib/tenant-purge.ts");
    const loop = purge.indexOf("for (const table of tables) {\n      await client.query(`DELETE");
    const orgRow = purge.indexOf("DELETE FROM organizations WHERE id = $1");
    expect(loop).toBeGreaterThan(-1);
    expect(orgRow).toBeGreaterThan(loop);
  });

  it("la preuve est écrite AVANT la suppression", () => {
    const purge = read("script/lib/tenant-purge.ts");
    const insert = purge.indexOf("INSERT INTO tenant_erasures");
    const firstDelete = purge.indexOf("DELETE FROM");
    expect(insert).toBeGreaterThan(-1);
    /*
     * L'ordre est la garantie : si le processus meurt entre les deux, la transaction est
     * annulée et rien n'a bougé. Inversé, il existerait un instant où des lignes ont
     * disparu sans que le registre le dise.
     */
    expect(insert).toBeLessThan(firstDelete);
  });
});
