/**
 * Exports one organization's data from PostgreSQL as JSON (read-only).
 *
 *   DATABASE_URL=postgres://... npm run tenant:export -- org_acme > org_acme.json
 *
 * Credential material is redacted (see script/lib/tenant-export.ts). The connection
 * string is never printed.
 */
import { Pool } from "pg";
import { exportTenant } from "./lib/tenant-export";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  const org = process.argv[2]?.trim();
  if (!url || !org) {
    console.error("usage: DATABASE_URL=postgres://... npm run tenant:export -- <organization_id> > export.json");
    return 1;
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await exportTenant(pool, org);
    const rows = Object.values(result.tables).reduce((n, t) => n + t.length, 0);
    if (rows === 0) {
      console.error(`[oathrion:tenant-export] organization "${org}" owns no rows; refusing to write an empty export.`);
      return 1;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    console.error(`[oathrion:tenant-export] ${org}: ${rows} rows from ${Object.keys(result.tables).length} tables; redacted: ${result.redactedColumns.join(", ") || "none"}`);
    return 0;
  } finally {
    await pool.end();
  }
}

main().then((c) => process.exit(c), (e) => { console.error(`[oathrion:tenant-export] failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
