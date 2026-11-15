/**
 * « PRÊT À X/5 » (`GET /api/local/readiness`, `POST /api/local/demo`) : les cinq étapes, lues sur
 * la machine ; « Show me » joue la démo et coche l'étape ; un téléphone appairé et des agents
 * nommés sont vus tels quels.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeTelegram } from "../local-telegram";
import type { TestClient } from "./harness";

type Steps = { steps: { id: string; done: boolean; bot?: string | null; optional?: boolean; connected?: number }[] };

describe("prêt à X/5", () => {
  let api: TestClient;
  const dir = mkdtempSync(join(tmpdir(), "oathrion-ready-"));
  let named: Record<string, unknown> = {};
  let demos = 0;
  let connected: unknown[] = [];
  beforeAll(async () => {
    api = await (await import("./harness")).startTestServer();
    (await import("../local-mode")).enterLocalMode();
    /* Le pivot, réduit à ce que les routes regardent. */
    (await import("../local-hub")).activateHub({
      isClosing: false,
      dir,
      mascots: { list: () => named },
      serverStates: () => connected,
      onDemo: () => {
        demos += 1;
        return { shown: true, detail: "pause" };
      },
    } as never);
  }, 60_000);
  afterAll(async () => {
    (await import("../local-hub")).activateHub(null);
    await api.close();
  });

  const steps = async () => Object.fromEntries((await api.get<Steps>("/api/local/readiness")).body.steps.map((s) => [s.id, s]));

  it("les cinq étapes, dans l'ordre ; rien de fait sur un pivot neuf (hors serveurs, lus sur la machine)", async () => {
    const reply = await api.get<Steps>("/api/local/readiness");
    expect(reply.status).toBe(200);
    expect(reply.body.steps.map((s) => s.id)).toEqual(["protected", "demo", "phone", "named", "decision"]);
    const s = await steps();
    expect([s.demo!.done, s.phone!.done, s.named!.done]).toEqual([false, false, false]);
  });

  it("« Show me » joue la démo et coche l'étape ; le téléphone et les noms sont vus", async () => {
    expect((await api.post("/api/local/demo")).status).toBe(200);
    expect(demos).toBe(1);
    writeTelegram(dir, { token: "1:x", bot: "oathrion_test_bot", chatId: 42, userId: 42 });
    named = { claude: { mascot: "nova", nickname: "Nova", at: "2026-11-12T00:00:00Z" } };
    const s = await steps();
    expect(s.demo!.done).toBe(true);
    expect(s.phone).toMatchObject({ done: true, bot: "oathrion_test_bot" });
    expect(s.named!.done).toBe(true);
  });

  it("protégé seulement quand un client s'est branché ; donner un nom est facultatif", async () => {
    connected = [];
    expect((await steps()).protected!.connected).toBe(0);
    expect((await steps()).protected!.done).toBe(false);
    expect((await steps()).named!.optional).toBe(true);
    /* Un serveur lancé une fois par le pivot : branché, même si le client est fermé maintenant. */
    mkdirSync(join(dir, "serveurs", "github"), { recursive: true });
    writeFileSync(join(dir, "serveurs", "github", "commande.json"), "{}");
    expect((await steps()).protected!.connected).toBe(1);
  });

  it("un lecteur voit l'état, mais ne lance pas la démo", async () => {
    expect((await api.get("/api/local/readiness", { auth: "test-viewer-key-123456" })).status).toBe(200);
    expect((await api.post("/api/local/demo", undefined, { auth: "test-viewer-key-123456" })).status).toBe(403);
  });
});
