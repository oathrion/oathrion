/**
 * Migration 18 — le nom d'une organisation devient unique, pour que son identifiant
 * puisse cesser d'être dérivé de ce nom.
 *
 * ## Le défaut corrigé
 *
 * `organizationIdFromName` fabriquait l'identifiant d'un tenant à partir de son nom :
 * « Acme Corp » → `org_acme_corp`. Trois conséquences, toutes dans le produit livré :
 *
 *   1. l'identifiant **divulgue le nom du client**. Il apparaît dans chaque ligne de
 *      journal, chaque ligne d'audit, chaque reçu, dans `OATHRION_QUOTAS` et dans les
 *      exports de tenant. Une banque qui évalue discrètement Oathrion est identifiable par
 *      quiconque lit une ligne de log ;
 *   2. deux raisons sociales proches **collisionnent** après normalisation et troncature
 *      à 48 caractères. La collision se manifeste par une erreur de clé primaire à la
 *      création, c'est-à-dire un oracle d'existence inter-tenant — la classe de défaut
 *      déjà fermée pour `action_policies` par la migration 16 ;
 *   3. un changement de raison sociale est impossible à refléter, puisqu'une
 *      organisation n'est jamais renommée (`repositories/organizations.ts`).
 *
 * ## Pourquoi cette migration parle du NOM et pas de l'identifiant
 *
 * Générer un identifiant aléatoire ne coûte rien et ne demande aucun schéma. Ce qui
 * demande un schéma, c'est la conséquence : les deux seuls chemins de production qui
 * créaient un tenant l'amorçaient **par son nom** — `OATHRION_CONSOLE_USERS`
 * (`server/auth.ts`) et `npm run bootstrap:admin`. Tant que l'identifiant était calculé
 * depuis le nom, « le même nom au prochain démarrage » retrouvait la même organisation
 * gratuitement. Avec un identifiant aléatoire, cette idempotence doit venir d'une
 * **recherche** par nom — donc le nom doit être unique, et l'unicité doit être garantie
 * par la base, pas seulement par l'application.
 *
 * ## `name_key` plutôt qu'un index sur `name`
 *
 * La clé est le nom normalisé : `lower(trim(name))`. Deux raisons de stocker la forme
 * normalisée dans sa propre colonne au lieu d'indexer une expression :
 *
 *   - un index sur expression ne s'écrit pas de la même façon sur les deux moteurs,
 *     alors que cette colonne et son backfill s'écrivent avec un SQL identique pour
 *     SQLite et PostgreSQL — `lower` et `trim` existent dans les deux ;
 *   - la valeur recherchée est lisible dans un `pg_dump` qu'un exploitant inspecte
 *     pendant un incident.
 *
 * La normalisation est **volontairement limitée aux minuscules et aux bords** : elle ne
 * réduit pas les espaces internes. « Acme  Corp » (deux espaces) et « Acme Corp » sont
 * donc deux organisations différentes. C'est le prix d'une règle que la couche SQL et la
 * couche TypeScript peuvent appliquer à l'identique — réduire les espaces exigerait
 * `regexp_replace` sur PostgreSQL et rien d'équivalent sur SQLite, donc deux définitions
 * de « même nom » qui divergeraient. Écrit dans `docs/limitations.md`.
 *
 * ## Les identifiants existants ne sont pas réécrits
 *
 * Un identifiant d'organisation est référencé par sept tables **et par la chaîne d'audit,
 * qui est en ajout seul et à falsification détectable**. Le réécrire reviendrait à
 * réécrire des lignes
 * d'audit, soit exactement ce que la chaîne existe pour rendre détectable. Les tenants
 * déjà créés gardent donc leur identifiant dérivé ; seuls les nouveaux en reçoivent un
 * opaque. La migration ne touche aucun identifiant.
 *
 * ## Si la base contient déjà deux noms équivalents
 *
 * L'index UNIQUE échoue, et le cadre de migration est purement SQL et synchrone
 * (`types.ts` : `statements()` ne fait aucune I/O), donc il ne peut pas produire un
 * message lisible à partir d'une lecture de données : ce qu'un exploitant voit est
 * l'erreur d'unicité du moteur.
 *
 * Ce cas a d'abord été annoncé comme « très improbable », au motif que `name_key` est une
 * normalisation plus fine que l'ancien slug — donc deux clés égales impliquaient le même
 * identifiant, donc une seule ligne. **C'était faux dès le premier passage de la suite.**
 * `server/test/fixtures/phase12-identity-instance.ts` donnait le littéral « Test Org » à
 * trois organisations d'identifiants différents, et la migration a échoué sur l'index.
 * L'écriture d'un même nom pour deux identifiants choisis à la main est donc un chemin
 * réel, pas théorique ; la fixture a été corrigée pour nommer chaque organisation d'après
 * son identifiant. Le correctif sur une base existante est le même : renommer l'une des
 * deux avant de redémarrer. Écrit dans `docs/limitations.md`.
 *
 * Append-only : aucune migration antérieure n'est modifiée.
 */

import type { Migration, SchemaInspect } from "./types";

/** Index d'unicité sur le nom normalisé. Nommé, pour qu'un incident puisse le citer. */
export const ORGANIZATION_NAME_KEY_INDEX = "organizations_name_key_uk";

/**
 * La normalisation, en SQL, pour le backfill. La même règle en TypeScript est
 * `organizationNameKey()` dans `shared/tenancy.ts` ; les deux doivent rester d'accord,
 * ce que `tenant-opaque-id.test.ts` vérifie sur la ligne réellement écrite en base.
 */
const NAME_KEY_SQL = `lower(trim(name))`;

export const organizationNameKeyUnique: Migration = {
  version: 18,
  name: "organization-name-key",
  statements(schema: SchemaInspect): string[] {
    const out: string[] = [];

    /*
     * `NOT NULL DEFAULT ''` et non une colonne nullable : sur les deux moteurs, un
     * index UNIQUE tolère plusieurs NULL. Une colonne nullable laisserait donc passer
     * exactement les doublons que cette migration existe pour interdire, sur les lignes
     * où la valeur manque. La chaîne vide, elle, est unique comme les autres valeurs.
     *
     * SQLite accepte `ADD COLUMN ... NOT NULL` à condition qu'un défaut non nul soit
     * fourni, ce qui est le cas ici ; PostgreSQL l'accepte aussi. Même instruction pour
     * les deux dialectes.
     */
    if (!schema.columns("organizations").has("name_key")) {
      out.push(`ALTER TABLE organizations ADD COLUMN name_key text NOT NULL DEFAULT ''`);
    }

    /*
     * Backfill avant l'index, sinon l'index refuserait les lignes existantes qui
     * partagent toutes la valeur par défaut `''`. Limité aux lignes encore à `''`, donc
     * rejouable : une organisation dont le nom normalisé serait vraiment vide reste à
     * `''`, ce que l'application refuse d'écrire (`ensureByName` rejette un nom vide).
     */
    out.push(`UPDATE organizations SET name_key = ${NAME_KEY_SQL} WHERE name_key = ''`);

    out.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${ORGANIZATION_NAME_KEY_INDEX} ON organizations (name_key)`,
    );

    return out;
  },
};
