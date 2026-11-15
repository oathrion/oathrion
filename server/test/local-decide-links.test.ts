/**
 * Le bouton « Décider » d'une notification Windows : Windows ouvre une ADRESSE, sans session.
 * Le jeton (`server/local-decide-links.ts`) est à usage unique, valable quinze minutes, et
 * `GET /api/local/decider` l'échange contre un lien de connexion NEUF à la console.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimDecideToken, mintDecideToken } from "../local-decide-links";

describe("le jeton « Décider »", () => {
  it("sert une fois, et seulement avant quinze minutes", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    const once = mintDecideToken(now);
    expect(claimDecideToken(once, now + 1_000)).toBe(true);
    expect(claimDecideToken(once, now + 2_000)).toBe(false);
    const late = mintDecideToken(now);
    expect(claimDecideToken(late, now + 15 * 60_000 + 1)).toBe(false);
    expect(claimDecideToken("inconnu", now)).toBe(false);
  });
});

describe("GET /api/local/decider", () => {
  let base = "";
  let close: () => Promise<void> = async () => undefined;
  beforeAll(async () => {
    process.env.OATHRION_SESSION_SECRET = "s".repeat(48);
    const harness = await import("./harness");
    const api = await harness.startTestServer();
    base = api.baseUrl;
    close = () => api.close();
    /* Le pivot, réduit à ce que la route regarde : il existe. */
    (await import("../local-mode")).enterLocalMode();
    (await import("../local-hub")).activateHub({ isClosing: false } as never);
  }, 60_000);
  afterAll(async () => {
    (await import("../local-hub")).activateHub(null);
    await close();
  });

  const open = (token: string) => fetch(`${base}/api/local/decider?n=${encodeURIComponent(token)}`, { redirect: "manual" });

  it("un jeton valide : la console, avec un lien de connexion neuf ; une seconde fois : la console nue", async () => {
    const token = mintDecideToken();
    const first = await open(token);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toMatch(/^\/console#\/connexion-locale\?ticket=v1\./);
    const again = await open(token);
    expect([again.status, again.headers.get("location")]).toEqual([302, "/console"]);
  });

  it("un jeton inconnu : la console nue, sans session", async () => {
    const answer = await open("fabrique-par-quelqu-un");
    expect([answer.status, answer.headers.get("location")]).toEqual([302, "/console"]);
  });
});
