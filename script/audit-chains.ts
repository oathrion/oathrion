/**
 * Vérifie la chaîne de reçus de **chaque locataire**, depuis la base.
 *
 *   DATABASE_URL=postgres://… npm run audit:chains
 *   DATABASE_URL=postgres://… npm run audit:chains -- --prometheus > /var/lib/node_exporter/placet.prom
 *
 * ## Pourquoi un script et non une route
 *
 * `GET /api/actions/receipts/verify` existe déjà, et c'est volontairement une route
 * **cadrée par le credential présenté** : un client vérifie SA chaîne. Il n'existe
 * aucune route qui parcoure tous les locataires, et il ne doit pas en exister — elle
 * livrerait à son appelant la liste des organisations du déploiement, ce que la
 * migration 18 a précisément cessé de faire.
 *
 * L'exploitant, lui, possède la base. Ce script y lit directement, ce qui est la forme
 * honnête de ce privilège : il n'a pas besoin du jeton de chaque client, et il n'ouvre
 * aucune surface HTTP nouvelle.
 *
 * ## Pourquoi la vérification est périodique et non continue
 *
 * Parce qu'elle est en O(n) sur les reçus d'un locataire. La faire à chaque scrape de
 * métriques transformerait la supervision en charge, et la faire à l'écriture
 * reviendrait à demander au scripteur de se contrôler lui-même. Une rupture de chaîne
 * n'est pas une panne de disponibilité : elle est soit une corruption, soit une
 * falsification, et dans les deux cas la détecter en une heure plutôt qu'en une seconde
 * ne change rien à ce qu'on en fera. Un passage horaire en cron est le bon rythme, et
 * `docs/ON-CALL.md` le dit.
 *
 * ## Codes de sortie — c'est le contrat
 *
 *   0  toutes les chaînes vérifiées (ou aucun reçu : une chaîne vide est valide)
 *   1  AU MOINS UNE CHAÎNE EST ROMPUE — réveiller quelqu'un
 *   2  impossible de vérifier (base injoignable, variable absente). PAS « tout va bien »
 *
 * Le 2 est séparé du 1 pour une raison : un cron qui ne sait pas distinguer « rien de
 * cassé » de « je n'ai pas pu regarder » finit par rassurer pendant une panne.
 */

import { Pool } from "pg";
import { verifyReceiptChain } from "../server/authority/receipt-chain";
import type { StoredReceipt } from "../server/authority/receipt-chain";
import { receiptFromRow } from "../server/authority/store";
import { isOrganizationId } from "@shared/tenancy";
import { redactUrl } from "./lib/throwaway-postgres";

const PROMETHEUS = process.argv.includes("--prometheus");

/** Écrit sur stderr quand la sortie standard est réservée au format Prometheus. */
function say(line: string): void {
  // eslint-disable-next-line no-console -- outil d'exploitation, la sortie EST le produit
  (PROMETHEUS ? console.error : console.log)(line);
}

interface Verdict {
  organization: string;
  ok: boolean;
  entries: number;
  brokenAt: number | null;
  reason: string | null;
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (url === "") {
    console.error("DATABASE_URL manquante. Ce script lit la base de l'exploitant ; sans elle,");
    console.error("il ne peut rien vérifier et ne prétend donc rien (sortie 2).");
    return 2;
  }

  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  let verdicts: Verdict[];
  try {
    /*
     * Les organisations sont lues depuis la table des REÇUS et non depuis celle des
     * organisations : un locataire sans aucun reçu n'a pas de chaîne à vérifier, et le
     * faire figurer comme « 0 entrées, OK » noierait les quelques lignes qui comptent
     * sous une par client.
     */
    const orgs = await pool.query<{ organization_id: string }>(
      `SELECT DISTINCT organization_id FROM action_receipts ORDER BY organization_id`,
    );

    verdicts = [];
    for (const { organization_id: org } of orgs.rows) {
      /*
       * Le MÊME tri que `AuthorityStore.listReceiptChain` — `entry_seq ASC NULLS FIRST`,
       * puis `executed_at`, puis `receipt_id`. Un tri différent ici rendrait un verdict
       * différent de celui que le client lit sur sa propre route, et deux vérités sur
       * la même chaîne est exactement ce qu'une chaîne sert à empêcher.
       */
      const rows = await pool.query(
        `SELECT * FROM action_receipts
          WHERE organization_id = $1
          ORDER BY entry_seq ASC NULLS FIRST, executed_at ASC, receipt_id ASC`,
        [org],
      );
      /*
       * `receiptFromRow` — LA conversion, celle que le store utilise, importée et non
       * recopiée. Mon premier jet avait sa propre version et elle perdait les
       * millisecondes de `executed_at` (`String(Date)` ne les écrit pas), ce qui faisait
       * déclarer ROMPUE une chaîne intacte. Deux conversions d'une même ligne, c'est
       * deux avis sur ce qui a été écrit, et le jour où ils diffèrent aucun ne vaut rien.
       */
      const receipts: StoredReceipt[] = rows.rows.map((row: Record<string, unknown>) => receiptFromRow(row));

      /*
       * L'identifiant est VALIDÉ et non transtypé. Il entre dans le hachage de genèse
       * (`genesis:<organisation>`), donc une valeur qui n'est pas un identifiant
       * d'organisation produirait une empreinte différente de celle qu'Oathrion a écrite et
       * ferait rendre « chaîne rompue » à une chaîne intacte — la pire panne possible
       * pour un outil dont le seul rôle est de dire la vérité sur une chaîne.
       */
      if (!isOrganizationId(org)) {
        say(`  ! ${org} — ignoré : la colonne organization_id ne porte pas un identifiant valide`);
        continue;
      }
      const verdict = verifyReceiptChain(org, receipts);
      verdicts.push({
        organization: org,
        ok: verdict.ok,
        entries: verdict.entries,
        brokenAt: verdict.brokenAt,
        reason: verdict.reason,
      });
    }
  } catch (error) {
    console.error(
      `Impossible de lire ${redactUrl(url)} : ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Sortie 2 : rien n'a été vérifié. Ce n'est pas un verdict favorable.");
    return 2;
  } finally {
    await pool.end().catch(() => undefined);
  }

  const broken = verdicts.filter((v) => !v.ok);

  if (PROMETHEUS) {
    /*
     * Format du collecteur de fichiers de node_exporter. L'identifiant du locataire
     * APPARAÎT ici, contrairement à `/api/metrics`, et la différence est délibérée : ce
     * fichier est écrit sur le disque de l'exploitant, lu par son propre collecteur, et
     * il faut bien pouvoir dire QUELLE chaîne est rompue pour aller la regarder. La
     * cardinalité reste bornée par le nombre de clients, pas par le trafic.
     */
    const lines = [
      "# HELP oathrion_receipt_chain_ok 1 si la chaîne de reçus de ce locataire se vérifie.",
      "# TYPE oathrion_receipt_chain_ok gauge",
      ...verdicts.map((v) => `oathrion_receipt_chain_ok{organization="${v.organization}"} ${v.ok ? 1 : 0}`),
      "# HELP oathrion_receipt_chain_entries Nombre de reçus dans la chaîne de ce locataire.",
      "# TYPE oathrion_receipt_chain_entries gauge",
      ...verdicts.map((v) => `oathrion_receipt_chain_entries{organization="${v.organization}"} ${v.entries}`),
      "# HELP oathrion_receipt_chain_audit_timestamp_seconds Date du dernier passage de cet audit.",
      "# TYPE oathrion_receipt_chain_audit_timestamp_seconds gauge",
      `oathrion_receipt_chain_audit_timestamp_seconds ${Math.floor(Date.now() / 1000)}`,
      "",
    ];
    process.stdout.write(lines.join("\n"));
  }

  say(`Oathrion — audit des chaînes de reçus sur ${redactUrl(url)}`);
  if (verdicts.length === 0) {
    say("Aucun reçu dans ce déploiement : rien à vérifier. Une chaîne vide est valide.");
    return 0;
  }
  for (const v of verdicts) {
    say(
      `  ${v.ok ? "✓" : "✗"} ${v.organization} — ${v.entries} reçus` +
        (v.ok ? "" : ` — ROMPUE au n°${String(v.brokenAt)} : ${v.reason ?? "sans motif"}`),
    );
  }
  say(`\n${verdicts.length - broken.length}/${verdicts.length} chaînes vérifiées`);

  if (broken.length > 0) {
    say("");
    say("UNE CHAÎNE ROMPUE N'EST PAS UNE PANNE DE DISPONIBILITÉ.");
    say("C'est soit une corruption de stockage, soit une écriture qui n'est pas passée par");
    say("Oathrion. Dans les deux cas : ne restaurez pas par-dessus, et ne réécrivez rien — la");
    say("procédure est dans docs/ON-CALL.md, §« chaîne rompue ».");
  }
  return broken.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(2);
  });
