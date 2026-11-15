/**
 * Efface une organisation de PostgreSQL — définitivement.
 *
 *   # Compter sans rien supprimer (le défaut) :
 *   DATABASE_URL=postgres://… npm run tenant:purge -- org_acme
 *
 *   # Supprimer, après avoir désactivé l'organisation :
 *   DATABASE_URL=postgres://… npm run tenant:purge -- org_acme \
 *     --confirm="Acme Corp" --by="jane@acme.test" --reason="contract ended 2026-10-01"
 *
 * Exportez AVANT (`npm run tenant:export`) si le client veut ses données : après, il
 * n'y a plus rien à exporter. La chaîne de reçus part avec le reste.
 */

import { Pool } from "pg";
import { purgeTenant, PurgeRefused } from "./lib/tenant-purge";

const USAGE = `usage:
  DATABASE_URL=postgres://… npm run tenant:purge -- <organization_id>
      counts what WOULD be deleted, deletes nothing

  DATABASE_URL=postgres://… npm run tenant:purge -- <organization_id> \\
      --confirm="<organization name>" --by="<who>" --reason="<why>"
      deletes, permanently

the organization must be INACTIVE first; the confirmation asks for the NAME,
not the identifier.`;

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  const org = process.argv[2]?.trim();
  if (!url || !org || org.startsWith("--")) {
    console.error(USAGE);
    return 1;
  }

  const confirmName = flag("confirm");
  const requestedBy = flag("by")?.trim();
  const reason = flag("reason")?.trim();

  /*
   * `--by` et `--reason` sont exigés AVEC `--confirm`, et pas seulement enregistrés
   * s'ils sont fournis. Un effacement sans demandeur ni motif est indéfendable six mois
   * plus tard, et c'est précisément le moment où on le relit.
   */
  if (confirmName !== undefined && (!requestedBy || !reason)) {
    console.error("[oathrion:tenant-purge] --confirm also requires --by and --reason.");
    return 1;
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await purgeTenant(pool, org, {
      confirmName,
      requestedBy: requestedBy ?? "",
      reason: reason ?? "",
    });

    const lines = Object.entries(result.rowCounts)
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `    ${table.padEnd(24)} ${n}`)
      .join("\n");

    if (!result.erased) {
      console.error(
        `\n[oathrion:tenant-purge] DRY RUN — nothing was deleted.\n\n` +
          `  organization  ${result.organizationId} (${result.nameKey})\n` +
          `  state         ${result.active ? "ACTIVE — purge would be refused" : "inactive"}\n` +
          `  rows          ${result.totalRows}\n\n${lines}\n\n` +
          `  To delete, re-run with --confirm="<name>" --by=… --reason=…\n` +
          `  Export first if the customer wants their data: there is nothing to export after.\n`,
      );
      return 0;
    }

    console.error(
      `\n[oathrion:tenant-purge] ERASED ${result.organizationId} — ${result.totalRows} rows.\n\n${lines}\n\n` +
        `  erasure record ${result.erasureId}\n` +
        `  The record keeps the counts and nothing else. The data is gone.\n`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    const refused = error instanceof PurgeRefused;
    console.error(
      `[oathrion:tenant-purge] ${refused ? "refused" : "failed"}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
