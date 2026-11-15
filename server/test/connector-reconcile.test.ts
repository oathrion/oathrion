/**
 * LA RÉCONCILIATION — ce qui s'est passé chez le service SANS Oathrion.
 *
 * `POST /api/connectors/:id/reconcile` relit ce que le service a enregistré depuis la
 * connexion de l'outil, et le confronte aux reçus. Ce fichier fixe le classement :
 *
 *   · une issue créée PAR Oathrion (marque + exécution connue)          → via Oathrion ;
 *   · une issue du même compte, SANS marque (une autre clé, une personne) → hors Oathrion ;
 *   · une issue d'un autre compte (un collègue)                        → compté, pas jugé ;
 *   · une marque qui ne correspond à aucune exécution de l'organisation → alerte ;
 *   · une écriture antérieure à la connexion                           → hors fenêtre ;
 *   · Stripe : un remboursement sans marque                            → hors Oathrion.
 *
 * SIMULÉ : GitHub et Stripe sont des serveurs locaux qui répondent comme eux.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetVaultKeyring } from "../connectors/vault";
import { resetInstalls } from "../connectors/oauth-install";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { notifier, type NotificationEvent } from "../notifications";
import { SlackChannel } from "../notifications/slack";

const GH_TOKEN = "github_pat_reconciliationOathrionxxxxxxxxxxxxx";
const STRIPE_KEY = "sk_test_reconciliationOathrionxxxxxxxx";
const AGENT = "agt_reconciliation";

interface Issue { number: number; title: string; body: string; user: { login: string }; created_at: string; html_url: string; pull_request?: object }
const issues: Issue[] = [];
const refunds: Record<string, unknown>[] = [];
let refundQuery = "";
let github: Server;
let stripe: Server;
let api: TestClient;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function githubHandler(req: IncomingMessage, res: ServerResponse, raw: string): void {
  if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(res, 401, { message: "Bad credentials" });
  const url = new URL(req.url ?? "/", "http://gh");
  if (url.pathname === "/user") return send(res, 200, { login: "kryxor" });
  if (url.pathname === "/user/repos") return send(res, 200, [{ full_name: "kryxor/produit", private: true, permissions: { push: true } }]);
  if (url.pathname === "/repos/kryxor/produit/issues" && req.method === "POST") {
    const body = JSON.parse(raw) as { title: string; body: string };
    const issue: Issue = { number: issues.length + 1, title: body.title, body: body.body, user: { login: "kryxor" }, created_at: new Date().toISOString(), html_url: `https://github.com/kryxor/produit/issues/${String(issues.length + 1)}` };
    issues.push(issue);
    return send(res, 201, issue);
  }
  if (url.pathname === "/repos/kryxor/produit/issues") return send(res, 200, issues);
  if (url.pathname === "/repos/kryxor/produit/issues/comments") return send(res, 200, []);
  return send(res, 404, { message: "Not Found" });
}

function stripeHandler(req: IncomingMessage, res: ServerResponse): void {
  if (req.headers.authorization !== `Bearer ${STRIPE_KEY}`) return send(res, 401, { error: { type: "invalid_request_error", message: "Invalid API Key" } });
  const url = new URL(req.url ?? "/", "http://stripe");
  if (url.pathname === "/v1/account") return send(res, 200, { id: "acct_1ReconciliationX", settings: { dashboard: { display_name: "Kryxor test" } } });
  if (url.pathname === "/v1/refunds") {
    refundQuery = url.search;
    return send(res, 200, { data: refunds, has_more: false });
  }
  /* Virements et journal d'événements : éprouvés dans connector-reconcile-stripe-money.test.ts. */
  if (url.pathname === "/v1/payouts" || url.pathname === "/v1/events") return send(res, 200, { data: [], has_more: false });
  return send(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such" } });
}

function serve(handler: (req: IncomingMessage, res: ServerResponse, raw: string) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => handler(req, res, raw));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` })));
}

type Report = {
  ok: boolean;
  since: string;
  identity: string;
  scanned: number;
  viaOathrion: number;
  outside: { id: string; actor: string | null; kind: string }[];
  unknownMarker: { id: string; marker: string }[];
  others: number;
  verdict: string;
  limits: string[];
};

let placetExecutionId = "";

beforeAll(async () => {
  const g = await serve(githubHandler);
  const s = await serve((req, res) => stripeHandler(req, res));
  github = g.server;
  stripe = s.server;
  process.env.OATHRION_GITHUB_API_ORIGIN = g.origin;
  process.env.OATHRION_STRIPE_API_ORIGIN = s.origin;
  process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE = "true";
  process.env.OATHRION_CONNECTOR_TIMEOUT_MS = "1000";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  resetVaultKeyring();
  resetInstalls();
  api = await startTestServer();

  /* Une issue créée AVANT la connexion : hors fenêtre, quelle qu'elle soit. */
  issues.push({ number: 0, title: "Avant Oathrion", body: "", user: { login: "kryxor" }, created_at: "2020-01-01T00:00:00Z", html_url: "https://github.com/kryxor/produit/issues/0" });

  expect((await api.post("/api/connectors/github/connect", { secret: GH_TOKEN }, { auth: ROLE_KEYS.admin })).status).toBe(201);
  expect((await api.post("/api/connectors/stripe/connect", { secret: STRIPE_KEY }, { auth: ROLE_KEYS.admin })).status).toBe(201);
  const sel = await api.put("/api/connectors/github/selection", { resources: ["github.com/kryxor/produit"], writes: "allow" }, { auth: ROLE_KEYS.admin });
  expect(sel.status, JSON.stringify(sel.body)).toBe(200);
  const agent = await api.post(
    "/api/agents",
    {
      id: AGENT,
      name: "Agent réconcilié",
      description: "",
      provider: "custom",
      model: "agent-mcp",
      status: "active",
      owner: "essai",
      mandate: { maxTransactionAmount: null, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: ["github.com"] },
      permissions: ["read:repository", "write:repository"].map((scope) => ({ scope, label: scope, description: "", granted: true, risk: "medium" })),
      policyIds: [],
      tags: [],
    },
    { auth: ROLE_KEYS.admin },
  );
  expect(agent.status, JSON.stringify(agent.body)).toBeLessThan(300);

  /* 1. Une issue créée PAR Oathrion : la marque porte l'identifiant de l'exécution. */
  const run = await api.post<{ decision: string; executionId: string; succeeded: boolean }>(
    "/api/execute",
    { agentId: AGENT, action: "github.issue.create", target: "github.com/kryxor/produit", metadata: { title: "Par Oathrion" } },
    { auth: ROLE_KEYS.admin },
  );
  expect(run.body).toMatchObject({ decision: "ALLOW", succeeded: true });
  placetExecutionId = run.body.executionId;

  const now = new Date().toISOString();
  /* 2. Même compte, SANS marque : une autre clé, ou une personne. Hors Oathrion. */
  issues.push({ number: 50, title: "Créée directement", body: "aucune marque", user: { login: "kryxor" }, created_at: now, html_url: "https://github.com/kryxor/produit/issues/50" });
  /* 3. Un autre compte : un collègue. Compté, pas jugé. */
  issues.push({ number: 51, title: "Créée par une collègue", body: "", user: { login: "awa" }, created_at: now, html_url: "https://github.com/kryxor/produit/issues/51" });
  /* 4. Une marque qui ne correspond à aucune exécution de l'organisation. */
  issues.push({ number: 52, title: "Marque recopiée", body: "<!-- placet-execution: exe_inconnue0001 -->", user: { login: "kryxor" }, created_at: now, html_url: "https://github.com/kryxor/produit/issues/52" });

  refunds.push(
    { id: "re_placet0001", amount: 100, currency: "eur", payment_intent: "pi_3Essai000001", created: Math.floor(Date.now() / 1000), metadata: { placet_execution: placetExecutionId } },
    { id: "re_horsplacet1", amount: 2500, currency: "eur", payment_intent: "pi_3Essai000002", created: Math.floor(Date.now() / 1000), metadata: {} },
  );
}, 30_000);

afterAll(async () => {
  for (const server of [github, stripe]) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  for (const name of ["OATHRION_GITHUB_API_ORIGIN", "OATHRION_STRIPE_API_ORIGIN", "OATHRION_WEBHOOK_ALLOW_PRIVATE", "OATHRION_CONNECTOR_TIMEOUT_MS"]) delete process.env[name];
});

async function reconcile(id: string, auth: string = ROLE_KEYS.admin) {
  return api.post<Report & { code?: string }>(`/api/connectors/${id}/reconcile`, {}, { auth });
}

describe("GitHub : ce qui s'est passé sans Oathrion", () => {
  it("classe chaque écriture de la fenêtre, et seulement elles", async () => {
    const res = await reconcile("github");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.identity).toBe("kryxor");
    /* L'issue d'avant la connexion n'est pas lue : 4 dans la fenêtre. */
    expect(res.body.scanned).toBe(4);
    expect(res.body.viaOathrion).toBe(1);
    expect(res.body.outside.map((i) => i.id)).toEqual(["kryxor/produit#50"]);
    expect(res.body.outside[0]).toMatchObject({ actor: "kryxor", kind: "issue" });
    expect(res.body.unknownMarker.map((i) => i.marker)).toEqual(["exe_inconnue0001"]);
    expect(res.body.others).toBe(1);
    expect(res.body.verdict).toBe("alert");
    expect(res.body.limits.join(" ")).toMatch(/other author/);
  });
});

describe("Stripe : un remboursement sans marque est hors Oathrion", () => {
  it("la fenêtre commence à la connexion, et le remboursement sans marque est signalé", async () => {
    const res = await reconcile("stripe");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.viaOathrion).toBe(1);
    expect(res.body.outside.map((i) => i.id)).toEqual(["re_horsplacet1"]);
    expect(res.body.verdict).toBe("alert");
    const since = Math.floor(Date.parse(res.body.since) / 1000);
    expect(refundQuery).toContain(`created[gte]=${String(since)}`);
    expect(res.body.limits.join(" ")).toMatch(/does not say WHO/);
  });
});

describe("ce qui est refusé", () => {
  it("un outil non connecté, un outil sans réconciliation, un lecteur, une autre organisation", async () => {
    expect((await reconcile("linear")).status).toBe(422);
    expect((await reconcile("inconnu")).status).toBe(404);
    expect((await reconcile("github", ROLE_KEYS.viewer)).status).toBe(403);
    /* L'autre organisation n'a rien connecté : rien à réconcilier, et rien des nôtres. */
    const other = await reconcile("github", OTHER_ORG_KEYS.admin);
    expect(other.status).toBe(422);
    expect(JSON.stringify(other.body)).not.toContain("kryxor");
  });
});

describe("la console dit le résultat sans l'embellir", () => {
  const read = (relative: string) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src", relative), "utf8");

  it("un résultat partiel n'est jamais présenté comme « rien ne s'est passé », et les limites sont affichées", () => {
    const panel = read("components/connectors/ReconcilePanel.tsx");
    expect(panel).toMatch(/run\.verdict === "partial"[\s\S]{0,200}the result is partial/);
    /* Ce que la tâche périodique a établi est montré sans clic. */
    expect(panel).toMatch(/queryFn: \(\) => getReconcileState\(connectorId\)/);
    expect(panel).toMatch(/report\.limits\.map/);
    expect(panel).toMatch(/by other accounts \(counted, not judged\)/);
  });

  it("le bouton n'apparaît que pour `manage`, sur un outil connecté qui sait se réconcilier", () => {
    const page = read("pages/connectors.tsx");
    expect(page).toMatch(/canManage && connector\.reconcilable && state === "connected" \? \(\s*<ReconcilePanel/);
  });
});

describe("la mémoire et l'alerte unique", () => {
  it("le premier passage alerte une fois pour les nouvelles écritures ; le suivant ne ré-alerte pas", async () => {
    const events: NotificationEvent[] = [];
    notifier.register({
      id: "capture-reconcile",
      handles: (type) => type === "reconciliation.alert",
      deliver: async (event) => {
        events.push(event);
        return { channelId: "capture-reconcile", eventId: event.id, at: event.at, ok: true, detail: "capturé" };
      },
    });
    try {
      /* Les passages des tests précédents ont DÉJÀ vu #50 et #52 : rien de neuf à alerter. */
      const again = await reconcile("github");
      expect((again.body as unknown as { newFindings: number }).newFindings).toBe(0);
      await notifier.drain();
      expect(events).toHaveLength(0);

      /* Une NOUVELLE issue hors Oathrion : une alerte, une seule, qui la nomme. */
      issues.push({ number: 60, title: "Encore créée directement", body: "", user: { login: "kryxor" }, created_at: new Date().toISOString(), html_url: "https://github.com/kryxor/produit/issues/60" });
      const fresh = await reconcile("github");
      expect((fresh.body as unknown as { newFindings: number }).newFindings).toBe(1);
      await notifier.drain();
      expect(events).toHaveLength(1);
      expect(events[0]!.title).toMatch(/1 write\(s\) made outside Oathrion on GitHub/);
      expect(events[0]!.summary).toContain("kryxor/produit#60");
      expect(events[0]!.data).toMatchObject({ connector: "github" });

      await reconcile("github");
      await notifier.drain();
      expect(events).toHaveLength(1);
    } finally {
      notifier.clear();
    }
  });

  it("la console relit le dernier passage et les écritures vues, sans relancer", async () => {
    const res = await api.get<{ lastRun: { trigger: string; verdict: string; outsideCount: number }; findings: { id: string; category: string; firstSeenAt: string }[] }>(
      "/api/connectors/github/reconcile",
      { auth: ROLE_KEYS.viewer },
    );
    expect(res.status).toBe(200);
    expect(res.body.lastRun).toMatchObject({ trigger: "manual", verdict: "alert", outsideCount: 2 });
    expect(res.body.findings.map((f) => f.id).sort()).toEqual(["kryxor/produit#50", "kryxor/produit#52", "kryxor/produit#60"]);
    expect(res.body.findings.find((f) => f.id === "kryxor/produit#52")?.category).toBe("unknown_marker");
    /* Une autre organisation ne lit rien des nôtres. */
    const other = await api.get<{ lastRun: unknown; findings: unknown[] }>("/api/connectors/github/reconcile", { auth: OTHER_ORG_KEYS.admin });
    expect(other.body).toEqual({ lastRun: null, findings: [] });
  });
});

describe("le canal Slack de l'exploitant porte l'alerte, sans bouton", () => {
  it("un message lisible, avec les liens, et aucune action à cliquer", async () => {
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
      expect(channel.handles("reconciliation.alert")).toBe(true);
      const result = await channel.deliver({
        id: "ntf_x",
        at: new Date().toISOString(),
        type: "reconciliation.alert",
        title: "Oathrion — 1 write(s) made outside Oathrion on GitHub (Kryxor)",
        summary: "• kryxor/produit#60 — Created directly again (outside Oathrion, by kryxor) https://github.com/kryxor/produit/issues/60",
        risk: "high",
        agentId: "",
        agentName: "",
        executionId: null,
        approvalId: null,
        policyId: null,
        policyName: null,
        data: {},
      });
      expect(result.ok).toBe(true);
      const body = JSON.parse(received) as { text: string; blocks: { type: string }[] };
      expect(body.text).toMatch(/outside Oathrion on GitHub/);
      expect(JSON.stringify(body.blocks)).toContain("kryxor/produit#60");
      expect(body.blocks.some((b) => b.type === "actions")).toBe(false);
    } finally {
      sink.closeAllConnections();
      await new Promise<void>((r) => sink.close(() => r()));
    }
  });
});
