/**
 * `oathrion receipt report` : la période demandée au pivot, le rapport écrit dans un fichier ;
 * puis `oathrion receipt verify` sur ce fichier.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { signDocument, signingKey } from "@shared/receipt-share";

import { reportStatement } from "../../server/local-report";
import { runReceipt } from "./receipts";
import { runReport } from "./report";

function signedReport(dir: string) {
  const key = signingKey(join(dir, "cle"));
  return signDocument(
    reportStatement({
      entries: [
        { at: "2026-11-10T10:00:00.000Z", source: "claude-code", agent: "Claude Code", action: "npm test", target: "shell:///w", outcome: "done", detail: null, ref: "t1" },
        { at: "2026-11-11T10:00:00.000Z", source: "claude-code", agent: "Claude Code", action: "rm -rf ~", target: "shell:///w", outcome: "refused", detail: "rule rm-outside-project", ref: "t2", impact: "49 files (3.1 MB)" },
      ],
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-30T00:00:00.000Z",
      subject: "Awa's team",
      home: "/home/awa",
      countsOnly: false,
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

describe("oathrion receipt report", () => {
  const now = () => new Date("2026-11-30T00:00:00.000Z");

  it("par défaut les 30 derniers jours ; écrit le rapport, et dit que rien n'est parti", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oathrion-rapport-cli-"));
    const report = signedReport(cwd);
    const asked: Record<string, unknown>[] = [];
    const io = capture();
    const code = await runReport([], { ...io, cwd, env: {}, now, hub: async () => ({ op: async <T>(body: Record<string, unknown>) => (asked.push(body), { status: 200, body: report as T }) }) });
    expect(code).toBe(0);
    expect(asked[0]).toEqual({ op: "report", since: "2026-10-31T00:00:00.000Z", until: "2026-11-30T00:00:00.000Z", subject: null, countsOnly: false });
    const file = join(cwd, "oathrion-report-2026-11-01-to-2026-11-30.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(report);
    expect(io.text()).toMatch(/Oathrion report for Awa's team, 2026-11-01 to 2026-11-30/);
    expect(io.text()).toMatch(/2 action\(s\) · 1 went through · 0 asked a person .* · 1 blocked/);
    expect(io.text()).toMatch(/✋ rm -rf ~ — would have deleted 49 files/);
    expect(io.text()).toMatch(/Nothing was sent/);
  });

  it("--since, --until, --for, --counts-only, --out passent au pivot", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oathrion-rapport-cli-"));
    const asked: Record<string, unknown>[] = [];
    const io = capture();
    const hub = async () => ({ op: async <T>(body: Record<string, unknown>) => (asked.push(body), { status: 200, body: signedReport(cwd) as T }) });
    expect(await runReport(["--since", "2026-11-01", "--until", "2026-11-15", "--for", "Acme", "--counts-only", "--out", "acme.json"], { ...io, cwd, env: {}, now, hub })).toBe(0);
    expect(asked[0]).toEqual({ op: "report", since: "2026-11-01T00:00:00.000Z", until: "2026-11-15T00:00:00.000Z", subject: "Acme", countsOnly: true });
    expect(readFileSync(join(cwd, "acme.json"), "utf8")).toMatch(/oathrion\.report\/v0/);
    expect(await runReport(["--days", "7"], { ...io, cwd, env: {}, now, hub })).toBe(0);
    expect(asked[1]).toMatchObject({ since: "2026-11-23T00:00:00.000Z" });
  });

  it("des options fausses : un message clair, le pivot n'est pas appelé", async () => {
    const io = capture();
    const hub = async () => {
      throw new Error("ne doit pas être appelé");
    };
    const base = { ...io, cwd: "/", env: {}, now, hub };
    expect(await runReport(["--days", "0"], base)).toBe(3);
    expect(await runReport(["--days", "7", "--since", "2026-11-01"], base)).toBe(3);
    expect(await runReport(["--since", "2026-11-20", "--until", "2026-11-01"], base)).toBe(3);
    expect(await runReport(["--since", "hier"], base)).toBe(3);
    expect(await runReport(["--envoie"], base)).toBe(3);
    expect(io.text()).not.toMatch(/ne doit pas/);
  });

  it("le pivot injoignable ou qui refuse : 4", async () => {
    const io = capture();
    expect(await runReport([], { ...io, cwd: "/", env: {}, now, hub: async () => ({ op: async <T>() => ({ status: 400, body: null as T | null }) }) })).toBe(4);
    expect(io.lines.at(-1)).toMatch(/refused the report \(400\)/);
  });
});

describe("oathrion receipt verify, un rapport", () => {
  const write = (alter: (json: string) => string = (j) => j) => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-rapport-verif-"));
    const report = signedReport(dir);
    const path = join(dir, "rapport.json");
    writeFileSync(path, alter(JSON.stringify(report, null, 2)));
    return { path, fingerprint: report.statement.issuer.fingerprint };
  };

  it("intact : 0, ce qu'il dit, et l'empreinte", () => {
    const { path, fingerprint } = write();
    const io = capture();
    expect(runReceipt(["verify", path], io.out, io.err)).toBe(0);
    expect(io.lines[0]).toBe("✓ Verified report: not a single character has changed since it was signed.");
    expect(io.text()).toMatch(/1 blocked/);
    expect(io.text()).toContain(fingerprint);
  });

  it("un nombre réécrit : 1, et son contenu n'est pas montré", () => {
    const { path } = write((json) => json.replace('"blocked": 1', '"blocked": 0'));
    const io = capture();
    expect(runReceipt(["verify", path], io.out, io.err)).toBe(1);
    expect(io.lines[0]).toMatch(/^✗ NOT VALID: .*not shown/);
    expect(io.text()).not.toMatch(/Awa's team/);
  });

  it("empreintes épinglées : une autre échoue", () => {
    const { path, fingerprint } = write();
    const io = capture();
    expect(runReceipt(["verify", path], io.out, io.err, { env: { OATHRION_TRUSTED_FINGERPRINTS: fingerprint } })).toBe(0);
    expect(runReceipt(["verify", path], io.out, io.err, { env: { OATHRION_TRUSTED_FINGERPRINTS: "ffff0000" } })).toBe(1);
    expect(io.text()).toMatch(/not in OATHRION_TRUSTED_FINGERPRINTS/);
  });
});
