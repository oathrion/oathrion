/**
 * STRIPE, DE BOUT EN BOUT, PAR L'API RÉELLE — le même parcours que Slack, Linear et GitHub.
 *
 * Connecter (une clé réelle ou publiable est refusée), choisir le compte, puis faire agir
 * un agent par `POST /api/execute` et par MCP, et constater :
 *
 *   · une lecture du compte choisi atteint Stripe, une fois ;
 *   · un remboursement sur un compte NON choisi : zéro requête à Stripe ;
 *   · un remboursement attend l'approbation, part UNE fois avec la clé d'idempotence de
 *     l'exécution, et une seconde approbation ne relâche rien ;
 *   · le plafond de dépense de l'agent s'applique au montant déclaré, avant tout appel ;
 *   · sans la permission `execute:payments`, rien ne part ;
 *   · le scénario guidé lit les paiements et ne rembourse jamais de lui-même.
 *
 * SIMULÉ au sens du rapport de release : Stripe est ici un serveur local qui répond comme
 * lui. La preuve contre le vrai Stripe (mode test) est `npm run verify:launch`.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetVaultKeyring } from "../connectors/vault";
import { resetInstalls } from "../connectors/oauth-install";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { seedIfEmpty } from "../repositories";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const KEY = "sk_test_bonnecleOathrionLancementxxxxxx";
const ACCOUNT = "acct_1OathrionLaunchAcct";
const OTHER_ACCOUNT = "acct_9AutreCompteXyz";
const PAYMENT = "pi_3OathrionLaunchEur01";

const AGENT_ID = "agt_stripe_launch";
const CAPPED_ID = "agt_stripe_plafond";
const READER_ID = "agt_stripe_lecteur";

interface Hit {
  method: string;
  path: string;
  idempotencyKey: string;
  form: URLSearchParams;
}
const hits: Hit[] = [];
let stripeServer: Server;
let api: TestClient;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const refunds = new Map<string, Record<string, unknown>>();

function stripe(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? "/", "http://stripe.local");
  hits.push({ method: req.method ?? "", path: url.pathname, idempotencyKey: String(req.headers["idempotency-key"] ?? ""), form: new URLSearchParams(body) });
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    return send(res, 401, { error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_****" } });
  }
  if (url.pathname === "/v1/account") return send(res, 200, { id: ACCOUNT, livemode: false, settings: { dashboard: { display_name: "Kryxor test" } } });
  if (url.pathname === "/v1/payment_intents") {
    return send(res, 200, { data: [{ id: PAYMENT, amount: 5000, amount_received: 5000, currency: "eur", status: "succeeded", created: 1_700_000_000 }] });
  }
  if (url.pathname === `/v1/payment_intents/${PAYMENT}`) return send(res, 200, { id: PAYMENT, currency: "eur", status: "succeeded", amount: 5000 });
  if (url.pathname === "/v1/refunds" && req.method === "POST") {
    const key = String(req.headers["idempotency-key"] ?? "");
    const form = new URLSearchParams(body);
    const refund = refunds.get(key) ?? { id: `re_${String(refunds.size + 1).padStart(6, "0")}Launch`, amount: Number(form.get("amount")), currency: "eur", status: "succeeded" };
    refunds.set(key, refund);
    return send(res, 200, refund);
  }
  return send(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } });
}

const posted = () => hits.filter((h) => h.method === "POST" && h.path === "/v1/refunds");

async function act(agentId: string, action: string, target: string, metadata: Record<string, unknown> = {}) {
  const reply = await api.post<Record<string, unknown>>("/api/execute", { agentId, action, target, metadata }, { auth: ROLE_KEYS.admin });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body;
}

function agent(id: string, scopes: string[], maxTransactionAmount: number | null) {
  return {
    id,
    name: `Agent ${id}`,
    description: "Traite les demandes de remboursement.",
    provider: "anthropic",
    model: "claude",
    status: "active",
    owner: "support",
    mandate: { maxTransactionAmount, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: ["stripe.com"] },
    permissions: scopes.map((scope) => ({ scope, label: scope, description: "", granted: true, risk: "medium" })),
    policyIds: [],
    tags: ["test"],
  };
}

beforeAll(async () => {
  stripeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => stripe(req, res, body));
  });
  await new Promise<void>((r) => stripeServer.listen(0, "127.0.0.1", r));
  process.env.OATHRION_STRIPE_API_ORIGIN = `http://127.0.0.1:${String((stripeServer.address() as AddressInfo).port)}`;
  process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE = "true";
  process.env.OATHRION_CONNECTOR_TIMEOUT_MS = "1000";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  resetVaultKeyring();
  resetInstalls();

  api = await startTestServer();
  await seedIfEmpty();
  for (const body of [
    agent(AGENT_ID, ["read:payments", "execute:payments"], null),
    agent(CAPPED_ID, ["read:payments", "execute:payments"], 10),
    agent(READER_ID, ["read:payments"], null),
  ]) {
    const created = await api.post("/api/agents", body, { auth: ROLE_KEYS.admin });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  }
});

afterAll(async () => {
  stripeServer.closeAllConnections();
  await new Promise<void>((r) => stripeServer.close(() => r()));
  for (const name of ["OATHRION_STRIPE_API_ORIGIN", "OATHRION_WEBHOOK_ALLOW_PRIVATE", "OATHRION_CONNECTOR_TIMEOUT_MS"]) delete process.env[name];
});

describe("1. connecter, vérifié contre Stripe", () => {
  it("Stripe figure au catalogue, non configuré", async () => {
    const listed = await api.get<{ id: string; status: { state: string } }[]>("/api/connectors", { auth: ROLE_KEYS.admin });
    expect(listed.body.map((c) => c.id)).toEqual(expect.arrayContaining(["github", "slack", "linear", "stripe"]));
    expect(listed.body.find((c) => c.id === "stripe")!.status.state).toBe("not_configured");
  });

  it.each([
    ["une clé RÉELLE", "sk_live_abcdefghijklmnopqrstuv"],
    ["une clé publiable", "pk_test_abcdefghijklmnopqrstuv"],
  ])("%s est refusée sans être envoyée", async (_label, secret) => {
    const before = hits.length;
    const refused = await api.post("/api/connectors/stripe/connect", { secret }, { auth: ROLE_KEYS.admin });
    expect(refused.status).toBe(422);
    expect(hits.length).toBe(before);
  });

  it("une clé de test se connecte, et la liste nomme le compte sans montrer la clé", async () => {
    const connected = await api.post("/api/connectors/stripe/connect", { secret: KEY }, { auth: ROLE_KEYS.admin });
    expect(connected.status, JSON.stringify(connected.body)).toBe(201);
    const listed = await api.get<{ id: string; status: { state: string; account: string } }[]>("/api/connectors", { auth: ROLE_KEYS.admin });
    expect(listed.body.find((c) => c.id === "stripe")!.status).toMatchObject({ state: "connected", account: `Kryxor test (${ACCOUNT})` });
    expect(JSON.stringify(listed.body)).not.toContain(KEY);
  });
});

describe("2. choisir le compte", () => {
  it("la ressource est le compte de la clé", async () => {
    const resources = await api.get<{ resources: { target: string }[] }>("/api/connectors/stripe/resources", { auth: ROLE_KEYS.admin });
    expect(resources.body.resources.map((r) => r.target)).toEqual([`stripe.com/${ACCOUNT}`]);
  });

  it("refuse un compte que la clé n'atteint pas", async () => {
    const refused = await api.put("/api/connectors/stripe/selection", { resources: [`stripe.com/${OTHER_ACCOUNT}`] }, { auth: ROLE_KEYS.admin });
    expect(refused.status).toBe(422);
  });

  it("le choix devient les deux politiques Stripe", async () => {
    const sel = await api.put("/api/connectors/stripe/selection", { resources: [`stripe.com/${ACCOUNT}`], writes: "approval" }, { auth: ROLE_KEYS.admin });
    expect(sel.status, JSON.stringify(sel.body)).toBe(200);
    const policies = await api.get<{ id: string }[]>("/api/policies", { auth: ROLE_KEYS.admin });
    expect(policies.body.map((p) => p.id)).toEqual(expect.arrayContaining(["pol_placet_stripe_perimetre", "pol_placet_stripe_ecritures"]));
  });
});

describe("3. agir par la passerelle", () => {
  it("ALLOW : lire les paiements du compte choisi atteint Stripe", async () => {
    const result = await act(AGENT_ID, "stripe.payments.list", `stripe.com/${ACCOUNT}`, { limit: 5 });
    expect(result).toMatchObject({ decision: "ALLOW", succeeded: true });
    expect((result.toolResult as { payments: { id: string }[] }).payments.map((p) => p.id)).toEqual([PAYMENT]);
  });

  it("BLOCK : un remboursement sur un compte non choisi n'atteint JAMAIS Stripe", async () => {
    const before = hits.length;
    const result = await act(AGENT_ID, "stripe.refund.create", `stripe.com/${OTHER_ACCOUNT}/${PAYMENT}`, { amount: 1, currency: "EUR" });
    expect(result).toMatchObject({ decision: "BLOCK", attempted: false });
    expect(String(result.policyId ?? result.reason)).toContain("pol_placet_stripe_perimetre");
    expect(hits.length).toBe(before);
  });

  it("APPROVAL : rien ne part avant ; l'approbation rembourse UNE fois, avec la clé de l'exécution", async () => {
    const held = await act(AGENT_ID, "stripe.refund.create", `stripe.com/${ACCOUNT}/${PAYMENT}`, {
      amount: 12.5,
      currency: "EUR",
      refund_reason: "requested_by_customer",
    });
    expect(held).toMatchObject({ decision: "APPROVAL_REQUIRED", attempted: false });
    expect(posted()).toHaveLength(0);

    const approved = await api.post<{ succeeded: boolean; toolResult: Record<string, unknown> }>(
      `/api/approvals/${String(held.approvalId)}/approve`,
      {},
      { auth: ROLE_KEYS.approver },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.succeeded).toBe(true);
    expect(approved.body.toolResult).toMatchObject({ amount: 12.5, currency: "EUR", payment: PAYMENT });
    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.form.get("amount")).toBe("1250");
    expect(posted()[0]!.idempotencyKey).toBe(`placet-${String(held.executionId)}`);

    await api.post(`/api/approvals/${String(held.approvalId)}/approve`, {}, { auth: ROLE_KEYS.approver });
    expect(posted()).toHaveLength(1);
  });

  it("le PLAFOND de l'agent s'applique au montant déclaré, avant tout appel", async () => {
    /* Écritures libres le temps de ce test : seul le plafond peut alors retenir un remboursement. */
    const free = await api.put("/api/connectors/stripe/selection", { resources: [`stripe.com/${ACCOUNT}`], writes: "allow" }, { auth: ROLE_KEYS.admin });
    expect(free.status).toBe(200);
    try {
      const before = { hits: hits.length, refunds: posted().length };
      /* Au-delà du plafond autonome : une personne décide (règle du mandat, `shared/policy/mandate.ts`). */
      const over = await act(CAPPED_ID, "stripe.refund.create", `stripe.com/${ACCOUNT}/${PAYMENT}`, { amount: 12.5, currency: "EUR" });
      expect(over).toMatchObject({ decision: "APPROVAL_REQUIRED", attempted: false });
      expect(String(over.reason)).toMatch(/^12,50.€ stripe\.refund\.create exceeds .*spending limit of 10,00.€/);
      /* Sans montant, ou dans une autre devise : non comparable au plafond, refusé. */
      const undeclared = await act(CAPPED_ID, "stripe.refund.create", `stripe.com/${ACCOUNT}/${PAYMENT}`, { currency: "EUR" });
      expect(undeclared.decision).toBe("BLOCK");
      const foreign = await act(CAPPED_ID, "stripe.refund.create", `stripe.com/${ACCOUNT}/${PAYMENT}`, { amount: 5, currency: "USD" });
      expect(foreign.decision).toBe("BLOCK");
      expect(hits.length).toBe(before.hits);

      /* Sous le plafond, sans règle d'approbation : le remboursement part, une fois. */
      const under = await act(CAPPED_ID, "stripe.refund.create", `stripe.com/${ACCOUNT}/${PAYMENT}`, { amount: 5, currency: "EUR" });
      expect(under).toMatchObject({ decision: "ALLOW", succeeded: true });
      expect(posted().length).toBe(before.refunds + 1);
      expect(posted().at(-1)!.form.get("amount")).toBe("500");
    } finally {
      await api.put("/api/connectors/stripe/selection", { resources: [`stripe.com/${ACCOUNT}`], writes: "approval" }, { auth: ROLE_KEYS.admin });
    }
  });

  it("par défaut, même sous le plafond, le remboursement attend une approbation", async () => {
    const under = await act(CAPPED_ID, "stripe.refund.create", `stripe.com/${ACCOUNT}/${PAYMENT}`, { amount: 5, currency: "EUR" });
    expect(under).toMatchObject({ decision: "APPROVAL_REQUIRED", attempted: false });
  });

  it("sans la permission execute:payments, rien ne part", async () => {
    const before = hits.length;
    const refused = await act(READER_ID, "stripe.refund.create", `stripe.com/${ACCOUNT}/${PAYMENT}`, { amount: 1, currency: "EUR" });
    expect(refused.decision).toBe("BLOCK");
    expect(hits.length).toBe(before);
  });
});

describe("4. la voie MCP", () => {
  async function rpc(method: string, params: Record<string, unknown>) {
    return api.post<{ result?: Record<string, unknown> }>(
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
          "X-Oathrion-Agent-Id": AGENT_ID,
        },
      },
    );
  }

  it("tools/list annonce le remboursement comme RÉEL, montant et devise à l'appui", async () => {
    const listed = await rpc("tools/list", {});
    expect(listed.status).toBe(200);
    const tools = (listed.body.result?.tools ?? []) as { name: string; description: string; inputSchema: { properties: Record<string, unknown> } }[];
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["stripe.balance.read", "stripe.payments.list", "stripe.customers.search", "stripe.refund.create"]),
    );
    const refund = tools.find((t) => t.name === "stripe.refund.create")!;
    expect(refund.description).toMatch(/REAL call/);
    expect(refund.inputSchema.properties).toHaveProperty("amount");
    expect(refund.inputSchema.properties).toHaveProperty("currency");
    expect(refund.inputSchema.properties).toHaveProperty("refund_reason");
  });

  it("tools/call d'un remboursement est retenu, et rien ne part", async () => {
    const before = posted().length;
    const called = await rpc("tools/call", {
      name: "stripe.refund.create",
      arguments: { target: `stripe.com/${ACCOUNT}/${PAYMENT}`, amount: 2, currency: "EUR" },
    });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    expect((called.body.result as { structuredContent: Record<string, unknown> }).structuredContent).toMatchObject({
      decision: "APPROVAL_REQUIRED",
      attempted: false,
      mode: "CONNECTOR",
    });
    expect(posted().length).toBe(before);
  });
});

describe("5. le scénario guidé avec Stripe seul", () => {
  type Step = { key: string; decision: string; action: string; target: string; attempted: boolean; succeeded: boolean };

  it("lit les paiements, refuse le compte non choisi sans l'appeler, et ne rembourse rien", async () => {
    const before = { hits: hits.length, refunds: posted().length };
    const ran = await api.post<{ steps: Step[] }>("/api/scenario/run", { agentId: AGENT_ID }, { auth: ROLE_KEYS.admin });
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    const by = Object.fromEntries(ran.body.steps.map((s) => [s.key, s]));
    expect(Object.keys(by).sort()).toEqual(["outside", "payments"]);
    expect(by.payments).toMatchObject({ decision: "ALLOW", succeeded: true, action: "stripe.payments.list", target: `stripe.com/${ACCOUNT}` });
    expect(by.outside).toMatchObject({ decision: "BLOCK", attempted: false, action: "stripe.refund.create" });
    expect(posted().length).toBe(before.refunds);
    /*
     * La lecture : le compte relu, puis les paiements. Puis la liste des ressources (le
     * compte, encore) pour chercher une cible hors périmètre RÉELLE — une clé n'en atteint
     * qu'une : la cible est donc un exemple. La tentative elle-même n'appelle rien.
     */
    expect(hits.slice(before.hits).map((h) => h.path)).toEqual(["/v1/account", "/v1/payment_intents", "/v1/account"]);
  });
});

describe("6. l'isolation entre organisations", () => {
  it("une autre organisation ne voit pas la connexion Stripe", async () => {
    const listed = await api.get<{ id: string; status: { state: string } }[]>("/api/connectors", { auth: OTHER_ORG_KEYS.admin });
    expect(listed.body.find((c) => c.id === "stripe")!.status.state).toBe("not_configured");
  });
});
