/**
 * LE RELAIS EN FLUX : Oathrion devant une API qui répond au fil de l'eau.
 *
 * ## Le défaut que ce fichier ferme
 *
 * Le relais TAMPONNAIT : il attendait la réponse entière du fournisseur, puis la rendait
 * d'un coup. Pour une API de modèle — OpenAI, Anthropic, Mistral — qui répond en
 * `text/event-stream` pendant plusieurs secondes, cela supprimait le streaming que
 * l'application de l'utilisateur attend, et une réponse longue butait sur le plafond de
 * 1 Mio et faisait échouer l'appel.
 *
 * Pour un produit qui gouverne des agents IA, c'était le cas d'usage le plus naturel et
 * il était hors de portée.
 *
 * ## La propriété mesurée, et pourquoi elle n'est pas contournable
 *
 * L'amont de ce fichier émet un premier événement, **attend 250 ms**, puis émet le
 * second. Un relais qui tamponne fait arriver les deux ensemble à la fin ; un relais qui
 * fait couler fait arriver le premier tout de suite. Le test mesure donc l'ÉCART entre
 * l'arrivée du premier et du dernier octet.
 *
 * Et il y a un CONTRÔLE NÉGATIF sur le même amont, avec la même pause : une règle sans
 * `stream` doit voir les deux événements arriver ensemble. Sans ce contrôle, l'assertion
 * de temps passerait aussi sur un relais qui tamponne mais dont le réseau est lent.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* Le harnais est importé DYNAMIQUEMENT : voir `beforeAll`. */
type Harness = typeof import("./harness");
let harness: Harness;
let client: Awaited<ReturnType<Harness["startTestServer"]>>;

const PROVIDER_KEY = "sk_du_modele_que_lagent_na_jamais_vu";
const AGENT_ID = "agt_flux";

/*
 * La clé de l'agent est FRAPPÉE pendant la mise en place, et il faut une session
 * d'administrateur pour cela : `POST /api/keys` refuse une clé d'API, même `admin`.
 * C'est volontaire côté produit — frapper un credential est un geste humain — et ça
 * oblige ce fichier à ouvrir une session comme le ferait un exploitant.
 */
let agentKey = "";

/** Ce que l'amont a reçu, pour prouver un négatif du côté de celui qui l'aurait reçu. */
interface Seen {
  url: string;
  authorization: string;
  body: string;
}
const seen: Seen[] = [];
let upstream: Server;

/** La pause entre les deux événements. Le relais ne peut pas la rattraper. */
const GAP_MS = 250;

async function startUpstream(): Promise<string> {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "",
        authorization: String(req.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });

      if ((req.url ?? "").startsWith("/v1/facon-slack")) {
        /*
         * UNE API À LA SLACK : toujours 200, et la réussite dans le corps. Le corps de la
         * requête dit laquelle rendre, pour éprouver les deux issues sur le même amont.
         */
        const asked = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(asked.includes("echec") ? '{"ok":false,"error":"invalid_auth"}' : '{"ok":true,"ts":"1700000000.000100"}');
        return;
      }

      if ((req.url ?? "").startsWith("/v1/sentinelle")) {
        /*
         * UNE RÉPONSE TAMPONNÉE PORTANT UNE VALEUR SENTINELLE.
         *
         * Le mode tamponné est celui où `result.data` portait historiquement le corps du
         * fournisseur, donc celui où le corps se retrouvait EN BASE. La chaîne
         * `SENTINELLE_CORPS_FOURNISSEUR` n'apparaît nulle part ailleurs dans ce dépôt :
         * si elle sort d'une lecture de la base, elle ne peut venir que d'ici.
         */
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            client: "Marie Dupont",
            carte: "4242",
            note: "SENTINELLE_CORPS_FOURNISSEUR",
          }),
        );
        return;
      }

      if ((req.url ?? "").startsWith("/v1/surcharge")) {
        /* Un statut d'erreur DU FOURNISSEUR, pour vérifier qu'il n'est pas fabriqué. */
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end('{"error":"rate_limited"}');
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write("data: {\"delta\":\"premier\"}\n\n");
      setTimeout(() => {
        res.write("data: {\"delta\":\"second\"}\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
      }, GAP_MS);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/`;
}

/**
 * Lit la réponse morceau par morceau et HORODATE chaque arrivée.
 *
 * C'est la seule mesure qui distingue un flux d'un tampon : le contenu final est le même
 * dans les deux cas.
 */
async function readWithTimings(
  path: string,
  key: string,
): Promise<{ status: number; headers: Headers; text: string; firstAt: number; lastAt: number }> {
  const started = Date.now();
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", stream: true, prompt: "bonjour" }),
  });

  let text = "";
  let firstAt = -1;
  let lastAt = -1;
  const reader = res.body?.getReader();
  if (reader) {
    const decode = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        if (firstAt < 0) firstAt = Date.now() - started;
        lastAt = Date.now() - started;
        text += decode.decode(value, { stream: true });
      }
    }
  }
  return { status: res.status, headers: res.headers, text, firstAt, lastAt };
}

beforeAll(async () => {
  const url = await startUpstream();

  /*
   * L'environnement est posé AVANT d'importer le harnais, et c'est obligatoire :
   * `server/routes.ts` analyse `OATHRION_INTERCEPTS` dans une constante de module, donc à
   * l'import. Un `import` statique en haut de ce fichier serait hissé avant ces lignes et
   * le serveur démarrerait sans aucune règle.
   */
  process.env.OATHRION_LOCAL_MCP_URL = url;
  process.env.OATHRION_LOCAL_MCP_ORGANIZATIONS = "*";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  process.env.OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE = PROVIDER_KEY;
  process.env.OATHRION_INTERCEPTS = JSON.stringify([
    {
      id: "modele_flux",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/chat",
      action: "api.request",
      target: "body.model",
      stream: true,
      forwardHeaders: ["content-type", "accept"],
    },
    /*
     * LE CONTRÔLE NÉGATIF : même amont, même pause, pas de `stream`. Sans lui, l'assertion
     * de temps ne prouverait pas que c'est le MODE qui change quelque chose.
     */
    {
      id: "modele_tampon",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/chat-tampon",
      action: "api.request",
      target: "body.model",
      forwardHeaders: ["content-type"],
    },
    /* Une cible refusée par une politique, pour prouver qu'un BLOCK ne laisse rien couler. */
    {
      id: "modele_interdit",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/chat-interdit",
      action: "api.request",
      target: "body.model",
      stream: true,
    },
    /* Une API qui répond 200 et dit sa réussite dans `ok`, comme Slack. */
    {
      id: "facon_slack",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/facon-slack",
      action: "api.request",
      target: "body.model",
      forwardHeaders: ["content-type"],
      successField: "ok",
    },
    /* Le mode TAMPONNÉ, avec une réponse qui porte une valeur sentinelle. */
    {
      id: "modele_sentinelle",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/sentinelle",
      action: "api.request",
      target: "body.model",
      forwardHeaders: ["content-type"],
    },
    /* Un statut d'erreur du fournisseur, en mode flux. */
    {
      id: "modele_surcharge",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/surcharge",
      action: "api.request",
      target: "body.model",
      stream: true,
    },
  ]);

  harness = await import("./harness");
  client = await harness.startTestServer();

  const login = await client.post<{ token?: string }>("/api/auth/login", {
    email: harness.TEST_CONSOLE_EMAIL,
    password: harness.TEST_CONSOLE_PASSWORD,
  });
  const session = String(login.body.token ?? "");
  expect(session).not.toBe("");

  await client.post(
    "/api/agents",
    {
      id: AGENT_ID,
      name: "Agent de flux",
      description: "Appelle une API de modèle à travers Oathrion.",
      provider: "openai",
      model: "gpt-4o",
      status: "active",
      owner: "ia",
      mandate: {
        maxTransactionAmount: 10_000,
        currency: "EUR",
        allowedCategories: [],
        blockedCategories: [],
        allowedDomains: [],
      },
      permissions: [
        { scope: "call:external-api", label: "Appeler une API tierce", description: "Sous mandat.", granted: true, risk: "medium" },
      ],
      policyIds: [],
      tags: ["flux"],
    },
    { auth: harness.ROLE_KEYS.admin },
  );

  const key = await client.post<{ secret?: string }>(
    "/api/keys",
    { name: "clé de flux", role: "operator", agentId: AGENT_ID },
    { auth: session },
  );
  agentKey = String(key.body.secret ?? "");
  expect(agentKey).not.toBe("");

  /* Un refus sec sur un modèle nommé : la cible est lue dans le corps. */
  await client.post(
    "/api/policies",
    {
      id: "pol_modele_interdit",
      name: "Ce modèle n'est pas autorisé",
      description: "Refus sec.",
      type: "BLOCK_TOOL",
      condition: { kind: "targetMatches", targets: ["modele-interdit"] },
      scope: "organization",
      appliesTo: "all agents",
      effect: "block",
      status: "enabled",
      action: "BLOCK",
      risk: "critical",
      priority: 5,
    },
    { auth: harness.ROLE_KEYS.admin },
  );
},
/*
 * SOIXANTE SECONDES, et pas le défaut de dix.
 *
 * Cette mise en place démarre un serveur amont, importe le harnais, ouvre une session,
 * crée un agent, une politique et une clé — une demi-douzaine d'allers-retours. Sur une
 * machine chargée elle a dépassé dix secondes, et le fichier a été rapporté comme
 * ÉCHOUÉ AVEC ZÉRO TEST : pas un test faux, une mise en place interrompue.
 *
 * Un délai trop court ne protège de rien ici — il n'y a pas de boucle infinie possible
 * dans ces appels — et il transforme une machine occupée en échec de suite, c'est-à-dire
 * en bruit qui apprend à ignorer les échecs.
 */
60_000);

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  for (const name of [
    "OATHRION_LOCAL_MCP_URL",
    "OATHRION_LOCAL_MCP_ORGANIZATIONS",
    "OATHRION_KEK",
    "OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE",
    "OATHRION_INTERCEPTS",
  ]) {
    delete process.env[name];
  }
});

describe("le flux arrive au fil de l'eau", () => {
  it("le premier événement arrive AVANT que l'amont ait fini d'émettre", async () => {
    const before = seen.length;
    const res = await readWithTimings("/api/v1/intercept/local-fixture/v1/chat", agentKey);

    expect(res.status).toBe(200);
    /* Le contenu complet, dans l'ordre : un flux ne doit pas perdre d'octets. */
    expect(res.text).toContain("premier");
    expect(res.text).toContain("second");
    expect(res.text.indexOf("premier")).toBeLessThan(res.text.indexOf("second"));

    /*
     * LA MESURE. L'amont attend 250 ms entre les deux événements, et aucun relais ne peut
     * rattraper cette pause. Un écart proche de 250 ms prouve que le premier octet est
     * parti chez l'agent avant que le second n'existe.
     *
     * La borne est à 150 ms et non à 250 : la machine de test peut être chargée, et le
     * seuil doit tomber du côté du faux négatif — un test de flux qui échoue par
     * ordonnancement est pénible ; un test qui PASSE sur un relais tamponné est inutile.
     * Le contrôle négatif juste en dessous ferme ce second risque.
     */
    expect(res.lastAt - res.firstAt).toBeGreaterThan(150);
    expect(seen.length).toBe(before + 1);
  });

  it("CONTRÔLE NÉGATIF : la même API sans `stream` arrive d'un seul coup", async () => {
    const res = await readWithTimings("/api/v1/intercept/local-fixture/v1/chat-tampon", agentKey);

    expect(res.status).toBe(200);
    expect(res.text).toContain("premier");
    expect(res.text).toContain("second");
    /*
     * Tout arrive ensemble : l'écart entre le premier et le dernier octet est quasi nul,
     * alors que la pause de l'amont est la même. C'est ce qui donne un sens à l'assertion
     * du test précédent — sans lui, elle pourrait mesurer la lenteur du réseau.
     */
    expect(res.lastAt - res.firstAt).toBeLessThan(80);
  });
});

describe("la gouvernance d'un flux", () => {
  it("les en-têtes de gouvernance sont posés AVANT le premier octet", async () => {
    const res = await readWithTimings("/api/v1/intercept/local-fixture/v1/chat", agentKey);

    expect(res.headers.get("x-oathrion-decision")).toBe("ALLOW");
    expect(res.headers.get("x-oathrion-rule")).toBe("modele_flux");
    /*
     * L'identifiant d'exécution est le seul lien entre cette réponse et son reçu. Une
     * réponse en flux ne doit pas être la seule réponse du pare-feu qu'un auditeur ne peut
     * pas relier — c'est pour ça qu'il voyage dans le passage de main.
     */
    expect(res.headers.get("x-oathrion-execution-id")).toMatch(/\S/);
    expect(res.headers.get("x-oathrion-credential-injected")).toBe("true");
    /* Et le `content-type` du fournisseur, sinon le client ne sait pas lire des événements. */
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("le credential est celui d'Oathrion, et la clé de l'agent ne part pas", async () => {
    const before = seen.length;
    await readWithTimings("/api/v1/intercept/local-fixture/v1/chat", agentKey);
    const received = seen[before];

    expect(received?.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
    /* La clé Oathrion de l'agent n'atteint JAMAIS le fournisseur. */
    expect(received?.authorization).not.toContain(agentKey);
    /* Et le corps de la requête part tel quel. */
    expect(received?.body).toContain("gpt-4o");
  });

  it("le statut est celui du FOURNISSEUR, pas 200 d'office", async () => {
    const res = await readWithTimings("/api/v1/intercept/local-fixture/v1/surcharge", agentKey);
    /*
     * 429 du fournisseur, rendu tel quel. Un agent qui reçoit 200 pour un 429 croirait son
     * appel passé et n'attendrait pas.
     */
    expect(res.status).toBe(429);
    expect(res.text).toContain("rate_limited");
  });

  it("un BLOCK ne laisse RIEN couler, et l'amont n'est pas touché", async () => {
    const before = seen.length;
    const res = await fetch(`${client.baseUrl}/api/v1/intercept/local-fixture/v1/chat-interdit`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "modele-interdit", stream: true }),
    });
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(text).not.toContain("premier");
    /* Mesuré du côté de celui qui l'aurait reçue : ZÉRO requête chez l'amont. */
    expect(seen.length).toBe(before);
  });
});

describe("ce que le reçu porte après un flux", () => {
  it("les octets RÉELLEMENT passés, et le fait que c'était un flux", async () => {
    const res = await readWithTimings("/api/v1/intercept/local-fixture/v1/chat", agentKey);
    const executionId = res.headers.get("x-oathrion-execution-id") ?? "";
    expect(executionId).toMatch(/\S/);

    const receipts = await client.get<{ entries?: { executionId?: string; action?: string }[] }>(
      "/api/actions/receipts",
      { auth: harness.ROLE_KEYS.admin },
    );
    expect(receipts.status).toBe(200);

    /*
     * Le reçu est écrit par la passerelle quand `run()` rend — donc APRÈS la fin du
     * transfert. C'est cet ordre qui permet d'y porter un nombre d'octets qui veut dire
     * quelque chose : rendre plus tôt écrirait un compte pris au milieu.
     */
    const executions = await client.get<{ id: string; toolResult?: Record<string, unknown> }[]>(
      "/api/executions",
      { auth: harness.ROLE_KEYS.admin },
    );
    const mine = executions.body.find((entry) => entry.id === executionId);
    expect(mine).toBeDefined();
    expect(mine?.toolResult?.streamed).toBe(true);
    expect(mine?.toolResult?.truncated).toBe(false);
    expect(Number(mine?.toolResult?.responseBytes ?? 0)).toBeGreaterThan(20);

    /*
     * ET LE CORPS DE LA RÉPONSE N'EST PAS LÀ. C'est la propriété que le mode tamponné a
     * dû apprendre à la dure — `result.data` est persisté — et le mode flux ne doit pas la
     * reperdre. Un flux n'a d'ailleurs jamais le corps entier à offrir.
     */
    expect(JSON.stringify(mine?.toolResult ?? {})).not.toContain("premier");
    expect(JSON.stringify(mine?.toolResult ?? {})).not.toContain(PROVIDER_KEY);
  });
});

/**
 * LA RÉPONSE DU FOURNISSEUR NE DOIT PAS FINIR EN BASE — ÉPROUVÉ PAR UNE SENTINELLE.
 *
 * ## La propriété, et pourquoi elle est fragile
 *
 * `InterceptTool.run()` rend un résultat, et ce résultat est PERSISTÉ avec l'exécution.
 * Si le corps de la réponse du fournisseur y entre, Oathrion écrit en base l'objet métier
 * du client : nom, adresse, fin de numéro de carte. Pour un produit vendu comme pare-feu
 * de gouvernance, ce serait exactement le contraire de sa promesse — et ce serait écrit
 * dans la table que l'on montre aux auditeurs.
 *
 * La réponse voyage donc par une table EN MÉMOIRE (`takeResponse`), lue une fois et
 * oubliée, et jamais par `toolResult`.
 *
 * ## Pourquoi une sentinelle plutôt qu'une inspection de champ
 *
 * Vérifier que `toolResult.data` est absent prouve que CE champ-là est vide. Une
 * sentinelle prouve que la valeur n'est **nulle part** — ni dans `toolResult`, ni dans le
 * journal d'audit, ni dans un champ qu'on n'aurait pas pensé à regarder. C'est la
 * différence entre vérifier une implémentation et vérifier une propriété.
 *
 * La chaîne employée n'apparaît nulle part ailleurs dans ce dépôt : si elle sort d'une
 * lecture de la base, elle ne peut venir que du faux fournisseur.
 *
 * ## Ce que cela complète
 *
 * Le mode FLUX avait déjà son test (« le corps de la réponse n'est pas là »). Le mode
 * TAMPONNÉ — celui où `result.data` portait historiquement le corps — n'avait qu'une
 * vérification sur le CREDENTIAL, pas sur le corps. C'est ce trou-ci qui est comblé.
 */
describe("la réponse du fournisseur ne survit pas en base", () => {
  const SENTINELLE = "SENTINELLE_CORPS_FOURNISSEUR";

  it("le corps est rendu à l'agent, et n'est écrit nulle part", async () => {
    const res = await fetch(`${client.baseUrl}/api/v1/intercept/local-fixture/v1/sentinelle`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "modele-ok" }),
    });
    const texte = await res.text();

    /* D'abord : l'agent le reçoit bien. Sinon le test suivant passerait pour rien. */
    expect(res.status).toBe(200);
    expect(texte).toContain(SENTINELLE);
    const executionId = res.headers.get("x-oathrion-execution-id") ?? "";
    expect(executionId).not.toBe("");

    /*
     * Puis : il n'est NULLE PART dans ce que la base rend. On lit l'exécution entière —
     * `toolResult`, le journal d'audit, l'entrée, tout — et on cherche la sentinelle dans
     * la sérialisation complète.
     */
    const executions = await client.get<{ id: string }[]>("/api/executions", {
      auth: harness.ROLE_KEYS.admin,
    });
    expect(executions.status).toBe(200);
    const mine = (executions.body as Record<string, unknown>[]).find(
      (entry) => entry.id === executionId,
    );
    expect(mine).toBeDefined();
    expect(JSON.stringify(mine)).not.toContain(SENTINELLE);
    /* Ni le nom du client, ni la fin de carte — la sentinelle n'est pas le seul danger. */
    expect(JSON.stringify(mine)).not.toContain("Marie Dupont");
    expect(JSON.stringify(mine)).not.toContain("4242");
  });

  it("la sentinelle n'apparaît dans AUCUNE exécution de ce locataire", async () => {
    /*
     * Le filet plus large : pas seulement l'exécution attendue, mais la liste entière.
     * Un champ qui recopierait le corps ailleurs — un résumé, une trace, un message
     * d'erreur — serait pris ici.
     */
    const executions = await client.get<unknown[]>("/api/executions", {
      auth: harness.ROLE_KEYS.admin,
    });
    expect(JSON.stringify(executions.body)).not.toContain(SENTINELLE);
  });
});

/**
 * LES EN-TÊTES DE GOUVERNANCE SUR UN REFUS — la promesse de la documentation, rendue vraie.
 *
 * `docs/firewall.md` §3 annonce « trois en-têtes de gouvernance sur chaque réponse
 * relayée, lisibles sans parser le corps » : `x-oathrion-decision`, `x-oathrion-rule`,
 * `x-oathrion-execution-id`.
 *
 * C'était **faux pour un BLOCK**. Seule la voie autorisée les posait. Un intégrateur qui
 * lit la promesse écrit `if (headers['x-oathrion-decision'] === 'BLOCK')`, et cette
 * condition ne se déclenchait jamais — le pire genre de documentation, celui qui compile.
 *
 * ## Pourquoi c'est sur le refus que l'en-tête compte le plus
 *
 * Le statut d'une réponse autorisée est **celui du fournisseur**. Donc un 403 d'Oathrion et
 * un 403 que le fournisseur a lui-même rendu arrivent tous les deux en 403. Sans en-tête,
 * l'agent ne peut les distinguer qu'en analysant le corps ; avec, le premier porte `BLOCK`
 * et le second `ALLOW`, et la question est tranchée par une lecture d'en-tête.
 *
 * Le défaut a été trouvé en écrivant `npm run demo` : la démonstration attendait
 * `x-oathrion-decision: BLOCK` sur le refus, et ne le trouvait pas.
 */
describe("un refus porte ses en-têtes de gouvernance", () => {
  it("un BLOCK annonce sa décision, sa règle et son exécution", async () => {
    const res = await fetch(`${client.baseUrl}/api/v1/intercept/local-fixture/v1/chat-interdit`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "modele-interdit", stream: true }),
    });
    await res.text();

    expect(res.status).toBe(403);
    expect(res.headers.get("x-oathrion-decision")).toBe("BLOCK");
    expect(res.headers.get("x-oathrion-rule")).toBe("modele_interdit");
    /*
     * L'identifiant d'exécution est présent sur un refus : un BLOCK EST une exécution
     * enregistrée — c'est ce qui permet à un auditeur de retrouver la décision. L'absence
     * de cet en-tête signifierait que rien n'a été jugé, ce qui n'est pas le cas ici.
     */
    expect(res.headers.get("x-oathrion-execution-id")).toBeTruthy();
  });

  it("le credential n'est PAS annoncé sur un refus — rien n'est parti", async () => {
    /*
     * `x-oathrion-credential-injected` n'appartient qu'à la voie autorisée. Le poser sur un
     * refus, même à `false`, suggérerait qu'une requête a été préparée pour le
     * fournisseur. Rien n'a été préparé.
     */
    const res = await fetch(`${client.baseUrl}/api/v1/intercept/local-fixture/v1/chat-interdit`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "modele-interdit", stream: true }),
    });
    await res.text();
    expect(res.headers.get("x-oathrion-credential-injected")).toBeNull();
  });

  it("une voie AUTORISÉE porte les mêmes trois en-têtes, plus le credential", async () => {
    /*
     * Le contrôle symétrique : sans lui, un mutant qui poserait les en-têtes PARTOUT
     * passerait les deux tests ci-dessus sans rien prouver du refus en particulier.
     */
    const res = await fetch(`${client.baseUrl}/api/v1/intercept/local-fixture/v1/sentinelle`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "modele-ok" }),
    });
    await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("x-oathrion-decision")).toBe("ALLOW");
    expect(res.headers.get("x-oathrion-rule")).toBe("modele_sentinelle");
    expect(res.headers.get("x-oathrion-credential-injected")).toBe("true");
  });
});

/**
 * UNE API QUI RÉPOND 200 QUAND ELLE REFUSE — le reçu ne doit plus mentir.
 *
 * `npm run verify:slack` l'a montré contre le vrai service : Slack répond HTTP 200 à un
 * message qu'il rejette, avec `{"ok": false}`. Oathrion jugeait la réussite sur le statut
 * HTTP et enregistrait donc le message rejeté comme ENVOYÉ. Pour un produit dont le reçu
 * est la preuve, c'est le pire défaut possible : une trace qui affirme le contraire de ce
 * qui s'est passé.
 *
 * L'amont de ce fichier imite Slack : 200 dans les deux cas, et `ok` qui dit la vérité.
 */
describe("la réussite lue dans le corps, quand le statut HTTP ment", () => {
  async function call(model: string) {
    const res = await fetch(`${client.baseUrl}/api/v1/intercept/local-fixture/v1/facon-slack`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const text = await res.text();
    return { status: res.status, text, executionId: res.headers.get("x-oathrion-execution-id") ?? "" };
  }

  async function statusOf(executionId: string): Promise<string> {
    const executions = await client.get<Record<string, unknown>[]>("/api/executions", {
      auth: harness.ROLE_KEYS.admin,
    });
    const mine = executions.body.find((entry) => entry.id === executionId);
    return String(mine?.status ?? "");
  }

  it("un refus du fournisseur (200 + ok:false) est enregistré comme ÉCHOUÉ", async () => {
    const res = await call("modele-echec");
    /* L'agent reçoit la vraie réponse du fournisseur, inchangée. */
    expect(res.status).toBe(200);
    expect(res.text).toContain('"ok":false');
    /* Mais le REÇU dit la vérité : ce n'est pas une réussite. */
    expect(res.executionId).not.toBe("");
    expect(await statusOf(res.executionId)).toBe("failed");
  });

  it("une vraie réussite (200 + ok:true) est enregistrée comme réussie", async () => {
    /*
     * Le contrôle symétrique : sans lui, un relais qui marquerait TOUT en échec passerait
     * le test précédent sans rien prouver.
     */
    const res = await call("modele-ok");
    expect(res.status).toBe(200);
    expect(await statusOf(res.executionId)).toBe("allowed");
  });
});
