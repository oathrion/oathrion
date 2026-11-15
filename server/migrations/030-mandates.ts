/**
 * Migration 30 — le mandat vérifiable (`notes/CONCEPTION-MANDAT.md`, étape M2).
 *
 * Trois tables, toutes cadrées par l'organisation :
 *
 *   · `mandates` : le mandat signé (le document entier, tel qu'une contrepartie le reçoit), son
 *     état, et sa place dans la liste de révocation de l'organisation (unique par organisation) ;
 *   · `mandate_keys` : la clé de l'ORGANISATION, scellée par le coffre (`server/secrets/
 *     envelope.ts`), et la clé PUBLIQUE de chaque signataire — sa clé privée ne quitte jamais son
 *     navigateur, le serveur ne peut pas signer à sa place ;
 *   · `mandate_grants` : chaque autorisation émise, pour tenir les cumuls (« ≤ 50 000 € par
 *     mois ») que seule l'organisation voit en entier.
 */
import type { Migration, SchemaInspect } from "./types";

export const MANDATES_TABLE = "mandates";
export const MANDATE_KEYS_TABLE = "mandate_keys";
export const MANDATE_GRANTS_TABLE = "mandate_grants";

const STATES = "('pending', 'active', 'revoked')";

export const mandates: Migration = {
  version: 30,
  name: "mandates",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(MANDATES_TABLE)) return [];
    const time = schema.dialect === "sqlite" ? "TEXT" : "TIMESTAMPTZ";
    return [
      `CREATE TABLE IF NOT EXISTS ${MANDATES_TABLE} (
         id               TEXT PRIMARY KEY,
         organization_id  TEXT NOT NULL,
         status_index     INTEGER NOT NULL,
         state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ${STATES}),
         document         TEXT NOT NULL,
         created_by       TEXT NOT NULL,
         created_at       ${time} NOT NULL,
         revoked_by       TEXT,
         revoked_at       ${time},
         UNIQUE (organization_id, status_index)
       )`,
      `CREATE INDEX IF NOT EXISTS ${MANDATES_TABLE}_by_tenant ON ${MANDATES_TABLE} (organization_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${MANDATE_KEYS_TABLE} (
         organization_id  TEXT NOT NULL,
         holder           TEXT NOT NULL,
         public_key       TEXT NOT NULL,
         sealed_private   TEXT,
         created_at       ${time} NOT NULL,
         PRIMARY KEY (organization_id, holder)
       )`,
      `CREATE TABLE IF NOT EXISTS ${MANDATE_GRANTS_TABLE} (
         id               TEXT PRIMARY KEY,
         organization_id  TEXT NOT NULL,
         mandate_id       TEXT NOT NULL,
         action_hash      TEXT NOT NULL,
         amount           DOUBLE PRECISION,
         currency         TEXT,
         issued_at        ${time} NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS ${MANDATE_GRANTS_TABLE}_by_mandate ON ${MANDATE_GRANTS_TABLE} (organization_id, mandate_id, issued_at DESC)`,
    ];
  },
};
