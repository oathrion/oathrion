/**
 * LE SAUVETAGE — ce qu'une suppression bloquée AURAIT effacé (priorité du 6 novembre : faire du
 * reçu un moment « waouh »). « Refusé : rm -rf ~ » se lit et s'oublie ; « aurait supprimé
 * 48 312 fichiers (3,2 Go) » se raconte.
 *
 * Mesuré au moment du refus, sur les chemins que la commande visait, en LECTURE seule : jamais un
 * lien suivi (un lien est compté comme un fichier, son contenu non), et borné — en nombre
 * d'entrées comme en temps — pour ne jamais ralentir Claude Code. Borné, le compte le dit
 * (« plus de 200 000 fichiers ») plutôt que d'arrondir.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Impact {
  files: number;
  bytes: number;
  /** La mesure s'est arrêtée à sa borne : il y en a au moins autant. */
  truncated: boolean;
}

export function measure(paths: readonly string[], limits: { maxEntries?: number; maxMs?: number; now?: () => number } = {}): Impact | null {
  const maxEntries = limits.maxEntries ?? 200_000;
  const now = limits.now ?? Date.now;
  const deadline = now() + (limits.maxMs ?? 1_500);
  const impact: Impact = { files: 0, bytes: 0, truncated: false };
  let seen = 0;
  let found = false;
  const stack = [...new Set(paths)];
  while (stack.length > 0) {
    if (seen >= maxEntries || now() > deadline) {
      impact.truncated = true;
      break;
    }
    const path = stack.pop()!;
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    found = true;
    seen += 1;
    if (stat.isDirectory()) {
      try {
        for (const name of readdirSync(path)) stack.push(join(path, name));
      } catch {
        /* illisible : on n'en dit rien de plus */
      }
    } else {
      impact.files += 1;
      impact.bytes += stat.size;
    }
  }
  return found ? impact : null;
}

/** « 48,312 files (3.2 GB) » ; « more than 200,000 files » quand la mesure s'est arrêtée à sa borne. */
export function describeImpact(impact: Impact): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let size = impact.bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const amount = unit === 0 ? `${String(size)} bytes` : `${size.toFixed(1)} ${units[unit]!}`;
  const files = `${impact.files.toLocaleString("en-US")} file${impact.files === 1 ? "" : "s"}`;
  return impact.truncated ? `more than ${files} (over ${amount})` : `${files} (${amount})`;
}
