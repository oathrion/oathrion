/**
 * LA RÉCONCILIATION STRIPE, ÉTENDUE À CE QUI FAIT SORTIR OU PERDRE DE L'ARGENT.
 *
 *   · un virement MANUEL vers la banque → hors Oathrion (Oathrion n'a aucun verbe de virement) ;
 *     un virement automatique (calendrier du compte) → compté ;
 *   · un paiement annulé, un client supprimé, un litige accepté PAR UNE REQUÊTE → hors
 *     Oathrion ; le même événement produit par Stripe seul (`request.id` absent) → compté ;
 *   · un litige gagné → ignoré : il ne fait rien perdre ;
 *   · une marque Oathrion qui ne correspond à aucune exécution → signalée ;
 *   · une clé restreinte qui ne lit pas le journal → résultat PARTIEL, et la limite le dit.
 *
 * SIMULÉ : Stripe est un serveur local qui répond comme lui.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetVaultKeyring } from "../connectors/vault";
import { resetInstalls } from "../connectors/oauth-install";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const STRIPE_KEY = "sk_test_reconciliationArgentxxxxxxxxx";

const payouts: Record<string, unknown>[] = [];
const events: Record<string, unknown>[] = [];
let eventsForbidden = false;
let eventsQuery = "";
let stripe: Server;
let api: TestClient;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function stripeHandler(req: IncomingMessage, res: ServerResponse): void {
  if (req.headers.authorization !== `Bearer ${STRIPE_KEY}`) return send(res, 401, { error: { type: "invalid_request_error", message: "Invalid API Key" } });
  const url = new URL(req.url ?? "/", "http://stripe");
  if (url.pathname === "/v1/account") return send(res, 200, { id: "acct_1ReconArgentX", settings: { dashboard: { display_name: "Kryxor test" } } });
  if (url.pathname === "/v1/refunds") return send(res, 200, { data: [], has_more: false });
  if (url.pathname === "/v1/payouts") return send(res, 200, { data: payouts, has_more: false });
  if (url.pathname === "/v1/events") {
    eventsQuery = decodeURIComponent(url.search);
    if (eventsForbidden) {
      return send(res, 403, { error: { type: "invalid_request_error", code: "secret_key_required", message: "The provided key 'rk_test_***' does not have the required permissions" } });
    }
    return send(res, 200, { data: events, has_more: false });
  }
  return send(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such" } });
}

type Item = { id: string; kind: string; actor: string | null; summary: string; marker: string | null };
type Report = { scanned: number; viaOathrion: number; outside: Item[]; unknownMarker: Item[]; others: number; verdict: string; truncated: boolean; limits: string[] };

beforeAll(async () => {
  stripe = createServer((req, res) => {
    req.resume();
    req.on("end", () => stripeHandler(req, res));
  });
  const origin = await new Promise<string>((resolve) =>
    stripe.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${String((stripe.address() as AddressInfo).port)}`)),
  );
  process.env.OATHRION_STRIPE_API_ORIGIN = origin;
  process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE = "true";
  process.env.OATHRION_CONNECTOR_TIMEOUT_MS = "1000";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  resetVaultKeyring();
  resetInstalls();
  api = await startTestServer();
  expect((await api.post("/api/connectors/stripe/connect", { secret: STRIPE_KEY }, { auth: ROLE_KEYS.admin })).status).toBe(201);

  const now = Math.floor(Date.now() / 1000);
  payouts.push(
    { id: "po_manuel0001", amount: 50000, currency: "eur", automatic: false, created: now, metadata: {} },
    { id: "po_auto00001", amount: 12000, currency: "eur", automatic: true, created: now, metadata: {} },
    { id: "po_marque0001", amount: 100, currency: "eur", automatic: false, created: now, metadata: { placet_execution: "exe_inconnue0002" } },
  );
  const requested = { id: "req_dashboard01", idempotency_key: null };
  events.push(
    { id: "evt_1", type: "payment_intent.canceled", created: now, request: requested, data: { object: { id: "pi_annule00001", amount: 2500, currency: "eur", cancellation_reason: "requested_by_customer", metadata: {} } } },
    { id: "evt_2", type: "payment_intent.canceled", created: now, request: { id: null, idempotency_key: null }, data: { object: { id: "pi_expire00001", amount: 900, currency: "eur", cancellation_reason: "abandoned", metadata: {} } } },
    { id: "evt_3", type: "customer.deleted", created: now, request: requested, data: { object: { id: "cus_supprime001", name: "Awa Diop", email: "awa@example.test", metadata: {} } } },
    { id: "evt_4", type: "charge.dispute.closed", created: now, request: requested, data: { object: { id: "dp_accepte0001", amount: 7000, currency: "eur", status: "lost", charge: "ch_litige0001", metadata: {} } } },
    { id: "evt_5", type: "charge.dispute.closed", created: now, request: { id: null }, data: { object: { id: "dp_gagne00001", amount: 3000, currency: "eur", status: "won", charge: "ch_litige0002", metadata: {} } } },
  );
}, 30_000);

afterAll(async () => {
  stripe.closeAllConnections();
  await new Promise<void>((r) => stripe.close(() => r()));
  for (const name of ["OATHRION_STRIPE_API_ORIGIN", "OATHRION_WEBHOOK_ALLOW_PRIVATE", "OATHRION_CONNECTOR_TIMEOUT_MS"]) delete process.env[name];
});

async function reconcile() {
  return api.post<Report>("/api/connectors/stripe/reconcile", {}, { auth: ROLE_KEYS.admin });
}

describe("virements, annulations, suppressions, litiges", () => {
  it("chaque écriture est classée, et l'alerte ne nomme ni le nom ni l'adresse du client", async () => {
    const res = await reconcile();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    /* 3 virements + 4 événements retenus (le litige gagné est ignoré). */
    expect(res.body.scanned).toBe(7);
    expect(res.body.outside.map((i) => i.id).sort()).toEqual(["cus_supprime001", "dp_accepte0001", "pi_annule00001", "po_manuel0001"]);
    expect(Object.fromEntries(res.body.outside.map((i) => [i.id, i.kind]))).toEqual({
      po_manuel0001: "payout",
      pi_annule00001: "payment",
      cus_supprime001: "customer",
      dp_accepte0001: "dispute",
    });
    expect(res.body.unknownMarker.map((i) => i.id)).toEqual(["po_marque0001"]);
    /* Le virement automatique et le paiement expiré : Stripe seul, comptés. */
    expect(res.body.others).toBe(2);
    expect(res.body.verdict).toBe("alert");
    expect(res.body.truncated).toBe(false);

    const summaries = res.body.outside.map((i) => i.summary).join(" | ");
    expect(summaries).toContain("Manual payout of 500 EUR");
    expect(summaries).toContain("Payment cancelled: 25 EUR (reason: requested_by_customer)");
    expect(summaries).toContain("Dispute lost: 70 EUR on ch_litige0001");
    expect(JSON.stringify(res.body)).not.toMatch(/Awa Diop|awa@example/);

    expect(eventsQuery).toContain("types[]=payment_intent.canceled");
    expect(eventsQuery).toContain("types[]=customer.deleted");
    expect(eventsQuery).toContain("types[]=charge.dispute.closed");
    expect(eventsQuery).toMatch(/created\[gte\]=\d+/);
    expect(res.body.limits.join(" ")).toMatch(/New payments/);
  });

  it("les écritures déjà vues restent gardées, et le panneau les liste", async () => {
    const state = await api.get<{ findings: { id: string; kind: string }[] }>("/api/connectors/stripe/reconcile", { auth: ROLE_KEYS.admin });
    expect(state.status).toBe(200);
    expect(state.body.findings.map((f) => f.kind).sort()).toEqual(["customer", "dispute", "payment", "payout", "payout"]);
  });
});

describe("une clé qui ne lit pas tout", () => {
  it("le journal refusé ne fait pas échouer le passage : il est dit, et le résultat est partiel", async () => {
    eventsForbidden = true;
    events.length = 0;
    payouts.length = 0;
    try {
      const res = await reconcile();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.verdict).toBe("partial");
      expect(res.body.truncated).toBe(true);
      expect(res.body.limits[0]).toMatch(/cannot read the event log/);
    } finally {
      eventsForbidden = false;
    }
  });
});
