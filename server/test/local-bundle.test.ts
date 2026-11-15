/**
 * Le paquet de reçus d'une branche (`server/local-bundle.ts`) : seulement ce dépôt, seulement
 * la fenêtre de la branche, aucun chemin personnel, aucun secret reconnaissable — et signé.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BUNDLE_TYPE, signDocument, signingKey, verifyShared } from "@shared/receipt-share";

import type { JournalEntry } from "../../cli/wrap/claude-journal";
import { bundleStatement, redactSecrets, relativize } from "../local-bundle";

let seq = 0;
const line = (over: Partial<JournalEntry>): JournalEntry =>
  ({ seq: (seq += 1), at: "2026-11-07T10:00:00.000Z", prev: null, hash: `h${String(seq)}`, phase: "pre", session: "s", toolUseId: `t${String(seq)}`, tool: "Bash", action: "claude.shell", target: "shell:///home/awa/app", verdict: "none", ...over }) as JournalEntry;

const scope = { repository: "awa/app", branch: "feat/x", base: "abc", head: "def", since: "2026-11-07T09:00:00.000Z", until: "2026-11-07T12:00:00.000Z" };
const build = (lines: JournalEntry[]) =>
  bundleStatement({ lines, project: "/home/awa/app", home: "/home/awa", scope, journal: { ok: true, entries: lines.length, reason: null, head: "h9" }, issuer: { name: "Oathrion local", publicKey: "k", fingerprint: "f" }, issuedAt: "2026-11-07T12:00:00.000Z" });

describe("le paquet d'une branche", () => {
  it("seulement les actions de CE dépôt, dans la fenêtre de la branche", () => {
    const bundle = build([
      line({ command: "npm test", toolUseId: "toolu_in" }),
      line({ command: "ls", target: "shell:///home/awa/autre", toolUseId: "toolu_autre" }),
      line({ command: "ls", target: "shell:///home/awa/app-copie", toolUseId: "toolu_voisin" }),
      line({ command: "old", at: "2026-11-07T08:00:00.000Z", toolUseId: "toolu_avant" }),
      line({ tool: "Write", action: "claude.file.write", target: "file:///home/awa/app/src/a.ts", toolUseId: "toolu_ecrit" }),
    ]);
    expect(bundle.type).toBe(BUNDLE_TYPE);
    expect(bundle.actions.map((a) => a.ref)).toEqual(["toolu_in", "toolu_ecrit"]);
    expect(bundle.actions[1]!.what).toBe("write ./src/a.ts");
    expect(bundle.summary).toMatchObject({ total: 2, passed: 2, blocked: 0 });
    expect(bundle.actions[0]!.entries).toEqual([{ seq: expect.any(Number), hash: expect.stringMatching(/^h/) }]);
  });

  it("une action bloquée garde sa règle et ce qu'elle aurait effacé ; aucun chemin personnel", () => {
    const [action] = build([line({ verdict: "deny", rule: "rm-outside-project", command: "rm -rf /home/awa/photos", impact: { files: 3, bytes: 3072, truncated: false } })]).actions;
    expect(action).toMatchObject({ what: "rm -rf ~/photos", outcome: "refused", outcomeLabel: "Refused by Oathrion", impact: "3 files (3.0 KB)" });
  });

  it("au-delà de la borne : les plus récentes, et le nombre écarté", () => {
    const lines = ["09:10", "09:20", "09:30"].map((t) => line({ at: `2026-11-07T${t}:00.000Z` }));
    const bundle = bundleStatement({ lines, project: "/home/awa/app", home: "/home/awa", scope, journal: { ok: true, entries: 3, reason: null, head: null }, issuer: { name: "x", publicKey: "k", fingerprint: "f" }, issuedAt: "t", maxActions: 2 });
    expect(bundle.actions.map((a) => a.at.slice(11, 16))).toEqual(["09:20", "09:30"]);
    expect(bundle.truncated).toBe(1);
  });

  it("signé : il vérifie ; une ligne changée, et il ne vérifie plus", () => {
    const key = signingKey(mkdtempSync(join(tmpdir(), "oathrion-paquet-")));
    const statement = { ...build([line({ command: "npm test" })]), issuer: { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint } };
    const signed = signDocument(statement, key.privateKey);
    expect(verifyShared(signed)).toMatchObject({ ok: true });
    const altered = structuredClone(signed);
    altered.statement.summary.blocked = 0;
    altered.statement.actions[0]!.outcomeLabel = "Approved by a person, done";
    expect(verifyShared(altered)).toMatchObject({ ok: false });
  });
});

describe("rien ne sort qui ne devrait pas", () => {
  it.each([
    ["git push https://awa:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b", "git push https://awa:«redacted»@github.com/a/b"],
    ["curl -H 'Authorization: Bearer abc.def.ghijklmnop' x", "curl -H 'Authorization: Bearer «redacted»' x"],
    ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234", "export OPENAI_API_KEY=«redacted»"],
    ["psql --password=hunter2 db", "psql --password=«redacted» db"],
    ["echo ghp_abcdefghijklmnopqrstuvwxyz0123", "echo «redacted»"],
    ["aws s3 ls # AKIAABCDEFGHIJKLMNOP", "aws s3 ls # «redacted»"],
    ["npm test", "npm test"],
  ])("%s", (input, output) => {
    expect(redactSecrets(input)).toBe(output);
  });

  it("le dépôt devient « . », le dossier personnel « ~ », sans toucher un dossier voisin", () => {
    expect(relativize("cat /home/awa/app/src/a.ts /home/awa/notes.txt /home/awa/app2/x", "/home/awa/app", "/home/awa")).toBe("cat ./src/a.ts ~/notes.txt ~/app2/x");
  });
});
