/**
 * Le sauvetage (`cli/wrap/impact.ts`) : ce qu'une suppression bloquée aurait effacé, mesuré
 * sans suivre les liens, borné, et dit sans arrondir.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeImpact, measure } from "./impact";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "oathrion-impact-"));
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "a", "un.txt"), "12345");
  writeFileSync(join(root, "a", "b", "deux.txt"), "1234567890");
  const elsewhere = mkdtempSync(join(tmpdir(), "oathrion-ailleurs-"));
  writeFileSync(join(elsewhere, "gros.bin"), Buffer.alloc(4096));
  symlinkSync(elsewhere, join(root, "lien"));
  return root;
}

describe("ce qu'une suppression aurait effacé", () => {
  it("compte les fichiers et leur taille ; un lien est un fichier, son contenu n'est pas suivi", () => {
    const root = tree();
    const impact = measure([root])!;
    expect(impact.files).toBe(3);
    expect(impact.truncated).toBe(false);
    expect(impact.bytes).toBeLessThan(4096);
  });

  it("borné : il le dit, sans arrondir", () => {
    const impact = measure([tree()], { maxEntries: 2 })!;
    expect(impact.truncated).toBe(true);
    expect(describeImpact({ files: 200_000, bytes: 3.2 * 1024 ** 3, truncated: true })).toBe("more than 200,000 files (over 3.2 GB)");
  });

  it("un chemin qui n'existe pas : rien à dire", () => {
    expect(measure([join(tmpdir(), "oathrion-absent-xyz")])).toBeNull();
    expect(describeImpact({ files: 1, bytes: 5, truncated: false })).toBe("1 file (5 bytes)");
  });
});
