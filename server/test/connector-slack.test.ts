/**
 * LE CONNECTEUR SLACK, CONTRE UN SLACK LOCAL QUI RÉPOND COMME SLACK.
 *
 * Ce fichier est un test SIMULÉ au sens du rapport de release : le serveur ci-dessous
 * imite les réponses documentées de Slack (`200 {"ok": false, "error": …}`, `429` avec
 * `Retry-After`, l'en-tête `x-oauth-scopes`). La preuve contre le vrai Slack est
 * `npm run verify:slack-connector`.
 *
 * Ce qu'il fixe :
 *   · un 200 avec `ok: false` est un ÉCHEC, jamais un succès ;
 *   · chaque erreur de Slack devient un code machine ET une phrase qui dit quoi faire ;
 *   · un jeton utilisateur, une cible sans canal ou un nom de canal ne partent jamais ;
 *   · le délai d'un fournisseur muet est borné ;
 *   · « Déconnecter » révoque réellement chez Slack, et le dit seulement si Slack l'a dit.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import {
  parseSlackTarget,
  SlackConnector,
  slackProbeCode,
  slackTokenProblem,
} from "../connectors/slack";
import type { ConnectorContext } from "../connectors/types";
import type { ConnectorVault } from "../connectors/vault";

const GOOD = "xoxb-1111111111-2222222222-bonjetonvalideplacet";
const NARROW = "xoxb-1111111111-2222222222-jetonsanslecturecanal";
const REVOKED = "xoxb-1111111111-2222222222-jetonrevoqueplacetx";
const LIMITED = "xoxb-1111111111-2222222222-jetonlimiteplacetxx";
const MUTE = "xoxb-1111111111-2222222222-fournisseurmuetxxxx";

interface Seen {
  method: string;
  authorization: string;
  body: string;
}

let server: Server;
let origin = "";
const seen: Seen[] = [];
let revoked = false;

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? "/", "http://x");
  const method = url.pathname.replace(/^\/api\//, "");
  const authorization = req.headers.authorization ?? "";
  seen.push({ method, authorization, body });
  const token = authorization.replace(/^Bearer /, "");

  if (token === MUTE) return; /* ne répond jamais */
  if (token === LIMITED) return reply(res, 429, { ok: false, error: "ratelimited" }, { "retry-after": "30" });
  if (token === REVOKED || (revoked && token === GOOD)) return reply(res, 200, { ok: false, error: "token_revoked" });
  if (token !== GOOD && token !== NARROW) return reply(res, 200, { ok: false, error: "invalid_auth" });

  const scopes = token === GOOD ? "chat:write,channels:read,channels:history" : "chat:write";
  const h = { "x-oauth-scopes": scopes };
  const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};

  switch (method) {
    case "auth.test":
      return reply(res, 200, { ok: true, team: "kryxor", user: "oathrion_test", team_id: "T0", user_id: "U0" }, h);
    case "users.conversations":
      if (token === NARROW) {
        return reply(res, 200, { ok: false, error: "missing_scope", needed: "channels:read", provided: scopes }, h);
      }
      return reply(res, 200, {
        ok: true,
        channels: [
          { id: "C0C8B7X16F8", name: "nouveau-canal", is_private: false },
          { id: "G0PRIVATE01", name: "equipe-privee", is_private: true },
        ],
        response_metadata: { next_cursor: "" },
      }, h);
    case "conversations.history": {
      const channel = url.searchParams.get("channel");
      if (channel === "C0MISSING00") return reply(res, 200, { ok: false, error: "channel_not_found" }, h);
      return reply(res, 200, {
        ok: true,
        messages: [{ ts: "1.0", user: "U1", text: "Déployer la v2 vendredi ?" }],
      }, h);
    }
    case "chat.postMessage": {
      if (json.channel === "C0NOTMEMBER") return reply(res, 200, { ok: false, error: "not_in_channel" }, h);
      return reply(res, 200, { ok: true, channel: json.channel, ts: "1700000000.000100" }, h);
    }
    case "chat.getPermalink":
      return reply(res, 200, { ok: true, permalink: "https://kryxor.slack.com/archives/C0C8B7X16F8/p1700000000000100" }, h);
    case "auth.revoke":
      revoked = true;
      return reply(res, 200, { ok: true, revoked: true }, h);
    default:
      return reply(res, 200, { ok: false, error: "unknown_method" });
  }
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
  revoked = false;
});

/** Un coffre en mémoire : ce fichier éprouve le connecteur, pas le chiffrement. */
function contextWith(secret: string | null): ConnectorContext & { forgotten: () => boolean } {
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
    env: {
      OATHRION_SLACK_API_ORIGIN: origin,
      OATHRION_WEBHOOK_ALLOW_PRIVATE: "true",
      OATHRION_CONNECTOR_TIMEOUT_MS: "1000",
    },
    forgotten: () => stored === null,
  };
}

const slack = new SlackConnector();

function request(action: string, target: string, metadata: Record<string, unknown> = {}) {
  return { action, target, metadata, executionId: "exe_slack_test_1" };
}

describe("le jeton : un bot, rien d'autre", () => {
  it("refuse un jeton utilisateur, de renouvellement ou d'application, et ne l'envoie pas", async () => {
    for (const bad of ["xoxp-1-2-3-abcdefabcdefabcdefabcdef", "xoxe.xoxp-1-abcdefabcdefabcdefabcdef", "xoxe-1-abcdefabcdefabcdef", "xapp-1-abcdefabcdefabcdefabc"]) {
      expect(slackTokenProblem(bad)).not.toBeNull();
      const probe = await slack.verify(bad, {}, contextWith(null).env);
      expect(probe.ok).toBe(false);
      expect(probe.code).toBe("unauthorized");
    }
    expect(seen).toHaveLength(0);
  });

  it("accepte un jeton de bot, y compris à rotation", () => {
    expect(slackTokenProblem(GOOD)).toBeNull();
    expect(slackTokenProblem(`xoxe.${GOOD}`)).toBeNull();
  });
});

describe("la connexion se vérifie CONTRE Slack", () => {
  it("un bon jeton nomme l'espace et le bot tels que Slack les rend, avec ses portées réelles", async () => {
    const probe = await slack.verify(GOOD, {}, contextWith(null).env);
    expect(probe).toMatchObject({ ok: true, code: "ok", account: "kryxor (bot oathrion_test)" });
    expect(probe.scopes).toEqual(["chat:write", "channels:read", "channels:history"]);
    expect(seen[0]!.authorization).toBe(`Bearer ${GOOD}`);
  });

  it("un jeton refusé : 200 + ok:false est un échec, avec une phrase utile", async () => {
    const probe = await slack.verify("xoxb-1111111111-2222222222-inconnuinconnuinco", {}, contextWith(null).env);
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe("unauthorized");
    expect(probe.detail).toMatch(/Bot User OAuth Token/);
    expect(probe.account).toBe("");
  });

  it("un jeton révoqué ou expiré dit « reconnectez »", async () => {
    const probe = await slack.verify(REVOKED, {}, contextWith(null).env);
    expect(probe.code).toBe("unauthorized");
    expect(probe.detail).toMatch(/Reconnect Slack/);
  });

  it("une limite de débit est un quota, pas une panne ni un jeton faux", async () => {
    const probe = await slack.verify(LIMITED, {}, contextWith(null).env);
    expect(probe.code).toBe("rate_limited");
    expect(probe.detail).toMatch(/try again/);
  });

  it("un fournisseur muet est coupé au délai, et classé injoignable", async () => {
    const started = Date.now();
    const probe = await slack.verify(MUTE, {}, contextWith(null).env);
    expect(probe.code).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("une permission manquante rend la capacité indisponible avec la correction à faire", async () => {
    const caps = await slack.capabilities(contextWith(NARROW));
    const byAction = Object.fromEntries(caps.map((c) => [c.action, c]));
    expect(byAction["slack.message.post"]!.available).toBe(true);
    expect(byAction["slack.channels.list"]!.available).toBe(false);
    expect(byAction["slack.channels.list"]!.reason).toMatch(/channels:read/);
  });
});

describe("les trois verbes", () => {
  it("liste les canaux où le bot est invité", async () => {
    const result = await slack.execute(contextWith(GOOD), request("slack.channels.list", "slack.com"));
    expect(result.ok).toBe(true);
    expect(result.data.channels).toEqual([
      { id: "C0C8B7X16F8", name: "nouveau-canal", private: false },
      { id: "G0PRIVATE01", name: "equipe-privee", private: true },
    ]);
  });

  it("une permission manquante sur la liste est « forbidden » avec le scope à ajouter", async () => {
    const result = await slack.execute(contextWith(NARROW), request("slack.channels.list", "slack.com"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("forbidden");
    expect(result.summary).toMatch(/channels:read/);
  });

  it("lit l'historique d'UN canal, borné", async () => {
    const result = await slack.execute(contextWith(GOOD), request("slack.history.read", "slack.com/C0C8B7X16F8", { limit: 500 }));
    expect(result.ok).toBe(true);
    expect(seen.at(-1)!.method).toBe("conversations.history");
    expect((result.data.messages as unknown[]).length).toBe(1);
  });

  it("un canal introuvable est « not_found »", async () => {
    const result = await slack.execute(contextWith(GOOD), request("slack.history.read", "slack.com/C0MISSING00"));
    expect(result.code).toBe("not_found");
  });

  it("publie, rend le lien du message, et porte l'identifiant d'exécution", async () => {
    const result = await slack.execute(
      contextWith(GOOD),
      request("slack.message.post", "slack.com/C0C8B7X16F8", { text: "Bonjour depuis Oathrion" }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.url).toMatch(/^https:\/\/kryxor\.slack\.com\/archives\//);
    const posted = seen.find((s) => s.method === "chat.postMessage")!;
    expect(JSON.parse(posted.body)).toMatchObject({
      channel: "C0C8B7X16F8",
      text: "Bonjour depuis Oathrion",
      metadata: { event_payload: { execution_id: "exe_slack_test_1" } },
    });
  });

  it("le bot absent du canal : un 200 de Slack qui est un ÉCHEC, et la phrase dit /invite", async () => {
    const result = await slack.execute(contextWith(GOOD), request("slack.message.post", "slack.com/C0NOTMEMBER", { text: "x" }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("forbidden");
    expect(result.summary).toMatch(/\/invite/);
  });
});

describe("ce qui ne part jamais", () => {
  it.each([
    ["un nom de canal", "slack.com/general"],
    ["un message direct", "slack.com/D0123456789"],
    ["un autre hôte", "evil.example/C0C8B7X16F8"],
    ["un chemin qui s'échappe", "slack.com/C0C8B7X16F8/../../api/admin"],
  ])("%s est refusé localement", async (_label, target) => {
    expect(() => parseSlackTarget(target)).toThrow();
    const result = await slack.execute(contextWith(GOOD), request("slack.message.post", target, { text: "x" }));
    expect(result.ok).toBe(false);
    expect(result.data.dispatched).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("un message vide ou sans canal ne part pas", async () => {
    const empty = await slack.execute(contextWith(GOOD), request("slack.message.post", "slack.com/C0C8B7X16F8", { text: "  " }));
    const noChannel = await slack.execute(contextWith(GOOD), request("slack.message.post", "slack.com", { text: "x" }));
    expect(empty.data.dispatched).toBe(false);
    expect(noChannel.data.dispatched).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("sans connexion, rien ne part et l'échec est nommé", async () => {
    const result = await slack.execute(contextWith(null), request("slack.message.post", "slack.com/C0C8B7X16F8", { text: "x" }));
    expect(result).toMatchObject({ ok: false, code: "unauthorized", data: { dispatched: false } });
    expect(seen).toHaveLength(0);
  });

  it("le jeton n'apparaît dans aucun résultat", async () => {
    const results = [
      await slack.verify(GOOD, {}, contextWith(null).env),
      await slack.execute(contextWith(GOOD), request("slack.message.post", "slack.com/C0NOTMEMBER", { text: "x" })),
      await slack.execute(contextWith(GOOD), request("slack.channels.list", "slack.com")),
    ];
    expect(JSON.stringify(results)).not.toContain(GOOD);
  });
});

describe("déconnecter", () => {
  it("révoque chez Slack, puis oublie — et ne dit « neutralisé » que si Slack l'a confirmé", async () => {
    const context = contextWith(GOOD);
    const revocation = await slack.revoke(context, "admin@test");
    expect(seen.some((s) => s.method === "auth.revoke")).toBe(true);
    expect(revocation).toMatchObject({ ok: true, remoteStillValid: false });
    expect(context.forgotten()).toBe(true);
  });

  it("si Slack ne confirme pas, la réponse dit que le jeton peut rester valide", async () => {
    const revocation = await slack.revoke(contextWith(REVOKED), "admin@test");
    expect(revocation.ok).toBe(true);
    expect(revocation.remoteStillValid).toBe(true);
    expect(revocation.detail).toMatch(/Revoke tokens/);
  });
});

describe("le code machine", () => {
  it("lit l'erreur de Slack, pas le statut HTTP", () => {
    expect(slackProbeCode(200, null)).toBe("ok");
    expect(slackProbeCode(200, "invalid_auth")).toBe("unauthorized");
    expect(slackProbeCode(200, "token_expired")).toBe("unauthorized");
    expect(slackProbeCode(200, "missing_scope")).toBe("forbidden");
    expect(slackProbeCode(200, "not_in_channel")).toBe("forbidden");
    expect(slackProbeCode(200, "channel_not_found")).toBe("not_found");
    expect(slackProbeCode(429, "ratelimited")).toBe("rate_limited");
    expect(slackProbeCode(503, "internal_error")).toBe("unreachable");
  });
});
