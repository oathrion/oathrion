/**
 * La course `pg` / `pg-pool` à l'arrêt de la base (`server/sql/pg-client-guard.ts`).
 *
 * Le défaut : quand `pg-pool` remet une connexion à un appelant, il retire d'abord SON
 * écouteur (`_acquireClient`) ; `pool.query` ne pose le sien qu'ensuite. Un message de
 * fin de PostgreSQL (57P01) arrivé entre les deux est émis sans écouteur, et Node arrête
 * le processus. `verify:faults` le provoquait une fois sur deux ou trois (journal §5.32).
 * Ici, cet état est construit sans attendre le hasard : une connexion fraîchement remise
 * par le pool, avant que quiconque l'écoute, reçoit une erreur.
 *
 * La partie sur un VRAI `pg-pool` exige une base (`OATHRION_TEST_POSTGRES_URL`) et se
 * déclare sautée sans elle.
 */
import { EventEmitter } from "node:events";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { guardPoolClients } from "../sql/pg-client-guard";

const CONNECTION = process.env.OATHRION_TEST_POSTGRES_URL ?? "";

describe("le garde, sans base", () => {
  it("pose un écouteur permanent sur chaque connexion créée, et journalise sans lever", () => {
    const pool = new EventEmitter();
    guardPoolClients(pool as unknown as Pool, "essai");
    const client = new EventEmitter();
    pool.emit("connect", client);
    expect(client.listenerCount("error")).toBe(1);

    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => client.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(String(warned.mock.calls[0]?.[0])).toMatch(/\[essai\] PostgreSQL connection lost.*administrator command/);
    warned.mockRestore();
  });
});

describe.skipIf(CONNECTION === "")("la course, sur un vrai pg-pool", () => {
  const pools: Pool[] = [];
  afterAll(async () => {
    for (const pool of pools) await pool.end().catch(() => undefined);
  });

  async function handedOut(guarded: boolean) {
    const pool = new Pool({ connectionString: CONNECTION, max: 2 });
    pools.push(pool);
    pool.on("error", () => undefined);
    if (guarded) guardPoolClients(pool, "essai");
    /* Remise par le pool : son écouteur d'inactivité vient d'être retiré. */
    return pool.connect();
  }

  it("sans le garde, une connexion qu'on vient de remettre n'a AUCUN écouteur (le défaut)", async () => {
    const client = await handedOut(false);
    expect(client.listenerCount("error")).toBe(0);
    /* `emit("error")` sans écouteur lève : c'est l'exception qui arrêtait le serveur. */
    expect(() => client.emit("error", new Error("57P01 simulé"))).toThrow(/57P01 simulé/);
    client.release(true);
  });

  it("avec le garde, la même erreur est journalisée et le processus continue", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = await handedOut(true);
    expect(client.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(() => client.emit("error", new Error("57P01 simulé"))).not.toThrow();
    expect(warned).toHaveBeenCalled();
    client.release(true);
    warned.mockRestore();
  });
});
