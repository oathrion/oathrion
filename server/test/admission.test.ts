/**
 * Le refus immédiat quand Oathrion est débordé (`server/admission.ts`).
 *
 * Ce qui doit tenir :
 *   · au-delà du plafond, 503 `overloaded` AUSSITÔT, avec `Retry-After`, sans que la
 *     route ne soit atteinte ;
 *   · les sondes passent toujours, même plafond atteint ;
 *   · une place se libère quand la réponse part, ET quand le client abandonne — sinon
 *     chaque abandon fermerait une place pour toujours ;
 *   · `0` coupe le plafond.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { admissionControl, DEFAULT_MAX_IN_FLIGHT, maxInFlight, retryAfterSeconds, type Admission } from "../admission";

let server: Server | null = null;
let release: (() => void)[] = [];
let reached = 0;

async function start(limit: number): Promise<{ base: string; admission: Admission }> {
  const app = express();
  const admission = admissionControl(limit);
  app.use(admission);
  app.get("/api/lent", (_req, res) => {
    reached += 1;
    release.push(() => res.json({ ok: true }));
  });
  app.get("/api/live", (_req, res) => res.json({ live: true }));
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, admission };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(predicate()).toBe(true);
}

afterEach(async () => {
  for (const r of release) r();
  release = [];
  reached = 0;
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

describe("le plafond", () => {
  it("lu dans l'environnement : 256 par défaut, 0 coupe, illisible = défaut", () => {
    expect(maxInFlight({})).toBe(DEFAULT_MAX_IN_FLIGHT);
    expect(DEFAULT_MAX_IN_FLIGHT).toBe(256);
    expect(maxInFlight({ OATHRION_MAX_IN_FLIGHT: "0" })).toBe(0);
    expect(maxInFlight({ OATHRION_MAX_IN_FLIGHT: "64" })).toBe(64);
    expect(maxInFlight({ OATHRION_MAX_IN_FLIGHT: "beaucoup" })).toBe(DEFAULT_MAX_IN_FLIGHT);
    expect(maxInFlight({ OATHRION_MAX_IN_FLIGHT: "-3" })).toBe(DEFAULT_MAX_IN_FLIGHT);
  });

  it("le délai annoncé croît avec le débordement, de 1 à 30 s", () => {
    expect(retryAfterSeconds(0, 256)).toBe(1);
    expect(retryAfterSeconds(255, 256)).toBe(1);
    expect(retryAfterSeconds(770, 256)).toBe(4);
    expect(retryAfterSeconds(1_000_000, 256)).toBe(30);
  });

  it("au-delà, 503 overloaded aussitôt, sans atteindre la route, et les sondes passent", async () => {
    const { base, admission } = await start(2);
    const first = fetch(`${base}/api/lent`);
    const second = fetch(`${base}/api/lent`);
    await until(() => reached === 2);
    expect(admission.inFlight()).toBe(2);

    const refused = await fetch(`${base}/api/lent`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body.code).toBe("overloaded");
    expect(body.limit).toBe(2);
    expect(String(body.message)).toMatch(/nothing was decided or executed/);
    expect(reached).toBe(2);

    /* La sonde n'est jamais refusée : un orchestrateur retirerait l'instance. */
    expect((await fetch(`${base}/api/live`)).status).toBe(200);

    for (const r of release) r();
    release = [];
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    await until(() => admission.inFlight() === 0);
  });

  it("un client qui abandonne libère sa place", async () => {
    const { base, admission } = await start(1);
    const controller = new AbortController();
    const abandoned = fetch(`${base}/api/lent`, { signal: controller.signal }).catch(() => "abandonné");
    await until(() => reached === 1);
    expect(admission.inFlight()).toBe(1);
    controller.abort();
    expect(await abandoned).toBe("abandonné");
    await until(() => admission.inFlight() === 0);

    const next = fetch(`${base}/api/lent`);
    await until(() => reached === 2);
    for (const r of release) r();
    release = [];
    expect((await next).status).toBe(200);
  });

  it("0 coupe le plafond", async () => {
    const { base } = await start(0);
    const calls = [fetch(`${base}/api/lent`), fetch(`${base}/api/lent`), fetch(`${base}/api/lent`)];
    await until(() => reached === 3);
    for (const r of release) r();
    release = [];
    expect((await Promise.all(calls)).map((r) => r.status)).toEqual([200, 200, 200]);
  });
});
