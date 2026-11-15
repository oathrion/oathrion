/**
 * LE PIVOT LOCAL (`server/local-hub.ts`) — un seul Oathrion par machine, un agent par client.
 *
 * Le vrai serveur (harnais), de vrais enfants (le faux serveur MCP du dépôt, sous deux noms),
 * et ce qu'un client vivrait avec la clé que le pivot lui rend.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalHub, ServerConflictError } from "../local-hub";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { repositoriesFor } from "../repositories";
import { startTestServer, type TestClient } from "./harness";

/* Une clé de client admis : les essais tournent avec OATHRION_UNSAFE_TRUST_ALL_PROGRAMS (setup.ts). */
async function keyFor(h: LocalHub, holder: string, client: string) {
  const issued = await h.issueClientKey(holder, client);
  if ("quarantined" in issued) throw new Error(`unexpected quarantine: ${issued.description}`);
  return issued;
}

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-stdio-mcp-server.cjs");
const STATE = mkdtempSync(join(tmpdir(), "oathrion-pivot-"));
const LOG = join(STATE, "appels.jsonl");

let api: TestClient;
let clock = 1_000_000;
let hub: LocalHub;

const spec = (name: string, args: string[] = [FAKE]) => ({ name, command: process.execPath, args, env: { PATH: process.env.PATH ?? "", FAKE_MCP_LOG: LOG } });
const calls = (): string[] =>
  existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { name: string }).name) : [];

async function mcp(key: string, method: string, params: Record<string, unknown> = {}) {
  return api.post<{ result?: { tools?: { name: string }[]; isError?: boolean } }>(
    "/api/mcp",
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} } } },
    { auth: key, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": method, ...(params.name ? { "Mcp-Name": String(params.name) } : {}) } },
  );
}
const toolNames = async (key: string) => ((await mcp(key, "tools/list")).body.result?.tools ?? []).map((t) => t.name).sort();

beforeAll(async () => {
  api = await startTestServer();
  hub = new LocalHub(STATE, { now: () => clock, holderTimeoutMs: 30_000, idleMs: 30_000, childTimeoutMs: 5_000 });
});

afterAll(async () => {
  await hub.shutdown();
});

describe("les serveurs s'inscrivent à la demande", () => {
  it("deux relais, le même serveur : un seul enfant, partagé", async () => {
    const a = hub.attachHolder("relay");
    const b = hub.attachHolder("relay");
    const first = await hub.attachServer(a, spec("pivot-notes"));
    const second = await hub.attachServer(b, spec("pivot-notes"));
    expect(first.classes).toEqual({ read: 1, write: 5, destructive: 1 });
    expect(second).toBe(first);
    expect(hub.serverNames()).toEqual(["pivot-notes"]);
    expect(first.createdPolicies).toEqual(["pol_wrap_pivot-notes_1"]);
  });

  it("le même nom pour une AUTRE commande : refusé, et l'enfant en place n'est pas touché", async () => {
    const c = hub.attachHolder("relay");
    await expect(hub.attachServer(c, spec("pivot-notes", [FAKE, "--autre"]))).rejects.toBeInstanceOf(ServerConflictError);
    expect(hub.serverNames()).toEqual(["pivot-notes"]);
  });
});

describe("un agent par client, une clé par relais", () => {
  it("« Cursor » : l'agent porte le nom du client, lit et écrit, ne détruit pas", async () => {
    const relay = hub.attachHolder("relay");
    await hub.attachServer(relay, spec("pivot-notes"));
    const { key, agentId, agentName } = await keyFor(hub, relay, "Cursor");
    expect([agentId, agentName]).toEqual(["agt_local_cursor", "Cursor"]);
    const agent = await repositoriesFor(hub.organization).agents.findById(agentId);
    expect(agent?.permissions.filter((p) => p.granted).map((p) => p.scope).sort()).toEqual(["mcp:read", "mcp:write"]);
    expect(await toolNames(key)).toContain("mcp.pivot-notes.read_note");
    expect(await toolNames(key)).not.toContain("mcp.pivot-notes.delete_note");
  });

  it("deux clients, deux agents ; et deux relais du même client gardent chacun leur clé valide", async () => {
    const r1 = hub.attachHolder("relay");
    const r2 = hub.attachHolder("relay");
    const r3 = hub.attachHolder("relay");
    for (const r of [r1, r2, r3]) await hub.attachServer(r, spec("pivot-notes"));
    const cursorA = await keyFor(hub, r1, "Cursor");
    const cursorB = await keyFor(hub, r2, "Cursor");
    const claude = await keyFor(hub, r3, "claude-code");
    expect(claude.agentId).toBe("agt_local_claude-code");
    expect(cursorA.agentId).toBe(cursorB.agentId);
    for (const { key } of [cursorA, cursorB, claude]) expect((await mcp(key, "tools/list")).status).toBe(200);

    hub.detach(r1);
    expect((await mcp(cursorA.key, "tools/list")).status).toBe(401);
    expect((await mcp(cursorB.key, "tools/list")).status).toBe(200);
  });

  it("une lecture passe par l'enfant partagé ; une écriture attend, sans l'atteindre", async () => {
    const relay = hub.attachHolder("relay");
    await hub.attachServer(relay, spec("pivot-notes"));
    const { key } = await keyFor(hub, relay, "Cursor");
    const before = calls().length;
    expect((await mcp(key, "tools/call", { name: "mcp.pivot-notes.read_note", arguments: {} })).body.result?.isError).toBe(false);
    await mcp(key, "tools/call", { name: "mcp.pivot-notes.create_note", arguments: { text: "x" } });
    expect(calls().slice(before)).toEqual(["read_note"]);
  });
});

describe("un serveur inscrit en cours de route", () => {
  it("apparaît dans la liste des outils, sans redémarrer quoi que ce soit", async () => {
    const relay = hub.attachHolder("relay");
    await hub.attachServer(relay, spec("pivot-notes"));
    const { key } = await keyFor(hub, relay, "Cursor");
    expect(await toolNames(key)).not.toContain("mcp.pivot-carnet.read_note");

    const other = hub.attachHolder("relay");
    await hub.attachServer(other, spec("pivot-carnet"));
    expect(await toolNames(key)).toContain("mcp.pivot-carnet.read_note");
  });
});

describe("un serveur que plus personne ne porte", () => {
  it("est arrêté ; le porteur suivant le relance, frais", async () => {
    const only = hub.attachHolder("relay");
    await hub.attachServer(only, spec("pivot-seul"));
    const { key } = await keyFor(hub, hub.attachHolder("relay"), "Cursor");
    expect(await toolNames(key)).toContain("mcp.pivot-seul.read_note");

    hub.detach(only);
    for (let i = 0; i < 50 && hub.serverNames().includes("pivot-seul"); i += 1) await new Promise((done) => setTimeout(done, 20));
    expect(hub.serverNames()).not.toContain("pivot-seul");
    expect(await toolNames(key)).not.toContain("mcp.pivot-seul.read_note");

    const next = hub.attachHolder("relay");
    await hub.attachServer(next, spec("pivot-seul"));
    expect(await toolNames(key)).toContain("mcp.pivot-seul.read_note");
    hub.detach(next);
  });
});

/*
 * Relevé en essayant Claude Code de bout en bout le 5 novembre : `oathrion console`, client
 * fermé, relançait le serveur avec l'environnement de SON terminal, et le client qui arrivait
 * ensuite réutilisait ce processus. Ses variables (`MEMORY_FILE_PATH`, un jeton) n'arrivaient
 * jamais. Le témoin : le faux serveur écrit ses appels dans le fichier que nomme SA variable
 * `FAKE_MCP_LOG`.
 */
describe("un serveur relancé par la console, puis le client arrive", () => {
  const withLog = (name: string, log: string) => ({ ...spec(name), env: { PATH: process.env.PATH ?? "", FAKE_MCP_LOG: log } });
  const logged = (log: string) => (existsSync(log) ? readFileSync(log, "utf8") : "");

  it("le client relance le serveur avec SON environnement : ses variables arrivent", async () => {
    const consoleLog = join(STATE, "console.jsonl");
    const clientLog = join(STATE, "client.jsonl");
    const byConsole = hub.attachHolder("console");
    await hub.attachServer(byConsole, withLog("pivot-env", consoleLog));

    const relay = hub.attachHolder("relay");
    await hub.attachServer(relay, withLog("pivot-env", clientLog));
    const { key } = await keyFor(hub, relay, "Claude Code");
    expect((await mcp(key, "tools/call", { name: "mcp.pivot-env.read_note", arguments: {} })).body.result?.isError).toBe(false);

    expect(logged(clientLog)).toMatch(/read_note/);
    expect(logged(consoleLog)).not.toMatch(/read_note/);
    hub.detach(relay);
    hub.detach(byConsole);
  });

  it("le même environnement : le serveur de la console est gardé tel quel", async () => {
    const same = join(STATE, "meme.jsonl");
    const byConsole = hub.attachHolder("console");
    const first = await hub.attachServer(byConsole, withLog("pivot-meme", same));
    const relay = hub.attachHolder("relay");
    expect(await hub.attachServer(relay, withLog("pivot-meme", same))).toBe(first);
    hub.detach(relay);
    hub.detach(byConsole);
  });

  it("entre deux clients, le premier garde le sien : seul un serveur de console cède la place", async () => {
    const firstLog = join(STATE, "premier.jsonl");
    const a = hub.attachHolder("relay");
    const first = await hub.attachServer(a, withLog("pivot-deux", firstLog));
    const b = hub.attachHolder("relay");
    expect(await hub.attachServer(b, withLog("pivot-deux", join(STATE, "second.jsonl")))).toBe(first);
    hub.detach(b);
    hub.detach(a);
  });
});

describe("un porteur qui attend le lancement de son serveur (§5.60)", () => {
  it("n'est pas détaché pendant ce temps, même au-delà du délai de silence", async () => {
    const slow = hub.attachHolder("relay");
    const launching = hub.attachServer(slow, { ...spec("pivot-lent"), command: "sh", args: ["-c", `sleep 1; exec "${process.execPath}" "${FAKE}"`] });
    clock += 60_000;
    expect(hub.sweep().expired).not.toContain(slow);
    await launching;
    expect(hub.heartbeat(slow)).toBe(true);
    hub.detach(slow);
  });
});

describe("la durée de vie", () => {
  it("un porteur muet est détaché, ses clés révoquées ; sans porteur, le pivot se dit inactif", async () => {
    for (const id of hub.sweep().expired) void id;
    const relay = hub.attachHolder("relay");
    await hub.attachServer(relay, spec("pivot-notes"));
    const { key } = await keyFor(hub, relay, "Cursor");

    clock += 20_000;
    expect(hub.heartbeat(relay)).toBe(true);
    clock += 20_000;
    expect(hub.sweep().expired).not.toContain(relay);

    clock += 31_000;
    const swept = hub.sweep();
    expect(swept.expired).toContain(relay);
    expect(hub.heartbeat(relay)).toBe(false);
    expect((await mcp(key, "tools/list")).status).toBe(401);
    expect(hub.holderCount()).toBe(0);
    expect(swept.idle).toBe(false);

    clock += 31_000;
    expect(hub.sweep().idle).toBe(true);
  });
});
