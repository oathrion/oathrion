/**
 * `oathrion receipt bundle` : la portée de la branche lue dans git, le paquet demandé au pivot,
 * écrit là où la PR le trouvera.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryOf, runBundle, type Git } from "./bundle";

function fakeGit(root: string, refs: Record<string, boolean> = { "origin/main^{commit}": true }): Git {
  return (args) => {
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return { code: 0, out: root };
    if (key === "rev-parse --abbrev-ref HEAD") return { code: 0, out: "feat/receipts" };
    if (key === "rev-parse HEAD") return { code: 0, out: "def456" };
    if (args[0] === "rev-parse" && args[1] === "--verify") return { code: refs[args[3]!] ? 0 : 1, out: "" };
    if (args[0] === "merge-base") return { code: 0, out: "abc123" };
    if (args[0] === "show") return { code: 0, out: "2026-11-07T09:00:00+00:00" };
    if (key === "remote get-url origin") return { code: 0, out: "https://awa:ghp_secret123@github.com/awa/app.git" };
    return { code: 1, out: "" };
  };
}

describe("oathrion receipt bundle", () => {
  it("la portée vient de git ; le paquet est écrit dans .oathrion/receipts/<branche>.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "oathrion-depot-"));
    const asked: Record<string, unknown>[] = [];
    const lines: string[] = [];
    const statement = { type: "oathrion.bundle/v0", issuer: { name: "Oathrion local", fingerprint: "5b24 150f" }, summary: { total: 3, passed: 2, asked: 0, blocked: 1 }, actions: [{ outcome: "refused", what: "rm -rf ~", impact: "9 files (1.0 KB)" }], evidence: { intact: true } };
    const code = await runBundle([], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      cwd: root,
      env: {},
      git: fakeGit(root),
      hub: async () => ({ op: async <T>(body: Record<string, unknown>) => (asked.push(body), { status: 200, body: { statement, signature: "sig" } as T }) }),
      now: () => new Date("2026-11-07T12:00:00.000Z"),
    });
    expect(code).toBe(0);
    expect(asked[0]).toEqual({
      op: "bundle",
      project: root,
      scope: { repository: "awa/app", branch: "feat/receipts", base: "abc123", head: "def456", since: "2026-11-07T09:00:00.000Z", until: "2026-11-07T12:00:00.000Z" },
    });
    expect(JSON.parse(readFileSync(join(root, ".oathrion", "receipts", "feat-receipts.json"), "utf8"))).toEqual({ statement, signature: "sig" });
    expect(lines.join("\n")).toMatch(/3 action\(s\).*1 blocked/);
    expect(lines.join("\n")).toMatch(/✋ rm -rf ~ — would have deleted 9 files/);
    expect(lines.join("\n")).not.toMatch(/ghp_secret/);
  });

  it("hors d'un dépôt, ou sans base : un message clair, rien d'écrit", async () => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), cwd: "/", env: {} };
    expect(await runBundle([], { ...io, git: () => ({ code: 128, out: "" }) })).toBe(3);
    expect(lines.at(-1)).toMatch(/inside a git repository/);
    expect(await runBundle([], { ...io, git: fakeGit("/tmp/x", {}) })).toBe(3);
    expect(lines.at(-1)).toMatch(/--base <ref>/);
  });

  it("le dépôt distant : owner/repo, jamais d'identifiant", () => {
    expect(repositoryOf("git@github.com:awa/app.git")).toBe("awa/app");
    expect(repositoryOf("https://x-access-token:abc@github.com/awa/app.git")).toBe("awa/app");
    expect(repositoryOf("https://gitlab.com/group/sub/app.git")).toBe("gitlab.com/group/sub/app");
    expect(repositoryOf("not a url")).toBeNull();
  });
});
