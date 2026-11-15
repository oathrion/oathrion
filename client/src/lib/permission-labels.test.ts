import { describe, expect, it } from "vitest";

import { PERMISSION_CATALOG } from "@shared/seed/agents";
import { permissionScopeSchema } from "@shared/validation";

import { permissionText } from "./permission-labels";

describe("les permissions, à l'affichage", () => {
  it("chaque portée connue a son texte dans le catalogue", () => {
    expect(PERMISSION_CATALOG.map((entry) => entry.scope).sort()).toEqual([...permissionScopeSchema.options].sort());
  });

  it("une copie en français gardée en base (agent créé avant le 4 novembre) s'affiche en anglais", () => {
    expect(permissionText({ scope: "mcp:write", label: "Écrire", description: "Les outils d'écriture, sous les règles." }).label).toBe("Write through a wrapped MCP server");
  });

  it("une portée inconnue garde son texte d'origine", () => {
    const unknown = { scope: "future:scope", label: "Future", description: "Not yet." } as unknown as Parameters<typeof permissionText>[0];
    expect(permissionText(unknown)).toEqual({ label: "Future", description: "Not yet." });
  });
});
