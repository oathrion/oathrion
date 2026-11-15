/**
 * Migration 31 — les reçus contresignés des mandats (`notes/CONCEPTION-MANDAT.md`, étape M4).
 *
 * Chaque action faite sous un mandat laisse, chez l'organisation, un reçu signé des DEUX côtés :
 * l'autorisation qu'elle a émise, et le reçu que la contrepartie a signé. Ils forment une chaîne
 * par organisation (`entry_seq` sans trou, `prev_hash`, `entry_hash`) : en retirer, en modifier ou
 * en réordonner un casse la chaîne, comme celle des reçus d'action.
 */
import type { Migration, SchemaInspect } from "./types";

export const MANDATE_RECEIPTS_TABLE = "mandate_receipts";

export const mandateReceipts: Migration = {
  version: 31,
  name: "mandate-receipts",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(MANDATE_RECEIPTS_TABLE)) return [];
    const time = schema.dialect === "sqlite" ? "TEXT" : "TIMESTAMPTZ";
    return [
      `CREATE TABLE IF NOT EXISTS ${MANDATE_RECEIPTS_TABLE} (
         organization_id  TEXT NOT NULL,
         grant_id         TEXT NOT NULL,
         mandate_id       TEXT NOT NULL,
         outcome          TEXT NOT NULL CHECK (outcome IN ('executed', 'refused')),
         counterparty     TEXT NOT NULL,
         document         TEXT NOT NULL,
         recorded_at      ${time} NOT NULL,
         entry_seq        INTEGER NOT NULL,
         prev_hash        TEXT,
         entry_hash       TEXT NOT NULL,
         PRIMARY KEY (organization_id, grant_id),
         UNIQUE (organization_id, entry_seq)
       )`,
      `CREATE INDEX IF NOT EXISTS ${MANDATE_RECEIPTS_TABLE}_by_mandate ON ${MANDATE_RECEIPTS_TABLE} (organization_id, mandate_id, entry_seq)`,
    ];
  },
};
