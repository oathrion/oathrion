/**
 * Versioned schema migrations — contracts.
 *
 * WHY THIS EXISTS (P0-3)
 * ----------------------
 * Until now the schema was created by a block of `CREATE TABLE IF NOT EXISTS`
 * running at import time, followed by hand-written `ALTER TABLE` guarded by
 * `PRAGMA table_info` diffs. That works exactly once — on a fresh checkout. It
 * gives an operator no way to know which version of the schema a database is at,
 * no way to fail loudly on a downgrade, and no ordered history to reason about
 * during an incident. The `sessions` table ended up declared twice (raw SQL in
 * `db.ts`, Drizzle in `shared/schema.ts`) precisely because nothing owned the
 * schema. Multi-tenancy and real user accounts both change the schema, so this
 * had to be fixed before either of them, not after.
 *
 * DESIGN
 * ------
 * A migration does not hold a fixed SQL string. It holds a function that is
 * handed a read-only view of the current schema and *returns* the statements to
 * run. Two reasons:
 *
 *   1. The inherited upgrade path is genuinely conditional (add `mandate` only if
 *      absent). Deleting that logic would break every database created by an
 *      earlier build; pretending it is unconditional would make it crash.
 *   2. SQLite and PostgreSQL do not share DDL. The same migration can emit the
 *      right statements for each dialect instead of the codebase carrying two
 *      divergent migration histories that drift apart.
 *
 * `statements()` is synchronous and must not perform I/O. The runner collects the
 * schema metadata *before* calling it, which is what lets one migration
 * definition serve both a synchronous SQLite driver and an asynchronous
 * PostgreSQL driver.
 */

export type Dialect = "sqlite" | "postgres";

/** Read-only view of the live schema, gathered by the runner before each migration. */
export interface SchemaInspect {
  readonly dialect: Dialect;
  /** Lower-cased column names of `table`, or an empty set when it does not exist. */
  columns(table: string): Set<string>;
  tableExists(table: string): boolean;
}

export interface Migration {
  /** Strictly increasing, unique, never reused. */
  readonly version: number;
  /**
   * Stable identifier recorded in the ledger. Renaming an already-applied
   * migration is treated as a tampered history and refused — see `runner.ts`.
   */
  readonly name: string;
  /**
   * Statements to apply, in order, inside a single transaction.
   * Returning an empty array is legal and means "already satisfied".
   */
  statements(schema: SchemaInspect): string[];
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
  statementCount: number;
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}
