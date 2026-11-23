/**
 * `oathrion receipt passport` : l'agent et la période demandés au pivot, le passeport écrit ;
 * un agent inconnu, ceux qui existent ; puis `oathrion receipt verify` sur le fichier.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { signDocument, signingKey } from "@shared/receipt-share";

import { passportStatement } from "../../server/local-passport";
import { runPassport } from "./passport";
import { runReceipt } from "./receipts";

function signedPassport(dir: string) {
  const key = signingKey(join(dir, "cle"));
  return signDocument(
    passportStatement({
      agent: "Claude Code",
      entries: [
        { at: "2026-11-10T10:00:00.000Z", source: "claude-code", agent: "Claude Code", action: "npm test", target: "shell:///w", outcome: "done", detail: null, ref: "t1" },
        { at: "2026-11-11T10:00:00.000Z", source: "claude-code", agent: "Claude Code", action: "rm -rf ~", target: "shell:///w", outcome: "refused", detail: "rule rm-outside-project", ref: "t2", impact: "49 files (3.1 MB)" },
      ],
      programs: [],
      hookRules: { all: ["rm-outside-project", "git-push"], disabled: new Set(), extraDeny: 0, extraAsk: 0 },
      since: "2026-10-31T00:00:00.000Z",
      until: "2026-11-30T00:00:00.000Z",
      subject: "Acme",
      home: "/home/awa",
      partial: false,
      receipts: { ok: true, entries: 0, head: null },
      journal: { ok: true, entries: 4, head: "h4" },
      issuer: { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint },
      issuedAt: "2026-11-30T00:00:01.000Z",
    }),
    key.privateKey,
  );
}

const capture = () => {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), text: () => lines.join("\n") };
};
const now = () => new Date("2026-11-30T00:00:00.000Z");

describe("oathrion receipt passport", () => {
  it("demande l'agent et la période au pivot ; écrit le passeport ; rien n'est envoyé", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oathrion-passeport-cli-"));
    const passport = signedPassport(cwd);
    const asked: Record<string, unknown>[] = [];
    const io = capture();
    const hub = async () => ({ op: async <T>(body: Record<string, unknown>) => (asked.push(body), { status: 200, body: passport as T }) });
    expect(await runPassport(["--agent", "Claude Code", "--for", "Acme"], { ...io, cwd, env: {}, now, hub })).toBe(0);
    expect(asked[0]).toEqual({ op: "passport", agent: "Claude Code", since: "2026-10-31T00:00:00.000Z", until: "2026-11-30T00:00:00.000Z", subject: "Acme" });
    expect(JSON.parse(readFileSync(join(cwd, "oathrion-passport-claude-code-2026-11-30.json"), "utf8"))).toEqual(passport);
    expect(io.text()).toMatch(/Agent passport: Claude Code · Acme/);
    expect(io.text()).toMatch(/Program: not read by Oathrion/);
    expect(io.text()).toMatch(/Rules in force: 2/);
    expect(io.text()).toMatch(/✋ Last stopped: rm -rf ~ — would have deleted 49 files/);
    expect(io.text()).toMatch(/Nothing was sent/);
    expect(await runPassport([], { ...io, cwd, env: {}, now, hub })).toBe(0);
    expect(asked[1]).toMatchObject({ agent: null });
  });

  it("un agent inconnu : ceux qu'Oathrion connaît, et 3", async () => {
    const io = capture();
    const hub = async () => ({ op: async <T>() => ({ status: 404, body: { error: 'No agent named "Devin" in Oathrion\'s record.', agents: ["Claude Code", "Cursor"] } as T }) });
    expect(await runPassport(["--agent", "Devin"], { ...io, cwd: "/", env: {}, now, hub })).toBe(3);
    expect(io.text()).toMatch(/Agents Oathrion knows: "Claude Code", "Cursor"/);
  });

  it("des options fausses : 3, le pivot n'est pas appelé", async () => {
    const io = capture();
    const hub = async () => {
      throw new Error("ne doit pas être appelé");
    };
    expect(await runPassport(["--days", "-1"], { ...io, cwd: "/", env: {}, now, hub })).toBe(3);
    expect(await runPassport(["--agent"], { ...io, cwd: "/", env: {}, now, hub })).toBe(3);
  });
});

describe("oathrion receipt verify, un passeport", () => {
  const write = (alter: (json: string) => string = (j) => j) => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-passeport-verif-"));
    const path = join(dir, "passeport.json");
    writeFileSync(path, alter(JSON.stringify(signedPassport(dir), null, 2)));
    return path;
  };

  it("intact : 0, et ce qu'il dit", () => {
    const io = capture();
    expect(runReceipt(["verify", write()], io.out, io.err)).toBe(0);
    expect(io.lines[0]).toBe("✓ Verified passport: not a single character has changed since it was signed.");
    expect(io.text()).toMatch(/Agent passport: Claude Code/);
  });

  it("un nombre réécrit dans le fichier : 1, et son contenu n'est pas montré", () => {
    const io = capture();
    const path = write((json) => json.replace('"blocked": 1', '"blocked": 0'));
    expect(readFileSync(path, "utf8")).toContain('"blocked": 0');
    expect(runReceipt(["verify", path], io.out, io.err)).toBe(1);
    expect(io.lines[0]).toMatch(/^✗ NOT VALID: .*not shown/);
    expect(io.text()).not.toMatch(/Acme/);
  });
});
