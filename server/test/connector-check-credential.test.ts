/**
 * « FERMEZ LES AUTRES PORTES » — l'ancienne clé d'un agent est-elle vraiment morte ?
 *
 * Quand un agent existant est branché sur Oathrion, la clé qu'il détenait doit être révoquée
 * chez le fournisseur : sinon il garde une seconde route, et Oathrion ne voit rien passer.
 * `POST /api/connectors/:id/check-credential` pose la question AU SERVICE.
 *
 * Ce que ce fichier fixe :
 *   · aucun filtre de forme : un jeton Slack UTILISATEUR, refusé à la connexion, est dit
 *     VIVANT s'il fonctionne encore — c'est une porte ouverte, pas une clé « refusée » ;
 *   · seul le refus du service (clé inconnue, révoquée) vaut « morte » ; une panne vaut
 *     « inconnu », jamais « morte » ;
 *   · la clé du coffre est reconnue et le service n'est pas appelé ;
 *   · la clé n'apparaît dans aucune réponse ; un lecteur ne peut pas vérifier.
 *
 * SIMULÉ : GitHub et Slack sont des serveurs locaux qui répondent comme eux.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetVaultKeyring } from "../connectors/vault";
import { resetInstalls } from "../connectors/oauth-install";
import { StripeConnector } from "../connectors/stripe";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const OATHRION_TOKEN = "github_pat_cleDuCoffreOathrionxxxxxxxxxxxxxxxxx";
const OLD_ALIVE = "github_pat_ancienneCleEncoreActivexxxxxxxxxx";
const OLD_LIMITED = "github_pat_ancienneCleLimiteexxxxxxxxxxxxxxx";
const OLD_DEAD = "github_pat_ancienneCleRevoqueexxxxxxxxxxxxxxx";
const SLACK_USER_TOKEN = "xoxp-1111-2222-3333-jetonUtilisateurEncoreActif";
const SLACK_REVOKED = "xoxb-1111-2222-jetonDeBotRevoquexxxxxxxx";

const hits: { service: string; authorization: string }[] = [];
let github: Server;
let slack: Server;
let api: TestClient;
let githubDown = false;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function githubHandler(req: IncomingMessage, res: ServerResponse): void {
  const authorization = req.headers.authorization ?? "";
  hits.push({ service: "github", authorization });
  if (githubDown) return send(res, 503, { message: "Service Unavailable" });
  if (req.url === "/user" && (authorization === `Bearer ${OATHRION_TOKEN}` || authorization === `Bearer ${OLD_ALIVE}`)) {
    return send(res, 200, { login: "kryxor" });
  }
  if (authorization === `Bearer ${OLD_LIMITED}`) return send(res, 403, { message: "Resource not accessible by personal access token" });
  if (req.url === "/user/repos?per_page=100&sort=full_name") return send(res, 200, []);
  return send(res, 401, { message: "Bad credentials" });
}

function slackHandler(req: IncomingMessage, res: ServerResponse): void {
  const authorization = req.headers.authorization ?? "";
  hits.push({ service: "slack", authorization });
  if (authorization === `Bearer ${SLACK_USER_TOKEN}`) return send(res, 200, { ok: true, team: "kryxor", user: "awa" });
  if (authorization === `Bearer ${SLACK_REVOKED}`) return send(res, 200, { ok: false, error: "token_revoked" });
  return send(res, 200, { ok: false, error: "invalid_auth" });
}

function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => handler(req, res));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` })),
  );
}

async function check(id: string, secret: string, auth: string = ROLE_KEYS.admin) {
  return api.post<{ state?: string; detail?: string; code?: string }>(`/api/connectors/${id}/check-credential`, { secret }, { auth });
}

beforeAll(async () => {
  const g = await serve(githubHandler);
  const s = await serve(slackHandler);
  github = g.server;
  slack = s.server;
  process.env.OATHRION_GITHUB_API_ORIGIN = g.origin;
  process.env.OATHRION_SLACK_API_ORIGIN = s.origin;
  process.env.OATHRION_WEBHOOK_ALLOW_PRIVATE = "true";
  process.env.OATHRION_CONNECTOR_TIMEOUT_MS = "1000";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  resetVaultKeyring();
  resetInstalls();
  api = await startTestServer();
  const connected = await api.post("/api/connectors/github/connect", { secret: OATHRION_TOKEN }, { auth: ROLE_KEYS.admin });
  expect(connected.status, JSON.stringify(connected.body)).toBe(201);
});

afterAll(async () => {
  for (const server of [github, slack]) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  for (const name of ["OATHRION_GITHUB_API_ORIGIN", "OATHRION_SLACK_API_ORIGIN", "OATHRION_WEBHOOK_ALLOW_PRIVATE", "OATHRION_CONNECTOR_TIMEOUT_MS"]) {
    delete process.env[name];
  }
});

describe("le service dit si l'ancienne clé ouvre encore une porte", () => {
  it("une clé que GitHub accepte encore est VIVANTE", async () => {
    const reply = await check("github", OLD_ALIVE);
    expect(reply.status).toBe(200);
    expect(reply.body.state).toBe("alive");
  });

  it("une clé que GitHub reconnaît mais limite (403) est VIVANTE : elle ouvre d'autres portes", async () => {
    expect((await check("github", OLD_LIMITED)).body.state).toBe("alive");
  });

  it("une clé que GitHub refuse (401) est MORTE", async () => {
    const reply = await check("github", OLD_DEAD);
    expect(reply.body.state).toBe("dead");
  });

  it("une panne du service n'est jamais « morte » : « inconnu »", async () => {
    githubDown = true;
    try {
      expect((await check("github", OLD_DEAD)).body.state).toBe("unknown");
    } finally {
      githubDown = false;
    }
  });

  it("un jeton Slack UTILISATEUR — refusé à la connexion — est dit VIVANT s'il fonctionne encore", async () => {
    const before = hits.filter((h) => h.service === "slack").length;
    const reply = await check("slack", SLACK_USER_TOKEN);
    expect(reply.body.state).toBe("alive");
    /* La question a bien été posée à Slack : aucun filtre de forme ne l'a court-circuitée. */
    expect(hits.filter((h) => h.service === "slack").length).toBe(before + 1);
  });

  it("un jeton Slack révoqué est MORT", async () => {
    expect((await check("slack", SLACK_REVOKED)).body.state).toBe("dead");
  });
});

describe("la clé du coffre, et ce qui ne fuit pas", () => {
  it("la clé qu'Oathrion garde est reconnue, et le service n'est pas appelé", async () => {
    const before = hits.length;
    const reply = await check("github", OATHRION_TOKEN);
    expect(reply.body.state).toBe("placet");
    expect(reply.body.detail).toMatch(/Do not revoke it/);
    expect(hits.length).toBe(before);
  });

  it("aucune réponse ne contient la clé présentée", async () => {
    for (const secret of [OLD_ALIVE, OLD_DEAD, OATHRION_TOKEN]) {
      expect(JSON.stringify((await check("github", secret)).body)).not.toContain(secret);
    }
  });

  it("la vérification ne connecte rien : la clé du coffre reste celle d'Oathrion", async () => {
    await check("github", OLD_ALIVE);
    expect((await check("github", OATHRION_TOKEN)).body.state).toBe("placet");
  });

  it("un lecteur ne peut pas vérifier une clé", async () => {
    expect((await check("github", OLD_ALIVE, ROLE_KEYS.viewer)).status).toBe(403);
  });

  it("un connecteur inconnu, une clé vide : refusés", async () => {
    expect((await check("inconnu", OLD_ALIVE)).status).toBe(404);
    expect((await check("github", "")).status).toBe(400);
  });
});

describe("Stripe : une clé publiable n'est pas une porte", () => {
  it("pk_ est dite morte sans appel ; une clé réelle est, elle, posée au service", async () => {
    const stripe = new StripeConnector();
    const env = { OATHRION_STRIPE_API_ORIGIN: "http://127.0.0.1:9", OATHRION_WEBHOOK_ALLOW_PRIVATE: "true", OATHRION_CONNECTOR_TIMEOUT_MS: "300" };
    expect((await stripe.credentialAlive("pk_live_abcdefghijklmnopqrst", env)).state).toBe("dead");
    /* Port fermé : la clé réelle a bien été présentée au « service » — injoignable, donc inconnu, jamais « morte ». */
    expect((await stripe.credentialAlive("sk_live_abcdefghijklmnopqrst", env)).state).toBe("unknown");
  });
});

describe("les portes restent écrites sur la fiche de l'agent", () => {
  const AGENT = "agt_portes_essai";
  type Payload = { verdict: string; tools: { id: string }[]; doors: { connectorId: string; declared: string; check: { state: string } | null }[] };

  async function doors(auth: string = ROLE_KEYS.admin) {
    return api.get<Payload>(`/api/agents/${AGENT}/doors`, { auth });
  }
  async function declare(tool: string, declared: string, extra: Record<string, unknown> = {}, auth: string = ROLE_KEYS.admin) {
    const res = await fetch(`${api.baseUrl}/api/agents/${AGENT}/doors/${tool}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify({ declared, ...extra }),
    });
    return { status: res.status, body: (await res.json()) as Payload & { code?: string } };
  }

  beforeAll(async () => {
    const created = await api.post(
      "/api/agents",
      {
        id: AGENT,
        name: "Agent existant (portes)",
        description: "",
        provider: "custom",
        model: "agent-mcp",
        status: "active",
        owner: "essai",
        mandate: { maxTransactionAmount: null, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: ["github.com", "slack.com"] },
        permissions: ["read:repository", "write:repository", "read:chat", "write:chat"].map((scope) => ({ scope, label: scope, description: "", granted: true, risk: "medium" })),
        policyIds: [],
        tags: ["existant"],
      },
      { auth: ROLE_KEYS.admin },
    );
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  });

  it("au départ : ses outils sont lus sur l'agent enregistré, et rien n'est déclaré", async () => {
    const res = await doors();
    expect(res.status).toBe(200);
    expect(res.body.tools.map((t) => t.id).sort()).toEqual(["github", "slack"]);
    expect(res.body.verdict).toBe("incomplete");
  });

  it("une vérification par le service s'inscrit sur l'agent ; une déclaration complète le reste", async () => {
    const checked = await api.post<{ state: string; recorded: boolean }>(
      "/api/connectors/github/check-credential",
      { secret: OLD_DEAD, agentId: AGENT },
      { auth: ROLE_KEYS.admin },
    );
    expect(checked.body).toMatchObject({ state: "dead", recorded: true });
    expect((await doors()).body.verdict).toBe("incomplete");
    const done = await declare("slack", "none");
    expect(done.status).toBe(200);
    expect(done.body.verdict).toBe("locked");
    /* Relu tel quel après coup : l'état ne vit plus dans l'écran. */
    const again = await doors();
    expect(again.body.verdict).toBe("locked");
    expect(again.body.doors.find((d) => d.connectorId === "github")?.check?.state).toBe("dead");
  });

  it("une ancienne clé encore vivante rouvre la porte, et la fiche le dit", async () => {
    await api.post("/api/connectors/github/check-credential", { secret: OLD_ALIVE, agentId: AGENT }, { auth: ROLE_KEYS.admin });
    expect((await doors()).body.verdict).toBe("open");
    /* Une nouvelle vérification, morte cette fois, la referme. */
    await api.post("/api/connectors/github/check-credential", { secret: OLD_DEAD, agentId: AGENT }, { auth: ROLE_KEYS.admin });
    expect((await doors()).body.verdict).toBe("locked");
  });

  it("une déclaration ne peut PAS poser un résultat de vérification", async () => {
    const forged = await declare("github", "revoked", { check: { state: "dead" } });
    expect(forged.status).toBe(400);
    /* « Révoquée » seule, sans vérification : déclarée, pas incontournable. */
    await declare("github", "none");
    const revoked = await declare("github", "revoked");
    expect(revoked.body.doors.find((d) => d.connectorId === "github")?.check).toBeNull();
    expect(revoked.body.verdict).toBe("declared");
  });

  it("la clé du coffre présentée par erreur ne s'inscrit pas comme une vérification", async () => {
    const res = await api.post<{ state: string; recorded?: boolean }>(
      "/api/connectors/github/check-credential",
      { secret: OATHRION_TOKEN, agentId: AGENT },
      { auth: ROLE_KEYS.admin },
    );
    expect(res.body.state).toBe("placet");
    expect(res.body.recorded).toBeUndefined();
    expect((await doors()).body.verdict).toBe("declared");
  });

  it("un outil que l'agent n'utilise pas, un agent inconnu : refusés", async () => {
    expect((await declare("stripe", "none")).status).toBe(422);
    expect(
      (await api.post("/api/connectors/linear/check-credential", { secret: "lin_api_x", agentId: AGENT }, { auth: ROLE_KEYS.admin })).status,
    ).toBe(422);
    expect((await api.post("/api/connectors/github/check-credential", { secret: OLD_DEAD, agentId: "agt_inconnu" }, { auth: ROLE_KEYS.admin })).status).toBe(404);
  });

  it("une autre organisation ne lit ni n'écrit ces portes ; un lecteur ne déclare rien", async () => {
    expect((await doors(OTHER_ORG_KEYS.admin)).status).toBe(404);
    expect((await declare("github", "none", {}, OTHER_ORG_KEYS.admin)).status).toBe(404);
    expect((await declare("github", "none", {}, ROLE_KEYS.viewer)).status).toBe(403);
    expect((await doors(ROLE_KEYS.viewer)).status).toBe(200);
  });
});

describe("une demande refusée ne présente aucune clé au service", () => {
  it("agent inconnu ou outil non utilisé : refusé AVANT tout appel au service", async () => {
    const before = hits.length;
    expect((await api.post("/api/connectors/github/check-credential", { secret: OLD_DEAD, agentId: "agt_inconnu" }, { auth: ROLE_KEYS.admin })).status).toBe(404);
    expect((await api.post("/api/connectors/slack/check-credential", { secret: SLACK_REVOKED, agentId: "agt_portes_essai" }, { auth: ROLE_KEYS.admin })).status).toBe(200);
    expect(hits.length).toBe(before + 1);
  });
});
