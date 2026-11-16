/**
 * LE FIL D'ACTUALITÉ (`server/local-feed.ts`) et LE JOURNAL DES ÉVÉNEMENTS (`local-events.ts`) :
 * des phrases simples avec la mascotte ; les actions ordinaires regroupées ; et ce qui se
 * partage ne porte RIEN de privé (chemin, fichier, commande, numéro de processus, serveur).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Approval, Execution } from "@shared/types";

import { LocalEvents } from "../local-events";
import { buildFeed } from "../local-feed";

const execution = (over: Partial<Execution>): Execution =>
  ({ id: "exe_1", agentId: "agt", agentName: "agy", action: "mcp.fichiers.read_file", target: "mcp://fichiers/read_file", status: "allowed", risk: "low", durationMs: 3, cost: 0, timestamp: "2026-11-11T10:05:00Z", input: {}, decision: "allow", decisionReason: "", policyEvaluated: null, policyId: null, result: "", audit: [], ...over }) as Execution;

describe("le journal des événements", () => {
  it("chaque événement inscrit, relu du plus récent au plus ancien", () => {
    let clock = Date.parse("2026-11-11T10:00:00Z");
    const events = new LocalEvents(mkdtempSync(join(tmpdir(), "oathrion-journal-")), () => new Date((clock += 1_000)));
    events.record({ kind: "paused", agent: "agy", detail: "/home/p/.local/bin/agy (process 42)" });
    events.record({ kind: "stopped", agent: "agy", by: "you, from the notification" });
    expect(events.list().map((e) => e.kind)).toEqual(["stopped", "paused"]);
    expect(events.list()[1]).toMatchObject({ agent: "agy", detail: "/home/p/.local/bin/agy (process 42)" });
  });
});

describe("le fil", () => {
  const events = [
    { id: "evt_1", at: "2026-11-11T10:00:00Z", kind: "paused" as const, agent: "agy", detail: "/home/p/.local/bin/agy (process 108044)" },
    { id: "evt_2", at: "2026-11-11T10:01:00Z", kind: "stopped" as const, agent: "agy", by: "you, from the notification" },
    { id: "evt_3", at: "2026-11-11T10:02:00Z", kind: "decoy" as const, agent: "decoy", detail: "~/.aws/credentials.backup" },
  ];
  const approvals = [
    { id: "apr_a", executionId: "exe_w", agentId: "agt", agentName: "Claude Code", title: "Approval required — mcp.fichiers.write file · mcp://fichiers/write_file", summary: "", requestedValue: "", policyId: "p", policyName: "p", policyLimit: "", risk: "medium", status: "approved", requestedAt: "2026-11-11T09:59:00Z", resolvedAt: "2026-11-11T10:03:00Z" },
    { id: "apr_b", agentId: "agt", agentName: "Claude Code", title: "x", summary: "", requestedValue: "", policyId: "p", policyName: "p", policyLimit: "", risk: "medium", status: "pending", requestedAt: "2026-11-11T10:04:00Z" },
  ] as unknown as Approval[];
  const executions = [
    execution({ id: "exe_r1", timestamp: "2026-11-11T10:05:00Z" }),
    execution({ id: "exe_r2", timestamp: "2026-11-11T10:20:00Z", action: "mcp.fichiers.list_directory" }),
    execution({ id: "exe_b", timestamp: "2026-11-11T10:30:00Z", status: "blocked", action: "mcp.fichiers.delete_file", target: "mcp://fichiers/delete_file" }),
  ];
  const feed = buildFeed({ events, approvals, executions });

  it("des phrases simples, avec la mascotte ; le plus récent d'abord ; une demande en attente n'y est pas encore", () => {
    expect(feed.map((i) => i.title)).toEqual([
      "Oathrion blocked Nova (agy): delete file.",
      "Nova (agy) did 2 things through Oathrion: read file, list directory.",
      "Ember (Claude Code) asked to write file; you approved.",
      "Something read one of your decoys: no honest task does that.",
      "You stopped Nova (agy).",
      "Nova (agy) was paused: it was running without Oathrion's protection.",
    ]);
    expect(feed.find((i) => i.id === "evt_1")).toMatchObject({ mascot: { id: "nova", name: "Nova" }, tone: "warn", detail: "/home/p/.local/bin/agy (process 108044)" });
  });

  it("la même chose dite plusieurs fois en dix minutes : un seul élément, « · 5 times »", () => {
    const stops = Array.from({ length: 5 }, (_, i) => ({ id: `evt_s${String(i)}`, at: `2026-11-11T11:0${String(i)}:00Z`, kind: "stopped" as const, agent: "agy" }));
    const grouped = buildFeed({ events: [...stops, { id: "evt_old", at: "2026-11-11T09:00:00Z", kind: "stopped" as const, agent: "agy" }], approvals: [], executions: [] });
    expect(grouped.map((i) => i.title)).toEqual(["You stopped Nova (agy) · 5 times.", "You stopped Nova (agy)."]);
  });

  it("ce qui se partage ne porte rien de privé", () => {
    for (const item of feed) {
      expect(item.share).not.toMatch(/\/|~|process \d|fichiers|credentials|\.backup|mcp\./);
      if (item.detail) expect(item.share).not.toContain(item.detail);
    }
  });
});

describe("une commande de Claude Code dans le fil (16 novembre)", () => {
  it("« asked to run a command » ; la commande, dessous", () => {
    const approval = {
      id: "apr_c",
      executionId: "exe_c",
      agentId: "agt",
      agentName: "Claude Code",
      title: "mcp.claude-code.shell · shell:///p",
      summary: "",
      requestedValue: "",
      policyId: "p",
      policyName: "p",
      policyLimit: "",
      risk: "medium",
      status: "approved",
      requestedAt: "2026-11-16T09:00:00Z",
      resolvedAt: "2026-11-16T09:01:00Z",
      context: [
        { label: "Action", value: "mcp.claude-code.shell" },
        { label: "Target", value: "shell:///p" },
        { label: "command", value: "git push origin main" },
      ],
    } as unknown as Approval;
    const [item] = buildFeed({ events: [], approvals: [approval], executions: [] });
    expect(item).toMatchObject({ title: "Ember (Claude Code) asked to run a command; you approved.", detail: "“git push origin main”" });
  });
});
