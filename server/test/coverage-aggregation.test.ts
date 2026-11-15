/**
 * `GET /api/coverage` — les deux chiffres qui mentaient, et la règle qui n'était pas la
 * vôtre.
 *
 * ## Le premier défaut : un plafond invisible
 *
 * La route lisait `executions.list(500)` puis comptait les éléments du tableau rendu.
 * TOUS les nombres de l'écran étaient donc plafonnés à 500 — et silencieusement. Un
 * exploitant avec dix mille exécutions lisait « 500 exécutions, 480 autorisées ».
 *
 * Ce qui rend ce défaut particulièrement mauvais : les PROPORTIONS restaient
 * vraisemblables. Rien n'attirait l'œil. Et c'est l'écran dont un exploitant se sert pour
 * décider s'il peut passer en pilote.
 *
 * ## Le second : des règles annoncées et inutilisables
 *
 * `OATHRION_INTERCEPTS` est une liste à l'échelle du DÉPLOIEMENT. La destination que chaque
 * règle nomme, elle, est cadrée par locataire dans `OATHRION_DESTINATIONS`. La route listait
 * les règles telles quelles, donc elle annonçait à un locataire des règles que la route
 * d'interception refuse avec `intercept_destination_unavailable`.
 *
 * Et la conséquence grave n'est pas le nombre affiché : `counts.interceptRules === 0`
 * décide d'une entrée BLOQUANTE. Un locataire sans aucune règle utilisable, mais dans un
 * déploiement où d'autres locataires en ont, ne recevait donc PAS l'avertissement —
 * l'écran lui disait que rien ne le bloquait, alors que son premier appel intercepté
 * aurait été refusé.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const saved: Record<string, string | undefined> = {};

/* Le locataire d'essai, et son voisin : les deux identifiants que le harnais sème. */
const MINE = "org_default";
const THEIRS = "org_rival_corp";

interface Coverage {
  counts: {
    agents: number;
    interceptRules: number;
    interceptRulesUnavailable: number;
    executions: number;
    allowed: number;
    blocked: number;
    failed: number;
  };
  interceptRules: { id: string; destination: string }[];
  interceptRulesUnavailable: { id: string; destination: string }[];
  blocking: { step: string; why: string; where: string }[];
}

let api: Awaited<ReturnType<typeof import("./harness").startTestServer>>;
let ROLE_KEYS: typeof import("./harness").ROLE_KEYS;
let OTHER_ORG_KEYS: typeof import("./harness").OTHER_ORG_KEYS;
let repositories: typeof import("../repositories");

beforeAll(async () => {
  /*
   * L'environnement AVANT l'import du harnais : `server/routes.ts` analyse
   * `OATHRION_INTERCEPTS` dans une constante de module, donc à l'import. Un `import`
   * statique serait hissé au-dessus de ces lignes et le serveur démarrerait sans règles.
   */
  for (const name of ["OATHRION_INTERCEPTS", "OATHRION_DESTINATIONS", "OATHRION_MCP_ALLOWED_DESTINATIONS"]) {
    saved[name] = process.env[name];
  }

  /* Deux destinations, chacune ouverte à UN seul locataire. */
  process.env.OATHRION_DESTINATIONS = JSON.stringify([
    {
      id: "cov-mine",
      url: "https://mcp.mine.example.com",
      label: "la mienne",
      organizations: [MINE],
    },
    {
      id: "cov-theirs",
      url: "https://mcp.theirs.example.com",
      label: "celle du voisin",
      organizations: [THEIRS],
    },
  ]);
  process.env.OATHRION_MCP_ALLOWED_DESTINATIONS =
    "https://mcp.mine.example.com,https://mcp.theirs.example.com";
  /* Une règle par destination. Déclarées toutes les deux, utilisables par un seul chacun. */
  process.env.OATHRION_INTERCEPTS = JSON.stringify([
    {
      id: "regle_a_moi",
      destination: "cov-mine",
      method: "POST",
      path: "/v1/chose",
      action: "api.request",
      target: "body.id",
    },
    {
      id: "regle_du_voisin",
      destination: "cov-theirs",
      method: "POST",
      path: "/v1/autre",
      action: "api.request",
      target: "body.id",
    },
  ]);

  const harness = await import("./harness");
  ROLE_KEYS = harness.ROLE_KEYS;
  OTHER_ORG_KEYS = harness.OTHER_ORG_KEYS;
  repositories = await import("../repositories");
  api = await harness.startTestServer();
  await repositories.seedIfEmpty();
}, 60_000);

afterAll(async () => {
  await api.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("le plafond de 500 n'existe plus", () => {
  it("compte VRAIMENT au-delà de 500 exécutions, par statut", async () => {
    /*
     * 520 lignes, écrites directement par le dépôt : c'est la seule façon de dépasser le
     * plafond sans faire 520 appels HTTP, et c'est le dépôt qu'on veut éprouver.
     *
     * Les trois statuts sont représentés en quantités DIFFÉRENTES et toutes supérieures à
     * zéro : si l'agrégation confondait deux colonnes, des quantités égales le
     * cacheraient.
     */
    const scoped = repositories.repositoriesFor(MINE as never);
    const avant = await scoped.executions.statusCounts();

    const plan: { status: string; n: number }[] = [
      { status: "allowed", n: 300 },
      { status: "blocked", n: 150 },
      { status: "failed", n: 70 },
    ];
    let suffix = 0;
    for (const { status, n } of plan) {
      for (let i = 0; i < n; i += 1) {
        suffix += 1;
        await scoped.executions.create({
          id: `exec_cov_${status}_${String(suffix)}`,
          agentId: "agent-coverage",
          agentName: "Coverage",
          action: "api.request",
          target: "t",
          status,
          risk: "low",
          durationMs: 1,
          cost: 0,
          timestamp: new Date().toISOString(),
          input: {},
          decision: status === "blocked" ? "block" : "allow",
          decisionReason: "montage de test",
          policyEvaluated: null,
          policyId: null,
          result: "",
          audit: [],
        } as never);
      }
    }

    const apres = await scoped.executions.statusCounts();
    expect(apres.allowed - avant.allowed).toBe(300);
    expect(apres.blocked - avant.blocked).toBe(150);
    expect(apres.failed - avant.failed).toBe(70);
    /* Le total dépasse 500 : c'est précisément ce que l'ancienne voie ne pouvait pas dire. */
    expect(apres.total).toBeGreaterThan(500);
    expect(apres.total - avant.total).toBe(520);

    /* Et la route rend ces mêmes nombres, non tronqués. */
    const coverage = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    expect(coverage.status).toBe(200);
    expect(coverage.body.counts.executions).toBe(apres.total);
    expect(coverage.body.counts.executions).toBeGreaterThan(500);
    expect(coverage.body.counts.allowed).toBe(apres.allowed);
    expect(coverage.body.counts.blocked).toBe(apres.blocked);
    expect(coverage.body.counts.failed).toBe(apres.failed);
  }, 120_000);

  it("les 520 lignes n'apparaissent pas chez le voisin", async () => {
    /*
     * L'agrégation est une requête de plus ; une requête de plus est un endroit de plus
     * où oublier `WHERE organization_id`. Le test le plus court de ce fichier, et celui
     * qu'il ne faut pas enlever.
     */
    const voisin = await api.get<Coverage>("/api/coverage", { auth: OTHER_ORG_KEYS.admin });
    const chez_moi = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    expect(voisin.status).toBe(200);
    /*
     * Le voisin n'a AUCUNE de ces lignes. L'assertion porte donc sur ce qui compte : son
     * total ne contient rien des 520, et il reste strictement sous le mien.
     *
     * Écrit d'abord `toBeLessThan(chez_moi)` — ce qui a échoué sur « 0 inférieur à 0 »
     * quand ce test tournait seul, le voisin n'ayant alors rien du tout. Le défaut était
     * dans l'assertion, pas dans le code : comparer deux totaux ne dit rien quand les
     * deux peuvent être nuls. On compare donc aux 520 lignes nommément.
     */
    expect(voisin.body.counts.allowed).toBeLessThan(300);
    expect(voisin.body.counts.executions).toBeLessThan(520);
    expect(chez_moi.body.counts.executions).toBeGreaterThan(500);
    expect(chez_moi.body.counts.executions).toBeGreaterThan(voisin.body.counts.executions);
  });
});

describe("une règle n'est annoncée qu'au locataire qui peut l'employer", () => {
  it("ne liste que les règles dont la destination est ouverte à ce locataire", async () => {
    const mine = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    expect(mine.status).toBe(200);

    const ids = mine.body.interceptRules.map((r) => r.id);
    expect(ids).toContain("regle_a_moi");
    /* LA RÈGLE DU VOISIN N'EST PAS LA MIENNE, et la route d'interception la refuserait. */
    expect(ids).not.toContain("regle_du_voisin");
    expect(mine.body.counts.interceptRules).toBe(1);
  });

  it("nomme à part les règles déclarées mais fermées, au lieu de les cacher", async () => {
    /*
     * Les cacher entièrement laisserait un exploitant chercher pourquoi la règle qu'il
     * vient d'écrire n'apparaît nulle part. Les compter avec les utilisables était le
     * défaut.
     */
    const mine = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    expect(mine.body.interceptRulesUnavailable.map((r) => r.id)).toEqual(["regle_du_voisin"]);
    expect(mine.body.counts.interceptRulesUnavailable).toBe(1);
  });

  it("le voisin voit SA règle et pas la mienne — la symétrie, donc pas un filtre au hasard", async () => {
    const theirs = await api.get<Coverage>("/api/coverage", { auth: OTHER_ORG_KEYS.admin });
    expect(theirs.status).toBe(200);
    expect(theirs.body.interceptRules.map((r) => r.id)).toEqual(["regle_du_voisin"]);
    expect(theirs.body.interceptRulesUnavailable.map((r) => r.id)).toEqual(["regle_a_moi"]);
  });

  it("une règle fermée ne compte pas comme un outil branché dans les obstacles", async () => {
    /*
     * LE DÉFAUT GRAVE, et le seul test qui le montre.
     *
     * `counts.interceptRules === 0` décide de l'entrée « Brancher un outil ou une route ».
     * Avec les règles non filtrées, un locataire qui ne peut employer AUCUNE règle voyait
     * ce compteur à 2 et ne recevait pas l'avertissement : l'écran lui disait que rien ne
     * le bloquait, alors que son premier appel intercepté aurait été refusé.
     *
     * Le voisin, ici, a une règle utilisable — donc pour éprouver l'obstacle il faut un
     * locataire qui n'en a aucune. On le vérifie par le compteur, qui est ce que la
     * décision lit : il est désormais le nombre de règles UTILISABLES, et c'est tout ce
     * que l'entrée bloquante a besoin de savoir pour être juste.
     */
    const mine = await api.get<Coverage>("/api/coverage", { auth: ROLE_KEYS.admin });
    const theirs = await api.get<Coverage>("/api/coverage", { auth: OTHER_ORG_KEYS.admin });

    /* Chacun en a exactement une, donc aucun des deux n'est bloqué pour cette raison. */
    expect(mine.body.counts.interceptRules).toBe(1);
    expect(theirs.body.counts.interceptRules).toBe(1);

    /*
     * Et le compteur n'est PLUS le nombre de règles déclarées (2) : c'est la correction
     * elle-même, affirmée sur la valeur que la logique d'obstacle consulte.
     */
    expect(mine.body.counts.interceptRules).not.toBe(2);
    expect(theirs.body.counts.interceptRules).not.toBe(2);
  });
});
