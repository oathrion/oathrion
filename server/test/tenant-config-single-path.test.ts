/**
 * Chantier 1 — the tripwire that keeps a tenant's quota ceiling on ONE read path.
 *
 * Same reasoning, and the same honest limit, as `agent-binding-single-path.test.ts`:
 * the behavioural tests in `tenant-quota-config.test.ts` prove the paths that exist
 * resolve the database first. They cannot see a second resolver added next quarter —
 * a route that parses `OATHRION_QUOTAS` itself, or reads `organization_quotas` with its own
 * query — which would quietly reintroduce "the ceiling the operator set in the database
 * is ignored here". So this file asserts the structure instead:
 *
 *   - `OATHRION_QUOTAS` is read by `server/quotas.ts` (resolution) and by
 *     `server/config-check.ts` (boot validation, through the same shared parser) — no
 *     third reader;
 *   - the `organization_quotas` table is named only by its migration, its Drizzle
 *     declaration and its store;
 *   - the store is imported only by `server/quotas.ts`, so every ceiling a request sees
 *     goes through `quotaLimitsFor`;
 *   - the pure merge `limitsFor` is called only by `server/quotas.ts`, so nothing can
 *     compute a ceiling from the environment alone and skip the database.
 *
 * It is a grep with an opinion: it narrows the omission window, it does not close it.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..", "..");

function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "test" || name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(relative(ROOT, full));
      }
    }
  };
  for (const dir of ["server", "shared", "script"]) walk(join(ROOT, dir));
  return out.sort();
}

/*
 * Comments are removed by the TypeScript printer rather than by importing the stripper
 * from `agent-binding-single-path.test.ts`: importing a test file registers its suites
 * a second time inside this one, and copying the stripper would be a second
 * implementation of the same rule. The printer is the compiler's own reading of what is
 * a comment, so a `//` inside a string or a regex cannot confuse it.
 */
const printer = ts.createPrinter({ removeComments: true });
function withoutComments(file: string, code: string): string {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return printer.printFile(ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, kind));
}

const SOURCES = shippedSources().map((file) => ({
  file,
  code: withoutComments(file, readFileSync(join(ROOT, file), "utf8")),
}));

function filesMatching(pattern: RegExp): string[] {
  return SOURCES.filter((s) => pattern.test(s.code)).map((s) => s.file);
}

describe("a tenant's quota ceiling has exactly one read path", () => {
  it("sees the files it is about (the scan is not vacuous)", () => {
    const files = SOURCES.map((s) => s.file);
    expect(files).toContain("server/quotas.ts");
    expect(files).toContain("server/repositories/organization-quotas.ts");
    expect(files).toContain("server/repositories/postgres.ts");
  });

  it("reads OATHRION_QUOTAS only in the resolver and in the boot validation", () => {
    // A read is `env.OATHRION_QUOTAS` / `env["OATHRION_QUOTAS"]`. The name also appears in error
    // messages and in scripts that SET it for a child process; neither is a reader.
    const reads = /\benv\??\.OATHRION_QUOTAS\b|\benv\[\s*["']OATHRION_QUOTAS["']\s*\]/;
    expect(filesMatching(reads)).toEqual(["server/config-check.ts", "server/quotas.ts"]);
  });

  it("names the organization_quotas table only in its migration, its declaration and its store", () => {
    expect(filesMatching(/\borganization_quotas\b/)).toEqual([
      // Not a reader: the production gate seeds one row to prove the boot refuses an
      // OATHRION_QUOTAS that contradicts it. Listed by name so a second script is noticed.
      "script/verify-production-config.ts",
      "server/migrations/017-organization-quotas.ts",
      "server/repositories/organization-quotas.ts",
      "shared/schema.ts",
    ]);
  });

  it("lets only the resolver import the store", () => {
    expect(filesMatching(/repositories\/organization-quotas["']/)).toEqual(["server/quotas.ts"]);
  });

  it("calls the pure environment merge only from the resolver", () => {
    // `quotaLimitsFor(` contains `LimitsFor(`, not `limitsFor(` preceded by a word
    // boundary, so the resolver's public name does not match this pattern.
    expect(filesMatching(/\blimitsFor\(/)).toEqual(["server/quotas.ts", "shared/quotas.ts"]);
  });
});
