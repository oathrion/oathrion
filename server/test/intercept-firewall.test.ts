/**
 * LE PARE-FEU : une requête interceptée atteint-elle l'API, et quand ?
 *
 * ## Ce que ces tests emploient
 *
 * Une **vraie API cible** : un serveur HTTP démarré dans ce fichier, qui enregistre
 * chaque requête reçue — méthode, chemin, en-têtes, corps. Il n'importe rien d'Oathrion.
 * C'est ce qui permet de prouver un négatif qui compte : « la requête BLOQUÉE n'est
 * jamais arrivée », mesuré du côté de celui qui l'aurait reçue.
 *
 * Et tout le reste est réel : la passerelle, le moteur de politique, le catalogue
 * d'actions, le registre de destinations avec ses règles d'adresse.
 *
 * ## Le défaut que la règle d'extraction ferme
 *
 * Un agent qui déclarerait lui-même « refund de 75 USD » choisirait la règle qui le
 * gouverne : il suffirait d'annoncer 1 et d'envoyer un corps à 100 000. Le dernier bloc
 * de ce fichier l'essaie.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import type { ConnectorVault } from "../connectors/vault";
import { AgentGateway } from "../gateway/agent-gateway";
import { ToolRegistry } from "../gateway/tool-registry";
import { resolveDownstreamDestination } from "../gateway/tools/mcp-destination";
import {
  INTERCEPT_REF_KEY,
  INTERCEPT_TOOL_ID,
  InterceptTool,
  putPending,
  putResponse,
  resetPending,
  responseCount,
  takeResponse,
  type PendingForward,
} from "../intercept/forward";
import {
  extractAction,
  ExtractionError,
  DEFAULT_FORWARD_HEADERS,
  matchPath,
  matchRule,
  parseInterceptRules,
  pathMatches,
} from "../intercept/rules";
import { interceptRuleProblems } from "../intercept/rules-check";
import { securityPostureNotices } from "../config-check";
import { repositoriesFor, seedIfEmpty } from "../repositories";
import { DecisionService } from "../services/decision-service";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const ORG = "org_default" as OrganizationId;
const AGENT_ID = "agt_intercept_test";

/* ----------------------------- l'API cible ------------------------------ */

interface Received {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

let target: Server;
let targetUrl: string;
const received: Received[] = [];
/** La réponse que la cible rendra au prochain appel. */
let targetReply = { status: 200, body: '{"id":"re_1","status":"succeeded"}' };

beforeAll(async () => {
  target = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
        ),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(targetReply.status, { "Content-Type": "application/json", "X-Request-Id": "req_abc" });
      res.end(targetReply.body);
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetUrl = `http://127.0.0.1:${String((target.address() as AddressInfo).port)}/`;

  api = await startTestServer();
  await seedIfEmpty();
  const created = await api.post("/api/agents", AGENT_BODY, { auth: ROLE_KEYS.admin });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  for (const policy of [BLOCK_POLICY, APPROVAL_POLICY]) {
    const written = await api.post("/api/policies", policy, { auth: ROLE_KEYS.admin });
    expect(written.status, JSON.stringify(written.body)).toBeLessThan(300);
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

/* ------------------------------ la règle -------------------------------- */

/**
 * Elle lit le montant en CENTIMES et le divise par 100.
 *
 * C'est le cas le plus coûteux à se tromper : Stripe envoie `7500` pour 75 USD, et un
 * plafond écrit « 500 » par un exploitant veut dire 500 dollars. Sans `amountScale`, un
 * plafond de 500 laisserait passer 500 000 dollars.
 */
const RULE_JSON = [
  {
    id: "cible_refunds",
    destination: "local-fixture",
    method: "POST",
    path: "/v1/refunds",
    action: "refund",
    target: "body.charge",
    amount: "body.amount",
    currency: "body.currency",
    amountScale: 100,
  },
];

/*
 * UNE RÈGLE QUI LIT LA CIBLE DANS L'URL, dans sa propre constante.
 *
 * Sans la source `path.`, cette route n'était pas gouvernable du tout : la cible était
 * introuvable et Oathrion refusait en 422 — donc toute API REST qui met la ressource dans
 * le chemin restait dehors.
 *
 * Elle n'est PAS ajoutée à `RULE_JSON` : plusieurs tests y comptent les règles analysées,
 * et faire passer leur compte de 1 à 2 affaiblirait des assertions qui portent sur autre
 * chose. Le montant est déclaré parce qu'un remboursement sans montant est refusé par le
 * moteur — le mandat ne peut pas borner une action dont il ne connaît pas la taille, et
 * c'est la bonne réponse.
 */
const CAPTURE_RULE_JSON = [
  {
    id: "cible_capture",
    destination: "local-fixture",
    method: "POST",
    path: "/v1/charges/{charge}/capture",
    action: "refund",
    target: "path.charge",
    amount: "body.amount",
    currency: "body.currency",
    amountScale: 100,
  },
];

const AGENT_BODY = {
  id: AGENT_ID,
  name: "Agent intercepté",
  description: "Appelle une API derrière le proxy Oathrion.",
  provider: "openai",
  model: "gpt-4o",
  status: "active",
  owner: "finance",
  mandate: {
    maxTransactionAmount: 10_000,
    currency: "EUR" as const,
    allowedCategories: [],
    blockedCategories: [],
    allowedDomains: [],
  },
  permissions: [
    {
      scope: "execute:payments" as const,
      label: "Rembourser",
      description: "Émet un remboursement sous mandat.",
      granted: true,
      risk: "high" as const,
    },
  ],
  policyIds: [],
  tags: ["intercept"],
};

/**
 * La règle de blocage, écrite par l'API comme un exploitant le ferait.
 *
 * Une version précédente de ce fichier comptait sur `pol_block_sanctioned` du seed et a
 * rendu ALLOW : cette règle du seed gouverne `purchase`, pas `refund`. Le moteur avait
 * raison, et le test s'appuyait sur une coïncidence plutôt que sur une politique. Une
 * règle réelle vaut mieux qu'un test qui emprunte celle du voisin.
 */
const BLOCK_POLICY = {
  id: "pol_intercept_block",
  name: "Cette charge n'est jamais remboursable",
  description: "Les remboursements vers ch_interdit sont refusés outright.",
  type: "BLOCK_TOOL",
  condition: { kind: "targetMatches", targets: ["ch_interdit"] },
  scope: "organization",
  appliesTo: "all agents",
  effect: "block",
  status: "enabled",
  action: "BLOCK",
  risk: "critical",
  priority: 5,
};

/** Au-dessus de 500 EUR, un humain. La règle porte sur le montant EXTRAIT, en unités. */
const APPROVAL_POLICY = {
  id: "pol_intercept_ceiling",
  name: "Au-dessus de 500, un humain",
  description: "Tout remboursement intercepté au-dessus de 500 est retenu.",
  type: "MAX_TRANSACTION_AMOUNT",
  condition: { kind: "amountAtMost", max: 500, currency: "EUR" },
  scope: "organization",
  appliesTo: "all agents",
  effect: "require_approval",
  status: "enabled",
  action: "APPROVAL_REQUIRED",
  risk: "high",
  priority: 10,
};

let api: TestClient;
let gateway: AgentGateway;
let tool: InterceptTool;

/** Dépose une requête et la fait juger par la passerelle, comme la route le fait. */
async function throughFirewall(
  body: Record<string, unknown>,
  path = "/v1/refunds",
  ruleSet: unknown[] = RULE_JSON,
) {
  const rules = parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(ruleSet) } as NodeJS.ProcessEnv);
  const request = { method: "POST", path, query: {}, headers: { "content-type": "application/json" }, body };

  const rule = matchRule(rules, request);
  if (!rule) return { refused: "no_rule" as const };

  const extracted = extractAction(rule, request);
  const destination = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: targetUrl } as NodeJS.ProcessEnv);
  expect(destination).not.toBeNull();

  const ref = `ref_${String(received.length)}_${String(Math.random()).slice(2, 8)}`;
  const forward: PendingForward = {
    destination: destination!,
    destinationId: "local-fixture",
    request,
    credentialHeader: "authorization",
    credentialTemplate: "Bearer {secret}",
    forwardHeaders: ["content-type", "x-idempotency"],
  };
  putPending(ref, forward);

  const result = await gateway.execute({
    agentId: AGENT_ID,
    action: extracted.action,
    target: extracted.target,
    metadata: { ...extracted.metadata, [INTERCEPT_REF_KEY]: ref },
    actor: "test",
  });
  return { result, extracted, rule, ref };
}

beforeEach(() => {
  received.length = 0;
  targetReply = { status: 200, body: '{"id":"re_1","status":"succeeded"}' };
  resetPending();

  /*
   * Un coffre qui ne rend rien : le credential de ces tests vient de l'ENVIRONNEMENT
   * passé au relais, ce qui exerce le repli. Le chemin du coffre est éprouvé par
   * `connector-vault.test.ts`, et ce fichier-ci porte sur le pare-feu.
   */
  tool = new InterceptTool(
    { open: () => Promise.resolve(null) } as unknown as ConnectorVault,
    /*
     * Pas de sas : ce fichier n'exerce que la voie SYNCHRONE, où la requête est encore en
     * mémoire. La voie persistée — celle d'une approbation rendue plus tard, après un
     * redémarrage — est éprouvée par `intercept-approval-persistence.test.ts`, contre une
     * vraie base.
     */
    null,
    { OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE: "sk_test_du_coffre_jamais_de_lagent" } as NodeJS.ProcessEnv,
  );
  const base = new ToolRegistry([], {});
  const registry = base.extendedWith([tool], { refund: INTERCEPT_TOOL_ID });
  const repositories = repositoriesFor(ORG);
  gateway = new AgentGateway(new DecisionService(repositories), repositories, registry, "EUR", ORG);
});

/* ------------------------------- les règles ------------------------------ */

describe("la reconnaissance : deny by default", () => {
  it("un joker ne traverse pas un `/`", () => {
    /*
     * Si `*` traversait les `/`, une règle écrite pour LIRE une charge
     * (`/v1/charges/*`) couvrirait `/v1/charges/ch_1/refunds` — donc autoriserait à la
     * rembourser. C'est la faute la plus coûteuse qu'un motif de chemin puisse avoir.
     */
    expect(pathMatches("/v1/charges/*", "/v1/charges/ch_1")).toBe(true);
    expect(pathMatches("/v1/charges/*", "/v1/charges/ch_1/refunds")).toBe(false);
    expect(pathMatches("/v1/refunds", "/v1/refunds")).toBe(true);
    expect(pathMatches("/v1/refunds", "/v1/refunds/re_1")).toBe(false);
  });

  it("une route qu'aucune règle ne reconnaît n'est pas transmise", async () => {
    const outcome = await throughFirewall({ charge: "ch_1", amount: 100 }, "/v1/payouts");
    expect(outcome.refused).toBe("no_rule");
    expect(received).toHaveLength(0);
  });

  it("une méthode non déclarée n'est pas reconnue", () => {
    const rules = parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(RULE_JSON) } as NodeJS.ProcessEnv);
    expect(
      matchRule(rules, { method: "DELETE", path: "/v1/refunds", query: {}, headers: {}, body: null }),
    ).toBeNull();
  });
});

describe("la cible lue dans l'URL", () => {
  const rulesOf = () =>
    parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(CAPTURE_RULE_JSON) } as NodeJS.ProcessEnv);

  it("un segment nommé capture, et ne traverse pas un `/`", () => {
    expect(matchPath("/v1/charges/{charge}/capture", "/v1/charges/ch_1/capture")).toEqual({
      charge: "ch_1",
    });
    /* Même propriété que le joker : un segment nommé vaut UN segment. */
    expect(matchPath("/v1/charges/{charge}/capture", "/v1/charges/ch_1/x/capture")).toBeNull();
    expect(matchPath("/v1/charges/{charge}/capture", "/v1/charges//capture")).toBeNull();
  });

  it("LE SEGMENT EST DÉCODÉ AVANT D'ÊTRE JUGÉ — sinon un encodage contourne un refus", () => {
    /*
     * Le scénario, et c'est pour lui que le décodage existe : un agent qui connaît une
     * politique de refus sur `ch_interdit` appelle `/v1/charges/ch%5Finterdit/capture`.
     * Si Oathrion jugeait la chaîne encodée, il ne reconnaîtrait pas la cible refusée et
     * autoriserait — puis le fournisseur décoderait et agirait sur la charge interdite.
     */
    expect(matchPath("/v1/charges/{charge}/capture", "/v1/charges/ch%5Finterdit/capture")).toEqual({
      charge: "ch_interdit",
    });
  });

  it("un segment indécodable ne matche pas, donc rien n'est transmis", () => {
    /* Une cible dont on n'est pas sûr de la valeur n'est pas une cible. */
    expect(matchPath("/v1/charges/{charge}/capture", "/v1/charges/ch%zz/capture")).toBeNull();
    expect(
      matchRule(rulesOf(), {
        method: "POST",
        path: "/v1/charges/ch%zz/capture",
        query: {},
        headers: {},
        body: null,
      }),
    ).toBeNull();
  });

  it("l'extraction lit la cible dans le chemin", () => {
    const request = {
      method: "POST",
      path: "/v1/charges/ch_42/capture",
      query: {},
      headers: {},
      body: { amount: 1_200, currency: "EUR" },
    };
    const rule = matchRule(rulesOf(), request);
    expect(rule?.id).toBe("cible_capture");
    const extracted = extractAction(rule!, request);
    expect(extracted.target).toBe("ch_42");
    expect(extracted.action).toBe("refund");
    expect(extracted.metadata.amount).toBe(12);
  });

  it("et un CORPS VIDE suffit quand seule l'URL porte la cible", () => {
    /*
     * Le cas des routes sans corps : `POST /v1/charges/{charge}/capture` sans rien, ou un
     * `DELETE`. La cible vient du chemin, donc l'extraction aboutit — alors qu'avec une
     * source `body.` elle refuserait, et à juste titre.
     *
     * Le montant est absent ici, et le moteur refusera un remboursement dont il ne connaît
     * pas la taille : c'est la décision qui bloque, pas l'extraction. Les deux étapes
     * restent distinctes, et ce test porte sur la première.
     */
    const rules = parseInterceptRules({
      OATHRION_INTERCEPTS: JSON.stringify([
        {
          id: "capture_nue",
          destination: "local-fixture",
          method: "POST",
          path: "/v1/charges/{charge}/capture",
          action: "refund",
          target: "path.charge",
        },
      ]),
    } as NodeJS.ProcessEnv);
    const request = { method: "POST", path: "/v1/charges/ch_7/capture", query: {}, headers: {}, body: null };
    expect(extractAction(rules[0]!, request).target).toBe("ch_7");
  });

  it("JUGE LE DÉCODÉ, RELAIE L'ENCODÉ — deux rôles, deux valeurs", async () => {
    /*
     * La décision porte sur `ch_123`, et le fournisseur reçoit le chemin TEL QUEL. Décoder
     * ce qui part changerait la requête du client, ce qui n'est pas le rôle d'un pare-feu ;
     * décoder ce qu'on juge est la seule façon de juger la même chose que le fournisseur.
     */
    const outcome = await throughFirewall(
      { amount: 1_200, currency: "EUR" },
      "/v1/charges/ch%5F123/capture",
      CAPTURE_RULE_JSON,
    );
    expect(outcome.extracted?.target).toBe("ch_123");
    expect(outcome.result?.decision).toBe("ALLOW");
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("/v1/charges/ch%5F123/capture");
  });

  it("une source `path.x` sans segment `{x}` est refusée AU DÉMARRAGE", () => {
    /*
     * À l'exécution ce serait `undefined`, donc « cible absente », donc un 422 à chaque
     * appel : un refus correct au mauvais moment, avec un motif qui parle de la requête
     * alors que la faute est dans la configuration.
     */
    const problems = interceptRuleProblems({
      OATHRION_INTERCEPTS: JSON.stringify([
        { id: "mauvaise", destination: "local-fixture", method: "POST", path: "/v1/charges/{id}/capture", action: "refund", target: "path.charge" },
      ]),
    } as NodeJS.ProcessEnv);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("path.charge");
    expect(problems[0]).toContain("{charge}");
    /* Et le motif dit ce qui EST déclaré, pour que la correction soit évidente. */
    expect(problems[0]).toContain("{id}");
  });

  it("un segment nommé répété est refusé : `path.id` désignerait deux segments", () => {
    const problems = interceptRuleProblems({
      OATHRION_INTERCEPTS: JSON.stringify([
        { id: "double", destination: "local-fixture", method: "POST", path: "/v1/{id}/x/{id}", action: "refund", target: "path.id" },
      ]),
    } as NodeJS.ProcessEnv);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("twice");
  });

  it("un segment qui RESSEMBLE à un segment nommé est refusé, pas traité en littéral", () => {
    /*
     * `{charge}x` serait comparé littéralement et ne matcherait jamais : la règle serait
     * morte, et un exploitant croirait sa route gouvernée.
     */
    const problems = interceptRuleProblems({
      OATHRION_INTERCEPTS: JSON.stringify([
        { id: "presque", destination: "local-fixture", method: "POST", path: "/v1/{charge}x/capture", action: "refund", target: "body.charge" },
      ]),
    } as NodeJS.ProcessEnv);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like");
  });
});

describe("l'extraction : l'agent n'annonce rien", () => {
  it("le montant est lu dans le corps et converti par l'échelle déclarée", () => {
    const rules = parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(RULE_JSON) } as NodeJS.ProcessEnv);
    const extracted = extractAction(rules[0]!, {
      method: "POST",
      path: "/v1/refunds",
      query: {},
      headers: {},
      body: { charge: "ch_7", amount: 7500, currency: "usd" },
    });
    expect(extracted.action).toBe("refund");
    expect(extracted.target).toBe("ch_7");
    /* 7500 centimes → 75 unités. Sans cela, un plafond de 500 laisserait passer 500 000. */
    expect(extracted.metadata.amount).toBe(75);
    expect(extracted.metadata.currency).toBe("USD");
  });

  it("une cible absente arrête tout, au lieu de juger une action sans cible", () => {
    const rules = parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(RULE_JSON) } as NodeJS.ProcessEnv);
    expect(() =>
      extractAction(rules[0]!, {
        method: "POST",
        path: "/v1/refunds",
        query: {},
        headers: {},
        body: { amount: 100 },
      }),
    ).toThrow(ExtractionError);
  });

  it("un montant illisible arrête tout, au lieu d'être jugé comme absent", () => {
    /*
     * `undefined` passerait les plafonds : le moteur verrait une action sans montant,
     * donc sans plafond applicable. C'est le trou qu'un `?? 0` aurait ouvert.
     */
    const rules = parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(RULE_JSON) } as NodeJS.ProcessEnv);
    expect(() =>
      extractAction(rules[0]!, {
        method: "POST",
        path: "/v1/refunds",
        query: {},
        headers: {},
        body: { charge: "ch_1", amount: "beaucoup" },
      }),
    ).toThrow(/does not contain a number/);
  });
});

/* ------------------------------ les décisions ---------------------------- */

describe("ALLOW — la requête atteint l'API, exactement une fois", () => {
  it("elle arrive, avec la méthode, le chemin et le corps de l'agent", async () => {
    const outcome = await throughFirewall({ charge: "ch_alpha", amount: 4200, currency: "eur" });
    expect(outcome.result?.decision).toBe("ALLOW");
    expect(outcome.result?.succeeded).toBe(true);

    expect(received).toHaveLength(1);
    const [hit] = received;
    expect(hit!.method).toBe("POST");
    expect(hit!.url).toBe("/v1/refunds");
    expect(JSON.parse(hit!.body)).toEqual({ charge: "ch_alpha", amount: 4200, currency: "eur" });
  });

  it("le credential vient du COFFRE, et la clé Oathrion de l'agent ne part pas", async () => {
    /*
     * LE CONTRÔLE QUI REND LE CONTOURNEMENT IMPOSSIBLE PLUTÔT QUE DÉCONSEILLÉ. L'agent
     * ne détient pas la clé du fournisseur : c'est Oathrion qui l'injecte. Et sa propre clé
     * Oathrion ne doit pas fuiter vers un tiers — un `authorization` relayé tel quel
     * divulguerait le credential d'authentification d'Oathrion à l'API du client.
     */
    await throughFirewall({ charge: "ch_beta", amount: 1000, currency: "eur" });
    const [hit] = received;
    expect(hit!.headers.authorization).toBe("Bearer sk_test_du_coffre_jamais_de_lagent");
  });

  it("la réponse du fournisseur revient telle quelle, statut compris", async () => {
    targetReply = { status: 201, body: '{"id":"re_42"}' };
    const outcome = await throughFirewall({ charge: "ch_gamma", amount: 500, currency: "eur" });

    /*
     * Le STATUT est dans `toolResult` — c'est un fait de gouvernance qu'un auditeur doit
     * voir. Le CORPS n'y est plus : il voyage par la table en mémoire, parce que
     * `toolResult` est persisté. Ce test vérifiait d'abord `data.responseBody`, et c'est
     * exactement ce que la fuite rendait possible.
     */
    const data = (outcome.result?.toolResult ?? {}) as Record<string, unknown>;
    expect(data.status).toBe(201);
    expect(data.dispatched).toBe(true);
    expect(data.responseBytes).toBe('{"id":"re_42"}'.length);

    const forwarded = takeResponse(outcome.ref!);
    expect(forwarded?.status).toBe(201);
    expect(forwarded?.body).toBe('{"id":"re_42"}');
  });

  it("un refus MÉTIER du fournisseur n'est pas un succès", async () => {
    /*
     * 422 de l'API : l'appel a eu lieu, l'effet non. Le reçu doit porter l'échec, et
     * Oathrion ne doit pas réessayer. Rendre 200 à l'agent lui ferait croire son
     * remboursement passé.
     */
    targetReply = { status: 422, body: '{"error":"charge already refunded"}' };
    const outcome = await throughFirewall({ charge: "ch_delta", amount: 100, currency: "eur" });
    expect(outcome.result?.succeeded).toBe(false);
    const data = (outcome.result?.toolResult ?? {}) as Record<string, unknown>;
    expect(data.status).toBe(422);
    expect(data.dispatched).toBe(true);
    expect(received).toHaveLength(1);
  });
});

describe("BLOCK — l'API ne reçoit rien", () => {
  it("une politique de blocage arrête la requête avant le réseau", async () => {
    const outcome = await throughFirewall({ charge: "ch_interdit", amount: 100, currency: "eur" });
    expect(outcome.result?.decision).toBe("BLOCK");
    expect(outcome.result?.attempted).toBe(false);
    /* Mesuré du côté de celui qui l'aurait reçue : zéro requête. */
    expect(received).toHaveLength(0);
  });

  it("le refus est enregistré — un blocage est un événement", async () => {
    const outcome = await throughFirewall({ charge: "ch_interdit", amount: 100, currency: "eur" });
    /*
     * La décision est vérifiée ICI AUSSI, et pas seulement l'identifiant d'exécution :
     * un ALLOW en produit un également, donc la seule assertion sur `executionId` passait
     * pendant que la requête partait. C'est la faute que le test voisin a révélée.
     */
    expect(outcome.result?.decision).toBe("BLOCK");
    expect(outcome.result?.executionId).not.toBeNull();
    expect(received).toHaveLength(0);
  });
});

describe("APPROVAL_REQUIRED — rien ne part avant l'humain", () => {
  it("au-dessus du plafond, la requête est retenue et l'API ne voit rien", async () => {
    /* 60 000 centimes = 600 unités, au-dessus du plafond de 500. */
    const outcome = await throughFirewall({ charge: "ch_grand", amount: 60_000, currency: "eur" });
    expect(outcome.extracted?.metadata.amount).toBe(600);
    expect(outcome.result?.decision).toBe("APPROVAL_REQUIRED");
    expect(outcome.result?.approvalId).not.toBeNull();
    expect(received).toHaveLength(0);
  });

  it("l'approbation la relâche, et une seule fois", async () => {
    const outcome = await throughFirewall({ charge: "ch_grand2", amount: 60_000, currency: "eur" });
    const approvalId = outcome.result?.approvalId;
    expect(approvalId).not.toBeNull();
    expect(received).toHaveLength(0);

    const released = await gateway.resolveApproval(approvalId!, "approved", "approbateur");
    expect(released?.attempted).toBe(true);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body).charge).toBe("ch_grand2");

    /*
     * Approuver deux fois ne transmet pas deux fois. DEUX gardes l'empêchent, et c'est
     * voulu : l'exécution est revendiquée une fois, et la table des requêtes en attente
     * est à usage unique.
     */
    await gateway.resolveApproval(approvalId!, "approved", "approbateur").catch(() => undefined);
    expect(received).toHaveLength(1);
  });

  it("un rejet ne transmet jamais", async () => {
    const outcome = await throughFirewall({ charge: "ch_rejete", amount: 60_000, currency: "eur" });
    await gateway.resolveApproval(outcome.result!.approvalId!, "rejected", "approbateur");
    expect(received).toHaveLength(0);
  });
});

describe("l'agent ne choisit pas la règle qui le gouverne", () => {
  it("un montant annoncé dans les métadonnées ne remplace pas celui du corps", async () => {
    /*
     * LA TENTATIVE QUI DOIT ÉCHOUER. Un agent qui pourrait annoncer son propre montant
     * passerait tous les plafonds : `amount: 1` dans l'enveloppe, 100 000 dans le corps.
     *
     * Ici l'extraction ne lit que le CORPS. La valeur annoncée est écartée avant que le
     * moteur la voie, parce qu'elle n'entre jamais dans `extracted.metadata`.
     */
    const rules = parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(RULE_JSON) } as NodeJS.ProcessEnv);
    const extracted = extractAction(rules[0]!, {
      method: "POST",
      path: "/v1/refunds",
      query: {},
      /* L'agent « déclare » 1 dans un en-tête et dans la requête. */
      headers: { "x-amount": "1", "x-oathrion-amount": "1" },
      body: { charge: "ch_ruse", amount: 10_000_000, currency: "eur" },
    });
    expect(extracted.metadata.amount).toBe(100_000);

    /* Et la décision suit le corps : 100 000 est au-dessus du plafond. */
    const outcome = await throughFirewall({ charge: "ch_ruse", amount: 10_000_000, currency: "eur" });
    expect(outcome.result?.decision).not.toBe("ALLOW");
    expect(received).toHaveLength(0);
  });

  it("le relais refuse une exécution qui ne vient pas du proxy", async () => {
    /*
     * `POST /api/execute` peut nommer le verbe `refund` sans passer par le proxy : il
     * n'y a alors aucune requête à relayer. Le relais refuse, nommément, au lieu
     * d'inventer une requête.
     */
    const result = await gateway.execute({
      agentId: AGENT_ID,
      action: "refund",
      target: "ch_direct",
      metadata: { amount: 10, currency: "EUR" },
      actor: "test",
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.succeeded).toBe(false);
    expect((result.toolResult ?? {}).reason).toBe("no_intercepted_request");
    expect(received).toHaveLength(0);
  });

  it("une requête déjà relayée ne l'est pas deux fois", async () => {
    const destination = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: targetUrl } as NodeJS.ProcessEnv);
    const forward: PendingForward = {
      destination: destination!,
      destinationId: "local-fixture",
      request: { method: "POST", path: "/v1/refunds", query: {}, headers: {}, body: { charge: "c", amount: 1 } },
      credentialHeader: "authorization",
      credentialTemplate: "Bearer {secret}",
      forwardHeaders: ["content-type"],
    };
    putPending("ref_unique", forward);

    const once = await tool.execute({
      organizationId: ORG,
      executionId: "exe_1",
      agentId: AGENT_ID,
      agentName: "a",
      action: "refund",
      target: "c",
      metadata: { [INTERCEPT_REF_KEY]: "ref_unique" },
      currency: "EUR",
    });
    expect(once.data.dispatched).toBe(true);
    expect(received).toHaveLength(1);

    const twice = await tool.execute({
      organizationId: ORG,
      executionId: "exe_2",
      agentId: AGENT_ID,
      agentName: "a",
      action: "refund",
      target: "c",
      metadata: { [INTERCEPT_REF_KEY]: "ref_unique" },
      currency: "EUR",
    });
    expect(twice.data.reason).toBe("intercepted_request_gone");
    expect(received).toHaveLength(1);
  });
});

/* -------------------------- les refus de démarrage ----------------------- */

describe("une déclaration fautive arrête le démarrage, avec le motif", () => {
  const env = (rules: unknown) =>
    ({
      OATHRION_INTERCEPTS: JSON.stringify(rules),
      OATHRION_LOCAL_MCP_URL: "http://127.0.0.1:9/",
      OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
    }) as NodeJS.ProcessEnv;

  it("un verbe hors catalogue", () => {
    const problems = interceptRuleProblems(env([{ ...RULE_JSON[0], action: "vide_le_compte" }]));
    expect(problems.join("\n")).toMatch(/missing from shared\/policy\/actions\.ts/);
  });

  it("une destination non enregistrée", () => {
    const problems = interceptRuleProblems(env([{ ...RULE_JSON[0], destination: "pas-la" }]));
    expect(problems.join("\n")).toMatch(/is not registered/);
  });

  it("une règle rendue inatteignable par une plus générale déclarée avant", () => {
    /*
     * Une règle morte sur un pare-feu est une règle dont l'auteur croit qu'elle protège
     * quelque chose. `/v1/*` déclaré avant `/v1/refunds` rend le second inutile.
     */
    const problems = interceptRuleProblems(
      env([
        { ...RULE_JSON[0], id: "fourre_tout", path: "/v1/*" },
        { ...RULE_JSON[0], id: "specifique", path: "/v1/refunds" },
      ]),
    );
    expect(problems.join("\n")).toMatch(/is unreachable/);
    expect(problems.join("\n")).toMatch(/fourre_tout/);
  });

  it("une échelle de montant sans montant", () => {
    const bad: Record<string, unknown> = { ...RULE_JSON[0] };
    delete bad.amount;
    const problems = interceptRuleProblems(env([bad]));
    expect(problems.join("\n")).toMatch(/amountScale.*without.*amount|converts nothing/);
  });

  it("une déclaration cohérente ne produit aucun problème", () => {
    expect(interceptRuleProblems(env(RULE_JSON))).toEqual([]);
  });

  it("une source d'extraction inventée est refusée à la lecture", () => {
    expect(() =>
      parseInterceptRules({
        OATHRION_INTERCEPTS: JSON.stringify([{ ...RULE_JSON[0], target: "agent.claimed_target" }]),
      } as NodeJS.ProcessEnv),
    ).toThrow(/is not a request source/);
  });
});

/* ----------------------------- la discrétion ----------------------------- */

describe("ce qui ne doit pas finir dans la trace", () => {
  it("le corps de la requête n'entre pas dans les métadonnées de l'exécution", async () => {
    /*
     * Un corps d'API financière porte des noms, des adresses, parfois un numéro de
     * carte. Le mettre dans `metadata` le mettrait dans la table que ce produit promet
     * de pouvoir montrer à un auditeur. Seuls les champs EXTRAITS y entrent — ceux que
     * la décision a pesés.
     */
    const outcome = await throughFirewall({
      charge: "ch_prive",
      amount: 100,
      currency: "eur",
      customer_email: "client@exemple.test",
      card_last4: "4242",
    });
    const serialised = JSON.stringify(outcome.extracted?.metadata ?? {});
    expect(serialised).not.toContain("client@exemple.test");
    expect(serialised).not.toContain("4242");
    /* Ce qui y est : ce sur quoi la politique a statué. */
    expect(outcome.extracted?.metadata).toEqual({ amount: 1, currency: "EUR" });
  });

  it("le credential du fournisseur n'apparaît pas dans le résultat rendu", async () => {
    const outcome = await throughFirewall({ charge: "ch_secret", amount: 100, currency: "eur" });
    expect(JSON.stringify(outcome.result?.toolResult ?? {})).not.toContain("sk_test_du_coffre");
  });
});

/* ------------------- LA FUITE QUE LE CHEMIN toolResult OUVRAIT ------------------- */

describe("la réponse du FOURNISSEUR ne doit pas être persistée", () => {
  /*
   * ## Le défaut, et comment il est arrivé
   *
   * `InterceptTool.run()` rend un `ToolResult`, et `AgentGateway` écrit `result.data`
   * dans la colonne `toolResult` de l'exécution — donc en base. Le relais y plaçait
   * `responseBody` et `responseHeaders`, c'est-à-dire **la réponse complète du
   * fournisseur**. Pour un remboursement Stripe, c'est l'objet client : adresse e-mail,
   * nom, quatre derniers chiffres de la carte.
   *
   * Le test voisin (« le corps de la requête n'entre pas dans les métadonnées ») ne
   * l'attrapait pas : il vérifiait la REQUÊTE, et la fuite était dans la RÉPONSE. Deux
   * directions, un seul contrôle.
   *
   * ## Ce qui est vérifié ici
   *
   * Ce que le relais rend dans `data` — donc ce qui sera écrit — ne contient ni le corps
   * ni les en-têtes de la réponse. Le statut, lui, y reste : c'est un fait de
   * gouvernance, pas une donnée métier, et sans lui un auditeur ne saurait pas si
   * l'action a réussi.
   */
  it("`data` ne porte ni le corps ni les en-têtes de la réponse", async () => {
    targetReply = {
      status: 200,
      body: JSON.stringify({
        id: "re_1",
        customer: { email: "client-prive@exemple.test", name: "Jean Dupont" },
        source: { last4: "4242" },
      }),
    };

    const outcome = await throughFirewall({ charge: "ch_fuite", amount: 100, currency: "eur" });
    const data = (outcome.result?.toolResult ?? {}) as Record<string, unknown>;
    const serialised = JSON.stringify(data);

    expect(serialised).not.toContain("client-prive@exemple.test");
    expect(serialised).not.toContain("Jean Dupont");
    expect(serialised).not.toContain("4242");
    expect(data.responseBody).toBeUndefined();
    expect(data.responseHeaders).toBeUndefined();
  });

  it("… mais elle porte ce qu'un auditeur doit savoir", async () => {
    /*
     * La contrepartie du retrait. Vider `data` protégerait les données et rendrait
     * l'audit inutile : « une action a été relayée » sans savoir vers où ni avec quel
     * résultat ne permet pas de reconstituer le parcours d'une action.
     */
    const outcome = await throughFirewall({ charge: "ch_audit", amount: 100, currency: "eur" });
    const data = (outcome.result?.toolResult ?? {}) as Record<string, unknown>;
    expect(data.dispatched).toBe(true);
    expect(data.status).toBe(200);
    expect(data.destination).toBe("local-fixture");
    expect(data.method).toBe("POST");
    expect(data.path).toBe("/v1/refunds");
    expect(data.credentialInjected).toBe(true);
  });

  it("la réponse reste disponible pour l'appelant, par un canal qui n'est pas persisté", async () => {
    /*
     * Retirer la réponse de `data` ne doit pas la faire disparaître : l'agent attend le
     * corps que le fournisseur a renvoyé. Elle passe donc par une table en mémoire, à
     * usage unique, que la route reprend — le même motif que la requête entrante, et pour
     * la même raison.
     */
    targetReply = { status: 201, body: '{"id":"re_canal"}' };
    const rules = parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(RULE_JSON) } as NodeJS.ProcessEnv);
    const destination = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: targetUrl } as NodeJS.ProcessEnv);
    const ref = "ref_canal";
    putPending(ref, {
      destination: destination!,
      destinationId: "local-fixture",
      request: {
        method: "POST",
        path: "/v1/refunds",
        query: {},
        headers: {},
        body: { charge: "ch_canal", amount: 100, currency: "eur" },
      },
      credentialHeader: "authorization",
      credentialTemplate: "Bearer {secret}",
      forwardHeaders: ["content-type"],
    });
    expect(rules).toHaveLength(1);

    await tool.execute({
      organizationId: ORG,
      executionId: "exe_canal",
      agentId: AGENT_ID,
      agentName: "a",
      action: "refund",
      target: "ch_canal",
      metadata: { [INTERCEPT_REF_KEY]: ref },
      currency: "EUR",
    });

    const response = takeResponse(ref);
    expect(response?.status).toBe(201);
    expect(response?.body).toBe('{"id":"re_canal"}');
    /* À usage unique : une seconde reprise ne rend rien. */
    expect(takeResponse(ref)).toBeNull();
  });
});

/* ============ LES DEUX TROUS QU'UNE REVUE HOSTILE AURAIT TROUVÉS ============ */

describe("les en-têtes sont une liste d'AUTORISATION, pas de refus", () => {
  /*
   * ## Le trou, et il n'était pas théorique
   *
   * Le relais appliquait une liste de REFUS : douze noms interdits, tout le reste
   * transmis. Sur Stripe Connect, `Stripe-Account: acct_autre` fait agir l'appel **sur un
   * autre compte**. La règle inspecte `body.charge` et le plafond ; ni l'un ni l'autre ne
   * voit le changement de compte.
   *
   * Un agent compromis par injection de prompt remboursait donc sur le compte d'un tiers,
   * dans les limites du plafond, et l'audit enregistrait une action parfaitement conforme.
   * La règle « le verbe ne vient pas de l'agent » était contournée par le canal d'à côté.
   */
  it("un en-tête que la règle n'autorise pas n'est PAS relayé", async () => {
    const rules = parseInterceptRules({ OATHRION_INTERCEPTS: JSON.stringify(RULE_JSON) } as NodeJS.ProcessEnv);
    const destination = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: targetUrl } as NodeJS.ProcessEnv);
    putPending("ref-entetes", {
      destination: destination!,
      destinationId: "local-fixture",
      request: {
        method: "POST",
        path: "/v1/refunds",
        query: {},
        headers: {
          "content-type": "application/json",
          /* LA TENTATIVE D'ÉLÉVATION : agir sur un autre compte Stripe. */
          "stripe-account": "acct_quelquun_dautre",
          "stripe-version": "2019-01-01",
          "idempotency-key": "choisie-par-lagent",
        },
        body: { charge: "ch_1", amount: 100, currency: "eur" },
        rawBody: '{"charge":"ch_1","amount":100,"currency":"eur"}',
      },
      credentialHeader: "authorization",
      credentialTemplate: "Bearer {secret}",
      /* La règle n'autorise que `content-type`. */
      forwardHeaders: ["content-type"],
    });
    expect(rules).toHaveLength(1);

    await tool.execute({
      organizationId: ORG,
      executionId: "exe_entetes",
      agentId: AGENT_ID,
      agentName: "a",
      action: "refund",
      target: "ch_1",
      metadata: { [INTERCEPT_REF_KEY]: "ref-entetes" },
      currency: "EUR",
    });

    const hit = received[received.length - 1];
    expect(hit).toBeDefined();
    /* Les trois tentatives d'élévation sont tombées. */
    expect(hit!.headers["stripe-account"]).toBeUndefined();
    expect(hit!.headers["stripe-version"]).toBeUndefined();
    expect(hit!.headers["idempotency-key"]).toBeUndefined();
    /* Et ce que la règle autorise est bien passé. */
    expect(hit!.headers["content-type"]).toBe("application/json");
  });

  it("une règle PEUT autoriser un en-tête, explicitement", async () => {
    /*
     * La contrepartie du refus : un exploitant qui a besoin de `stripe-version` doit
     * pouvoir le nommer. Une allowlist qui n'autorise rien serait un refus déguisé en
     * configuration.
     */
    const destination = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: targetUrl } as NodeJS.ProcessEnv);
    putPending("ref-permis", {
      destination: destination!,
      destinationId: "local-fixture",
      request: {
        method: "POST",
        path: "/v1/refunds",
        query: {},
        headers: { "content-type": "application/json", "stripe-version": "2024-06-20" },
        body: { charge: "ch_1" },
        rawBody: '{"charge":"ch_1"}',
      },
      credentialHeader: "authorization",
      credentialTemplate: "Bearer {secret}",
      forwardHeaders: ["content-type", "stripe-version"],
    });

    await tool.execute({
      organizationId: ORG,
      executionId: "exe_permis",
      agentId: AGENT_ID,
      agentName: "a",
      action: "refund",
      target: "ch_1",
      metadata: { [INTERCEPT_REF_KEY]: "ref-permis" },
      currency: "EUR",
    });

    expect(received[received.length - 1]!.headers["stripe-version"]).toBe("2024-06-20");
  });

  it("`authorization` ne peut JAMAIS être autorisé, même en le nommant", () => {
    /*
     * Le plancher que même une règle ne descend pas : c'est la clé Oathrion de l'agent, et
     * la relayer la divulguerait au fournisseur. Refusé au DÉMARRAGE plutôt que filtré en
     * silence — un exploitant qui l'écrit croit avoir autorisé quelque chose.
     */
    for (const forbidden of ["authorization", "Authorization", "cookie", "accept-encoding", "host"]) {
      expect(() =>
        parseInterceptRules({
          OATHRION_INTERCEPTS: JSON.stringify([{ ...RULE_JSON[0], forwardHeaders: ["content-type", forbidden] }]),
        } as NodeJS.ProcessEnv),
      ).toThrow(/can never be relayed/);
    }
  });

  it("le défaut est court : content-type et accept, rien d'autre", () => {
    expect([...DEFAULT_FORWARD_HEADERS]).toEqual(["content-type", "accept"]);
    /*
     * `accept-encoding` en est absent pour une raison mécanique et non par prudence :
     * `sendGuarded` ne décompresse pas, donc un `gzip` demandé par l'agent reviendrait
     * comme des octets abîmés lus en UTF-8 — une réponse corrompue rendue comme valide.
     */
    expect([...DEFAULT_FORWARD_HEADERS]).not.toContain("accept-encoding");
  });
});

describe("le corps part BRUT — une API form-encoded fonctionne", () => {
  /*
   * ## Le trou qui rendait l'exemple vedette de la documentation inutilisable
   *
   * Le relais re-sérialisait l'objet parsé en JSON, puis conservait le `content-type` de
   * l'agent. L'API de Stripe parle `application/x-www-form-urlencoded` : Oathrion envoyait
   * donc un corps JSON sous un en-tête `form`, que Stripe refuse. `docs/firewall.md`
   * montrait un client Stripe pointé sur le proxy — et cela ne pouvait pas marcher.
   */
  it("un corps form-encoded arrive octet pour octet", async () => {
    const destination = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: targetUrl } as NodeJS.ProcessEnv);
    const raw = "charge=ch_form&amount=7500&currency=eur&metadata%5Border%5D=A-12";
    putPending("ref-form", {
      destination: destination!,
      destinationId: "local-fixture",
      request: {
        method: "POST",
        path: "/v1/refunds",
        query: {},
        headers: { "content-type": "application/x-www-form-urlencoded" },
        /* Le parsé sert à EXTRAIRE ; le brut est ce qui part. */
        body: { charge: "ch_form", amount: "7500", currency: "eur" },
        rawBody: raw,
      },
      credentialHeader: "authorization",
      credentialTemplate: "Bearer {secret}",
      forwardHeaders: ["content-type"],
    });

    await tool.execute({
      organizationId: ORG,
      executionId: "exe_form",
      agentId: AGENT_ID,
      agentName: "a",
      action: "refund",
      target: "ch_form",
      metadata: { [INTERCEPT_REF_KEY]: "ref-form" },
      currency: "EUR",
    });

    const hit = received[received.length - 1];
    /* OCTET POUR OCTET — pas du JSON, pas une clé réordonnée, pas un `metadata[order]` mangé. */
    expect(hit!.body).toBe(raw);
    expect(hit!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("un corps JSON aussi, sans réécriture", async () => {
    /*
     * Une re-sérialisation réordonne les clés et peut perdre de la précision numérique.
     * Le fournisseur doit recevoir ce que l'agent a envoyé, pas une version équivalente.
     */
    const destination = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: targetUrl } as NodeJS.ProcessEnv);
    const raw = '{"currency":"eur","charge":"ch_ordre","amount":100,"big":10000000000000001}';
    putPending("ref-json", {
      destination: destination!,
      destinationId: "local-fixture",
      request: {
        method: "POST",
        path: "/v1/refunds",
        query: {},
        headers: { "content-type": "application/json" },
        body: { charge: "ch_ordre", amount: 100, currency: "eur" },
        rawBody: raw,
      },
      credentialHeader: "authorization",
      credentialTemplate: "Bearer {secret}",
      forwardHeaders: ["content-type"],
    });

    await tool.execute({
      organizationId: ORG,
      executionId: "exe_json",
      agentId: AGENT_ID,
      agentName: "a",
      action: "refund",
      target: "ch_ordre",
      metadata: { [INTERCEPT_REF_KEY]: "ref-json" },
      currency: "EUR",
    });

    expect(received[received.length - 1]!.body).toBe(raw);
  });
});

describe("la table des réponses est bornée", () => {
  it("elle n'accumule pas sans limite quand personne ne lit", () => {
    /*
     * Une entrée n'est reprise que si l'appelant lit la réponse. Un client qui coupe la
     * connexion laissait la sienne jusqu'au balayage par l'âge : avec du débit et des
     * réponses volumineuses, rien ne bornait la mémoire dans la fenêtre d'une minute. Un
     * attaquant qui le sait fait tomber le processus — donc arrête TOUS les agents
     * gouvernés, la pire issue disponible pour un plan de contrôle.
     */
    resetPending();
    for (let i = 0; i < 2_500; i += 1) {
      putResponse(`ref-${String(i)}`, { status: 200, headers: {}, body: "x".repeat(1_000) });
    }
    /* Plafonnée, et la plus ancienne est évincée : perdre une réponse ne perd aucun effet. */
    expect(responseCount()).toBeLessThanOrEqual(2_000);
    /* La dernière est toujours là — c'est celle dont un appelant attend la réponse. */
    expect(takeResponse("ref-2499")?.status).toBe(200);
  });
});

describe("l'avis sur `amountScale` oublié", () => {
  it("un montant sans échelle produit un avis au démarrage", () => {
    /*
     * Oathrion ne PEUT PAS détecter la faute : il ne sait pas en quoi compte l'API d'en
     * face. Donc pas un refus de démarrage, qui bloquerait les intégrations légitimes —
     * un avis, affiché à côté des autres postures de sécurité.
     *
     * Sans lui, un plafond de 500 laissant passer 500 000 reste silencieux, permissif, et
     * invisible dans l'audit : celui-ci affiche « 500 — autorisé ».
     */
    const sansEchelle: Record<string, unknown> = { ...RULE_JSON[0] };
    delete sansEchelle.amountScale;
    const notices = securityPostureNotices({
      OATHRION_INTERCEPTS: JSON.stringify([sansEchelle]),
    } as NodeJS.ProcessEnv);
    expect(notices.join("\n")).toMatch(/amountScale/);
    expect(notices.join("\n")).toMatch(/factor of 100/);
    expect(notices.join("\n")).toMatch(/PERMISSIVE/);
  });

  it("… et une règle avec échelle n'en produit aucun", () => {
    const notices = securityPostureNotices({
      OATHRION_INTERCEPTS: JSON.stringify(RULE_JSON),
    } as NodeJS.ProcessEnv);
    expect(notices.filter((n) => n.includes("amountScale"))).toEqual([]);
  });

  it("une règle sans montant du tout n'en produit aucun", () => {
    /* Pas de montant, pas de plafond à fausser. */
    const sansMontant: Record<string, unknown> = { ...RULE_JSON[0] };
    delete sansMontant.amount;
    delete sansMontant.amountScale;
    const notices = securityPostureNotices({
      OATHRION_INTERCEPTS: JSON.stringify([sansMontant]),
    } as NodeJS.ProcessEnv);
    expect(notices.filter((n) => n.includes("amountScale"))).toEqual([]);
  });
});
