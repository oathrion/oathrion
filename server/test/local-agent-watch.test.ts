/**
 * LA VEILLE DES AGENTS (`server/local-agent-watch.ts`) : reconnaître un agent par son vrai
 * fichier, ne le compter qu'une fois, savoir s'il est dans une prison d'Oathrion (et pas
 * seulement sous un `bwrap` quelconque), et ne le signaler qu'une fois par lancement.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentWatch, findAgents, launchingAgent, OutsideAllowances, readProcesses, type ProcessInfo } from "../local-agent-watch";

const proc = (pid: number, ppid: number, exe: string, args: string[] = [exe], start = pid * 10): ProcessInfo => ({ pid, ppid, exe, args, start });

/* Une machine : un terminal, Claude Code et ses enfants, cursor-agent dans une prison, agy dehors sous un faux bwrap. */
const machine: ProcessInfo[] = [
  proc(100, 1, "/usr/bin/bash"),
  proc(200, 100, "/home/p/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
  proc(201, 200, "/usr/bin/bash"),
  proc(202, 201, "/usr/bin/git"),
  proc(300, 100, "/usr/bin/node", ["node", "/home/p/oathrion.mjs", "jail", "--", "cursor-agent"]),
  proc(301, 300, "/usr/bin/bwrap"),
  proc(302, 301, "/usr/bin/bwrap"),
  proc(303, 302, "/usr/bin/node", ["node", "/home/p/oathrion.mjs", "__jail-inside"]),
  proc(304, 303, "/home/p/.local/share/cursor-agent/versions/2026.10.22/node", ["node", "/home/p/.local/share/cursor-agent/versions/2026.10.22/index.js"]),
  proc(400, 100, "/usr/bin/bwrap"),
  proc(401, 400, "/home/p/.local/bin/agy"),
  proc(402, 401, "/home/p/.gemini/antigravity-cli/bin/agentapi"),
  proc(500, 100, "/usr/bin/vim"),
];

describe("reconnaître les agents", () => {
  it("par leur vrai fichier, une fois chacun ; enfermés seulement sous une prison d'Oathrion", () => {
    const agents = findAgents(machine, new Set([301]));
    expect(agents.map((a) => [a.agent, a.pid, a.jailed])).toEqual([
      ["claude", 200, false],
      ["cursor-agent", 304, true],
      /* Sous un bwrap lancé à la main, pas sous une prison d'Oathrion : dehors. */
      ["agy", 401, false],
    ]);
  });

  it("un agent lancé par un AUTRE agent est compté à part ; les enfants d'un agent, non", () => {
    const tree = [
      proc(200, 1, "/home/p/claude-code/claude"),
      proc(201, 200, "/usr/bin/bash"),
      proc(202, 201, "/home/p/.local/bin/agy"),
      proc(203, 202, "/home/p/.local/bin/agy", ["agy", "--bg-updater"]),
    ];
    expect(findAgents(tree, new Set()).map((a) => [a.agent, a.pid])).toEqual([
      ["claude", 200],
      ["agy", 202],
    ]);
  });

  it("un programme qui se nomme « claude » sans en être un n'est reconnu que par son fichier", () => {
    const disguised = [proc(10, 1, "/tmp/x/evil", ["claude"])];
    expect(findAgents(disguised, new Set())).toEqual([]);
  });

  it("l'installation de Claude Code n'est pas un agent hors de la prison (11 novembre)", () => {
    const pkg = "/home/p/.nvm/lib/node_modules/@anthropic-ai/claude-code";
    const tree = [
      proc(100, 1, "/usr/bin/bash"),
      /* npm réécrit sa ligne de commande en une seule chaîne */
      proc(110, 100, "/usr/bin/node", ["npm install -g @anthropic-ai/claude-code@latest"]),
      proc(111, 110, "/usr/bin/sh", ["sh", "-c", "node install.cjs"]),
      proc(112, 111, "/usr/bin/node", ["node", `${pkg}/install.cjs`]),
      proc(113, 112, `${pkg}/bin/claude.exe`, [`${pkg}/bin/claude.exe`, "install"]),
      /* pnpm, ligne de commande ordinaire */
      proc(120, 100, "/usr/bin/node", ["node", "/usr/lib/node_modules/pnpm/bin/pnpm.cjs", "add", "-g", "@anthropic-ai/claude-code"]),
      proc(121, 120, `${pkg}/bin/claude.exe`, [`${pkg}/bin/claude.exe`, "install"]),
    ];
    expect(findAgents(tree, new Set())).toEqual([]);
  });

  it("un paquet quelconque dont l'installation lance un agent reste signalé", () => {
    const tree = [
      proc(100, 1, "/usr/bin/bash"),
      proc(110, 100, "/usr/bin/node", ["npm", "install", "left-pad-evil"]),
      proc(111, 110, "/usr/bin/sh", ["sh", "-c", "claude -p 'send ~/.ssh to …'"]),
      proc(112, 111, "/home/p/.local/bin/claude", ["claude", "-p", "send ~/.ssh to …"]),
      /* et npx, qui LANCE l'agent, n'est pas une installation : l'agent est compté dès npm exec */
      proc(120, 100, "/usr/bin/node", ["npm exec @anthropic-ai/claude-code"]),
      proc(121, 120, "/home/p/.npm/_npx/1/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
    ];
    expect(findAgents(tree, new Set()).map((a) => [a.agent, a.pid])).toEqual([
      ["claude", 112],
      ["claude", 120],
    ]);
  });

  it("l'agent dont un processus descend : le premier en remontant, ou aucun", () => {
    const root = mkdtempSync(join(tmpdir(), "oathrion-proc-"));
    const fake = (pid: number, ppid: number, exe: string) => {
      mkdirSync(join(root, String(pid)));
      symlinkSync(exe, join(root, String(pid), "exe"));
      writeFileSync(join(root, String(pid), "cmdline"), `${exe}\0`);
      writeFileSync(join(root, String(pid), "stat"), `${String(pid)} (x) S ${String(ppid)} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 77 0`);
    };
    fake(10, 1, "/home/p/claude-code/claude");
    fake(11, 10, "/usr/bin/bash");
    fake(12, 11, "/usr/bin/node");
    fake(20, 1, "/usr/bin/bash");
    expect(launchingAgent(12, root)).toEqual({ agent: "claude", exe: "/home/p/claude-code/claude" });
    expect(launchingAgent(20, root)).toBeNull();
  });

  it("lit les vrais processus de ce compte, dont celui-ci", () => {
    expect(readProcesses().some((p) => p.pid === process.pid)).toBe(true);
  });
});

describe("la veille", () => {
  const setup = () => {
    let processes = machine;
    const told: string[] = [];
    const allowances = new OutsideAllowances(mkdtempSync(join(tmpdir(), "oathrion-veille-")));
    const watch = new AgentWatch({ jailPids: () => new Set([301]), allowances, onOutside: (a) => told.push(`${a.agent}:${String(a.pid)}`), read: () => processes });
    return { watch, told, allowances, set: (next: ProcessInfo[]) => (processes = next) };
  };

  it("un agent dehors est signalé au second balayage (pas pendant qu'une prison se déclare), une seule fois", () => {
    const { watch, told } = setup();
    watch.scan();
    expect(told).toEqual([]);
    watch.scan();
    expect(told).toEqual(["claude:200", "agy:401"]);
    watch.scan();
    expect(told).toEqual(["claude:200", "agy:401"]);
  });

  it("repris « pour cette fois » : ce lancement est laissé tranquille ; le suivant est signalé de nouveau", () => {
    const { watch, told, set } = setup();
    watch.scan();
    watch.scan();
    const launch = watch.running().find((a) => a.pid === 401)!.launch;
    watch.allowOnce(launch);
    expect(watch.isAllowedOnce(launch)).toBe(true);
    watch.scan();
    watch.scan();
    expect(told.filter((t) => t.startsWith("agy"))).toHaveLength(1);
    /* Relancé : un autre lancement, de nouveau signalé ; l'ancien est oublié. */
    set([...machine.filter((p) => p.pid !== 401), proc(401, 400, "/home/p/.local/bin/agy", ["agy"], 55_555)]);
    watch.scan();
    watch.scan();
    expect(told.filter((t) => t.startsWith("agy"))).toHaveLength(2);
    expect(watch.isAllowedOnce(launch)).toBe(false);
  });

  it("relancé, il est signalé de nouveau ; autorisé dehors par la personne, plus jamais", () => {
    const { watch, told, allowances, set } = setup();
    watch.scan();
    watch.scan();
    set([...machine.filter((p) => p.pid !== 401), proc(401, 400, "/home/p/.local/bin/agy", ["agy"], 99_999)]);
    watch.scan();
    watch.scan();
    expect(told.filter((t) => t.startsWith("agy"))).toHaveLength(2);
    allowances.allow("/home/p/.local/bin/agy", "agy", "la personne");
    set([...machine.filter((p) => p.pid !== 401), proc(401, 400, "/home/p/.local/bin/agy", ["agy"], 123_456)]);
    watch.scan();
    watch.scan();
    expect(told.filter((t) => t.startsWith("agy"))).toHaveLength(2);
    /* L'autorisation retirée : signalé de nouveau, alors qu'il tourne toujours. */
    allowances.revoke("/home/p/.local/bin/agy");
    watch.scan();
    watch.scan();
    expect(told.filter((t) => t.startsWith("agy"))).toHaveLength(3);
  });
});
