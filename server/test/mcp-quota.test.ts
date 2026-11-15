/**
 * UN QUOTA ATTEINT, PAR LA VOIE MCP : un message clair, pas « Internal error ».
 *
 * Le banc d'endurance du pivot local (journal §5.75) a atteint le plafond mensuel de
 * 100 000 exécutions : `/api/mcp` répondait alors 500 « Internal error handling the MCP
 * request » à chaque appel. Les routes REST disaient déjà 429 `quota_exceeded`. Ce
 * fichier éprouve que la voie MCP dit la même chose, et que RIEN ne part vers l'outil.
 * Le mode local, lui, ne refuse plus (`resolveQuotaMode`, `quotas.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { configureQuotas, resetQuotaConfig } from "../quotas";
import { parseQuotaOverrides } from "@shared/quotas";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";

interface RpcReply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

let api: TestClient;

function refund(target: string) {
  const params = {
    name: "refund",
    arguments: { target, amount: 75, currency: "EUR" },
    _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} },
  };
  return api.post<RpcReply>("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params }, {
    auth: ROLE_KEYS.operator,
    headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "refund", "X-Oathrion-Agent-Id": "agt_billing" },
  });
}

async function refundCount(): Promise<number> {
  const res = await api.get<{ id: string; toolExecutionCount: number }[]>("/api/tools", { auth: ROLE_KEYS.admin });
  return res.body.find((t) => t.id === "refund_tool")!.toolExecutionCount;
}

async function usedExecutions(): Promise<number> {
  const res = await api.get<{ counters: { counter: string; used: number }[] }>("/api/usage", { auth: ROLE_KEYS.admin });
  return res.body.counters.find((c) => c.counter === "executions")!.used;
}

beforeAll(async () => {
  api = await startTestServer();
});

afterAll(async () => {
  resetQuotaConfig();
  await api?.close();
});

describe("le quota d'exécutions, par la voie MCP", () => {
  it("plafond atteint : erreur JSON-RPC qui dit le quota et sa remise à zéro, et l'outil n'est pas appelé", async () => {
    const used = await usedExecutions();
    configureQuotas({ overrides: parseQuotaOverrides(`default:executions=${String(used)}`), mode: "enforce" });
    const before = await refundCount();

    const res = await refund("cus_quota_mcp");
    expect(res.status).toBe(429);
    expect(res.body.error?.message).toMatch(/Quota reached for executions this month/);
    expect(res.body.error?.message).not.toMatch(/Internal error/);
    expect(res.body.error?.data).toMatchObject({ counter: "executions", limit: used });
    expect(typeof res.body.error?.data?.resetAt).toBe("string");
    expect(await refundCount()).toBe(before);
  });

  it("en mode observe, le même appel passe", async () => {
    const used = await usedExecutions();
    configureQuotas({ overrides: parseQuotaOverrides(`default:executions=${String(used)}`), mode: "observe" });
    const before = await refundCount();
    const res = await refund("cus_quota_mcp_observe");
    expect(res.status).toBe(200);
    expect(res.body.result?.isError).toBe(false);
    expect(await refundCount()).toBe(before + 1);
  });
});
