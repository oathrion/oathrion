/**
 * OATHRION GOUVERNE-T-IL RÉELLEMENT UN CONNECTEUR ? ALLOW · BLOCK · APPROVAL_REQUIRED.
 *
 * ## Ce que ces tests prouvent, et avec quoi
 *
 * Le connecteur employé ici est un ESPION local à ce fichier : il enregistre ce qu'on lui
 * demande et ne joint aucun service. C'est exactement ce qu'il faut pour la question
 * posée, qui n'est pas « GitHub répond-il ? » mais « une action refusée atteint-elle le
 * connecteur ? ». Un vrai appel réseau rendrait le test plus impressionnant et moins
 * concluant : un zéro appel pourrait venir d'une panne.
 *
 * La preuve que le connecteur GitHub atteint vraiment GitHub est
 * `npm run verify:github`, qui exige un jeton réel et refuse de passer sans
 * (code de sortie 2). Les deux ne se remplacent pas.
 *
 * ## Tout le reste est réel
 *
 * Le registre d'outils est le vrai, construit par `extendedWith` comme la portée d'un
 * locataire le fait. La passerelle est la vraie. Les politiques sont celles du seed. Le
 * catalogue d'actions est le vrai, donc un verbe non catalogué ferait échouer la
 * construction ici comme au démarrage.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import { AgentGateway } from "../gateway/agent-gateway";
import { ToolRegistry } from "../gateway/tool-registry";
import { ConnectorTool } from "../connectors/connector-tool";
import type {
  Connector,
  ConnectorCapability,
  ConnectorContext,
  ConnectorExecuteRequest,
  ConnectorExecuteResult,
  ConnectorProbe,
  ConnectorRevocation,
} from "../connectors/types";
import type { ConnectorVault } from "../connectors/vault";
import { repositoriesFor, seedIfEmpty } from "../repositories";
import { DecisionService } from "../services/decision-service";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const ORG = "org_default" as OrganizationId;

/**
 * L'espion. Il compte les appels et retient le dernier.
 *
 * `execute` réussit toujours : un connecteur qui échouerait rendrait les assertions
 * « n'a pas été atteint » ambiguës — on ne saurait plus si zéro appel vient du refus de
 * Oathrion ou d'une erreur du connecteur.
 */
class SpyConnector implements Connector {
  readonly id = "spy";
  readonly label = "Connecteur espion";
  readonly description = "Compte ce qu'on lui demande. Ne joint aucun service.";
  readonly actions = ["github.issue.create"] as const;
  readonly credentialGuide = "Aucun credential : cet objet n'existe que dans ce fichier de test.";

  calls = 0;
  last: ConnectorExecuteRequest | null = null;

  verify(): Promise<ConnectorProbe> {
    return Promise.resolve({ ok: true, account: "spy", scopes: [], code: "ok", detail: "espion" });
  }
  test(): Promise<ConnectorProbe> {
    return Promise.resolve({ ok: true, account: "spy", scopes: [], code: "ok", detail: "espion" });
  }
  capabilities(): Promise<ConnectorCapability[]> {
    return Promise.resolve([{ action: "github.issue.create", label: "Ouvrir une issue", available: true }]);
  }
  execute(_context: ConnectorContext, request: ConnectorExecuteRequest): Promise<ConnectorExecuteResult> {
    this.calls += 1;
    this.last = request;
    return Promise.resolve({
      ok: true,
      code: "ok",
      summary: `Issue ouverte sur ${request.target}.`,
      data: { dispatched: true, issueNumber: 1 },
    });
  }
  revoke(): Promise<ConnectorRevocation> {
    return Promise.resolve({ ok: true, remoteStillValid: true, detail: "espion" });
  }
}

/**
 * Un coffre qui dit toujours « connecté ».
 *
 * Seules les deux méthodes que ce chemin emploie sont implémentées. Le reste lèverait
 * si on l'atteignait, ce qui est la bonne réaction : un test qui passerait en se servant
 * d'un coffre factice plus large que nécessaire masquerait l'endroit où le vrai coffre
 * est consulté.
 */
function vaultSayingConnected(): ConnectorVault {
  return {
    describe: () =>
      Promise.resolve({
        connectorId: "spy",
        state: "connected" as const,
        account: "spy",
        scopes: [],
        fingerprint: "aaaaaa",
        detail: "",
        connectedBy: "test",
        verified: true,
        connectedAt: new Date().toISOString(),
        lastCheckedAt: null,
      }),
    open: () => Promise.resolve({ secretEnvelope: "jeton-de-test", account: "spy", scopes: [] }),
  } as unknown as ConnectorVault;
}

/**
 * L'agent de ce fichier, créé par l'API.
 *
 * Aucun agent du seed ne détient `write:repository` — la portée n'existait pas avant ce
 * chantier — donc le scénario ALLOW a d'abord rendu BLOCK par la barrière de permission.
 * Le moteur avait raison deux fois de suite : d'abord sur l'hôte manquant dans la cible,
 * ensuite sur la portée manquante. Créer l'agent ici est aussi la seule façon de
 * vérifier que `write:repository` est RÉELLEMENT accordable par l'API — ce qui n'était
 * pas le cas de `publish:content`, resté absent de `permissionScopeSchema` (voir
 * `shared/permission-scope-parity.test.ts`).
 */
const AGENT_ID = "agt_connector_test";

const AGENT_BODY = {
  id: AGENT_ID,
  name: "Agent de dépôt",
  description: "Ouvre des issues sous mandat, pour ce fichier de test.",
  provider: "openai",
  model: "gpt-4o",
  status: "active",
  owner: "engineering",
  mandate: {
    maxTransactionAmount: 1000,
    currency: "EUR" as const,
    allowedCategories: [],
    blockedCategories: [],
    /* `github.com` et rien d'autre : c'est cette liste que l'allowlist de domaine lit. */
    allowedDomains: ["github.com"],
  },
  permissions: [
    {
      scope: "write:repository" as const,
      label: "Écrire dans un dépôt",
      description: "Ouvrir et commenter des issues.",
      granted: true,
      risk: "medium" as const,
    },
  ],
  policyIds: [],
  tags: ["test"],
};

/** La cible et les métadonnées d'une ouverture d'issue. */
const ISSUE = {
  agentId: AGENT_ID,
  action: "github.issue.create",
  /*
   * L'HÔTE EST DANS LA CIBLE, ET C'EST CE TEST QUI L'A IMPOSÉ.
   *
   * Écrit d'abord `placet-labs/pilote`, ce scénario a rendu BLOCK avec ce motif :
   * « does not resolve to a destination that can be checked against the agent's approved
   * domains ». Le moteur avait raison — les verbes GitHub sont `outbound`, donc
   * l'allowlist de domaine du mandat les gouverne, et aucun hôte n'était lisible. Voir
   * `parseRepository` pour pourquoi la forme courte est désormais refusée nommément.
   */
  target: "github.com/placet-labs/pilote",
  metadata: { title: "Rapport d'exécution", body: "Corps de l'issue." },
};

let api: TestClient;
let spy: SpyConnector;
let tool: ConnectorTool;
let gateway: AgentGateway;

async function build(): Promise<void> {
  spy = new SpyConnector();
  const context: ConnectorContext = {
    organizationId: ORG,
    vault: vaultSayingConnected(),
    env: {} as NodeJS.ProcessEnv,
  };
  tool = new ConnectorTool(spy, context);
  await tool.refreshSimulated();

  /*
   * `extendedWith` sur un registre de base vide : la table de routage passe par le vrai
   * constructeur, donc `github.issue.create` doit être au catalogue d'actions avec une
   * portée de permission. Si quelqu'un retirait l'entrée, ce fichier échouerait à la
   * construction — ce qui est le but.
   */
  const base = new ToolRegistry([], {});
  const registry = base.extendedWith([tool], { "github.issue.create": tool.id });

  const repositories = repositoriesFor(ORG);
  gateway = new AgentGateway(new DecisionService(repositories), repositories, registry, "EUR", ORG);
}

beforeAll(async () => {
  api = await startTestServer();
  await seedIfEmpty();

  /*
   * L'agent est créé par l'API, pas inséré en base. La requête traverse donc
   * `permissionScopeSchema` : si `write:repository` n'y était pas, cette assertion
   * échouerait ici plutôt que de produire des BLOCK inexpliqués plus bas.
   */
  const created = await api.post("/api/agents", AGENT_BODY, { auth: ROLE_KEYS.admin });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

  /*
   * La règle d'approbation. Écrite par l'API comme un exploitant le ferait, et portant
   * sur un dépôt nommé : c'est la démonstration qu'un verbe de connecteur se gouverne
   * avec les mêmes politiques que tout le reste, sans rien de particulier.
   */
  const policy = await api.post(
    "/api/policies",
    {
      id: "pol_connector_approval",
      name: "Un dépôt sensible demande un humain",
      description: "Toute action sur placet-labs/sensible est retenue pour approbation.",
      type: "REQUIRE_HUMAN_APPROVAL",
      /*
       * La cible ENTIÈRE, pas un fragment. Écrit d'abord `placet-labs/sensible`, le
       * motif n'a rien retenu : côté autorisation, `matchesExplicit` exige que le motif
       * couvre toute la cible (invariant 1 de `shared/policy/matchers.ts`), et seul le
       * côté refus accepte un segment. Une règle qui RETIENT doit être écrite exactement,
       * sinon elle retient plus que ce que son auteur a voulu.
       */
      condition: { kind: "targetMatches", targets: ["github.com/placet-labs/sensible"] },
      scope: "organization",
      appliesTo: "all agents",
      effect: "require_approval",
      status: "enabled",
      action: "APPROVAL_REQUIRED",
      risk: "high",
      priority: 5,
    },
    { auth: ROLE_KEYS.admin },
  );
  expect(policy.status, JSON.stringify(policy.body)).toBeLessThan(300);
});

beforeEach(async () => {
  await build();
});

describe("le registre refuse un verbe que la politique ne connaît pas", () => {
  it("un connecteur ne peut pas introduire un verbe hors catalogue", () => {
    /*
     * LA BARRIÈRE QU'UN CONNECTEUR NE FRANCHIT PAS, et elle est la même que pour un
     * outil intégré ou déclaré. Câbler un outil sur un verbe est ce qui transforme une
     * décision en effet de bord ; l'entrée du catalogue est ce qui fait appliquer la
     * portée de permission, le plafond de mandat et l'allowlist de domaine.
     */
    const base = new ToolRegistry([], {});
    expect(() => base.extendedWith([tool], { "github.wipe.everything": tool.id })).toThrow(
      /not declared in shared\/policy\/actions\.ts/,
    );
  });

  it("les trois verbes GitHub, eux, sont catalogués avec une portée", () => {
    const base = new ToolRegistry([], {});
    const registry = base.extendedWith([tool], {
      "github.repo.read": tool.id,
      "github.issue.create": tool.id,
      "github.issue.comment": tool.id,
    });
    expect(registry.actionsFor(tool.id).sort()).toEqual([
      "github.issue.comment",
      "github.issue.create",
      "github.repo.read",
    ]);
  });
});

describe("ALLOW — l'action autorisée atteint le connecteur, exactement une fois", () => {
  it("dépêche et rend ce que le connecteur a répondu", async () => {
    const result = await gateway.execute({ ...ISSUE, actor: "test" });

    expect(result.decision).toBe("ALLOW");
    expect(result.succeeded).toBe(true);
    expect(result.toolId).toBe("connector_spy");
    expect(spy.calls).toBe(1);
    expect(result.toolResult).toMatchObject({ dispatched: true, connector: "spy", code: "ok" });
  });

  it("transmet la cible et les métadonnées sans y ajouter quoi que ce soit", async () => {
    await gateway.execute({ ...ISSUE, actor: "test" });
    expect(spy.last?.target).toBe("github.com/placet-labs/pilote");
    expect(spy.last?.action).toBe("github.issue.create");
    expect(spy.last?.metadata).toMatchObject({ title: "Rapport d'exécution" });
    /* La clé d'idempotence est l'exécution, pas une valeur inventée par le connecteur. */
    expect(spy.last?.executionId).toMatch(/^exe_/);
  });

  it("l'outil se déclare NON simulé quand un credential est stocké", () => {
    expect(tool.simulated).toBe(false);
  });
});

describe("BLOCK — le connecteur n'est jamais atteint", () => {
  it("une politique de blocage arrête l'action avant le connecteur", async () => {
    /*
     * `pol_block_sanctioned` du seed bloque la cible `sanctioned-supplier`. La cible
     * voyage telle quelle jusqu'au moteur, donc une règle écrite sur la cible gouverne
     * un verbe de connecteur comme n'importe quel autre.
     */
    const result = await gateway.execute({
      ...ISSUE,
      target: "sanctioned-supplier.com/placet-labs/pilote",
      actor: "test",
    });

    expect(result.decision).toBe("BLOCK");
    expect(result.attempted).toBe(false);
    expect(spy.calls).toBe(0);
    expect(spy.last).toBeNull();
  });

  it("le refus est enregistré — un BLOCK est un événement, pas un silence", async () => {
    const result = await gateway.execute({ ...ISSUE, target: "sanctioned-supplier.com/placet-labs/pilote", actor: "test" });
    expect(result.executionId).not.toBeNull();
  });

  it("un agent sans la portée requise n'atteint pas le connecteur", async () => {
    /*
     * `agt_support` n'a pas `write:repository`. La barrière de permission est antérieure
     * à toute politique d'organisation : c'est l'entrée du catalogue d'actions qui la
     * déclenche, et c'est pourquoi un connecteur doit y déclarer ses verbes.
     */
    const result = await gateway.execute({ ...ISSUE, agentId: "agt_support", actor: "test" });
    expect(result.decision).not.toBe("ALLOW");
    expect(spy.calls).toBe(0);
  });
});

describe("APPROVAL_REQUIRED — rien ne part avant l'humain", () => {
  /*
   * La règle qui retient est créée par l'API, dans `beforeAll`, et elle porte sur la
   * CIBLE : `REQUIRE_HUMAN_APPROVAL` + `targetMatches`. Aucune règle du seed ne
   * gouvernait un verbe de connecteur, et la première version de ce test s'en accommodait
   * par une sortie anticipée — c'est-à-dire qu'il passait sans rien prouver. Une
   * politique réelle vaut mieux qu'un test qui s'excuse.
   */
  it("retient l'action sans joindre le connecteur", async () => {
    const result = await gateway.execute({
      ...ISSUE,
      target: "github.com/placet-labs/sensible",
      actor: "test",
    });

    expect(result.decision).toBe("APPROVAL_REQUIRED");
    expect(result.approvalId).not.toBeNull();
    expect(result.attempted).toBe(false);
    expect(spy.calls).toBe(0);
  });

  it("l'approbation d'un humain relâche l'action, et une seule fois", async () => {
    const held = await gateway.execute({
      ...ISSUE,
      target: "github.com/placet-labs/sensible",
      actor: "test",
    });
    const approvalId = held.approvalId;
    expect(approvalId).not.toBeNull();
    expect(spy.calls).toBe(0);

    const released = await gateway.resolveApproval(approvalId!, "approved", "approbateur");
    expect(released?.approval?.approval.status).toBe("approved");
    expect(released?.attempted).toBe(true);
    expect(spy.calls).toBe(1);

    /* Approuver deux fois ne dépêche pas deux fois. */
    await gateway.resolveApproval(approvalId!, "approved", "approbateur").catch(() => undefined);
    expect(spy.calls).toBe(1);
  });

  it("un rejet ne dépêche jamais", async () => {
    const held = await gateway.execute({
      ...ISSUE,
      target: "github.com/placet-labs/sensible",
      actor: "test",
    });
    await gateway.resolveApproval(held.approvalId!, "rejected", "approbateur");
    expect(spy.calls).toBe(0);
  });
});

describe("l'isolation du locataire tient jusque dans l'outil", () => {
  it("un appel d'un autre locataire est refusé, et rien n'est envoyé", async () => {
    /*
     * La portée du locataire construit un `ConnectorTool` par organisation, donc les
     * deux coïncident par construction. L'assertion existe parce que « par
     * construction » est le genre d'affirmation qu'un cache mal invalidé transforme en
     * fuite : l'action d'une organisation partirait avec le jeton d'une autre.
     */
    const result = await tool.execute({
      organizationId: "org_quelquun_dautre" as OrganizationId,
      executionId: "exe_test",
      agentId: "agt_procurement",
      agentName: "Agent",
      action: "github.issue.create",
      target: "github.com/placet-labs/pilote",
      metadata: {},
      currency: "EUR",
    });

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ dispatched: false, reason: "tenant_mismatch" });
    expect(spy.calls).toBe(0);
  });

  it("… et le refus est compté, parce qu'un refus est un événement", async () => {
    await tool.execute({
      organizationId: "org_quelquun_dautre" as OrganizationId,
      executionId: "exe_test",
      agentId: "agt_procurement",
      agentName: "Agent",
      action: "github.issue.create",
      target: "github.com/placet-labs/pilote",
      metadata: {},
      currency: "EUR",
    });
    expect(tool.toolExecutionCount).toBe(1);
  });
});
