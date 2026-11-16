/**
 * LES RÉPONSES « WAS OATHRION RIGHT? », RELUES (`server/local-feedback.ts`) : les plus récentes
 * d'abord, une ligne coupée n'empêche pas de lire les autres, et ce qui a été partagé est noté.
 */
import { appendFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FEEDBACK_SHARED_FILE, markFeedbackShared, readFeedback } from "../local-feedback";
import { FEEDBACK_FILE, recordFeedback } from "../local-notifications";

describe("les réponses gardées sur la machine", () => {
  it("rien encore : une liste vide, jamais partagée", () => {
    expect(readFeedback(mkdtempSync(join(tmpdir(), "oathrion-feedback-")))).toEqual({ answers: [], sharedUntil: null });
  });

  it("les plus récentes d'abord ; une ligne coupée est ignorée", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-feedback-"));
    recordFeedback(dir, { about: "paused agy", decision: "Stopped", right: true }, new Date("2026-11-16T20:00:00Z"));
    appendFileSync(join(dir, FEEDBACK_FILE), '{"at":"2026-11-16T20:01');
    appendFileSync(join(dir, FEEDBACK_FILE), "\n");
    recordFeedback(dir, { about: "asked you before Cursor acted", decision: "Rejected", right: false }, new Date("2026-11-16T21:00:00Z"));
    const { answers } = readFeedback(dir);
    expect(answers.map((a) => [a.about, a.right])).toEqual([
      ["asked you before Cursor acted", false],
      ["paused agy", true],
    ]);
  });

  it("partagé jusqu'à une date, dans un fichier lisible par la seule personne", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-feedback-"));
    markFeedbackShared(dir, "2026-11-16T21:30:00.000Z");
    expect(readFeedback(dir).sharedUntil).toBe("2026-11-16T21:30:00.000Z");
    expect(statSync(join(dir, FEEDBACK_SHARED_FILE)).mode & 0o777).toBe(0o600);
    expect(() => markFeedbackShared(dir, "hier")).toThrow(/date/);
  });
});
