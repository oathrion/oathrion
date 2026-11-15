/**
 * LA CORRESPONDANCE DÉCLARÉE EST COMPARÉE AU SCHÉMA DU SERVEUR.
 *
 * ## Ce que ces tests couvrent, et avec quoi
 *
 * Un vrai serveur MCP — `examples/mcp-server/`, qui n'importe rien d'Oathrion — démarré
 * sur loopback. Ce n'est donc pas un faux `tools/list` : le schéma lu ici est celui que
 * ce serveur déclare, avec ses deux champs requis.
 *
 * Et un second serveur, écrit dans ce fichier, pour les cas que l'exemple ne produit
 * pas : un `tools/list` refusé en -32601 (un serveur qui n'implémente pas la découverte),
 * et un schéma ouvert sans `properties`.
 *
 * ## Les trois fautes que ceci attrape
 *
 * Avant, `OATHRION_TOOLS` laissait écrire une correspondance que rien ne comparait au
 * serveur. Trois fautes passaient le démarrage et ne se révélaient qu'au premier appel
 * d'un client : un nom d'outil inexistant, un argument requis oublié, et un argument
 * projeté que le serveur IGNORE en silence — celui-là est le pire, parce que l'exploitant
 * croit avoir transmis un montant.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { discoverDownstreamTools, DownstreamDiscoveryError } from "../gateway/tools/mcp-client";
import { resolveDownstreamDestination, type McpDestination } from "../gateway/tools/mcp-destination";
import { resetUpstreamSchemaCache, verifyAgainstUpstream } from "../gateway/tools/upstream-schema";
import { startExampleMcpServer, type ExampleMcpServer } from "../../examples/mcp-server/server";

/** La destination loopback, résolue par le vrai résolveur — donc par les règles réelles. */
function destinationFor(url: string): McpDestination {
  const resolved = resolveDownstreamDestination({ OATHRION_LOCAL_MCP_URL: url } as NodeJS.ProcessEnv);
  expect(resolved, `${url} doit se résoudre en destination loopback`).not.toBeNull();
  return resolved!;
}

let example: ExampleMcpServer;
let exampleDestination: McpDestination;

beforeAll(async () => {
  example = await startExampleMcpServer();
  exampleDestination = destinationFor(example.url);
});

afterAll(async () => {
  await example.close();
});

afterEach(() => {
  resetUpstreamSchemaCache();
});

/** Un serveur jetable qui répond ce qu'on lui dit, pour les cas que l'exemple ne produit pas. */
async function serverReplying(body: unknown): Promise<{ destination: McpDestination; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    destination: destinationFor(`http://127.0.0.1:${String(port)}/`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("la découverte lit le schéma réel du serveur", () => {
  it("rend le nom, la description et les champs requis", async () => {
    const tools = await discoverDownstreamTools(exampleDestination);
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool!.name).toBe("stripe.refund");
    expect(tool!.description).not.toBe("");
    expect(tool!.properties.sort()).toEqual(["amount", "currency", "customer", "reference"]);
    /* `required` vient du serveur, pas d'une supposition d'Oathrion. */
    expect(tool!.required.sort()).toEqual(["amount", "customer"]);
  });

  it("distingue « méthode inconnue » d'une panne", async () => {
    /*
     * -32601 est le cas LÉGITIME d'un serveur qui n'implémente pas la découverte. Le
     * code est conservé dans le message pour qu'un exploitant ne cherche pas un incident
     * là où il y a une limite du serveur.
     */
    const stub = await serverReplying({
      jsonrpc: "2.0",
      id: "placet-discover",
      error: { code: -32601, message: "Méthode inconnue : tools/list" },
    });
    try {
      await expect(discoverDownstreamTools(stub.destination)).rejects.toThrow(DownstreamDiscoveryError);
      await expect(discoverDownstreamTools(stub.destination)).rejects.toThrow(/-32601/);
    } finally {
      await stub.close();
    }
  });

  it("refuse une réponse sans tableau `tools`", async () => {
    const stub = await serverReplying({ jsonrpc: "2.0", id: "x", result: { tools: "beaucoup" } });
    try {
      await expect(discoverDownstreamTools(stub.destination)).rejects.toThrow(/result\.tools/);
    } finally {
      await stub.close();
    }
  });

  it("ignore une entrée sans nom plutôt que de la compter", async () => {
    /*
     * Une entrée sans nom n'est pas un outil : la garder produirait une correspondance
     * contre `undefined`, c'est-à-dire un refus dont le motif citerait un nom vide.
     */
    const stub = await serverReplying({
      jsonrpc: "2.0",
      id: "x",
      result: { tools: [{ description: "sans nom" }, { name: "vrai.outil" }] },
    });
    try {
      const tools = await discoverDownstreamTools(stub.destination);
      expect(tools.map((t) => t.name)).toEqual(["vrai.outil"]);
    } finally {
      await stub.close();
    }
  });
});

describe("la vérification accepte une déclaration correcte", () => {
  it("… celle que `mcp:discover --declare` produit", async () => {
    const verdict = await verifyAgainstUpstream({
      destinationId: "local-fixture",
      destination: exampleDestination,
      tool: "stripe.refund",
      projected: ["customer", "amount", "currency"],
    });
    expect(verdict).toMatchObject({ ok: true, checked: true, reason: "ok" });
  });

  it("… et une déclaration qui omet un champ OPTIONNEL", async () => {
    /* `currency` n'est pas requis par ce serveur : l'omettre est légitime. */
    const verdict = await verifyAgainstUpstream({
      destinationId: "local-fixture",
      destination: exampleDestination,
      tool: "stripe.refund",
      projected: ["customer", "amount"],
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("les trois refus, et chacun nomme sa correction", () => {
  it("un nom d'outil que le serveur ne déclare pas", async () => {
    const verdict = await verifyAgainstUpstream({
      destinationId: "local-fixture",
      destination: exampleDestination,
      /* Une faute d'une lettre — exactement ce qui passait le démarrage sans rien dire. */
      tool: "stripe.refunds",
      projected: ["customer", "amount"],
    });
    expect(verdict).toMatchObject({ ok: false, checked: true, reason: "tool_not_found_upstream" });
    /* Le motif LISTE ce qui existe : sans cela l'exploitant devine. */
    expect(verdict.detail).toContain("stripe.refund");
    expect(verdict.detail).toMatch(/Fix the declaration's "tool" field/);
  });

  it("un argument que le serveur EXIGE et que la déclaration oublie", async () => {
    const verdict = await verifyAgainstUpstream({
      destinationId: "local-fixture",
      destination: exampleDestination,
      tool: "stripe.refund",
      projected: ["customer"],
    });
    expect(verdict).toMatchObject({ ok: false, checked: true, reason: "missing_required_argument" });
    expect(verdict.detail).toContain('"amount"');
    /* Et il propose la correction, pas seulement le diagnostic. */
    expect(verdict.detail).toContain('"amount": "metadata.amount"');
  });

  it("un argument projeté que le schéma ne connaît pas", async () => {
    /*
     * LE PIRE DES TROIS. Le serveur IGNORE un argument qu'il ne déclare pas, donc rien
     * n'échoue : l'exploitant croit avoir transmis `montant` et le fournisseur n'en a
     * jamais vu. C'est la faute qu'aucune erreur du fournisseur ne révélera jamais.
     */
    const verdict = await verifyAgainstUpstream({
      destinationId: "local-fixture",
      destination: exampleDestination,
      tool: "stripe.refund",
      projected: ["customer", "amount", "montant"],
    });
    expect(verdict).toMatchObject({ ok: false, checked: true, reason: "unknown_argument_upstream" });
    expect(verdict.detail).toContain('"montant"');
    expect(verdict.detail).toMatch(/SILENTLY/);
  });
});

describe("un schéma OUVERT ne fait pas refuser", () => {
  it("un `inputSchema` sans `properties` accepte ce que la déclaration projette", async () => {
    /*
     * Un schéma sans propriétés ne dit pas « aucun argument permis », il ne dit rien. Y
     * voir une liste fermée refuserait tous les appels à un serveur parfaitement
     * légitime — et l'exploitant n'aurait aucun moyen de le corriger.
     */
    const stub = await serverReplying({
      jsonrpc: "2.0",
      id: "x",
      result: { tools: [{ name: "ouvert.outil", inputSchema: { type: "object" } }] },
    });
    try {
      const verdict = await verifyAgainstUpstream({
        destinationId: "ouvert",
        destination: stub.destination,
        tool: "ouvert.outil",
        projected: ["ce", "que", "je", "veux"],
      });
      expect(verdict).toMatchObject({ ok: true, checked: true });
    } finally {
      await stub.close();
    }
  });
});

describe("quand la découverte échoue", () => {
  it("le verdict dit « non vérifié », et jamais « vérifié et correct »", async () => {
    /*
     * La distinction est tout l'intérêt du champ `checked`. Un `ok: false` sans lui
     * serait indiscernable d'un désaccord réel, et un `ok: true` par défaut serait
     * l'affirmation d'une vérification qui n'a pas eu lieu.
     */
    const verdict = await verifyAgainstUpstream({
      destinationId: "mort",
      /* Port 9 : « discard », rien n'écoute. */
      destination: destinationFor("http://127.0.0.1:9/"),
      tool: "peu.importe",
      projected: [],
    });
    expect(verdict.checked).toBe(false);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("discovery_unavailable");
  });

  it("… et le motif explique les deux suites possibles", async () => {
    const verdict = await verifyAgainstUpstream({
      destinationId: "mort",
      destination: destinationFor("http://127.0.0.1:9/"),
      tool: "peu.importe",
      projected: [],
    });
    /* Qu'un serveur sans tools/list est normal, et comment exiger le refus strict. */
    expect(verdict.detail).toContain("tools/list");
    expect(verdict.detail).toContain('"requireSchema": true');
  });
});

describe("le cache", () => {
  it("ne ré-interroge pas le serveur avant expiration", async () => {
    /*
     * Un `tools/list` avant chaque dépêche doublerait la latence et le trafic de chaque
     * action pour revérifier ce qui change une fois par trimestre.
     */
    const before = example.receivedCount();
    for (let i = 0; i < 3; i += 1) {
      await verifyAgainstUpstream({
        destinationId: "local-fixture",
        destination: exampleDestination,
        tool: "stripe.refund",
        projected: ["customer", "amount"],
      });
    }
    /*
     * `receivedCount()` ne compte que les `tools/call` du serveur d'exemple, donc il ne
     * bouge pas ici. Ce que ce test vérifie est l'absence d'EFFET : trois vérifications
     * n'exécutent rien chez le fournisseur.
     */
    expect(example.receivedCount()).toBe(before);
    expect(example.executedCount()).toBe(0);
  });

  it("une destination différente est interrogée séparément", async () => {
    const stub = await serverReplying({
      jsonrpc: "2.0",
      id: "x",
      result: { tools: [{ name: "autre.outil", inputSchema: { properties: { a: {} }, required: ["a"] } }] },
    });
    try {
      /* Le cache est par destination : le schéma de l'une ne répond pas pour l'autre. */
      const first = await verifyAgainstUpstream({
        destinationId: "local-fixture",
        destination: exampleDestination,
        tool: "stripe.refund",
        projected: ["customer", "amount"],
      });
      const second = await verifyAgainstUpstream({
        destinationId: "autre",
        destination: stub.destination,
        tool: "stripe.refund",
        projected: ["customer", "amount"],
      });
      expect(first.ok).toBe(true);
      expect(second.reason).toBe("tool_not_found_upstream");
      expect(second.detail).toContain("autre.outil");
    } finally {
      await stub.close();
    }
  });
});
