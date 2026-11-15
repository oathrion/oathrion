/**
 * LE FLOT SSO DE BOUT EN BOUT, contre un VRAI fournisseur d'identité local.
 *
 * ## Ce que ce fichier emploie
 *
 * Un fournisseur OIDC écrit ici : il sert un document de découverte, un JWKS, et un point
 * d'échange qui signe de vrais jetons d'identité avec une vraie clé RSA. Il n'importe rien
 * d'Oathrion — c'est ce qui permet de prouver qu'Oathrion parle bien le protocole, et non sa
 * propre interprétation.
 *
 * ## Les deux propriétés qui comptent le plus
 *
 *  1. **Une session SSO est une session NORMALE.** Elle apparaît dans la liste des
 *     sessions, elle se révoque, elle expire. C'était la décision de conception : le SSO
 *     remplace la VÉRIFICATION, pas ce qui vient après. Si ce test tombe, c'est qu'un
 *     second système de sessions est né.
 *
 *  2. **Le `state` lié au cookie.** Sans lui, un attaquant envoie la victime sur
 *     `/callback?code=<son code>` et la victime se retrouve connectée AU COMPTE DE
 *     L'ATTAQUANT. C'est le CSRF de connexion, et il est sous-estimé parce qu'« être
 *     connecté chez l'attaquant » a l'air inoffensif jusqu'à ce qu'on y saisisse quelque
 *     chose.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ROLE_KEYS, TEST_CONSOLE_EMAIL, startTestServer, type TestClient } from "./harness";
import { resetOidcKeys } from "../identity/oidc";
import { ssoIdentityStore } from "../repositories/sso-identities";
import { HANDOFF_TTL_MS, issueHandoff, takeHandoff } from "../identity/sso-handoff";
import { userStore } from "../repositories/users";

const CLIENT_ID = "placet-console";
const CLIENT_SECRET = "le-secret-client-du-deploiement";

let idp: Server;
let issuer = "";
let privateKey: KeyObject;
let jwk: Record<string, unknown>;
let client: TestClient;
const saved: Record<string, string | undefined> = {};

/** Ce que le faux fournisseur mettra dans le prochain jeton qu'il signe. */
let nextClaims: Record<string, unknown> = {};
/** Les échanges de code recus, pour prouver qu'aucun n'a lieu quand il ne doit pas. */
const exchanges: string[] = [];

const b64 = (value: string): string => Buffer.from(value).toString("base64url");

function signIdToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: "idp-2026" };
  const claims = {
    iss: issuer,
    sub: "idp-subject-1",
    aud: CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce,
    email: TEST_CONSOLE_EMAIL,
    email_verified: true,
    name: "Administrateur Oathrion",
    ...nextClaims,
  };
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  const signer = createSign("sha256");
  signer.update(input, "utf8");
  signer.end();
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  jwk = { ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "idp-2026", alg: "RS256", use: "sig" };

  idp = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.startsWith("/.well-known/openid-configuration")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          }),
        );
        return;
      }
      if (url.startsWith("/jwks")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (url.startsWith("/token")) {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        exchanges.push(form.get("code") ?? "");
        /*
         * Le `nonce` que le fournisseur place dans le jeton est celui qu'Oathrion a demandé
         * — porté ici par le code, parce que ce faux fournisseur n'a pas d'état. Un vrai
         * IdP le mémorise à l'autorisation.
         */
        const nonce = (form.get("code") ?? "").replace(/^code-for-/, "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "jeton-dacces-que-placet-ignore", id_token: signIdToken(nonce), token_type: "Bearer" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${String((idp.address() as AddressInfo).port)}`;

  for (const name of ["OATHRION_OIDC", "OATHRION_OIDC_ALLOW_HTTP"]) saved[name] = process.env[name];
  /*
   * `OATHRION_OIDC_ALLOW_HTTP=1` : le banc est en HTTP sur la boucle locale. En production
   * un émetteur non HTTPS refuse le démarrage — un jeton d'identité en clair se capture
   * et se rejoue.
   */
  process.env.OATHRION_OIDC_ALLOW_HTTP = "1";
  process.env.OATHRION_OIDC = JSON.stringify({
    issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: "http://127.0.0.1/api/auth/sso/callback",
  });

  client = await startTestServer();
}, 60_000);

afterAll(async () => {
  await client.close();
  await new Promise<void>((r) => idp.close(() => r()));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  nextClaims = {};
  exchanges.length = 0;
  resetOidcKeys();
});

/**
 * CHAQUE TEST PART D'UN COMPTE NON LIÉ.
 *
 * Les tests de ce fichier partagent une base, et la liaison `(issuer, sub)` est
 * PERSISTANTE — c'est tout son objet. Sans cette remise à zéro, le premier test à se
 * connecter lie le compte de console, et tous les suivants qui emploient un autre `sub`
 * avec la même adresse tombent sur un conflit d'identité. Le code aurait raison ; c'est
 * l'ordre des tests qui déciderait du résultat.
 *
 * Le nettoyage n'est pas un artifice de test : il emploie `unbindUser`, la sortie de
 * secours administrative que le refus de conflit rend indispensable. Un fournisseur qui
 * réémet un `sub` pour la même personne verrouillerait sinon le compte, et la seule
 * issue serait un `DELETE` à la main en production.
 */
beforeEach(() => {
  const compte = userStore.findByEmail(TEST_CONSOLE_EMAIL);
  if (compte) ssoIdentityStore.unbindUser(issuer, compte.id);
});

/** Le navigateur : demande une connexion, et garde le cookie et le `state`. */
async function beginLogin(): Promise<{ state: string; nonce: string; cookie: string }> {
  const res = await fetch(`${client.baseUrl}/api/auth/sso/start?format=json`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url: string };
  const url = new URL(body.url);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("oathrion_sso_state="));
  expect(cookie).toBeDefined();
  return {
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    cookie: (cookie ?? "").split(";")[0] ?? "",
  };
}

/** Le retour du fournisseur. `cookie` omis = un navigateur qui n'a rien demandé. */
async function finishLogin(params: {
  state: string;
  nonce: string;
  cookie?: string;
  code?: string;
  error?: string;
}) {
  const query = new URLSearchParams();
  if (params.error) query.set("error", params.error);
  else query.set("code", params.code ?? `code-for-${params.nonce}`);
  query.set("state", params.state);

  const headers: Record<string, string> = {};
  if (params.cookie !== undefined) headers.cookie = params.cookie;

  /*
   * `format=json` : le rappel rend alors le TICKET au lieu de rediriger. C'est le même
   * code que pour un navigateur — seul l'exécutant de la redirection change — et cela
   * évite d'avoir à suivre un 302 vers une page que le serveur de test ne sert pas.
   */
  query.set("format", "json");
  const res = await fetch(`${client.baseUrl}/api/auth/sso/callback?${query.toString()}`, { headers });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }

  /*
   * LE PARCOURS COMPLET, parce que c'est lui qu'il faut éprouver.
   *
   * Le rappel ne rend plus de jeton : il rend un ticket à usage unique, que la console
   * échange par un POST. Cet assistant fait les DEUX étapes et expose le résultat final,
   * pour que les tests écrits avant le ticket continuent d'affirmer la même chose — une
   * session utilisable au bout du parcours — plutôt que d'affirmer la forme d'une
   * réponse intermédiaire.
   *
   * Le ticket lui-même a ses propres tests, plus bas.
   */
  if (res.status === 200 && typeof body.handoff === "string") {
    const claimed = await fetch(`${client.baseUrl}/api/auth/sso/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff: body.handoff }),
    });
    const session = (await claimed.json()) as Record<string, unknown>;
    return {
      status: claimed.status,
      body: { ...session, handoff: body.handoff },
      headers: claimed.headers,
      /* Les en-têtes du RAPPEL restent lisibles : c'est lui qui porte le no-store. */
      callbackHeaders: res.headers,
      callbackStatus: res.status,
    };
  }
  return {
    status: res.status,
    body,
    headers: res.headers,
    callbackHeaders: res.headers,
    callbackStatus: res.status,
  };
}

describe("le parcours complet", () => {
  it("ouvre une session utilisable", async () => {
    const begin = await beginLogin();
    const done = await finishLogin(begin);

    expect(done.status).toBe(200);
    const token = String(done.body.token ?? "");
    expect(token).not.toBe("");

    /* ET LA SESSION MARCHE RÉELLEMENT : c'est la seule preuve qui compte. */
    const agents = await client.get("/api/agents", { auth: token });
    expect(agents.status).toBe(200);
  });

  it("l'URL d'autorisation porte ce que le protocole demande", async () => {
    const res = await fetch(`${client.baseUrl}/api/auth/sso/start?format=json`);
    const body = (await res.json()) as { url: string };
    const url = new URL(body.url);

    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("scope")).toContain("email");
    /* `state` ET `nonce`, distincts : deux rôles, deux valeurs. */
    const state = url.searchParams.get("state") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    expect(state).not.toBe("");
    expect(nonce).not.toBe("");
    expect(state).not.toBe(nonce);
  });

  it("LE COOKIE D'ÉTAT EST `HttpOnly`", async () => {
    /*
     * Sans `HttpOnly`, un script dans la page lit le `state` — et le `state` est ce qui
     * prouve que le retour appartient à ce navigateur.
     */
    const res = await fetch(`${client.baseUrl}/api/auth/sso/start?format=json`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("oathrion_sso_state=")) ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/auth/sso");
  });

  it("UNE SESSION SSO EST UNE SESSION NORMALE — elle se liste et se révoque", async () => {
    /*
     * LA propriété de conception de ce chantier. Le SSO remplace la vérification, jamais
     * ce qui vient après : si ce test tombe, un second système de sessions est né, avec sa
     * propre révocation à maintenir et son propre trou à découvrir.
     */
    const begin = await beginLogin();
    const done = await finishLogin(begin);
    const token = String(done.body.token ?? "");

    const sessions = await client.get<{ sessions: { id: string }[] }>("/api/auth/sessions", { auth: token });
    expect(sessions.status).toBe(200);
    const mine = sessions.body.sessions[0];
    expect(mine).toBeDefined();

    const revoked = await client.del(`/api/auth/sessions/${mine!.id}`, { auth: token });
    expect(revoked.status).toBeLessThan(300);

    /* Et le jeton ne vaut plus rien. */
    const after = await client.get("/api/agents", { auth: token });
    expect(after.status).toBe(401);
  });
});

describe("LE CSRF DE CONNEXION, fermé par le couple état + cookie", () => {
  it("sans cookie, le retour est refusé", async () => {
    /*
     * L'attaque : l'attaquant déclenche `/start` chez lui, obtient un `state` et un code
     * pour SON compte, puis envoie à la victime le lien de retour. Si Oathrion acceptait, la
     * victime serait connectée au compte de l'attaquant — et tout ce qu'elle y ferait,
     * l'attaquant le verrait.
     */
    const begin = await beginLogin();
    const done = await finishLogin({ ...begin, cookie: undefined });

    expect(done.status).toBe(400);
    expect(done.body.error).toBe("sso_refused");
    /* ET AUCUN ÉCHANGE N'A EU LIEU : les contrôles passent avant tout appel réseau. */
    expect(exchanges).toHaveLength(0);
  });

  it("avec le cookie d'une AUTRE tentative, refusé", async () => {
    const first = await beginLogin();
    const second = await beginLogin();
    const done = await finishLogin({ ...second, cookie: first.cookie });

    expect(done.status).toBe(400);
    expect(exchanges).toHaveLength(0);
  });

  it("un `state` inventé est refusé", async () => {
    const begin = await beginLogin();
    const done = await finishLogin({ ...begin, state: "un-etat-que-placet-na-pas-emis" });
    expect(done.status).toBe(400);
    expect(exchanges).toHaveLength(0);
  });

  it("UN `state` DÉJÀ UTILISÉ NE SERT PAS DEUX FOIS", async () => {
    /*
     * À usage unique. Sans ça, un retour capturé — journal de serveur mandataire,
     * historique d'un navigateur partagé — serait rejouable tant que le jeton du
     * fournisseur reste valide.
     */
    const begin = await beginLogin();
    const first = await finishLogin(begin);
    expect(first.status).toBe(200);

    const again = await finishLogin(begin);
    expect(again.status).toBe(400);
  });

  it("une erreur du fournisseur est refusée proprement, sans échange", async () => {
    const begin = await beginLogin();
    const done = await finishLogin({ ...begin, error: "access_denied" });
    expect(done.status).toBe(400);
    expect(exchanges).toHaveLength(0);
  });

  it("un retour sans code est refusé", async () => {
    const begin = await beginLogin();
    const query = new URLSearchParams({ state: begin.state });
    const res = await fetch(`${client.baseUrl}/api/auth/sso/callback?${query.toString()}`, {
      headers: { cookie: begin.cookie },
    });
    expect(res.status).toBe(400);
    expect(exchanges).toHaveLength(0);
  });
});

describe("l'identité portée par le jeton", () => {
  it("une adresse SANS utilisateur de console est refusée", async () => {
    /*
     * Le refus par défaut. Sans lui, tout l'annuaire du client aurait un accès à la
     * console de gouvernance dès que le SSO est branché.
     */
    /*
     * UN AUTRE `sub`, et c'est le point du test — pas un détail de montage.
     *
     * L'identité d'une personne est désormais `(issuer, sub)`, plus son adresse. « Une
     * autre personne » doit donc porter un autre `sub` : réemployer `idp-subject-1`
     * avec une adresse différente ne décrit pas un inconnu, cela décrit la personne
     * déjà liée dont l'adresse a changé — un cas légitime, qui est accepté, et qui a
     * son propre test plus bas.
     *
     * Le test affirmait déjà la bonne chose ; c'est son montage qui s'appuyait sur une
     * identité fondée sur l'adresse.
     */
    nextClaims = { email: "quelquun.dautre@acme.example.com", sub: "idp-subject-inconnu" };
    const begin = await beginLogin();
    const done = await finishLogin(begin);

    expect(done.status).toBe(403);
    expect(done.body.error).toBe("sso_refused");
    /* ET LE MESSAGE NE DIT PAS que ce compte n'existe pas : ce serait un oracle. */
    expect(JSON.stringify(done.body)).not.toContain("quelquun.dautre");
  });

  it("un jeton d'une AUTRE audience est refusé", async () => {
    nextClaims = { aud: "une-autre-application" };
    const begin = await beginLogin();
    expect((await finishLogin(begin)).status).toBe(400);
  });

  it("un jeton d'un AUTRE émetteur est refusé", async () => {
    nextClaims = { iss: "https://idp-de-lattaquant.example" };
    const begin = await beginLogin();
    expect((await finishLogin(begin)).status).toBe(400);
  });

  it("un `nonce` qui ne répond pas à cette tentative est refusé", async () => {
    const begin = await beginLogin();
    /* Le code porte le nonce chez ce faux IdP : en changer un fabrique un jeton pour une autre tentative. */
    const done = await finishLogin({ ...begin, code: "code-for-un-autre-nonce" });
    expect(done.status).toBe(400);
  });

  it("une adresse non vérifiée est refusée", async () => {
    nextClaims = { email_verified: false };
    const begin = await beginLogin();
    expect((await finishLogin(begin)).status).toBe(400);
  });

  it("un jeton expiré est refusé", async () => {
    nextClaims = { exp: Math.floor(Date.now() / 1000) - 3600 };
    const begin = await beginLogin();
    expect((await finishLogin(begin)).status).toBe(400);
  });
});

describe("ce qu'Oathrion NE GARDE PAS du fournisseur", () => {
  it("le jeton d'accès du fournisseur n'est jamais rendu ni stocké", async () => {
    /*
     * Oathrion n'appelle aucune API au nom de l'utilisateur : il lui faut une preuve
     * d'identité, une fois. Garder le jeton d'accès serait stocker un credential sans
     * usage, donc un risque sans bénéfice.
     */
    const begin = await beginLogin();
    const done = await finishLogin(begin);
    const serialised = JSON.stringify(done.body);

    expect(serialised).not.toContain("jeton-dacces-que-placet-ignore");
    expect(serialised).not.toContain(CLIENT_SECRET);
    /* Le jeton d'identité non plus : la session d'Oathrion le remplace. */
    expect(serialised).not.toContain("eyJ");
  });

  it("le `clientSecret` n'apparaît dans aucune réponse, même en échec", async () => {
    nextClaims = { aud: "mauvaise-audience" };
    const begin = await beginLogin();
    const done = await finishLogin(begin);
    expect(JSON.stringify(done.body)).not.toContain(CLIENT_SECRET);
  });
});

describe("quand le SSO n'est pas configuré", () => {
  it("les deux routes répondent 404, pas 403", async () => {
    /*
     * Sans configuration, la fonctionnalité n'existe pas. Un 403 confirmerait l'existence
     * du point d'entrée à qui le cherche.
     */
    const previous = process.env.OATHRION_OIDC;
    delete process.env.OATHRION_OIDC;
    try {
      const start = await fetch(`${client.baseUrl}/api/auth/sso/start?format=json`);
      expect(start.status).toBe(404);
      const callback = await fetch(`${client.baseUrl}/api/auth/sso/callback?code=x&state=y`);
      expect(callback.status).toBe(404);
    } finally {
      process.env.OATHRION_OIDC = previous;
    }
  });

  it("la connexion par mot de passe continue de marcher", async () => {
    /* Le SSO s'ajoute, il ne remplace pas : un déploiement sans IdP n'est pas cassé. */
    const res = await client.get("/api/agents", { auth: ROLE_KEYS.admin });
    expect(res.status).toBe(200);
  });
});

/**
 * L'IDENTITÉ EST `(issuer, sub)`, ET L'ADRESSE N'EST QU'UN ATTRIBUT.
 *
 * Ce bloc existe à cause d'un défaut précis de la première version : la route faisait
 * `findByEmail(verdict.email)` et rien d'autre. Une adresse électronique est
 * RÉATTRIBUABLE dans un annuaire d'entreprise — un départ, une homonymie, un alias repris
 * par le service informatique. Le jour où cela arrive, la nouvelle personne hérite
 * silencieusement du compte de console de l'ancienne : son rôle, son organisation, ses
 * approbations en attente. Rien ne le signale, puisque du point de vue d'Oathrion c'est la
 * même adresse qui revient.
 *
 * Les tests passent par le VRAI fournisseur de ce fichier — jetons signés par une vraie
 * clé RSA, route réelle, base réelle. C'est la seule façon de prouver que la liaison est
 * écrite et relue, et pas seulement qu'une fonction de dépôt se comporte bien.
 */
describe("la liaison entre l'identité du fournisseur et le compte de console", () => {
  it("lie `(issuer, sub)` au compte à la PREMIÈRE connexion", async () => {
    nextClaims = { sub: "idp-premiere-liaison", email: TEST_CONSOLE_EMAIL };
    const done = await finishLogin(await beginLogin());
    expect(done.status).toBe(200);

    const lien = ssoIdentityStore.find(issuer, "idp-premiere-liaison");
    expect(lien).not.toBeNull();
    expect(lien?.lastEmail).toBe(TEST_CONSOLE_EMAIL);
  });

  it("suit le `sub` quand l'adresse a changé — un mariage n'est pas une attaque", async () => {
    nextClaims = { sub: "idp-adresse-changeante", email: TEST_CONSOLE_EMAIL };
    expect((await finishLogin(await beginLogin())).status).toBe(200);

    /*
     * La même personne revient sous une adresse qui n'a AUCUN compte de console. Par
     * adresse, elle serait refusée ; par `sub`, elle est reconnue. C'est le comportement
     * voulu, et c'est aussi ce qui rend le refus du test suivant non ambigu.
     */
    nextClaims = { sub: "idp-adresse-changeante", email: "nouveau.nom@acme.example.com" };
    const retour = await finishLogin(await beginLogin());
    expect(retour.status).toBe(200);

    const lien = ssoIdentityStore.find(issuer, "idp-adresse-changeante");
    expect(lien?.lastEmail).toBe("nouveau.nom@acme.example.com");
  });

  it("REFUSE une adresse réattribuée à une autre identité", async () => {
    /*
     * LE TEST QUI JUSTIFIE TOUTE LA TABLE.
     *
     * Étape 1 : quelqu'un se connecte, son `sub` est lié au compte de console.
     * Étape 2 : un AUTRE `sub` se présente avec LA MÊME adresse — c'est-à-dire l'adresse
     * a été réattribuée dans l'annuaire du client.
     *
     * L'ancienne version aurait ouvert une session sur le compte de la première
     * personne. Ici c'est un refus : suivre l'adresse donnerait le compte au nouveau
     * venu, suivre le `sub` créerait un doublon, et aucune des deux décisions
     * n'appartient à du code.
     */
    nextClaims = { sub: "idp-titulaire-initial", email: TEST_CONSOLE_EMAIL };
    expect((await finishLogin(await beginLogin())).status).toBe(200);

    nextClaims = { sub: "idp-nouveau-titulaire", email: TEST_CONSOLE_EMAIL };
    const usurpation = await finishLogin(await beginLogin());

    expect(usurpation.status).toBe(403);
    expect(usurpation.body.error).toBe("sso_refused");
    /* Le message rendu reste générique — il ne dit pas à qui l'adresse appartenait. */
    expect(JSON.stringify(usurpation.body)).not.toContain("idp-titulaire-initial");
    /* Et la liaison d'origine est INTACTE : un refus ne déplace rien. */
    expect(ssoIdentityStore.find(issuer, "idp-titulaire-initial")?.lastEmail).toBe(
      TEST_CONSOLE_EMAIL,
    );
    expect(ssoIdentityStore.find(issuer, "idp-nouveau-titulaire")).toBeNull();
  });

  it("ne confond pas deux émetteurs qui emploient le même `sub`", async () => {
    /*
     * Les `sub` ne sont uniques QUE dans le périmètre de leur émetteur : `12345` chez
     * deux fournisseurs désigne deux personnes. L'unicité porte donc sur la paire, et ce
     * test le prouve par la base plutôt que par lecture du schéma.
     */
    nextClaims = { sub: "sub-partage", email: TEST_CONSOLE_EMAIL };
    expect((await finishLogin(await beginLogin())).status).toBe(200);

    expect(ssoIdentityStore.find(issuer, "sub-partage")).not.toBeNull();
    expect(ssoIdentityStore.find("https://un-autre-idp.example.com", "sub-partage")).toBeNull();
  });

  it("une liaison vers un compte supprimé est refusée, sans repli sur l'adresse", async () => {
    /*
     * Le repli serait la faute : retomber sur `findByEmail` quand la liaison pointe dans
     * le vide rouvrirait exactement la porte que la table ferme — et elle se rouvrirait
     * précisément le jour où un compte a été supprimé, c'est-à-dire le jour où l'on
     * tient le moins à ce qu'une session s'ouvre.
     */
    ssoIdentityStore.bind({
      issuer,
      subject: "idp-compte-disparu",
      userId: "usr_qui-nexiste-pas",
      organizationId: null,
      email: TEST_CONSOLE_EMAIL,
    });

    nextClaims = { sub: "idp-compte-disparu", email: TEST_CONSOLE_EMAIL };
    const done = await finishLogin(await beginLogin());
    expect(done.status).toBe(403);
  });

  it("deux connexions simultanées du même `sub` aboutissent au même compte", async () => {
    /*
     * La course que l'unicité en base rattrape : les deux lisent « aucune liaison » avant
     * que l'une ait écrit. Un contrôle applicatif se perdrait dans cette fenêtre et
     * créerait deux lignes — donc deux identités pour une personne.
     *
     * Les deux `beginLogin` sont faits d'abord, pour que les deux `state` existent avant
     * le premier échange : c'est ce qui rend le recouvrement réel plutôt que séquentiel.
     */
    nextClaims = { sub: "idp-course", email: TEST_CONSOLE_EMAIL };
    const [a, b] = await Promise.all([beginLogin(), beginLogin()]);
    const [ra, rb] = await Promise.all([finishLogin(a), finishLogin(b)]);

    expect([ra.status, rb.status]).toEqual([200, 200]);
    const lien = ssoIdentityStore.find(issuer, "idp-course");
    expect(lien).not.toBeNull();
    /* UNE seule ligne pour ce `sub` : c'est l'unicité de la migration 23 qui le garantit. */
    expect(ssoIdentityStore.findForUser(issuer, lien!.userId)?.subject).toBe("idp-course");
  });

  it("n'écrit aucune liaison quand la connexion est refusée", async () => {
    /*
     * Une liaison écrite avant les refus serait une liaison qu'aucune connexion ne
     * pourrait plus jamais rafraîchir — et, pour un jeton refusé, une liaison créée par
     * un jeton qu'Oathrion vient de déclarer indigne de confiance.
     */
    nextClaims = { sub: "idp-jamais-lie", email: "inconnu.total@acme.example.com" };
    const done = await finishLogin(await beginLogin());
    expect(done.status).toBe(403);
    expect(ssoIdentityStore.find(issuer, "idp-jamais-lie")).toBeNull();
  });
});

/**
 * LE JETON DE SESSION, ET LES ENDROITS OÙ IL NE DOIT PAS SE RETROUVER.
 *
 * Le rappel SSO est un **GET qui renvoie un jeton de session dans son corps**. C'est
 * inhabituel, et c'est imposé par le protocole : le fournisseur ramène le navigateur par
 * une navigation, donc par un GET. Or une réponse à un GET est cacheable PAR DÉFAUT — le
 * navigateur peut la garder sur disque, et un mandataire d'entreprise placé devant Oathrion
 * peut la garder pour tout le monde.
 *
 * La première version ne posait aucun en-tête de cache. Les deux autres routes d'Oathrion
 * qui rendent un jeton (`/api/auth/login` et `/api/invitations`) sont des POST, donc non
 * cacheables par défaut : le rappel SSO était le seul GET concerné.
 */
describe("le jeton de session ne doit ni se cacher ni se promener", () => {
  it("le rappel INTERDIT le stockage de sa réponse", async () => {
    nextClaims = { sub: "idp-cache-succes", email: TEST_CONSOLE_EMAIL };
    const done = await finishLogin(await beginLogin());
    expect(done.status).toBe(200);
    /* Le corps porte bien un jeton — c'est ce qui rend l'en-tête nécessaire. */
    expect(typeof done.body.token).toBe("string");

    const cache = done.callbackHeaders.get("cache-control") ?? "";
    /*
     * `no-store` et pas seulement `no-cache` : `no-cache` AUTORISE le stockage et
     * n'impose qu'une revalidation, ce qui laisse le jeton sur le disque.
     */
    expect(cache).toContain("no-store");
    expect(cache).toContain("private");
  });

  it("l'interdiction vaut AUSSI pour les réponses de refus", async () => {
    /*
     * Un en-tête posé seulement sur le chemin heureux est un en-tête qu'on oublie le
     * jour où l'on ajoute une sortie. Celui-ci est posé à l'entrée du gestionnaire,
     * et ce test le prouve sur un chemin qui ne produit aucun jeton.
     */
    const done = await finishLogin({ state: "inconnu", nonce: "x" });
    expect(done.status).toBe(400);
    expect(done.headers.get("cache-control") ?? "").toContain("no-store");
  });

  it("le rappel n'emporte pas le code d'autorisation dans un `Referer`", async () => {
    /*
     * L'URL du rappel porte le code d'autorisation ; un `Referer` l'emporterait vers la
     * page suivante. L'en-tête vient de `security.ts`, qui le pose pour toutes les
     * réponses — ce test l'affirme sur CETTE réponse, parce que c'est ici qu'il compte,
     * et pour que son retrait global soit visible depuis le SSO.
     *
     * Une version précédente de ce fichier posait l'en-tête une seconde fois dans la
     * route. Un mutant l'a montrée inutile : le retrait de cette ligne ne faisait tomber
     * aucun test, parce que la garantie était déjà ailleurs.
     */
    nextClaims = { sub: "idp-referer", email: TEST_CONSOLE_EMAIL };
    const done = await finishLogin(await beginLogin());
    expect(done.callbackHeaders.get("referrer-policy")).toBe("no-referrer");
  });

  it("`/start` interdit le stockage de sa redirection", async () => {
    /*
     * Une redirection mise en cache rejouerait un `state` déjà consommé — donc une
     * connexion refusée sans raison visible — et conserverait un `nonce` qui ne doit
     * vivre que le temps d'une tentative.
     */
    const res = await fetch(`${client.baseUrl}/api/auth/sso/start?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control") ?? "").toContain("no-store");
  });

  it("aucun jeton de session ne voyage dans une URL", async () => {
    /*
     * Une URL finit dans l'historique du navigateur, dans les journaux du mandataire et
     * dans l'en-tête `Referer` de la navigation suivante. Le jeton est donc dans le
     * CORPS, et `returnTo` — la seule valeur qu'Oathrion renvoie pour une navigation —
     * doit rester un chemin relatif sans jeton.
     */
    nextClaims = { sub: "idp-pas-dans-l-url", email: TEST_CONSOLE_EMAIL };
    const done = await finishLogin(await beginLogin());
    expect(done.status).toBe(200);
    const token = String(done.body.token);
    expect(token.length).toBeGreaterThan(16);
    expect(String(done.body.returnTo ?? "")).not.toContain(token);
    expect(String(done.body.returnTo ?? "")).toMatch(/^\//);
  });
});

describe("le `state` : imprévisible, unique, et périssable", () => {
  it("deux tentatives ne partagent ni `state` ni `nonce`", async () => {
    const a = await beginLogin();
    const b = await beginLogin();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    /*
     * Et le `state` n'est pas le `nonce`. Les deux rôles sont distincts : le `state`
     * revient dans l'URL et prouve que ce retour répond à une demande d'Oathrion ; le
     * `nonce` va dans le JETON et prouve que ce jeton a été émis pour cette demande.
     * Réutiliser une seule valeur mettrait dans l'URL ce qui doit rester dans le jeton.
     */
    expect(a.state).not.toBe(a.nonce);
  });

  it("le `state` porte au moins 32 octets d'aléa", async () => {
    /*
     * Un `state` devinable rendrait le contrôle CSRF décoratif. On mesure la LONGUEUR
     * DÉCODÉE plutôt que la longueur de la chaîne : un encodage bavard ferait croire à
     * de l'entropie qui n'y est pas.
     */
    const { state, nonce } = await beginLogin();
    expect(Buffer.from(state, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(nonce, "base64url").length).toBeGreaterThanOrEqual(32);
  });

  it("vingt tentatives donnent vingt `state` distincts", async () => {
    /* Un compteur, un horodatage ou un générateur mal amorcé se verrait ici. */
    const vus = new Set<string>();
    for (let i = 0; i < 20; i += 1) vus.add((await beginLogin()).state);
    expect(vus.size).toBe(20);
  });

  it("un `state` consommé puis rejoué une troisième fois reste refusé", async () => {
    /*
     * Le rejeu n'est pas un événement unique : un retour capturé dans un journal de
     * mandataire sera essayé plusieurs fois. La consommation est un `delete` AVANT le
     * contrôle d'expiration, donc une tentative reprise est perdue dans tous les cas.
     */
    nextClaims = { sub: "idp-rejeu", email: TEST_CONSOLE_EMAIL };
    const begin = await beginLogin();
    expect((await finishLogin(begin)).status).toBe(200);
    expect((await finishLogin(begin)).status).toBe(400);
    expect((await finishLogin(begin)).status).toBe(400);
  });
});

/**
 * LE TICKET : ce qui voyage dans l'URL, et pourquoi ce n'est pas un jeton.
 *
 * Le fournisseur ramène le navigateur par une NAVIGATION, qui détruit la mémoire de la
 * console — l'application à page unique qui garde son jeton en mémoire n'existe pas
 * encore quand le jeton est prêt. La première version résolvait cela en rendant le jeton
 * en JSON : le navigateur affichait une page de JSON brut portant un jeton de session,
 * visible, copiable, et dans l'historique.
 *
 * Ce qui voyage est donc un ticket opaque, valable 60 secondes et consommable UNE fois —
 * exactement ce qu'est un code d'autorisation OAuth, et pour la même raison. Un ticket
 * resté dans l'historique est un ticket déjà dépensé.
 */
describe("le ticket de passage au navigateur", () => {
  async function callbackOnly(begin: { state: string; nonce: string; cookie: string }) {
    const query = new URLSearchParams({
      code: `code-for-${begin.nonce}`,
      state: begin.state,
      format: "json",
    });
    const res = await fetch(`${client.baseUrl}/api/auth/sso/callback?${query.toString()}`, {
      headers: { cookie: begin.cookie },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function claim(handoff: unknown) {
    const res = await fetch(`${client.baseUrl}/api/auth/sso/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
  }

  it("le rappel ne rend AUCUN jeton de session", async () => {
    nextClaims = { sub: "idp-ticket-1", email: TEST_CONSOLE_EMAIL };
    const first = await callbackOnly(await beginLogin());
    expect(first.status).toBe(200);
    expect(typeof first.body.handoff).toBe("string");
    /* Le mot « token » n'apparaît pas dans cette réponse, sous aucune forme. */
    expect(Object.keys(first.body)).not.toContain("token");
    expect(JSON.stringify(first.body)).not.toContain("oathrion_session");
  });

  it("le ticket s'échange UNE fois contre un jeton utilisable", async () => {
    nextClaims = { sub: "idp-ticket-2", email: TEST_CONSOLE_EMAIL };
    const first = await callbackOnly(await beginLogin());
    const session = await claim(first.body.handoff);

    expect(session.status).toBe(200);
    expect(typeof session.body.token).toBe("string");

    /* Et le jeton obtenu est une VRAIE session, pas une chaîne qui en a l'air. */
    const sessions = await client.get<{ sessions: unknown[] }>("/api/auth/sessions", {
      auth: String(session.body.token),
    });
    expect(sessions.status).toBe(200);

    /* Le second échange est refusé : le ticket a été consommé. */
    const rejeu = await claim(first.body.handoff);
    expect(rejeu.status).toBe(400);
  });

  it("un ticket inventé est refusé", async () => {
    expect((await claim("un-ticket-que-personne-n-a-emis")).status).toBe(400);
    expect((await claim("")).status).toBe(400);
    /* Et un type inattendu ne doit pas faire lever le serveur. */
    expect((await claim(42)).status).toBe(400);
    expect((await claim(null)).status).toBe(400);
  });

  it("deux tickets ne se ressemblent pas et portent 32 octets d'aléa", async () => {
    nextClaims = { sub: "idp-ticket-3", email: TEST_CONSOLE_EMAIL };
    const a = await callbackOnly(await beginLogin());
    nextClaims = { sub: "idp-ticket-3", email: TEST_CONSOLE_EMAIL };
    const b = await callbackOnly(await beginLogin());

    expect(a.body.handoff).not.toBe(b.body.handoff);
    expect(Buffer.from(String(a.body.handoff), "base64url").length).toBeGreaterThanOrEqual(32);
  });

  it("un ticket périmé est refusé", async () => {
    /*
     * Soixante secondes, et le temps est pris à la consommation — pas de minuterie à
     * laquelle se fier. On éprouve la borne par la fonction, parce qu'attendre une
     * minute dans un test serait une minute perdue à chaque exécution de la suite.
     */
    const ref = issueHandoff("usr_peu-importe", "/", Date.now() - HANDOFF_TTL_MS - 1);
    expect(takeHandoff(ref)).toBeNull();

    const frais = issueHandoff("usr_peu-importe", "/");
    expect(takeHandoff(frais)).not.toBeNull();
    /* Consommé : le second appel ne rend rien, même dans la fenêtre. */
    expect(takeHandoff(frais)).toBeNull();
  });

  it("un ticket non échangé ne laisse aucune session derrière lui", async () => {
    /*
     * La session naît à l'ÉCHANGE, pas au rappel. Un onglet fermé entre les deux étapes
     * ne doit donc rien coûter : ni une session ouverte, ni un jeton valable quelque part.
     *
     * La mesure se fait depuis une session SSO réelle, qui sait lister les sessions du
     * compte. On compte, on abandonne un ticket, on recompte.
     */
    nextClaims = { sub: "idp-ticket-temoin", email: TEST_CONSOLE_EMAIL };
    const temoin = await finishLogin(await beginLogin());
    const token = String(temoin.body.token ?? "");
    expect(token).not.toBe("");

    const avant = await client.get<{ sessions: unknown[] }>("/api/auth/sessions", { auth: token });
    expect(avant.status).toBe(200);
    const compte = avant.body.sessions.length;

    /* Un rappel SANS échange : le ticket part à la poubelle avec l'onglet. */
    nextClaims = { sub: "idp-ticket-temoin", email: TEST_CONSOLE_EMAIL };
    const abandonne = await callbackOnly(await beginLogin());
    expect(typeof abandonne.body.handoff).toBe("string");

    const apres = await client.get<{ sessions: unknown[] }>("/api/auth/sessions", { auth: token });
    expect(apres.body.sessions.length).toBe(compte);
  });

  it("la réponse de l'échange interdit son stockage", async () => {
    nextClaims = { sub: "idp-ticket-cache", email: TEST_CONSOLE_EMAIL };
    const first = await callbackOnly(await beginLogin());
    const session = await claim(first.body.handoff);
    expect(session.headers.get("cache-control") ?? "").toContain("no-store");
  });

  it("le rappel redirige un navigateur, et le ticket est dans l'URL — pas le jeton", async () => {
    /*
     * Sans `format=json`, c'est un 302. On ne suit PAS la redirection : ce qu'on veut
     * voir est l'URL elle-même, et ce qu'elle porte.
     */
    nextClaims = { sub: "idp-ticket-302", email: TEST_CONSOLE_EMAIL };
    const begin = await beginLogin();
    const query = new URLSearchParams({ code: `code-for-${begin.nonce}`, state: begin.state });
    const res = await fetch(`${client.baseUrl}/api/auth/sso/callback?${query.toString()}`, {
      headers: { cookie: begin.cookie },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    /* Un chemin RELATIF : `startLogin` l'impose, et c'est ce qui ferme la redirection ouverte. */
    expect(location.startsWith("/")).toBe(true);
    expect(location).toContain("sso_handoff=");

    /* Le ticket de l'URL s'échange, donc la redirection est bien utilisable. */
    const ticket = new URL(location, "http://placet.invalid").searchParams.get("sso_handoff");
    expect((await claim(ticket)).status).toBe(200);
  });
});

describe("la route d'état du SSO", () => {
  it("dit que le SSO est configuré, sans nommer l'émetteur", async () => {
    const res = await fetch(`${client.baseUrl}/api/auth/sso/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    /*
     * Et rien de plus. Un nom d'émetteur dirait à un visiteur anonyme quel annuaire
     * l'entreprise emploie — une information qui ne sert qu'à celui qui prépare un
     * hameçonnage.
     */
    expect(Object.keys(body)).toEqual(["configured"]);
  });

  it("répond sans session : c'est l'écran de connexion qui la lit", async () => {
    const res = await fetch(`${client.baseUrl}/api/auth/sso/status`);
    expect(res.status).not.toBe(401);
    expect(res.headers.get("cache-control") ?? "").toContain("no-store");
  });
});
