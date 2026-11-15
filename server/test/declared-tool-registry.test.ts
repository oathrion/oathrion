/**
 * LE REGISTRE D'OUTILS DÉCLARÉ — ce qu'une déclaration peut et ne peut pas faire.
 *
 * `docs/limitations.md` disait : « The tool registry is five hardcoded simulated tools ».
 * La phrase était vraie et elle décrivait mal le manque. Le chemin aval RÉEL existait
 * déjà et `npm run verify:mcp` le prouve contre un serveur qui ne partage aucune ligne
 * avec Oathrion ; ce qui manquait, c'était la capacité de DÉCLARER le sien sans modifier
 * du TypeScript.
 *
 * Cette suite attaque la déclaration, pas la dépêche. Qu'un outil déclaré atteigne
 * effectivement un serveur indépendant, exactement une fois, est prouvé par
 * `npm run verify:tools` — un processus, un vrai serveur, un vrai PostgreSQL. Ici on
 * vérifie les refus : ce qui doit s'arrêter au démarrage plutôt qu'au premier appel
 * d'un client, et ce qu'une déclaration ne doit jamais pouvoir contourner.
 */

import { describe, expect, it } from "vitest";

import {
  DeclaredTool,
  DeclaredToolError,
  declaredToolProblems,
  parseDeclaredTools,
  type DeclaredToolSpec,
} from "../gateway/tools/declared-tool";
import { createDefaultRegistry } from "../gateway/tool-registry";
import type { ToolContext } from "../gateway/tools/types";

/*
 * Une adresse loopback dont le port est fermé. La résolution de destination doit
 * réussir (c'est une adresse valide pour la fixture locale) et aucun test de ce
 * fichier ne doit la JOINDRE : si l'un d'eux se mettait à dépêcher pour de vrai, il
 * échouerait sur un refus de connexion au lieu de passer en silence.
 */
const FIXTURE_URL = "http://127.0.0.1:9/";

function envWith(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    OATHRION_LOCAL_MCP_URL: FIXTURE_URL,
    OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
    ...extra,
  } as NodeJS.ProcessEnv;
}

const SPEC: DeclaredToolSpec = {
  id: "acme_refund",
  label: "Acme refunds",
  destination: "local-fixture",
  tool: "refunds.create",
  actions: ["refund"],
  arguments: { customer: "target", amount: "metadata.amount", currency: "currency" },
  requireSchema: false,
};

function context(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    organizationId: "org_acme00000000000000",
    executionId: "axn_0123456789abcdef0123456789abcdef",
    agentId: "agt_pay",
    agentName: "Agent de paiement",
    action: "refund",
    target: "cus_7",
    metadata: { amount: 40 },
    currency: "USD",
    ...extra,
  };
}

const tools = (specs: unknown) => JSON.stringify(specs);

describe("parseDeclaredTools — la forme, refusée au démarrage", () => {
  it("rend une liste vide quand rien n'est déclaré", () => {
    expect(parseDeclaredTools(envWith())).toEqual([]);
    expect(parseDeclaredTools(envWith({ OATHRION_TOOLS: "   " }))).toEqual([]);
  });

  it("lit une déclaration complète", () => {
    const [spec] = parseDeclaredTools(envWith({ OATHRION_TOOLS: tools([SPEC]) }));
    expect(spec).toEqual(SPEC);
  });

  /*
   * Chaque faute est une EXCEPTION, jamais une entrée silencieusement ignorée.
   * Sauter une déclaration mal formée produirait un déploiement où un verbe est
   * autorisé par la politique et n'atteint aucun outil : un refus déguisé en succès.
   */
  const refusals: Array<[string, unknown, RegExp]> = [
    ["du JSON invalide", "{not json", /not valid JSON/],
    ["autre chose qu'un tableau", { id: "x" }, /must be a JSON array/],
    ["une entrée qui n'est pas un objet", ["acme_refund"], /is not an object/],
    ["un id de mauvaise forme", [{ ...SPEC, id: "Acme Refund" }], /invalid id/],
    ["un id répété", [SPEC, SPEC], /repeats the id/],
    ["aucune destination", [{ ...SPEC, destination: "" }], /declares no destination/],
    ["aucun nom d'outil aval", [{ ...SPEC, tool: "  " }], /no downstream tool name/],
    ["aucun verbe", [{ ...SPEC, actions: [] }], /claims no action/],
    ["aucune table d'arguments", [{ ...SPEC, arguments: null }], /no argument mapping/],
    ["un argument qui n'est pas une chaîne", [{ ...SPEC, arguments: { amount: 12 } }], /must name a context field/],
  ];
  for (const [label, value, pattern] of refusals) {
    it(`refuse ${label}`, () => {
      const raw = typeof value === "string" ? value : tools(value);
      expect(() => parseDeclaredTools(envWith({ OATHRION_TOOLS: raw }))).toThrow(DeclaredToolError);
      expect(() => parseDeclaredTools(envWith({ OATHRION_TOOLS: raw }))).toThrow(pattern);
    });
  }

  /*
   * LE REFUS QUI COMPTE LE PLUS DANS CE FICHIER.
   *
   * `metadta.amount` est une faute de frappe d'une lettre. Acceptée, elle projetterait
   * `undefined` dans une instruction qu'Oathrion signe : le fournisseur recevrait une
   * demande de remboursement sans montant. Elle doit arrêter le démarrage, pas
   * produire un virement au champ vide.
   */
  it("refuse une source de contexte inconnue, et nomme les sources permises", () => {
    const raw = tools([{ ...SPEC, arguments: { amount: "metadta.amount" } }]);
    expect(() => parseDeclaredTools(envWith({ OATHRION_TOOLS: raw }))).toThrow(
      /names "metadta.amount", which is not a context field/,
    );
    expect(() => parseDeclaredTools(envWith({ OATHRION_TOOLS: raw }))).toThrow(/metadata\.<key>/);
  });

  it("refuse un préfixe `metadata.` sans clé", () => {
    const raw = tools([{ ...SPEC, arguments: { amount: "metadata." } }]);
    expect(() => parseDeclaredTools(envWith({ OATHRION_TOOLS: raw }))).toThrow(/not a context field/);
  });

  it("n'accepte pas de projeter un champ qui n'existe pas sur le contexte", () => {
    /* `organizationId` est sur le contexte mais n'est pas projetable : l'identifiant du
     * locataire sert à RÉSOUDRE la destination, il n'a pas à partir chez le fournisseur
     * sans que personne l'ait demandé. */
    const raw = tools([{ ...SPEC, arguments: { tenant: "organizationId" } }]);
    expect(() => parseDeclaredTools(envWith({ OATHRION_TOOLS: raw }))).toThrow(/not a context field/);
  });
});

describe("declaredToolProblems — ce qui doit arrêter le démarrage", () => {
  it("ne reproche rien à une déclaration cohérente", () => {
    expect(declaredToolProblems(envWith({ OATHRION_TOOLS: tools([SPEC]) }))).toEqual([]);
  });

  it("refuse une destination qui n'est pas enregistrée, et liste celles qui le sont", () => {
    const problems = declaredToolProblems(
      envWith({ OATHRION_TOOLS: tools([{ ...SPEC, destination: "acme-rep" }]) }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/destination "acme-rep", which is not registered/);
    expect(problems[0]).toMatch(/local-fixture/);
  });

  it("refuse un verbe absent du catalogue d'actions", () => {
    const problems = declaredToolProblems(
      envWith({ OATHRION_TOOLS: tools([{ ...SPEC, actions: ["wire_transfer_anywhere"] }]) }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not declared in shared\/policy\/actions\.ts/);
  });

  it("rapporte TOUTES les fautes d'un coup, pas la première", () => {
    const problems = declaredToolProblems(
      envWith({
        OATHRION_TOOLS: tools([
          { ...SPEC, id: "first_tool", destination: "nope", actions: ["not_a_verb"] },
          { ...SPEC, id: "second_tool", destination: "nope-too" },
        ]),
      }),
    );
    expect(problems).toHaveLength(3);
  });

  it("une forme invalide devient un problème nommé, pas une exception au démarrage", () => {
    const problems = declaredToolProblems(envWith({ OATHRION_TOOLS: "{nope" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/OATHRION_TOOLS/);
  });

  /*
   * Quand le registre de destinations est lui-même illisible, `destinationRegistryProblems`
   * le dit avec le détail. Répéter « destination introuvable » pour chaque outil déclaré
   * noierait la cause sous ses conséquences.
   */
  it("se tait quand c'est le registre de destinations qui est cassé", () => {
    const problems = declaredToolProblems({
      OATHRION_DESTINATIONS: "{nope",
      OATHRION_TOOLS: tools([SPEC]),
    } as NodeJS.ProcessEnv);
    expect(problems).toEqual([]);
  });
});

describe("DeclaredTool — ce que l'inventaire annonce", () => {
  it("se dit SIMULÉ quand sa destination n'est pas déclarée", () => {
    expect(new DeclaredTool(SPEC, envWith({ OATHRION_LOCAL_MCP_URL: undefined })).simulated).toBe(true);
  });

  it("se dit RÉEL quand elle l'est", () => {
    expect(new DeclaredTool(SPEC, envWith()).simulated).toBe(false);
  });

  /*
   * L'inventaire décrit le DÉPLOIEMENT, pas les droits de celui qui regarde : la même
   * réponse pour tous les locataires. Savoir si CE locataire-là y a droit est une
   * question d'autorisation, tranchée à l'appel — et le test suivant montre qu'elle
   * l'est.
   */
  it("répond à l'inventaire sans consulter le locataire", () => {
    const scoped = envWith({ OATHRION_LOCAL_MCP_ORGANIZATIONS: "org_autre00000000000000" });
    expect(new DeclaredTool(SPEC, scoped).simulated).toBe(false);
  });

  it("un registre cassé ne déclare rien de réel", () => {
    const broken = { OATHRION_DESTINATIONS: "{nope" } as NodeJS.ProcessEnv;
    expect(new DeclaredTool(SPEC, broken).simulated).toBe(true);
  });
});

describe("DeclaredTool — ce qui n'est PAS dépêché", () => {
  it("refuse, et le dit, quand la destination n'est pas permise à ce locataire", async () => {
    const scoped = envWith({ OATHRION_LOCAL_MCP_ORGANIZATIONS: "org_autre00000000000000" });
    const result = await new DeclaredTool(SPEC, scoped).execute(context());
    expect(result.ok).toBe(false);
    expect(result.data.dispatched).toBe(false);
    /* Un échec nommé, jamais un succès silencieux : l'action a été autorisée, donc
     * l'appelant doit apprendre que rien n'est parti. */
    expect(result.summary).toMatch(/not available to this organisation/);
    /* Un CODE, comme l'autre refus de cette méthode — pas de la prose à analyser. */
    expect(result.data.reason).toBe("destination_unavailable");
    expect(String(result.data.detail)).toMatch(/local-fixture|not registered|unknown/i);
  });

  /*
   * La faute qu'aucun contrôle de démarrage ne peut voir. `metadata.amount` est une
   * source LÉGITIME, et pourtant absente quand l'agent n'a pas envoyé le champ.
   * `JSON.stringify` efface une valeur `undefined` : dépêcher ferait partir
   * `{"customer":"cus_7","currency":"USD"}` là où Oathrion croit avoir transmis un
   * montant, et un fournisseur qui complète par un défaut rembourserait une somme que
   * personne n'a autorisée.
   */
  it("refuse quand un argument déclaré n'a aucune valeur dans cet appel", async () => {
    const result = await new DeclaredTool(SPEC, envWith()).execute(context({ metadata: {} }));
    expect(result.ok).toBe(false);
    expect(result.data.dispatched).toBe(false);
    expect(result.data.reason).toBe("unprojectable_arguments");
    expect(result.data.arguments).toEqual(["amount ← metadata.amount"]);
  });

  it("compte quand même l'appel : un refus est un événement, pas un silence", async () => {
    const tool = new DeclaredTool(SPEC, envWith());
    await tool.execute(context({ metadata: {} }));
    expect(tool.toolExecutionCount).toBe(1);
  });
});

describe("createDefaultRegistry — ce qu'une déclaration remplace, et ce qu'elle ne peut pas", () => {
  it("sans déclaration, les cinq outils intégrés et rien d'autre", () => {
    const registry = createDefaultRegistry({} as NodeJS.ProcessEnv);
    expect(registry.list()).toHaveLength(5);
    expect(registry.resolve("refund")?.id).toBe("refund_tool");
  });

  /*
   * Le remplacement est l'EFFET VOULU de la déclaration, pas un accident : un pilote
   * veut que son `refund` parte chez son fournisseur et non dans le simulateur.
   */
  it("un outil déclaré remplace l'outil intégré de son verbe", () => {
    const registry = createDefaultRegistry(envWith({ OATHRION_TOOLS: tools([SPEC]) }));
    expect(registry.resolve("refund")?.id).toBe("acme_refund");
    /* L'intégré reste dans l'inventaire — il n'est plus câblé, ce n'est pas la même
     * chose que ne plus exister. */
    expect(registry.get("refund_tool")).toBeDefined();
    expect(registry.list()).toHaveLength(6);
  });

  /*
   * LE CHAMP NÉ D'UN PASSAGE DE `verify:tools`.
   *
   * L'inventaire montrait DEUX outils annonçant « non simulé » — le déclaré et
   * l'intégré qu'il remplace, qui dépêcherait aussi si un verbe lui était encore
   * câblé — et rien ne disait lequel une action atteindrait. Un pilote n'avait aucun
   * moyen, par l'API, de confirmer que sa déclaration avait pris effet.
   */
  it("l'inventaire dit quels verbes chaque outil sert réellement", () => {
    const registry = createDefaultRegistry(envWith({ OATHRION_TOOLS: tools([SPEC]) }));
    expect(registry.actionsFor("acme_refund")).toEqual(["refund"]);
    /* Un tableau vide est une INFORMATION : l'outil existe, plus aucun verbe n'y mène. */
    expect(registry.actionsFor("refund_tool")).toEqual([]);
  });

  it("… et le dérive de la table de routage, pas d'un champ porté par l'outil", () => {
    const registry = createDefaultRegistry({} as NodeJS.ProcessEnv);
    expect(registry.actionsFor("refund_tool")).toEqual(["refund"]);
    expect(registry.actionsFor("inexistant")).toEqual([]);
  });

  it("l'outil déclaré apparaît dans l'inventaire avec son étiquette", () => {
    const registry = createDefaultRegistry(envWith({ OATHRION_TOOLS: tools([SPEC]) }));
    const tool = registry.get("acme_refund");
    expect(tool?.name).toBe("Acme refunds");
    expect(tool?.description).toMatch(/refunds\.create/);
  });

  /*
   * LA BARRIÈRE QU'UNE DÉCLARATION NE FRANCHIT PAS.
   *
   * Câbler un outil sur un verbe est ce qui transforme une décision en effet de bord.
   * Le constructeur de `ToolRegistry` refuse un verbe absent de
   * `shared/policy/actions.ts` — et c'est cette entrée-là qui fait appliquer la
   * barrière de permission, le plafond de mandat et l'allowlist de domaine. Un
   * connecteur déclaré rencontre ce refus au MÊME endroit qu'un outil intégré.
   */
  it("refuse de câbler un verbe absent du catalogue, au démarrage", () => {
    expect(() =>
      createDefaultRegistry(
        envWith({ OATHRION_TOOLS: tools([{ ...SPEC, actions: ["wire_transfer_anywhere"] }]) }),
      ),
    ).toThrow(/not declared in shared\/policy\/actions\.ts/);
  });

  /*
   * LA CAPTURE SILENCIEUSE, REFUSÉE.
   *
   * Le remplacement légitime passe par le VERBE, et l'inventaire le montre. Reprendre
   * l'IDENTIFIANT d'un outil intégré serait invisible : la ligne intégrée
   * `refund: "refund_tool"` résoudrait vers l'outil déclaré, donc une déclaration ne
   * revendiquant que `delete_customer` capturerait `refund` au passage.
   */
  it("refuse une déclaration qui reprend l'identifiant d'un outil intégré", () => {
    const usurper = { ...SPEC, id: "refund_tool", actions: ["delete_customer"] };
    expect(() => createDefaultRegistry(envWith({ OATHRION_TOOLS: tools([usurper]) }))).toThrow(
      /reuses the id of a built-in tool/,
    );
  });

  it("… et sans ce refus, le verbe `refund` aurait suivi l'identifiant", () => {
    /* La démonstration de ce que le refus empêche : seul `delete_customer` est
     * revendiqué, et pourtant `refund` pointerait sur l'usurpateur. */
    const registry = createDefaultRegistry(
      envWith({ OATHRION_TOOLS: tools([{ ...SPEC, id: "acme_other", actions: ["delete_customer"] }]) }),
    );
    expect(registry.resolve("refund")?.id).toBe("refund_tool");
    expect(registry.resolve("delete_customer")?.id).toBe("acme_other");
  });

  it("une déclaration mal formée empêche la construction du registre", () => {
    expect(() => createDefaultRegistry(envWith({ OATHRION_TOOLS: "{nope" }))).toThrow(DeclaredToolError);
  });
});
