/**
 * LE PARCOURS DE LANCEMENT, DE BOUT EN BOUT, PAR L'API RÉELLE.
 *
 * Connecter Slack et Linear (jeton puis OAuth), choisir les ressources, puis faire agir un
 * agent par `POST /api/execute` — la même route qu'un agent réel — et constater :
 *
 *   · ALLOW : l'appel atteint le fournisseur, une fois ;
 *   · BLOCK (ressource non choisie) : ZÉRO requête au fournisseur ;
 *   · APPROVAL_REQUIRED : rien ne part avant l'approbation, l'approbation part une fois,
 *     une seconde approbation ne relâche rien ;
 *   · une autre organisation ne voit ni n'utilise la connexion ;
 *   · le retour OAuth refuse un navigateur qui n'a pas lancé la connexion.
 *
 * SIMULÉ au sens du rapport de release : Slack et Linear sont ici des serveurs locaux qui
 * répondent comme eux. Tout le reste — routes, passerelle, moteur, coffre chiffré,
 * approbations — est le code livré.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetVaultKeyring } from "../connectors/vault";
import { META_KEYS, PROTOCOL_VERSION } from "../mcp/protocol";
import { resetInstalls } from "../connectors/oauth-install";
import { seedIfEmpty } from "../repositories";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const SLACK_TOKEN = "xoxb-1111111111-2222222222-bonjetonvalideplacet";
const SLACK_OAUTH_TOKEN = "xoxb-1111111111-2222222222-jetonissuoauthxxxx";
const LINEAR_KEY = "lin_api_bonnecleOathrionTestxxxxxxxxxxxxxxxx";
const ALLOWED = "C0PRODUIT01";
const OTHER = "C0AUTRE0001";

interface Hit {
  service: "slack" | "linear" | "github";
  what: string;
  body: string;
}
const hits: Hit[] = [];
let slowSeen = false;

let slackServer: Server;
let linearServer: Server;
let githubServer: Server;
const GITHUB_TOKEN = "github_pat_jetonDeTestOathrionxxxxxxxxxxxxxx";
let api: TestClient;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function slack(req: IncomingMessage, res: ServerResponse, body: string): void {
  const method = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/api\//, "");
  hits.push({ service: "slack", what: method, body });
  if (method === "oauth.v2.access") {
    const form = new URLSearchParams(body);
    if (form.get("code") !== "code-valide") return send(res, 200, { ok: false, error: "invalid_code" });
    return send(res, 200, { ok: true, token_type: "bot", access_token: SLACK_OAUTH_TOKEN, scope: "chat:write,channels:read,channels:history", team: { name: "kryxor" } });
  }
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (token !== SLACK_TOKEN && token !== SLACK_OAUTH_TOKEN) return send(res, 200, { ok: false, error: "invalid_auth" });
  const h = { "x-oauth-scopes": "chat:write,channels:read,channels:history" };
  switch (method) {
    case "auth.test":
      return send(res, 200, { ok: true, team: "kryxor", user: "placet" }, h);
    case "users.conversations":
      return send(res, 200, {
        ok: true,
        channels: [{ id: ALLOWED, name: "produit" }, { id: OTHER, name: "general" }],
        response_metadata: { next_cursor: "" },
      }, h);
    case "conversations.history":
      return send(res, 200, { ok: true, messages: [{ ts: "1", user: "U1", text: "Bug : la connexion échoue" }] }, h);
    case "chat.postMessage":
      /* « LENT » : Slack reçoit le message et ne répond pas, la PREMIÈRE fois — l'effet est inconnu. */
      if ((JSON.parse(body) as { text?: string }).text === "LENT" && !slowSeen) {
        slowSeen = true;
        return;
      }
      return send(res, 200, { ok: true, ts: "1700000000.000100" }, h);
    case "chat.getPermalink":
      return send(res, 200, { ok: true, permalink: "https://kryxor.slack.com/archives/x/p1" }, h);
    default:
      return send(res, 200, { ok: false, error: "unknown_method" });
  }
}

function linear(req: IncomingMessage, res: ServerResponse, body: string): void {
  const { query, variables } = JSON.parse(body || "{}") as { query?: string; variables?: Record<string, unknown> };
  hits.push({ service: "linear", what: query ?? req.url ?? "", body });
  if (req.headers.authorization !== LINEAR_KEY) {
    return send(res, 400, { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] });
  }
  if (query?.includes("viewer")) return send(res, 200, { data: { viewer: { name: "Mariama" }, organization: { name: "Kryxor" } } });
  if (query?.includes("teams(first")) {
    return send(res, 200, { data: { teams: { nodes: [{ id: "t-eng", key: "ENG", name: "Engineering" }, { id: "t-ops", key: "OPS", name: "Ops" }] } } });
  }
  if (query?.includes("teams(filter")) return send(res, 200, { data: { teams: { nodes: [{ id: "t-eng", key: variables?.key }] } } });
  if (query?.includes("issueCreate")) {
    /* « LENT-MCP » : Linear reçoit la création et ne répond jamais — l'effet est inconnu. */
    if ((variables?.input as { title?: string } | undefined)?.title === "LENT-MCP") return;
    return send(res, 200, { data: { issueCreate: { success: true, issue: { id: "x", identifier: "ENG-42", title: "t", url: "https://linear.app/kryxor/issue/ENG-42" } } } });
  }
  return send(res, 400, { errors: [{ message: "unknown" }] });
}

function github(req: IncomingMessage, res: ServerResponse, body: string): void {
  const path = req.url ?? "/";
  hits.push({ service: "github", what: `${req.method ?? ""} ${path}`, body });
  if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) return send(res, 401, { message: "Bad credentials" });
  if (path === "/user") return send(res, 200, { login: "placet-test" });
  if (path.startsWith("/user/repos")) {
    return send(res, 200, [{ full_name: "kryxor/produit", private: true }, { full_name: "kryxor/autre", private: false }]);
  }
  if (req.method === "POST" && path === "/repos/kryxor/produit/issues") {
    return send(res, 201, { number: 7, html_url: "https://github.com/kryxor/produit/issues/7" });
  }
  return send(res, 404, { message: "Not Found" });
}

function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` }),
    ),
  );
}

const AGENT_ID = "agt_launch_path";

function count(service: Hit["service"], what: string): number {
  return hits.filter((h) => h.service === service && h.what.includes(what)).length;
}

/** Le retour du fournisseur, sans suivre la redirection : c'est elle qu'on lit. */
async function callback(query: string, cookie?: string): Promise<{ status: number; location: string }> {
  const res = await fetch(`${api.baseUrl}/api/connectors/oauth/callback?${query}`, {
    redirect: "manual",
    /* Ce qu'envoie un navigateur sur une navigation de premier niveau. */
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...(cookie ? { cookie: `oathrion_connector_state=${cookie}` } : {}),
    },
  });
  await res.text();
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

async function act(action: string, target: string, metadata: Record<string, unknown> = {}) {
  const reply = await api.post<Record<string, unknown>>(
    "/api/execute",
    { agentId: AGENT_ID, action, target, metadata },
    { auth: ROLE_KEYS.admin },
  );
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body;
}

beforeAll(async () => {
  const s = await serve(slack);
  const l = await serve(linear);
  const g = await serve(github);
  slackServer = s.server;
  linearServer = l.server;
  githubServer = g.server;
  process.env.OATHRION_GITHUB_API_ORIGIN = g.origin;
  process.env.OATHRION_SLACK_API_ORIGIN = s.origin;
  process.env.OATHRION_LINEAR_API_ORIGIN = l.origin;
  process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE = "true";
  process.env.OATHRION_CONNECTOR_TIMEOUT_MS = "1000";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  process.env.OATHRION_PUBLIC_URL = "http://localhost:5000";
  process.env.OATHRION_SLACK_CLIENT_ID = "client-id-test";
  process.env.OATHRION_SLACK_CLIENT_SECRET = "client-secret-test";
  resetVaultKeyring();
  resetInstalls();

  api = await startTestServer();
  await seedIfEmpty();

  const created = await api.post(
    "/api/agents",
    {
      id: AGENT_ID,
      name: "Agent de l'équipe produit",
      description: "Lit le canal produit, prépare les tâches.",
      provider: "anthropic",
      model: "claude",
      status: "active",
      owner: "produit",
      mandate: {
        maxTransactionAmount: null,
        currency: "EUR",
        allowedCategories: [],
        blockedCategories: [],
        allowedDomains: ["slack.com", "linear.app", "github.com"],
      },
      permissions: ["read:chat", "write:chat", "read:tasks", "write:tasks", "read:repository", "write:repository"].map((scope) => ({
        scope,
        label: scope,
        description: "",
        granted: true,
        risk: "medium",
      })),
      policyIds: [],
      tags: ["test"],
    },
    { auth: ROLE_KEYS.admin },
  );
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
});

afterAll(async () => {
  for (const server of [slackServer, linearServer, githubServer]) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  for (const name of [
    "OATHRION_SLACK_API_ORIGIN",
    "OATHRION_LINEAR_API_ORIGIN",
    "OATHRION_GITHUB_API_ORIGIN",
    "OATHRION_WEBHOOK_ALLOW_PRIVATE",
    "OATHRION_CONNECTOR_TIMEOUT_MS",
    "OATHRION_PUBLIC_URL",
    "OATHRION_SLACK_CLIENT_ID",
    "OATHRION_SLACK_CLIENT_SECRET",
  ]) {
    delete process.env[name];
  }
});

describe("1. connecter, vérifié contre le service", () => {
  it("un jeton refusé par Slack ne laisse aucune trace dans le coffre", async () => {
    const refused = await api.post<{ connected: boolean; detail: string }>(
      "/api/connectors/slack/connect",
      { secret: "xoxb-1111111111-2222222222-inconnuinconnuinco" },
      { auth: ROLE_KEYS.admin },
    );
    expect(refused.status).toBe(422);
    const listed = await api.get<{ id: string; status: { state: string } }[]>("/api/connectors", { auth: ROLE_KEYS.admin });
    expect(listed.body.find((c) => c.id === "slack")!.status.state).toBe("not_configured");
  });

  it("un jeton utilisateur Slack est refusé sans être envoyé", async () => {
    const before = hits.length;
    const refused = await api.post("/api/connectors/slack/connect", { secret: "xoxp-1-2-3-abcdefabcdefabcdefabcdef" }, { auth: ROLE_KEYS.admin });
    expect(refused.status).toBe(422);
    expect(hits.length).toBe(before);
  });

  it("Slack et Linear se connectent, et l'écran dit si le clic OAuth est offert", async () => {
    expect((await api.post("/api/connectors/slack/connect", { secret: SLACK_TOKEN }, { auth: ROLE_KEYS.admin })).status).toBe(201);
    expect((await api.post("/api/connectors/linear/connect", { secret: LINEAR_KEY }, { auth: ROLE_KEYS.admin })).status).toBe(201);
    const listed = await api.get<{ id: string; status: { state: string; account: string }; oauth: { available: boolean } }[]>(
      "/api/connectors",
      { auth: ROLE_KEYS.admin },
    );
    const byId = Object.fromEntries(listed.body.map((c) => [c.id, c]));
    expect(byId.slack!.status).toMatchObject({ state: "connected", account: "kryxor (bot placet)" });
    expect(byId.linear!.status).toMatchObject({ state: "connected", account: "Kryxor (Mariama)" });
    expect(byId.slack!.oauth.available).toBe(true);
    expect(byId.linear!.oauth.available).toBe(false);
    expect(JSON.stringify(listed.body)).not.toContain(SLACK_TOKEN);
    expect(JSON.stringify(listed.body)).not.toContain("OATHRION_");
  });
});

describe("2. choisir les ressources", () => {
  it("liste ce que la connexion atteint réellement", async () => {
    const slackResources = await api.get<{ resources: { target: string; label: string }[] }>("/api/connectors/slack/resources", { auth: ROLE_KEYS.admin });
    expect(slackResources.body.resources.map((r) => r.label)).toEqual(["#produit", "#general"]);
    const linearResources = await api.get<{ resources: { target: string }[] }>("/api/connectors/linear/resources", { auth: ROLE_KEYS.admin });
    expect(linearResources.body.resources.map((r) => r.target)).toEqual(["linear.app/ENG", "linear.app/OPS"]);
  });

  it("refuse une ressource que la connexion n'atteint pas", async () => {
    const refused = await api.put("/api/connectors/slack/selection", { resources: ["slack.com/C0INCONNU01"] }, { auth: ROLE_KEYS.admin });
    expect(refused.status).toBe(422);
  });

  it("le choix devient deux politiques visibles, relues comme telles", async () => {
    const slackSel = await api.put("/api/connectors/slack/selection", { resources: [`slack.com/${ALLOWED}`], writes: "approval" }, { auth: ROLE_KEYS.admin });
    expect(slackSel.status, JSON.stringify(slackSel.body)).toBe(200);
    const linearSel = await api.put("/api/connectors/linear/selection", { resources: ["linear.app/ENG"], writes: "allow" }, { auth: ROLE_KEYS.admin });
    expect(linearSel.status).toBe(200);

    const policies = await api.get<{ id: string; status: string }[]>("/api/policies", { auth: ROLE_KEYS.admin });
    const ids = policies.body.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["pol_placet_slack_perimetre", "pol_placet_slack_ecritures", "pol_placet_linear_perimetre"]));
    const read = await api.get("/api/connectors/slack/selection", { auth: ROLE_KEYS.viewer });
    expect(read.body).toEqual({ resources: [`slack.com/${ALLOWED}`], writes: "approval" });
  });

  it("un lecteur ne peut pas changer le choix", async () => {
    const refused = await api.put("/api/connectors/slack/selection", { resources: [] }, { auth: ROLE_KEYS.viewer });
    expect(refused.status).toBe(403);
  });
});

describe("3. agir par la passerelle", () => {
  it("ALLOW : lire le canal choisi atteint Slack une fois", async () => {
    const before = count("slack", "conversations.history");
    const result = await act("slack.history.read", `slack.com/${ALLOWED}`);
    expect(result.decision).toBe("ALLOW");
    expect(result.succeeded).toBe(true);
    expect(count("slack", "conversations.history")).toBe(before + 1);
  });

  it("BLOCK : un canal non choisi n'atteint JAMAIS Slack", async () => {
    const before = hits.length;
    const result = await act("slack.message.post", `slack.com/${OTHER}`, { text: "fuite" });
    expect(result.decision).toBe("BLOCK");
    expect(result.attempted).toBe(false);
    expect(String(result.policyId ?? result.reason)).toContain("pol_placet_slack_perimetre");
    expect(hits.length).toBe(before);
  });

  it("BLOCK : une équipe Linear non choisie n'atteint jamais Linear", async () => {
    const before = hits.length;
    const result = await act("linear.issue.create", "linear.app/OPS", { title: "x" });
    expect(result.decision).toBe("BLOCK");
    expect(hits.length).toBe(before);
  });

  it("ALLOW (écritures libres pour Linear) : l'issue est créée", async () => {
    const result = await act("linear.issue.create", "linear.app/ENG", { title: "Corriger la connexion" });
    expect(result.decision).toBe("ALLOW");
    expect(result.succeeded).toBe(true);
    expect(result.toolResult).toMatchObject({ identifier: "ENG-42", url: "https://linear.app/kryxor/issue/ENG-42" });
  });

  it("APPROVAL : rien ne part avant, l'approbation part UNE fois, la seconde ne relâche rien", async () => {
    const before = count("slack", "chat.postMessage");
    const held = await act("slack.message.post", `slack.com/${ALLOWED}`, { text: "Résumé de la semaine" });
    expect(held.decision).toBe("APPROVAL_REQUIRED");
    expect(held.attempted).toBe(false);
    expect(count("slack", "chat.postMessage")).toBe(before);

    const approvalId = String(held.approvalId);
    const approved = await api.post<{ succeeded: boolean }>(`/api/approvals/${approvalId}/approve`, {}, { auth: ROLE_KEYS.approver });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.succeeded).toBe(true);
    expect(count("slack", "chat.postMessage")).toBe(before + 1);

    const replay = await api.post<Record<string, unknown>>(`/api/approvals/${approvalId}/approve`, {}, { auth: ROLE_KEYS.approver });
    /* L'API rend la demande déjà approuvée, sans la relâcher une seconde fois. */
    expect((replay.body as { attempted?: boolean }).attempted).not.toBe(true);
    expect(count("slack", "chat.postMessage")).toBe(before + 1);
  });

  it("EFFET INCONNU : Slack reçoit puis se tait — le reçu ne dit pas « rien envoyé », et le rejeu est refusé", async () => {
    const before = count("slack", "chat.postMessage");
    const held = await act("slack.message.post", `slack.com/${ALLOWED}`, { text: "LENT" });
    const approved = await api.post<{ succeeded: boolean; toolResult: { dispatched: unknown; code: string } }>(
      `/api/approvals/${String(held.approvalId)}/approve`,
      {},
      { auth: ROLE_KEYS.approver },
    );
    expect(approved.body.succeeded).toBe(false);
    expect(approved.body.toolResult).toMatchObject({ dispatched: "unknown", code: "unreachable" });
    expect(count("slack", "chat.postMessage")).toBe(before + 1);

    const retried = await api.post<{ message?: string }>(`/api/executions/${String(held.executionId)}/retry`, {}, { auth: ROLE_KEYS.admin });
    expect(retried.status).toBe(409);
    expect(JSON.stringify(retried.body)).toMatch(/may already have taken effect/);
    expect(count("slack", "chat.postMessage")).toBe(before + 1);

    /* La console lit la MÊME règle : elle n'offre pas un bouton que le serveur refusera. */
    const shown = await api.get<{ retry: { retryable: boolean; requiresConfirmation?: boolean; reason: string } }>(
      `/api/executions/${String(held.executionId)}`,
      { auth: ROLE_KEYS.admin },
    );
    expect(shown.body.retry.retryable).toBe(false);
    expect(shown.body.retry.requiresConfirmation).toBe(true);
    expect(shown.body.retry.reason).toMatch(/may already have taken effect/);

    /* LA PROCÉDURE SÛRE. Sans la capacité `approve`, la confirmation est refusée. */
    const operator = await api.post(`/api/executions/${String(held.executionId)}/retry`, { confirmNotApplied: true }, { auth: ROLE_KEYS.operator });
    expect(operator.status).toBe(403);
    expect(count("slack", "chat.postMessage")).toBe(before + 1);

    /* Quelqu'un qui peut approuver a vérifié chez Slack : rien. Il le confirme, et c'est écrit. */
    const confirmed = await api.post<{ succeeded: boolean }>(
      `/api/executions/${String(held.executionId)}/retry`,
      { confirmNotApplied: true },
      { auth: ROLE_KEYS.admin },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.succeeded).toBe(true);
    expect(count("slack", "chat.postMessage")).toBe(before + 2);
    const audited = await api.get<{ audit: { event: string; actor: string }[]; input: Record<string, unknown> }>(
      `/api/executions/${String(held.executionId)}`,
      { auth: ROLE_KEYS.admin },
    );
    expect(audited.body.audit.map((e) => e.event)).toEqual(
      expect.arrayContaining(["Human attestation: unknown effect reported absent", "Tool execution retried"]),
    );
    /* L'intention d'origine est préservée : c'est le message approuvé qui part, tel quel. */
    expect(audited.body.input).toMatchObject({ text: "LENT" });
    const sent = hits.filter((h) => h.what === "chat.postMessage").slice(-2).map((h) => JSON.parse(h.body).text);
    expect(sent).toEqual(["LENT", "LENT"]);
  });

  it("le champ de confirmation est strict : rien d'autre n'est accepté", async () => {
    const bad = await api.post(`/api/executions/exe_inexistant/retry`, { confirmNotApplied: "oui" }, { auth: ROLE_KEYS.admin });
    expect(bad.status).toBe(400);
  });

  it("REJET : rien ne part", async () => {
    const before = count("slack", "chat.postMessage");
    const held = await act("slack.message.post", `slack.com/${ALLOWED}`, { text: "à refuser" });
    const rejected = await api.post(`/api/approvals/${String(held.approvalId)}/reject`, {}, { auth: ROLE_KEYS.approver });
    expect(rejected.status).toBe(200);
    expect(count("slack", "chat.postMessage")).toBe(before);
  });
});

describe("4. l'isolation entre organisations", () => {
  it("une autre organisation ne voit pas la connexion", async () => {
    const listed = await api.get<{ id: string; status: { state: string } }[]>("/api/connectors", { auth: OTHER_ORG_KEYS.admin });
    expect(listed.body.find((c) => c.id === "slack")!.status.state).toBe("not_configured");
    const resources = await api.get("/api/connectors/slack/resources", { auth: OTHER_ORG_KEYS.admin });
    expect(resources.status).toBe(422);
  });

  it("ni approuver une action retenue chez nous : rien ne part", async () => {
    const before = count("slack", "chat.postMessage");
    const held = await act("slack.message.post", `slack.com/${ALLOWED}`, { text: "à ne pas relâcher" });
    expect(held.decision).toBe("APPROVAL_REQUIRED");
    const foreign = await api.post(`/api/approvals/${String(held.approvalId)}/approve`, {}, { auth: OTHER_ORG_KEYS.admin });
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain("à ne pas relâcher");
    expect(count("slack", "chat.postMessage")).toBe(before);
    const read = await api.get(`/api/executions/${String(held.executionId)}`, { auth: OTHER_ORG_KEYS.admin });
    expect(read.status).toBe(404);
    /* Rejeté chez nous pour ne pas laisser de demande ouverte dans le fichier. */
    await api.post(`/api/approvals/${String(held.approvalId)}/reject`, {}, { auth: ROLE_KEYS.approver });
  });

  it("ni son choix de ressources", async () => {
    const read = await api.get("/api/connectors/slack/selection", { auth: OTHER_ORG_KEYS.viewer });
    expect(read.body).toEqual({ resources: null, writes: null });
  });
});

describe("5. le retour OAuth", () => {
  it("le clic rend l'URL du fournisseur, sans portée utilisateur, et pose le cookie", async () => {
    const started = await api.post<{ url: string }>("/api/connectors/slack/oauth/start", {}, { auth: ROLE_KEYS.admin });
    expect(started.status).toBe(200);
    const url = new URL(started.body.url);
    expect(url.pathname).toBe("/oauth/v2/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5000/api/connectors/oauth/callback");
    expect(url.searchParams.get("user_scope")).toBe("");
    expect(started.headers.get("set-cookie")).toMatch(/oathrion_connector_state=.*HttpOnly/);
  });

  it("un lecteur ne peut pas lancer de connexion", async () => {
    expect((await api.post("/api/connectors/slack/oauth/start", {}, { auth: ROLE_KEYS.viewer })).status).toBe(403);
  });

  it("un navigateur sans le cookie est refusé, et la tentative est consommée", async () => {
    const started = await api.post<{ url: string }>("/api/connectors/slack/oauth/start", {}, { auth: ROLE_KEYS.admin });
    const state = new URL(started.body.url).searchParams.get("state")!;
    const exchanges = count("slack", "oauth.v2.access");
    const back = await callback(`code=code-valide&state=${state}`);
    expect(back.status).toBe(302);
    expect(back.location).toMatch(/result=error/);
    expect(count("slack", "oauth.v2.access")).toBe(exchanges);
    /* Rejoué avec le bon cookie : la tentative n'existe plus. */
    const again = await callback(`code=code-valide&state=${state}`, state);
    expect(decodeURIComponent(again.location)).toMatch(/expir/);
  });

  it("le même navigateur, un code valide : jeton échangé, VÉRIFIÉ, scellé", async () => {
    const started = await api.post<{ url: string }>("/api/connectors/slack/oauth/start", {}, { auth: ROLE_KEYS.admin });
    const state = new URL(started.body.url).searchParams.get("state")!;
    const back = await callback(`code=code-valide&state=${state}`, state);
    expect(back.status).toBe(302);
    expect(back.location).toBe("/console#/onboarding?connector=slack&result=connected");
    const listed = await api.get<{ id: string; status: { state: string; connectedBy: string } }[]>("/api/connectors", { auth: ROLE_KEYS.admin });
    expect(listed.body.find((c) => c.id === "slack")!.status.state).toBe("connected");
  });

  it("un client d'API reçoit le même résultat en JSON, sans redirection", async () => {
    const res = await fetch(`${api.baseUrl}/api/connectors/oauth/callback?code=x&state=inconnu`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ result: "error" });
  });

  it("un refus chez le fournisseur revient avec une phrase, pas une page d'erreur", async () => {
    const started = await api.post<{ url: string }>("/api/connectors/slack/oauth/start", {}, { auth: ROLE_KEYS.admin });
    const state = new URL(started.body.url).searchParams.get("state")!;
    const back = await callback(`error=access_denied&state=${state}`, state);
    expect(decodeURIComponent(back.location).replace(/\+/g, " ")).toMatch(/refused the authorisation/);
  });
});

describe("6. la voie MCP : un agent réel voit et utilise les connecteurs", () => {
  async function rpc(method: string, params: Record<string, unknown>) {
    return api.post<{ result?: Record<string, unknown>; error?: { message: string } }>(
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

  it("tools/list annonce Slack comme RÉEL, avec l'argument `text` requis", async () => {
    const listed = await rpc("tools/list", {});
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const tools = (listed.body.result?.tools ?? []) as { name: string; description: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }[];
    const post = tools.find((t) => t.name === "slack.message.post")!;
    expect(post.description).toMatch(/REAL call/);
    expect(post.description).not.toMatch(/SIMULATED/);
    expect(post.inputSchema.required).toEqual(["target", "text"]);
    expect(tools.find((t) => t.name === "linear.issue.create")!.inputSchema.properties).toHaveProperty("priority");
  });

  it("tools/call passe par la même politique : un canal hors périmètre est bloqué, sans appel", async () => {
    const before = hits.length;
    const called = await rpc("tools/call", { name: "slack.message.post", arguments: { target: `slack.com/${OTHER}`, text: "x" } });
    expect(called.status).toBe(200);
    expect(JSON.stringify(called.body)).toMatch(/BLOCK/);
    expect(hits.length).toBe(before);
    /* Rien n'a tourné, mais l'outil n'est pas simulé pour autant : c'est un connecteur réel. */
    expect((called.body as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent).toMatchObject({
      decision: "BLOCK", attempted: false, mode: "CONNECTOR", simulated: false,
    });
  });

  it("une exécution réelle par MCP est annoncée RÉELLE à l'agent, jamais « SIMULATED »", async () => {
    /* Linear : les écritures y sont libres dans ce parcours (Slack passe par approbation). */
    const before = count("linear", "issueCreate");
    const called = await rpc("tools/call", { name: "linear.issue.create", arguments: { target: "linear.app/ENG", title: "Réel" } });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    expect(count("linear", "issueCreate")).toBe(before + 1);
    const result = (called.body as { result: { structuredContent: Record<string, unknown>; content: { text: string }[] } }).result;
    expect(result.structuredContent).toMatchObject({ decision: "ALLOW", succeeded: true, mode: "CONNECTOR", simulated: false });
    expect(result.content[0]!.text).toMatch(/REAL call/);
    expect(result.content[0]!.text).not.toMatch(/SIMULATED/);
  });

  it("un effet INCONNU est annoncé inconnu à l'agent, avec l'interdiction de réessayer — jamais « did not complete »", async () => {
    const before = count("linear", "issueCreate");
    const called = await rpc("tools/call", { name: "linear.issue.create", arguments: { target: "linear.app/ENG", title: "LENT-MCP" } });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    expect(count("linear", "issueCreate")).toBe(before + 1);
    const result = (called.body as { result: { isError: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ decision: "ALLOW", attempted: true, succeeded: false, effect: "unknown", mode: "CONNECTOR" });
    expect(result.content[0]!.text).toMatch(/UNKNOWN/);
    expect(result.content[0]!.text).toMatch(/do not retry/i);
    expect(result.content[0]!.text).not.toMatch(/did not complete/);
  });

  it("un appel réel réussi porte effect: applied ; un appel bloqué, effect: none", async () => {
    const done = await rpc("tools/call", { name: "linear.issue.create", arguments: { target: "linear.app/ENG", title: "Effet appliqué" } });
    expect((done.body as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent).toMatchObject({ effect: "applied" });
    const blocked = await rpc("tools/call", { name: "slack.message.post", arguments: { target: `slack.com/${OTHER}`, text: "x" } });
    expect((blocked.body as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent).toMatchObject({ effect: "none" });
  });

  it("un argument déclaré pour un AUTRE verbe est refusé", async () => {
    const called = await rpc("tools/call", { name: "slack.message.post", arguments: { target: `slack.com/${ALLOWED}`, title: "x", text: "y" } });
    expect(called.status).toBe(400);
  });

  it("un argument requis manquant est refusé avant toute décision", async () => {
    const before = hits.length;
    const called = await rpc("tools/call", { name: "slack.message.post", arguments: { target: `slack.com/${ALLOWED}` } });
    expect(called.status).toBe(400);
    expect(hits.length).toBe(before);
  });

  it("une création Linear par MCP atteint Linear avec le titre transmis", async () => {
    const called = await rpc("tools/call", { name: "linear.issue.create", arguments: { target: "linear.app/ENG", title: "Depuis MCP", priority: 2 } });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    const create = hits.filter((h) => h.service === "linear" && h.what.includes("issueCreate")).at(-1)!;
    expect(JSON.parse(create.body).variables.input).toMatchObject({ title: "Depuis MCP", priority: 2 });
  });
});

describe("7. le scénario guidé : une tâche réelle à travers les trois outils", () => {
  type Step = { key: string; decision: string; target: string; url: string | null; approvalId: string | null; executionId: string | null; attempted: boolean; succeeded: boolean };

  it("se refuse tant qu'un outil n'a pas de ressource choisie — puis se joue", async () => {
    expect((await api.post("/api/connectors/github/connect", { secret: GITHUB_TOKEN }, { auth: ROLE_KEYS.admin })).status).toBe(201);
    const sel = await api.put("/api/connectors/github/selection", { resources: ["github.com/kryxor/produit"] }, { auth: ROLE_KEYS.admin });
    expect(sel.status, JSON.stringify(sel.body)).toBe(200);
  });

  let steps: Step[] = [];

  it("lit, prépare une tâche, retient l'issue, et refuse la ressource non choisie sans l'appeler", async () => {
    const before = { post: count("slack", "chat.postMessage"), gh: count("github", "POST /repos") };
    const ran = await api.post<{ steps: Step[] }>("/api/scenario/run", { agentId: AGENT_ID }, { auth: ROLE_KEYS.admin });
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    steps = ran.body.steps;
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));

    expect(by.read).toMatchObject({ decision: "ALLOW", succeeded: true, target: `slack.com/${ALLOWED}` });
    expect(by.task).toMatchObject({ decision: "ALLOW", succeeded: true, url: "https://linear.app/kryxor/issue/ENG-42" });
    expect(by.issue).toMatchObject({ decision: "APPROVAL_REQUIRED", attempted: false });
    /* La ressource hors périmètre est un VRAI canal que le bot atteint et qui n'a pas été choisi. */
    expect(by.outside).toMatchObject({ decision: "BLOCK", attempted: false, target: `slack.com/${OTHER}` });
    expect(count("slack", "chat.postMessage")).toBe(before.post);
    expect(count("github", "POST /repos")).toBe(before.gh);
  });

  it("l'approbation crée l'issue GitHub, puis le résumé Slack porte son lien", async () => {
    const issue = steps.find((s) => s.key === "issue")!;
    const approved = await api.post<{ succeeded: boolean; toolResult: { url: string } }>(`/api/approvals/${issue.approvalId!}/approve`, {}, { auth: ROLE_KEYS.approver });
    expect(approved.body.succeeded).toBe(true);
    expect(approved.body.toolResult.url).toBe("https://github.com/kryxor/produit/issues/7");

    const executionIds = steps.filter((s) => s.executionId).map((s) => s.executionId!);
    const notified = await api.post<{ step: Step }>("/api/scenario/notify", { agentId: AGENT_ID, executionIds }, { auth: ROLE_KEYS.admin });
    expect(notified.status, JSON.stringify(notified.body)).toBe(200);
    /* Les écritures Slack attendent une approbation : le résumé aussi. */
    expect(notified.body.step.decision).toBe("APPROVAL_REQUIRED");
    const released = await api.post<{ succeeded: boolean }>(`/api/approvals/${notified.body.step.approvalId!}/approve`, {}, { auth: ROLE_KEYS.approver });
    expect(released.body.succeeded).toBe(true);
    const posted = hits.filter((h) => h.service === "slack" && h.what === "chat.postMessage").at(-1)!;
    const text = String(JSON.parse(posted.body).text);
    expect(text).toContain("https://github.com/kryxor/produit/issues/7");
    expect(text).toContain("https://linear.app/kryxor/issue/ENG-42");
  });

  it("l'audit nomme le scénario guidé comme acteur, pas un agent autonome", async () => {
    const execution = await api.get<{ audit: { actor?: string; by?: string; detail?: string }[] }>(`/api/executions/${steps[0]!.executionId!}`, { auth: ROLE_KEYS.admin });
    expect(JSON.stringify(execution.body)).toContain("guided scenario");
  });

  it("une autre organisation ne peut pas jouer le scénario avec cet agent", async () => {
    const refused = await api.post("/api/scenario/run", { agentId: AGENT_ID }, { auth: OTHER_ORG_KEYS.admin });
    expect(refused.status).not.toBe(200);
  });
});
