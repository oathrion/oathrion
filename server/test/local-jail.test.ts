/**
 * LE RELAIS ENFERMÉ (`oathrion jail`, pièce J2 de `notes/CONCEPTION-JAIL.md`).
 *
 * Dans la prison, le relais ne voit que le secret RELAIS de SA prison, créé par le pivot à la
 * demande d'`oathrion jail` et lié à l'identité de l'agent relevée dehors. Signé avec lui, il ne
 * fait que les gestes d'un relais : jamais ouvrir la console ni décider, jamais une clé
 * d'approbation, et il ne fait lancer QUE la commande exacte d'un serveur connu — avec les jetons
 * pris au coffre, dehors, jamais ceux qu'il enverrait. Son journal passe par le pivot.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mintLocalLoginTicket } from "@shared/local-login-ticket";

import { verifyJournal } from "../../cli/wrap/claude-journal";
import { LocalHub } from "../local-hub";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { startTestServer, type TestClient } from "./harness";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-stdio-mcp-server.cjs");
/* Comme sur une vraie machine : `<racine>/_local`, où le pivot range aussi le journal. */
const STATE = join(mkdtempSync(join(tmpdir(), "oathrion-jail-")), "_local");
const VAULT_LOG = join(STATE, "appels-coffre.jsonl");
const SENT_LOG = join(STATE, "appels-envoyes.jsonl");
const SESSION_SECRET = "s".repeat(48);
let RELAY_SECRET = "";
/* L'agent que lance `oathrion jail`, tel qu'il l'a relevé dehors. */
const AGENT = { exe: "/opt/agent/bin/agent", script: null, sha256: "a".repeat(64), platform: "linux" };

let api: TestClient;
let hub: LocalHub;

/** Une opération du pivot, signée comme dans la prison (secret relais) ou dehors (secret de session). */
const op = (body: Record<string, unknown>, from: "jail" | "outside" = "jail") =>
  api.post<Record<string, unknown>>("/api/local/hub", body, {
    headers: from === "jail" ? { "x-oathrion-relay": mintLocalLoginTicket(RELAY_SECRET) } : { "x-oathrion-local": mintLocalLoginTicket(SESSION_SECRET) },
  });

beforeAll(async () => {
  mkdirSync(STATE, { recursive: true });
  process.env.OATHRION_SESSION_SECRET = SESSION_SECRET;
  api = await startTestServer();
  hub = new LocalHub(STATE, { holderTimeoutMs: 30_000, idleMs: 30_000, childTimeoutMs: 5_000 });
  (await import("../local-mode")).enterLocalMode();
  (await import("../local-hub")).activateHub(hub);
  RELAY_SECRET = (await op({ op: "jail-open", program: AGENT }, "outside")).body.relaySecret as string;
  /* Ce que `oathrion jail` inscrit en lisant la configuration des clients, et le coffre de J1. */
  writeFileSync(join(STATE, "servers.json"), JSON.stringify({ carnet: { command: process.execPath, args: [FAKE] } }));
  mkdirSync(join(STATE, "server-secrets"), { recursive: true });
  writeFileSync(join(STATE, "server-secrets", "carnet.json"), JSON.stringify({ env: { FAKE_MCP_LOG: VAULT_LOG, CARNET_API_TOKEN: "jeton-du-coffre-1234567890" } }));
}, 60_000);

afterAll(async () => {
  (await import("../local-hub")).activateHub(null);
  await hub.shutdown();
});

describe("signé avec le secret relais", () => {
  it("ne s'attache pas comme une console, et ne décide rien", async () => {
    expect((await op({ op: "attach", kind: "console" })).status).toBe(403);
    expect((await op({ op: "accord", server: "carnet", verb: "mcp.carnet.delete_note" })).status).toBe(403);
    expect((await op({ op: "bundle", project: "/tmp", scope: { since: "2026-11-01" } })).status).toBe(403);
  });

  it("jail-open : seulement dehors, et avec une identité", async () => {
    expect((await op({ op: "jail-open", program: AGENT })).status).toBe(403);
    expect((await op({ op: "jail-open" }, "outside")).status).toBe(400);
  });

  it("un agent jamais vu : pas de prison, la personne prévenue ; confirmé, il l'a ; bloqué, jamais", async () => {
    const before = process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS;
    delete process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS;
    const announced: string[] = [];
    hub.onUnknownProgram = (program) => announced.push(program.description);
    try {
      const fresh = { exe: "/home/p/.local/bin/agy", script: null, sha256: "b".repeat(64), platform: "linux" };
      const first = await op({ op: "jail-open", program: fresh, name: "agy" }, "outside");
      expect(first.body).toMatchObject({ quarantined: "pending", program: expect.stringMatching(/agy/) });
      expect(first.body.relaySecret).toBeUndefined();
      expect(announced).toHaveLength(1);
      /* Redemandé en attendant la décision : pas de seconde notification. */
      await op({ op: "jail-open", program: fresh, name: "agy" }, "outside");
      expect(announced).toHaveLength(1);

      hub.programs.decide(String(first.body.programId), "trusted", "la personne");
      expect(typeof (await op({ op: "jail-open", program: fresh, name: "agy" }, "outside")).body.relaySecret).toBe("string");

      hub.programs.decide(String(first.body.programId), "blocked", "la personne");
      const blocked = await op({ op: "jail-open", program: fresh, name: "agy" }, "outside");
      expect(blocked.body).toMatchObject({ quarantined: "blocked" });
      expect(blocked.body.relaySecret).toBeUndefined();
    } finally {
      hub.onUnknownProgram = null;
      if (before !== undefined) process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS = before;
    }
  });

  it("l'identité est celle relevée dehors : ce que le relais déclare de lui-même est ignoré", async () => {
    const holder = (await op({ op: "attach" })).body.holder as string;
    await op({ op: "server", holder, server: { name: "carnet", command: process.execPath, args: [FAKE] } });
    const before = process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS;
    delete process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS;
    try {
      /*
       * Le relais se dit un programme jamais vu : s'il était cru, il serait en quarantaine. Il a
       * sa clé, parce que c'est l'agent relevé DEHORS (admis à l'ouverture de la prison) qui compte.
       */
      const claimed = { exe: "/usr/bin/cursor", script: null, sha256: "c".repeat(64), platform: "linux" };
      const answer = await op({ op: "client", holder, client: "Cursor", program: claimed });
      expect(answer.body.quarantined).toBeUndefined();
      expect(typeof answer.body.agentToken).toBe("string");
      expect(hub.programs.list().some((p) => p.identity?.exe === "/usr/bin/cursor")).toBe(false);
    } finally {
      if (before !== undefined) process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS = before;
    }
  });

  it("ne touche pas aux porteurs du dehors, ni à ceux d'une autre prison", async () => {
    const outside = (await op({ op: "attach" }, "outside")).body.holder as string;
    expect((await op({ op: "detach", holder: outside })).status).toBe(403);
    expect((await op({ op: "heartbeat", holder: outside })).status).toBe(403);
    expect(hub.heartbeat(outside)).toBe(true);
  });

  it("refermée : son secret ne vaut plus rien, ses relais sont détachés", async () => {
    const other = (await op({ op: "jail-open", program: AGENT }, "outside")).body.relaySecret as string;
    const signed = (body: Record<string, unknown>) => api.post<Record<string, unknown>>("/api/local/hub", body, { headers: { "x-oathrion-relay": mintLocalLoginTicket(other) } });
    const holder = (await signed({ op: "attach" })).body.holder as string;
    expect(hub.heartbeat(holder)).toBe(true);
    expect((await op({ op: "jail-close", relaySecret: other }, "outside")).status).toBe(204);
    expect(hub.heartbeat(holder)).toBe(false);
    expect((await signed({ op: "attach" })).status).toBe(403);
  });

  it("un ancien fichier relay.secret partagé n'ouvre plus rien", async () => {
    const legacy = "l".repeat(48);
    writeFileSync(join(STATE, "relay.secret"), legacy, { mode: 0o600 });
    const answer = await api.post("/api/local/hub", { op: "attach" }, { headers: { "x-oathrion-relay": mintLocalLoginTicket(legacy) } });
    expect(answer.status).toBe(403);
  });

  it("le secret relais ne vaut pas le secret de session", async () => {
    const forged = await api.post("/api/local/hub", { op: "attach", kind: "console" }, { headers: { "x-oathrion-local": mintLocalLoginTicket(RELAY_SECRET) } });
    expect(forged.status).toBe(403);
  });

  it("un serveur inconnu, ou un serveur connu à une autre commande : refusé", async () => {
    const holder = (await op({ op: "attach" })).body.holder as string;
    const unknown = await op({ op: "server", holder, server: { name: "evasion", command: "/bin/sh", args: ["-c", "cat ~/.oathrion/_local/session.secret"] } });
    expect(unknown.status).toBe(403);
    expect(JSON.stringify(unknown.body)).toMatch(/not a server Oathrion knows/);
    const other = await op({ op: "server", holder, server: { name: "carnet", command: "/bin/sh", args: ["-c", "id"] } });
    expect(other.status).toBe(403);
    expect(hub.serverNames()).not.toContain("evasion");
  });

  it("la commande exacte d'un serveur connu : lancé avec les jetons du coffre, jamais ceux envoyés ; pas de clé d'approbation", async () => {
    const holder = (await op({ op: "attach" })).body.holder as string;
    const launched = await op({ op: "server", holder, server: { name: "carnet", command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: SENT_LOG } } });
    expect(launched.status).toBe(200);
    const client = await op({ op: "client", holder, client: "Agent enfermé", approver: true });
    expect(client.body.approverToken).toBeNull();
    const key = client.body.agentToken as string;
    const read = await api.post<{ result?: { isError?: boolean } }>(
      "/api/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mcp.carnet.read_note", arguments: {}, _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} } } },
      { auth: key, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "mcp.carnet.read_note" } },
    );
    expect(read.body.result?.isError).not.toBe(true);
    /* Le serveur a reçu l'environnement du coffre ; celui qu'envoyait le relais enfermé est ignoré. */
    expect(existsSync(VAULT_LOG)).toBe(true);
    expect(existsSync(SENT_LOG)).toBe(false);
  });

  it("le journal : ajouté par le pivot, et sa chaîne tient", async () => {
    const record = { phase: "pre", session: "s1", toolUseId: "t1", tool: "Bash", action: "shell", target: "shell://ls", verdict: "none" };
    expect((await op({ op: "journal", record })).status).toBe(204);
    expect((await op({ op: "journal", record: { ...record, phase: "post" } })).status).toBe(204);
    const file = join(STATE, "claude-code", "journal.jsonl");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(verifyJournal(file)).toMatchObject({ ok: true, entries: 2 });
  });
});

describe("la veille des agents : les prisons, et les agents dehors", () => {
  it("le processus d'une prison se déclare de dehors seulement, et pour une prison ouverte", async () => {
    expect((await op({ op: "jail-started", relaySecret: RELAY_SECRET, pid: 4242 })).status).toBe(403);
    expect((await op({ op: "jail-started", relaySecret: "inconnu", pid: 4242 }, "outside")).status).toBe(404);
    expect((await op({ op: "jail-started", relaySecret: RELAY_SECRET, pid: 4242 }, "outside")).status).toBe(204);
    expect(hub.jailPids().has(4242)).toBe(true);
  });

  it("laisser la place à un pivot neuf : jamais tant qu'une prison ou un relais en dépend ; jamais demandé de dedans", async () => {
    expect(hub.canRetire()).toBe(false);
    expect((await op({ op: "retire" }, "outside")).status).toBe(409);
    expect((await op({ op: "retire" })).status).toBe(403);
  });

  it("une autorisation hors de la prison se voit, et se retire", async () => {
    hub.outsideAllowances.allow("/home/p/.local/bin/agy", "agy", "la personne");
    const listed = await api.get<{ exe: string; agent: string; by: string }[]>("/api/local/agents/allowed");
    expect(listed.body).toEqual([expect.objectContaining({ exe: "/home/p/.local/bin/agy", agent: "agy", by: "la personne" })]);
    expect((await api.post("/api/local/agents/allowed/revoke", { exe: "/home/p/.local/bin/agy" })).status).toBe(200);
    expect(hub.outsideAllowances.has("/home/p/.local/bin/agy")).toBe(false);
    expect((await api.post("/api/local/agents/allowed/revoke", { exe: "/home/p/.local/bin/agy" })).status).toBe(404);
    /* Le retrait va au fil d'actualité. */
    const feed = await api.get<{ title: string }[]>("/api/local/feed");
    expect(feed.status).toBe(200);
    expect(feed.body.map((i) => i.title)).toContain("Nova (agy) is no longer allowed outside the jail.");
  });

  it("arrêter : seulement un agent que la veille voit dehors à l'instant, jamais un processus quelconque", async () => {
    const listed = await api.get<unknown[]>("/api/local/agents/running");
    expect(listed.status).toBe(200);
    const stop = await api.post(`/api/local/agents/running/${String(process.pid)}/stop`, {});
    expect(stop.status).toBe(404);
    expect((await api.post(`/api/local/agents/running/${String(process.pid)}/autre`, {})).status).toBe(400);
  });
});

describe("signé avec le secret de session (dehors)", () => {
  it("ouvre la console, et inscrit au registre les serveurs qu'il lance", async () => {
    expect((await op({ op: "attach", kind: "console" }, "outside")).status).toBe(200);
    const holder = (await op({ op: "attach" }, "outside")).body.holder as string;
    expect((await op({ op: "server", holder, server: { name: "notes-dehors", command: process.execPath, args: [FAKE, "--dehors"] } }, "outside")).status).toBe(200);
    expect(hub.knownServer("notes-dehors", process.execPath, [FAKE, "--dehors"])).toBe(true);
  });
});
