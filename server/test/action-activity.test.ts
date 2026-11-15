/**
 * `executions.actionActivity(prefix)` sur SQLite, le moteur du pivot local : l'écran
 * « Serveurs » compte les actions d'un serveur par là.
 *
 * Le défaut qu'il ferme (banc d'endurance du pivot, 1er novembre 2026) : la route lisait
 * `executions.list(1_000)` puis comptait le tableau rendu. Après 1 496 appels, l'écran disait
 * « 1 000 ». Le même défaut que celui de la couverture (`coverage-aggregation.test.ts`).
 * La voie PostgreSQL a le même test dans `phase11-postgres-core.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Execution } from "@shared/types";

const MINE = "org_default";
const THEIRS = "org_rival_corp";
let repositories: typeof import("../repositories");

beforeAll(async () => {
  const harness = await import("./harness");
  repositories = await import("../repositories");
  await harness.startTestServer();
  await repositories.seedIfEmpty();
}, 60_000);

const execution = (id: string, action: string, timestamp: string): Execution => ({
  id,
  agentId: "agent-activite",
  agentName: "Activité",
  action,
  target: "mcp://x",
  status: "allowed",
  risk: "low",
  durationMs: 1,
  cost: 0,
  timestamp,
  input: {},
  decision: "allow",
  decisionReason: "test",
  policyEvaluated: null,
  policyId: null,
  result: "ok",
  audit: [],
});

describe("actionActivity, sur SQLite", () => {
  it("compte au-delà de 1 000, par début EXACT d'action (`_` n'est pas un joker), par locataire, et rend la plus récente", async () => {
    const mine = repositories.repositoriesFor(MINE as never);
    const base = Date.parse("2026-11-01T00:00:00Z");
    for (let i = 0; i < 1_050; i += 1) {
      await mine.executions.create(execution(`exe_act_${String(i)}`, i % 2 ? "mcp.my_srv.read_file" : "mcp.my_srv.write_file", new Date(base + i * 1_000).toISOString()));
    }
    /* `LIKE 'mcp.my_srv.%'` compterait ces deux-là ; un début exact non. */
    await mine.executions.create(execution("exe_act_joker", "mcp.myXsrv.read_file", new Date(base + 9_999_000).toISOString()));
    await mine.executions.create(execution("exe_act_autre", "mcp.my_srv2.read_file", new Date(base + 9_999_000).toISOString()));
    await repositories.repositoriesFor(THEIRS as never).executions.create(execution("exe_act_voisin", "mcp.my_srv.read_file", new Date(base + 9_999_000).toISOString()));

    const activity = await mine.executions.actionActivity("mcp.my_srv.");
    expect(activity.count).toBe(1_050);
    expect(activity.latest?.id).toBe("exe_act_1049");
    expect(await mine.executions.actionActivity("mcp.absent.")).toEqual({ count: 0, latest: undefined });
  }, 60_000);
});
