/**
 * LA VÉRIFICATION PAR ÉTAPES DE LA CHAÎNE DE REÇUS (`?mode=incremental`, migration 29).
 *
 * La vérification complète relit toute la chaîne : ~13 s par million de reçus (journal
 * §5.34). Le mode par étapes reprend au point de la dernière vérification réussie, vérifie
 * que l'ANCRE (le dernier reçu déjà vérifié) est intacte, et ne relit que ce qui a été écrit
 * depuis. Ce fichier éprouve ce qu'il voit, et ce qu'il ne voit PAS : une modification plus
 * ancienne que l'ancre, que seule la vérification complète voit.
 *
 * La chaîne est écrite UNE fois, par le vrai chemin (autoriser, exécuter), et chaque
 * falsification est annulée après son contrôle : le limiteur de débit des décisions n'est
 * pas relevé pour ce fichier.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { rawDb } from "../db";
import { ACTION_RECEIPTS_TABLE } from "../migrations/012-action-authority";
import { DEFAULT_ORGANIZATION_ID, organizationId } from "@shared/tenancy";

const ORG_A = DEFAULT_ORGANIZATION_ID;
const ORG_B = organizationId("org_rival_corp");
const AS_A = { auth: ROLE_KEYS.admin };
const AS_B = { auth: OTHER_ORG_KEYS.admin };

interface Report {
  ok: boolean;
  entries: number;
  headHash: string | null;
  brokenAt: number | null;
  reason: string | null;
  mode: string;
  verifiedFrom: number;
  lastFullVerification: string | null;
}

let client: TestClient;
let mock: MockDownstream;
let mcp: LocalMcpServer;
const saved: Record<string, string | undefined> = {};
let counter = 0;

async function writeChain(auth: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    counter += 1;
    const body = { action: "stripe.refund", destinationId: "local-fixture", agentId: "agt_chain", arguments: { customer: `cus_inc${String(counter)}`, amount: 10, currency: "EUR" } };
    const decision = await client.post<{ decision: string; grantId: string }>("/api/actions/authorize", body, { auth });
    expect(decision.body.decision, JSON.stringify(decision.body).slice(0, 200)).toBe("ALLOW");
    expect((await client.post("/api/actions/execute", { ...body, grantId: decision.body.grantId }, { auth })).status).toBe(200);
  }
}

const incremental = () => client.get<Report>("/api/actions/receipts/verify?mode=incremental", AS_A);
const full = () => client.get<Report>("/api/actions/receipts/verify", AS_A);

/** Falsifie un reçu le temps d'un contrôle, puis le rend tel qu'il était. */
async function whileTampered<T>(entrySeq: number, check: () => Promise<T>): Promise<T> {
  const row = rawDb.prepare(`SELECT result_summary FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? AND entry_seq = ?`).get(ORG_A, entrySeq) as { result_summary: string };
  rawDb.prepare(`UPDATE ${ACTION_RECEIPTS_TABLE} SET result_summary = 'falsifié' WHERE organization_id = ? AND entry_seq = ?`).run(ORG_A, entrySeq);
  try {
    return await check();
  } finally {
    rawDb.prepare(`UPDATE ${ACTION_RECEIPTS_TABLE} SET result_summary = ? WHERE organization_id = ? AND entry_seq = ?`).run(row.result_summary, ORG_A, entrySeq);
  }
}

beforeAll(async () => {
  mock = await startMockDownstream();
  mcp = await startLocalMcpServer(mock.url);
  for (const key of ["OATHRION_LOCAL_MCP_URL", "OATHRION_DESTINATIONS"]) saved[key] = process.env[key];
  process.env.OATHRION_LOCAL_MCP_URL = mcp.url;
  delete process.env.OATHRION_DESTINATIONS;
  client = await startTestServer();
  for (const auth of [ROLE_KEYS.admin, OTHER_ORG_KEYS.admin]) {
    const reply = await fetch(`${client.baseUrl}/api/action-policies`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify({ id: "apol_chain_inc", name: "petit", action: "stripe.refund", effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 }),
    });
    expect(reply.status).toBe(200);
  }
  rawDb.prepare(`DELETE FROM ${ACTION_RECEIPTS_TABLE}`).run();
  rawDb.prepare(`DELETE FROM receipt_chain_checkpoints`).run();
  await writeChain(ROLE_KEYS.admin, 4);
  await writeChain(OTHER_ORG_KEYS.admin, 2);
}, 60_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await client?.close();
  await mcp?.close();
  await mock?.close();
});

/* Les cas s'enchaînent dans l'ordre : chacun part de l'état laissé par le précédent. */
describe("la vérification par étapes", () => {
  it("sans point de reprise, elle fait une vérification complète, et le dit", async () => {
    const res = await incremental();
    expect(res.body).toMatchObject({ ok: true, entries: 4, mode: "full", verifiedFrom: 0 });
    expect(res.body.lastFullVerification).not.toBeNull();
  });

  it("ensuite, elle ne relit que ce qui a été écrit depuis, et rend le même total et la même tête", async () => {
    const first = await full();
    await writeChain(ROLE_KEYS.admin, 3);
    const next = await incremental();
    expect(next.body).toMatchObject({ ok: true, entries: 7, mode: "incremental", verifiedFrom: 4 });
    expect(next.body.lastFullVerification).toBe(first.body.lastFullVerification);
    expect((await incremental()).body).toMatchObject({ ok: true, entries: 7, verifiedFrom: 7, headHash: next.body.headHash });
    expect((await full()).body.headHash).toBe(next.body.headHash);
  });

  it("voit une modification d'un reçu écrit APRÈS le point de reprise", async () => {
    await writeChain(ROLE_KEYS.admin, 2);
    const res = await whileTampered(8, incremental);
    expect(res.body).toMatchObject({ ok: false, mode: "incremental", brokenAt: 7 });
    expect(res.body.reason).toMatch(/^content:/);
  });

  it("un échec n'avance pas le point de reprise ; chaque organisation a le sien", async () => {
    const stored = () => rawDb.prepare(`SELECT organization_id, entries FROM receipt_chain_checkpoints`).all() as { organization_id: string; entries: number }[];
    expect(stored().find((r) => r.organization_id === ORG_A)?.entries).toBe(7);
    await client.get("/api/actions/receipts/verify", AS_B);
    expect(stored().find((r) => r.organization_id === ORG_B)?.entries).toBe(2);
    /* La falsification annulée, la même vérification réussit et avance. */
    expect((await incremental()).body).toMatchObject({ ok: true, entries: 9, verifiedFrom: 7 });
    expect(stored().find((r) => r.organization_id === ORG_A)?.entries).toBe(9);
  });

  it("voit une modification de l'ANCRE, le dernier reçu déjà vérifié", async () => {
    const res = await whileTampered(9, incremental);
    expect(res.body).toMatchObject({ ok: false, mode: "incremental" });
    expect(res.body.reason).toMatch(/^checkpoint:.*full verification/);
  });

  it("ne voit PAS une modification plus ancienne que l'ancre — seule la vérification complète la voit", async () => {
    /* La limite du mode, éprouvée plutôt qu'affirmée. */
    await whileTampered(2, async () => {
      expect((await incremental()).body).toMatchObject({ ok: true, mode: "incremental" });
      expect((await full()).body).toMatchObject({ ok: false, mode: "full", brokenAt: 1 });
    });
  });
});
