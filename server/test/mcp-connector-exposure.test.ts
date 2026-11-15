/**
 * CE QU'UN AGENT VOIT DANS `tools/list` CORRESPOND À CE QUI FONCTIONNE.
 *
 * Défaut corrigé : les actions d'un connecteur NON connecté étaient listées et décrites
 * « SIMULATED », alors qu'un appel aurait échoué. Ce fichier fixe chaque état :
 *
 *   absent · configuré mais non vérifié · connecté · accès perdu (le service refuse le
 *   jeton) · autre organisation · agent sans la portée · reconnexion
 *
 * et que le filtrage n'est PAS l'autorisation : la passerelle reste le seul juge.
 *
 * SIMULÉ au sens du rapport : Slack est un serveur local qui répond comme Slack.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import { connectorPlaneFor } from "../connectors";
import { resetVaultKeyring } from "../connectors/vault";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { repositoryExecutor, seedIfEmpty } from "../repositories";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const TOKEN = "xoxb-1111111111-2222222222-jetonexpositionmcp";
const ORG = "org_default" as OrganizationId;
const AGENT = "agt_mcp_exposure";
const NARROW = "agt_mcp_narrow";
const RIVAL = "agt_mcp_rival";

let slack: Server;
let api: TestClient;
let tokenValid = true;
let calls = 0;

function send(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json", "x-oauth-scopes": "chat:write,channels:read,channels:history" });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  calls += 1;
  const method = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/api\//, "");
  if (!tokenValid || req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, { ok: false, error: "token_revoked" });
  if (method === "auth.test") return send(res, { ok: true, team: "kryxor", user: "placet" });
  if (method === "conversations.history") return send(res, { ok: true, messages: [] });
  return send(res, { ok: false, error: "unknown_method" });
}

function agentBody(id: string, scopes: string[]) {
  return {
    id,
    name: `Agent ${id}`,
    description: "Exposition MCP.",
    provider: "custom",
    model: "agent-mcp",
    status: "active",
    owner: "test",
    mandate: { maxTransactionAmount: null, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: ["slack.com"] },
    permissions: scopes.map((scope) => ({ scope, label: scope, description: "", granted: true, risk: "medium" })),
    policyIds: [],
    tags: [],
  };
}

async function listed(agentId: string, auth: string = ROLE_KEYS.operator): Promise<string[]> {
  const reply = await api.post<{ result?: { tools?: { name: string; description: string }[] }; error?: unknown }>(
    "/api/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} } },
    },
    { auth, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "tools/list", "X-Oathrion-Agent-Id": agentId } },
  );
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return (reply.body.result?.tools ?? []).map((t) => t.name);
}

const slackTools = (names: string[]) => names.filter((n) => n.startsWith("slack."));

beforeAll(async () => {
  slack = createServer(handle);
  await new Promise<void>((r) => slack.listen(0, "127.0.0.1", r));
  process.env.OATHRION_SLACK_API_ORIGIN = `http://127.0.0.1:${String((slack.address() as AddressInfo).port)}`;
  process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE = "true";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  /* Toujours relire le coffre : ce fichier observe les transitions, pas le délai. */
  process.env.OATHRION_CONNECTOR_STATUS_TTL_MS = "0";
  resetVaultKeyring();
  api = await startTestServer();
  await seedIfEmpty();
  for (const [id, scopes] of [
    [AGENT, ["read:chat", "write:chat"]],
    [NARROW, ["write:chat"]],
  ] as const) {
    const created = await api.post("/api/agents", agentBody(id, [...scopes]), { auth: ROLE_KEYS.admin });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  }
  const rival = await api.post("/api/agents", agentBody(RIVAL, ["read:chat", "write:chat"]), { auth: OTHER_ORG_KEYS.admin });
  expect(rival.status, JSON.stringify(rival.body)).toBeLessThan(300);
});

afterAll(async () => {
  slack.closeAllConnections();
  await new Promise<void>((r) => slack.close(() => r()));
  for (const name of ["OATHRION_SLACK_API_ORIGIN", "OATHRION_WEBHOOK_ALLOW_PRIVATE", "OATHRION_CONNECTOR_STATUS_TTL_MS"]) delete process.env[name];
});

describe("l'état du connecteur décide de ce qui est annoncé", () => {
  it("ABSENT : aucune action Slack n'est annoncée — ni disponible, ni « simulée »", async () => {
    expect(slackTools(await listed(AGENT))).toEqual([]);
  });

  it("CONFIGURÉ MAIS NON VÉRIFIÉ : un jeton présent ne suffit pas", async () => {
    await connectorPlaneFor(repositoryExecutor(), ORG).vault.store({
      connectorId: "slack",
      secret: TOKEN,
      account: "",
      scopes: [],
      connectedBy: "test",
      verified: false,
    });
    expect(slackTools(await listed(AGENT))).toEqual([]);
  });

  it("CONNECTÉ (vérifié par le service) : les actions apparaissent, décrites comme réelles", async () => {
    expect((await api.post("/api/connectors/slack/connect", { secret: TOKEN }, { auth: ROLE_KEYS.admin })).status).toBe(201);
    const names = await listed(AGENT);
    expect(slackTools(names).sort()).toEqual(["slack.channels.list", "slack.history.read", "slack.message.post"]);
  });

  it("AGENT SANS LA PORTÉE : il ne voit que ce que ses permissions couvrent", async () => {
    expect(slackTools(await listed(NARROW))).toEqual(["slack.message.post"]);
  });

  it("AUTRE ORGANISATION : sa propre liste, sans notre connexion", async () => {
    expect(slackTools(await listed(RIVAL, OTHER_ORG_KEYS.admin))).toEqual([]);
  });

  it("ACCÈS PERDU : le service refuse le jeton lors d'un appel réel → l'action disparaît, sans test manuel", async () => {
    tokenValid = false;
    const result = await api.post<{ succeeded: boolean; toolResult: { code: string } }>(
      "/api/execute",
      { agentId: AGENT, action: "slack.history.read", target: "slack.com/C0PRODUIT01", metadata: {} },
      { auth: ROLE_KEYS.admin },
    );
    expect(result.body.succeeded).toBe(false);
    expect(result.body.toolResult.code).toBe("unauthorized");
    expect(slackTools(await listed(AGENT))).toEqual([]);
    const state = await api.get<{ id: string; status: { state: string; detail: string } }[]>("/api/connectors", { auth: ROLE_KEYS.admin });
    const status = state.body.find((c) => c.id === "slack")!.status;
    expect(status.state).toBe("error");
    expect(status.detail).toMatch(/Reconnect Slack/);
    expect(JSON.stringify(state.body)).not.toContain(TOKEN);
  });

  it("le filtre n'est pas l'autorisation : un appel MCP à l'outil masqué est refusé, sans appel au service", async () => {
    const before = calls;
    const reply = await api.post(
      "/api/mcp",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "slack.message.post",
          arguments: { target: "slack.com/C0PRODUIT01", text: "x" },
          _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} },
        },
      },
      {
        auth: ROLE_KEYS.operator,
        headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "slack.message.post", "X-Oathrion-Agent-Id": AGENT },
      },
    );
    expect(reply.status).toBe(404);
    expect(calls).toBe(before);
  });

  it("RECONNEXION : le service accepte à nouveau, les actions reviennent", async () => {
    tokenValid = true;
    expect((await api.post("/api/connectors/slack/test", {}, { auth: ROLE_KEYS.admin })).status).toBe(200);
    expect(slackTools(await listed(AGENT))).toHaveLength(3);
  });

  it("un test manuel qui échoue retire aussi les actions", async () => {
    tokenValid = false;
    await api.post("/api/connectors/slack/test", {}, { auth: ROLE_KEYS.admin });
    expect(slackTools(await listed(AGENT))).toEqual([]);
    tokenValid = true;
  });

  it("une révocation retire les actions", async () => {
    await api.post("/api/connectors/slack/test", {}, { auth: ROLE_KEYS.admin });
    expect(slackTools(await listed(AGENT))).toHaveLength(3);
    await api.del("/api/connectors/slack", { auth: ROLE_KEYS.admin });
    expect(slackTools(await listed(AGENT))).toEqual([]);
  });
});
