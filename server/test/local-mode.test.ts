/**
 * LE MODE LOCAL (`server/local-mode.ts`) — `oathrion wrap`, étape E3.
 *
 * La règle de `database-config.ts` — « No environment variable can opt SQLite into
 * production » — doit rester vraie. Le mode local ne s'ouvre donc que par un point
 * d'entrée distinct, compilé dans son propre fichier. Ce fichier vérifie :
 *
 *   · que `enterLocalMode` n'est appelé QUE par `local-entry.ts`, et que rien dans le
 *     serveur n'importe `local-entry.ts` (le paquet serveur ne peut donc pas basculer) ;
 *   · que hors mode local, SQLite en production reste refusé, quelle que soit la variable ;
 *   · qu'en mode local, SQLite est accepté — et seulement SQLite — et que l'écoute hors de
 *     la boucle locale est refusée au démarrage.
 *
 * L'ordre des tests compte : le drapeau ne se baisse pas, donc les refus hors mode local
 * passent d'abord. Chaque fichier de test a ses propres modules, le drapeau ne fuit pas.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveHost } from "../config-check";
import { DatabaseConfigError, validateProductionConfiguration } from "../database-config";
import { enterLocalMode, isLocalMode } from "../local-mode";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function serverSources(directory: string = SERVER_DIR): { file: string; source: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "node_modules" ? [] : serverSources(full);
    return entry.name.endsWith(".ts") ? [{ file: full.slice(SERVER_DIR.length + 1), source: readFileSync(full, "utf8") }] : [];
  });
}

const PRODUCTION_SQLITE = { NODE_ENV: "production", DATABASE_DRIVER: "sqlite", OATHRION_IDENTITY_PLANE: "sqlite" };

describe("le mode local ne s'ouvre que par son point d'entrée", () => {
  it("enterLocalMode n'est appelé que par local-entry.ts", () => {
    const callers = serverSources()
      .filter(({ file, source }) => file !== "local-mode.ts" && /enterLocalMode\s*\(/.test(source))
      .map(({ file }) => file);
    expect(callers).toEqual(["local-entry.ts"]);
  });

  it("aucun module du serveur n'importe local-entry.ts", () => {
    const importers = serverSources().filter(({ source }) => /from\s+["'][^"']*local-entry["']|import\(["'][^"']*local-entry["']\)/.test(source));
    expect(importers.map(({ file }) => file)).toEqual([]);
  });

  it("le paquet serveur est construit depuis index.ts, le mode local depuis son propre fichier", () => {
    const build = readFileSync(join(SERVER_DIR, "..", "script", "build.ts"), "utf8");
    expect(build).toMatch(/entryPoints: \["server\/index\.ts"\][\s\S]*outfile: "dist\/index\.cjs"/);
    expect(build).toMatch(/entryPoints: \["server\/local-entry\.ts"\][\s\S]*outfile: "dist\/oathrion-local\.cjs"/);
  });
});

describe("hors mode local, rien ne change", () => {
  it("SQLite en production reste refusé", () => {
    expect(isLocalMode()).toBe(false);
    expect(() => validateProductionConfiguration(PRODUCTION_SQLITE)).toThrow(DatabaseConfigError);
  });

  it("une adresse d'écoute réseau reste acceptée (l'image Docker en a besoin)", () => {
    expect(resolveHost("0.0.0.0")).toBe("0.0.0.0");
  });
});

describe("en mode local", () => {
  it("SQLite est accepté en production, pour les données et l'identité", () => {
    enterLocalMode();
    expect(validateProductionConfiguration(PRODUCTION_SQLITE)).toMatchObject({ database: { driver: "sqlite" }, identityPlane: "sqlite" });
  });

  it("… et seulement SQLite : viser PostgreSQL n'est plus un mode local", () => {
    expect(() =>
      validateProductionConfiguration({
        NODE_ENV: "production",
        DATABASE_DRIVER: "postgres",
        DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x",
        OATHRION_IDENTITY_PLANE: "postgres",
        OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
        RATE_LIMIT_STORE: "postgres",
      }),
    ).toThrow(/only uses SQLite/);
  });

  it("l'écoute hors de la boucle locale est refusée au démarrage", () => {
    expect(() => resolveHost("0.0.0.0")).toThrow(/loopback/);
    expect(() => resolveHost("192.168.1.10")).toThrow(/loopback/);
    expect(resolveHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveHost("::1")).toBe("::1");
  });
});
