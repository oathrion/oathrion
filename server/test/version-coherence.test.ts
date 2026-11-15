/**
 * UNE SEULE VERSION, écrite à cinq endroits.
 *
 * Relevé en préparant la préversion (28 octobre 2026) : le produit disait 1.0.0, la commande et
 * le SDK Python 0.8.0, la passerelle MCP annonçait 1.0.0 en dur. Aucun ne mentait exprès ; ils
 * avaient simplement divergé, et un rapport de bogue citant « 0.8.0 » n'aurait désigné aucune
 * livraison. `package.json` est la référence ; les autres doivent la suivre.
 *
 * Python s'écrit autrement : PEP 440 lirait « 0.1.0-preview.0 » comme une version candidate
 * (0.1.0rc0). La préversion y est une alpha : `X.Y.Z-preview.N` ↔ `X.Y.ZaN`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const product = (JSON.parse(read("package.json")) as { version: string }).version;

function literal(path: string, pattern: RegExp): string {
  const match = pattern.exec(read(path));
  if (!match?.[1]) throw new Error(`${path} : version introuvable`);
  return match[1];
}

function pythonOf(version: string): string {
  const preview = /^(\d+\.\d+\.\d+)-preview\.(\d+)$/.exec(version);
  return preview ? `${preview[1]!}a${preview[2]!}` : version;
}

describe("la version du produit est la même partout", () => {
  it("package.json est une préversion lisible", () => {
    expect(product).toMatch(/^\d+\.\d+\.\d+(-preview\.\d+)?$/);
  });

  it("la commande oathrion", () => {
    expect(literal("cli/main.ts", /const VERSION = "([^"]+)";/)).toBe(product);
  });

  it("la passerelle MCP, dans serverInfo", () => {
    expect(literal("server/mcp/router.ts", /const SERVER_INFO = \{ name: "oathrion", version: "([^"]+)" \}/)).toBe(product);
  });

  it("le SDK Python, paquet et module, dans la notation PEP 440", () => {
    expect(literal("sdk/python/pyproject.toml", /^version = "([^"]+)"/m)).toBe(pythonOf(product));
    expect(literal("sdk/python/oathrion/__init__.py", /^__version__ = "([^"]+)"/m)).toBe(pythonOf(product));
  });
});
