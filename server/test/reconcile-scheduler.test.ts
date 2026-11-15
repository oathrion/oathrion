/**
 * La réconciliation périodique — ce que la tâche garantit, sans réseau ni base.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  MIN_RECONCILE_INTERVAL_MS,
  reconcileIntervalMs,
  startReconcileScheduler,
} from "../connectors/reconcile-scheduler";

type Org = { id: string; name: string; active: boolean };

describe("l'intervalle", () => {
  it("une heure par défaut, 0 coupe, jamais moins d'une minute, illisible = défaut", () => {
    expect(reconcileIntervalMs({})).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(reconcileIntervalMs({ OATHRION_RECONCILE_INTERVAL_MS: "0" })).toBe(0);
    expect(reconcileIntervalMs({ OATHRION_RECONCILE_INTERVAL_MS: "1000" })).toBe(MIN_RECONCILE_INTERVAL_MS);
    expect(reconcileIntervalMs({ OATHRION_RECONCILE_INTERVAL_MS: "900000" })).toBe(900_000);
    expect(reconcileIntervalMs({ OATHRION_RECONCILE_INTERVAL_MS: "souvent" })).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
    expect(reconcileIntervalMs({ OATHRION_RECONCILE_INTERVAL_MS: "-5" })).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
  });
});

function scheduler(orgs: Org[], run: (org: Org) => Promise<void>, shuttingDown = () => false) {
  const logs: string[] = [];
  const s = startReconcileScheduler({ intervalMs: 0, organizations: () => orgs, runOrganization: run, isShuttingDown: shuttingDown, log: (m) => logs.push(m) });
  return { s, logs };
}

describe("un passage", () => {
  it("chaque organisation ACTIVE, une à la fois", async () => {
    const seen: string[] = [];
    const { s } = scheduler(
      [
        { id: "org_a", name: "A", active: true },
        { id: "org_b", name: "B", active: false },
        { id: "org_c", name: "C", active: true },
      ],
      async (org) => {
        seen.push(org.id);
      },
    );
    await s.tick();
    expect(seen).toEqual(["org_a", "org_c"]);
  });

  it("l'échec d'une organisation n'arrête pas les suivantes, et il est dit", async () => {
    const seen: string[] = [];
    const { s, logs } = scheduler(
      [
        { id: "org_a", name: "A", active: true },
        { id: "org_b", name: "B", active: true },
      ],
      async (org) => {
        if (org.id === "org_a") throw new Error("GitHub is unreachable");
        seen.push(org.id);
      },
    );
    await s.tick();
    expect(seen).toEqual(["org_b"]);
    expect(logs.join("\n")).toMatch(/org_a interrupted: GitHub is unreachable/);
  });

  it("un passage en cours empêche le suivant de démarrer", async () => {
    let release!: () => void;
    let calls = 0;
    const { s } = scheduler([{ id: "org_a", name: "A", active: true }], () => {
      calls += 1;
      return new Promise<void>((r) => (release = r));
    });
    const first = s.tick();
    await s.tick();
    expect(calls).toBe(1);
    release();
    await first;
    /* Le précédent fini, le suivant démarre. */
    const third = s.tick();
    expect(calls).toBe(2);
    release();
    await third;
  });

  it("rien n'est lancé pendant l'arrêt du serveur", async () => {
    let calls = 0;
    const { s } = scheduler([{ id: "org_a", name: "A", active: true }], async () => {
      calls += 1;
    }, () => true);
    await s.tick();
    expect(calls).toBe(0);
  });

  it("intervalle 0 : la tâche est coupée, et le journal le dit", () => {
    const { logs } = scheduler([], async () => undefined);
    expect(logs.join("\n")).toMatch(/disabled/);
  });
});
