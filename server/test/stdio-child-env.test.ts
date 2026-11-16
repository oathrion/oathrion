import { describe, expect, it } from "vitest";

import { childEnv } from "../gateway/tools/stdio-mcp-child";

describe("un serveur lancé par npx : le cache d'abord (16 novembre)", () => {
  it("npx, npx.cmd, ou un chemin vers npx : prefer-offline", () => {
    expect(childEnv("npx", { PATH: "/bin" })).toEqual({ PATH: "/bin", npm_config_prefer_offline: "true" });
    expect(childEnv("/usr/bin/npx", {}).npm_config_prefer_offline).toBe("true");
    expect(childEnv("C:\\Program Files\\nodejs\\npx.cmd", {}).npm_config_prefer_offline).toBe("true");
  });

  it("une autre commande, ou un réglage déjà là : rien ne change", () => {
    const env = { PATH: "/bin" };
    expect(childEnv("node", env)).toBe(env);
    expect(childEnv("npx", { NPM_CONFIG_PREFER_ONLINE: "true" })).toEqual({ NPM_CONFIG_PREFER_ONLINE: "true" });
    expect(childEnv("npx", { npm_config_prefer_offline: "false" })).toEqual({ npm_config_prefer_offline: "false" });
  });
});
