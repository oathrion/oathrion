/**
 * Tests de l'adaptateur de framework.
 *
 * Quatre parties, et le découpage est l'argument :
 *
 *   1. **Les garanties de l'adaptateur**, contre un transport bouchonné. Elles tournent
 *      partout et ne doivent jamais régresser.
 *   2. **Chaque forme d'outil** que les frameworks donnent à « exécuter » — `execute`,
 *      `invoke`, `call`, `func`, `run`, `_run`, et une fonction nue. C'est ici que
 *      « agnostique au framework » devient un résultat de test et non une intention.
 *   3. **Un vrai outil LangChain**, enrobé DIRECTEMENT, quand `@langchain/core` est
 *      installé. Sinon ces tests SKIPPENT en imprimant pourquoi, plutôt que de passer en
 *      silence : une suite verte qui n'a jamais chargé de framework ne prouverait rien.
 *   4. **La preuve structurelle** : le source de l'adaptateur n'importe aucun framework.
 *      C'est la seule preuve d'agnosticisme qui ne se périme pas — énumérer les
 *      frameworks qui marchent ne dit rien de celui qui sortira le mois prochain.
 *
 * ## Ce qu'une « forme » prouve, et ce qu'elle ne prouve pas
 *
 * La partie 2 utilise des objets écrits à la main qui reproduisent la forme publiée de
 * chaque framework. **Une forme n'est pas le framework.** Elle prouve que l'adaptateur
 * enrobe cette signature correctement ; elle ne prouve pas qu'une version donnée de
 * LlamaIndex se comporte comme sa documentation. Seule la partie 3 charge du code tiers,
 * et elle n'en charge qu'un — c'est écrit dans `docs/limitations.md` en ces termes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OathrionClient } from "../../sdk/typescript/src";
import {
  EXECUTE_METHODS,
  ToolNotAuthorizedError,
  executeMethodOf,
  withPlacet,
  withOathrion,
} from "./with-placet";

const BASE = "http://placet.test";

/** Un client Oathrion dont le transport rend exactement ce qu'un test dicte. */
function clientReturning(body: unknown, status = 200): OathrionClient {
  return new OathrionClient({
    baseUrl: BASE,
    apiKey: "test-key-000000000000",
    fetch: async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  });
}

/** Un client Oathrion qui ne peut pas joindre le serveur. */
function unreachableClient(): OathrionClient {
  return new OathrionClient({
    baseUrl: BASE,
    apiKey: "test-key-000000000000",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
}

const decisionBody = (decision: string, extra: Record<string, unknown> = {}) => ({
  decision,
  reason: `test ${decision}`,
  policyId: "pol_test",
  policyName: "Test policy",
  risk: "low",
  requestId: "req_test",
  approvalId: null,
  ...extra,
});

interface Args { id: string; amount: number }

/**
 * Les options, avec UN SEUL type d'argument pour `target` et `input`.
 *
 * Le premier jet déclarait `target: (a: { id: string })` et
 * `input: (a: { amount: number })` — deux formes différentes pour le même appel. Ça
 * passait par contravariance tant que `ToolLike` était une interface ; le typage plus
 * strict de cette version l'a refusé, et il avait raison : les deux fonctions reçoivent
 * les MÊMES arguments, ceux de l'outil.
 */
const opts = (client: OathrionClient, action?: string) => ({
  client,
  agentId: "agt_support_bot",
  ...(action === undefined ? {} : { action }),
  target: (a: Args) => a.id,
  input: (a: Args) => ({ amount: a.amount, currency: "EUR", category: "refunds" }),
});

/* -------------------------------------------------------------------------- */
/* 1. Les garanties de l'adaptateur                                            */
/* -------------------------------------------------------------------------- */

function spyTool() {
  return {
    name: "stripe.refund",
    calls: 0,
    description: "Rembourse un client.",
    schema: { type: "object", properties: { id: { type: "string" } } },
    async execute(args: Args): Promise<string> {
      this.calls += 1;
      return `refunded ${args.amount} to ${args.id}`;
    },
  };
}

describe("withOathrion — les garanties", () => {
  it("exécute l'outil sur ALLOW et rend son résultat inchangé", async () => {
    const tool = spyTool();
    const wrapped = withOathrion(tool, opts(clientReturning(decisionBody("ALLOW"))));
    await expect(wrapped.execute({ id: "cus_1", amount: 75 })).resolves.toBe("refunded 75 to cus_1");
    expect(tool.calls).toBe(1);
  });

  it("n'exécute PAS l'outil sur BLOCK", async () => {
    const tool = spyTool();
    const wrapped = withOathrion(tool, opts(clientReturning(decisionBody("BLOCK"))));
    await expect(wrapped.execute({ id: "cus_1", amount: 75 })).rejects.toThrow(ToolNotAuthorizedError);
    expect(tool.calls).toBe(0);
  });

  /*
   * Le test le plus important du fichier. Une action retenue n'est PAS autorisée ;
   * traiter une attente comme un oui est le pire défaut qu'une intégration puisse avoir.
   */
  it("n'exécute PAS l'outil sur APPROVAL_REQUIRED", async () => {
    const tool = spyTool();
    const wrapped = withOathrion(
      tool,
      opts(clientReturning(decisionBody("APPROVAL_REQUIRED", { approvalId: "apr_1" }))),
    );
    await expect(wrapped.execute({ id: "cus_1", amount: 750 })).rejects.toThrow(ToolNotAuthorizedError);
    expect(tool.calls).toBe(0);
  });

  it("n'exécute PAS l'outil quand Oathrion est injoignable", async () => {
    const tool = spyTool();
    const wrapped = withOathrion(tool, opts(unreachableClient()));
    await expect(wrapped.execute({ id: "cus_1", amount: 75 })).rejects.toThrow();
    expect(tool.calls).toBe(0);
  });

  it("n'exécute PAS l'outil quand le credential est refusé", async () => {
    const tool = spyTool();
    const wrapped = withOathrion(tool, opts(clientReturning({ error: "Invalid credentials" }, 401)));
    await expect(wrapped.execute({ id: "cus_1", amount: 75 })).rejects.toThrow();
    expect(tool.calls).toBe(0);
  });

  it("n'exécute PAS l'outil sur une décision qu'il ne reconnaît pas", async () => {
    const tool = spyTool();
    const wrapped = withOathrion(tool, opts(clientReturning(decisionBody("PROBABLY_FINE"))));
    await expect(wrapped.execute({ id: "cus_1", amount: 75 })).rejects.toThrow();
    expect(tool.calls).toBe(0);
  });

  it("évalue le nom de l'outil par défaut, et la surcharge quand elle est donnée", async () => {
    const seen: string[] = [];
    const spyClient = new OathrionClient({
      baseUrl: BASE,
      apiKey: "test-key-000000000000",
      fetch: async (_url, init) => {
        seen.push(String((JSON.parse(String(init?.body ?? "{}")) as { action?: string }).action));
        return new Response(JSON.stringify(decisionBody("ALLOW")), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });

    await withOathrion(spyTool(), opts(spyClient)).execute({ id: "c", amount: 1 });
    await withOathrion(spyTool(), opts(spyClient, "billing.refund")).execute({ id: "c", amount: 1 });
    expect(seen).toEqual(["stripe.refund", "billing.refund"]);
  });

  it("enregistre la décision par défaut, parce qu'un vrai appel va avoir lieu", async () => {
    let persisted: unknown;
    const spyClient = new OathrionClient({
      baseUrl: BASE,
      apiKey: "test-key-000000000000",
      fetch: async (_url, init) => {
        persisted = (JSON.parse(String(init?.body ?? "{}")) as { persist?: unknown }).persist;
        return new Response(JSON.stringify(decisionBody("ALLOW")), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });
    await withOathrion(spyTool(), opts(spyClient)).execute({ id: "c", amount: 1 });
    expect(persisted).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Chaque forme d'outil                                                     */
/* -------------------------------------------------------------------------- */

describe("withOathrion — n'importe quelle forme d'outil", () => {
  /**
   * Une forme par framework, reproduite depuis son API publiée.
   *
   * Ce sont des objets écrits à la main : ils prouvent que l'adaptateur enrobe la
   * signature, PAS qu'une version donnée du framework se comporte comme sa
   * documentation. Seule la partie 3 charge du code tiers.
   */
  const shapes: Array<{ framework: string; method: string; build: (onRun: () => void) => object }> = [
    {
      framework: "SDK ai (Vercel)", method: "execute",
      build: (onRun) => ({ name: "stripe.refund", description: "d", parameters: {}, execute: async (a: Args) => { onRun(); return `ok ${a.amount}`; } }),
    },
    {
      framework: "LangChain / LangGraph", method: "invoke",
      build: (onRun) => ({ name: "stripe.refund", schema: {}, invoke: async (a: Args) => { onRun(); return `ok ${a.amount}`; } }),
    },
    {
      framework: "LlamaIndex", method: "call",
      build: (onRun) => ({ name: "stripe.refund", metadata: {}, call: async (a: Args) => { onRun(); return `ok ${a.amount}`; } }),
    },
    {
      framework: "LangChain (implémentation nue)", method: "func",
      build: (onRun) => ({ name: "stripe.refund", func: async (a: Args) => { onRun(); return `ok ${a.amount}`; } }),
    },
    {
      framework: "convention générique", method: "run",
      build: (onRun) => ({ name: "stripe.refund", run: async (a: Args) => { onRun(); return `ok ${a.amount}`; } }),
    },
    {
      framework: "CrewAI (portage)", method: "_run",
      build: (onRun) => ({ name: "stripe.refund", _run: async (a: Args) => { onRun(); return `ok ${a.amount}`; } }),
    },
  ];

  for (const { framework, method, build } of shapes) {
    describe(`${framework} — méthode « ${method} »`, () => {
      it("est exécutée sur ALLOW", async () => {
        let ran = 0;
        const wrapped = build(() => { ran += 1; }) as Record<string, (a: Args) => Promise<string>>;
        const guarded = withOathrion(wrapped, opts(clientReturning(decisionBody("ALLOW")))) as typeof wrapped;
        await expect(guarded[method]!({ id: "cus_1", amount: 75 })).resolves.toBe("ok 75");
        expect(ran).toBe(1);
      });

      it("n'est PAS exécutée sur APPROVAL_REQUIRED", async () => {
        let ran = 0;
        const wrapped = build(() => { ran += 1; }) as Record<string, (a: Args) => Promise<string>>;
        const guarded = withOathrion(wrapped, opts(clientReturning(decisionBody("APPROVAL_REQUIRED")))) as typeof wrapped;
        await expect(guarded[method]!({ id: "cus_1", amount: 750 })).rejects.toThrow(ToolNotAuthorizedError);
        expect(ran).toBe(0);
      });
    });
  }

  it("enrobe aussi une fonction nue, en gardant son nom", async () => {
    let ran = 0;
    async function stripeRefund(a: Args): Promise<string> { ran += 1; return `ok ${a.amount}`; }
    const guarded = withOathrion(stripeRefund, opts(clientReturning(decisionBody("ALLOW"))));
    // Le nom survit : certains frameworks construisent le schéma d'outil depuis `fn.name`.
    expect(guarded.name).toBe("stripeRefund");
    await expect(guarded({ id: "cus_1", amount: 75 })).resolves.toBe("ok 75");
    expect(ran).toBe(1);
  });

  it("une fonction nue n'est PAS exécutée sur BLOCK", async () => {
    let ran = 0;
    const guarded = withOathrion(
      async (a: Args) => { ran += 1; return `ok ${a.amount}`; },
      opts(clientReturning(decisionBody("BLOCK")), "stripe.refund"),
    );
    await expect(guarded({ id: "cus_1", amount: 75 })).rejects.toThrow(ToolNotAuthorizedError);
    expect(ran).toBe(0);
  });

  /*
   * LE TEST QUE L'UN DES MUTANTS A EXIGÉ.
   *
   * Le commentaire de `ToolFn` affirme que les arguments supplémentaires sont transmis,
   * parce que LangChain appelle `invoke(input, config)` — callbacks, identifiant de run,
   * signal d'annulation. Un mutant remplaçant `original.call(tool, ...args)` par
   * `original.call(tool, args[0])` passait **32/32** : l'affirmation n'était vérifiée par
   * rien. Un outil enrobé aurait perdu sa configuration à chaque appel, en silence.
   */
  it("transmet TOUS les arguments, pas seulement le premier", async () => {
    const seen: unknown[] = [];
    const tool = {
      name: "stripe.refund",
      invoke: async (a: Args, config?: { runName?: string }) => {
        seen.push(a, config);
        return `ok ${a.amount}`;
      },
    };
    const guarded = withOathrion(tool, opts(clientReturning(decisionBody("ALLOW"))));
    await guarded.invoke({ id: "cus_1", amount: 75 }, { runName: "refund-run" });
    expect(seen).toEqual([{ id: "cus_1", amount: 75 }, { runName: "refund-run" }]);
  });

  it("transmet aussi les arguments supplémentaires d'une fonction nue", async () => {
    const seen: unknown[] = [];
    const guarded = withOathrion(
      async (a: Args, signal?: AbortSignal) => { seen.push(a, signal); return "ok"; },
      opts(clientReturning(decisionBody("ALLOW")), "stripe.refund"),
    );
    const controller = new AbortController();
    await guarded({ id: "c", amount: 1 }, controller.signal);
    expect(seen[1]).toBe(controller.signal);
  });

  /*
   * LE TEST QUI A MOTIVÉ LA RÉÉCRITURE. Le premier adaptateur reconstruisait
   * `{ name, execute }` et jetait le reste. Un outil LangChain enrobé perdait donc son
   * `schema`, et LangChain refusait de l'appeler — « agnostique » était faux de la façon
   * la plus coûteuse : ça compilait.
   */
  it("conserve tout le reste de l'objet — description, schéma, métadonnées", () => {
    const tool = {
      name: "stripe.refund",
      description: "Rembourse un client.",
      schema: { type: "object", required: ["id"] },
      returnDirect: false,
      execute: async (a: Args) => `ok ${a.amount}`,
    };
    const guarded = withOathrion(tool, opts(clientReturning(decisionBody("ALLOW"))));
    expect(guarded.description).toBe("Rembourse un client.");
    expect(guarded.schema).toEqual({ type: "object", required: ["id"] });
    expect(guarded.returnDirect).toBe(false);
    expect(guarded.name).toBe("stripe.refund");
  });

  it("conserve les méthodes héritées du prototype — un outil est souvent une instance", async () => {
    class FrameworkTool {
      readonly name = "stripe.refund";
      readonly schema = { type: "object" };
      ran = 0;
      async invoke(a: Args): Promise<string> { this.ran += 1; return `ok ${a.amount}`; }
      describe(): string { return `outil ${this.name}`; }
    }
    const tool = new FrameworkTool();
    const guarded = withOathrion(tool, opts(clientReturning(decisionBody("ALLOW"))));
    // Une méthode du prototype qu'un spread aurait perdue.
    expect(typeof guarded.describe).toBe("function");
    expect(guarded.describe()).toBe("outil stripe.refund");
    await expect(guarded.invoke({ id: "c", amount: 7 })).resolves.toBe("ok 7");
    // `this` est l'outil D'ORIGINE : son état privé est celui qui bouge.
    expect(tool.ran).toBe(1);
  });

  it("refuse TOUT DE SUITE un outil sans méthode exécutable, en nommant les candidats", () => {
    expect(() =>
      withOathrion({ name: "inerte" } as never, opts(clientReturning(decisionBody("ALLOW")))),
    ).toThrow(/n'expose aucune méthode exécutable/);
    expect(() =>
      withOathrion({ name: "inerte" } as never, opts(clientReturning(decisionBody("ALLOW")))),
    ).toThrow(new RegExp(EXECUTE_METHODS.join(", ")));
  });

  it("`execute` gagne sur `invoke` quand les deux existent", async () => {
    /*
     * L'ordre de `EXECUTE_METHODS` est un choix et non un hasard : on enrobe l'entrée
     * publique, celle qui valide les arguments, plutôt que l'implémentation nue.
     */
    const order: string[] = [];
    const tool = {
      name: "t",
      execute: async (a: Args) => { order.push("execute"); return `ok ${a.amount}`; },
      invoke: async (a: Args) => { order.push("invoke"); return `ok ${a.amount}`; },
    };
    expect(executeMethodOf(tool)).toBe("execute");
    const guarded = withOathrion(tool, opts(clientReturning(decisionBody("ALLOW"))));
    await guarded.execute({ id: "c", amount: 1 });
    await guarded.invoke({ id: "c", amount: 1 });
    // `invoke` n'est pas enrobée : seule la première trouvée l'est, et c'est dit.
    expect(order).toEqual(["execute", "invoke"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Un vrai framework                                                        */
/* -------------------------------------------------------------------------- */

const langchain = await (async () => {
  try {
    return await import("@langchain/core/tools");
  } catch {
    return null;
  }
})();

describe.skipIf(langchain === null)("withOathrion sur un VRAI outil LangChain", () => {
  if (langchain === null) {
    console.warn(
      "\n[with-placet.test] SKIPPÉ : @langchain/core n'est pas installé, donc l'adaptateur " +
        "n'a PAS été éprouvé contre un framework réel dans ce passage.\n",
    );
  }

  const buildTool = (onRun: () => void) => {
    const { DynamicStructuredTool } = langchain!;
    return new DynamicStructuredTool({
      name: "stripe_refund",
      description: "Rembourse un client.",
      schema: { type: "object", properties: { id: { type: "string" }, amount: { type: "number" } } },
      func: async (args: Record<string, unknown>) => {
        onRun();
        return `refunded ${String(args.amount)}`;
      },
    });
  };

  /*
   * ENROBÉ DIRECTEMENT, et c'est le progrès que cette version apporte.
   *
   * L'ancien test devait écrire à la main `{ name: lc.name, execute: a => lc.invoke(a) }`
   * — une cale, parce que l'adaptateur exigeait `execute`. Qu'il ait fallu l'écrire était
   * la preuve que « agnostique au framework » n'était pas vrai : le client payait
   * l'adaptation. `withOathrion(lc, …)` suffit maintenant.
   */
  it("enrobe l'outil LangChain sans cale, et l'exécute sur ALLOW", async () => {
    let ran = 0;
    const lc = buildTool(() => { ran += 1; });
    const guarded = withOathrion(lc, {
      client: clientReturning(decisionBody("ALLOW")),
      agentId: "agt_support_bot",
      action: "stripe.refund",
      target: (a: Args) => a.id,
      input: (a: Args) => ({ amount: a.amount, currency: "EUR" }),
    });

    await expect(guarded.invoke({ id: "cus_1", amount: 75 } as never)).resolves.toContain("refunded 75");
    expect(ran).toBe(1);
  });

  it("n'exécute pas l'outil LangChain sur APPROVAL_REQUIRED", async () => {
    let ran = 0;
    const lc = buildTool(() => { ran += 1; });
    const guarded = withOathrion(lc, {
      client: clientReturning(decisionBody("APPROVAL_REQUIRED", { approvalId: "apr_1" })),
      agentId: "agt_support_bot",
      action: "stripe.refund",
      target: (a: Args) => a.id,
      input: (a: Args) => ({ amount: a.amount, currency: "EUR" }),
    });

    await expect(guarded.invoke({ id: "cus_1", amount: 7500 } as never)).rejects.toThrow(ToolNotAuthorizedError);
    expect(ran).toBe(0);
  });

  it("l'outil enrobé garde le nom et la description que LangChain lit", () => {
    const lc = buildTool(() => undefined);
    const guarded = withOathrion(lc, {
      client: clientReturning(decisionBody("ALLOW")),
      target: (a: Args) => a.id,
    });
    expect(guarded.name).toBe("stripe_refund");
    expect(guarded.description).toBe("Rembourse un client.");
    // Le schéma survit : sans lui, LangChain refuse d'appeler l'outil.
    expect(guarded.schema).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. La preuve structurelle                                                   */
/* -------------------------------------------------------------------------- */

describe("l'agnosticisme, prouvé par l'absence de dépendance", () => {
  const source = readFileSync(path.join(import.meta.dirname, "with-placet.ts"), "utf8");

  it("l'adaptateur n'importe AUCUN framework", () => {
    /*
     * La seule preuve d'agnosticisme qui ne se périme pas. Énumérer les frameworks qui
     * marchent ne dit rien de celui qui sortira le mois prochain ; une absence de
     * dépendance, elle, reste vraie — et elle est vérifiable en lisant le fichier.
     */
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(imports).toEqual(["../../sdk/typescript/src"]);
  });

  it("… et ne nomme aucun framework ailleurs que dans ses commentaires", () => {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const framework of ["langchain", "llamaindex", "crewai", "openai", "@ai-sdk", "mastra"]) {
      expect(code.toLowerCase()).not.toContain(framework);
    }
  });

  it("l'alias hérité `withPlacet` fonctionne encore", async () => {
    /*
     * Cet adaptateur est un exemple que le client COPIE dans son dépôt : une ligne
     * `withPlacet(tool, …)` vit chez lui, et le renommage ne doit pas la casser.
     */
    expect(withPlacet).toBe(withOathrion);
    const tool = spyTool();
    await withPlacet(tool, opts(clientReturning(decisionBody("ALLOW")))).execute({ id: "c", amount: 1 });
    expect(tool.calls).toBe(1);
  });
});
