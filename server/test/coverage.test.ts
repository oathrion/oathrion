/**
 * `GET /api/coverage` — la seule page qui dit si un pilote peut commencer.
 *
 * ## Ce qu'elle doit tenir
 *
 * Chaque nombre vient d'un COMPTAGE en base, dans la portée du locataire. Aucun n'est
 * estimé, aucun n'est inventé, et la liste des obstacles est ordonnée comme la suite
 * d'actions d'un exploitant qui part de rien.
 *
 * ## Le piège que les deux premiers tests évitent
 *
 * `decision` et `status` existent tous les deux sur une exécution et ne disent pas la
 * même chose : `decision` est le verdict du moteur, `status` est ce qu'il est DEVENU. Une
 * action autorisée dont l'outil a échoué porte `decision: "allow"` et
 * `status: "failed"`. La compter parmi les autorisées masquerait exactement ce qui
 * réclame une intervention — et c'est la faute que la première version de cette route
 * faisait, en comparant `decision` à des valeurs de `status` qui n'existent pas dans son
 * type.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { seedIfEmpty } from "../repositories";

interface Coverage {
  counts: {
    agents: number;
    policies: number;
    connectorsConnected: number;
    interceptRules: number;
    executions: number;
    allowed: number;
    blocked: number;
    pendingApprovals: number;
    failed: number;
  };
  governedActions: string[];
  connectors: { id: string; label: string; state: string; actions: string[] }[];
  interceptRules: { id: string; method: string; path: string }[];
  blocking: { step: string; why: string; where: string }[];
  caveat: string;
}

let api: TestClient;

beforeAll(async () => {
  api = await startTestServer();
  await seedIfEmpty();
});

describe("les chiffres viennent de la base", () => {
  it("compte les agents et les politiques réellement présents", async () => {
    const [coverage, agents, policies] = await Promise.all([
      api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin }),
      api.get<unknown[]>("/api/agents", { auth: ROLE_KEYS.admin }),
      api.get<{ status: string }[]>("/api/policies", { auth: ROLE_KEYS.admin }),
    ]);

    expect(coverage.status).toBe(200);
    expect(coverage.body.counts.agents).toBe(agents.body.length);
    /* Les politiques ACTIVES, pas toutes : une politique désactivée ne gouverne rien. */
    expect(coverage.body.counts.policies).toBe(
      policies.body.filter((policy) => policy.status === "enabled").length,
    );
  });

  it("les autorisées et les échecs sont comptés séparément", async () => {
    /*
     * Une action autorisée dont l'outil a échoué est `failed`, et ne doit PAS être
     * comptée comme autorisée : l'y inclure masquerait la colonne qui réclame une
     * intervention. Les deux comptes viennent de `status`, pas de `decision`.
     */
    const coverage = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    const executions = await api.get<{ status: string }[]>("/api/executions", { auth: ROLE_KEYS.admin });

    const byStatus = (value: string) => executions.body.filter((run) => run.status === value).length;
    expect(coverage.body.counts.allowed).toBe(byStatus("allowed"));
    expect(coverage.body.counts.blocked).toBe(byStatus("blocked"));
    expect(coverage.body.counts.failed).toBe(byStatus("failed"));
    /* Et le total n'est pas la somme des trois : `pending` existe aussi. */
    expect(coverage.body.counts.executions).toBeGreaterThanOrEqual(
      coverage.body.counts.allowed + coverage.body.counts.blocked + coverage.body.counts.failed,
    );
  });

  it("les verbes gouvernés sont ceux de la table de routage", async () => {
    /*
     * Pas un catalogue : ce qu'une action atteindrait RÉELLEMENT. `/api/tools` rend les
     * verbes par outil, et leur union doit être exactement cette liste — sinon l'un des
     * deux écrans annonce une couverture que l'autre ne reconnaît pas.
     */
    const coverage = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    const tools = await api.get<{ actions: string[] }[]>("/api/tools", { auth: ROLE_KEYS.admin });

    const fromTools = [...new Set(tools.body.flatMap((tool) => tool.actions))].sort();
    expect(coverage.body.governedActions).toEqual(fromTools);
    expect(coverage.body.governedActions.length).toBeGreaterThan(0);
  });
});

describe("la liste des obstacles est ordonnée et motivée", () => {
  it("chaque obstacle nomme un motif et un endroit où agir", async () => {
    const coverage = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    for (const item of coverage.body.blocking) {
      expect(item.step.length).toBeGreaterThan(5);
      /* Le POURQUOI, pas seulement le quoi : un obstacle sans motif ne se corrige pas. */
      expect(item.why.length).toBeGreaterThan(40);
      expect(item.where.startsWith("/")).toBe(true);
    }
  });

  it("une base seedée n'a pas d'obstacle « déclarer un agent »", async () => {
    /*
     * Le seed déclare des agents et des politiques, donc ces deux obstacles doivent
     * tomber. Si l'un restait, la liste décrirait un état que la base ne porte pas — et
     * un exploitant suivrait une consigne inutile.
     */
    const coverage = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    const steps = coverage.body.blocking.map((item) => item.step);
    expect(steps).not.toContain("Declare an agent");
    expect(steps).not.toContain("Écrire au moins une politique");
  });
});

describe("la réserve ne peut pas être perdue", () => {
  it("la réponse porte toujours la phrase sur ce qu'Oathrion ne voit pas", async () => {
    /*
     * C'est la seule phrase qui empêche cet écran de rassurer à tort : une liste
     * d'obstacles vide ne veut pas dire « vous êtes protégé ». Elle vient du SERVEUR,
     * donc la console ne peut pas l'oublier en changeant de mise en page.
     */
    const coverage = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    expect(coverage.body.caveat).toMatch(/governs only the actions that go through it/);
    expect(coverage.body.caveat).toMatch(/credentials/);
    expect(coverage.body.caveat.length).toBeGreaterThan(150);
  });
});

describe("la route est protégée comme les autres", () => {
  it("sans credential, 401", async () => {
    const res = await api.get("/api/coverage", { auth: null });
    expect(res.status).toBe(401);
  });

  it("un viewer peut lire — c'est une lecture", async () => {
    /*
     * `read` suffit : rien ici n'utilise un credential de fournisseur ni n'en révèle un.
     * Un opérateur doit pouvoir constater l'état de sa couverture sans détenir `manage`.
     */
    const res = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.viewer });
    expect(res.status).toBe(200);
    expect(typeof res.body.counts.agents).toBe("number");
  });

  it("l'organisation voisine voit SA couverture, pas la nôtre", async () => {
    /*
     * Le test d'isolation qui compte pour cette route : les deux réponses doivent
     * différer, sinon la portée du locataire n'est pas appliquée et un client lirait
     * l'activité d'un autre.
     */
    const mine = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    const theirs = await api.get<Coverage>("/api/coverage", { auth: OTHER_ORG_KEYS.admin });
    expect(theirs.status).toBe(200);
    expect(theirs.body.counts.agents).not.toBe(mine.body.counts.agents);
  });
});
