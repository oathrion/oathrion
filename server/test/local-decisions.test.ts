/**
 * LA DÉCISION DANS LA CONSOLE (`server/local-decisions.ts`) : sous macOS et Windows, « Decide »
 * ouvre la carte de la notification dans la console — ses boutons agissent une seule fois, par la
 * même voie que la fenêtre de Linux, puis « Was this right? » et le partage.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { DecisionDesk } from "../local-decisions";
import { DesktopChannel } from "../notifications/desktop";
import type { NotificationEvent } from "../notifications/types";

const paused = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  id: "program_demo_1",
  type: "approval.requested",
  at: "2026-11-11T20:00:00Z",
  title: "Nova (demo) is paused",
  summary: "A demo: no real agent was paused. Try Stop, then Share it.",
  risk: "high",
  agentId: "demo",
  agentName: "demo",
  executionId: null,
  approvalId: null,
  policyId: null,
  policyName: null,
  data: {
    custom: true,
    mascot: { id: "nova", name: "Nova", path: "/x/nova.png" },
    actions: [
      { id: "stop", label: "Stop" },
      { id: "resume", label: "Resume this time" },
    ],
  },
  ...over,
});

function desk() {
  const acted: string[] = [];
  const judged: [boolean, string][] = [];
  const d = new DecisionDesk();
  d.bind({
    act: (_event, actionId) => {
      acted.push(actionId);
      return { text: "Stopped. Nova won't do anything.", share: "Oathrion caught my AI agent, and I stopped it in one click." };
    },
    feedback: (_event, right, decision) => judged.push([right, decision]),
  });
  return { d, acted, judged };
}

describe("la décision dans la console", () => {
  it("garde une notification à boutons, montre ses mots, sa mascotte et ses boutons", () => {
    const { d } = desk();
    const id = d.keep(paused());
    expect(id).toBe("program_demo_1");
    expect(d.view(id!)).toMatchObject({
      title: "Nova (demo) is paused",
      mascot: { id: "nova", name: "Nova" },
      danger: false,
      actions: [{ id: "stop", label: "Stop" }, { id: "resume", label: "Resume this time" }],
      done: null,
      share: null,
    });
  });

  it("une approbation reçoit Approve / Reject, avec les mots de la notification", () => {
    const { d } = desk();
    const id = d.keep(paused({ id: "ntf_1", approvalId: "apr_1", data: { action: "mcp.fichiers.write_file" } }));
    expect(d.view(id!)).toMatchObject({ title: 'demo wants to use "write_file"', actions: [{ id: "approve" }, { id: "reject" }, { id: "allow-hour" }] });
  });

  it("rien à décider, rien à garder", () => {
    expect(desk().d.keep(paused({ data: { custom: true } }))).toBeNull();
  });

  it("un bouton agit une seule fois ; un choix inconnu est refusé ; puis une réponse au feedback, et la phrase à partager", async () => {
    const { d, acted, judged } = desk();
    const id = d.keep(paused())!;
    expect(await d.choose(id, "allow")).toMatch(/Unknown choice/);
    expect(await d.choose(id, "stop")).toEqual({ text: "Stopped. Nova won't do anything.", share: "Oathrion caught my AI agent, and I stopped it in one click." });
    expect(await d.choose(id, "resume")).toMatchObject({ text: "Stopped. Nova won't do anything." });
    expect(acted).toEqual(["stop"]);
    expect(d.view(id)!.share).toBe("Oathrion caught my AI agent, and I stopped it in one click.");
    expect(d.judge(id, true)).toBe(true);
    expect(d.judge(id, false)).toBe(false);
    expect(judged).toEqual([[true, "Stopped. Nova won't do anything."]]);
  });

  it("macOS : « Decide » donne la notification elle-même, que la console garde", async () => {
    const { d } = desk();
    const opened: (string | null)[] = [];
    /* Le dialogue de macOS, dont on a cliqué « Decide ». */
    const spawnImpl = () => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      (child as unknown as { stdout: PassThrough }).stdout = stdout;
      setTimeout(() => {
        stdout.end("button returned:Decide, gave up:false\n");
        child.emit("exit", 0);
      }, 5);
      return child;
    };
    await new DesktopChannel({ platform: "darwin", spawnImpl, onDecide: (_id, event) => opened.push(event ? d.keep(event) : null) }).deliver(paused());
    await new Promise((done) => setTimeout(done, 30));
    expect(opened).toEqual(["program_demo_1"]);
  });
});
