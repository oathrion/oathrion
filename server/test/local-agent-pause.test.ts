/**
 * METTRE UN AGENT EN PAUSE (`server/local-agent-pause.ts`) : sur un vrai processus enfant de
 * ce test, jamais un autre. Gelé (cgroup v2) quand la machine le permet, arrêté par signal
 * sinon ; repris où il en était ; arrêté, lui et ce qu'il a lancé.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { descendants, pauseAgent, pausedHow, resumeAgent, stopAgent, stopRequested, sweepPauseGroups } from "../local-agent-pause";

const state = (pid: number) => readFileSync(`/proc/${String(pid)}/status`, "utf8").match(/^State:\s+(\S)/m)?.[1];
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      /* Arrêté par la voie d'Oathrion : son groupe de pause, s'il en a un, s'en va avec lui. */
      stopAgent(child.pid!);
      child.kill("SIGKILL");
    } catch {
      /* déjà parti */
    }
  }
});

describe.runIf(process.platform === "linux")("mettre un agent en pause", () => {
  it("figé, il ne compte plus ; repris, il reprend ; en pause une seconde fois, rien ne change", async () => {
    /* Un « agent » qui compte, et un enfant à lui : la pause les prend tous les deux. */
    const agent = spawn(process.execPath, ["-e", "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); let n=0; setInterval(()=>{n++},10)"], { stdio: "ignore" });
    children.push(agent);
    await wait(400);
    const pid = agent.pid!;
    expect(descendants(pid)).toHaveLength(1);

    const how = pauseAgent(pid);
    expect(["frozen", "stopped"]).toContain(how);
    expect(pausedHow(pid)).toBe(how);
    await wait(200);
    if (how === "stopped") expect(state(pid)).toBe("T");
    /* Déjà en pause : on ne refait rien. */
    expect(pauseAgent(pid)).toBe(how);

    expect(resumeAgent(pid)).toBe(true);
    expect(pausedHow(pid)).toBeNull();
    await wait(100);
    expect(state(pid)).not.toBe("T");
  });

  it("arrêté pendant sa pause : lui et ses enfants s'en vont", async () => {
    const agent = spawn(process.execPath, ["-e", "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.push(agent);
    await wait(400);
    const pid = agent.pid!;
    const [child] = descendants(pid);
    pauseAgent(pid);
    const exited = new Promise((done) => agent.once("exit", done));
    expect(stopAgent(pid)).toBe(true);
    await exited;
    await wait(300);
    expect(() => readFileSync(`/proc/${String(child)}/status`)).toThrow();
  });

  it("arrêté pendant sa pause (pkill, Ctrl+C) : la demande se voit ; dégelé, il s'arrête vraiment", async () => {
    const agent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.push(agent);
    await wait(300);
    const pid = agent.pid!;
    if (pauseAgent(pid) !== "frozen") return;
    expect(stopRequested(pid)).toBe(false);
    process.kill(pid, "SIGTERM");
    await wait(200);
    expect(stopRequested(pid)).toBe(true);
    const exited = new Promise((done) => agent.once("exit", done));
    resumeAgent(pid);
    await exited;
  });

  it("tué de dehors pendant sa pause : son groupe vide est retiré au balayage suivant", async () => {
    const agent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.push(agent);
    await wait(300);
    const pid = agent.pid!;
    if (pauseAgent(pid) !== "frozen") return;
    const group = readFileSync(`/proc/${String(pid)}/cgroup`, "utf8").match(/^0::(.*)$/m)![1]!;
    const exited = new Promise((done) => agent.once("exit", done));
    process.kill(pid, "SIGKILL");
    await exited;
    await wait(300);
    sweepPauseGroups();
    expect(existsSync(`/sys/fs/cgroup${group}`)).toBe(false);
  });
});
