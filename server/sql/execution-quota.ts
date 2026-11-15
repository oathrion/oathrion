/**
 * LE QUOTA D'EXÉCUTIONS DU MOIS — une seule définition pour les deux voies et les deux
 * moteurs.
 *
 * ## Compter, puis tenir un compteur
 *
 * Une exécution passe par l'une de deux voies : le relais et la passerelle (une ligne
 * `executions`), ou la voie directe (une autorisation consommée, `action_grants.consumed_at`).
 * Le quota les additionne. Il les COMPTAIT à chaque exécution, sous le verrou de
 * l'organisation : environ 1 s pour un million d'actions dans le mois, donc une exécution
 * par seconde à ce volume (journal §5.34).
 *
 * Désormais, `quota_period_counts` (migration 28) tient le total de la période. Il est lu,
 * puis incrémenté, dans la MÊME transaction que l'écriture qu'il compte, sous le MÊME
 * verrou (`executionQuotaLockKey` ; sur SQLite, la transaction IMMEDIATE suffit) : la
 * lecture et l'écriture ne peuvent pas se chevaucher, et une transaction annulée annule
 * son incrément. Le coût ne dépend plus du volume.
 *
 * Le comptage reste pour INITIALISER une période, la première fois qu'elle est lue
 * (`periodUsage`) : une fois par mois et par organisation, et pour un rapport d'usage qui
 * trouverait la période pas encore ouverte (sans rien écrire).
 *
 * ## Ce que le compteur ne voit pas
 *
 * Une exécution écrite SANS passer par l'une des deux voies — une importation, une ligne
 * insérée à la main — n'est pas comptée. Les trois chemins qui insèrent une exécution et la
 * consommation d'une autorisation passent tous par ici.
 */
import type { OrganizationId } from "@shared/tenancy";
import { ACTION_GRANTS_TABLE } from "../migrations/012-action-authority";
import { QUOTA_PERIOD_COUNTS_TABLE } from "../migrations/028-quota-period-counts";
import type { SqlExecutor } from "./executor";

const COUNTER = "executions";

/** La clé du verrou par locataire sous lequel le quota d'exécutions se lit et s'incrémente. */
export function executionQuotaLockKey(org: OrganizationId): string {
  return `placet:quota:executions:${org}`;
}

/**
 * Les exécutions du locataire depuis `since`, LES DEUX VOIES, comptées. Une action ne passe
 * que par une voie : rien n'est compté deux fois. `consumed_at` et non l'état : une
 * autorisation consommée puis révoquée a bien été exécutée.
 */
export async function countExecutionsSince(executor: SqlExecutor, org: OrganizationId, since: string): Promise<number> {
  const rows = await executor.all<{ n: unknown }>(
    `SELECT (SELECT count(*) FROM ${ACTION_GRANTS_TABLE} WHERE organization_id = ? AND consumed_at >= ?)
          + (SELECT count(*) FROM executions WHERE organization_id = ? AND "timestamp" >= ?) AS n`,
    [org, since, org, since],
  );
  return Number(rows[0]?.n ?? 0);
}

async function readCounter(executor: SqlExecutor, org: OrganizationId, periodStart: string): Promise<number | null> {
  const rows = await executor.all<{ used: unknown }>(
    `SELECT used FROM ${QUOTA_PERIOD_COUNTS_TABLE} WHERE organization_id = ? AND counter = ? AND period_start = ?`,
    [org, COUNTER, periodStart],
  );
  return rows[0] ? Number(rows[0].used) : null;
}

/**
 * Le total de la période, ouverte si besoin par un comptage. À appeler sous le verrou et
 * dans la transaction de l'écriture : c'est ce qui rend l'ouverture sûre.
 */
export async function periodUsage(executor: SqlExecutor, org: OrganizationId, periodStart: string): Promise<number> {
  const known = await readCounter(executor, org, periodStart);
  if (known !== null) return known;
  const counted = await countExecutionsSince(executor, org, periodStart);
  await executor.run(
    `INSERT INTO ${QUOTA_PERIOD_COUNTS_TABLE} (organization_id, counter, period_start, used) VALUES (?, ?, ?, ?)
       ON CONFLICT (organization_id, counter, period_start) DO NOTHING`,
    [org, COUNTER, periodStart, counted],
  );
  return (await readCounter(executor, org, periodStart)) ?? counted;
}

/** Le total pour un RAPPORT : le compteur s'il existe, sinon un comptage, et rien n'est écrit. */
export async function reportedUsage(executor: SqlExecutor, org: OrganizationId, periodStart: string): Promise<number> {
  return (await readCounter(executor, org, periodStart)) ?? countExecutionsSince(executor, org, periodStart);
}

/** Une exécution de plus dans la période. Dans la transaction de l'écriture comptée. */
export async function incrementPeriodUsage(executor: SqlExecutor, org: OrganizationId, periodStart: string): Promise<void> {
  await executor.run(
    `UPDATE ${QUOTA_PERIOD_COUNTS_TABLE} SET used = used + 1 WHERE organization_id = ? AND counter = ? AND period_start = ?`,
    [org, COUNTER, periodStart],
  );
}
