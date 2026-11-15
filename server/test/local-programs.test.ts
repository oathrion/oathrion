/**
 * Les programmes que le pivot connaît (`server/local-programs.ts`) : un programme jamais vu
 * attend une personne ; un autre programme qui prend le même nom reste un autre programme ; une
 * mise à jour au même endroit reste connue ; un programme bloqué le reste.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalPrograms, describeIdentity, parseIdentity, type ProgramIdentity } from "../local-programs";

const claude: ProgramIdentity = { exe: "/home/awa/.local/share/claude/claude.exe", script: null, sha256: "a".repeat(64), platform: "linux" };
const impostor: ProgramIdentity = { exe: "/tmp/x/claude", script: null, sha256: "b".repeat(64), platform: "linux" };

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS;
  delete process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS;
  else process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS = saved;
});

describe("les programmes que le pivot connaît", () => {
  it("jamais vu : en attente ; confirmé : admis ; bloqué : le reste, même confirmé d'avance", () => {
    const programs = new LocalPrograms(mkdtempSync(join(tmpdir(), "oathrion-programs-")));
    const first = programs.observe("Claude Code", claude);
    expect(first.status).toBe("pending");
    expect(programs.decide(first.id, "trusted", "Awa")).toMatchObject({ status: "trusted", decidedBy: "Awa" });
    expect(programs.observe("Claude Code", claude).status).toBe("trusted");

    const other = programs.observe("Cursor", impostor);
    programs.decide(other.id, "blocked", "Awa");
    expect(programs.trust("Cursor", impostor, "npx oathrion").status).toBe("blocked");
  });

  it("un autre programme qui se dit « Claude Code » est un autre programme, et attend", () => {
    const programs = new LocalPrograms(mkdtempSync(join(tmpdir(), "oathrion-programs-")));
    programs.trust("Claude Code", claude, "npx oathrion");
    const spoof = programs.observe("Claude Code", impostor);
    expect(spoof.status).toBe("pending");
    expect(describeIdentity(spoof)).toBe('/tmp/x/claude — it says it is "Claude Code"');
  });

  it("une mise à jour au même endroit reste connue, et l'ancienne empreinte est gardée", () => {
    const programs = new LocalPrograms(mkdtempSync(join(tmpdir(), "oathrion-programs-")));
    programs.trust("Claude Code", claude, "npx oathrion");
    const updated = programs.observe("Claude Code", { ...claude, sha256: "c".repeat(64) });
    expect(updated).toMatchObject({ status: "trusted", previousSha256: ["a".repeat(64)] });
  });

  it("une identité mal formée n'est pas une identité", () => {
    expect(parseIdentity({ exe: "/bin/x", sha256: "nope" })).toBeNull();
    expect(parseIdentity("x")).toBeNull();
    expect(parseIdentity({ exe: "/bin/x", sha256: "d".repeat(64), platform: "linux" })).toEqual({ exe: "/bin/x", script: null, sha256: "d".repeat(64), platform: "linux" });
  });
});
