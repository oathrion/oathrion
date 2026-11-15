/**
 * The product must not claim a guarantee it does not provide.
 *
 * This is not a style rule. Oathrion's whole value is that its answer about an agent
 * action can be trusted, and the audit trail is what a design partner would put
 * in front of an auditor. A UI label saying "Immutable" is a statement about
 * what an attacker with database access cannot do. Oathrion does not provide that.
 *
 * WHAT Oathrion ACTUALLY PROVIDES (see `server/audit-chain.ts`)
 * --------------------------------------------------------
 * Each audit event carries a hash over its own content plus the hash of the
 * previous event in the same execution's trail. Editing an event breaks the
 * chain from that point on, and the verifier reports where. That is real, and it
 * is worth having: it means silent edits are detectable.
 *
 * It is NOT immutability, and the difference is not pedantic:
 *
 *   - the chain is per execution, so deleting an execution's rows entirely
 *     removes the trail rather than breaking it. `audit-chain.ts` says so
 *     itself, in its own header;
 *   - the hashes live in the same database as the data they protect, so anyone
 *     who can rewrite a row can recompute the chain over the rewritten row;
 *   - nothing is anchored outside the deployment - no external notary, no
 *     append-only store, no signature by a key Oathrion does not hold.
 *
 * So the honest words are TAMPER-EVIDENT, or INTERNAL TAMPER EVIDENCE. Not
 * IMMUTABLE, not EXTERNALLY IMMUTABLE EVIDENCE, not TAMPER-PROOF.
 *
 * DEFECT P9-3
 * -----------
 * The Phase 8 build shipped three overclaims, all in surfaces a buyer reads
 * rather than in the code that does the work:
 *
 *   - `shared/seed/executions.ts` wrote "Immutable audit entry written." into
 *     the seeded demo audit trail, 51 times. The demo is the first thing anyone
 *     sees, and it told them the log was immutable;
 *   - `client/src/pages/settings.tsx` labelled the audit section "Immutable
 *     record of every decision made by the control plane.";
 *   - `client/src/pages/execution-detail.tsx` labelled the per-execution trail
 *     "Immutable event log for this execution."
 *
 * All three now say hash-chained and tamper-evident, and name the limit.
 *
 * This test scans the shipped source so the claim cannot come back through a
 * copy-paste, a new page, or a regenerated seed file - the three ways it would
 * plausibly return.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Repository root, derived from this file's location rather than from cwd. */
const ROOT = join(new URL(".", import.meta.url).pathname, "..", "..");

/**
 * Directories that are not Oathrion's own shipped source.
 *
 * `notes/` and the `PHASE-*.md` reports are excluded on purpose: they are a
 * record of what was believed at the time, including the wrong beliefs, and
 * rewriting history to make a test pass would be its own kind of dishonesty.
 * This test governs what the product SAYS, not what the archive REMEMBERS.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  "notes",
  "uploaded_attachments",
]);

/** Extensions that constitute shipped source or shipped copy. */
const SCANNED = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".sh", ".html", ".json", ".md"]);

/**
 * Historical records, excluded by name rather than by directory.
 *
 * `.md` was added to the scan in Phase 9 after noticing that HALF of the P9-3
 * defect lived in `docs/` — the immutability claim was in the prose a user
 * reads, not only in a string a developer reads — and the regression guard
 * covered only the half written in TypeScript. A guard that watches the code
 * but not the documentation does not protect against the defect it was written
 * for.
 *
 * The phase reports and the architecture notes at the repository root are a
 * different kind of document: they record what was believed at the time,
 * wrong beliefs included, and PHASE-9-REPORT.md quotes the banned string
 * verbatim precisely in order to explain why it was removed. Rewriting history
 * to make a test pass would be its own dishonesty — the same reasoning that
 * already excludes `notes/` above.
 *
 * `docs/`, README.md and DEPLOYMENT.md are NOT excluded: they are what the
 * product says today.
 */
const HISTORICAL_MD = /^(PHASE-|Oathrion-|AUDIT-|RAPPORT-)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue; // a broken symlink is not a claim
    }
    if (stats.isDirectory()) {
      walk(full, out);
      continue;
    }
    const dot = entry.lastIndexOf(".");
    if (dot <= 0 || !SCANNED.has(entry.slice(dot))) continue;
    // Only at the repository root: `docs/` never holds a historical record.
    if (entry.endsWith(".md") && dir === ROOT && HISTORICAL_MD.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const FILES = walk(ROOT);

/**
 * Files allowed to contain the banned word, each for a stated reason.
 *
 * An allowlist rather than a looser regex: every exemption should require
 * someone to write down why, in this file, where a reviewer will see it.
 */
const EXEMPT: ReadonlyArray<{ path: string; because: string }> = [
  {
    // This file quotes the banned claims in order to ban them.
    path: join("server", "test", "claims-honesty.test.ts"),
    because: "states the rule, so it necessarily contains the words it forbids",
  },
  {
    // "an immutable filesystem" - a description of a Linux mount option in a
    // comment about what the chaos bench can and cannot simulate. Not a claim
    // about Oathrion's audit trail.
    path: join("script", "chaos.ts"),
    because: "describes an immutable *filesystem mount*, not the audit log",
  },
  {
    // package-lock.json contains third-party package names and descriptions
    // that Oathrion does not author and must not edit.
    path: "package-lock.json",
    because: "third-party dependency metadata, not Oathrion's own copy",
  },
];

function exemptionFor(file: string): { path: string; because: string } | undefined {
  const rel = relative(ROOT, file);
  return EXEMPT.find((e) => rel === e.path || rel.endsWith(sep + e.path));
}

describe("audit claims are honest (regression guard for P9-3)", () => {
  it("scans a plausible number of files", () => {
    /*
     * A guard on the guard. If the walk breaks - wrong root, over-eager skip
     * list - every assertion below passes vacuously, which is the exact failure
     * mode this whole Phase 9 pass exists to eliminate.
     */
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.endsWith(join("shared", "seed", "executions.ts")))).toBe(true);
    expect(FILES.some((f) => f.endsWith(join("client", "src", "pages", "settings.tsx")))).toBe(true);
    expect(FILES.some((f) => f.endsWith(join("server", "audit-chain.ts")))).toBe(true);
  });

  it("no shipped source calls the audit trail immutable or tamper-proof", () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      if (exemptionFor(file) !== undefined) continue;

      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }

      /*
       * Matches the word family (immutable, immutability, immutably) and
       * "tamper-proof"/"tamperproof". "tamper-evident" is explicitly NOT
       * matched: it is the correct term and should appear.
       */
      const banned = /\b(immutab\w*|tamper[\s-]?proof)\b/gi;
      for (const match of text.matchAll(banned)) {
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${relative(ROOT, file)}:${line} — "${match[0]}"`);
      }
    }

    expect(
      offenders,
      `Overclaimed guarantees found. Oathrion's audit trail is hash-chained and ` +
        `TAMPER-EVIDENT within an execution; it is not immutable and not tamper-proof. ` +
        `Use "tamper-evident" or "hash-chained", or add a justified exemption to EXEMPT ` +
        `in this file.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the corrected surfaces say what is actually true", () => {
    // Not just "the bad word is gone" - the replacement has to be meaningful.
    const seed = readFileSync(join(ROOT, "shared", "seed", "executions.ts"), "utf8");
    expect(seed).toContain("Hash-chained audit entry written.");

    const settings = readFileSync(join(ROOT, "client", "src", "pages", "settings.tsx"), "utf8");
    expect(settings).toMatch(/Tamper-evident within each execution trail; not anchored outside this deployment/);

    const detail = readFileSync(
      join(ROOT, "client", "src", "pages", "execution-detail.tsx"),
      "utf8",
    );
    /* La console est en anglais depuis le 4 novembre 2026 (elle était en français du 28 octobre à cette date). */
    expect(detail).toMatch(/Tamper-evident: edits break the chain and are reported/);
  });

  it("the audit chain module still documents its own limits", () => {
    /*
     * The reason the corrected wording is defensible is that `audit-chain.ts`
     * is honest about the two holes. If that honesty is ever edited out, the UI
     * copy above stops being backed by anything.
     */
    const chain = readFileSync(join(ROOT, "server", "audit-chain.ts"), "utf8");
    expect(chain.toLowerCase()).toMatch(/delet/); // it says deletion is not detected
    expect(chain.length).toBeGreaterThan(500);
  });
});
