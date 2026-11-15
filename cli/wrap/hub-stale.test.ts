/**
 * Un pivot plus ancien que le paquet installé (`hubIsStale`, `hub.ts`) : mettre Oathrion à jour
 * ne relance pas le pivot qui tourne, et ses nouvelles protections n'y sont pas.
 */
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hubIsStale } from "./hub";

describe("un pivot d'avant la mise à jour", () => {
  const dir = mkdtempSync(join(tmpdir(), "oathrion-pivot-"));
  const bundle = join(dir, "oathrion-local.cjs");
  const env = { OATHRION_LOCAL_BUNDLE: bundle };
  writeFileSync(bundle, "ancienne version");
  const print = (text: string, at: number) => {
    writeFileSync(bundle, text);
    utimesSync(bundle, at, at);
  };

  it("sans repère (lancé par une version d'avant ce repère) : ancien", () => {
    expect(hubIsStale(env, dir)).toBe(true);
  });

  it("le même paquet qu'à son lancement : à jour ; un paquet remplacé depuis : ancien", () => {
    print("version 1", 1_000);
    writeFileSync(join(dir, "hub-build"), "9:1000000");
    expect(hubIsStale(env, dir)).toBe(false);
    print("version 2, plus longue", 2_000);
    expect(hubIsStale(env, dir)).toBe(true);
  });

  it("pas de paquet trouvé : on ne conclut rien", () => {
    expect(hubIsStale({ OATHRION_LOCAL_BUNDLE: join(dir, "absent.cjs") }, dir)).toBe(false);
  });
});
