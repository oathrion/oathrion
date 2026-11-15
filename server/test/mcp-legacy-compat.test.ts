/**
 * LE MODE DE COMPATIBILITÉ MCP — pour les clients qui parlent 2025-06-18 / 2025-03-26.
 *
 * Mesuré le 19 octobre 2026 avec un vrai client, `cursor-agent` 2026.08.11 : il ouvre par
 * `initialize` sans en-tête `MCP-Protocol-Version`, recevait 400, retombait sur l'ancien
 * transport SSE (GET) et recevait 404. Ce fichier fixe ce que le mode de compatibilité
 * accepte, et surtout ce qu'il ne change pas : `tools/call` passe par la même passerelle,
 * avec le même résultat que le mode 2026-07-28, et les contrôles d'en-têtes restent là où
 * leurs entrées existent.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { JSON_RPC_ERRORS, MCP_ERRORS, META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const AGENT = "agt_billing";

interface RpcReply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let api: TestClient;

beforeAll(async () => {
  api = await startTestServer();
});

/** Une requête telle qu'un client 2025-xx l'envoie : pas de `_meta` de version. */
function legacy(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}, id: number | null = 1) {
  const body = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  return api.post<RpcReply>("/api/mcp", body, {
    auth: ROLE_KEYS.operator,
    headers: { "X-Placet-Agent-Id": AGENT, Accept: "application/json, text/event-stream", ...headers },
  });
}

/** La même requête en mode 2026-07-28. */
function current(method: string, params: Record<string, unknown> = {}) {
  return api.post<RpcReply>(
    "/api/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} } },
    },
    {
      auth: ROLE_KEYS.operator,
      headers: {
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": method,
        ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
        "X-Placet-Agent-Id": AGENT,
      },
    },
  );
}

async function toolCount(id: string): Promise<number> {
  const res = await api.get<{ id: string; toolExecutionCount: number }[]>("/api/tools", { auth: ROLE_KEYS.admin });
  return res.body.find((t) => t.id === id)!.toolExecutionCount;
}

describe("la poignée de main", () => {
  it("initialize sans en-tête : la version du client est rendue, avec la capacité tools", async () => {
    const res = await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cursor", version: "x" } });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "oathrion" },
    });
  });

  it("une version inconnue du client reçoit la plus récente prise en charge", async () => {
    const res = await legacy("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    expect(res.body.result?.protocolVersion).toBe("2025-06-18");
  });

  it("notifications/initialized est accusée en 202, sans corps", async () => {
    const res = await legacy("notifications/initialized", {}, {}, null);
    expect(res.status).toBe(202);
  });

  it("ping répond par un résultat, sans erreur", async () => {
    const res = await legacy("ping");
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result).toBeDefined();
  });

  it("sans credential, rien : 401", async () => {
    const res = await api.post("/api/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { auth: null });
    expect(res.status).toBe(401);
  });
});

describe("le même moteur derrière les deux enveloppes", () => {
  it("tools/list rend exactement la liste du mode 2026-07-28", async () => {
    const names = (r: RpcReply) => ((r.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
    const a = await legacy("tools/list");
    const b = await current("tools/list");
    expect(a.status).toBe(200);
    expect(names(a.body)).toEqual(names(b.body));
    expect(names(a.body).length).toBeGreaterThan(0);
  });

  it("tools/call passe par la passerelle : la décision et l'effet sont ceux du mode courant", async () => {
    const before = await toolCount("refund_tool");
    const viaLegacy = await legacy("tools/call", { name: "refund", arguments: { target: "cus_legacy", amount: 10, currency: "EUR" } });
    const afterLegacy = await toolCount("refund_tool");
    const viaCurrent = await current("tools/call", { name: "refund", arguments: { target: "cus_current", amount: 10, currency: "EUR" } });
    const afterCurrent = await toolCount("refund_tool");
    const decision = (r: RpcReply) => (r.result?.structuredContent as { decision?: string } | undefined)?.decision;
    expect(viaLegacy.status).toBe(200);
    expect(decision(viaLegacy.body)).toBeDefined();
    expect(decision(viaLegacy.body)).toBe(decision(viaCurrent.body));
    expect(afterLegacy - before).toBe(afterCurrent - afterLegacy);
  });

  it("un argument non déclaré reste refusé", async () => {
    const res = await legacy("tools/call", { name: "refund", arguments: { target: "cus_x", approved: true } });
    expect(res.status).toBe(400);
  });
});

describe("les contrôles d'en-têtes, là où leurs entrées existent", () => {
  it("un Mcp-Method qui contredit le corps est refusé", async () => {
    const res = await legacy("tools/list", {}, { "Mcp-Method": "tools/call" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe(MCP_ERRORS.headerMismatch);
  });

  it("un Mcp-Name qui contredit params.name est refusé, sans exécution", async () => {
    const before = await toolCount("refund_tool");
    const res = await legacy("tools/call", { name: "refund", arguments: { target: "cus_x", amount: 1 } }, { "Mcp-Name": "purchase" });
    expect(res.status).toBe(400);
    expect(await toolCount("refund_tool")).toBe(before);
  });

  it("l'en-tête 2025-06-18 est accepté ; une version inconnue est refusée", async () => {
    expect((await legacy("tools/list", {}, { "MCP-Protocol-Version": "2025-06-18" })).status).toBe(200);
    const unknown = await legacy("tools/list", {}, { "MCP-Protocol-Version": "1999-01-01" });
    expect(unknown.status).toBe(400);
  });

  it("le mode 2026-07-28 reste strict : initialize y est inconnu", async () => {
    const res = await current("initialize");
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
  });
});

describe("le transport", () => {
  it("GET /api/mcp rend 405 (aucun flux serveur), pas 404", async () => {
    const res = await fetch(`${api.baseUrl}/api/mcp`, { headers: { authorization: `Bearer ${ROLE_KEYS.operator}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
