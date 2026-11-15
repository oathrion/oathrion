/**
 * LE QUOTA D'EXÉCUTIONS COUVRE AUSSI LA VOIE DIRECTE.
 *
 * Une passe d'endurance de 12 h (journal §5.25) a vu le relais refusé au 100 000e appel
 * du mois, pendant que `/api/actions/authorize` puis `execute` continuaient sans limite :
 * le compteur ne lisait que la table `executions`, et la voie directe écrit des reçus
 * (`action_receipts`). Ce fichier éprouve que :
 *
 *   · chaque exécution directe compte dans `GET /api/usage` ;
 *   · le plafond atteint, `execute` répond 429 `quota_exceeded`, avec la limite et la
 *     remise à zéro, et RIEN ne part en aval ;
 *   · l'autorisation n'est PAS consommée par ce refus : elle reste `issued` ;
 *   · en mode `observe`, l'exécution passe (le mode mesure, il ne refuse pas).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { configureQuotas, resetQuotaConfig } from "../quotas";
import { parseQuotaOverrides, periodStartFor } from "@shared/quotas";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { sqliteExecutor } from "../sql/executor";
import { rawDb as testDb } from "../db";
import { countExecutionsSince } from "../sql/execution-quota";

const AS_ADMIN = { auth: ROLE_KEYS.admin };

let client: TestClient;
let mock: MockDownstream;
let mcp: LocalMcpServer;
const saved: Record<string, string | undefined> = {};
let index = 0;

async function usedExecutions(): Promise<{ used: number; limit: number }> {
  const res = await client.get<{ counters: { counter: string; used: number; limit: number }[] }>("/api/usage", AS_ADMIN);
  expect(res.status).toBe(200);
  const counter = res.body.counters.find((c) => c.counter === "executions")!;
  return { used: counter.used, limit: counter.limit };
}

async function authorize() {
  index += 1;
  const body = {
    action: "stripe.refund",
    destinationId: "local-fixture",
    agentId: "agt_quota_direct",
    arguments: { customer: `cus_q${String(index)}`, amount: 10, currency: "EUR" },
  };
  const decision = await client.post<{ decision: string; grantId: string }>("/api/actions/authorize", body, AS_ADMIN);
  expect(decision.body.decision, JSON.stringify(decision.body).slice(0, 300)).toBe("ALLOW");
  return { body, grantId: decision.body.grantId };
}

async function execute(grant: { body: Record<string, unknown>; grantId: string }) {
  const res = await fetch(`${client.baseUrl}/api/actions/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ROLE_KEYS.admin}` },
    body: JSON.stringify({ ...grant.body, grantId: grant.grantId }),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
}

function setExecutionsLimit(limit: number, mode: "enforce" | "observe" = "enforce"): void {
  configureQuotas({ overrides: parseQuotaOverrides(`default:executions=${String(limit)}`), mode });
}

beforeAll(async () => {
  mock = await startMockDownstream();
  mcp = await startLocalMcpServer(mock.url);
  for (const key of ["OATHRION_LOCAL_MCP_URL", "OATHRION_DESTINATIONS"]) saved[key] = process.env[key];
  process.env.OATHRION_LOCAL_MCP_URL = mcp.url;
  delete process.env.OATHRION_DESTINATIONS;
  client = await startTestServer();
  const reply = await fetch(`${client.baseUrl}/api/action-policies`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${ROLE_KEYS.admin}` },
    body: JSON.stringify({ id: "apol_quota_direct", name: "petit", action: "stripe.refund", effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 }),
  });
  expect(reply.status).toBe(200);
}, 30_000);

afterAll(async () => {
  resetQuotaConfig();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await client?.close();
  await mcp?.close();
  await mock?.close();
});

describe("la voie directe compte, et bute sur le plafond", () => {
  it("chaque exécution directe est comptée dans l'usage", async () => {
    const before = (await usedExecutions()).used;
    const calls = mock.received().length;
    const run = await execute(await authorize());
    expect(run.status).toBe(200);
    expect((await usedExecutions()).used).toBe(before + 1);
    /* L'aval a bien reçu l'appel : sans cela, « rien ne part » plus bas ne prouverait rien. */
    expect(mock.received().length).toBeGreaterThan(calls);
  });

  it("plafond atteint : 429 quota_exceeded, rien ne part, l'autorisation reste intacte", async () => {
    const { used } = await usedExecutions();
    setExecutionsLimit(used + 1);
    expect((await execute(await authorize())).status).toBe(200);

    const grant = await authorize();
    const calls = mock.received().length;
    const refused = await execute(grant);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("quota_exceeded");
    expect(refused.body.counter).toBe("executions");
    expect(refused.body.limit).toBe(used + 1);
    expect(typeof refused.body.resetAt).toBe("string");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    /* Rien n'est parti en aval. */
    expect(mock.received().length).toBe(calls);
    /* Et l'autorisation n'a pas été brûlée par le refus. */
    const state = await client.get<{ state?: string; grant?: { state: string } }>(`/api/actions/grants/${grant.grantId}`, AS_ADMIN);
    expect(state.body.grant?.state ?? state.body.state).toBe("issued");

    /* Le plafond relevé, la MÊME autorisation s'exécute. */
    setExecutionsLimit(used + 10);
    expect((await execute(grant)).status).toBe(200);
  });

  it("en mode observe, l'exécution passe malgré le dépassement", async () => {
    const { used } = await usedExecutions();
    setExecutionsLimit(used, "observe");
    expect((await execute(await authorize())).status).toBe(200);
  });
});

describe("le compteur du mois (migration 28) reste égal au comptage réel", () => {
  /*
   * Le quota ne compte plus les exécutions à chaque fois (≈ 1 s à un million d'actions,
   * journal §5.34) : il tient `quota_period_counts`. Ces tests vérifient qu'il dit
   * toujours la même chose que le comptage qu'il remplace.
   */
  async function counter(): Promise<number | null> {
    const row = testDb
      .prepare(`SELECT used FROM quota_period_counts WHERE organization_id = ? AND counter = 'executions' AND period_start = ?`)
      .get(DEFAULT_ORGANIZATION_ID, periodStartFor("executions", new Date())) as { used: number } | undefined;
    return row ? Number(row.used) : null;
  }
  function counted(): Promise<number> {
    return countExecutionsSince(sqliteExecutor(testDb), DEFAULT_ORGANIZATION_ID, periodStartFor("executions", new Date()));
  }

  it("un rapport d'usage lit sans ouvrir la période ; une exécution l'ouvre au bon total, puis l'incrémente", async () => {
    resetQuotaConfig();
    testDb.prepare(`DELETE FROM quota_period_counts WHERE organization_id = ?`).run(DEFAULT_ORGANIZATION_ID);

    const reported = (await usedExecutions()).used;
    expect(reported).toBe(await counted());
    expect(await counter()).toBeNull();

    expect((await execute(await authorize())).status).toBe(200);
    expect(await counter()).toBe(reported + 1);
    expect(await counter()).toBe(await counted());
    expect((await usedExecutions()).used).toBe(reported + 1);
  });

  it("une autorisation présentée deux fois n'est comptée qu'une fois", async () => {
    resetQuotaConfig();
    const grant = await authorize();
    expect((await execute(grant)).status).toBe(200);
    const after = await counter();
    expect((await execute(grant)).status).toBe(403);
    expect(await counter()).toBe(after);
    expect(await counter()).toBe(await counted());
  });
});
