/**
 * `oathrion pont` : un serveur MCP distant présenté comme un serveur local, contre un faux
 * serveur distant (`fake-remote-mcp.ts`) sur la boucle locale.
 */
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { remoteUrlProblem, runBridge } from "./bridge";
import { REMOTE_TOKEN, startFakeRemote, type FakeRemote } from "./fake-remote-mcp";

let remote: FakeRemote;
beforeAll(async () => {
  remote = await startFakeRemote();
});
afterAll(async () => {
  await remote.close();
});

/** Le pont, à qui l'on parle : on lui écrit des lignes, il rend des réponses. */
function bridge(args: string[], headers: Record<string, string> | undefined = { Authorization: `Bearer ${REMOTE_TOKEN}` }) {
  const input = new PassThrough();
  const out: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const waiting = new Map<unknown, (m: Record<string, unknown>) => void>();
  const done = runBridge(args, headers ? { MCP_REMOTE_HEADERS: JSON.stringify(headers) } : {}, {
    input,
    write: (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      out.push(message);
      waiting.get(message.id)?.(message);
    },
    log: (line) => logs.push(line),
  });
  const ask = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method: string) => input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return { ask, notify, out, logs, end: () => (input.end(), done) };
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oathrion", version: "1" } };

describe("oathrion pont", () => {
  it("Streamable HTTP : session, version, réponses en JSON et en SSE, jeton envoyé, session fermée au départ", async () => {
    const before = remote.received.length;
    const b = bridge(["--url", remote.url]);
    expect(((await b.ask(1, "initialize", INIT)).result as { serverInfo: { name: string } }).serverInfo.name).toBe("faux-distant");
    b.notify("notifications/initialized");
    const tools = (await b.ask(2, "tools/list")).result as { tools: { name: string }[] };
    expect(tools.tools.map((t) => t.name)).toEqual(["read_doc", "create_doc", "delete_doc"]);
    expect(((await b.ask(3, "tools/call", { name: "read_doc", arguments: {} })).result as { content: { text: string }[] }).content[0]!.text).toBe("read_doc fait (distant)");
    expect(await b.end()).toBe(0);

    const seen = remote.received.slice(before);
    expect(seen.every((r) => r.authorization === `Bearer ${REMOTE_TOKEN}`)).toBe(true);
    expect(seen.filter((r) => r.rpc && r.rpc !== "initialize").every((r) => r.session === "session-1" && r.protocolVersion === "2025-06-18")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", session: "session-1" });
  });

  it("l'ancien transport SSE : l'adresse annoncée, les réponses dans le flux", async () => {
    const b = bridge(["--url", remote.sseUrl, "--transport", "sse"]);
    await b.ask(1, "initialize", INIT);
    const tools = (await b.ask(2, "tools/list")).result as { tools: unknown[] };
    expect(tools.tools).toHaveLength(3);
    expect(await b.end()).toBe(0);
  });

  it("jeton refusé : chaque requête reçoit une erreur claire, sans le jeton ni l'adresse complète dans le journal", async () => {
    const b = bridge(["--url", `${remote.url}?cle=secrete`], { Authorization: "Bearer mauvais" });
    const answer = await b.ask(1, "initialize", INIT);
    expect((answer.error as { message: string }).message).toMatch(/refuses access \(401\): check the token/);
    expect(await b.end()).toBe(0);
    expect(b.logs.join("\n")).not.toMatch(/mauvais|secrete/);
  });

  it("les jetons ne partent jamais en clair hors de la machine", () => {
    expect(remoteUrlProblem("https://mcp.exemple.test/mcp")).toBeNull();
    expect(remoteUrlProblem("http://127.0.0.1:5000/mcp")).toBeNull();
    expect(remoteUrlProblem("http://localhost:5000/mcp")).toBeNull();
    expect(remoteUrlProblem("http://mcp.exemple.test/mcp")).toMatch(/in clear/);
    expect(remoteUrlProblem("ftp://x")).toMatch(/not supported/);
  });
});
