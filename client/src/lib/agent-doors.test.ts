import { describe, expect, it } from "vitest";

import { doorsVerdict, type Door } from "./agent-doors";

const dead: Door = { declared: "revoked", check: { state: "dead", detail: "" } };
const alive: Door = { declared: "revoked", check: { state: "alive", detail: "" } };
const unknown: Door = { declared: "revoked", check: { state: "unknown", detail: "" } };
const placet: Door = { declared: "revoked", check: { state: "placet", detail: "" } };
const unchecked: Door = { declared: "revoked", check: null };
const none: Door = { declared: "none" };

describe("« incontournable » n'est dit que s'il est établi", () => {
  it("chaque outil sans clé, ou vérifié mort : incontournable", () => {
    expect(doorsVerdict({ github: none, stripe: dead }, ["github", "stripe"])).toBe("locked");
  });

  it("une révocation seulement déclarée, ou non concluante, n'est que déclarée", () => {
    expect(doorsVerdict({ github: unchecked }, ["github"])).toBe("declared");
    expect(doorsVerdict({ github: unknown }, ["github"])).toBe("declared");
    /* La clé du coffre présentée par erreur ne prouve rien sur l'ancienne. */
    expect(doorsVerdict({ github: placet }, ["github"])).toBe("declared");
  });

  it("une seule clé encore vivante : porte ouverte, quoi que disent les autres", () => {
    expect(doorsVerdict({ github: dead, slack: alive }, ["github", "slack"])).toBe("open");
    expect(doorsVerdict({ github: alive }, ["github", "slack"])).toBe("open");
  });

  it("un outil sans réponse, ou aucun outil : incomplet", () => {
    expect(doorsVerdict({ github: dead }, ["github", "slack"])).toBe("incomplete");
    expect(doorsVerdict({}, [])).toBe("incomplete");
  });
});
