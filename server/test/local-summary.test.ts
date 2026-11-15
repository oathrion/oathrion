/**
 * Le bilan (`server/local-summary.ts`) : trois nombres justes, les actions bloquées en tête, et
 * « rien n'a été modifié » seulement si les deux chaînes sont intactes.
 */
import { describe, expect, it } from "vitest";

import type { ActivityEntry, ActivityOutcome } from "../local-activity";
import { summarize } from "../local-summary";

const entry = (outcome: ActivityOutcome, at: string, agent = "Claude Code", action = "ls"): ActivityEntry => ({
  at,
  source: "claude-code",
  agent,
  action,
  target: "shell:///p",
  outcome,
  detail: null,
  ref: `toolu_${at}`,
});
const intact = { ok: true, entries: 10, reason: null };
const period = { since: "2026-11-06T00:00:00.000Z", until: "2026-11-06T23:59:59.000Z", receipts: intact, journal: intact };

describe("le bilan", () => {
  it("passé seul, demandé à une personne, bloqué ; hors de la période : ignoré", () => {
    const summary = summarize(
      [
        entry("done", "2026-11-06T09:00:00.000Z"),
        entry("failed", "2026-11-06T09:01:00.000Z"),
        entry("approved-done", "2026-11-06T09:02:00.000Z", "Cursor"),
        entry("refused-by-person", "2026-11-06T09:03:00.000Z"),
        entry("waiting", "2026-11-06T09:04:00.000Z"),
        entry("refused", "2026-11-06T09:05:00.000Z", "Claude Code", "rm -rf ~"),
        entry("done", "2026-11-05T23:59:00.000Z"),
      ],
      period,
    );
    expect(summary).toMatchObject({ total: 6, passed: 2, asked: 3, refusedByPerson: 1, waiting: 1, blocked: 1 });
    expect(summary.saves.map((s) => s.action)).toEqual(["rm -rf ~"]);
    expect(summary.agents).toEqual([
      { agent: "Claude Code", total: 5 },
      { agent: "Cursor", total: 1 },
    ]);
  });

  it("les actions bloquées : les plus récentes d'abord, bornées", () => {
    const saves = summarize(
      ["09", "11", "10"].map((h) => entry("refused", `2026-11-06T${h}:00:00.000Z`, "Claude Code", `rm ${h}`)),
      { ...period, maxSaves: 2 },
    ).saves;
    expect(saves.map((s) => s.action)).toEqual(["rm 11", "rm 10"]);
  });

  it("« rien n'a été modifié » seulement si les DEUX chaînes sont intactes", () => {
    expect(summarize([], period).proof.intact).toBe(true);
    expect(summarize([], { ...period, journal: { ok: false, entries: 3, reason: "line 2 edited" } }).proof.intact).toBe(false);
    expect(summarize([], { ...period, receipts: { ok: false, entries: 3, reason: "gap" } }).proof.intact).toBe(false);
  });
});
