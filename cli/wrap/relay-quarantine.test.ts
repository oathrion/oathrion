/**
 * Un programme pas encore confirmé (`server/local-programs.ts`) : le relais n'a pas de clé, ne
 * transmet rien, et dit à l'agent pourquoi. Dès qu'une personne le confirme, le relais reprend
 * seul et prévient le client que la liste des outils a changé.
 */
import { describe, expect, it } from "vitest";

import { McpRelay, UNKNOWN_PROGRAM_TOOL, type Credentials } from "./relay";

const call = (id: number, method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("un programme en quarantaine", () => {
  it("rien n'atteint le pivot ; l'agent lit pourquoi ; confirmé, le relais reprend seul", async () => {
    let answer: Credentials = { quarantined: "pending", program: '/tmp/x/claude — it says it is "Claude Code"' };
    const posted: string[] = [];
    const out: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const message = JSON.parse(init.body) as { id: unknown; method: string };
      posted.push(message.method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [] } : {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const relay = new McpRelay({
      endpoint: "http://127.0.0.1:1/api/mcp",
      key: "",
      serverName: "fichiers",
      write: (l) => out.push(l),
      log: () => undefined,
      fetchImpl,
      quarantinePollMs: 20,
      approvalWaitMs: 150,
      pollMs: 20,
      previewTools: async () => [{ name: "list_directory", description: "List a directory", inputSchema: { type: "object" } }],
      credentialsFor: async () => answer,
    });
    const reply = (id: number) => out.map((l) => JSON.parse(l) as { id?: number; method?: string; result?: Record<string, unknown> }).find((m) => m.id === id);

    await relay.handle(call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", title: "Claude Code" } }));
    expect(reply(1)?.result).toMatchObject({ serverInfo: { name: "oathrion" }, instructions: expect.stringMatching(/has not met this program yet: \/tmp\/x\/claude/) });
    await relay.handle(call(2, "tools/list"));
    /* Les vrais outils (sans les destructeurs), et l'outil qui explique : l'appel pourra attendre. */
    expect((reply(2)?.result?.tools as { name: string }[]).map((t) => t.name)).toEqual(["list_directory", UNKNOWN_PROGRAM_TOOL]);
    await relay.handle(call(3, "tools/call", { name: "read_file", arguments: { path: "/etc/hostname" } }));
    expect(reply(3)?.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not even a read/) }] });
    expect(posted).toEqual([]);

    /* La personne confirme dans la console : le relais le voit seul, et prévient le client. */
    answer = { key: "oathrion_cle_admise" };
    await new Promise((done) => setTimeout(done, 80));
    expect(out.some((l) => (JSON.parse(l) as { method?: string }).method === "notifications/tools/list_changed")).toBe(true);
    await relay.handle(call(4, "tools/list"));
    expect(posted).toContain("tools/list");
  });

  it("bloqué : l'agent lit qu'une personne l'a bloqué", async () => {
    const out: string[] = [];
    const relay = new McpRelay({ endpoint: "http://127.0.0.1:1/api/mcp", key: "", serverName: "s", write: (l) => out.push(l), log: () => undefined, quarantinePollMs: 3_600_000, approvalWaitMs: 100, pollMs: 20, credentialsFor: async () => ({ quarantined: "blocked", program: "/tmp/x" }) });
    await relay.handle(call(1, "initialize", { clientInfo: { name: "x" } }));
    await relay.handle(call(2, "tools/call", { name: "anything" }));
    expect(out.at(-1)).toMatch(/A person blocked it in Oathrion's console/);
  });
});

describe("un appel qui attend la personne", () => {
  it("confirmé PENDANT l'attente : l'appel part, et l'agent ne reçoit que la réponse du serveur", async () => {
    let answer: Credentials = { quarantined: "pending", program: "/tmp/x/agent" };
    const out: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const message = JSON.parse(init.body) as { id: unknown; method: string };
      const result = message.method === "tools/list" ? { tools: [{ name: "mcp.fichiers.list_directory" }] } : { content: [{ type: "text", text: "a.txt" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { status: 200 });
    }) as unknown as typeof fetch;
    const relay = new McpRelay({ endpoint: "http://127.0.0.1:1/api/mcp", key: "", serverName: "fichiers", write: (l) => out.push(l), log: () => undefined, fetchImpl, quarantinePollMs: 3_600_000, approvalWaitMs: 5_000, pollMs: 20, credentialsFor: async () => answer });
    await relay.handle(call(1, "initialize", { clientInfo: { name: "agent" } }));
    const waiting = relay.handle(call(2, "tools/call", { name: "list_directory", arguments: { path: "." } }));
    setTimeout(() => {
      answer = { key: "oathrion_cle" };
    }, 100);
    await waiting;
    const result = out.map((l) => JSON.parse(l) as { id?: number; result?: { isError?: boolean; content?: { text: string }[] } }).find((m) => m.id === 2)?.result;
    expect(result?.isError).not.toBe(true);
    expect(result?.content?.[0]?.text).toBe("a.txt");
  });
});
