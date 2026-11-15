import { describe, expect, it } from "vitest";

import type { Approval } from "@/types";

import { approvedInARow, decideOnceSuggestion, toolOf } from "./decide-once";

let n = 0;
const approval = (over: Partial<Approval> = {}): Approval =>
  ({
    id: `apr_${String((n += 1))}`,
    agentId: "agt_cursor",
    agentName: "Cursor",
    title: "mcp.files.write file · mcp://files/write_file",
    status: "approved",
    requestedAt: `2026-11-05T10:${String(n).padStart(2, "0")}:00.000Z`,
    resolvedAt: `2026-11-05T10:${String(n).padStart(2, "0")}:30.000Z`,
    ...over,
  }) as Approval;

describe("décider une fois", () => {
  it("l'outil : le titre avant « · », jamais une commande du hook", () => {
    expect(toolOf({ title: "mcp.files.write file · mcp://files/write_file" })).toBe("mcp.files.write file");
    expect(toolOf({ title: "mcp.claude-code.shell · shell:///p" })).toBeNull();
    expect(toolOf({ title: "payment.send 50,00 € · stripe://x" })).toBeNull();
  });

  it("trois approbations de suite : on propose ; un refus remet à zéro", () => {
    const history = [approval({ status: "rejected" }), approval(), approval(), approval()];
    const pending = approval({ status: "pending", resolvedAt: null });
    expect(decideOnceSuggestion(pending, [...history, pending])).toBe(3);
    const refusedLast = [...history, approval({ status: "rejected" })];
    expect(approvedInARow(pending, refusedLast)).toBe(0);
    expect(decideOnceSuggestion(pending, history.slice(0, 3))).toBeNull();
  });

  it("un autre agent, un autre outil, une demande expirée : comptés à part ou ignorés", () => {
    const pending = approval({ status: "pending", resolvedAt: null });
    const history = [
      approval(),
      approval(),
      approval({ status: "expired" }),
      approval({ agentId: "agt_other", status: "rejected" }),
      approval({ title: "mcp.files.delete file · mcp://files/delete_file", status: "rejected" }),
      approval(),
    ];
    expect(approvedInARow(pending, history)).toBe(3);
  });

  it("rien à proposer sur une carte déjà tranchée", () => {
    const history = [approval(), approval(), approval()];
    expect(decideOnceSuggestion(approval(), history)).toBeNull();
  });
});
