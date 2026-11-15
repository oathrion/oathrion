/**
 * Protégé, et angles morts (`server/local-protection.ts`) : chaque porte de chaque agent, dans
 * l'un des quatre états, sans arrondir.
 */
import { describe, expect, it } from "vitest";

import { protectionReport, type ProtectionInput } from "../local-protection";

const server = (over: Partial<ProtectionInput["servers"][number]>): ProtectionInput["servers"][number] => ({
  client: "Claude Code",
  where: "Claude Code · all your projects",
  name: "files",
  config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
  wrapped: false,
  ...over,
});
const none = { allProjects: false, projects: [] };

describe("un serveur MCP", () => {
  it.each([
    [{ wrapped: true }, "protected", null],
    [{}, "bypasses", "npx oathrion"],
    [{ config: { url: "https://mcp.example.com", headers: { Authorization: "Bearer x" } } }, "bypasses", "npx oathrion"],
    [{ config: { url: "https://mcp.example.com" } }, "blind", null],
  ] as const)("%o → %s", (over, coverage, fix) => {
    const { agents } = protectionReport({ clients: ["Claude Code"], servers: [server(over)], hooks: { allProjects: true, projects: [] } });
    expect(agents[0]!.items.find((i) => i.kind === "mcp-server")).toMatchObject({ coverage, fix, where: "Claude Code · all your projects" });
  });
});

describe("le shell et les écritures de Claude Code", () => {
  const shell = (hooks: ProtectionInput["hooks"]) =>
    protectionReport({ clients: ["Claude Code"], servers: [], hooks }).agents[0]!.items.find((i) => i.what === "Shell and file edits")!;

  it("hook pour tous les projets : vérifiés ; dans quelques projets : à côté ailleurs ; aucun : à côté", () => {
    expect(shell({ allProjects: true, projects: [] }).coverage).toBe("checked");
    expect(shell({ allProjects: false, projects: ["~/app"] })).toMatchObject({ coverage: "bypasses", fix: "npx oathrion" });
    expect(shell({ allProjects: false, projects: ["~/app"] }).why).toContain("~/app");
    expect(shell(none)).toMatchObject({ coverage: "bypasses", fix: "npx oathrion" });
  });

  it("les lectures ne sont jamais présentées comme couvertes", () => {
    const { agents } = protectionReport({ clients: ["Claude Code"], servers: [], hooks: { allProjects: true, projects: [] } });
    expect(agents[0]!.items.find((i) => i.what.startsWith("File reads"))!.coverage).toBe("blind");
  });
});

describe("la machine entière", () => {
  it("un client présent sans serveur est montré ; un client absent ne l'est pas ; ce qui demande une action d'abord", () => {
    const report = protectionReport({
      clients: ["Claude Code", "Cursor"],
      servers: [server({ wrapped: true }), server({ name: "github", client: "Cursor", where: "Cursor · all your projects" })],
      hooks: { allProjects: true, projects: [] },
    });
    expect(report.agents.map((a) => a.client)).toEqual(["Claude Code", "Cursor"]);
    expect(report.agents[1]!.items.map((i) => i.coverage)).toEqual(["bypasses", "blind"]);
    expect(report.counts).toEqual({ protected: 1, checked: 1, bypasses: 1, blind: 2 });
  });

  it("Claude Desktop trouvé par sa seule configuration : ses extensions et connecteurs restent invisibles", () => {
    const { agents } = protectionReport({ clients: [], servers: [server({ client: "Claude Desktop", where: "Claude Desktop", wrapped: true })], hooks: none });
    expect(agents.map((a) => a.client)).toEqual(["Claude Desktop"]);
    expect(agents[0]!.items.filter((i) => i.coverage === "blind").map((i) => i.what)).toEqual(["Extensions installed from Claude Desktop", "Connectors added in Claude's settings"]);
  });
});
