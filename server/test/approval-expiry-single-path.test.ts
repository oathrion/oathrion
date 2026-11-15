/**
 * Structural tripwires for the expiry guards.
 *
 * WHAT THESE ARE, AND WHAT THEY ARE NOT
 * -------------------------------------
 * The behavioural tests in `approval-expiry-e2e.test.ts` prove that the paths
 * they exercise refuse a lapsed authorisation. What they cannot prove is that
 * those are the *only* paths, because a test can only observe the code it calls.
 * A fourth dispatch site added next quarter, or a guard quietly deleted, would
 * leave every one of those tests green.
 *
 * So this file reads the source as text and asserts on its shape. That is a
 * weaker kind of evidence and is recorded as such in the phase report: a
 * determined author can defeat any of it by renaming things. It is a tripwire
 * against drift, not a security boundary. The boundaries are the conditional
 * `UPDATE` in the repository and the guards these tests watch over.
 *
 * They are written to fail loudly rather than silently: each one names what a
 * maintainer should do if it trips, because a structural test that fails without
 * explaining itself tends to get deleted rather than understood.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");

function source(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

const GATEWAY = "server/gateway/agent-gateway.ts";
const REPOSITORY = "server/repositories/sqlite.ts";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("a tool can still only be reached through one guarded funnel", () => {
  const gateway = source(GATEWAY);

  it("declares exactly one dispatch implementation", () => {
    // If this trips: a second dispatcher exists, and none of the expiry guards
    // apply to it. Fold it back into `dispatch()` rather than duplicating them.
    expect(occurrences(gateway, "private async dispatch(")).toBe(1);
  });

  it("calls it from exactly three places, all inside the gateway", () => {
    /*
     * Three, by design: the initial ALLOW, the release of an approval, and a
     * retry. Each is guarded, and each guard is asserted below.
     *
     * If this count changes, the new site needs the same guards — the number
     * itself is not sacred, the review it forces is.
     */
    expect(occurrences(gateway, "this.dispatch(")).toBe(3);
  });

  it("is private, so no caller outside the gateway can reach it", () => {
    const callers = ["server", "shared", "client", "script"]
      .flatMap((dir) => listTs(path.join(root, dir)))
      .filter((file) => !file.endsWith(path.normalize(GATEWAY)))
      // Test files discuss `dispatch()` in prose; only executable references matter.
      .filter((file) => !file.includes(`${path.sep}test${path.sep}`))
      // Comments are stripped first: several modules refer to
      // `AgentGateway.dispatch()` in prose to explain why they are safe, and a
      // tripwire that fired on documentation would be removed rather than heeded.
      .filter((file) => /\.dispatch\s*\(/.test(withoutComments(readFileSync(file, "utf8"))));

    expect(callers).toEqual([]);
  });

  it("has no background worker that could claim a tool run on its own", () => {
    /*
     * The reason the sweep endpoint is reporting rather than enforcement. If
     * something ran on a timer and claimed executions, an expired approval whose
     * execution had not yet been closed could be picked up by it, and the
     * deadline would hold only for as long as nobody looked.
     */
    const claimers = ["server", "shared", "script"]
      .flatMap((dir) => listTs(path.join(root, dir)))
      .filter((file) => !file.includes(`${path.sep}test${path.sep}`))
      .filter((file) => /claimToolRun\s*\(/.test(readFileSync(file, "utf8")))
      .filter((file) => !file.endsWith(path.normalize("server/repositories/sqlite.ts")))
      /*
       * Phase 11 added the PostgreSQL repository, which defines the same conditional
       * UPDATE for the same reason. Excluded on the same grounds as its SQLite sibling —
       * it is the statement, not a caller — and the assertion below is unchanged: the
       * gateway is still the only thing that CALLS a claim.
       */
      .filter((file) => !file.endsWith(path.normalize("server/repositories/postgres.ts")))
      .filter((file) => !file.endsWith(path.normalize("server/repositories/types.ts")))
      .map((file) => path.relative(root, file));

    // Only the gateway claims runs. The repository defines the statement; the
    // interface declares it.
    expect(claimers).toEqual([path.normalize(GATEWAY)]);
  });
});

describe("each dispatch site is guarded before it can be reached", () => {
  const gateway = source(GATEWAY);
  const lines = gateway.split("\n");

  /** Line index of the nth `this.dispatch(` call, 0-based. */
  function dispatchLine(nth: number): number {
    const found = lines.reduce<number[]>((acc, line, index) => {
      if (line.includes("this.dispatch(")) acc.push(index);
      return acc;
    }, []);
    expect(found.length).toBe(3);
    return found[nth]!;
  }

  it("guards the initial dispatch on an ALLOW decision", () => {
    const before = lines.slice(0, dispatchLine(0)).join("\n");
    expect(before).toContain('if (outcome.decision !== "ALLOW" || !execution) return base;');
  });

  it("guards the approval release on expiry, and tests expiry first", () => {
    /*
     * The single most load-bearing line added in this phase. An expiry returns
     * `changed: true`, with a non-null execution, for a caller who asked to
     * approve — so every *other* term in this guard is satisfied on the late-approve
     * path. Drop `expired` and the action is released by the clock's own
     * bookkeeping.
     */
    const before = lines.slice(0, dispatchLine(1)).join("\n");
    expect(before).toContain(
      'if (expired || status !== "approved" || !execution || !changed) {',
    );
  });

  it("guards the retry on the gating approval's deadline", () => {
    const before = lines.slice(0, dispatchLine(2)).join("\n");
    // The lookup and the classification both have to be present: either one alone
    // decides nothing.
    expect(before).toContain("findByExecutionId(");
    expect(before).toContain("isExpired(");
  });

  it("classifies expiry with the shared module rather than its own comparison", () => {
    // An inline `new Date(x) < new Date()` would silently read a null deadline as
    // "not expired", which is the opposite of the module's fail-closed contract.
    expect(gateway).toContain('from "@shared/approvals/ttl"');
  });
});

describe("the deadline is enforced inside the statement, not before it", () => {
  const repository = source(REPOSITORY);

  it("puts the deadline conditions in the resolve UPDATE itself", () => {
    /*
     * The distinction this whole design rests on. A read that says "still valid",
     * followed by a write, is a race whose window is the latency between the two;
     * two approvers arriving either side of the deadline can both be told they
     * succeeded. Inside one indivisible statement there is no window.
     *
     * If this trips: someone has moved the check into a pre-flight `if`. Move it
     * back into the WHERE clause.
     */
    const resolve = between(repository, "async resolve(", "async expire(");
    expect(resolve).toContain("isNotNull(approvalRows.expiresAt)");
    expect(resolve).toContain("gt(approvalRows.expiresAt");
  });

  it("requires a live deadline, so a NULL cannot be resolved", () => {
    // `isNotNull` is what makes the fail-closed reading true at the storage layer
    // as well as in the classifier. Without it, an unstamped row is releasable
    // forever.
    const resolve = between(repository, "async resolve(", "async expire(");
    expect(resolve).toContain("isNotNull(approvalRows.expiresAt)");
  });

  it("only expires rows that are actually past their deadline", () => {
    /*
     * `expire()` must not double as an unaudited way to cancel a live request.
     * Killing a pending approval early is a decision, and decisions go through
     * reject, under the `approve` capability, with a human's name attached.
     */
    const expire = between(repository, "async expire(", "async expirePending(");
    expect(expire).toContain("lte(approvalRows.expiresAt");
    expect(expire).toContain('eq(approvalRows.status, "pending")');
  });

  it("stamps a deadline at the single write boundary", () => {
    // So that no code path can create an approval without one, which is what makes
    // fail-closed reading cost nothing legitimate.
    expect(repository).toContain("approvalDeadline(");
  });

  it("scopes both new statements to the organization", () => {
    const expire = between(repository, "async expire(", "async expirePending(");
    const sweep = between(repository, "async expirePending(", "async findByExecutionId(");
    const lookup = between(repository, "async findByExecutionId(", "\n  async ");
    for (const [name, body] of [
      ["expire", expire],
      ["expirePending", sweep],
      ["findByExecutionId", lookup],
    ] as const) {
      // A sweep that crossed tenants would let any organization close another's
      // pending requests — a denial of service against someone else's business.
      expect(body, `${name} must be tenant-scoped`).toContain("organizationId");
    }
  });
});

/* --------------------------------------------------------------------------- */

/** Text between the first occurrence of `start` and the next `end` after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `expected to find ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  return to === -1 ? source.slice(from) : source.slice(from, to);
}

/**
 * Source with comments removed. Crude on purpose — it drops `//`-prefixed lines
 * and whole block-comment spans, which is enough to stop prose from tripping the
 * reference checks without pulling in a parser.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
