/**
 * TENANT PURGE — tout ce qu'une organisation possède, supprimé, et une preuve qui reste.
 *
 * La symétrie de `tenant-export.ts`, et son contraire : l'un lit sans rien changer,
 * l'autre détruit sans retour. Les deux découvrent les tables de la même façon — toute
 * table du schéma portant une colonne `organization_id` — parce qu'une liste écrite à la
 * main oublie la table suivante, et qu'une table oubliée par la purge, ce sont des
 * données d'un client qu'on a promis d'effacer et qui restent.
 *
 * ## Quatre verrous, et aucun n'est décoratif
 *
 * **1. Le locataire doit être INACTIF.** Purger exige donc deux décisions humaines
 * séparées dans le temps : désactiver, puis effacer. Une désactivation se répare ; une
 * purge, non.
 *
 * **2. La confirmation est le NOM, pas l'identifiant.** L'identifiant apparaît dans
 * chaque ligne de journal et dans chaque export : quelqu'un peut le recopier sans savoir
 * de qui il s'agit. Le nom demande d'être allé le chercher.
 *
 * **3. Rien n'est supprimé sans `--confirm`.** Sans lui, la fonction compte et rend ce
 * qu'elle aurait fait. C'est le mode par défaut.
 *
 * **4. La preuve est écrite AVANT la suppression**, dans la même transaction. Si le
 * processus meurt au milieu, soit la transaction est annulée et rien n'a bougé, soit elle
 * a abouti et la preuve est là. Il n'existe pas d'état où des lignes ont disparu sans que
 * le registre le dise.
 *
 * ## Ce que cette purge NE fait pas
 *
 * Elle n'efface pas une personne à l'intérieur d'un locataire vivant. `action_receipts`
 * porte `approved_by` et `consumed_by` **dans l'empreinte chaînée** : vider ces champs
 * casse la chaîne, et un effacement légitime deviendrait indiscernable d'une falsification.
 * Résoudre cela demande un ré-ancrage de chaîne qui n'existe pas. C'est écrit dans
 * `docs/limitations.md` plutôt que contourné par une demi-mesure.
 */

import type { Pool } from "pg";
import crypto from "node:crypto";

export interface PurgePlan {
  organizationId: string;
  nameKey: string;
  active: boolean;
  /** `{ table: lignes }`, dans l'ordre alphabétique des tables. */
  rowCounts: Record<string, number>;
  totalRows: number;
  schemaVersion: number | null;
}

export interface PurgeResult extends PurgePlan {
  erased: boolean;
  erasureId: string | null;
}

export class PurgeRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PurgeRefused";
  }
}

/**
 * Les tables qui portent `organization_id`, DÉCOUVERTES et non listées — puis ordonnées
 * par leurs dépendances, et non par leur nom.
 *
 * ## Le défaut corrigé, et ce qu'il cassait
 *
 * Cette fonction rendait les tables triées par `ORDER BY c.table_name`, et la boucle de
 * suppression suivait cet ordre. **L'ordre alphabétique n'a aucun rapport avec l'ordre
 * référentiel** : `action_grants` précède `action_receipts`, or
 * `action_receipts.grant_id` référence `action_grants.id`. La purge supprimait donc le
 * parent avant l'enfant et la transaction entière échouait :
 *
 *     update or delete on table "action_grants" violates foreign key constraint
 *     "action_receipts_grant_id_fkey" on table "action_receipts"
 *
 * Autrement dit, **l'effacement d'un locataire échouait sur PostgreSQL dès que ce
 * locataire avait des reçus d'action** — c'est-à-dire dès qu'il avait servi à quelque
 * chose. Un droit à l'effacement qui ne fonctionne que sur un locataire vide ne
 * fonctionne pas.
 *
 * La transaction protégeait l'intégrité (rien n'était à moitié effacé), donc le défaut
 * était un REFUS et non une corruption. C'est la seule bonne nouvelle de l'affaire.
 *
 * ## Pourquoi un tri topologique plutôt qu'une liste écrite à la main
 *
 * La découverte est le point de la conception : une table ajoutée demain porte
 * `organization_id` et se fait effacer sans que personne ait à se souvenir de ce fichier.
 * Une liste ordonnée à la main aurait rendu l'ordre correct aujourd'hui et aurait
 * reproduit le défaut d'origine à la prochaine table — exactement comme le littéral
 * `=== 18` du banc multi-locataire, trouvé le même jour.
 *
 * Les arêtes sont donc lues dans le catalogue, et les enfants partent avant les parents.
 * Un cycle — que ce schéma n'a pas — laisserait les tables restantes dans l'ordre
 * alphabétique : la suppression échouerait alors bruyamment, ce qui vaut mieux qu'un
 * ordre inventé.
 */
async function tenantTables(client: {
  query: Pool["query"];
}): Promise<string[]> {
  const found = await client.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND c.column_name = 'organization_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
  );
  const tables = found.rows.map((r) => r.table_name);
  return orderByDependency(tables, await foreignKeyEdges(client, tables));
}

/**
 * Les arêtes de clé étrangère ENTRE les tables données : `{ child, parent }`.
 *
 * Lues dans `pg_constraint` plutôt que dans `information_schema`, qui demanderait trois
 * jointures pour la même information. Les auto-références sont écartées : une table qui
 * se référence elle-même ne contraint pas l'ordre ENTRE tables, et la garder ferait voir
 * un cycle là où il n'y en a pas.
 */
async function foreignKeyEdges(
  client: { query: Pool["query"] },
  tables: readonly string[],
): Promise<{ child: string; parent: string }[]> {
  if (tables.length === 0) return [];
  const rows = await client.query<{ child: string; parent: string }>(
    `SELECT src.relname AS child, tgt.relname AS parent
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class tgt ON tgt.oid = con.confrelid
      WHERE con.contype = 'f'
        AND src.relname = ANY($1::text[])
        AND tgt.relname = ANY($1::text[])
        AND src.relname <> tgt.relname`,
    [tables as string[]],
  );
  return rows.rows;
}

/** Les enfants d'abord : un tri topologique, stable sur l'ordre d'entrée. */
export function orderByDependency(
  tables: readonly string[],
  edges: readonly { child: string; parent: string }[],
): string[] {
  /* Combien de tables encore présentes référencent celle-ci. */
  const referencedBy = new Map<string, Set<string>>();
  for (const table of tables) referencedBy.set(table, new Set());
  for (const { child, parent } of edges) referencedBy.get(parent)?.add(child);

  const ordered: string[] = [];
  const remaining = [...tables];
  while (remaining.length > 0) {
    /*
     * Une table que PLUS AUCUNE table restante ne référence peut partir : ses enfants
     * sont déjà effacés. On prend la première dans l'ordre d'entrée, ce qui rend le
     * résultat déterministe — un ordre qui change d'un passage à l'autre rendrait un
     * échec irreproductible.
     */
    const index = remaining.findIndex((table) => {
      const children = referencedBy.get(table) ?? new Set<string>();
      return [...children].every((child) => !remaining.includes(child));
    });
    if (index === -1) {
      /*
       * Un cycle. Ce schéma n'en a pas, et s'il en acquiert un, mieux vaut une
       * suppression qui échoue bruyamment qu'un ordre inventé qui en effacerait une
       * partie. Les tables restantes sont donc rendues telles quelles.
       */
      ordered.push(...remaining);
      break;
    }
    ordered.push(remaining.splice(index, 1)[0]!);
  }
  return ordered;
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

export interface PurgeOptions {
  /** Le NOM de l'organisation, tel que l'opérateur l'a saisi. Sans lui : comptage seul. */
  confirmName?: string;
  /** Qui a demandé l'effacement. Écrit au registre. */
  requestedBy: string;
  /** Pourquoi. Écrit au registre : un effacement sans motif est inexplicable six mois plus tard. */
  reason: string;
}

export async function purgeTenant(
  pool: Pool,
  organizationId: string,
  options: PurgeOptions,
): Promise<PurgeResult> {
  const client = await pool.connect();
  try {
    /*
     * SERIALIZABLE : le comptage et la suppression doivent voir la même base. En lecture
     * répétable, une écriture concurrente d'un autre processus pourrait insérer une ligne
     * entre les deux, et le registre annoncerait un compte inférieur à ce qui a disparu.
     */
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

    const org = await client.query<{ name_key: string; active: number | boolean }>(
      `SELECT name_key, active FROM organizations WHERE id = $1`,
      [organizationId],
    );
    const row = org.rows[0];
    if (!row) throw new PurgeRefused(`no organization "${organizationId}" exists.`);

    const active = row.active === true || row.active === 1;
    const nameKey = row.name_key;

    const tables = await tenantTables(client as never);
    const rowCounts: Record<string, number> = {};
    for (const table of tables) {
      const count = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${quote(table)} WHERE organization_id = $1`,
        [organizationId],
      );
      rowCounts[table] = Number(count.rows[0]?.n ?? 0);
    }
    // La ligne de l'organisation elle-même, qui n'a pas de colonne `organization_id`.
    rowCounts.organizations = 1;

    const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
    const schemaVersion = await client
      .query<{ v: number }>("SELECT max(version)::int AS v FROM schema_migrations")
      .then((r) => r.rows[0]?.v ?? null, () => null);

    const plan: PurgePlan = { organizationId, nameKey, active, rowCounts, totalRows, schemaVersion };

    if (options.confirmName === undefined) {
      await client.query("ROLLBACK");
      return { ...plan, erased: false, erasureId: null };
    }

    /* ----------------------------- les verrous ----------------------------- */

    if (active) {
      await client.query("ROLLBACK");
      throw new PurgeRefused(
        `organization "${organizationId}" is still ACTIVE. Deactivate it first: purging a live ` +
          `tenant would delete a customer that is still using the product. Two decisions, not one.`,
      );
    }

    /*
     * Comparé à la clé NORMALISÉE et non au nom brut : « Acme Corp », « acme corp » et
     * « ACME  CORP » désignent le même client, et refuser sur une casse ferait recommencer
     * l'opérateur — ce qui est exactement le moment où l'on copie-colle sans lire.
     */
    const confirmKey = options.confirmName.trim().toLowerCase().replace(/\s+/g, " ");
    if (confirmKey !== nameKey.trim().toLowerCase()) {
      await client.query("ROLLBACK");
      throw new PurgeRefused(
        `the name you typed does not match this organization. Nothing was deleted. ` +
          `Confirmation asks for the NAME on purpose: the identifier appears in every log line.`,
      );
    }

    /* --------------------- la preuve, puis la suppression ------------------- */

    const erasureId = `ers_${crypto.randomUUID().replace(/-/g, "")}`;
    await client.query(
      `INSERT INTO tenant_erasures
         (id, purged_organization_id, purged_name_key, requested_by, reason, row_counts, schema_version, erased_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        erasureId,
        organizationId,
        nameKey,
        options.requestedBy,
        options.reason,
        JSON.stringify(rowCounts),
        schemaVersion,
      ],
    );

    for (const table of tables) {
      await client.query(`DELETE FROM ${quote(table)} WHERE organization_id = $1`, [organizationId]);
    }
    // En dernier : tant qu'elle existe, la purge est reprenable si le processus meurt.
    await client.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);

    await client.query("COMMIT");
    return { ...plan, erased: true, erasureId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
