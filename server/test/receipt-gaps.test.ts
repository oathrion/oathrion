/**
 * L'ALERTE POUR LES ACTIONS SANS REÇU (`server/authority/receipt-gaps.ts`).
 *
 *   · une autorisation consommée sans reçu, passé le délai de grâce, alerte UNE fois ;
 *   · avant le délai de grâce, rien : son reçu est peut-être en train de s'écrire ;
 *   · une autre organisation ne voit pas, et n'alerte pas, pour celles-ci ;
 *   · le message Slack est lisible, sans bouton.
 *
 * Les autorisations sont produites PAR LE VRAI CHEMIN (autoriser, exécuter), puis leur
 * reçu est retiré en base — le modèle de menace d'un processus tué entre l'appel au
 * fournisseur et l'écriture du reçu, que `verify:faults` provoque pour de vrai.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { startMockDownstream, type MockDownstream } from "../mcp-local/mock-downstream";
import { startLocalMcpServer, type LocalMcpServer } from "../mcp-local/local-mcp-server";
import { rawDb } from "../db";
import { authorityFor } from "../authority";
import { ACTION_RECEIPTS_TABLE } from "../migrations/012-action-authority";
import { ReconcileStore } from "../connectors/reconcile-store";
import { sqliteExecutor } from "../sql/executor";
import { findNewReceiptGaps, receiptGapAlert, receiptGapGraceMs } from "../authority/receipt-gaps";
import { SlackChannel } from "../notifications/slack";
import { DEFAULT_ORGANIZATION_ID, organizationId } from "@shared/tenancy";

const ORG_A = DEFAULT_ORGANIZATION_ID;
const ORG_B = organizationId("org_rival_corp");

let client: TestClient;
let mock: MockDownstream;
let mcp: LocalMcpServer;
const saved: Record<string, string | undefined> = {};

async function executeOnce(auth: string, index: number): Promise<string> {
  const body = { action: "stripe.refund", destinationId: "local-fixture", agentId: "agt_gap", arguments: { customer: `cus_gap${String(index)}`, amount: 5, currency: "EUR" } };
  const decision = await client.post<{ decision: string; grantId: string }>("/api/actions/authorize", body, { auth });
  expect(decision.body.decision).toBe("ALLOW");
  expect((await client.post("/api/actions/execute", { ...body, grantId: decision.body.grantId }, { auth })).status).toBe(200);
  return decision.body.grantId;
}

function dropReceipt(org: string, grantId: string): void {
  rawDb.prepare(`DELETE FROM ${ACTION_RECEIPTS_TABLE} WHERE organization_id = ? AND grant_id = ?`).run(org, grantId);
}

function findingsFor(org: typeof ORG_A): ReconcileStore {
  return new ReconcileStore(sqliteExecutor(rawDb), org);
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
      body: JSON.stringify({ id: "apol_gap", name: "petit", action: "stripe.refund", effect: "ALLOW", constraints: [{ field: "amount", op: "lte", value: 100 }], priority: 100 }),
    });
    expect(reply.status).toBe(200);
  }
}, 30_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await client?.close();
  await mcp?.close();
  await mock?.close();
});

describe("le délai de grâce", () => {
  it("couvre le délai du fournisseur, la patience du reçu et une marge", () => {
    expect(receiptGapGraceMs({})).toBe(30_000 + 60_000 + 30_000);
    expect(receiptGapGraceMs({ OATHRION_MCP_TIMEOUT_MS: "4000", OATHRION_RECEIPT_PATIENCE_MS: "10000" })).toBe(4_000 + 10_000 + 30_000);
  });
});

describe("une action sans reçu", () => {
  it("n'alerte pas tant que son reçu peut encore s'écrire, puis alerte une seule fois", async () => {
    const grant = await executeOnce(ROLE_KEYS.admin, 1);
    dropReceipt(ORG_A, grant);
    const { store } = authorityFor(ORG_A);

    /* Dans le délai de grâce : ce n'est pas encore un trou. */
    expect(await findNewReceiptGaps({ store, findings: findingsFor(ORG_A), graceMs: 60 * 60 * 1000 })).toEqual([]);

    /* Passé le délai : signalée, une fois. */
    const later = new Date(Date.now() + 10_000);
    const first = await findNewReceiptGaps({ store, findings: findingsFor(ORG_A), graceMs: 1_000, now: later });
    expect(first.map((f) => f.id)).toEqual([grant]);
    expect(first[0]).toMatchObject({ kind: "missing_receipt", category: "receipt_gap", actor: "agt_gap" });
    expect(first[0]!.summary).toMatch(/stripe\.refund.*without a receipt/);
    expect(await findNewReceiptGaps({ store, findings: findingsFor(ORG_A), graceMs: 1_000, now: later })).toEqual([]);

    /* Une seconde action sans reçu : seule ELLE alerte. */
    const second = await executeOnce(ROLE_KEYS.admin, 2);
    dropReceipt(ORG_A, second);
    const next = await findNewReceiptGaps({ store, findings: findingsFor(ORG_A), graceMs: 1_000, now: new Date(Date.now() + 10_000) });
    expect(next.map((f) => f.id)).toEqual([second]);
  });

  it("une autre organisation ne la voit pas et n'alerte pas pour elle", async () => {
    const theirs = await executeOnce(OTHER_ORG_KEYS.admin, 3);
    const later = new Date(Date.now() + 10_000);
    /* L'organisation B, sans trou à elle : rien, malgré ceux de A. */
    expect(await findNewReceiptGaps({ store: authorityFor(ORG_B).store, findings: findingsFor(ORG_B), graceMs: 1_000, now: later })).toEqual([]);
    dropReceipt(ORG_B, theirs);
    const fresh = await findNewReceiptGaps({ store: authorityFor(ORG_B).store, findings: findingsFor(ORG_B), graceMs: 1_000, now: later });
    expect(fresh.map((f) => f.id)).toEqual([theirs]);
  });
});

describe("l'alerte", () => {
  it("nomme l'organisation et chaque autorisation, sans argument d'action", () => {
    const event = receiptGapAlert("org_x", "Kryxor", [
      { id: "grant_1", kind: "missing_receipt", url: null, createdAt: "2026-10-27T03:00:00.000Z", actor: "agt_a", summary: "stripe.refund by agt_a, grant consumed without a receipt", marker: null, category: "receipt_gap", firstSeenAt: "2026-10-27T03:05:00.000Z" },
    ]);
    expect(event.type).toBe("receipt.gap");
    expect(event.title).toBe("Oathrion — 1 action(s) without a receipt (Kryxor)");
    expect(event.summary).toContain("grant_1");
    expect(JSON.stringify(event)).not.toMatch(/cus_|amount/);
  });

  it("Slack : un message lisible, sans bouton", async () => {
    let received = "";
    const sink = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        received = raw;
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    try {
      const channel = new SlackChannel({ url: `http://127.0.0.1:${String((sink.address() as AddressInfo).port)}/hook`, allowPrivate: true });
      expect(channel.handles("receipt.gap")).toBe(true);
      const event = receiptGapAlert("org_x", "Kryxor", [
        { id: "grant_9", kind: "missing_receipt", url: null, createdAt: "2026-10-27T03:00:00.000Z", actor: "agt_a", summary: "stripe.refund by agt_a, grant consumed without a receipt", marker: null, category: "receipt_gap", firstSeenAt: "2026-10-27T03:05:00.000Z" },
      ]);
      const result = await channel.deliver({ ...event, id: "ntf_gap", at: new Date().toISOString() });
      expect(result.ok).toBe(true);
      const body = JSON.parse(received) as { text: string; blocks: { type: string }[] };
      expect(body.text).toMatch(/action\(s\) without a receipt/);
      expect(JSON.stringify(body.blocks)).toContain("grant_9");
      expect(body.blocks.some((b) => b.type === "actions")).toBe(false);
    } finally {
      sink.closeAllConnections();
      await new Promise<void>((r) => sink.close(() => r()));
    }
  });
});
