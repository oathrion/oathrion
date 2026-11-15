/**
 * `oathrion receipt verify <fichier>` : la vérification indépendante d'un reçu partagé.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BUNDLE_TYPE, RECEIPT_TYPE, signDocument, signingKey, signStatement } from "@shared/receipt-share";

import { receiptHtml } from "../../server/receipt-share-html";
import { runReceipt } from "./receipts";

function file(alter?: (html: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "oathrion-recu-"));
  const key = signingKey(dir);
  const shared = signStatement(
    {
      type: RECEIPT_TYPE,
      issuedAt: "2026-11-06T10:00:00.000Z",
      issuer: { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint },
      action: { at: "2026-11-06T09:59:00.000Z", agent: "Cursor", via: "Through Oathrion", what: "mcp.files.write_file", target: "mcp://files/write_file", outcome: "approved-done", outcomeLabel: "Approved by a person, done", detail: null, impact: null, ref: "exe_1" },
      evidence: { chain: "Oathrion's chained record of this execution", entries: [], chainIntact: true, chainEntries: 3, chainHead: null },
    },
    key.privateKey,
  );
  const path = join(dir, "oathrion-receipt-exe_1.html");
  writeFileSync(path, (alter ?? ((h) => h))(receiptHtml(shared)));
  return { path, fingerprint: key.fingerprint };
}

describe("oathrion receipt verify", () => {
  it("intact : 0, et l'empreinte à comparer", () => {
    const { path, fingerprint } = file();
    const lines: string[] = [];
    expect(runReceipt(["verify", path], (l) => lines.push(l), (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toMatch(/^✓ Verified/);
    expect(lines.join("\n")).toContain(`Fingerprint: ${fingerprint}`);
  });

  it("plusieurs fichiers : chacun vérifié ; un absent le dit clairement ; le pire code l'emporte", () => {
    const good = file().path;
    const bad = file((html) => html.replace("Approved by a person, done", "Done")).path;
    const lines: string[] = [];
    expect(runReceipt(["verify", good, bad], (l) => lines.push(l), (l) => lines.push(l))).toBe(1);
    expect(lines.filter((l) => /^✓ Verified|^✗ NOT VALID/.test(l))).toHaveLength(2);
    const missing: string[] = [];
    expect(runReceipt(["verify", "/nulle-part/recu.html"], (l) => missing.push(l), (l) => missing.push(l))).toBe(3);
    expect(missing[0]).toBe("No file here: /nulle-part/recu.html. Download a receipt from the console first (Activity → Receipt).");
  });

  it("une issue réécrite dans le fichier : 1, NOT VALID", () => {
    const { path } = file((html) => html.replace("Approved by a person, done", "Approved by a person, DONE"));
    const lines: string[] = [];
    expect(runReceipt(["verify", path], (l) => lines.push(l), (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toBe("✗ NOT VALID: the receipt was changed after it was signed.");
  });
});

describe("oathrion receipt verify, un paquet de branche (« no receipt, no merge »)", () => {
  function bundleFile(alter?: (json: string) => string) {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-pr-"));
    const key = signingKey(join(dir, "cle"));
    const signed = signDocument(
      {
        type: BUNDLE_TYPE,
        issuedAt: "2026-11-07T12:00:00.000Z",
        issuer: { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint },
        scope: { repository: "awa/app", branch: "feat/x", base: "abc", head: "def4567", since: "2026-11-07T09:00:00.000Z", until: "2026-11-07T12:00:00.000Z" },
        summary: { total: 3, passed: 1, asked: 1, blocked: 1, refusedByPerson: 0, waiting: 0 },
        actions: [
          { at: "2026-11-07T10:00:00.000Z", agent: "Claude Code", what: "npm test", outcome: "done", outcomeLabel: "Done", detail: null, impact: null, ref: "t1", entries: [] },
          { at: "2026-11-07T10:05:00.000Z", agent: "Claude Code", what: "git push | tee `log`", outcome: "asked-done", outcomeLabel: "Asked, then done", detail: "rule git-push", impact: null, ref: "t2", entries: [] },
          { at: "2026-11-07T10:10:00.000Z", agent: "Claude Code", what: "rm -rf ~", outcome: "refused", outcomeLabel: "Refused by Oathrion", detail: "rule rm-outside-project", impact: "49 files (3.1 MB)", ref: "t3", entries: [] },
        ],
        truncated: 0,
        evidence: { chain: "Claude Code journal kept by Oathrion's hook", intact: true, entries: 6, head: "h6" },
        limits: ["Only what Claude Code did in this repository, through Oathrion's hook."],
      },
      key.privateKey,
    );
    mkdirSync(join(dir, "receipts"));
    const path = join(dir, "receipts", "feat-x.json");
    writeFileSync(path, (alter ?? ((j) => j))(JSON.stringify(signed, null, 2)));
    return { dir, path, fingerprint: key.fingerprint };
  }
  /* Un faux git : le commit du paquet existe, fait partie de la PR, et `after` commits l'ont suivi. */
  const git = (ancestor: boolean, after = 0) => (args: string[]) => ({ code: args[0] === "merge-base" ? (ancestor ? 0 : 1) : 0, out: args[0] === "rev-list" ? String(after) : "" });
  const run = (args: string[], env: Record<string, string> = {}, gitImpl = git(true)) => {
    const lines: string[] = [];
    const code = runReceipt(args, (l) => lines.push(l), (l) => lines.push(l), { env, git: gitImpl, cwd: "/" });
    return { code, text: lines.join("\n") };
  };

  it("valide : 0 ; le résumé de la PR dit le total, ce qui a été bloqué, et l'empreinte", () => {
    const { dir } = bundleFile();
    const summary = join(dir, "summary.md");
    const { code, text } = run(["verify", join(dir, "receipts"), "--github"], { GITHUB_STEP_SUMMARY: summary }, git(true, 2));
    expect(code).toBe(0);
    expect(text).toMatch(/✓ Verified branch receipt/);
    const md = readFileSync(summary, "utf8");
    expect(md).toMatch(/### ✅ Oathrion — no receipt, no merge/);
    expect(md).toMatch(/\*\*3\*\* action\(s\) by Claude Code: 1 went through · 1 asked a person · \*\*1 blocked\*\*/);
    expect(md).toMatch(/\| ✋ \| `rm -rf ~` \| Refused by Oathrion — would have deleted 49 files/);
    expect(md).toMatch(/`git push \\\| tee ʼlogʼ`/);
    expect(md).toMatch(/\*\*2 later commit\(s\) not covered\*\*/);
    expect(md).toMatch(/not pinned/);
  });

  it("un total réécrit : 1, et la PR le dit", () => {
    const { dir } = bundleFile((json) => json.replace('"blocked": 1', '"blocked": 0'));
    const summary = join(dir, "summary.md");
    expect(run(["verify", join(dir, "receipts"), "--github"], { GITHUB_STEP_SUMMARY: summary }).code).toBe(1);
    expect(readFileSync(summary, "utf8")).toMatch(/### ❌[\s\S]*the receipt was changed after it was signed/);
  });

  it("empreintes épinglées : la sienne passe, une autre échoue", () => {
    const { path, fingerprint } = bundleFile();
    expect(run(["verify", path, "--github"], { OATHRION_TRUSTED_FINGERPRINTS: `ffff 0000, ${fingerprint.toUpperCase()}` }).code).toBe(0);
    const other = run(["verify", path, "--github"], { OATHRION_TRUSTED_FINGERPRINTS: "ffff0000ffff0000" });
    expect(other.code).toBe(1);
    expect(other.text).toMatch(/not in OATHRION_TRUSTED_FINGERPRINTS/);
  });

  it("un paquet d'une autre histoire : son commit n'est pas dans la PR, 1", () => {
    const { path } = bundleFile();
    expect(run(["verify", path, "--github"], {}, git(false)).text).toMatch(/not part of this pull request/);
  });

  it("aucun reçu : neutre par défaut, échec avec --require", () => {
    const empty = join(mkdtempSync(join(tmpdir(), "oathrion-pr-vide-")), ".oathrion", "receipts");
    expect(run(["verify", empty, "--github"]).code).toBe(0);
    expect(run(["verify", empty, "--github", "--require"]).code).toBe(1);
  });
});
