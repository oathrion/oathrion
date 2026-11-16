/**
 * « ALLOW 1 HOUR » (16 novembre) : une permission bornée dans le temps et dans l'objet. La demande
 * couverte suit son chemin, puis le pivot l'approuve au nom de la permission, sans déranger
 * personne ; une permission expirée ne vaut plus rien ; jamais pour une commande de Claude Code.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { HOUR_PASS_MS, HourPasses, passable } from "../local-hour-passes";
import { registerLocalNotifications } from "../local-notifications";
import { Notifier } from "../notifications";
import { notificationActions } from "../notifications/desktop";

const freshDir = () => mkdtempSync(join(tmpdir(), "oathrion-hour-pass-"));

describe("la permission d'une heure", () => {
  it("couvre cet agent et cet outil, pas les autres ; jamais une commande de Claude Code", () => {
    const passes = new HourPasses(freshDir());
    passes.grant("agt_cursor", "mcp.fichiers.write_file");
    expect(passes.covers("agt_cursor", "mcp.fichiers.write_file")).not.toBeNull();
    expect(passes.covers("agt_cursor", "mcp.fichiers.delete_file")).toBeNull();
    expect(passes.covers("agt_other", "mcp.fichiers.write_file")).toBeNull();
    expect(passable("mcp.claude-code.shell")).toBe(false);
    expect(() => passes.grant("agt_cursor", "mcp.claude-code.shell")).toThrow(/server behind Oathrion/);
  });

  it("expire au bout d'une heure, et se relit après un redémarrage", () => {
    const dir = freshDir();
    let now = Date.parse("2026-11-16T10:00:00Z");
    new HourPasses(dir, () => now).grant("agt_cursor", "mcp.fichiers.write_file");
    const again = new HourPasses(dir, () => now);
    expect(again.covers("agt_cursor", "mcp.fichiers.write_file")?.until).toBe("2026-11-16T11:00:00.000Z");
    now += HOUR_PASS_MS + 1;
    expect(again.covers("agt_cursor", "mcp.fichiers.write_file")).toBeNull();
  });

  it("le bouton n'apparaît que pour un outil d'un serveur derrière Oathrion", () => {
    const ask = (action: string) => notificationActions({ id: "e", type: "approval.requested", at: "", title: "", summary: "", risk: "medium", agentId: "a", agentName: "a", executionId: "x", approvalId: "apr", policyId: null, policyName: null, data: { action } }).map((a) => a.id);
    expect(ask("mcp.fichiers.write_file")).toEqual(["approve", "reject", "allow-hour"]);
    expect(ask("mcp.claude-code.shell")).toEqual(["approve", "reject"]);
  });
});

describe("une demande couverte : approuvée sans déranger personne", () => {
  /* Un faux notify-send : chaque lancement compte une notification montrée. */
  const desktop = () => {
    const shown: string[][] = [];
    const spawnImpl = (_command: string, args: string[]) => {
      shown.push(args);
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      (child as unknown as { stdout: PassThrough }).stdout = stdout;
      setTimeout(() => {
        stdout.end();
        child.emit("exit", 0);
      }, 5);
      return child;
    };
    return { shown, spawnImpl };
  };
  const approval = (approvalId: string) => ({
    type: "approval.requested" as const,
    title: "Approval required — x",
    summary: "",
    risk: "medium",
    agentId: "agt_cursor",
    agentName: "Cursor",
    executionId: `exe_${approvalId}`,
    approvalId,
    policyId: null,
    policyName: null,
    data: { action: "mcp.fichiers.write_file" },
  });
  const until = async (target: Notifier, count: number) => {
    for (let i = 0; i < 200 && target.recentDeliveries().length < count; i += 1) await new Promise((done) => setTimeout(done, 10));
    return target.recentDeliveries();
  };

  it("sans permission la notification part ; avec, la demande est approuvée en son nom et rien ne s'affiche", async () => {
    const dir = freshDir();
    const passes = new HourPasses(dir);
    const decided: [string, string, string | undefined][] = [];
    const { shown, spawnImpl } = desktop();
    const target = new Notifier();
    registerLocalNotifications(target, {
      stateDir: dir,
      baseUrl: "http://127.0.0.1:1",
      secret: "s".repeat(48),
      desktopAllowed: true,
      popup: false,
      phone: false,
      spawnImpl,
      passes,
      decideApproval: async (approvalId, status, by) => {
        decided.push([approvalId, status, by]);
        return "Approved: the action ran";
      },
    });

    target.emit(approval("apr_1"));
    await until(target, 2);
    expect(shown).toHaveLength(1);
    expect(decided).toEqual([]);

    passes.grant("agt_cursor", "mcp.fichiers.write_file");
    target.emit(approval("apr_2"));
    const deliveries = await until(target, 4);
    expect(shown).toHaveLength(1);
    expect(decided).toEqual([["apr_2", "approved", expect.stringMatching(/^your 1-hour permission \(until /)]]);
    expect(deliveries.map((d) => d.detail)).toEqual(expect.arrayContaining(["Approved: the action ran", "allowed for the hour: no notification"]));
  });
});
