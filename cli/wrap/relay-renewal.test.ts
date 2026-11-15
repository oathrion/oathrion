/**
 * Un 401 pendant un renouvellement de clé : le relais attend la clé neuve et rejoue UNE fois,
 * au lieu de remonter « Invalid credentials » à l'agent (banc d'endurance, journal §5.74).
 * Un 401 arrive avant toute décision : le rejeu ne peut pas exécuter deux fois.
 */
import { describe, expect, it } from "vitest";

import { McpRelay } from "./relay";

function relayWith(answers: (key: string, call: number) => { status: number; body?: unknown }) {
  const keys: string[] = [];
  const out: string[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    const key = init.headers.authorization!.replace("Bearer ", "");
    keys.push(key);
    const { status, body } = answers(key, keys.length);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const relay = new McpRelay({
    endpoint: "http://127.0.0.1:1/api/mcp",
    key: "cle-revoquee",
    serverName: "carnet",
    write: (line) => out.push(line),
    log: (line) => logs.push(line),
    fetchImpl,
    credentialsFor: async () => ({ key: "cle-revoquee" }),
  });
  return { relay, keys, out, logs };
}

const listed = { jsonrpc: "2.0", id: 7, result: { tools: [] } };

describe("le relais et le renouvellement de clé", () => {
  it("401, puis une clé neuve : un seul rejeu, avec la clé neuve, et l'agent reçoit la réponse", async () => {
    const { relay, keys, out, logs } = relayWith((key) => (key === "cle-neuve" ? { status: 200, body: listed } : { status: 401, body: { error: "Invalid credentials" } }));
    const answered = relay.handle(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }));
    setTimeout(() => relay.setCredentials({ key: "cle-neuve" }), 50);
    await answered;
    expect(keys).toEqual(["cle-revoquee", "cle-neuve"]);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ id: 7, result: { tools: [] } });
    expect(logs.join("\n")).toMatch(/key renewed by the hub: the call is replayed once/);
  });

  it("toujours 401 avec la clé neuve : pas de second rejeu, une erreur claire", async () => {
    const { relay, keys, out } = relayWith(() => ({ status: 401, body: { error: "Invalid credentials" } }));
    const answered = relay.handle(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }));
    setTimeout(() => relay.setCredentials({ key: "cle-neuve" }), 50);
    await answered;
    expect(keys).toEqual(["cle-revoquee", "cle-neuve"]);
    expect(JSON.parse(out.at(-1)!).error.message).toMatch(/reconnecting this client/);
  });
});
