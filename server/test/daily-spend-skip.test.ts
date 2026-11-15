/**
 * La dépense du jour n'est sommée que si une règle la lit (journal §5.76).
 *
 * La somme parcourt chaque exécution autorisée de l'agent sur 24 h : 17 à 28 ms à 100 000
 * exécutions, mesuré sur la base du banc de 12 h. Sans budget journalier, elle est sautée.
 * Avec un budget, elle est toujours lue : `daily-budget-concurrency.test.ts` le prouve
 * de bout en bout.
 */
import { describe, expect, it } from "vitest";

import { readsDailySpend } from "../services/decision-service";

describe("la dépense du jour", () => {
  it("n'est lue que si une règle fixe un budget journalier", () => {
    expect(readsDailySpend([])).toBe(false);
    expect(readsDailySpend([{ condition: { kind: "maxAmount" } }, { condition: { kind: "blockTarget" } }])).toBe(false);
    expect(readsDailySpend([{ condition: { kind: "maxAmount" } }, { condition: { kind: "dailySpendAtMost" } }])).toBe(true);
  });
});
