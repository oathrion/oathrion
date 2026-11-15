/**
 * LE FIL-PIÈGE (`server/local-tripwire.ts`) : sur des fichiers temporaires de ce test, jamais
 * de vrais leurres. Armé sans bruit ; une lecture se voit au balayage suivant, une fois ; réarmé,
 * la lecture suivante se voit aussi ; un fichier retiré ne casse rien.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { arm, Tripwire, wasRead } from "../local-tripwire";

const dir = mkdtempSync(join(tmpdir(), "oathrion-piege-"));
const trap = (name: string) => {
  const path = join(dir, name);
  writeFileSync(path, "faux secret\n");
  return path;
};

describe("armer un fichier", () => {
  it("sa date d'accès passe sous sa date de modification, qui ne bouge pas ; une lecture le trahit", () => {
    const path = trap("a");
    const mtime = statSync(path).mtimeMs;
    arm(path);
    expect(wasRead(path)).toBe(false);
    expect(Math.abs(statSync(path).mtimeMs - mtime)).toBeLessThan(1);
    readFileSync(path);
    expect(wasRead(path)).toBe(true);
  });
});

describe("le fil-piège", () => {
  it("armé sans bruit ; une lecture, une alerte ; réarmé, la suivante aussi ; retiré, rien", () => {
    const one = trap("b");
    const two = trap("c");
    let files = [one, two];
    const seen: string[] = [];
    const wire = new Tripwire({ files: () => files, onTrip: (e) => seen.push(e.path), now: () => new Date("2026-11-10T23:00:00Z") });

    wire.check();
    expect(seen).toEqual([]);
    wire.check();
    expect(seen).toEqual([]);

    readFileSync(one);
    wire.check();
    expect(seen).toEqual([one]);
    wire.check();
    expect(seen).toEqual([one]);

    readFileSync(one);
    readFileSync(two);
    wire.check();
    expect(seen).toEqual([one, one, two]);
    expect(wire.events().map((e) => e.path)).toEqual([two, one, one]);

    rmSync(two);
    files = [one];
    expect(() => wire.check()).not.toThrow();
  });
});
