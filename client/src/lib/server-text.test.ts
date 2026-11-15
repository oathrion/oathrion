/**
 * Les phrases fixes du serveur, dans la console anglaise (`server-text.ts`) : affichées telles
 * que le serveur les écrit, et les décisions en capitales lisibles.
 */
import { describe, expect, it } from "vitest";

import { exhaustedReason } from "../../../server/gateway/retryability";
import { contextLabel, decisionLabel, reasonLabel, resultLabel, retryReasonLabel } from "./server-text";

describe("les phrases du serveur, telles quelles", () => {
  it("raisons, résultats, contexte : la phrase du serveur, sans changement", () => {
    expect(retryReasonLabel(exhaustedReason(5))).toBe(exhaustedReason(5));
    expect(reasonLabel("No policy constrains this action.")).toBe("No policy constrains this action.");
    expect(resultLabel("Action denied before reaching the tool.")).toBe("Action denied before reaching the tool.");
    expect(contextLabel("Target")).toBe("Target");
  });

  it("les décisions, en capitales lisibles", () => {
    expect(decisionLabel("allow")).toBe("ALLOWED");
    expect(decisionLabel("require_approval")).toBe("APPROVAL REQUIRED");
    expect(decisionLabel("quarantine")).toBe("QUARANTINE");
  });
});
