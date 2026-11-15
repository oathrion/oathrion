/**
 * LE CONNECTEUR STRIPE, CONTRE UN STRIPE LOCAL QUI RÉPOND COMME STRIPE.
 *
 * Test SIMULÉ au sens du rapport de release : le serveur imite l'API REST de Stripe
 * (formulaires urlencodés, erreurs dans `error.{type,code,message}`, 401 pour une clé
 * inconnue, `Idempotency-Key` qui rend le même remboursement). La preuve contre le vrai
 * Stripe (mode test) est `npm run verify:launch` avec `OATHRION_STRIPE_TEST_KEY`.
 *
 * Ce qu'il fixe :
 *   · une clé publiable ou réelle est refusée AVANT tout appel (le réel seulement sur
 *     décision de l'exploitant) ;
 *   · le compte de la cible doit être celui de la clé ;
 *   · un remboursement relit le paiement, refuse une devise différente ou un paiement non
 *     abouti, convertit le montant en unités mineures, et porte une clé d'idempotence
 *     stable par exécution ;
 *   · la clé n'apparaît dans aucun résultat ni message.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import {
  classifyStripeKey,
  parseStripeTarget,
  redactStripeMessage,
  refundIdempotencyKey,
  StripeConnector,
  stripeProbeCode,
} from "../connectors/stripe";
import type { ConnectorContext } from "../connectors/types";
import type { ConnectorVault } from "../connectors/vault";

const KEY = "sk_test_bonnecleOathrionTestxxxxxxxxxxxx";
const RESTRICTED = "rk_test_restreinteOathrionSansRefunds00";
const UNKNOWN = "sk_test_inconnueOathrionTestxxxxxxxxxxx";
const ACCOUNT = "acct_1OathrionTestAcct";
const OTHER = "acct_9AutreCompteXyz";
const PI_EUR = "pi_3OathrionEurSucceeded";
const PI_USD = "pi_3OathrionUsdSucceeded";
const PI_PENDING = "pi_3OathrionEurPending00";

interface Seen {
  method: string;
  path: string;
  authorization: string;
  idempotencyKey: string;
  form: URLSearchParams;
}

let server: Server;
let origin = "";
const seen: Seen[] = [];
const refundsByKey = new Map<string, Record<string, unknown>>();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function stripeError(res: ServerResponse, status: number, type: string, code: string, message: string): void {
  send(res, status, { error: { type, code, message } });
}

function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
  const authorization = req.headers.authorization ?? "";
  const idempotencyKey = String(req.headers["idempotency-key"] ?? "");
  const url = new URL(req.url ?? "/", "http://stripe.local");
  seen.push({ method: req.method ?? "", path: url.pathname + url.search, authorization, idempotencyKey, form: new URLSearchParams(raw) });

  if (authorization !== `Bearer ${KEY}` && authorization !== `Bearer ${RESTRICTED}`) {
    const shown = authorization.replace(/^Bearer /, "");
    return stripeError(res, 401, "invalid_request_error", "", `Invalid API Key provided: ${shown}`);
  }
  if (url.pathname === "/v1/account") {
    return send(res, 200, { id: ACCOUNT, livemode: false, settings: { dashboard: { display_name: "Kryxor test" } } });
  }
  if (url.pathname === "/v1/balance") {
    return send(res, 200, { available: [{ amount: 12345, currency: "eur" }], pending: [{ amount: 500, currency: "xof" }] });
  }
  if (url.pathname === "/v1/payment_intents") {
    return send(res, 200, {
      data: [
        { id: PI_EUR, amount: 5000, amount_received: 5000, currency: "eur", status: "succeeded", customer: null, created: 1_700_000_000 },
      ],
    });
  }
  if (url.pathname === "/v1/customers") {
    return send(res, 200, { data: [{ id: "cus_OathrionClient1", name: "Awa", email: url.searchParams.get("email"), created: 1_700_000_000 }] });
  }
  if (url.pathname.startsWith("/v1/payment_intents/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    if (id === PI_EUR) return send(res, 200, { id, currency: "eur", status: "succeeded", amount: 5000 });
    if (id === PI_USD) return send(res, 200, { id, currency: "usd", status: "succeeded", amount: 5000 });
    if (id === PI_PENDING) return send(res, 200, { id, currency: "eur", status: "requires_payment_method", amount: 5000 });
    return stripeError(res, 404, "invalid_request_error", "resource_missing", `No such payment_intent: '${id}'`);
  }
  if (url.pathname === "/v1/refunds" && req.method === "POST") {
    if (authorization === `Bearer ${RESTRICTED}`) {
      return stripeError(res, 403, "invalid_request_error", "", `The provided key '${RESTRICTED}' does not have the required permissions.`);
    }
    const form = new URLSearchParams(raw);
    const existing = refundsByKey.get(idempotencyKey);
    if (existing) return send(res, 200, existing);
    const refund = {
      id: `re_${String(refundsByKey.size + 1).padStart(8, "0")}Oathrion`,
      amount: Number(form.get("amount")),
      currency: "eur",
      status: "succeeded",
      payment_intent: form.get("payment_intent"),
    };
    if (idempotencyKey) refundsByKey.set(idempotencyKey, refund);
    return send(res, 200, refund);
  }
  return stripeError(res, 404, "invalid_request_error", "", "Unrecognized request URL");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
  refundsByKey.clear();
});

function envWith(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { OATHRION_STRIPE_API_ORIGIN: origin, OATHRION_WEBHOOK_ALLOW_PRIVATE: "true", OATHRION_CONNECTOR_TIMEOUT_MS: "1000", ...extra };
}

function contextWith(secret: string | null, extra: Record<string, string> = {}): ConnectorContext & { forgotten: () => boolean } {
  let stored = secret;
  const vault = {
    open: () => Promise.resolve(stored === null ? null : { secretEnvelope: stored, account: "", scopes: [] }),
    describe: () => Promise.resolve(null),
    revoke: () => {
      const had = stored !== null;
      stored = null;
      return Promise.resolve(had);
    },
  } as unknown as ConnectorVault;
  return {
    organizationId: "org_test" as OrganizationId,
    vault,
    env: envWith(extra),
    forgotten: () => stored === null,
  };
}

const stripe = new StripeConnector();

function request(action: string, target: string, metadata: Record<string, unknown> = {}, executionId = "exe_stripe_1") {
  return { action, target, metadata, executionId };
}

const refundsSent = () => seen.filter((s) => s.method === "POST" && s.path === "/v1/refunds");

describe("la forme de la clé, avant tout appel", () => {
  it("accepte une clé secrète ou restreinte de test", () => {
    expect(classifyStripeKey(KEY, {})).toEqual({ ok: true, mode: "test" });
    expect(classifyStripeKey(RESTRICTED, {})).toEqual({ ok: true, mode: "test" });
  });

  it("refuse une clé publiable", () => {
    const kind = classifyStripeKey("pk_test_abcdefghijklmnop", {});
    expect(kind.ok).toBe(false);
    expect(kind.ok ? "" : kind.detail).toMatch(/PUBLISHABLE/);
  });

  it("refuse une clé RÉELLE tant que l'exploitant ne l'a pas autorisée", () => {
    const live = "sk_live_abcdefghijklmnopqrst";
    expect(classifyStripeKey(live, {}).ok).toBe(false);
    expect(classifyStripeKey(live, { OATHRION_STRIPE_ALLOW_LIVE: "yes" }).ok).toBe(false);
    expect(classifyStripeKey(live, { OATHRION_STRIPE_ALLOW_LIVE: "true" })).toEqual({ ok: true, mode: "live" });
  });

  it.each(["", "sk_test_court", "sk_prod_abcdefghijklmnop", "bonjour"])("refuse %j", (key) => {
    expect(classifyStripeKey(key, {}).ok).toBe(false);
  });

  it("une clé réelle refusée n'atteint jamais Stripe", async () => {
    const probe = await stripe.verify("sk_live_abcdefghijklmnopqrst", {}, envWith());
    expect(probe).toMatchObject({ ok: false, code: "unauthorized" });
    expect(seen).toHaveLength(0);
  });
});

describe("la cible nomme le compte", () => {
  it("lit les deux formes", () => {
    expect(parseStripeTarget(`stripe.com/${ACCOUNT}`)).toEqual({ account: ACCOUNT, payment: null });
    expect(parseStripeTarget(`https://stripe.com/${ACCOUNT}/${PI_EUR}/`)).toEqual({ account: ACCOUNT, payment: PI_EUR });
  });

  it.each([
    ["un autre hôte", `evil.example/${ACCOUNT}`],
    ["le domaine seul", "stripe.com"],
    ["un compte mal formé", "stripe.com/acct_../x"],
    ["un paiement mal formé", `stripe.com/${ACCOUNT}/ch_123456789`],
    ["trop de segments", `stripe.com/${ACCOUNT}/${PI_EUR}/refunds`],
  ])("refuse %s", (_label, target) => {
    expect(() => parseStripeTarget(target)).toThrow();
  });
});

describe("la connexion", () => {
  it("une bonne clé nomme le compte tel que Stripe le rend, et le mode", async () => {
    const probe = await stripe.verify(KEY, {}, envWith());
    expect(probe).toMatchObject({ ok: true, code: "ok", account: `Kryxor test (${ACCOUNT})` });
    expect(probe.detail).toMatch(/TEST mode/);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/v1/account", authorization: `Bearer ${KEY}` });
  });

  it("une clé que Stripe ne connaît pas est « unauthorized », et le message ne la cite pas", async () => {
    const probe = await stripe.verify(UNKNOWN, {}, envWith());
    expect(probe).toMatchObject({ ok: false, code: "unauthorized" });
    expect(JSON.stringify(probe)).not.toContain(UNKNOWN);
  });

  it("les ressources : le compte de la clé, et lui seul", async () => {
    const listed = await stripe.resources(contextWith(KEY));
    expect(listed).toEqual({ ok: true, resources: [{ target: `stripe.com/${ACCOUNT}`, label: "Kryxor test", detail: ACCOUNT }] });
  });
});

describe("les lectures", () => {
  it("le solde, converti en unités par devise", async () => {
    const result = await stripe.execute(contextWith(KEY), request("stripe.balance.read", `stripe.com/${ACCOUNT}`));
    expect(result.ok).toBe(true);
    expect(result.data.available).toEqual([{ amount: 123.45, currency: "EUR" }]);
    expect(result.data.pending).toEqual([{ amount: 500, currency: "XOF" }]);
  });

  it("les paiements, bornés à 25 et avec leur cible de remboursement", async () => {
    const result = await stripe.execute(contextWith(KEY), request("stripe.payments.list", `stripe.com/${ACCOUNT}`, { limit: 999 }));
    expect(result.ok).toBe(true);
    expect(seen.at(-1)!.path).toBe("/v1/payment_intents?limit=25");
    expect(result.data.payments).toEqual([
      expect.objectContaining({ id: PI_EUR, amount: 50, currency: "EUR", status: "succeeded", target: `stripe.com/${ACCOUNT}/${PI_EUR}` }),
    ]);
  });

  it("les clients, filtrés par adresse", async () => {
    const result = await stripe.execute(contextWith(KEY), request("stripe.customers.search", `stripe.com/${ACCOUNT}`, { email: "awa@example.com" }));
    expect(result.ok).toBe(true);
    expect(seen.at(-1)!.path).toBe("/v1/customers?limit=10&email=awa%40example.com");
  });

  it("une cible écrite pour UN AUTRE compte n'agit pas sur celui de la clé", async () => {
    const result = await stripe.execute(contextWith(KEY), request("stripe.payments.list", `stripe.com/${OTHER}`));
    expect(result).toMatchObject({ ok: false, code: "forbidden", data: { dispatched: false, reason: "account_mismatch" } });
    expect(seen.map((s) => s.path)).toEqual(["/v1/account"]);
  });
});

describe("le remboursement", () => {
  const target = `stripe.com/${ACCOUNT}/${PI_EUR}`;

  it("relit le paiement, puis rembourse le montant DÉCLARÉ en unités mineures, avec une clé d'idempotence", async () => {
    const result = await stripe.execute(
      contextWith(KEY),
      request("stripe.refund.create", target, { amount: 12.5, currency: "EUR", refund_reason: "requested_by_customer", reason: "Le client a été facturé deux fois." }),
    );
    expect(result.ok).toBe(true);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/account", `GET /v1/payment_intents/${PI_EUR}`, "POST /v1/refunds"]);
    const sent = refundsSent()[0]!;
    expect(sent.idempotencyKey).toBe(refundIdempotencyKey("exe_stripe_1"));
    expect(Object.fromEntries(sent.form)).toEqual({
      payment_intent: PI_EUR,
      amount: "1250",
      reason: "requested_by_customer",
      "metadata[placet_execution]": "exe_stripe_1",
    });
    expect(result.data).toMatchObject({ amount: 12.5, currency: "EUR", payment: PI_EUR, status: "succeeded" });
    expect(result.data.url).toBe(`https://dashboard.stripe.com/test/payments/${PI_EUR}`);
  });

  it("rejouer LA MÊME exécution rend le MÊME remboursement : Stripe reconnaît la clé", async () => {
    const first = await stripe.execute(contextWith(KEY), request("stripe.refund.create", target, { amount: 1, currency: "EUR" }));
    const again = await stripe.execute(contextWith(KEY), request("stripe.refund.create", target, { amount: 1, currency: "EUR" }));
    expect(first.data.refund).toBe(again.data.refund);
    expect(refundsByKey.size).toBe(1);
    const other = await stripe.execute(contextWith(KEY), request("stripe.refund.create", target, { amount: 1, currency: "EUR" }, "exe_stripe_2"));
    expect(other.data.refund).not.toBe(first.data.refund);
  });

  it("une devise déclarée différente de celle du paiement : rien n'est remboursé", async () => {
    const result = await stripe.execute(contextWith(KEY), request("stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_USD}`, { amount: 10, currency: "EUR" }));
    expect(result).toMatchObject({ ok: false, data: { dispatched: false, reason: "currency_mismatch" } });
    expect(refundsSent()).toHaveLength(0);
  });

  it("un paiement non abouti : rien n'est remboursé", async () => {
    const result = await stripe.execute(contextWith(KEY), request("stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_PENDING}`, { amount: 10, currency: "EUR" }));
    expect(result).toMatchObject({ ok: false, data: { dispatched: false, reason: "payment_not_succeeded" } });
    expect(refundsSent()).toHaveLength(0);
  });

  it("un paiement introuvable est « not_found », et rien n'est remboursé", async () => {
    const result = await stripe.execute(contextWith(KEY), request("stripe.refund.create", `stripe.com/${ACCOUNT}/pi_3Inexistant000`, { amount: 10, currency: "EUR" }));
    expect(result).toMatchObject({ ok: false, code: "not_found", data: { dispatched: false } });
    expect(refundsSent()).toHaveLength(0);
  });

  it("une clé restreinte sans la permission est « forbidden », et la réponse ne cite pas la clé", async () => {
    const result = await stripe.execute(contextWith(RESTRICTED), request("stripe.refund.create", target, { amount: 1, currency: "EUR" }));
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
    expect(JSON.stringify(result)).not.toContain(RESTRICTED);
  });
});

describe("ce qui ne part jamais", () => {
  it.each([
    ["remboursement sans montant", "stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_EUR}`, { currency: "EUR" }],
    ["remboursement sans devise", "stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_EUR}`, { amount: 10 }],
    ["montant négatif", "stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_EUR}`, { amount: -5, currency: "EUR" }],
    ["montant nul", "stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_EUR}`, { amount: 0, currency: "EUR" }],
    ["trop de décimales", "stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_EUR}`, { amount: 1.234, currency: "EUR" }],
    ["devise non prise en charge", "stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_EUR}`, { amount: 1, currency: "GBP" }],
    ["motif Stripe inconnu", "stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_EUR}`, { amount: 1, currency: "EUR", refund_reason: "parce que" }],
    ["remboursement sans paiement", "stripe.refund.create", `stripe.com/${ACCOUNT}`, { amount: 1, currency: "EUR" }],
    ["lecture sur un paiement", "stripe.payments.list", `stripe.com/${ACCOUNT}/${PI_EUR}`, {}],
    ["client mal formé", "stripe.payments.list", `stripe.com/${ACCOUNT}`, { customer: "../admin" }],
    ["cible étrangère", "stripe.refund.create", `evil.example/${ACCOUNT}/${PI_EUR}`, { amount: 1, currency: "EUR" }],
  ])("%s", async (_label, action, target, metadata) => {
    const result = await stripe.execute(contextWith(KEY), request(action, target, metadata));
    expect(result.ok).toBe(false);
    expect(result.data.dispatched).toBe(false);
    expect(refundsSent()).toHaveLength(0);
  });

  it("sans connexion, rien ne part", async () => {
    const result = await stripe.execute(contextWith(null), request("stripe.balance.read", `stripe.com/${ACCOUNT}`));
    expect(result).toMatchObject({ ok: false, code: "unauthorized", data: { dispatched: false } });
    expect(seen).toHaveLength(0);
  });

  it("une clé réelle scellée avant que l'exploitant ne retire l'autorisation n'agit plus", async () => {
    const result = await stripe.execute(contextWith("sk_live_abcdefghijklmnopqrst"), request("stripe.balance.read", `stripe.com/${ACCOUNT}`));
    expect(result).toMatchObject({ ok: false, data: { dispatched: false, reason: "key_refused" } });
    expect(seen).toHaveLength(0);
  });

  it("la clé n'apparaît dans aucun résultat", async () => {
    const results = [
      await stripe.verify(KEY, {}, envWith()),
      await stripe.execute(contextWith(KEY), request("stripe.refund.create", `stripe.com/${ACCOUNT}/${PI_EUR}`, { amount: 1, currency: "EUR" })),
      await stripe.resources(contextWith(KEY)),
    ];
    expect(JSON.stringify(results)).not.toContain(KEY);
  });
});

describe("déconnecter", () => {
  it("Oathrion oublie la clé et dit qu'elle reste valide chez Stripe", async () => {
    const context = contextWith(KEY);
    const revocation = await stripe.revoke(context, "admin@test");
    expect(context.forgotten()).toBe(true);
    expect(revocation).toMatchObject({ ok: true, remoteStillValid: true });
    expect(revocation.detail).toMatch(/API keys/);
    expect(seen).toHaveLength(0);
  });
});

describe("le code machine et le masquage", () => {
  it("lit le statut et `error.code`", () => {
    expect(stripeProbeCode(200, null)).toBe("ok");
    expect(stripeProbeCode(401, null)).toBe("unauthorized");
    expect(stripeProbeCode(403, null)).toBe("forbidden");
    expect(stripeProbeCode(404, null)).toBe("not_found");
    expect(stripeProbeCode(400, { type: "invalid_request_error", code: "resource_missing", message: "" })).toBe("not_found");
    expect(stripeProbeCode(429, null)).toBe("rate_limited");
    expect(stripeProbeCode(502, null)).toBe("unreachable");
    expect(stripeProbeCode(400, { type: "invalid_request_error", code: "amount_too_large", message: "" })).toBe("unexpected");
  });

  it("ne garde que le préfixe d'une clé citée par Stripe", () => {
    expect(redactStripeMessage(`Invalid API Key provided: ${KEY}`)).toBe("Invalid API Key provided: sk_test_***");
    expect(redactStripeMessage("rk_live_ABCdef123 et pk_test_xyz987")).toBe("rk_live_*** et pk_test_***");
  });
});
