/**
 * `boundStoredResult` : ce que la base garde d'une réponse d'outil (journal §5.74).
 */
import { describe, expect, it } from "vitest";

import { hashResult } from "../action/canonical";
import { boundStoredResult, STORED_RESULT_LIMIT } from "../gateway/stored-result";

describe("la réponse gardée en base", () => {
  it("une réponse ordinaire est gardée telle quelle", () => {
    const small = { mode: "STDIO_MCP", summary: "note 1 créée", result: { content: [{ type: "text", text: "note 1 créée" }] } };
    expect(boundStoredResult(small)).toBe(small);
  });

  it("au-delà de la limite : les petits champs restent, les gros deviennent taille + empreinte, et l'ensemble est empreint", () => {
    const content = { content: [{ type: "text", text: "x".repeat(STORED_RESULT_LIMIT + 10) }] };
    const big = { mode: "STDIO_MCP", url: "https://exemple.test/1", dispatched: true, result: content };
    const kept = boundStoredResult(big);
    expect(kept).toMatchObject({ mode: "STDIO_MCP", url: "https://exemple.test/1", dispatched: true });
    expect(kept.result).toEqual({ tronque: true, taille: expect.any(Number), empreinte: hashResult(content) });
    expect(kept.reponseBornee).toMatchObject({ empreinte: hashResult(big) });
    expect(JSON.stringify(kept).length).toBeLessThan(1_000);
  });
});
