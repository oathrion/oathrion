/**
 * « Ajouter un agent existant » — ce que l'écran ne doit jamais cesser de faire.
 *
 * Le client n'a pas de banc DOM : comme les autres gardes de l'interface, ce test lit la
 * source. La logique du verdict (« incontournable » / « déclaré » / « porte ouverte ») est
 * éprouvée à part, sans DOM (`client/src/lib/agent-doors.test.ts`) ; la route serveur de
 * vérification par `connector-check-credential.test.ts` ; le parcours entier dans un
 * navigateur (STRESS-TEST-LOG §5.16).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src");
const read = (relative: string) => readFileSync(path.join(CLIENT, relative), "utf8");

describe("l'écran est atteignable", () => {
  it("la route est déclarée AVANT /agents/:id, sinon « connect » serait lu comme un identifiant", () => {
    const app = read("App.tsx");
    const connect = app.indexOf('path="/agents/connect"');
    const byId = app.indexOf('path="/agents/:id"');
    expect(connect).toBeGreaterThan(-1);
    expect(connect).toBeLessThan(byId);
  });

  it("l'écran Agents propose « Ajouter un agent existant », en tête et dans l'état vide", () => {
    const agents = read("pages/agents.tsx");
    expect(agents).toContain('href="/agents/connect"');
    expect(agents.match(/\{connectExistingButton\}/g)?.length).toBe(2);
  });
});

describe("ce que l'écran promet, et pas plus", () => {
  const page = read("pages/agent-connect.tsx");

  it("Claude Desktop et « autre outil MCP » sont dits non vérifiés", () => {
    expect(page).toMatch(/id: "claude",[\s\S]{0,200}verified: false/);
    expect(page).toMatch(/id: "mcp",[\s\S]{0,200}verified: false/);
    expect(page).toMatch(/Not verified by Oathrion/);
  });

  it("l'étape 4 et la fiche de l'agent lisent les portes GARDÉES PAR LE SERVEUR", () => {
    expect(page).toContain('import { DoorsPanel } from "@/components/agents/DoorsPanel";');
    expect(page).toMatch(/<DoorsPanel\s+agentId=\{agent\.id\}/);
    expect(page).not.toMatch(/doorsVerdict\(/);
    const detail = read("pages/agent-detail.tsx");
    expect(detail).toMatch(/<DoorsPanel agentId=\{agent\.id\} canManage=\{canManage\} \/>/);
  });

  it("le panneau présente l'ancienne clé au serveur, l'efface, et ne pose jamais lui-même une vérification", () => {
    const panel = read("components/agents/DoorsPanel.tsx");
    expect(panel).toMatch(/queryFn: \(\) => getAgentDoors\(agentId\)/);
    expect(panel).toMatch(/await checkOldCredential\(tool\.id, value, agentId\)[\s\S]{0,300}setValue\(""\);/);
    expect(panel).toMatch(/type="password"/);
    /* Les seules écritures : la déclaration (sans résultat) et la vérification par le serveur. */
    expect(panel).toMatch(/declareAgentDoor\(agentId, tool\.id, next\)/);
    expect(panel).not.toMatch(/setQueryData\([^)]*check/);
  });

  it("l'agent créé ne reçoit que les permissions des outils cochés, et une clé liée à lui seul", () => {
    expect(page).toMatch(/agentForTools\(label, tools,/);
    expect(page).toMatch(/createApiKey\(\{ name: `\$\{created\.name\} key`, role: "operator", agentId: created\.id/);
  });
});
