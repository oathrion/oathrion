/**
 * LA RÉCONCILIATION, ÉTENDUE À SLACK ET LINEAR.
 *
 *   · Slack : un message posté PAR Oathrion (métadonnées `placet_execution`) → via Oathrion ;
 *     un message du BOT sans marque → hors Oathrion ; un message d'une personne → compté ;
 *     un message système (arrivée dans le canal) → ignoré.
 *   · Linear : une tâche créée PAR Oathrion (« exécution exe_… ») → via Oathrion ; une tâche du
 *     même compte sans marque → hors Oathrion ; une tâche d'un autre compte → comptée.
 *
 * SIMULÉ : Slack et Linear sont des serveurs locaux qui répondent comme eux.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetVaultKeyring } from "../connectors/vault";
import { resetInstalls } from "../connectors/oauth-install";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const SLACK_TOKEN = "xoxb-1111111111-2222222222-reconciliationslack";
const LINEAR_KEY = "lin_api_reconciliationOathrionxxxxxxxxxxxxxx";
const AGENT = "agt_reconciliation_slack_linear";

type SlackMessage = Record<string, unknown>;
const slackMessages: SlackMessage[] = [];
let historyQuery = "";
type LinearIssue = { identifier: string; title: string; url: string; description: string; createdAt: string; creator: { id: string; name: string } };
const linearIssues: LinearIssue[] = [];
let slack: Server;
let linear: Server;
let api: TestClient;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function slackHandler(req: IncomingMessage, res: ServerResponse, raw: string): void {
  if (req.headers.authorization !== `Bearer ${SLACK_TOKEN}`) return send(res, 200, { ok: false, error: "invalid_auth" });
  const url = new URL(req.url ?? "/", "http://slack");
  const method = url.pathname.replace(/^\/api\//, "");
  if (method === "auth.test") return send(res, 200, { ok: true, user_id: "U0BOT", bot_id: "B0BOT", user: "placet", team: "kryxor" });
  if (method === "users.conversations") return send(res, 200, { ok: true, channels: [{ id: "C0PRODUIT01", name: "produit", is_private: false, is_member: true }] });
  if (method === "chat.postMessage") {
    const body = JSON.parse(raw) as { text: string; metadata?: unknown };
    const message = { type: "message", ts: (Date.now() / 1000).toFixed(6), text: body.text, bot_id: "B0BOT", metadata: body.metadata };
    slackMessages.push(message);
    return send(res, 200, { ok: true, ts: message.ts, channel: "C0PRODUIT01" });
  }
  if (method === "conversations.history") {
    historyQuery = url.search;
    return send(res, 200, { ok: true, messages: slackMessages, has_more: false });
  }
  return send(res, 200, { ok: false, error: "unknown_method" });
}

function linearHandler(req: IncomingMessage, res: ServerResponse, raw: string): void {
  if (req.headers.authorization !== LINEAR_KEY) return send(res, 400, { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] });
  const { query, variables } = JSON.parse(raw) as { query: string; variables: Record<string, unknown> };
  if (query.includes("issues(first: 100")) {
    expect(variables).toMatchObject({ key: "ENG" });
    return send(res, 200, { data: { issues: { nodes: linearIssues, pageInfo: { hasNextPage: false } }, comments: { nodes: [], pageInfo: { hasNextPage: false } } } });
  }
  if (query.includes("viewer")) return send(res, 200, { data: { viewer: { id: "u-placet", name: "Awa" }, organization: { name: "Kryxor", urlKey: "kryxor" } } });
  if (query.includes("teams(first")) return send(res, 200, { data: { teams: { nodes: [{ id: "t-eng", key: "ENG", name: "Engineering" }] } } });
  if (query.includes("teams(filter")) return send(res, 200, { data: { teams: { nodes: [{ id: "t-eng", key: "ENG" }] } } });
  if (query.includes("issueCreate")) {
    const input = variables.input as { title: string; description: string };
    const issue: LinearIssue = { identifier: `ENG-${String(linearIssues.length + 1)}`, title: input.title, url: "https://linear.app/kryxor/issue/ENG-1", description: input.description, createdAt: new Date().toISOString(), creator: { id: "u-placet", name: "Awa" } };
    linearIssues.push(issue);
    return send(res, 200, { data: { issueCreate: { success: true, issue: { id: "x", identifier: issue.identifier, title: issue.title, url: issue.url } } } });
  }
  return send(res, 400, { errors: [{ message: "Unknown query" }] });
}

function serve(handler: (req: IncomingMessage, res: ServerResponse, raw: string) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => handler(req, res, raw));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` })));
}

type Report = { scanned: number; viaOathrion: number; outside: { id: string; kind: string; actor: string | null }[]; others: number; verdict: string; identity: string; limits: string[] };

beforeAll(async () => {
  const s = await serve(slackHandler);
  const l = await serve(linearHandler);
  slack = s.server;
  linear = l.server;
  process.env.OATHRION_SLACK_API_ORIGIN = s.origin;
  process.env.OATHRION_LINEAR_API_ORIGIN = l.origin;
  process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE = "true";
  process.env.OATHRION_CONNECTOR_TIMEOUT_MS = "1000";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  resetVaultKeyring();
  resetInstalls();
  api = await startTestServer();

  expect((await api.post("/api/connectors/slack/connect", { secret: SLACK_TOKEN }, { auth: ROLE_KEYS.admin })).status).toBe(201);
  expect((await api.post("/api/connectors/linear/connect", { secret: LINEAR_KEY }, { auth: ROLE_KEYS.admin })).status).toBe(201);
  expect((await api.put("/api/connectors/slack/selection", { resources: ["slack.com/C0PRODUIT01"], writes: "allow" }, { auth: ROLE_KEYS.admin })).status).toBe(200);
  expect((await api.put("/api/connectors/linear/selection", { resources: ["linear.app/ENG"], writes: "allow" }, { auth: ROLE_KEYS.admin })).status).toBe(200);
  const agent = await api.post(
    "/api/agents",
    {
      id: AGENT,
      name: "Agent réconcilié (Slack, Linear)",
      description: "",
      provider: "custom",
      model: "agent-mcp",
      status: "active",
      owner: "essai",
      mandate: { maxTransactionAmount: null, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: ["slack.com", "linear.app"] },
      permissions: ["read:chat", "write:chat", "read:tasks", "write:tasks"].map((scope) => ({ scope, label: scope, description: "", granted: true, risk: "medium" })),
      policyIds: [],
      tags: [],
    },
    { auth: ROLE_KEYS.admin },
  );
  expect(agent.status, JSON.stringify(agent.body)).toBeLessThan(300);

  /* Par Oathrion : un message, une tâche. */
  for (const [action, target, metadata] of [
    ["slack.message.post", "slack.com/C0PRODUIT01", { text: "Résumé par Oathrion" }],
    ["linear.issue.create", "linear.app/ENG", { title: "Tâche par Oathrion" }],
  ] as const) {
    const run = await api.post<{ decision: string; succeeded: boolean }>("/api/execute", { agentId: AGENT, action, target, metadata }, { auth: ROLE_KEYS.admin });
    expect(run.body, JSON.stringify(run.body)).toMatchObject({ decision: "ALLOW", succeeded: true });
  }

  const ts = (Date.now() / 1000 + 1).toFixed(6);
  slackMessages.push(
    { type: "message", ts, text: "Posté par le bot, SANS Oathrion", bot_id: "B0BOT" },
    { type: "message", ts, text: "Bonjour l'équipe", user: "U0AWA" },
    { type: "message", subtype: "channel_join", ts, text: "<@U0NEW> a rejoint le canal", user: "U0NEW" },
  );
  const now = new Date().toISOString();
  linearIssues.push(
    { identifier: "ENG-50", title: "Créée sans Oathrion", url: "https://linear.app/kryxor/issue/ENG-50", description: "aucune marque", createdAt: now, creator: { id: "u-placet", name: "Awa" } },
    { identifier: "ENG-51", title: "Créée par un collègue", url: "https://linear.app/kryxor/issue/ENG-51", description: "", createdAt: now, creator: { id: "u-moussa", name: "Moussa" } },
  );
}, 30_000);

afterAll(async () => {
  for (const server of [slack, linear]) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  for (const name of ["OATHRION_SLACK_API_ORIGIN", "OATHRION_LINEAR_API_ORIGIN", "OATHRION_WEBHOOK_ALLOW_PRIVATE", "OATHRION_CONNECTOR_TIMEOUT_MS"]) delete process.env[name];
});

async function reconcile(id: string) {
  return api.post<Report>(`/api/connectors/${id}/reconcile`, {}, { auth: ROLE_KEYS.admin });
}

describe("Slack", () => {
  it("le message d'Oathrion est reconnu, celui du bot sans marque est signalé, la personne est comptée, le système ignoré", async () => {
    const res = await reconcile("slack");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scanned).toBe(3);
    expect(res.body.viaOathrion).toBe(1);
    expect(res.body.outside).toHaveLength(1);
    expect(res.body.outside[0]).toMatchObject({ kind: "message", actor: "bot Oathrion" });
    expect(res.body.others).toBe(1);
    expect(res.body.verdict).toBe("alert");
    expect(historyQuery).toContain("include_all_metadata=true");
    expect(historyQuery).toMatch(/oldest=\d+\.\d{6}/);
  });
});

describe("Linear", () => {
  it("la tâche d'Oathrion est reconnue, celle du même compte sans marque est signalée, le collègue est compté", async () => {
    const res = await reconcile("linear");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.identity).toBe("Awa (Kryxor)");
    expect(res.body.scanned).toBe(3);
    expect(res.body.viaOathrion).toBe(1);
    expect(res.body.outside.map((i) => i.id)).toEqual(["ENG-50"]);
    expect(res.body.others).toBe(1);
    expect(res.body.verdict).toBe("alert");
    /* La limite de la clé personnelle est dite avec le résultat. */
    expect(res.body.limits.join(" ")).toMatch(/personal key/);
  });
});

describe("les quatre outils savent maintenant se réconcilier", () => {
  it("le catalogue l'annonce pour GitHub, Slack, Linear et Stripe", async () => {
    const listed = await api.get<{ id: string; reconcilable: boolean }[]>("/api/connectors", { auth: ROLE_KEYS.admin });
    expect(Object.fromEntries(listed.body.map((c) => [c.id, c.reconcilable]))).toEqual({ github: true, slack: true, linear: true, stripe: true });
  });
});
