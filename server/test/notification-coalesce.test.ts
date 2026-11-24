/**
 * Regrouper les notifications rapprochées (`server/notifications/coalesce.ts`) : la première part
 * tout de suite, les suivantes de la fenêtre partent ensemble, et seulement si elles attendent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coalesced } from "../notifications/coalesce";
import { desktopText } from "../notifications/desktop";
import type { NotificationEvent } from "../notifications/types";

const event = (n: number, data: Record<string, unknown> = { action: "mcp.files.create_directory" }): NotificationEvent => ({
  id: `evt_${String(n)}`,
  type: "approval.requested",
  at: "t",
  title: `Approval required — request ${String(n)}`,
  summary: "",
  risk: "medium",
  agentId: "agt",
  agentName: "Claude Code",
  executionId: `exe_${String(n)}`,
  approvalId: `apr_${String(n)}`,
  policyId: null,
  policyName: null,
  data,
});

describe("regrouper les notifications", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(stillPending: (id: string | null) => boolean = () => true) {
    const sent: NotificationEvent[] = [];
    const deliver = coalesced(
      async (e) => {
        sent.push(e);
        return { channelId: "c", eventId: e.id, at: "t", ok: true, detail: "sent" };
      },
      "c",
      { windowMs: 60_000, pending: async (id) => stillPending(id), now: () => Date.now() },
    );
    return { sent, deliver };
  }

  it("la première part tout de suite ; les trois suivantes de la minute partent en UNE", async () => {
    const { sent, deliver } = setup();
    await deliver(event(1));
    expect(sent.map((e) => e.id)).toEqual(["evt_1"]);
    await vi.advanceTimersByTimeAsync(5_000);
    for (const n of [2, 3, 4]) await deliver(event(n));
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ approvalId: null, data: { grouped: 3 } });
    /* Plusieurs questions du même agent : son nom, puis « I have 3 questions for you. ». */
    expect(desktopText(sent[1]!).title).toBe(sent[1]!.agentName);
    expect(desktopText(sent[1]!).body).toMatch(/^I have 3 questions for you\./);
  });

  it("celles tranchées entre-temps ne dérangent personne ; une seule restante part telle quelle", async () => {
    const decided = new Set(["apr_2", "apr_3"]);
    const { sent, deliver } = setup((id) => !decided.has(id ?? ""));
    await deliver(event(1));
    for (const n of [2, 3, 4]) await deliver(event(n));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.map((e) => e.id)).toEqual(["evt_1", "evt_4"]);
  });

  it("après un moment calme, la suivante repart tout de suite", async () => {
    const { sent, deliver } = setup();
    await deliver(event(1));
    await vi.advanceTimersByTimeAsync(61_000);
    await deliver(event(2));
    expect(sent.map((e) => e.id)).toEqual(["evt_1", "evt_2"]);
  });
});

describe("ce que dit la notification", () => {
  it("une commande du hook Claude Code : la commande elle-même", () => {
    expect(desktopText(event(1, { action: "mcp.claude-code.shell", command: "git push" })).title).toBe("Claude Code wants to run: git push");
    expect(desktopText(event(1, { action: "mcp.claude-code.file_write", target: "file:///p/notes.txt" })).title).toBe("Claude Code wants to write: /p/notes.txt");
  });
});
