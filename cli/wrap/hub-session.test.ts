/**
 * La reprise d'un relais après une veille (`HubSession.startHeartbeat`) : elle va jusqu'au bout,
 * même quand une étape échoue la première fois.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HubSession, type HubConnection } from "./hub";

type Op = Record<string, unknown>;

function fakeHub(answers: (op: Op) => { status: number; body?: Record<string, unknown> | null }) {
  const ops: Op[] = [];
  const conn: HubConnection = {
    base: "http://127.0.0.1:1",
    dir: "/nulle-part",
    secret: "s",
    wasRunning: true,
    op: async <T>(body: Op) => {
      ops.push(body);
      const answer = answers(body);
      return { status: answer.status, body: (answer.body ?? null) as T | null };
    },
  };
  return { conn, ops };
}

describe("reprise après une veille", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("le serveur tarde à redémarrer : le battement suivant le réinscrit et demande les clés neuves", async () => {
    let known = "";
    let slept = false;
    let serverAfterSleep = 0;
    let keys = 0;
    const { conn, ops } = fakeHub((op) => {
      if (op.op === "attach") return { status: 200, body: { holder: (known = slept ? "h2" : "h1") } };
      if (op.op === "heartbeat") return { status: op.holder === known ? 204 : 404 };
      /* Après la veille, le premier lancement du serveur dépasse le délai du pivot. */
      if (op.op === "server") return slept && (serverAfterSleep += 1) === 1 ? { status: 502, body: { error: "did not answer initialize within 60000 ms" } } : { status: 200, body: { summary: {} } };
      if (op.op === "client") return { status: 200, body: { agentToken: `clé-${String((keys += 1))}`, approverToken: null, agentName: "Claude Code" } };
      return { status: 400 };
    });
    const session = new HubSession(conn, "relay", {});
    await session.attach();
    await session.attachServer({ name: "memory", command: "npx", args: [], env: {} });
    await session.clientKey("Claude Code", false);
    const renewed: unknown[] = [];
    session.startHeartbeat((k) => renewed.push(k), 1_000);

    slept = true;
    known = ""; // la veille : le pivot a oublié ce porteur et révoqué sa clé
    await vi.advanceTimersByTimeAsync(1_000); // 404 → rattaché, mais le serveur échoue : pas fini
    expect(renewed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000); // 204, la reprise n'est pas finie : serveur, puis clés neuves
    expect(renewed).toEqual([{ agentToken: "clé-2", approverToken: null, agentName: "Claude Code" }]);
    const after = ops.length;
    await vi.advanceTimersByTimeAsync(1_000); // tout est en ordre : un simple battement
    expect(ops.slice(after).map((o) => o.op)).toEqual(["heartbeat"]);
    await session.detach();
  });
});
