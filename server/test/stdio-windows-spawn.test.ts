/**
 * Sous Windows, un serveur MCP déclaré `"command": "npx"` doit pouvoir démarrer.
 *
 * `npx` y est un script `npx.cmd` : le `spawn` de Node sans shell ne le lance pas. Le choix du
 * lanceur se fait au chargement du module, selon la plateforme ; ce test la simule. Le vrai
 * lancement sous Windows ne se vérifie que sur une machine Windows (procédure Claude Desktop).
 */
import { spawn as nodeSpawn } from "node:child_process";

import crossSpawn from "cross-spawn";
import { afterEach, describe, expect, it, vi } from "vitest";

const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.resetModules();
});

async function launcherOn(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
  vi.resetModules();
  return (await import("../gateway/tools/stdio-mcp-child")).spawnChild;
}

describe("le lanceur des serveurs MCP", () => {
  it("Windows : cross-spawn, qui trouve npx.cmd et échappe les arguments pour cmd.exe", async () => {
    expect(await launcherOn("win32")).toBe(crossSpawn);
  });

  it("ailleurs : le spawn de Node, inchangé", async () => {
    expect(await launcherOn("linux")).toBe(nodeSpawn);
    expect(await launcherOn("darwin")).toBe(nodeSpawn);
  });
});
