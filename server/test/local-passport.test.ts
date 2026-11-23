/**
 * Le passeport d'un agent (`server/local-passport.ts`) : seulement ses actions, son programme
 * admis, les outils qu'il a atteints, les règles du hook pour Claude Code, la dernière action
 * arrêtée — et signé.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PASSPORT_TYPE, signDocument, signingKey, verifyShared } from "@shared/receipt-share";

import type { ActivityEntry } from "../local-activity";
import { passportStatement, toolOf } from "../local-passport";
import type { KnownProgram } from "../local-programs";

let n = 0;
const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  at: "2026-11-10T10:00:00.000Z",
  source: "claude-code",
  agent: "Claude Code",
  action: "npm test",
  target: "shell:///home/awa/app",
  outcome: "done",
  detail: null,
  ref: `t${String((n += 1))}`,
  ...over,
});

const program = (over: Partial<KnownProgram>): KnownProgram => ({
  id: "prg_1",
  name: "Cursor",
  identity: { exe: "/home/awa/.local/bin/cursor", script: null, sha256: "4f1c".padEnd(60, "0") + "0b7d", platform: "linux" },
  status: "trusted",
  firstSeen: "2026-11-03T09:00:00.000Z",
  lastSeen: "2026-11-20T09:00:00.000Z",
  decidedAt: "2026-11-03T09:01:00.000Z",
  decidedBy: "local console",
  previousSha256: [],
  ...over,
});

const chain = { ok: true, entries: 9, head: "h9" };
const entries = [
  entry({}),
  entry({ outcome: "asked-done", detail: "rule git-push", action: "git push" }),
  entry({ outcome: "refused", detail: "rule rm-outside-project", action: "rm -rf /home/awa/photos", impact: "3 files (3.0 KB)", at: "2026-11-12T10:00:00.000Z" }),
  entry({ source: "claude-code", target: "file:///home/awa/app/a.ts", action: "write /home/awa/app/a.ts" }),
  entry({ source: "oathrion", agent: "Cursor", action: "mcp.github.create_issue", target: "mcp://github/create_issue", outcome: "approved-done", detail: "writes ask" }),
  entry({ source: "oathrion", agent: "Cursor", action: "mcp.github.get_file", target: "mcp://github/get_file" }),
  entry({ source: "oathrion", agent: "Cursor", action: "mcp.postgres.query", target: "mcp://postgres/query", at: "2026-10-01T10:00:00.000Z" }),
];
const build = (agent: string, over: Partial<Parameters<typeof passportStatement>[0]> = {}) =>
  passportStatement({
    agent,
    entries,
    programs: [program({}), program({ id: "prg_2", name: "Cursor", status: "blocked", identity: { exe: "/tmp/faux-cursor", script: null, sha256: "f".repeat(64), platform: "linux" } })],
    hookRules: { all: ["rm-outside-project", "git-push", "secret-egress"], disabled: new Set(["git-push"]), extraDeny: 1, extraAsk: 0 },
    since: "2026-11-01T00:00:00.000Z",
    until: "2026-11-30T00:00:00.000Z",
    subject: "Acme",
    home: "/home/awa",
    partial: false,
    receipts: chain,
    journal: chain,
    issuer: { name: "Oathrion local", publicKey: "k", fingerprint: "f" },
    issuedAt: "2026-11-30T00:00:01.000Z",
    ...over,
  });

describe("le passeport d'un agent", () => {
  it("Claude Code : ses seules actions, les outils, les règles du hook, la dernière action arrêtée", () => {
    const passport = build("Claude Code");
    expect(passport.type).toBe(PASSPORT_TYPE);
    expect(passport.record).toMatchObject({ total: 4, passed: 2, asked: 1, blocked: 1 });
    expect(passport.tools).toEqual([
      { tool: "shell", total: 3, asked: 1, blocked: 1 },
      { tool: "files", total: 1, asked: 0, blocked: 0 },
    ]);
    expect(passport.hookRules).toEqual({ inForce: ["rm-outside-project", "secret-egress"], off: ["git-push"], extraDeny: 1, extraAsk: 0 });
    expect(passport.lastStopped).toMatchObject({ what: "rm -rf ~/photos", rule: "rm-outside-project", impact: "3 files (3.0 KB)" });
    expect(passport.agent.program).toBeNull();
    expect(JSON.stringify(passport)).not.toContain("/home/awa");
  });

  it("un agent MCP : le programme qu'une personne a admis sous ce nom, jamais celui qui a été bloqué", () => {
    const passport = build("Cursor");
    expect(passport.agent.program).toEqual({ executable: "~/.local/bin/cursor", sha256: expect.stringMatching(/^4f1c.*0b7d$/), platform: "linux", admittedAt: "2026-11-03T09:01:00.000Z", updates: 0 });
    expect(passport.agent.firstSeen).toBe("2026-10-01T10:00:00.000Z");
    expect(passport.record).toMatchObject({ total: 2, asked: 1, approvedByPerson: 1 });
    expect(passport.tools.map((t) => t.tool)).toEqual(["github"]);
    expect(passport.hookRules).toBeNull();
    expect(passport.lastStopped).toBeNull();
  });

  it("aucun programme admis sous ce nom : le passeport dit qu'il n'a pas été lu", () => {
    expect(build("Cursor", { programs: [program({ status: "pending" })] }).agent.program).toBeNull();
  });

  it("les outils d'une action", () => {
    expect(toolOf(entry({ source: "oathrion", action: "mcp.linear.create_issue" }))).toBe("linear");
    expect(toolOf(entry({ target: "file:///x" }))).toBe("files");
    expect(toolOf(entry({ action: "read untrusted content: https://x.example" }))).toBe("untrusted content");
  });

  it("signé : il vérifie ; une ligne changée, et il ne vérifie plus", () => {
    const key = signingKey(mkdtempSync(join(tmpdir(), "oathrion-passeport-")));
    const signed = signDocument({ ...build("Claude Code"), issuer: { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint } }, key.privateKey);
    expect(verifyShared(signed)).toMatchObject({ ok: true });
    const altered = structuredClone(signed);
    altered.statement.hookRules!.off = [];
    expect(verifyShared(altered)).toMatchObject({ ok: false });
  });
});
