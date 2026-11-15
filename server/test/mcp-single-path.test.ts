/**
 * There must be exactly one path from an MCP request to a tool.
 *
 * WHY A SOURCE-LEVEL TEST AND NOT ONLY A BEHAVIOURAL ONE
 * -----------------------------------------------------
 * `mcp-gateway.test.ts` proves the invariant holds for the calls it makes. It
 * cannot prove that no *future* branch reaches a tool directly, because a test
 * can only observe the paths it exercises — and a second dispatch path added
 * later would very likely come with its own passing tests.
 *
 * So this file reads the source. It is a blunt instrument and it is honest
 * about that below, but it fails loudly the moment someone adds
 * `registry.get(id).execute(...)` to the MCP layer, which is the specific
 * mistake that would make every policy, mandate, approval and audit guarantee
 * apply to REST callers and not to MCP callers.
 *
 * WHAT THIS TEST CANNOT DO
 * ------------------------
 * It is a textual check, so it is defeatable by anyone who wants to defeat it
 * (dynamic property access, an intermediate alias, a new file it does not
 * know to read). It is not a sandbox. It is a tripwire for the accidental
 * version of the mistake, which is the likely one.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp");

function mcpSources(): { file: string; source: string }[] {
  return readdirSync(MCP_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((file) => ({ file, source: readFileSync(join(MCP_DIR, file), "utf8") }));
}

/** Strips comments, so the prose explaining the rule cannot trip the rule. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("MCP has a single path to the tools", () => {
  it("finds the MCP layer where this test expects it", () => {
    // Without this, every assertion below passes vacuously if the directory is
    // ever renamed.
    const files = mcpSources().map((entry) => entry.file);
    expect(files).toContain("router.ts");
    expect(files).toContain("protocol.ts");
  });

  it("never invokes a tool directly", () => {
    /*
     * The rule, stated as narrowly as it can be checked textually: within the
     * MCP layer, the ONLY permitted `.execute(` call is `gateway.execute(`.
     *
     * `registry.resolve(action)` and `registry.get(id)` both return a `Tool`,
     * whose `.execute()` is the raw side effect with no policy evaluation, no
     * mandate check, no approval queue and no audit entry.
     *
     * HOW THIS ASSERTION GOT ITS CURRENT SHAPE
     * ----------------------------------------
     * It was first written as a set of patterns for the shapes a bypass was
     * expected to take, including `.resolve(...)` followed by a member access.
     * A deliberate bypass was then injected into `router.ts` to check the
     * tripwire, and it MISSED it: the mutant stored the tool in a local
     * (`const direct = ctx.registry.resolve(name)`) and called `.execute()` on
     * the variable a line later, so no single pattern matched. Four behavioural
     * tests caught the mutant; this one did not.
     *
     * It was rewritten as a whitelist for that reason. Enumerating what is
     * allowed survives an indirection that enumerating what is forbidden does
     * not, because the call still has to be spelled `.execute(` somewhere.
     */
    for (const { file, source } of mcpSources()) {
      const body = code(source);
      const executeCalls = body.match(/[\w.?[\]]*\.execute\(/g) ?? [];
      for (const call of executeCalls) {
        expect(
          call.endsWith("gateway.execute("),
          `${file} contains "${call}", which is not gateway.execute(). Every tools/call must pass through AgentGateway; a direct tool invocation skips policy, mandate, approval and audit.`,
        ).toBe(true);
      }
    }
  });

  it("never asks the registry to resolve a tool instance", () => {
    /*
     * A second, independent tripwire: `tools/list` needs only `actions()` and
     * `resolve(...)`-for-metadata, and `tool-catalog.ts` legitimately uses the
     * latter to read a tool's name. `router.ts` needs neither, so it is held to
     * the stricter rule — obtaining a tool instance there has no purpose except
     * calling it.
     */
    const router = code(readFileSync(join(MCP_DIR, "router.ts"), "utf8"));
    for (const pattern of [/\.resolve\(/, /registry\.get\(/, /\.run\(/]) {
      expect(
        pattern.test(router),
        `router.ts matches ${pattern}; it must not obtain a tool instance at all.`,
      ).toBe(false);
    }
  });

  it("does not import any tool implementation", () => {
    for (const { file, source } of mcpSources()) {
      const body = code(source);
      expect(
        /from\s+["'][^"']*gateway\/tools/.test(body),
        `${file} imports a tool implementation directly.`,
      ).toBe(false);
    }
  });

  it("reaches the engine only through gateway.execute", () => {
    const router = code(readFileSync(join(MCP_DIR, "router.ts"), "utf8"));
    const calls = router.match(/gateway\.\w+/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    // If a second gateway method is ever called from here, this test is the
    // place to decide deliberately whether that is acceptable.
    expect([...new Set(calls)]).toEqual(["gateway.execute"]);
  });

  it("keeps the transport layer free of any Oathrion concept", () => {
    /*
     * `protocol.ts` parses attacker-controlled input. Keeping it unable to
     * reach a repository, a policy or a tool means a malformed frame can only
     * ever produce a protocol error, never a decision.
     */
    const protocol = code(readFileSync(join(MCP_DIR, "protocol.ts"), "utf8"));
    for (const forbidden of ["gateway", "repositories", "Agent", "policy", "Identity"]) {
      expect(
        protocol.includes(forbidden),
        `protocol.ts references "${forbidden}"; the transport layer must know nothing about Oathrion.`,
      ).toBe(false);
    }
  });

  it("takes the audit actor from the verified identity and never from the request", () => {
    const router = code(readFileSync(join(MCP_DIR, "router.ts"), "utf8"));
    // The actor written to the audit chain must be the credential's identity.
    expect(router).toContain("actor: ctx.identity.name");
    // And there must be no other assignment to `actor`.
    expect((router.match(/actor:/g) ?? []).length).toBe(1);
  });

  it("passes no tenant identifier, because the scope is bound at construction", () => {
    /*
     * Cross-tenant access is impossible here rather than merely checked: the
     * router receives an already tenant-scoped `Repositories` and
     * `AgentGateway`, so there is no organisation parameter to get wrong.
     */
    const router = code(readFileSync(join(MCP_DIR, "router.ts"), "utf8"));
    expect(/organizationId\s*:/.test(router)).toBe(false);
  });

  /* ---------------------------------------------------------------------- */
  /* Phase 4: the downstream MCP client must not become a second path       */
  /* ---------------------------------------------------------------------- */

  describe("the downstream MCP client is reachable only from inside a tool", () => {
    /*
     * Phase 4 gave Oathrion an outbound MCP client so an authorized action can be
     * dispatched to a real downstream server. That is the most dangerous
     * addition in the project so far, because a module that can issue a refund
     * over HTTP is precisely what must never be callable without a decision.
     *
     * `callDownstreamTool` is safe only because of where it sits: inside
     * `CountingTool.run()`, reachable only from `execute()`, reachable only
     * from `AgentGateway.dispatch()`, which runs only after an ALLOW. These
     * tests assert that containment textually, so importing it from a route,
     * from the MCP router, or from any other entry point fails the suite rather
     * than quietly opening a bypass around the chokepoint.
     */
    const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

    /** Every `.ts` file under `server/`, recursively, excluding tests. */
    function serverSources(directory: string = SERVER_DIR): { file: string; source: string }[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          // `test/` is excluded: a test legitimately drives the fixture directly.
          return entry.name === "test" || entry.name === "node_modules" ? [] : serverSources(full);
        }
        return entry.name.endsWith(".ts")
          ? [{ file: full.slice(SERVER_DIR.length + 1), source: readFileSync(full, "utf8") }]
          : [];
      });
    }

    it("is imported only by the tool implementations", () => {
      const importers = serverSources()
        .filter(({ source }) => /from\s+["'][^"']*mcp-client["']/.test(code(source)))
        .map(({ file }) => file)
        .sort();

      /*
       * Two importers, and the second one is Phase 10's addition.
       *
       * `authority/enforcement-point.ts` is the only other module allowed to hold
       * the outbound client, because it is the same KIND of thing as a governed
       * tool: it is a chokepoint, not a caller. It dispatches only after
       * `consumeGrant` has atomically claimed a single-use grant bound to the exact
       * action, agent, tenant and destination — which is asserted below, so this
       * entry cannot become a way to smuggle a dispatch in.
       *
       * Still NOT routes.ts and NOT the MCP router: a route may ask the
       * enforcement point to act, never the downstream client directly.
       *
       * THIRD ENTRY — `gateway/tools/declared-tool.ts`, le registre d'outils déclaré.
       * C'est un outil gouverné comme les cinq autres : il étend `CountingTool`, donc
       * la seule façon d'atteindre sa dépêche est `execute()`, atteignable seulement
       * depuis `AgentGateway.dispatch()`, atteignable seulement après un ALLOW. Ce
       * qu'il ajoute n'est pas un chemin, c'est le fait que la CIBLE soit déclarée par
       * configuration — et elle passe par `resolveDestination`, donc par l'allowlist et
       * les règles d'adresse existantes. Les deux assertions plus bas sont ce qui lui
       * vaut sa place : une seule dépêche, dans `run()`, et jamais avant la résolution.
       */
      /*
       * QUATRIÈME ENTRÉE — `gateway/tools/upstream-schema.ts`, la vérification de la
       * correspondance déclarée.
       *
       * Elle importe `discoverDownstreamTools`, c'est-à-dire `tools/list`, et PAS
       * `callDownstreamTool`. Elle n'ouvre donc aucun chemin vers un effet : lire ce
       * qu'un serveur déclare ne produit rien chez lui. L'assertion juste en dessous est
       * ce qui lui vaut sa place — elle interdit à ce module d'acquérir une dépêche plus
       * tard, ce qui serait le vrai danger : un module qui vérifie et qui agit ne serait
       * plus vérifiable.
       *
       * Elle sort par le MÊME transport gardé que `tools/call`, donc elle ne crée pas de
       * seconde surface d'adresse.
       */
      expect(importers).toEqual([
        join("authority", "enforcement-point.ts"),
        join("gateway", "tools", "declared-tool.ts"),
        join("gateway", "tools", "simulated-tools.ts"),
        join("gateway", "tools", "upstream-schema.ts"),
      ]);
    });

    it("la vérification de schéma lit, et ne dépêche jamais", () => {
      /*
       * L'assertion qui vaut sa place à `upstream-schema.ts` dans l'ensemble clos
       * ci-dessus. Un module qui VÉRIFIE une correspondance et qui pourrait aussi AGIR
       * serait le pire des deux : la vérification cesserait d'être une étape séparable, et
       * un refactor pourrait faire passer un appel par le chemin « lecture ».
       */
      const source = code(readFileSync(join(SERVER_DIR, "gateway", "tools", "upstream-schema.ts"), "utf8"));
      expect(source).toContain("discoverDownstreamTools");
      expect(source).not.toContain("callDownstreamTool");
      /* Et elle n'ouvre pas sa propre socket : le transport gardé reste le seul. */
      expect(source).not.toMatch(/\bfetch\(/);
      expect(source).not.toContain("sendGuarded");
      expect(source).not.toMatch(/from "node:https?"/);
    });

    it("is not reachable from the MCP router or the HTTP routes", () => {
      for (const file of ["mcp/router.ts", "mcp/protocol.ts", "routes.ts"]) {
        const source = code(readFileSync(join(SERVER_DIR, file), "utf8"));
        expect(source).not.toContain("callDownstreamTool");
        expect(source).not.toContain("mcp-client");
      }
    });

    it("is never invoked outside a tool's run()", () => {
      const callers = serverSources()
        .filter(({ source }) => code(source).includes("callDownstreamTool("))
        .map(({ file }) => file)
        .sort();
      /*
       * Two files, and both are expected: `mcp-client.ts` is where the function
       * is declared, and `simulated-tools.ts` is the only place that calls it.
       * Listed explicitly rather than filtered down to one, because the point
       * of this assertion is that the set is CLOSED — a third entry means some
       * module other than a governed tool can dispatch a real action.
       */
      expect(callers).toEqual([
        join("authority", "enforcement-point.ts"),
        join("gateway", "tools", "declared-tool.ts"),
        join("gateway", "tools", "mcp-client.ts"),
        join("gateway", "tools", "simulated-tools.ts"),
      ]);
    });

    /*
     * LES DEUX ASSERTIONS QUI VALENT SA PLACE AU REGISTRE DÉCLARÉ.
     *
     * Un outil déclaré est la première chose dans ce dépôt dont la CIBLE vient de
     * l'environnement. Les deux propriétés ci-dessous sont ce qui empêche cela de
     * devenir un chemin de sortie libre, et elles sont textuelles pour la même raison
     * que l'ordre « réclamer puis agir » du point d'application : un refactor qui les
     * casserait laisserait tous les tests fonctionnels verts.
     */
    it("le registre déclaré ne dépêche que depuis run(), sous CountingTool", () => {
      const source = code(readFileSync(join(SERVER_DIR, "gateway", "tools", "declared-tool.ts"), "utf8"));

      /*
       * `CountingTool` est la porte : `execute()` y est la seule entrée publique, elle
       * compte l'appel, et `AgentGateway.dispatch()` est le seul appelant. Un outil
       * déclaré qui exposerait sa dépêche autrement contournerait le compteur — c'est
       * lui qui permet de prouver un négatif (« le BLOCK n'a atteint aucun outil »).
       */
      expect(source).toMatch(/class DeclaredTool extends CountingTool/);

      /* Une seule dépêche. Deux appels seraient deux chemins à vérifier. */
      const calls = source.match(/callDownstreamTool\(/g) ?? [];
      expect(calls).toHaveLength(1);

      /* Et elle est après l'ouverture de `run()`, pas dans une autre méthode. */
      const run = source.indexOf("protected async run(");
      expect(run).toBeGreaterThan(-1);
      expect(source.indexOf("callDownstreamTool(")).toBeGreaterThan(run);
    });

    it("… et jamais vers une destination qui n'a pas été résolue d'abord", () => {
      /*
       * L'ORDRE EST LA PROPRIÉTÉ. `resolveDestination` applique l'allowlist de
       * `OATHRION_MCP_ALLOWED_DESTINATIONS`, les règles d'adresse anti-SSRF, et la portée
       * par locataire du registre. Une dépêche écrite AVANT elle enverrait l'action
       * vers ce que l'environnement dit, sans qu'aucune de ces trois barrières se soit
       * prononcée — et la fonctionnalité marcherait parfaitement.
       */
      const source = code(readFileSync(join(SERVER_DIR, "gateway", "tools", "declared-tool.ts"), "utf8"));
      const resolve = source.indexOf("resolveDestination(");
      const dispatch = source.indexOf("callDownstreamTool(");
      expect(resolve).toBeGreaterThan(-1);
      expect(dispatch).toBeGreaterThan(-1);
      expect(resolve).toBeLessThan(dispatch);

      /*
       * Et la destination transmise est bien celle que la résolution a rendue, non une
       * valeur lue à côté : `callDownstreamTool` retombe sur la destination de repli du
       * déploiement quand on ne lui en passe aucune, ce qui ferait partir l'action d'un
       * locataire vers le service d'un autre.
       */
      expect(source).toMatch(/destination:\s*destination\.destination/);
    });

    it("dispatches from the Phase 10 enforcement point only AFTER the grant is consumed", () => {
      /*
       * The assertion that earns the enforcement point its place in the closed set
       * above. Textual, and deliberately so: the ordering is a security property
       * ("claim, then act"), and a refactor that moved the dispatch above the claim
       * would leave every functional test passing — the action would still be
       * executed and the grant would still end up consumed — while re-opening the
       * double-execution window the atomic claim exists to close.
       */
      const source = code(readFileSync(join(SERVER_DIR, "authority", "enforcement-point.ts"), "utf8"));
      const claim = source.indexOf("consumeGrant(");
      const dispatch = source.indexOf("callDownstreamTool(");
      expect(claim).toBeGreaterThan(-1);
      expect(dispatch).toBeGreaterThan(-1);
      expect(claim).toBeLessThan(dispatch);
    });

    it("refuses a non-loopback downstream, so a misread env var cannot dispatch outward", async () => {
      // Phase 4 is a local exercise. Failing loudly beats silently sending a
      // refund instruction to whatever host happens to be named.
      const { downstreamMcpUrl } = await import("../gateway/tools/mcp-client");
      const previous = process.env.OATHRION_LOCAL_MCP_URL;
      try {
        process.env.OATHRION_LOCAL_MCP_URL = "https://api.stripe.com";
        expect(() => downstreamMcpUrl()).toThrow(/loopback/);

        process.env.OATHRION_LOCAL_MCP_URL = "http://127.0.0.1:9999";
        expect(downstreamMcpUrl()).toBe("http://127.0.0.1:9999");

        // Unset means SIMULATED, which is what every pre-existing test relies on.
        delete process.env.OATHRION_LOCAL_MCP_URL;
        expect(downstreamMcpUrl()).toBeNull();
      } finally {
        if (previous === undefined) delete process.env.OATHRION_LOCAL_MCP_URL;
        else process.env.OATHRION_LOCAL_MCP_URL = previous;
      }
    });

    /*
     * `oathrion wrap`, étape E1 : `stdio-mcp-child.ts` joint un serveur MCP lancé en
     * processus enfant, et son `callTool` produit l'effet. Il est donc de la même espèce
     * que `mcp-client.ts`, et tenu à la même règle : seul l'outil gouverné qui l'enveloppe
     * (`gateway/tools/stdio-mcp-tool.ts`, étape E2) peut l'importer. Tant que cet outil
     * n'existe pas, personne.
     */
    it("le client stdio n'est importé que par l'outil gouverné qui l'enveloppe", () => {
      const importers = serverSources()
        .filter(({ source }) => /from\s+["'][^"']*stdio-mcp-child["']/.test(code(source)))
        .map(({ file }) => file);
      for (const file of importers) expect(file).toBe(join("gateway", "tools", "stdio-mcp-tool.ts"));
    });

    /*
     * Le routeur et le catalogue MCP lisent les fiches des serveurs enveloppés dans
     * `gateway/wrapped-catalog.ts`. Ce module n'a sa place que s'il reste INERTE : s'il
     * importait un outil, `server/mcp/` en tiendrait un par son intermédiaire, et la règle
     * « does not import any tool implementation » serait contournée d'un cran.
     */
    it("les fiches des serveurs enveloppés sont inertes : aucun outil importé", () => {
      const source = code(readFileSync(join(SERVER_DIR, "gateway", "wrapped-catalog.ts"), "utf8"));
      expect(/from\s+["'][^"']*(tools\/|tool-registry|agent-gateway)/.test(source)).toBe(false);
    });
  });
});
