/**
 * Une connexion coupée PENDANT une transaction ne doit pas arrêter le processus.
 *
 * Reproduit en coupant PostgreSQL sous trafic continu (docs/STRESS-TEST-LOG.md) : une fois
 * sur cinq, Oathrion s'arrêtait — « [lifecycle] uncaught exception — shutting down:
 * Connection terminated unexpectedly ». Un client emprunté au pool n'a plus d'écouteur
 * d'erreur ; coupé pendant que la transaction attend du code applicatif entre deux
 * requêtes, il émettait `error` dans le vide.
 *
 * Ce test rend la course déterministe : il tue la connexion de la transaction depuis une
 * autre session (`pg_terminate_backend`) et attend que le client l'apprenne, entre deux
 * requêtes. Une erreur échappée fait échouer la suite (vitest signale toute exception non
 * attrapée) ; contre l'ancien `transaction()`, c'est ce qui se produit.
 *
 *   OATHRION_TEST_POSTGRES_URL=postgres://… npx vitest run server/test/postgres-connection-loss.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { postgresExecutor } from "../sql/executor";

const CONNECTION = process.env.OATHRION_TEST_POSTGRES_URL ?? process.env.DATABASE_URL ?? "";

describe.runIf(CONNECTION !== "")("une connexion coupée au milieu d'une transaction", () => {
  let pool: Pool;
  let killer: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: CONNECTION, max: 2 });
    // Comme en production : le pool lui-même a un écouteur pour ses clients inactifs.
    pool.on("error", () => undefined);
    killer = new Pool({ connectionString: CONNECTION, max: 1 });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await killer?.end().catch(() => undefined);
  });

  it("refuse la transaction sans arrêter le processus, et le pool reste utilisable", async () => {
    const executor = postgresExecutor(pool);
    let killed = false;

    const attempt = executor.transaction(async (tx) => {
      const [row] = await tx.all<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await killer.query("SELECT pg_terminate_backend($1)", [row!.pid]);
      killed = true;
      // ENTRE deux requêtes : le client apprend la coupure pendant cette attente.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx.all("SELECT 1");
    });

    await expect(attempt).rejects.toThrow();
    expect(killed).toBe(true);

    // Le client cassé a été détruit, pas rendu : la requête suivante obtient une
    // connexion saine.
    const [after] = await executor.all<{ ok: number }>("SELECT 1 AS ok");
    expect(after?.ok).toBe(1);
  }, 30_000);
});
