/**
 * La mémoire de la réconciliation (migration 26).
 *
 * `addFindings` est le mécanisme d'alerte unique : `INSERT … ON CONFLICT DO NOTHING
 * RETURNING` ne rend que les écritures jamais vues, donc deux passages simultanés (deux
 * instances, ou le bouton pendant la tâche) n'alertent qu'une fois pour chacune.
 */
import type { OrganizationId } from "@shared/tenancy";
import { RECONCILE_FINDINGS_TABLE, RECONCILE_RUNS_TABLE } from "../migrations";
import type { SqlExecutor } from "../sql/executor";
import type { ReconcileItem } from "./types";

/**
 * `receipt_gap` : une autorisation consommée dont le reçu n'a jamais été écrit — l'écart
 * qu'Oathrion constate sur LUI-MÊME (`server/authority/receipt-gaps.ts`), gardé ici pour
 * n'alerter qu'une fois, comme une écriture vue hors d'Oathrion.
 */
export type FindingCategory = "outside" | "unknown_marker" | "receipt_gap";

export interface StoredFinding extends Omit<ReconcileItem, "byOathrionIdentity"> {
  category: FindingCategory;
  firstSeenAt: string;
}

export interface ReconcileRunRecord {
  ranAt: string;
  trigger: "manual" | "auto";
  ok: boolean;
  verdict: "clean" | "alert" | "partial" | "failed";
  since: string;
  identity: string;
  scanned: number;
  viaOathrion: number;
  outsideCount: number;
  unknownCount: number;
  others: number;
  truncated: boolean;
  detail: string;
}

const instant = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ""));

export class ReconcileStore {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
  ) {}

  /** Garde les écritures, et rend celles qui sont NOUVELLES — les seules à alerter. */
  async addFindings(connectorId: string, findings: { item: ReconcileItem; category: FindingCategory }[], now = new Date()): Promise<StoredFinding[]> {
    const fresh: StoredFinding[] = [];
    const at = now.toISOString();
    for (const { item, category } of findings) {
      const rows = await this.sql.all<{ item_id: string }>(
        `INSERT INTO ${RECONCILE_FINDINGS_TABLE}
           (organization_id, connector_id, item_id, category, kind, url, summary, actor, marker, item_created_at, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (organization_id, connector_id, item_id) DO NOTHING
         RETURNING item_id`,
        [this.org, connectorId, item.id, category, item.kind, item.url, item.summary.slice(0, 200), item.actor, item.marker, item.createdAt, at],
      );
      if (rows.length > 0) {
        fresh.push({ id: item.id, kind: item.kind, url: item.url, createdAt: item.createdAt, actor: item.actor, summary: item.summary, marker: item.marker, category, firstSeenAt: at });
      }
    }
    return fresh;
  }

  async findings(connectorId: string, limit = 50): Promise<StoredFinding[]> {
    const rows = await this.sql.all<Record<string, unknown>>(
      `SELECT item_id, category, kind, url, summary, actor, marker, item_created_at, first_seen_at
         FROM ${RECONCILE_FINDINGS_TABLE}
        WHERE organization_id = ? AND connector_id = ?
        ORDER BY first_seen_at DESC, item_id ASC
        LIMIT ?`,
      [this.org, connectorId, limit],
    );
    return rows.map((r) => ({
      id: String(r.item_id),
      category: r.category === "unknown_marker" ? "unknown_marker" : "outside",
      kind: String(r.kind) as ReconcileItem["kind"],
      url: r.url === null ? null : String(r.url),
      summary: String(r.summary ?? ""),
      actor: r.actor === null ? null : String(r.actor),
      marker: r.marker === null ? null : String(r.marker),
      createdAt: String(r.item_created_at ?? ""),
      firstSeenAt: instant(r.first_seen_at),
    }));
  }

  async recordRun(connectorId: string, run: ReconcileRunRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO ${RECONCILE_RUNS_TABLE}
         (organization_id, connector_id, ran_at, run_trigger, ok, verdict, since, identity, scanned, via_placet,
          outside_count, unknown_count, others, truncated, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, connector_id) DO UPDATE SET
         ran_at = excluded.ran_at, run_trigger = excluded.run_trigger, ok = excluded.ok, verdict = excluded.verdict,
         since = excluded.since, identity = excluded.identity, scanned = excluded.scanned, via_placet = excluded.via_placet,
         outside_count = excluded.outside_count, unknown_count = excluded.unknown_count, others = excluded.others,
         truncated = excluded.truncated, detail = excluded.detail`,
      [
        this.org, connectorId, run.ranAt, run.trigger, run.ok ? 1 : 0, run.verdict, run.since, run.identity, run.scanned,
        run.viaOathrion, run.outsideCount, run.unknownCount, run.others, run.truncated ? 1 : 0, run.detail.slice(0, 500),
      ],
    );
  }

  async lastRun(connectorId: string): Promise<ReconcileRunRecord | null> {
    const rows = await this.sql.all<Record<string, unknown>>(
      `SELECT ran_at, run_trigger, ok, verdict, since, identity, scanned, via_placet, outside_count, unknown_count, others, truncated, detail
         FROM ${RECONCILE_RUNS_TABLE}
        WHERE organization_id = ? AND connector_id = ?`,
      [this.org, connectorId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ranAt: instant(r.ran_at),
      trigger: r.run_trigger === "auto" ? "auto" : "manual",
      ok: Number(r.ok) === 1,
      verdict: (["clean", "alert", "partial", "failed"].includes(String(r.verdict)) ? String(r.verdict) : "failed") as ReconcileRunRecord["verdict"],
      since: String(r.since ?? ""),
      identity: String(r.identity ?? ""),
      scanned: Number(r.scanned ?? 0),
      viaOathrion: Number(r.via_placet ?? 0),
      outsideCount: Number(r.outside_count ?? 0),
      unknownCount: Number(r.unknown_count ?? 0),
      others: Number(r.others ?? 0),
      truncated: Number(r.truncated) === 1,
      detail: String(r.detail ?? ""),
    };
  }
}
