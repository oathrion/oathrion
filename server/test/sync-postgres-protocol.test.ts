/**
 * Le protocole entre le thread principal et le worker d'identité PostgreSQL.
 *
 * Relevé par `SOAK_MINUTES=60 npm run verify:soak` (docs/STRESS-TEST-LOG.md §2.2) : deux
 * `500` sur `GET /api/actions/receipts` en 32 552 cycles, `SyntaxError: Unexpected end of
 * JSON input` dans `resolveActive` et `membership`. Une notification arrivée en retard
 * réveillait l'attente de la requête SUIVANTE avant toute réponse.
 *
 * Le worker de ce test (`fixtures/sync-pg-unruly-worker.cjs`) produit les deux
 * comportements à la demande, sans PostgreSQL et sans dépendre d'un ordonnancement
 * chanceux : la course que le banc d'endurance attrapait une fois sur ~16 000 devient
 * déterministe.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncPostgresDatabase, IdentityDatabaseError } from "../identity/sync-postgres";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sync-pg-unruly-worker.cjs");

function open(timeoutMs = 200) {
  return createSyncPostgresDatabase("postgres://inutilise", {
    OATHRION_IDENTITY_PG_WORKER: WORKER,
    OATHRION_IDENTITY_PG_TIMEOUT_MS: String(timeoutMs),
  });
}

describe("le protocole synchrone du plan d'identité", () => {
  it("un réveil sans réponse publiée est ignoré : la requête attend SA réponse", () => {
    const db = open();
    try {
      expect(db.prepare("spurious").get()).toEqual({ echo: "spurious" });
      expect(db.prepare("ensuite").get()).toEqual({ echo: "ensuite" });
    } finally {
      db.close();
    }
  });

  it("la réponse tardive d'une requête abandonnée n'est jamais rendue à la suivante", async () => {
    const db = open(600);
    try {
      /* Abandonnée à 600 ms ; sa réponse arrive à 800 ms… */
      expect(() => db.prepare("slow").get()).toThrow(IdentityDatabaseError);
      /* …pendant l'attente de celle-ci, qui répond à ~1 000 ms. */
      expect(db.prepare("lent-frais").get()).toEqual({ echo: "lent-frais" });
      expect(db.prepare("encore").get()).toEqual({ echo: "encore" });
    } finally {
      db.close();
    }
  });

  it("mille requêtes d'affilée reçoivent chacune leur propre réponse", () => {
    const db = open(2_000);
    try {
      for (let i = 0; i < 1_000; i += 1) {
        expect(db.prepare(`q${i}`).get()).toEqual({ echo: `q${i}` });
      }
    } finally {
      db.close();
    }
  });
});
