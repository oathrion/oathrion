/**
 * L'inventaire des outils dit la vérité sur la simulation — C34 du kit de conformité.
 *
 * ## Le défaut
 *
 * `mcp-e2e-downstream.test.ts` a déjà retiré un `simulated: true` codé en dur du
 * **compte rendu d'exécution**, avec ce motif : « which became a false statement the
 * moment a tool could dispatch for real ». La même affirmation est restée debout dans
 * les deux surfaces d'**inventaire** :
 *
 *   - le catalogue MCP écrivait `simulated: true as const` — et le TYPE lui-même,
 *     `OathrionToolGovernance.simulated: true`, était un littéral, donc le compilateur
 *     refusait la valeur honnête ;
 *   - `GET /api/tools` ne portait rien du tout, alors que
 *     `docs/COMMERCIAL_READINESS.md` affirmait qu'il « expose le drapeau ».
 *
 * Une affirmation inexacte sur l'honnêteté, dans un dépôt dont le différenciateur
 * s'appelle `claims-honesty.test.ts`, pèse plus lourd qu'une documentation périmée
 * ordinaire. Ce fichier est ce qui l'empêche de revenir.
 *
 * ## Pourquoi le dernier test est le seul qui compte vraiment
 *
 * Vérifier qu'un champ booléen existe est cosmétique : une implémentation qui renvoie
 * `true` en dur passerait. Le test final configure une destination aval et exige que
 * l'outil qui sait y dépêcher bascule à `false` — sur les DEUX surfaces à la fois.
 * C'est la seule forme qui distingue un drapeau dérivé d'un drapeau décoratif.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolRegistry } from "../gateway/tool-registry";
import { connectorPlaneFor } from "../connectors";
import { repositoryExecutor } from "../repositories";
import type { OrganizationId } from "@shared/tenancy";

interface InventoryEntry {
  id: string;
  name: string;
  description: string;
  toolExecutionCount: number;
  simulated: unknown;
}

let client: TestClient;
const AS_ADMIN = { auth: ROLE_KEYS.admin };

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  delete process.env.OATHRION_LOCAL_MCP_URL;
});

/**
 * Ce que la source unique déclare pour un outil donné.
 *
 * LE MÊME REGISTRE QUE LA ROUTE, et c'est une correction. Cette fonction ne lisait que
 * `toolRegistry`, la table du PROCESSUS, alors que `/api/tools` liste désormais aussi les
 * outils montés par organisation — connecteurs et relais du pare-feu. Un outil de
 * locataire rendait donc `undefined` ici, et le test échouait en accusant la route
 * d'inventer un drapeau qu'elle dérivait correctement.
 *
 * Reconstruire le registre dérivé comme la route le fait garde la force de l'assertion :
 * le drapeau rendu en HTTP doit venir de l'instance d'outil, pour TOUS les outils.
 */
function sourceSimulated(toolId: string): boolean | undefined {
  const connectors = connectorPlaneFor(repositoryExecutor(), "org_default" as OrganizationId);
  const registry = toolRegistry.extendedWith(
    [...connectors.tools.values()],
    connectors.actionMap,
  );
  return registry.list().find((t) => t.id === toolId)?.simulated;
}

describe("GET /api/tools — l'inventaire HTTP", () => {
  it("porte un booléen `simulated` pour chaque outil", async () => {
    const res = await client.get<InventoryEntry[]>("/api/tools", AS_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const tool of res.body) {
      expect(typeof tool.simulated, `outil "${tool.id}"`).toBe("boolean");
    }
  });

  it("rend ce que la source unique déclare, outil par outil", async () => {
    const res = await client.get<InventoryEntry[]>("/api/tools", AS_ADMIN);
    for (const tool of res.body) {
      expect(tool.simulated, `outil "${tool.id}"`).toBe(sourceSimulated(tool.id));
    }
  });

  it("et le catalogue MCP ne porte plus de littéral", () => {
    /*
     * Assertion sur le TEXTE SOURCE, comme les tests « single path » de ce dépôt.
     * Son coût est connu : elle ne voit pas un littéral calculé. Elle voit en
     * revanche le retour exact de ce qui a été retiré — `simulated: true as const`,
     * et le type littéral `simulated: true` qui le rendait obligatoire.
     */
    const text = readFileSync(join(import.meta.dirname, "..", "mcp", "tool-catalog.ts"), "utf8");
    expect(text).toContain("simulated: tool.simulated");
    expect(text).not.toMatch(/simulated:\s*true\s+as\s+const/);
    expect(text).not.toMatch(/^\s*simulated:\s*true;\s*$/m);
  });
});

describe("le drapeau est dérivé, pas décoratif", () => {
  it("sans destination aval, tous les outils se déclarent simulés", async () => {
    const res = await client.get<InventoryEntry[]>("/api/tools", AS_ADMIN);
    expect(res.body.every((t) => t.simulated === true)).toBe(true);
  });

  it("avec une destination aval configurée, l'outil qui sait y dépêcher bascule", async () => {
    /*
     * `downstreamMcpUrl()` est relu à chaque accès, jamais mis en cache : la
     * simulation est une propriété du DÉPLOIEMENT, pas de la compilation. Le port 9
     * est « discard » : rien n'écoute, et rien n'a besoin d'écouter — on mesure ce
     * que l'inventaire DÉCLARE, pas ce qu'un appel ferait.
     */
    process.env.OATHRION_LOCAL_MCP_URL = "http://127.0.0.1:9/";

    const res = await client.get<InventoryEntry[]>("/api/tools", AS_ADMIN);
    const refund = res.body.find((t) => t.id === "refund_tool");
    expect(refund, "l'outil de remboursement doit figurer dans l'inventaire").toBeDefined();
    expect(refund!.simulated).toBe(false);
    expect(sourceSimulated("refund_tool")).toBe(false);

    // Et les outils qui n'ont aucun chemin aval n'héritent pas de l'étiquette du voisin.
    const purchase = res.body.find((t) => t.id === "purchase_tool");
    expect(purchase!.simulated).toBe(true);
  });
});
