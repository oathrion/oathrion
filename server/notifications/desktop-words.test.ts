import { describe, expect, it } from "vitest";

import { notificationWords } from "@shared/approval-text";

import { groupedEvent } from "./coalesce";
import { desktopText } from "./desktop";
import type { NotificationEvent } from "./types";

/*
 * 16 novembre, retour des premiers testeurs : « on ne comprend pas la notification, alors on
 * approuve sans regarder ». Elle dit maintenant qui veut faire quoi, sur quoi exactement, et
 * pourquoi Oathrion demande.
 */
const note = { agentName: "claude-code", requestedValue: "", title: "", context: [{ label: "Action", value: "mcp.carnet.create_note" }, { label: "Target", value: "mcp://carnet/create_note" }, { label: "arguments.text", value: "Invoice F-2026-114 paid" }] };

function event(words: ReturnType<typeof notificationWords>, extra: Partial<NotificationEvent> = {}): NotificationEvent {
  return { id: "e1", type: "approval.requested", at: "2026-11-16T06:00:00Z", title: "Approval required — x", summary: "", risk: "medium", agentId: "a", agentName: "claude-code", executionId: "exe_1", approvalId: "apr_1", policyId: null, policyName: null, data: { action: "mcp.carnet.create_note", words }, ...extra };
}

describe("les mots de la notification", () => {
  it("quoi, sur quoi, et la règle qui demande", () => {
    expect(notificationWords(note, "carnet: every write waits for approval")).toEqual({
      headline: "claude-code wants to create note on the carnet server",
      content: "Invoice F-2026-114 paid",
      why: "your rule “carnet: every write waits for approval”",
    });
  });

  it("la raison du hook passe avant la règle, sans le préfixe « Oathrion: »", () => {
    const asked = { ...note, context: [...note.context, { label: "reason", value: "Oathrion: a push leaves this machine." }] };
    expect(notificationWords(asked, "x").why).toBe("a push leaves this machine");
  });

  it("une session qui a lu du contenu extérieur : c'est la raison donnée", () => {
    const tainted = { ...note, context: [...note.context, { label: "untrusted", value: "WebFetch evil.example, at 10:42 UTC" }] };
    expect(notificationWords(tainted, "x").why).toBe("this session read content from outside (WebFetch evil.example, at 10:42 UTC)");
  });

  it("un contenu trop long est coupé", () => {
    const long = { ...note, context: [...note.context.slice(0, 2), { label: "arguments.text", value: "x".repeat(400) }] };
    expect(notificationWords(long, null).content).toHaveLength(158);
  });

  it("la notification les dit ; le téléphone, sans le contenu", () => {
    const words = notificationWords(note, "carnet: every write waits for approval");
    expect(desktopText(event(words))).toEqual({
      title: "claude-code wants to create note on the carnet server",
      body: "“Invoice F-2026-114 paid”\nWhy: your rule “carnet: every write waits for approval”.",
    });
    expect(desktopText(event(words), { content: false }).body).toBe("Why: your rule “carnet: every write waits for approval”.");
  });

  it("plusieurs demandes rapprochées : la liste, pas un renvoi à la console", () => {
    const words = notificationWords(note, null);
    const grouped = groupedEvent([event(words), event({ ...words, headline: "claude-code wants to update issue on the github server" }, { id: "e2" }), event(words, { id: "e3" }), event(words, { id: "e4" })]);
    expect(desktopText(grouped)).toEqual({
      title: "4 requests are waiting for your decision",
      body: "· claude-code wants to create note on the carnet server\n· claude-code wants to update issue on the github server\n· claude-code wants to create note on the carnet server\n· and 1 more\nDecide each one in Oathrion's console.",
    });
  });
});
