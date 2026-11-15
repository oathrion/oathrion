/**
 * LES JETONS COURTS : Google, Microsoft 365 et Salesforce.
 *
 * ## Le défaut que ce fichier ferme
 *
 * Le pare-feu injectait un en-tête STATIQUE, donc il ne savait travailler qu'avec une clé
 * de longue durée. Google Workspace, Microsoft 365 et Salesforce délivrent un jeton
 * d'accès d'une heure et un jeton de rafraîchissement : un jeton collé dans
 * l'environnement y expirait en soixante minutes, puis chaque appel recevait un 401 du
 * fournisseur — un symptôme qui ressemble à une clé fausse et qui est une clé périmée.
 *
 * C'est le manque qui fermait la plus grande part du marché, puisque ces trois
 * fournisseurs portent la messagerie, l'agenda, les documents et le CRM d'une entreprise.
 *
 * ## Ce que ce fichier emploie
 *
 * Un VRAI point d'échange : un serveur HTTP local qui parle comme un point `/token`
 * OAuth, compte ses appels, et peut refuser. Et un VRAI amont, qui enregistre l'en-tête
 * d'autorisation reçu — c'est la seule façon de prouver que **ce qui part est le jeton
 * d'accès et jamais le jeton de rafraîchissement**.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import type { ConnectorVault } from "../connectors/vault";
import { resolveDownstreamDestination } from "../gateway/tools/mcp-destination";
import { INTERCEPT_REF_KEY, InterceptTool, putPending, resetPending } from "../intercept/forward";
import {
  accessTokenFor,
  oauthAppFor,
  oauthConfigProblems,
  OAuthConfigError,
  OAuthRefreshError,
  resetOAuthTokens,
  type OAuthApp,
} from "../connectors/oauth";

const ORG = "org_oauth_test";
const DEST = "fixture-oauth";
const REFRESH = "rt_le_jeton_de_rafraichissement_du_locataire";

/* ------------------------- le point d'échange ------------------------- */

interface Exchange {
  body: string;
  contentType: string;
}
const exchanges: Exchange[] = [];
let tokenReply: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({ access_token: "at_premier", expires_in: 3600, token_type: "Bearer" }),
};
let tokenServer: Server;
let tokenUrl = "";

/* ----------------------------- l'amont ------------------------------- */

const upstreamAuth: string[] = [];
let upstream: Server;
let upstreamUrl = "";

beforeAll(async () => {
  tokenServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      exchanges.push({
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: String(req.headers["content-type"] ?? ""),
      });
      res.writeHead(tokenReply.status, { "Content-Type": "application/json" });
      res.end(tokenReply.body);
    });
  });
  await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r));
  tokenUrl = `http://127.0.0.1:${String((tokenServer.address() as AddressInfo).port)}/token`;

  upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamAuth.push(String(req.headers.authorization ?? ""));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/`;

  /*
   * La boucle locale est autorisée par la variable dédiée, et `accessTokenFor` la relit
   * pour décider d'`allowPrivate`. Deux décisions différentes sur la même adresse —
   * autorisée à la configuration, refusée à l'appel — seraient une incohérence
   * exploitable, et c'est pour ça que les deux lisent la même variable.
   */
  process.env.OATHRION_OAUTH_ALLOW_LOOPBACK = "1";
});

afterAll(async () => {
  await new Promise<void>((r) => tokenServer.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  delete process.env.OATHRION_OAUTH_ALLOW_LOOPBACK;
});

afterEach(() => {
  resetOAuthTokens();
  exchanges.length = 0;
  upstreamAuth.length = 0;
  tokenReply = {
    status: 200,
    body: JSON.stringify({ access_token: "at_premier", expires_in: 3600, token_type: "Bearer" }),
  };
});

const appOf = (): OAuthApp => ({
  tokenUrl: new URL(tokenUrl),
  clientId: "placet-client",
  clientSecret: "cs_du_deploiement",
});

describe("l'échange d'un jeton de rafraîchissement", () => {
  it("rend un jeton d'ACCÈS, et pas ce qu'on lui a donné", async () => {
    const token = await accessTokenFor({
      organizationId: ORG,
      destinationId: DEST,
      refreshToken: REFRESH,
      app: appOf(),
    });

    expect(token).toBe("at_premier");
    /* LA propriété : le jeton de rafraîchissement ne devient jamais le credential. */
    expect(token).not.toBe(REFRESH);
    expect(exchanges).toHaveLength(1);
  });

  it("parle la grammaire du protocole, pas une de notre invention", async () => {
    await accessTokenFor({ organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf() });

    const sent = new URLSearchParams(exchanges[0]!.body);
    expect(exchanges[0]!.contentType).toContain("application/x-www-form-urlencoded");
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe(REFRESH);
    expect(sent.get("client_id")).toBe("placet-client");
    expect(sent.get("client_secret")).toBe("cs_du_deploiement");
  });

  it("NE RÉÉCHANGE PAS pendant que le jeton est valide", async () => {
    for (let i = 0; i < 5; i += 1) {
      await accessTokenFor({ organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf() });
    }
    /*
     * Un échange par appel d'agent serait un aller-retour de plus sur le chemin critique
     * ET un risque chez les fournisseurs qui font tourner le jeton de rafraîchissement à
     * chaque usage : deux échanges s'invalideraient mutuellement.
     */
    expect(exchanges).toHaveLength(1);
  });

  it("réchange quand l'échéance approche, pas quand elle est passée", async () => {
    /*
     * Le fournisseur annonce 90 secondes. La marge est de 60 : à T+0 le jeton est servi,
     * à T+31 s il reste 59 secondes — moins que la marge — donc on réchange AVANT
     * l'expiration. Sans cette marge, un jeton obtenu « valide » par Oathrion pouvait être
     * refusé par le fournisseur le temps du trajet, et un 401 intermittent sur un
     * déploiement sain est l'un des symptômes les plus coûteux à diagnostiquer.
     */
    tokenReply = { status: 200, body: JSON.stringify({ access_token: "at_court", expires_in: 90 }) };
    const first = await accessTokenFor({
      organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf(),
    });
    expect(first).toBe("at_court");
    expect(exchanges).toHaveLength(1);

    tokenReply = { status: 200, body: JSON.stringify({ access_token: "at_renouvele", expires_in: 3600 }) };
    const second = await accessTokenFor({
      organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf(),
      now: Date.now() + 31_000,
    });
    expect(second).toBe("at_renouvele");
    expect(exchanges).toHaveLength(2);
  });

  it("deux appels CONCURRENTS ne déclenchent qu'un échange", async () => {
    /*
     * Certains fournisseurs — Salesforce, Microsoft avec rotation — invalident le jeton
     * de rafraîchissement à chaque usage. Deux échanges simultanés en invalideraient un
     * mutuellement, et l'agent se retrouverait sans accès sans que rien d'anormal ne soit
     * arrivé.
     */
    const [a, b, c] = await Promise.all([
      accessTokenFor({ organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf() }),
      accessTokenFor({ organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf() }),
      accessTokenFor({ organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf() }),
    ]);
    expect([a, b, c]).toEqual(["at_premier", "at_premier", "at_premier"]);
    expect(exchanges).toHaveLength(1);
  });

  it("UN JETON DE RAFRAÎCHISSEMENT CHANGÉ N'EST PAS SERVI PAR L'ANCIEN CACHE", async () => {
    await accessTokenFor({ organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf() });
    expect(exchanges).toHaveLength(1);

    tokenReply = { status: 200, body: JSON.stringify({ access_token: "at_du_nouveau", expires_in: 3600 }) };
    const after = await accessTokenFor({
      organizationId: ORG, destinationId: DEST, refreshToken: `${REFRESH}_remplace`, app: appOf(),
    });

    /*
     * La clé de cache porte l'empreinte du jeton de rafraîchissement. Sans elle, un
     * exploitant qui remplace le jeton après une RÉVOCATION verrait Oathrion continuer à
     * injecter pendant une heure un accès obtenu avec le consentement retiré.
     */
    expect(after).toBe("at_du_nouveau");
    expect(exchanges).toHaveLength(2);
  });

  it("un locataire ne sert pas le jeton d'un autre", async () => {
    await accessTokenFor({ organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf() });
    tokenReply = { status: 200, body: JSON.stringify({ access_token: "at_autre_locataire", expires_in: 3600 }) };
    const other = await accessTokenFor({
      organizationId: "org_rival_corp", destinationId: DEST, refreshToken: REFRESH, app: appOf(),
    });
    expect(other).toBe("at_autre_locataire");
    expect(exchanges).toHaveLength(2);
  });
});

describe("quand l'échange échoue, rien ne part", () => {
  const failing = async () =>
    accessTokenFor({ organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf() });

  it("un refus du point d'échange LÈVE, et le motif nomme la cause probable", async () => {
    tokenReply = { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
    await expect(failing()).rejects.toThrow(OAuthRefreshError);
    await expect(failing()).rejects.toThrow(/revoked/);
    /*
     * Lever plutôt que rendre `null` : un relais sans credential est un relais que
     * l'agent pourrait contourner — il devrait porter sa propre clé — et un 401 du
     * fournisseur ferait chercher l'erreur du mauvais côté.
     */
  });

  it("LE CORPS DE L'ERREUR N'EST PAS REPRIS DANS LE MESSAGE", async () => {
    /*
     * Un point d'échange peut renvoyer la requête en écho dans son message d'erreur —
     * donc le `client_secret`. Le message d'Oathrion ne porte que le STATUT.
     */
    tokenReply = {
      status: 401,
      body: JSON.stringify({ error: "invalid_client", sent: "client_secret=cs_du_deploiement" }),
    };
    const error = await failing().catch((e: unknown) => e);
    const text = error instanceof Error ? error.message : String(error);
    expect(text).toContain("401");
    expect(text).not.toContain("cs_du_deploiement");
    expect(text).not.toContain(REFRESH);
  });

  it("une réponse sans `access_token` est un échec, pas un succès vide", async () => {
    tokenReply = { status: 200, body: JSON.stringify({ token_type: "Bearer", expires_in: 3600 }) };
    await expect(failing()).rejects.toThrow(/access_token/);
  });

  it("une réponse qui n'est pas du JSON est un échec nommé", async () => {
    tokenReply = { status: 200, body: "<html>maintenance</html>" };
    await expect(failing()).rejects.toThrow(/JSON/);
  });

  it("un échec n'est PAS mis en cache", async () => {
    tokenReply = { status: 500, body: "{}" };
    await expect(failing()).rejects.toThrow(OAuthRefreshError);
    tokenReply = { status: 200, body: JSON.stringify({ access_token: "at_apres_panne", expires_in: 3600 }) };
    /* Une panne passagère du fournisseur ne doit pas condamner la destination. */
    await expect(failing()).resolves.toBe("at_apres_panne");
  });
});

describe("la configuration, validée au démarrage", () => {
  const envWith = (value: string): NodeJS.ProcessEnv =>
    ({
      OATHRION_OAUTH_FIXTURE_OAUTH: value,
      OATHRION_OAUTH_ALLOW_LOOPBACK: "1",
    }) as NodeJS.ProcessEnv;

  it("absente veut dire « clé statique », et ce n'est pas une erreur", () => {
    expect(oauthAppFor(DEST, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(oauthConfigProblems({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("présente et complète est acceptée", () => {
    const app = oauthAppFor(
      DEST,
      envWith(JSON.stringify({ tokenUrl, clientId: "c", clientSecret: "s" })),
    );
    expect(app?.clientId).toBe("c");
    expect(app?.tokenUrl.toString()).toBe(tokenUrl);
  });

  it("présente et FAUSSE lève, elle ne retombe pas sur l'injection statique", () => {
    /*
     * Retomber enverrait le jeton de RAFRAÎCHISSEMENT dans l'en-tête d'autorisation, où
     * le fournisseur le refuserait — un 401 pour une configuration que l'exploitant croit
     * correcte.
     */
    expect(() => oauthAppFor(DEST, envWith("pas du json"))).toThrow(OAuthConfigError);
    expect(() => oauthAppFor(DEST, envWith(JSON.stringify({ tokenUrl })))).toThrow(/clientId/);
    expect(() =>
      oauthAppFor(DEST, envWith(JSON.stringify({ tokenUrl, clientId: "c", clientSecret: "" }))),
    ).toThrow(/clientSecret/);
  });

  it("un point d'échange hors allowlist est REFUSÉ, et le motif dit quoi déclarer", () => {
    /*
     * Un point d'échange est une URL configurable vers laquelle Oathrion envoie un
     * `clientSecret` : c'est exactement la cible qu'une erreur de configuration rend
     * précieuse. Il passe donc par le même résolveur que toute sortie — allowlist et
     * règles d'adresse.
     */
    const problems = oauthConfigProblems({
      OATHRION_OAUTH_FIXTURE_OAUTH: JSON.stringify({
        tokenUrl: "https://oauth.exemple-non-declare.test/token",
        clientId: "c",
        clientSecret: "s",
      }),
    } as NodeJS.ProcessEnv);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("OATHRION_MCP_ALLOWED_DESTINATIONS");
  });

  it("un point d'échange en boucle locale est refusé SANS la variable qui l'autorise", () => {
    expect(() =>
      oauthAppFor(DEST, {
        OATHRION_OAUTH_FIXTURE_OAUTH: JSON.stringify({ tokenUrl, clientId: "c", clientSecret: "s" }),
      } as NodeJS.ProcessEnv),
    ).toThrow(OAuthConfigError);
  });

  it("une métadonnée d'instance cloud est refusée", () => {
    /* 169.254.169.254 : la cible classique d'un SSRF, et un point d'échange est une URL. */
    const problems = oauthConfigProblems({
      OATHRION_OAUTH_FIXTURE_OAUTH: JSON.stringify({
        tokenUrl: "http://169.254.169.254/latest/api/token",
        clientId: "c",
        clientSecret: "s",
      }),
      OATHRION_OAUTH_ALLOW_LOOPBACK: "1",
    } as NodeJS.ProcessEnv);
    expect(problems).toHaveLength(1);
  });

  it("`OATHRION_OAUTH_ALLOW_LOOPBACK` n'est pas lue comme une destination", () => {
    /*
     * Elle commence par `OATHRION_OAUTH_`, donc la boucle de validation la verrait comme la
     * configuration d'une destination nommée « allow-loopback ». L'exclure explicitement
     * évite un problème de démarrage inventé par la forme du nom.
     */
    expect(oauthConfigProblems({ OATHRION_OAUTH_ALLOW_LOOPBACK: "1" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("ce qui arrive CHEZ LE FOURNISSEUR", () => {
  it("l'amont reçoit le jeton d'accès, jamais le jeton de rafraîchissement", async () => {
    const token = await accessTokenFor({
      organizationId: ORG, destinationId: DEST, refreshToken: REFRESH, app: appOf(),
    });

    /*
     * Mesuré du côté de celui qui reçoit, et non déduit du code : c'est la seule façon de
     * prouver qu'un secret ne part pas.
     */
    await fetch(upstreamUrl, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });

    expect(upstreamAuth).toHaveLength(1);
    expect(upstreamAuth[0]).toBe("Bearer at_premier");
    expect(upstreamAuth[0]).not.toContain(REFRESH);
    expect(upstreamAuth[0]).not.toContain("cs_du_deploiement");
  });
});

/**
 * LE RELAIS, DE BOUT EN BOUT : le coffre tient un jeton de rafraîchissement, l'amont
 * reçoit un jeton d'accès.
 *
 * C'est le test qui compte, parce qu'il éprouve la décision la plus facile à rater : quand
 * une destination a une configuration OAuth, le secret du coffre **n'est plus ce qui
 * part**. Il devient une matière première, et ce qui part est le jeton qu'elle permet
 * d'obtenir. Un relais qui injecterait le jeton de rafraîchissement enverrait un secret de
 * longue durée à chaque appel, et le fournisseur le refuserait.
 */
describe("le relais injecte le jeton d'accès", () => {
  const ORG_ID = "org_default" as OrganizationId;

  const toolWith = (env: NodeJS.ProcessEnv) =>
    new InterceptTool(
      /* Un coffre qui ne tient qu'une chose : le jeton de RAFRAÎCHISSEMENT du locataire. */
      { open: () => Promise.resolve({ secretEnvelope: REFRESH, account: "", scopes: [] }) } as unknown as ConnectorVault,
      null,
      env,
    );

  const relay = async (env: NodeJS.ProcessEnv, ref: string) => {
    const destination = resolveDownstreamDestination({
      OATHRION_LOCAL_MCP_URL: upstreamUrl,
    } as NodeJS.ProcessEnv);
    expect(destination).not.toBeNull();

    putPending(ref, {
      destination: destination!,
      destinationId: DEST,
      request: {
        method: "POST",
        path: "/v1/messages",
        query: {},
        headers: { "content-type": "application/json" },
        body: { hello: "world" },
        rawBody: '{"hello":"world"}',
      },
      credentialHeader: "authorization",
      credentialTemplate: "Bearer {secret}",
      forwardHeaders: ["content-type"],
    });

    return toolWith(env).execute({
      organizationId: ORG_ID,
      executionId: `exe_${ref}`,
      agentId: "agt_oauth",
      agentName: "Agent OAuth",
      action: "api.request",
      target: "fixture",
      metadata: { [INTERCEPT_REF_KEY]: ref },
      currency: "EUR",
    });
  };

  afterEach(() => {
    resetPending();
  });

  it("l'amont reçoit `Bearer <jeton d'accès>`, et jamais le jeton du coffre", async () => {
    const env = {
      OATHRION_OAUTH_FIXTURE_OAUTH: JSON.stringify({ tokenUrl, clientId: "c", clientSecret: "s" }),
      OATHRION_OAUTH_ALLOW_LOOPBACK: "1",
    } as NodeJS.ProcessEnv;

    const result = await relay(env, "ref_oauth_1");

    expect(result.ok).toBe(true);
    expect(result.data.credentialInjected).toBe(true);
    expect(upstreamAuth).toEqual(["Bearer at_premier"]);
    /* Le secret du coffre n'a servi qu'à obtenir l'autre. */
    expect(upstreamAuth[0]).not.toContain(REFRESH);
    expect(exchanges).toHaveLength(1);
  });

  it("SANS configuration OAuth, le secret du coffre part tel quel", async () => {
    /*
     * Le contrôle négatif, et il porte : sans lui, le test précédent passerait aussi sur
     * un relais qui aurait cessé d'injecter quoi que ce soit du coffre.
     */
    const result = await relay({} as NodeJS.ProcessEnv, "ref_oauth_2");

    expect(result.ok).toBe(true);
    expect(upstreamAuth).toEqual([`Bearer ${REFRESH}`]);
    /* Et aucun échange n'a eu lieu : la destination n'a pas de point d'échange. */
    expect(exchanges).toHaveLength(0);
  });

  it("un échange en échec REFUSE le relais, et l'amont n'est pas touché", async () => {
    tokenReply = { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
    const env = {
      OATHRION_OAUTH_FIXTURE_OAUTH: JSON.stringify({ tokenUrl, clientId: "c", clientSecret: "s" }),
      OATHRION_OAUTH_ALLOW_LOOPBACK: "1",
    } as NodeJS.ProcessEnv;

    const result = await relay(env, "ref_oauth_3");

    expect(result.ok).toBe(false);
    /*
     * ZÉRO requête chez l'amont, mesuré du côté de celui qui l'aurait reçue. Un relais
     * qui serait parti sans credential aurait reçu un 401 du fournisseur, et l'exploitant
     * aurait cherché l'erreur du mauvais côté.
     */
    expect(upstreamAuth).toHaveLength(0);
    expect(result.data.dispatched).not.toBe(true);
    /*
     * Un motif NOMMÉ, et non une exception : laisser lever ferait rendre un 500 à l'agent,
     * et l'exploitant chercherait une panne d'Oathrion au lieu d'un jeton révoqué.
     */
    expect(result.data.reason).toBe("oauth_unavailable");
    expect(result.summary).toMatch(/revoked/);
    expect(result.data.credentialInjected).toBe(false);
  });

  it("NI LE JETON DE RAFRAÎCHISSEMENT NI LE SECRET CLIENT NE SONT DANS CE QUI EST PERSISTÉ", async () => {
    const env = {
      OATHRION_OAUTH_FIXTURE_OAUTH: JSON.stringify({ tokenUrl, clientId: "c", clientSecret: "cs_du_deploiement" }),
      OATHRION_OAUTH_ALLOW_LOOPBACK: "1",
    } as NodeJS.ProcessEnv;

    const result = await relay(env, "ref_oauth_4");

    /* `data` est écrit en base par la passerelle : c'est la surface qui compte. */
    const persisted = JSON.stringify(result.data);
    expect(persisted).not.toContain(REFRESH);
    expect(persisted).not.toContain("cs_du_deploiement");
    expect(persisted).not.toContain("at_premier");
    /* Et le résumé lisible non plus. */
    expect(result.summary).not.toContain(REFRESH);
  });
});
