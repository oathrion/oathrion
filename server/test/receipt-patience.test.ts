/**
 * LE REÇU D'UNE ACTION DÉJÀ EXÉCUTÉE NE SE PERD PAS SUR UNE BASE SATURÉE.
 *
 * À 1 024 clients avec le pool saturé (journal §5.28), 14 actions sont parties chez le
 * fournisseur sans reçu : l'écriture du reçu avait échoué sur un délai d'attente de
 * connexion. `EnforcementPoint.writeReceiptPatiently` réessaie désormais tant que la
 * base est seulement injoignable. Éprouvé ici contre un faux magasin, parce que
 * provoquer exactement cet échec sur une vraie base n'est pas reproductible.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EnforcementPoint, receiptPatienceMs } from "../authority/enforcement-point";
import type { ActionAuthorityStore, GrantRecord, ReceiptRecord } from "../authority/store";
import { organizationId } from "@shared/tenancy";

const ORG = organizationId("org_patience");
const POOL_TIMEOUT = () => new Error("timeout exceeded when trying to connect");

const grant: GrantRecord = {
  id: "grant_patience",
  actionId: "act_patience",
  agentId: "agt_patience",
  action: "stripe.refund",
  actionHash: "a".repeat(64),
  destinationId: "local-fixture",
  decision: "ALLOW",
  state: "consumed",
  requestId: null,
  idempotencyKey: null,
  policyId: null,
  createdAt: "2026-10-27T00:00:00.000Z",
  issuedAt: "2026-10-27T00:00:00.000Z",
  expiresAt: "2026-10-27T01:00:00.000Z",
  consumedAt: "2026-10-27T00:00:01.000Z",
  consumedBy: "test",
  approvalId: null,
  approvedAt: null,
  approvedBy: null,
  revokedAt: null,
  revokedReason: null,
};

function storeFailing(failures: number, error: () => Error = POOL_TIMEOUT, existing?: ReceiptRecord) {
  let calls = 0;
  const store = {
    appendReceipt: vi.fn(async (build: (head: { prevHash: string | null; entrySeq: number }) => ReceiptRecord) => {
      calls += 1;
      if (calls <= failures) throw error();
      return build({ prevHash: null, entrySeq: 1 });
    }),
    findReceiptByGrant: vi.fn(async () => existing),
  };
  return store;
}

function write(store: ReturnType<typeof storeFailing>, env: NodeJS.ProcessEnv = {}): Promise<ReceiptRecord> {
  const point = new EnforcementPoint(store as unknown as ActionAuthorityStore, ORG, env);
  const patient = (point as unknown as { writeReceiptPatiently: (input: unknown) => Promise<ReceiptRecord> }).writeReceiptPatiently.bind(point);
  return patient({
    grant,
    executionId: "axn_patience",
    outcome: "succeeded",
    downstream: { ok: true, text: "ok", data: {} },
    at: new Date("2026-10-27T00:00:02.000Z"),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("la patience du reçu", () => {
  it("60 s par défaut, réglable, une valeur illisible garde le défaut", () => {
    expect(receiptPatienceMs({})).toBe(60_000);
    expect(receiptPatienceMs({ OATHRION_RECEIPT_PATIENCE_MS: "" })).toBe(60_000);
    expect(receiptPatienceMs({ OATHRION_RECEIPT_PATIENCE_MS: "5000" })).toBe(5_000);
    expect(receiptPatienceMs({ OATHRION_RECEIPT_PATIENCE_MS: "longtemps" })).toBe(60_000);
  });

  it("une base saturée : réessayé jusqu'à ce que le reçu soit écrit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = storeFailing(2);
    const receipt = await write(store);
    expect(store.appendReceipt).toHaveBeenCalledTimes(3);
    expect(receipt.grantId).toBe(grant.id);
    expect(receipt.downstreamExecutionId).toBe("axn_patience");
  });

  it("un reçu déjà validé dont la réponse s'est perdue n'est pas écrit deux fois", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const already = { receiptId: "rcpt_deja", grantId: grant.id } as ReceiptRecord;
    const store = storeFailing(1, POOL_TIMEOUT, already);
    expect(await write(store)).toBe(already);
    expect(store.appendReceipt).toHaveBeenCalledTimes(1);
  });

  it("une AUTRE erreur remonte aussitôt, et la ligne de journal dit ce qui manque", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = storeFailing(1, () => new Error("violates check constraint"));
    await expect(write(store)).rejects.toThrow(/check constraint/);
    expect(store.appendReceipt).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/RECEIPT NOT WRITTEN.*axn_patience.*grant_patience.*stripe\.refund/);
  });

  it("la patience épuisée : l'erreur remonte au lieu d'attendre sans fin", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = storeFailing(1_000);
    await expect(write(store, { OATHRION_RECEIPT_PATIENCE_MS: "300" })).rejects.toThrow(/timeout exceeded/);
    expect(store.appendReceipt.mock.calls.length).toBeGreaterThan(1);
  });
});
