/**
 * Inventaire des dépendances livrées (SBOM), dérivé du lockfile.
 *
 * ## Pourquoi depuis `package-lock.json` et non depuis `node_modules`
 *
 * Le lockfile est ce que `npm ci` installe, exactement, et c'est lui qui est livré dans
 * l'archive. Un inventaire lu dans `node_modules` décrirait la machine qui l'a produit —
 * y compris des paquets installés à la main, et y compris une version résolue
 * différemment par un autre registre. Ce qui doit être auditable, c'est ce que le client
 * installera, pas ce qu'avait le développeur.
 *
 * ## Ce que ce fichier contient et ne contient pas
 *
 * Pour chaque paquet : nom, version, URL résolue, empreinte d'intégrité du registre, et
 * s'il est livré en production ou seulement en développement. L'empreinte vient du
 * lockfile : c'est celle que `npm ci` vérifie, donc un paquet substitué en amont ne
 * s'installerait pas.
 *
 * Il ne contient **pas** de licences. `package-lock.json` n'en porte pas, et les lire
 * dans `node_modules` donnerait un inventaire de licences vrai pour une installation et
 * non pour la livraison — exactement le défaut décrit plus haut. Une revue de licences
 * demande une étape dédiée, et la prétendre faite ici serait une fausse assurance : c'est
 * noté comme limite dans `docs/COMMERCIAL_READINESS.md`.
 *
 * Format : CycloneDX 1.5 minimal, en JSON. Pas de dépendance ajoutée pour le produire.
 *
 *   npm run sbom            → écrit release/sbom.json
 *   npm run sbom -- --check → échoue si le fichier est absent ou périmé
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCKFILE = path.join(ROOT, "package-lock.json");
const OUTPUT_DIR = path.join(ROOT, "release");
const OUTPUT = path.join(OUTPUT_DIR, "sbom.json");

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  link?: boolean;
}

interface Component {
  type: "library";
  name: string;
  version: string;
  purl: string;
  scope: "required" | "optional";
  properties: { name: string; value: string }[];
  hashes?: { alg: string; content: string }[];
}

/** `node_modules/a/node_modules/b` → `b`; the lockfile keys packages by install path. */
function packageName(key: string): string | null {
  const marker = "node_modules/";
  const at = key.lastIndexOf(marker);
  if (at === -1) return null;
  const name = key.slice(at + marker.length);
  return name === "" ? null : name;
}

/**
 * Converts the lockfile's `sha512-<base64>` integrity string into a CycloneDX hash.
 *
 * Returned as null when the algorithm is anything else, rather than guessed at: an
 * inventory that mislabels which algorithm produced a digest is worse than one that omits
 * the digest, because a verifier would compare the wrong thing and conclude "match".
 */
function toHash(integrity: string | undefined): { alg: string; content: string } | null {
  if (integrity === undefined) return null;
  const [algorithm, base64] = integrity.split("-", 2);
  if (algorithm !== "sha512" && algorithm !== "sha256" && algorithm !== "sha1") return null;
  if (!base64) return null;
  const alg = algorithm === "sha512" ? "SHA-512" : algorithm === "sha256" ? "SHA-256" : "SHA-1";
  return { alg, content: Buffer.from(base64, "base64").toString("hex") };
}

function build(): { document: unknown; counts: { total: number; production: number; dev: number } } {
  const lock = JSON.parse(readFileSync(LOCKFILE, "utf8")) as {
    name?: string;
    version?: string;
    packages?: Record<string, LockEntry>;
  };
  const packages = lock.packages ?? {};

  const components: Component[] = [];
  let production = 0;
  let dev = 0;

  for (const [key, entry] of Object.entries(packages)) {
    // The root project is keyed by "" and is the subject, not a component of itself.
    if (key === "") continue;
    // A workspace link points at local source already inside the archive.
    if (entry.link === true) continue;
    const name = packageName(key);
    if (name === null || entry.version === undefined) continue;

    const isDev = entry.dev === true;
    if (isDev) dev += 1;
    else production += 1;

    const hash = toHash(entry.integrity);
    components.push({
      type: "library",
      name,
      version: entry.version,
      purl: `pkg:npm/${name.replace("@", "%40")}@${entry.version}`,
      scope: entry.optional === true ? "optional" : "required",
      properties: [
        // The honest field: whether this package reaches a production install at all.
        { name: "placet:shipped", value: isDev ? "development-only" : "production" },
        ...(entry.resolved === undefined ? [] : [{ name: "placet:resolved", value: entry.resolved }]),
      ],
      ...(hash === null ? {} : { hashes: [hash] }),
    });
  }

  components.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));

  /*
   * The lockfile's own digest is recorded in the document. It is what makes this
   * inventory falsifiable: regenerate it from a lockfile with a different digest and the
   * two disagree, which is exactly what `--check` reports.
   */
  const lockDigest = crypto.createHash("sha256").update(readFileSync(LOCKFILE)).digest("hex");

  return {
    document: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        // No timestamp on purpose: it would change the digest on every run and make the
        // `--check` below report drift that is not drift.
        component: {
          type: "application",
          name: lock.name ?? "placet",
          version: lock.version ?? "0.0.0",
        },
        properties: [
          { name: "placet:source", value: "package-lock.json" },
          { name: "placet:lockfileSha256", value: lockDigest },
          { name: "placet:licences", value: "non inventoriées — voir docs/COMMERCIAL_READINESS.md" },
        ],
      },
      components,
    },
    counts: { total: components.length, production, dev },
  };
}

const { document, counts } = build();
const serialised = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (!existsSync(OUTPUT)) {
    console.error(
      `\n[sbom] release/sbom.json est absent. L'inventaire des dépendances fait partie de la ` +
        `livraison : lancez \`npm run sbom\`.`,
    );
    process.exit(1);
  }
  const onDisk = readFileSync(OUTPUT, "utf8");
  if (onDisk !== serialised) {
    console.error(
      `\n[sbom] release/sbom.json ne correspond plus à package-lock.json.\n` +
        `  Une dépendance a changé sans que l'inventaire soit régénéré. Lancez \`npm run sbom\`.`,
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[sbom] à jour — ${counts.total} paquets (${counts.production} en production).`);
  process.exit(0);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT, serialised);
const digest = crypto.createHash("sha256").update(serialised).digest("hex");

// eslint-disable-next-line no-console
console.log(
  [
    "",
    "[sbom] inventaire des dépendances écrit",
    "",
    `  fichier     release/sbom.json`,
    `  paquets     ${counts.total}  (${counts.production} en production, ${counts.dev} développement)`,
    `  format      CycloneDX 1.5`,
    `  sha256      ${digest}`,
    "",
    "  Les licences ne sont PAS inventoriées ici : le lockfile n'en porte pas.",
    "  Une revue de licences est une étape distincte, documentée comme telle.",
    "",
  ].join("\n"),
);
