/**
 * Migration 29 — le point de reprise de la vérification de chaque chaîne de reçus.
 *
 * La vérification complète relit toute la chaîne d'une organisation : environ 13 µs par
 * reçu, soit environ 13 s par million (journal §5.25, §5.34). Une vérification par ÉTAPES
 * ne relit que ce qui a été écrit depuis la dernière vérification réussie : il faut donc
 * se souvenir où elle s'est arrêtée — le nombre de reçus vérifiés, la position et
 * l'empreinte du dernier — et quand la dernière vérification COMPLÈTE a eu lieu, parce
 * qu'une vérification par étapes ne voit pas une modification des reçus déjà vérifiés.
 *
 * Une ligne par organisation. Table seule : aucune donnée existante n'est modifiée.
 */

import type { Migration, SchemaInspect } from "./types";

export const RECEIPT_CHAIN_CHECKPOINTS_TABLE = "receipt_chain_checkpoints";

export const receiptChainCheckpoints: Migration = {
  version: 29,
  name: "receipt-chain-checkpoints",
  statements(schema: SchemaInspect): string[] {
    if (schema.tableExists(RECEIPT_CHAIN_CHECKPOINTS_TABLE)) return [];
    return [
      `CREATE TABLE IF NOT EXISTS ${RECEIPT_CHAIN_CHECKPOINTS_TABLE} (
         organization_id  TEXT PRIMARY KEY,
         entries          INTEGER NOT NULL,
         entry_seq        INTEGER NOT NULL,
         entry_hash       TEXT NOT NULL,
         verified_at      TEXT NOT NULL,
         full_verified_at TEXT
       )`,
    ];
  },
};
