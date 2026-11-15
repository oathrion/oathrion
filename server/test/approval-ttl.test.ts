/**
 * The approval deadline: the classifier, and the SQL that enforces it.
 *
 * Two halves, deliberately tested as two different kinds of thing.
 *
 * `shared/approvals/ttl.ts` is pure and is tested as arithmetic. It is *not* the
 * security boundary and these tests do not pretend it is.
 *
 * The boundary is the conditional `UPDATE` in the approval repository, so the
 * second half of this file drives the repository directly and asserts on stored
 * rows. That level is chosen on purpose: a test that only went through HTTP
 * could be satisfied by a guard sitting anywhere in the stack, including one in
 * front of the write that a second code path could walk around. Asserting that
 * the *statement* refuses is what makes the claim "cannot be released after the
 * deadline" hold for every caller, present and future.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Approval } from "@shared/types";
import {
  DEFAULT_APPROVAL_TTL_MS,
  MAX_APPROVAL_TTL_MS,
  MIN_APPROVAL_TTL_MS,
  approvalDeadline,
  approvalTtlMs,
  isExpired,
  msRemaining,
} from "@shared/approvals/ttl";
import { repositoriesFor } from "../repositories";
import { DEFAULT_ORGANIZATION_ID, organizationId } from "@shared/tenancy";

describe("the approval TTL classifier", () => {
  describe("reading the configured window", () => {
    it("falls back to the default when nothing is set", () => {
      expect(approvalTtlMs({})).toBe(DEFAULT_APPROVAL_TTL_MS);
    });

    it("honours a value inside the permitted range", () => {
      expect(approvalTtlMs({ OATHRION_APPROVAL_TTL_MS: "900000" })).toBe(900000);
    });

    it("refuses a value below the floor rather than expiring requests instantly", () => {
      expect(approvalTtlMs({ OATHRION_APPROVAL_TTL_MS: String(MIN_APPROVAL_TTL_MS - 1) })).toBe(
        DEFAULT_APPROVAL_TTL_MS,
      );
    });

    it("refuses a value above the ceiling, so a stray zero cannot restore 'never expires'", () => {
      // The failure this guards against: 3600000 typed as 36000000000. Without a
      // ceiling that is a 416-day window, which is indistinguishable from having
      // no deadline at all.
      expect(approvalTtlMs({ OATHRION_APPROVAL_TTL_MS: String(MAX_APPROVAL_TTL_MS + 1) })).toBe(
        DEFAULT_APPROVAL_TTL_MS,
      );
    });

    it.each([
      ["not a number", "soon"],
      ["empty", ""],
      ["whitespace", "   "],
      ["negative", "-60000"],
      ["zero", "0"],
      ["fractional", "60000.5"],
      ["hex", "0x3600"],
      ["infinity", "Infinity"],
    ])("falls back on a malformed value (%s)", (_label, raw) => {
      expect(approvalTtlMs({ OATHRION_APPROVAL_TTL_MS: raw })).toBe(DEFAULT_APPROVAL_TTL_MS);
    });

    it("never returns a non-positive window whatever it is handed", () => {
      // The property that matters more than any single case above: whatever
      // arrives, the result is a usable positive window. A zero or negative TTL
      // would expire every request at the instant it was raised.
      for (const raw of ["", "0", "-1", "abc", "NaN", "1e400", "  12  "]) {
        expect(approvalTtlMs({ OATHRION_APPROVAL_TTL_MS: raw })).toBeGreaterThan(0);
      }
    });
  });

  describe("computing a deadline", () => {
    it("adds the window to the request instant", () => {
      const requested = "2026-09-02T10:00:00.000Z";
      expect(approvalDeadline(requested, { OATHRION_APPROVAL_TTL_MS: "3600000" })).toBe(
        "2026-09-02T11:00:00.000Z",
      );
    });

    it("returns a real instant for an unparseable request time", () => {
      // Falls back to *now* as the base, which is the shortest defensible
      // deadline. The failure being avoided is an `Invalid Date`, which
      // stringifies to something no comparison can order and therefore behaves
      // like "never expires".
      const deadline = approvalDeadline("not a date");
      expect(Number.isFinite(Date.parse(deadline))).toBe(true);
      expect(Date.parse(deadline)).toBeGreaterThan(Date.now() - 1000);
    });
  });

  describe("classifying a deadline (fail-closed)", () => {
    it("treats a future deadline as live", () => {
      expect(isExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
    });

    it("treats a past deadline as expired", () => {
      expect(isExpired(new Date(Date.now() - 1).toISOString())).toBe(true);
    });

    it("treats the deadline instant itself as expired", () => {
      const now = Date.now();
      expect(isExpired(new Date(now).toISOString(), now)).toBe(true);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
      ["unparseable", "whenever"],
    ])("treats a missing or unreadable deadline as expired (%s)", (_label, value) => {
      // The whole fail-closed premise. A row nobody stamped is a bug, and the
      // safe reading of a bug is not "valid forever".
      expect(isExpired(value)).toBe(true);
    });

    it("reports no time remaining once expired", () => {
      expect(msRemaining(new Date(Date.now() - 1000).toISOString())).toBe(0);
      expect(msRemaining(null)).toBe(0);
    });

    it("reports the remaining time while live", () => {
      const remaining = msRemaining(new Date(Date.now() + 30_000).toISOString());
      expect(remaining).toBeGreaterThan(25_000);
      expect(remaining).toBeLessThanOrEqual(30_000);
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The enforcement half.
 * ---------------------------------------------------------------------------
 */

const repos = repositoriesFor(DEFAULT_ORGANIZATION_ID);

let counter = 0;

/** A pending approval whose deadline is `offsetMs` from now (negative = already past). */
function pending(offsetMs: number, overrides: Partial<Approval> = {}): Approval {
  counter += 1;
  const now = Date.now();
  return {
    id: `apr_ttl_${counter}_${now}`,
    executionId: null,
    agentId: "agt_billing",
    agentName: "TTL fixture",
    title: "Refund 750 EUR",
    summary: "Awaiting a human",
    requestedValue: "750 EUR",
    policyId: "pol_refund_approval",
    policyName: "Refund approval",
    policyLimit: "500 EUR",
    risk: "high",
    status: "pending",
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + offsetMs).toISOString(),
    context: [],
    ...overrides,
  };
}

describe("the conditional UPDATE is what enforces the deadline", () => {
  const created: string[] = [];

  beforeEach(() => {
    created.length = 0;
  });

  afterEach(() => {
    // Nothing to undo: each test uses a unique id, so rows accumulate harmlessly
    // and no test can observe another's fixture.
  });

  it("stamps a deadline on a row created without one", async () => {
    // The invariant the decision paths rely on: whatever a caller omits, a stored
    // row has a deadline. Without this, fail-closed reading would reject
    // legitimate approvals raised by any code path that forgot to compute one.
    const bare = pending(0);
    delete bare.expiresAt;
    await repos.approvals.create(bare);
    created.push(bare.id);

    const stored = await repos.approvals.findById(bare.id);
    expect(stored?.expiresAt).toBeTruthy();
    expect(isExpired(stored?.expiresAt)).toBe(false);
  });

  it("respects a deadline the caller did supply", async () => {
    const explicit = pending(5 * 60_000);
    await repos.approvals.create(explicit);
    const stored = await repos.approvals.findById(explicit.id);
    expect(stored?.expiresAt).toBe(explicit.expiresAt);
  });

  it("claims a resolution while the window is open", async () => {
    const live = pending(60_000);
    await repos.approvals.create(live);

    const result = await repos.approvals.resolve(live.id, "approved", "Priya Raman");
    expect(result?.claimed).toBe(true);
    expect(result?.approval.status).toBe("approved");
    expect(result?.approval.resolvedBy).toBe("Priya Raman");
    // The companion timestamp: the trail must be able to say when, not only who.
    expect(result?.approval.resolvedAt).toBeTruthy();
  });

  it("refuses to claim a resolution once the window has closed", async () => {
    const stale = pending(-1000);
    await repos.approvals.create(stale);

    const result = await repos.approvals.resolve(stale.id, "approved", "Priya Raman");

    // `claimed: false` is the whole point: the caller performed no write, so
    // nothing downstream of it may treat this as a release.
    expect(result?.claimed).toBe(false);
    // And the stored row is untouched — still pending, no approver's name against
    // a decision that did not take effect.
    expect(result?.approval.status).toBe("pending");
    expect(result?.approval.resolvedBy).toBeFalsy();
  });

  it("refuses to claim a rejection once the window has closed, too", async () => {
    // Symmetry matters here. A rejection after expiry is harmless in outcome, but
    // recording it would put a human's name against a request the clock had
    // already settled, and the trail would then disagree with what happened.
    const stale = pending(-1000);
    await repos.approvals.create(stale);

    const result = await repos.approvals.resolve(stale.id, "rejected", "Priya Raman");
    expect(result?.claimed).toBe(false);
    expect(result?.approval.status).toBe("pending");
  });

  it("refuses to claim a row whose deadline is NULL", async () => {
    // Reaches past `create()` with raw SQL, because the repository would have
    // stamped a deadline. This is the fail-closed case at the level that
    // enforces it: a row that a future migration, an import, or a bug leaves
    // unstamped must not be releasable.
    const orphan = pending(60_000);
    await repos.approvals.create(orphan);
    const { rawDb } = await import("../db");
    rawDb.prepare("UPDATE approvals SET expires_at = NULL WHERE id = ?").run(orphan.id);

    const result = await repos.approvals.resolve(orphan.id, "approved", "Priya Raman");
    expect(result?.claimed).toBe(false);
    expect(result?.approval.status).toBe("pending");
  });

  it("expires a row whose deadline has passed", async () => {
    const stale = pending(-1000);
    await repos.approvals.create(stale);

    const result = await repos.approvals.expire(stale.id);
    expect(result?.claimed).toBe(true);
    expect(result?.approval.status).toBe("expired");
    expect(result?.approval.resolvedAt).toBeTruthy();
    // Nobody decided this, so nobody is named as having decided it.
    expect(result?.approval.resolvedBy).toBeFalsy();
  });

  it("will not expire a row whose window is still open", async () => {
    // `expire` must not be usable as an unaudited way to kill a live request.
    // Anyone wanting a pending request gone before its time has to reject it,
    // under the `approve` capability, leaving a named human in the trail.
    const live = pending(60_000);
    await repos.approvals.create(live);

    const result = await repos.approvals.expire(live.id);
    expect(result?.claimed).toBe(false);
    expect(result?.approval.status).toBe("pending");
  });

  it("expires only once, so a second observer cannot double-record it", async () => {
    const stale = pending(-1000);
    await repos.approvals.create(stale);

    const first = await repos.approvals.expire(stale.id);
    const second = await repos.approvals.expire(stale.id);
    expect(first?.claimed).toBe(true);
    expect(second?.claimed).toBe(false);
    expect(second?.approval.status).toBe("expired");
  });

  it("cannot resolve a row that has already expired", async () => {
    const stale = pending(-1000);
    await repos.approvals.create(stale);
    await repos.approvals.expire(stale.id);

    const result = await repos.approvals.resolve(stale.id, "approved", "Priya Raman");
    expect(result?.claimed).toBe(false);
    expect(result?.approval.status).toBe("expired");
  });

  it("sweeps every past-deadline pending row and leaves live ones alone", async () => {
    const stale = pending(-1000);
    const live = pending(10 * 60_000);
    await repos.approvals.create(stale);
    await repos.approvals.create(live);

    const swept = await repos.approvals.expirePending();

    expect(swept).toContain(stale.id);
    expect(swept).not.toContain(live.id);
    expect((await repos.approvals.findById(stale.id))?.status).toBe("expired");
    expect((await repos.approvals.findById(live.id))?.status).toBe("pending");
  });

  it("does not report a row it did not transition", async () => {
    // The sweep returns ids for a caller to act on (close the execution, write the
    // trail). Reporting a row it did not actually claim would have the caller
    // write an expiry entry for a request a human had just decided.
    const stale = pending(-1000);
    await repos.approvals.create(stale);
    await repos.approvals.expire(stale.id);

    const swept = await repos.approvals.expirePending();
    expect(swept).not.toContain(stale.id);
  });

  it("finds the approval that gated an execution", async () => {
    const gated = pending(60_000, { executionId: "exe_ttl_lookup" });
    await repos.approvals.create(gated);

    const found = await repos.approvals.findByExecutionId("exe_ttl_lookup");
    expect(found?.id).toBe(gated.id);
  });

  it("returns nothing for an execution no approval gated", async () => {
    expect(await repos.approvals.findByExecutionId("exe_never_gated")).toBeUndefined();
  });
});

describe("the deadline guard is tenant-scoped like every other statement", () => {
  it("does not let one organization sweep another's approvals", async () => {
    // A sweep is a write. One that crossed tenants would let any organization
    // close another's pending requests, which is a denial of service against
    // somebody else's business.
    const rival = repositoriesFor(organizationId("org_rival_corp"));
    const mine = pending(-1000);
    await repos.approvals.create(mine);

    const sweptByRival = await rival.approvals.expirePending();
    expect(sweptByRival).not.toContain(mine.id);
    expect((await repos.approvals.findById(mine.id))?.status).toBe("pending");
  });

  it("does not let one organization expire another's approval by id", async () => {
    const rival = repositoriesFor(organizationId("org_rival_corp"));
    const mine = pending(-1000);
    await repos.approvals.create(mine);

    const result = await rival.approvals.expire(mine.id);
    expect(result).toBeUndefined();
    expect((await repos.approvals.findById(mine.id))?.status).toBe("pending");
  });
});
