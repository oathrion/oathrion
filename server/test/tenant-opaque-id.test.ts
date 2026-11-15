/**
 * Chantier 1 — l'identifiant d'un locataire cesse d'être dérivé de son nom.
 *
 * Jusqu'à la migration 18, `organizationIdFromName` fabriquait l'identifiant depuis le
 * nom : « Acme Corp » → `org_acme_corp`. Trois défauts, tous dans le produit livré :
 * l'identifiant divulguait le nom du client dans chaque ligne de journal, d'audit et de
 * reçu ; deux raisons sociales proches collisionnaient après troncature, transformant
 * une erreur de clé primaire en oracle d'existence inter-tenant ; et un changement de
 * raison sociale ne pouvait pas être reflété.
 *
 * Ces tests épinglent ce que la correction doit valoir, sur SQLite ici et sur PostgreSQL
 * dans `tenant-opaque-id-postgres.test.ts` :
 *
 *   - un identifiant neuf est opaque, et ne contient rien du nom ;
 *   - le même nom retrouve le même locataire, sans en créer un second — l'idempotence
 *     que la dérivation offrait gratuitement et qui vient maintenant d'une recherche ;
 *   - un nom qui ne peut pas être une clé est refusé à l'écriture, avec une raison
 *     nommée, et ne peut pas atteindre la table même par un INSERT direct ;
 *   - un nom déjà détenu par une AUTRE organisation est refusé, et surtout : l'appelant
 *     ne reçoit jamais l'organisation qui détient ce nom à la place de la sienne ;
 *   - un seul fichier du dépôt sait fabriquer un identifiant d'organisation.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  InvalidOrganizationName,
  organizationStore,
} from "../repositories/organizations";
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  organizationId,
  organizationNameKey,
  organizationNameProblem,
} from "@shared/tenancy";
import { rawDb } from "../db";

/** Les organisations créées par un test, retirées après lui. */
const created: string[] = [];

function uniqueName(prefix: string): string {
  const name = `${prefix} ${Math.random().toString(36).slice(2, 10)}`;
  created.push(organizationNameKey(name));
  return name;
}

afterEach(() => {
  for (const key of created.splice(0)) {
    rawDb.prepare(`DELETE FROM organizations WHERE name_key = ?`).run(key);
  }
});

/** La ligne telle qu'elle est réellement stockée, pour vérifier `name_key`. */
function rowOf(id: string): { id: string; name: string; name_key: string } | undefined {
  return rawDb.prepare(`SELECT id, name, name_key FROM organizations WHERE id = ?`).get(id) as
    | { id: string; name: string; name_key: string }
    | undefined;
}

describe("un identifiant d'organisation neuf", () => {
  it("est opaque, de la forme attendue, et ne contient rien du nom", () => {
    const name = uniqueName("Alpha Industries");
    const org = organizationStore.ensureByName(name);

    expect(org.id).toMatch(/^org_[a-z0-9]{20}$/);
    expect(org.id).not.toContain("alpha");
    expect(org.id).not.toContain("industries");
    // Ni tiret ni soulignement après le préfixe : un identifiant ne doit pas pouvoir
    // RESSEMBLER au slug d'un nom, sinon un lecteur se demande ce que les séparateurs
    // voulaient dire.
    expect(org.id.slice(4)).not.toMatch(/[-_]/);
    expect(org.name).toBe(name);
  });

  it("diffère à chaque création, même pour deux noms voisins", () => {
    const first = organizationStore.ensureByName(uniqueName("Banque Atlantique CI"));
    const second = organizationStore.ensureByName(uniqueName("Banque Atlantique CM"));
    expect(first.id).not.toBe(second.id);
  });

  it("n'est jamais réécrit pour une organisation existante", () => {
    const name = uniqueName("Heritage Corp");
    const first = organizationStore.ensureByName(name);
    const again = organizationStore.ensureByName(name);
    /*
     * La propriété qui compte le plus de ce fichier. Un identifiant est référencé par
     * sept tables ET par la chaîne d'audit, en ajout seul et à falsification détectable :
     * le réécrire
     * reviendrait à réécrire des lignes d'audit.
     */
    expect(again.id).toBe(first.id);
    expect(again.createdAt).toBe(first.createdAt);
  });
});

describe("le nom est la clé de recherche", () => {
  it("retrouve le même locataire sans en créer un second", () => {
    const name = uniqueName("Idempotent SA");
    const before = organizationStore.list().length;
    const a = organizationStore.ensureByName(name);
    const b = organizationStore.ensureByName(name);
    expect(b.id).toBe(a.id);
    expect(organizationStore.list().length).toBe(before + 1);
  });

  it("ignore la casse et les espaces de bord — c'est ce que l'exploitant tape", () => {
    const name = uniqueName("Casse Variable");
    const canonical = organizationStore.ensureByName(name);
    expect(organizationStore.ensureByName(name.toUpperCase()).id).toBe(canonical.id);
    expect(organizationStore.ensureByName(`  ${name}  `).id).toBe(canonical.id);
    expect(organizationStore.findByName(name.toLowerCase())?.id).toBe(canonical.id);
  });

  it("traite deux espaces internes comme un AUTRE nom — la limite assumée", () => {
    /*
     * La normalisation est volontairement limitée aux minuscules et aux bords, parce que
     * le backfill SQL de la migration 18 doit appliquer la règle identique sur les deux
     * moteurs (`lower` et `trim` existent partout, `regexp_replace` non). Le prix est
     * ici, visible et testé, plutôt que découvert par un exploitant.
     */
    const single = uniqueName("Espace Simple");
    const double = single.replace(" ", "  ");
    created.push(organizationNameKey(double));
    expect(organizationStore.ensureByName(single).id).not.toBe(
      organizationStore.ensureByName(double).id,
    );
  });

  it("est stocké normalisé, et la base est d'accord avec le TypeScript", () => {
    const name = uniqueName("  Normalisation SARL  ");
    const org = organizationStore.ensureByName(name);
    const row = rowOf(org.id);
    // Le backfill de la migration 18 écrit `lower(trim(name))` en SQL ; ce test vérifie
    // que la fonction TypeScript et le SQL ne peuvent pas avoir divergé.
    expect(row?.name_key).toBe(organizationNameKey(name));
    expect(row?.name_key).toBe(name.trim().toLowerCase());
  });
});

describe("un nom qui ne peut pas être une clé", () => {
  const refused: [string, unknown][] = [
    ["vide", ""],
    ["espaces seulement", "   "],
    ["pas une chaîne", 42],
    ["trop long", "x".repeat(MAX_ORGANIZATION_NAME_LENGTH + 1)],
  ];

  for (const [label, value] of refused) {
    it(`est refusé avec une raison nommée, et rien n'est écrit : ${label}`, () => {
      expect(organizationNameProblem(value)).not.toBeNull();
      const before = organizationStore.list().length;
      expect(() => organizationStore.ensureByName(value as string)).toThrow(InvalidOrganizationName);
      expect(organizationStore.list().length).toBe(before);
    });
  }

  it("est refusé aussi par `ensure`, qui reçoit un identifiant choisi", () => {
    expect(() => organizationStore.ensure(organizationId("org_explicit_name_test"), "  ")).toThrow(
      InvalidOrganizationName,
    );
  });
});

describe("deux organisations ne peuvent pas porter le même nom", () => {
  it("refuse la seconde en nommant celle qui détient le nom, et ne rend jamais la sienne", () => {
    const name = uniqueName("Collision Ltd");
    const holder = organizationStore.ensureByName(name);

    let error: unknown;
    try {
      organizationStore.ensure(organizationId("org_collision_attempt"), name);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidOrganizationName);
    // Le message doit nommer le détenteur : le conflit n'est pas là où l'appelant croit.
    expect(String(error)).toContain(holder.id);
    /*
     * Et surtout : l'appelant n'a PAS reçu l'organisation qui détient le nom. Rendre
     * `holder` ici aurait cadré l'appelant sur le locataire d'un autre — le seul échec
     * que ce fichier existe pour empêcher.
     */
    expect(organizationStore.find(organizationId("org_collision_attempt"))).toBeNull();
  });

  it("est refusé par la base elle-même, pas seulement par l'application (index UNIQUE)", () => {
    const name = uniqueName("Index Unique SA");
    organizationStore.ensureByName(name);
    expect(() =>
      rawDb
        .prepare(
          `INSERT INTO organizations (id, name, name_key, created_at, active, currency)
             VALUES (?, ?, ?, ?, true, ?)`,
        )
        .run("org_direct_insert_bypass", name, organizationNameKey(name), new Date().toISOString(), "EUR"),
    ).toThrow();
    expect(organizationStore.find(organizationId("org_direct_insert_bypass"))).toBeNull();
  });
});

describe("un seul fichier sait fabriquer un identifiant d'organisation", () => {
  /*
   * Le test « single path » qui remplace `organizationIdFromName`. Tant qu'une deuxième
   * fonction peut produire un identifiant de locataire, il existe un deuxième endroit où
   * la règle peut être affaiblie — et c'est la plus faible des deux définitions qui
   * cadrerait une requête. Même motif que `agent-binding-single-path.test.ts` et
   * `currency-single-path.test.ts`.
   */
  const ROOT = join(import.meta.dirname, "..", "..");
  const MINTER = join("server", "repositories", "organizations.ts");

  /*
   * La seule exception, nommée plutôt que tolérée par un motif large.
   *
   * `script/bench-daily-spend.ts` crée ses PROPRES tables dans une base jetable et y
   * écrit des `org_0`, `org_1`… synthétiques pour mesurer des plans de requête. Il
   * n'atteint jamais le registre, ne crée aucun locataire, et son résultat n'est pas du
   * code livré. L'exclure par son nom garde au test toute sa valeur sur les chemins qui,
   * eux, créent de vraies organisations — y compris les harnais de `script/`.
   */
  const ALLOWED = new Set([MINTER, join("script", "bench-daily-spend.ts")]);

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const relative = join(dir, entry);
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      if (statSync(join(ROOT, relative)).isDirectory()) sources(relative, out);
      else if (/\.tsx?$/.test(entry)) out.push(relative);
    }
    return out;
  }

  const files = ["server", "shared", "client", "script", "cli", "sdk", "examples"]
    .flatMap((dir) => sources(dir))
    .map((relative) => ({ relative, text: readFileSync(join(ROOT, relative), "utf8") }));

  it("voit bien les fichiers qu'il inspecte (le balayage n'est pas vide)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.relative === MINTER)).toBe(true);
  });

  it("ne laisse aucun fichier construire un identifiant par concaténation de `org_`", () => {
    /*
     * Cherche une fabrication : un littéral `org_` suivi d'une interpolation. Les
     * constantes de test (`"org_rival_corp"`) sont des littéraux complets et ne
     * correspondent pas ; `DEFAULT_ORGANIZATION_ID` est une constante déclarée dans
     * `shared/tenancy.ts` et nommée, pas une construction.
     */
    const offenders = files
      .filter((f) => !ALLOWED.has(f.relative))
      .filter((f) => /["'`]org_\$\{|["'`]org_["'`]\s*\+/.test(f.text))
      .map((f) => f.relative);
    expect(offenders).toEqual([]);
  });

  it("n'a pas laissé revenir une dérivation depuis le nom", () => {
    /*
     * Cherche un IMPORT, pas une mention. Le nom de l'ancienne fonction apparaît
     * volontairement dans plusieurs commentaires — celui de la migration 18, celui du
     * store, celui d'`auth.ts` — parce qu'expliquer ce qui a été retiré et pourquoi est
     * la moitié utile du changement. Ce qui doit être impossible, c'est de l'utiliser.
     */
    const offenders = files
      .filter((f) => /import[^;]*\borganizationIdFromName\b[^;]*from/s.test(f.text))
      .map((f) => f.relative);
    expect(offenders).toEqual([]);
  });
});
