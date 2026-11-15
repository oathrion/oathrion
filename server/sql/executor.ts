/**
 * One SQL surface, two engines (Phase 10).
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 9 shipped an honest refusal: `DATABASE_DRIVER=postgres` would not boot,
 * because the repositories were synchronous better-sqlite3 statements. Phase 10
 * has to make PostgreSQL real, and the cheapest way to make two engines agree is
 * to make them run the *same statements*.
 *
 * So every Phase 10 store is written once, against this interface, in portable
 * SQL with `?` placeholders. The PostgreSQL executor rewrites `?` into `$1..$n`;
 * nothing else differs. The alternative — two hand-written implementations —
 * is how a security check ends up present in one engine and absent in the other,
 * and the engine it is absent from is always the one in production.
 *
 * WHAT IS DELIBERATELY NOT ABSTRACTED
 * -----------------------------------
 * Transactions are exposed, not hidden. The single-use grant consumption is a
 * conditional UPDATE whose row count is the security decision, so `run` returns
 * the affected row count and callers branch on it. A wrapper that swallowed that
 * number would remove the only evidence that exactly one consumer won.
 */

import type { Pool, PoolClient } from "pg";

export type SqlDialect = "sqlite" | "postgres";

export interface SqlExecutor {
  readonly dialect: SqlDialect;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Affected row count. The value several security checks branch on. */
  run(sql: string, params?: readonly unknown[]): Promise<number>;
  /**
   * Runs `fn` inside one transaction on ONE connection.
   *
   * The executor handed to `fn` must be used for every statement inside it: a
   * `BEGIN` on one pooled connection and an `UPDATE` on another is not a
   * transaction, it is two unrelated statements and a leaked connection.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Rewrites portable `?` placeholders into PostgreSQL's positional form. */
export function toPositional(sql: string): string {
  let index = 0;
  let out = "";
  let inSingle = false;
  for (const ch of sql) {
    if (ch === "'") inSingle = !inSingle;
    if (ch === "?" && !inSingle) {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** better-sqlite3 executor. Synchronous underneath, async at the surface. */
export function sqliteExecutor(database: {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  };
  exec(sql: string): unknown;
}): SqlExecutor {
  /*
   * UNE TRANSACTION À LA FOIS sur la connexion unique (test de charge du 9 novembre). Deux
   * transactions lancées ensemble ouvraient chacune « BEGIN » sur la même connexion : la
   * seconde échouait (« transaction within a transaction »). Elles attendent maintenant leur
   * tour. Une transaction ne doit pas en ouvrir une autre : elle attendrait la fin de la sienne.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const executor: SqlExecutor = {
    dialect: "sqlite",
    async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return database.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: readonly unknown[] = []): Promise<number> {
      return database.prepare(sql).run(...params).changes;
    },
    transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const turn = queue.then(() => runTransaction(fn));
      queue = turn.catch(() => undefined);
      return turn;
    },
  };
  async function runTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      /*
       * IMMEDIATE, not DEFERRED. A deferred transaction takes its write lock at
       * the first write, so two concurrent transactions can both read, then one
       * fails at write time with SQLITE_BUSY. Taking the lock up front makes the
       * two serialise instead of one erroring, which is what the grant
       * consumption path needs.
       */
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(executor);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          /* a rollback that fails must not mask the original error */
        }
        throw error;
      }
  }
  return executor;
}

/** node-postgres executor over a pool. */
export function postgresExecutor(pool: Pool): SqlExecutor {
  const executor: SqlExecutor = {
    dialect: "postgres",
    async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const result = await pool.query(toPositional(sql), params as unknown[]);
      return result.rows as T[];
    },
    async run(sql: string, params: readonly unknown[] = []): Promise<number> {
      const result = await pool.query(toPositional(sql), params as unknown[]);
      return result.rowCount ?? 0;
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      /*
       * UN CLIENT EMPRUNTÉ N'A PLUS D'ÉCOUTEUR D'ERREUR. `pg-pool` retire le sien pendant
       * l'emprunt ; si la connexion est coupée pendant que la transaction attend du code
       * applicatif ENTRE deux requêtes, le client émet `error` sans personne pour
       * l'entendre — et Node arrête le processus. Reproduit en coupant PostgreSQL sous
       * trafic (docs/STRESS-TEST-LOG.md) : « uncaught exception — shutting down:
       * Connection terminated unexpectedly ». L'erreur est retenue ici ; la requête
       * suivante échoue normalement et la transaction est refusée.
       *
       * Et un client cassé n'est PAS rendu au pool : `release(error)` le détruit, au lieu
       * de le prêter à la requête suivante.
       */
      let broken: Error | undefined;
      const onError = (error: Error): void => {
        broken = error;
      };
      client.on("error", onError);
      try {
        await client.query("BEGIN");
        const result = await fn(clientExecutor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* see above */
        }
        throw error;
      } finally {
        client.off("error", onError);
        client.release(broken);
      }
    },
  };
  return executor;
}

function clientExecutor(client: PoolClient): SqlExecutor {
  const executor: SqlExecutor = {
    dialect: "postgres",
    async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const result = await client.query(toPositional(sql), params as unknown[]);
      return result.rows as T[];
    },
    async run(sql: string, params: readonly unknown[] = []): Promise<number> {
      const result = await client.query(toPositional(sql), params as unknown[]);
      return result.rowCount ?? 0;
    },
    // Already inside a transaction: nesting would need savepoints, and no Phase 10
    // path needs one. Reusing the same connection is correct and honest.
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return fn(executor);
    },
  };
  return executor;
}
