/**
 * La démonstration du mandat vérifiable, jouée en entier : la banque exécute ce que le mandat
 * permet, refuse le reste elle-même, et contresigne chacune de ses réponses.
 */
import { describe, expect, it } from "vitest";

import { verifyCountersigned } from "../../sdk/verify/src";
import { runDemo } from "./demo";

describe("la banque fictive et le mandat d'Acme", () => {
  it("3 200 € exécuté ; la falsification et le mandat révoqué refusés par la banque ; tout contresigné", async () => {
    const lines: string[] = [];
    const { answers, ledger } = await runDemo((line) => lines.push(line));
    expect(answers.map((a) => [a.status, a.reason ?? null])).toEqual([
      ["executed", null],
      ["refused", "the authorization is for another action"],
      ["refused", "the mandate has been revoked"],
    ]);
    expect(answers.every((a) => a.receipt !== null && verifyCountersigned(a.receipt).ok)).toBe(true);
    expect(ledger).toEqual([{ reference: "F-2026-114", amount: 3_200, beneficiary: "FR7630006000011234567890189" }]);
    expect(lines.join("\n")).toMatch(/Not granted: above the mandate's 5,000 EUR per action/);
    expect(lines.join("\n")).toMatch(/Not granted: the mandate has been revoked/);
    expect(lines.join("\n")).toMatch(/Acme's record: 3 receipts signed by both sides/);
  });
});
