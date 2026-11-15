/**
 * La veille permanente (`watch.ts`) : un service systemd de la session, relancé s'il s'arrête ;
 * sans systemd, le démarrage automatique du bureau ; et `--undo`. `systemctl` est simulé : les
 * essais ne touchent jamais aux services de la machine.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OutsideAllowances } from "../../server/local-agent-watch";
import { autostartEntry, runWatch, serviceUnit, SERVICE_NAME, watchInstaller } from "./watch";

const setup = (systemdWorks: boolean) => {
  const home = mkdtempSync(join(tmpdir(), "oathrion-watch-"));
  const calls: string[] = [];
  const started: string[] = [];
  const installer = watchInstaller({
    home,
    script: __filename,
    env: { PATH: "/usr/bin:/bin" },
    systemctl: (args) => {
      calls.push(args.join(" "));
      return systemdWorks;
    },
    startNow: (_node, script) => started.push(script),
  });
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), env: {}, home, script: __filename, installer };
  return { home, calls, started, installer, io, lines, unit: join(home, ".config", "systemd", "user", SERVICE_NAME), autostart: join(home, ".config", "autostart", "oathrion-watch.desktop") };
};

describe.runIf(process.platform === "linux")("oathrion watch --always", () => {
  it("avec systemd : un service relancé s'il s'arrête, démarré tout de suite ; --undo l'arrête et le retire", async () => {
    const t = setup(true);
    expect(await runWatch(["--always"], t.io)).toBe(0);
    expect(readFileSync(t.unit, "utf8")).toMatch(/^Restart=always$/m);
    expect(t.calls).toEqual(["daemon-reload", `enable --now ${SERVICE_NAME}`]);
    expect(t.lines.join("\n")).toMatch(/started again if it stops/);
    expect(t.installer.installed()).toBe(true);

    expect(await runWatch(["--always", "--undo"], t.io)).toBe(0);
    expect(t.calls.slice(2)).toEqual([`disable --now ${SERVICE_NAME}`, "daemon-reload"]);
    expect(existsSync(t.unit)).toBe(false);
    expect(t.installer.installed()).toBe(false);
  });

  it("un ancien démarrage du bureau, là où systemd répond : pas la veille permanente ; remplacé par le service", async () => {
    const t = setup(true);
    mkdirSync(join(t.home, ".config", "autostart"), { recursive: true });
    writeFileSync(t.autostart, autostartEntry("/usr/bin/node", "/old/oathrion.mjs"));
    expect(t.installer.installed()).toBe(false);
    expect(t.installer.install()).toBe("systemd");
    expect(existsSync(t.autostart)).toBe(false);
    expect(existsSync(t.unit)).toBe(true);
  });

  it("sans systemd : le démarrage automatique du bureau, et la veille lancée tout de suite", async () => {
    const t = setup(false);
    expect(await runWatch(["--always"], t.io)).toBe(0);
    expect(existsSync(t.unit)).toBe(false);
    expect(readFileSync(t.autostart, "utf8")).toMatch(/^Exec=".*" ".*watch\.test\.ts" watch$/m);
    expect(t.started).toHaveLength(1);
    expect(await runWatch(["--always", "--undo"], t.io)).toBe(0);
    expect(existsSync(t.autostart)).toBe(false);
  });
});

describe("oathrion watch --forget", () => {
  it("liste les agents autorisés hors de la prison, et en retire un par son nom", async () => {
    const home = mkdtempSync(join(tmpdir(), "oathrion-oubli-"));
    const env = { OATHRION_WRAP_HOME: home };
    mkdirSync(join(home, "_local"), { recursive: true });
    const allowances = new OutsideAllowances(join(home, "_local"));
    allowances.allow("/home/p/.local/bin/agy", "agy", "you, from the notification");
    allowances.allow("/home/p/claude-code/claude", "claude", "npx oathrion (run from this agent)");
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), env, home, script: __filename };
    expect(await runWatch(["--forget"], io)).toBe(0);
    expect(lines.join("\n")).toMatch(/agy {2}\/home\/p\/\.local\/bin\/agy/);
    expect(await runWatch(["--forget", "agy"], io)).toBe(0);
    expect(allowances.has("/home/p/.local/bin/agy")).toBe(false);
    expect(allowances.has("/home/p/claude-code/claude")).toBe(true);
    expect(await runWatch(["--forget", "agy"], io)).toBe(2);
  });
});

describe("les fichiers de la veille", () => {
  it("un chemin avec un guillemet reste une seule commande", () => {
    expect(autostartEntry("/usr/bin/node", '/home/p/a "b"/oathrion.mjs')).toContain('Exec="/usr/bin/node" "/home/p/a \\"b\\"/oathrion.mjs" watch');
    expect(serviceUnit("/usr/bin/node", "/x/oathrion.mjs", "/usr/bin")).toContain('ExecStart="/usr/bin/node" "/x/oathrion.mjs" watch');
  });
});
