/**
 * SQLite driver for the migration runner.
 *
 * Thin on purpose: better-sqlite3 is already synchronous and already exposes
 * transactions, so this adapter exists to keep the runner free of any engine
 * knowledge — which is the whole point of having a driver interface before the
 * PostgreSQL work starts.
 */

import type Database from "better-sqlite3";
import type { MigrationDriver } from "./runner";

export function createSqliteMigrationDriver(sqlite: Database.Database): MigrationDriver {
  return {
    dialect: "sqlite",

    exec(sql: string): void {
      sqlite.exec(sql);
    },

    query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
      return sqlite.prepare(sql).all(...(params as never[])) as T[];
    },

    transaction(fn: () => void): void {
      /*
       * better-sqlite3's `transaction()` wrapper is used rather than hand-written
       * BEGIN/COMMIT because it handles the nested-transaction and rollback cases
       * correctly, including re-throwing the original error after the rollback —
       * which is what the runner relies on to report the failed migration.
       */
      sqlite.transaction(fn)();
    },

    tableExists(table: string): boolean {
      const row = sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { name?: string } | undefined;
      return row?.name === table;
    },

    columns(table: string): Set<string> {
      // PRAGMA on a missing table returns an empty list rather than throwing, so
      // an absent table and a table with no columns are indistinguishable here.
      // Callers that need the difference use `tableExists`.
      const rows = sqlite.pragma(`table_info(${JSON.stringify(table)})`) as { name: string }[];
      return new Set(rows.map((row) => row.name.toLowerCase()));
    },
  };
}
