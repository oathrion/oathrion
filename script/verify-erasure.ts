/**
 * L'effacement d'un locataire, éprouvé contre un PostgreSQL réel.
 *
 *   DATABASE_URL=postgres://… npm run verify:erasure
 *
 * ## Pourquoi ce banc existe à côté de `e2e:multitenant`
 *
 * La campagne multi-locataires éprouve aussi la purge, et c'est le meilleur endroit :
 * deux locataires réels, des reçus chaînés, des grants consommés. Mais cette section-là
 * vit **après** la restauration par `pg_dump`, et une machine sans `pg_dump` n'y arrive
 * jamais — les vérifications passent alors silencieusement à la trappe.
 *
 * Un effacement est irréversible. Il ne peut pas dépendre d'un outil système pour être
 * vérifié : ce banc-ci monte sa propre base jetable, n'a besoin de rien d'autre qu'un
 * serveur joignable, et éprouve les quatre verrous plus l'isolation.
 *
 * Il ne remplace pas la campagne : il garantit qu'un dépôt peut TOUJOURS démontrer que la
 * purge emporte tout d'un locataire et rien de l'autre.
 */

import { Pool } from "pg";
import { createThrowawayDatabase } from "./lib/throwaway-postgres";
import { purgeTenant, PurgeRefused } from "./lib/tenant-purge";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 72 - title.length))}`);
}

const A = { id: "org_alpha_erasure", name: "Alpha Industries", key: "alpha industries" };
const B = { id: "org_bravo_erasure", name: "Bravo Logistics", key: "bravo logistics" };

/** Deux locataires, des lignes dans plusieurs tables, dont une créée récemment. */
async function seed(pool: Pool): Promise<void> {
  for (const t of [A, B]) {
    await pool.query(
      `INSERT INTO organizations (id, name, name_key, created_at, active) VALUES ($1, $2, $3, now(), true)`,
      [t.id, t.name, t.key],
    );
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `INSERT INTO agents (id, name, description, provider, model, status, owner, created_at,
                             executions_24h, success_rate, cost_24h, cost_month, risk_level,
                             permissions, mandate, policy_ids, tags, organization_id)
         VALUES ($1, $2, '', 'openai', 'gpt-4', 'active', 'ops', now(), 0, 1, 0, 0, 'LOW', '[]', '{}', '[]', '[]', $3)`,
        [`agt_${t.id}_${i}`, `Agent ${i}`, t.id],
      );
    }
    await pool.query(
      `INSERT INTO product_feedback (id, organization_id, author_user_id, vote, category, comment,
                                     feature, product_version, context_ref, created_at, updated_at)
       VALUES ($1, $2, 'user:ops', 1, 'experience', 'note', 'policies', '1.0.0', NULL, now(), now())`,
      [`fb_${t.id}`, t.id],
    );
    /*
     * UN CREDENTIAL DE CONNECTEUR, et c'est la ligne la plus importante de ce seed.
     *
     * Les autres tables contiennent des données du client. Celle-ci contient un JETON
     * D'ACCÈS à un système tiers : une ligne oubliée par la purge ne serait pas une
     * donnée résiduelle, ce serait un credential encore scellé dans une base dont le
     * propriétaire est parti. La migration 021 nomme sa colonne `organization_id`
     * précisément pour que la découverte par schéma l'atteigne — l'inverse exact du
     * registre d'effacement de la migration 020.
     *
     * L'enveloppe est une chaîne factice : ce qui est vérifié ici est la SUPPRESSION,
     * pas le déchiffrement (`server/test/connector-vault.test.ts` s'en charge).
     */
    await pool.query(
      `INSERT INTO connector_credentials (organization_id, connector_id, account, scopes,
                                          secret_envelope, fingerprint, status, status_detail,
                                          connected_by, connected_at)
       VALUES ($1, 'github', 'octocat', '["repo"]', 'v1.enveloppe.factice', 'aaaaaa',
               'connected', '', 'ops', now())`,
      [t.id],
    );
    /*
     * UNE REQUÊTE GARÉE EN ATTENTE D'APPROBATION (migration 022).
     *
     * Elle porte le corps CHIFFRÉ de la requête d'un client. Une ligne oubliée par la
     * purge ne serait pas une donnée résiduelle quelconque : ce serait le contenu d'un
     * appel métier, scellé dans la base d'un locataire parti. Comme le coffre, cette
     * table nomme sa colonne `organization_id` pour que la découverte par schéma
     * l'atteigne.
     */
    await pool.query(
      `INSERT INTO pending_interceptions
         (organization_id, ref, execution_id, destination_id, method, path, query,
          headers_envelope, body_envelope, credential_header, credential_template,
          created_at, expires_at)
       VALUES ($1, 'ref-attente', 'exe_x', 'local-fixture', 'POST', '/v1/refunds', '{}',
               'v1.entetes.factice', 'v1.corps.factice', 'authorization', 'Bearer {secret}',
               now(), now() + interval '15 minutes')`,
      [t.id],
    );

    /*
     * UNE ACTION, UN GRANT, ET SON REÇU — et c'est le trou que ce banc avait.
     *
     * Ces trois lignes sont les seules du jeu de données qui portent une CLÉ ÉTRANGÈRE
     * entre deux tables du locataire : `action_receipts.grant_id` référence
     * `action_grants.id`. Sans elles, la purge n'a aucune contrainte référentielle à
     * respecter, et l'ordre des suppressions ne peut pas être faux.
     *
     * Il l'était. La découverte des tables les rendait triées par NOM, et l'ordre
     * alphabétique place `action_grants` avant `action_receipts` : la purge supprimait
     * le parent avant l'enfant, et la transaction échouait :
     *
     *     update or delete on table "action_grants" violates foreign key constraint
     *     "action_receipts_grant_id_fkey" on table "action_receipts"
     *
     * Autrement dit l'effacement d'un locataire échouait dès que ce locataire avait
     * servi à quelque chose. Ce banc passait 20/20 pendant ce temps, parce qu'aucune de
     * ses lignes ne se référençait.
     *
     * L'en-tête de ce fichier avait pourtant prévu le piège : la purge de
     * `e2e:multitenant` vit après `pg_dump`, donc sur une machine sans outils clients
     * PostgreSQL elle « passe silencieusement à la trappe ». C'est exactement ce qui
     * s'est produit, et c'est pourquoi la lacune est comblée ICI plutôt qu'ailleurs.
     */
    await pool.query(
      `INSERT INTO actions
         (organization_id, id, agent_id, action, arguments, destination_id, canonical,
          action_hash, decision, reason, created_at)
       VALUES ($1, $2, 'agt_erasure', 'stripe.refund', '{}', 'local-fixture', 'canon',
               $3, 'ALLOW', 'jeu de données du banc', now())`,
      [t.id, `act_${t.id}`, "h".repeat(64)],
    );
    await pool.query(
      `INSERT INTO action_grants
         (organization_id, id, action_id, agent_id, action, action_hash, destination_id,
          decision, state, created_at, expires_at)
       VALUES ($1, $2, $3, 'agt_erasure', 'stripe.refund', $4, 'local-fixture',
               'ALLOW', 'consumed', now(), now() + interval '15 minutes')`,
      [t.id, `grant_${t.id}`, `act_${t.id}`, "h".repeat(64)],
    );
    await pool.query(
      `INSERT INTO action_receipts
         (organization_id, receipt_id, grant_id, action_id, agent_id, action, action_hash,
          destination_id, decision, executed_at, outcome, result_hash, entry_hash, entry_seq)
       VALUES ($1, $2, $3, $4, 'agt_erasure', 'stripe.refund', $5, 'local-fixture',
               'ALLOW', now(), 'succeeded', $6, $7, 1)`,
      [
        t.id,
        `rcpt_${t.id}`,
        `grant_${t.id}`,
        `act_${t.id}`,
        "h".repeat(64),
        "r".repeat(64),
        "e".repeat(64),
      ],
    );
  }
}

const countFor = (pool: Pool, table: string, org: string) =>
  pool
    .query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE organization_id = $1`, [org])
    .then((r) => Number(r.rows[0]?.n ?? 0));

async function main(): Promise<number> {
  console.log("\n" + "=".repeat(78));
  console.log("Oathrion — TENANT ERASURE (PostgreSQL, throwaway database, no pg_dump needed)");
  console.log("=".repeat(78));

  const db = await createThrowawayDatabase("oathrion_erasure", process.env, { migrate: true });
  const pool = new Pool({ connectionString: db.url, max: 2 });
  try {
    await seed(pool);

    section("THE LEDGER ESCAPES TENANT DISCOVERY");
    const discovered = await pool.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema() AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'`,
    );
    const names = discovered.rows.map((r) => r.table_name);
    record(
      "tenant_erasures is NOT discovered as a tenant table",
      !names.includes("tenant_erasures"),
      `${names.length} tenant table(s) discovered; the ledger is not one of them`,
    );
    record(
      "a table added recently IS discovered",
      names.includes("product_feedback"),
      "discovery is by schema, not by a hand-written list",
    );
    record(
      "the connector credential vault IS discovered as a tenant table",
      names.includes("connector_credentials"),
      "a forgotten row there would be a live third-party token in a dead tenant's database",
    );
    record(
      "the parked-interception store IS discovered as a tenant table",
      names.includes("pending_interceptions"),
      "a forgotten row there would be a customer's sealed request body in a dead tenant's database",
    );

    section("THE FOUR LOCKS");
    const dry = await purgeTenant(pool, A.id, { requestedBy: "", reason: "" });
    record("without --confirm nothing is deleted", !dry.erased && dry.erasureId === null, `${dry.totalRows} row(s) counted`);
    record("after the dry run the rows are still there", (await countFor(pool, "agents", A.id)) === 2);

    let active = "";
    try {
      await purgeTenant(pool, A.id, { confirmName: A.name, requestedBy: "v", reason: "v" });
    } catch (e) {
      active = e instanceof PurgeRefused ? e.message : `wrong error: ${String(e)}`;
    }
    record("an ACTIVE tenant is refused", active.includes("still ACTIVE"));

    await pool.query(`UPDATE organizations SET active = false WHERE id = $1`, [A.id]);

    let wrongName = "";
    try {
      await purgeTenant(pool, A.id, { confirmName: B.name, requestedBy: "v", reason: "v" });
    } catch (e) {
      wrongName = e instanceof PurgeRefused ? e.message : `wrong error: ${String(e)}`;
    }
    record("the other tenant's name does not confirm this one", wrongName.includes("does not match"));
    record("a refused purge left the rows alone", (await countFor(pool, "agents", A.id)) === 2);

    section("THE ERASURE");
    const bBefore = await countFor(pool, "agents", B.id);
    const done = await purgeTenant(pool, A.id, {
      // Casse et espaces différents : la confirmation compare la clé normalisée.
      confirmName: `  ${A.name.toUpperCase()}  `,
      requestedBy: "verify@placet.test",
      reason: "verify:erasure",
    });
    record("a deactivated tenant is erased", done.erased && done.erasureId !== null, `${done.totalRows} row(s)`);

    const left =
      (await countFor(pool, "agents", A.id)) +
      (await countFor(pool, "product_feedback", A.id)) +
      (await countFor(pool, "connector_credentials", A.id)) +
      (await countFor(pool, "pending_interceptions", A.id)) +
      (await pool
        .query<{ n: string }>(`SELECT count(*)::text AS n FROM organizations WHERE id = $1`, [A.id])
        .then((r) => Number(r.rows[0]?.n ?? 0)));
    record("nothing of A survives", left === 0, `${left} row(s) left`);

    /*
     * Nommé séparément, en plus du total. Le total passerait aussi si le coffre n'avait
     * jamais été compté — et « le credential a-t-il disparu ? » est la question qu'un
     * client posera, pas « la somme est-elle nulle ? ».
     */
    const vaultLeft = await countFor(pool, "connector_credentials", A.id);
    record(
      "A's connector credential is gone, envelope included",
      vaultLeft === 0,
      `${vaultLeft} sealed credential(s) left behind`,
    );
    const parkedLeft = await countFor(pool, "pending_interceptions", A.id);
    record(
      "A's parked interception is gone, sealed body included",
      parkedLeft === 0,
      `${parkedLeft} sealed request(s) left behind`,
    );

    const bAfter = await countFor(pool, "agents", B.id);
    record("B is untouched", bAfter === bBefore && bAfter > 0, `B had ${bBefore}, still has ${bAfter}`);
    const bVault = await countFor(pool, "connector_credentials", B.id);
    record("B's credential is untouched", bVault === 1, `${bVault} credential(s)`);

    section("THE PROOF THAT REMAINS");
    const ledger = await pool.query<{ row_counts: string; purged_name_key: string; requested_by: string; reason: string }>(
      `SELECT row_counts, purged_name_key, requested_by, reason FROM tenant_erasures WHERE purged_organization_id = $1`,
      [A.id],
    );
    const row = ledger.rows[0];
    record("the record survives the purge it describes", ledger.rowCount === 1);
    record(
      "it keeps the counts",
      !!row && JSON.parse(row.row_counts).agents === 2 && JSON.parse(row.row_counts).product_feedback === 1,
      row ? `agents=${JSON.parse(row.row_counts).agents}, feedback=${JSON.parse(row.row_counts).product_feedback}` : "",
    );
    record(
      "it keeps who asked and why",
      row?.requested_by === "verify@placet.test" && row?.reason === "verify:erasure",
    );
    /*
     * Le registre garde la clé NORMALISÉE, pas la raison sociale. Se souvenir du nom
     * complet d'un client qu'on vient d'effacer reviendrait à ne pas l'avoir effacé.
     */
    record(
      "it keeps the normalised key, not the full name",
      row?.purged_name_key === A.key && !JSON.stringify(row).includes(A.name),
      `kept "${row?.purged_name_key}", not "${A.name}"`,
    );

    const second = await purgeTenant(pool, A.id, { requestedBy: "", reason: "" }).catch((e) =>
      e instanceof PurgeRefused ? e.message : String(e),
    );
    record(
      "purging an already-erased tenant is refused, not silently repeated",
      typeof second === "string" && second.includes("no organization"),
      typeof second === "string" ? second.slice(0, 60) : "returned a plan",
    );
  } finally {
    await pool.end().catch(() => undefined);
    await db.dispose();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("\n" + "=".repeat(78));
  console.log(`${checks.length - failed.length} / ${checks.length} checks passed`);
  console.log("=".repeat(78) + "\n");
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[oathrion:verify-erasure] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
