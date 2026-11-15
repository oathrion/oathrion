/**
 * TENANT EXPORT — every row one organization owns, read from PostgreSQL, as JSON.
 *
 * Read-only (one REPEATABLE READ, READ ONLY transaction, so the export is a single
 * consistent snapshot). The set of tables is not a hand-maintained list that could
 * forget a new one: it is every table of the schema that has an `organization_id`
 * column, plus the organization's own row in `organizations`. Tables without that
 * column (the migration ledger, the rate-limit counters) hold no tenant data.
 *
 * Credential material is REDACTED, never exported: a column whose name says it holds
 * a password, a secret, or a key/token hash is replaced by "[REDACTED]". Audit hash
 * The session id is redacted too (see below). Audit hash
 * chains are kept — they are what lets the customer verify the export's integrity.
 */
import type { Pool } from "pg";

export const REDACTED = "[REDACTED]";
const SENSITIVE_COLUMN = /(password|secret|key_hash|token_hash|session_hash|credential_hash)/i;
/*
 * A console bearer token is `<sessions.id>.<HMAC(id)>`. The id alone is not a token
 * (the HMAC needs OATHRION_SESSION_SECRET), but an export is handed outside the
 * operator's perimeter: half of a live credential does not leave with it.
 */
const SENSITIVE_BY_TABLE: Record<string, string[]> = { sessions: ["id"] };

export interface TenantExport {
  format: "placet-tenant-export/1";
  organizationId: string;
  exportedAt: string;
  schemaVersion: number | null;
  tables: Record<string, Record<string, unknown>[]>;
  redactedColumns: string[];
}

export async function exportTenant(pool: Pool, organizationId: string): Promise<TenantExport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tablesWithOrg = await client.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema() AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`,
    );
    const version = await client
      .query<{ v: number }>("SELECT max(version)::int AS v FROM schema_migrations")
      .then((r) => r.rows[0]?.v ?? null, () => null);
    const tables: Record<string, Record<string, unknown>[]> = {};
    const redacted = new Set<string>();
    const redact = (table: string, row: Record<string, unknown>) => {
      for (const column of Object.keys(row)) {
        const named = SENSITIVE_BY_TABLE[table]?.includes(column) ?? false;
        if ((named || SENSITIVE_COLUMN.test(column)) && row[column] !== null) {
          row[column] = REDACTED;
          redacted.add(`${table}.${column}`);
        }
      }
      return row;
    };
    const orgTable = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'organizations'`,
    );
    if (orgTable.rowCount) {
      const own = await client.query(`SELECT * FROM organizations WHERE id = $1`, [organizationId]);
      tables.organizations = own.rows.map((r) => redact("organizations", r));
    }
    for (const { table_name } of tablesWithOrg.rows) {
      // Identifier comes from information_schema, quoted; the value is a bound parameter.
      const rows = await client.query(`SELECT * FROM "${table_name.replace(/"/g, '""')}" WHERE organization_id = $1`, [
        organizationId,
      ]);
      tables[table_name] = rows.rows.map((r) => redact(table_name, r));
    }
    await client.query("COMMIT");
    return {
      format: "placet-tenant-export/1",
      organizationId,
      exportedAt: new Date().toISOString(),
      schemaVersion: version,
      tables,
      redactedColumns: [...redacted].sort(),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
