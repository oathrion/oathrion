import { describe, expect, it } from "vitest";

import { toCsv } from "./activity-export";

describe("l'export CSV de la chronologie", () => {
  it("une ligne par action, les virgules et les guillemets d'une commande sans décalage", () => {
    const csv = toCsv([
      { at: "2026-11-05T15:54:00.000Z", agent: "Claude Code", source: "claude-code", action: 'git commit -m "a, b"', target: "shell:///p", outcome: "approved-done", detail: null, ref: "toolu_1" },
    ]);
    const [header, row] = csv.split("\n");
    expect(header).toBe("at,agent,source,action,target,outcome,detail,ref,would_have_deleted");
    expect(row).toBe('"2026-11-05T15:54:00.000Z","Claude Code","claude-code","git commit -m ""a, b""","shell:///p","approved-done","","toolu_1",""');
  });
});
