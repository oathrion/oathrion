/**
 * LE CLIC SLACK : le seul point d'entrée d'Oathrion sans credential Oathrion.
 *
 * ## Ce que ce fichier protège
 *
 * Toutes les autres routes sont authentifiées par une clé d'agent ou une session. Celle-ci
 * ne peut pas l'être : c'est Slack qui appelle, et Slack ne connaît aucun credential de
 * Oathrion. Si l'un des quatre contrôles cède, **n'importe qui sur Internet peut approuver
 * n'importe quelle action d'agent** — un contournement total du plan de contrôle, par la
 * porte qui sert à le faire respecter.
 *
 * Chaque test ci-dessous mesure donc DEUX choses : la réponse rendue, et l'état réel de
 * l'approbation après coup. La seconde est la seule qui compte — une route peut répondre
 * « refusé » et avoir résolu l'approbation.
 *
 * ## Les quatre contrôles
 *
 *   1. la signature HMAC de l'application Slack, sur le corps BRUT ;
 *   2. la fraîcheur de l'horodatage — sinon une requête signée capturée reste rejouable ;
 *   3. la correspondance nominative : une signature valide prouve que l'application est
 *      la nôtre, pas que la personne a le droit d'approuver ;
 *   4. la capacité `approve` du rôle de cette personne — la liste Slack donne une
 *      identité, pas un droit.
 */

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ROLE_KEYS,
  TEST_CONSOLE_EMAIL,
  TEST_VIEWER_EMAIL,
  startTestServer,
  type TestClient,
} from "./harness";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const SLACK_ADMIN = "U_ADMIN_PLACET";
const SLACK_VIEWER = "U_VIEWER_PLACET";
const SLACK_INCONNU = "U_PERSONNE";
const AGENT_ID = "agt_slack_test";

let client: TestClient;
let fixture: Server;
const saved: Record<string, string | undefined> = {};

interface Approval {
  id: string;
  status: string;
  resolvedBy?: string;
}

beforeAll(async () => {
  /*
   * Une destination enregistrée : sans `OATHRION_LOCAL_MCP_URL`, toute autorisation est
   * BLOQUÉE pour « destination non enregistrée » — un refus correct qui testerait la
   * mauvaise chose. Le serveur n'est jamais appelé : `stripe.refund` est servi par un
   * outil simulé, et ce fichier porte sur l'approbation, pas sur le relais.
   */
  fixture = createServer((_req, res) => res.end("{}"));
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const { port } = fixture.address() as AddressInfo;

  for (const name of [
    "OATHRION_SLACK_SIGNING_SECRET",
    "OATHRION_SLACK_APPROVERS",
    "OATHRION_LOCAL_MCP_URL",
    "OATHRION_LOCAL_MCP_ORGANIZATIONS",
  ]) {
    saved[name] = process.env[name];
  }
  process.env.OATHRION_LOCAL_MCP_URL = `http://127.0.0.1:${String(port)}/`;
  process.env.OATHRION_LOCAL_MCP_ORGANIZATIONS = "*";
  process.env.OATHRION_SLACK_SIGNING_SECRET = SIGNING_SECRET;
  process.env.OATHRION_SLACK_APPROVERS = [
    `${SLACK_ADMIN}:${TEST_CONSOLE_EMAIL}`,
    `${SLACK_VIEWER}:${TEST_VIEWER_EMAIL}`,
  ].join(",");

  client = await startTestServer();

  await client.post(
    "/api/agents",
    {
      id: AGENT_ID,
      name: "Agent Slack",
      description: "Pour éprouver l'approbation depuis Slack.",
      provider: "openai",
      model: "gpt-4o",
      status: "active",
      owner: "ops",
      mandate: {
        maxTransactionAmount: 10_000,
        currency: "EUR",
        allowedCategories: [],
        blockedCategories: [],
        allowedDomains: [],
      },
      permissions: [
        { scope: "execute:payments", label: "Rembourser", description: "Sous mandat.", granted: true, risk: "high" },
      ],
      policyIds: [],
      tags: [],
    },
    { auth: ROLE_KEYS.admin },
  );

  /*
   * LE CATALOGUE D'ACTIONS D'ABORD. Le plan d'autorité refuse par défaut : « No active
   * rule authorizes "stripe.refund" on destination "local-fixture" ». Il faut donc
   * déclarer que ce verbe est autorisé sur cette destination AVANT que la politique de
   * gouvernance puisse le retenir — les deux plans sont distincts, et c'est voulu : le
   * premier dit ce qui est permis, le second à quelles conditions.
   */
  await client.put(
    "/api/action-policies",
    {
      id: "apol_slack",
      name: "Remboursements, sous conditions",
      action: "stripe.refund",
      destinationId: "local-fixture",
      /*
       * `APPROVAL_REQUIRED` directement sur la règle d'autorité : c'est ce plan-là que
       * `/api/v1/actions/authorize` consulte, et c'est lui qui fabrique l'approbation.
       * Le plan de gouvernance (`/api/policies`) gouverne l'autre voie, celle du
       * pare-feu — deux plans distincts, et les confondre faisait autoriser ici ce qu'on
       * voulait retenir.
       */
      effect: "APPROVAL_REQUIRED",
      constraints: [{ field: "amount", op: "lte", value: 1_000 }],
      priority: 100,
    },
    { auth: ROLE_KEYS.admin },
  );

  /* Une politique qui RETIENT : c'est elle qui fabrique les approbations à cliquer. */
  await client.post(
    "/api/policies",
    {
      id: "pol_slack_hold",
      name: "Au-dessus de 10, un humain",
      description: "Retenu pour approbation.",
      type: "MAX_TRANSACTION_AMOUNT",
      /*
       * `actions` RESTREINT LE PLAFOND AUX VERBES QUI PORTENT UN MONTANT, et c'est la
       * bonne façon de poser un plafond : sans cette liste, il s'appliquerait à tout
       * verbe, y compris ceux qui ne déclarent aucun montant — que le moteur refuse alors,
       * à juste titre, faute de pouvoir les borner.
       */
      condition: { kind: "amountAtMost", max: 10, currency: "EUR", actions: ["stripe.refund", "refund"] },
      scope: "organization",
      appliesTo: "all agents",
      effect: "require_approval",
      status: "enabled",
      action: "APPROVAL_REQUIRED",
      risk: "high",
      priority: 10,
    },
    { auth: ROLE_KEYS.admin },
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
  await new Promise<void>((r) => fixture.close(() => r()));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * Une approbation en attente, fraîche, pour chaque test.
 *
 * Par `/api/execute`, c'est-à-dire LE PLAN DE GOUVERNANCE — celui dont les approbations
 * sont listées par `/api/approvals` et résolues par `gateway.resolveApproval`, donc par la
 * route de console ET par le clic Slack.
 *
 * Le plan d'AUTORITÉ (`/api/v1/actions/authorize` et ses règles d'action) tient ses
 * propres approbations, dans une autre table. Les deux coexistent et ne se mélangent pas :
 * une première version de ce fichier créait une approbation d'autorité et cherchait
 * ensuite à la résoudre par Slack, qui ne la trouvait pas — un test qui aurait pu passer
 * pour un défaut du canal Slack.
 */
async function pendingApproval(): Promise<string> {
  const res = await client.post<{ approvalId?: string; decision?: string }>(
    "/api/execute",
    {
      agentId: "agt_procurement",
      action: "purchase",
      /* Le domaine doit être dans l'allowlist du mandat de cet agent : c'est `supplier-x.com`
       * chez l'agent de départ, et un autre domaine est BLOQUÉ par le mandat avant
       * qu'aucune politique ne parle. */
      target: "supplier-x.com",
      metadata: { amount: 12_000, category: "Equipment" },
    },
    { auth: ROLE_KEYS.operator },
  );
  const id = String(res.body.approvalId ?? "");
  expect(id).not.toBe("");
  return id;
}

async function statusOf(approvalId: string): Promise<Approval | undefined> {
  const res = await client.get<Approval[]>("/api/approvals", { auth: ROLE_KEYS.admin });
  return res.body.find((entry) => entry.id === approvalId);
}

/** Le corps form-encoded que Slack envoie, et sa signature. */
function slackRequest(params: {
  approvalId: string;
  slackUserId: string;
  actionId?: string;
  blockId?: string;
  secret?: string;
  timestampSeconds?: number;
}): { body: string; headers: Record<string, string> } {
  const payload = {
    type: "block_actions",
    user: { id: params.slackUserId, name: "quelqu'un" },
    actions: [
      {
        action_id: params.actionId ?? "placet_approve",
        value: params.approvalId,
        block_id: params.blockId ?? `placet_approval:${params.approvalId}`,
      },
    ],
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(params.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", params.secret ?? SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`, "utf8")
    .digest("hex")}`;
  return {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
  };
}

async function postToSlackRoute(body: string, headers: Record<string, string>) {
  const res = await fetch(`${client.baseUrl}/api/slack/interactions`, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
}

let approvalId = "";
beforeEach(async () => {
  approvalId = await pendingApproval();
});

describe("sans signature valide, RIEN n'est résolu", () => {
  it("aucune signature du tout", async () => {
    const { body } = slackRequest({ approvalId, slackUserId: SLACK_ADMIN });
    const res = await postToSlackRoute(body, { "content-type": "application/x-www-form-urlencoded" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("did not take this click into account");
    /* LA seule assertion qui compte : l'approbation est intacte. */
    expect((await statusOf(approvalId))?.status).toBe("pending");
  });

  it("une signature calculée avec un AUTRE secret", async () => {
    const { body, headers } = slackRequest({
      approvalId,
      slackUserId: SLACK_ADMIN,
      secret: "le-mauvais-secret-de-signature-aaaa",
    });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect((await statusOf(approvalId))?.status).toBe("pending");
  });

  it("une signature valide pour un AUTRE corps — le rejeu ne marche pas", async () => {
    /*
     * La signature porte sur le corps BRUT. On signe un corps, on en envoie un autre :
     * c'est exactement ce qu'un attaquant tente après avoir capturé une requête légitime.
     */
    const legitimate = slackRequest({ approvalId, slackUserId: SLACK_ADMIN });
    const other = await pendingApproval();
    const tampered = `payload=${encodeURIComponent(
      JSON.stringify({
        type: "block_actions",
        user: { id: SLACK_ADMIN },
        actions: [{ action_id: "placet_approve", value: other, block_id: `placet_approval:${other}` }],
      }),
    )}`;

    const res = await postToSlackRoute(tampered, legitimate.headers);
    expect(res.status).toBe(200);
    expect((await statusOf(other))?.status).toBe("pending");
  });

  it("UN HORODATAGE VIEUX DE PLUS DE CINQ MINUTES — la protection anti-rejeu", async () => {
    /*
     * Sans ce contrôle, une requête signée capturée une fois — dans un journal de proxy,
     * dans un outil de capture — resterait valable pour toujours. Et rejouer une
     * approbation relâche une action autant de fois qu'on veut.
     */
    const { body, headers } = slackRequest({
      approvalId,
      slackUserId: SLACK_ADMIN,
      timestampSeconds: Math.floor(Date.now() / 1000) - 600,
    });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect((await statusOf(approvalId))?.status).toBe("pending");
  });

  it("un horodatage dans le FUTUR est tout aussi suspect", async () => {
    /*
     * N'en vérifier qu'un côté laisserait fabriquer un horodatage lointain et obtenir une
     * requête valable pendant des années.
     */
    const { body, headers } = slackRequest({
      approvalId,
      slackUserId: SLACK_ADMIN,
      timestampSeconds: Math.floor(Date.now() / 1000) + 3_600,
    });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect((await statusOf(approvalId))?.status).toBe("pending");
  });
});

describe("une signature valide ne suffit PAS", () => {
  it("un utilisateur Slack non déclaré est refusé", async () => {
    /*
     * LE REFUS QUI COMPTE LE PLUS. La signature prouve que l'appel vient de notre
     * application Slack ; elle ne dit rien de la personne. Un espace de travail Slack
     * contient toute l'entreprise, stagiaires et prestataires compris.
     */
    const { body, headers } = slackRequest({ approvalId, slackUserId: SLACK_INCONNU });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect(res.text).toContain("did not take this click into account");
    expect((await statusOf(approvalId))?.status).toBe("pending");
  });

  it("UN APPROBATEUR DÉCLARÉ MAIS SANS LA CAPACITÉ `approve` est refusé", async () => {
    /*
     * `viewer@placet.test` est bien dans la liste Slack, et son rôle n'a pas la capacité.
     * Sans ce contrôle, écrire un identifiant Slack dans une variable d'environnement
     * accorderait un pouvoir que l'écran des rôles dit ne pas avoir donné.
     */
    const { body, headers } = slackRequest({ approvalId, slackUserId: SLACK_VIEWER });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect((await statusOf(approvalId))?.status).toBe("pending");
  });

  it("un bloc et un bouton qui ne désignent pas la même approbation", async () => {
    const other = await pendingApproval();
    const { body, headers } = slackRequest({
      approvalId,
      slackUserId: SLACK_ADMIN,
      blockId: `placet_approval:${other}`,
    });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect((await statusOf(approvalId))?.status).toBe("pending");
    expect((await statusOf(other))?.status).toBe("pending");
  });

  it("un `action_id` inconnu ne résout rien", async () => {
    const { body, headers } = slackRequest({
      approvalId,
      slackUserId: SLACK_ADMIN,
      actionId: "autre_bouton_de_slack",
    });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect((await statusOf(approvalId))?.status).toBe("pending");
  });
});

describe("le clic légitime", () => {
  it("approuve, et l'audit porte LES DEUX identités", async () => {
    const { body, headers } = slackRequest({ approvalId, slackUserId: SLACK_ADMIN });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Approved");

    const after = await statusOf(approvalId);
    expect(after?.status).toBe("approved");
    /*
     * Le canal fait partie du fait : un auditeur qui lit « approuvé par X » sans savoir
     * que le geste est venu de Slack ne peut pas reconstituer ce qui s'est passé.
     */
    expect(after?.resolvedBy).toContain("Slack");
    expect(after?.resolvedBy).toContain(SLACK_ADMIN);
  });

  it("refuse quand c'est le bouton « Refuser »", async () => {
    const { body, headers } = slackRequest({
      approvalId,
      slackUserId: SLACK_ADMIN,
      actionId: "oathrion_reject",
    });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Denied");
    expect((await statusOf(approvalId))?.status).toBe("rejected");
  });

  it("DEUX CLICS ne relâchent pas deux fois", async () => {
    const first = slackRequest({ approvalId, slackUserId: SLACK_ADMIN });
    const once = await postToSlackRoute(first.body, first.headers);
    expect(once.text).toContain("Approved");

    /* Un second clic, signé à neuf — donc pas un rejeu, un vrai second geste. */
    const second = slackRequest({ approvalId, slackUserId: SLACK_ADMIN });
    const twice = await postToSlackRoute(second.body, second.headers);

    expect(twice.status).toBe(200);
    expect(twice.text).toContain("already");
    expect((await statusOf(approvalId))?.status).toBe("approved");
  });

  it("un identifiant d'approbation inventé ne dit pas s'il existe ailleurs", async () => {
    const { body, headers } = slackRequest({
      approvalId: "apr_inexistant_000000",
      slackUserId: SLACK_ADMIN,
    });
    const res = await postToSlackRoute(body, headers);

    expect(res.status).toBe(200);
    expect(res.text).toContain("no longer exists");
  });
});

describe("ce que la réponse ne dit jamais", () => {
  it("ni le secret de signature, ni le motif précis du refus", async () => {
    const { body, headers } = slackRequest({ approvalId, slackUserId: SLACK_INCONNU });
    const res = await postToSlackRoute(body, headers);

    expect(res.text).not.toContain(SIGNING_SECRET);
    /*
     * Le texte est le même pour toutes les causes. Distinguer « signature fausse » de
     * « vous n'êtes pas dans la liste » dirait à qui sonde s'il a trouvé le bon format.
     */
    expect(res.text).not.toMatch(/signature/i);
    expect(res.text).not.toMatch(/approbateur/i);
  });

  it("sans secret de signature configuré, la route répond 404", async () => {
    const previous = process.env.OATHRION_SLACK_SIGNING_SECRET;
    delete process.env.OATHRION_SLACK_SIGNING_SECRET;
    try {
      const { body, headers } = slackRequest({ approvalId, slackUserId: SLACK_ADMIN });
      const res = await postToSlackRoute(body, headers);
      /*
       * 404 et non 403 : quand Slack n'est pas configuré, la fonctionnalité n'existe pas.
       * Un 403 confirmerait l'existence du point d'entrée à qui le cherche.
       */
      expect(res.status).toBe(404);
      expect((await statusOf(approvalId))?.status).toBe("pending");
    } finally {
      process.env.OATHRION_SLACK_SIGNING_SECRET = previous;
    }
  });
});
