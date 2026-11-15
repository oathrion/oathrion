/**
 * L'ORDRE DES SUPPRESSIONS D'UNE PURGE DE LOCATAIRE.
 *
 * ## Le défaut que ce fichier garde
 *
 * `tenantTables()` découvre les tables portant `organization_id` — c'est le point de la
 * conception, une table ajoutée demain se fait effacer sans que personne ait à se
 * souvenir du fichier. Mais elle les rendait triées par `ORDER BY c.table_name`, et la
 * boucle de suppression suivait cet ordre.
 *
 * **L'ordre alphabétique n'a aucun rapport avec l'ordre référentiel.**
 * `action_grants` précède `action_receipts`, or `action_receipts.grant_id` référence
 * `action_grants.id`. La purge supprimait donc le parent avant l'enfant :
 *
 *     update or delete on table "action_grants" violates foreign key constraint
 *     "action_receipts_grant_id_fkey" on table "action_receipts"
 *
 * Autrement dit, **l'effacement d'un locataire échouait sur PostgreSQL dès que ce
 * locataire avait des reçus d'action** — c'est-à-dire dès qu'il avait servi à quelque
 * chose. Un droit à l'effacement qui ne marche que sur un locataire vide ne marche pas.
 *
 * ## Pourquoi il avait échappé à `verify:erasure`
 *
 * Ce banc passait 20/20. Il n'exerçait pas un locataire porteur de reçus d'action, donc
 * l'arête fautive n'existait pas dans son jeu de données. C'est l'illustration exacte de
 * « un test qui passe ne prouve pas que la fonctionnalité marche » : il prouve que les
 * cas écrits passent.
 *
 * Le défaut a été trouvé par `npm run e2e:multitenant`, qui construit un locataire
 * complet sur un vrai PostgreSQL — et qui, lui, échouait.
 *
 * ## Ce que ces tests éprouvent, et ce qu'ils n'éprouvent pas
 *
 * Le tri, isolément et sans base. Le parcours complet sur un vrai PostgreSQL est couvert
 * par `e2e:multitenant` (98/98) ; ici on garde la LOI, pour qu'un futur ordre
 * alphabétique tombe en millisecondes plutôt qu'au prochain effacement d'un client.
 */

import { describe, expect, it } from "vitest";

import { orderByDependency } from "../../script/lib/tenant-purge";

/** La position d'une table dans l'ordre rendu. */
const at = (ordered: readonly string[], table: string) => ordered.indexOf(table);

describe("les enfants partent avant les parents", () => {
  it("l'arête réelle du défaut : action_receipts avant action_grants", () => {
    /*
     * Les deux tables sont données dans l'ordre ALPHABÉTIQUE — celui que la découverte
     * produit, donc celui qui cassait. Le résultat doit l'inverser.
     */
    const ordered = orderByDependency(
      ["action_grants", "action_receipts"],
      [{ child: "action_receipts", parent: "action_grants" }],
    );
    expect(at(ordered, "action_receipts")).toBeLessThan(at(ordered, "action_grants"));
  });

  it("respecte une chaîne de trois", () => {
    /* c → b → a : il faut c, puis b, puis a. */
    const ordered = orderByDependency(
      ["a", "b", "c"],
      [
        { child: "b", parent: "a" },
        { child: "c", parent: "b" },
      ],
    );
    expect(ordered).toEqual(["c", "b", "a"]);
  });

  it("n'oublie aucune table", () => {
    /*
     * La propriété la plus importante après l'ordre : une purge qui laisse une table
     * derrière elle laisse des données d'un locataire effacé. On vérifie donc la
     * conservation de l'ensemble, pas seulement l'ordre.
     */
    const tables = ["agents", "action_grants", "action_receipts", "executions", "approvals"];
    const ordered = orderByDependency(tables, [
      { child: "action_receipts", parent: "action_grants" },
      { child: "approvals", parent: "executions" },
    ]);
    expect([...ordered].sort()).toEqual([...tables].sort());
    expect(ordered).toHaveLength(tables.length);
  });

  it("laisse les tables indépendantes dans leur ordre d'entrée", () => {
    /*
     * Déterminisme : un ordre qui change d'un passage à l'autre rendrait un échec
     * irreproductible, ce qui est le pire des défauts à chasser.
     */
    const tables = ["z_table", "a_table", "m_table"];
    expect(orderByDependency(tables, [])).toEqual(tables);
    expect(orderByDependency(tables, [])).toEqual(orderByDependency(tables, []));
  });

  it("une table qui se référence elle-même ne bloque rien", () => {
    /*
     * Une auto-référence ne contraint pas l'ordre ENTRE tables. `foreignKeyEdges`
     * l'écarte déjà en SQL ; si elle arrivait quand même, elle ne doit pas faire voir un
     * cycle là où il n'y en a pas.
     */
    const ordered = orderByDependency(["a", "b"], [{ child: "a", parent: "a" }]);
    expect([...ordered].sort()).toEqual(["a", "b"]);
  });

  it("un cycle rend toutes les tables plutôt que d'en perdre", () => {
    /*
     * Ce schéma n'a pas de cycle. S'il en acquiert un, l'alternative à « rendre tout
     * dans l'ordre d'entrée » serait d'en omettre — donc d'effacer un locataire à
     * moitié en croyant l'avoir effacé. La suppression échouera bruyamment sur la
     * contrainte, ce qui est le bon échec.
     */
    const ordered = orderByDependency(
      ["a", "b"],
      [
        { child: "a", parent: "b" },
        { child: "b", parent: "a" },
      ],
    );
    expect([...ordered].sort()).toEqual(["a", "b"]);
  });

  it("ne rend rien pour une liste vide", () => {
    expect(orderByDependency([], [])).toEqual([]);
  });

  it("l'ordre alphabétique seul NE suffit PAS — le défaut, énoncé", () => {
    /*
     * Ce test existe pour que l'intention soit lisible : si quelqu'un remplace le tri
     * par `[...tables].sort()`, il tombe. C'est la forme exacte du code d'origine.
     */
    const tables = ["action_grants", "action_receipts"];
    const alphabetique = [...tables].sort();
    const correct = orderByDependency(tables, [
      { child: "action_receipts", parent: "action_grants" },
    ]);
    expect(correct).not.toEqual(alphabetique);
  });
});
