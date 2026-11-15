/**
 * `oathrion demo` : la notification sur un agent pour de faux, demandée au pivot ; ce qui est dit
 * dans le terminal ; un pivot sans démo (plus ancien) ou des notifications coupées, dits clairement.
 */
import { describe, expect, it } from "vitest";

import { runDemo } from "./demo";
import type { HubConnection } from "./hub";

function fakeHub(answer: { status: number; body: unknown }) {
  const asked: Record<string, unknown>[] = [];
  const conn = {
    base: "http://127.0.0.1:1",
    dir: "/x",
    secret: "s",
    wasRunning: true,
    op: (body: Record<string, unknown>) => {
      asked.push(body);
      return Promise.resolve(answer);
    },
  } as unknown as HubConnection;
  return { asked, connect: () => Promise.resolve(conn) };
}

function io(connect: () => Promise<HubConnection>, platform: NodeJS.Platform = "linux") {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: {}, platform, connect } };
}

describe("oathrion demo", () => {
  it("demande la démo au pivot, et dit quoi faire : Stop, puis Share it ; rien de réel", async () => {
    const hub = fakeHub({ status: 200, body: { shown: true, detail: "pause" } });
    const run = io(hub.connect);
    expect(await runDemo([], run.io)).toBe(0);
    expect(hub.asked).toEqual([{ op: "demo", kind: "pause" }]);
    expect(run.out.join("\n")).toContain("Oathrion paused Nova, a pretend AI agent");
    expect(run.out.join("\n")).toContain("nothing real was paused");
    expect(run.out.join("\n")).toContain("« Stop », then « Share it »");
  });

  it("hors de Linux : « Decide » ouvre la décision dans la console", async () => {
    const run = io(fakeHub({ status: 200, body: { shown: true, detail: "pause" } }).connect, "darwin");
    expect(await runDemo([], run.io)).toBe(0);
    expect(run.out.join("\n")).toContain("Click « Decide »: your console opens on Nova");
    expect(run.out.join("\n")).not.toContain("top right");
  });

  it("--decoy : la notification rouge ; hors de Linux, pas de « Share it » promis", async () => {
    const hub = fakeHub({ status: 200, body: { shown: true, detail: "decoy" } });
    const run = io(hub.connect, "darwin");
    expect(await runDemo(["--decoy"], run.io)).toBe(0);
    expect(hub.asked).toEqual([{ op: "demo", kind: "decoy" }]);
    expect(run.out.join("\n")).toContain("a decoy was read");
    expect(run.out.join("\n")).not.toContain("Share it");
  });

  it("des notifications coupées : le pivot le dit, la commande le répète", async () => {
    const run = io(fakeHub({ status: 409, body: { shown: false, detail: "Desktop notifications are off." } }).connect);
    expect(await runDemo([], run.io)).toBe(1);
    expect(run.err).toEqual(["Desktop notifications are off."]);
  });

  it("un pivot plus ancien, sans démo : dit comment le relancer", async () => {
    const run = io(fakeHub({ status: 400, body: { error: "op: attach…" } }).connect);
    expect(await runDemo([], run.io)).toBe(1);
    expect(run.err[0]).toContain("older than this one");
  });

  it("une option inconnue est refusée", async () => {
    const run = io(fakeHub({ status: 200, body: {} }).connect);
    expect(await runDemo(["--loud"], run.io)).toBe(2);
    expect(run.err[0]).toContain("Unknown option: --loud");
  });
});
