/**
 * Le pivot local ne laisse AUCUN processus derrière lui, quelle que soit la façon dont les
 * clients s'en vont (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`).
 *
 * Trouvé le 28 octobre 2026 dans l'essai réel avec Cursor (STRESS-TEST-LOG §5.49) : Cursor
 * arrête le relais par un signal ; l'ancien Oathrion par serveur restait alors à l'écoute avec
 * son enfant. Avec le pivot, le relais part (et se détache s'il en a le temps) ; tué net, il se
 * tait : ses battements cessent, le pivot le détache, arrête le serveur que plus personne ne
 * porte, puis s'arrête lui-même. Les durées sont raccourcies (`FAST`).
 *
 * Le serveur enveloppé est lancé derrière un `sh -c`, comme `npx` (npm → sh → node). Le test
 * ne suit que les processus de SON pivot (repérés par leur dossier de travail).
 */
import { afterAll, describe, expect, it } from "vitest";

import { alive, cmdline, FAKE, freshHome, hubTree, mcpClient, ready, until } from "./hub-test-kit";

if (!ready) console.warn("[wrap-lifecycle.test] SAUTÉ — il faut Linux et « npm run build ».");

const seen = new Set<number>();
afterAll(() => {
  for (const pid of seen) {
    try {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      /* parti */
    }
  }
});

const SHELL_WRAPPED = ["sh", "-c", `"${process.execPath}" "${FAKE}"; true`];

async function treeGone(home: string, ms: number): Promise<string[]> {
  const tracked = new Set(hubTree(home));
  for (const pid of tracked) seen.add(pid);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const pid of hubTree(home)) {
      tracked.add(pid);
      seen.add(pid);
    }
    if ([...tracked].every((pid) => !alive(pid))) return [];
    await new Promise((done) => setTimeout(done, 100));
  }
  return [...tracked].filter(alive).map((pid) => `${String(pid)} ${cmdline(pid)}`);
}

describe.skipIf(!ready)("aucun processus ne survit aux clients", () => {
  it.each(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"] as const)(
    "client arrêté par %s une fois prêt : le pivot et le serveur enveloppé s'arrêtent d'eux-mêmes",
    async (signal) => {
      const home = freshHome("oathrion-vie-");
      const client = mcpClient(home, "carnet", "Cursor", { args: SHELL_WRAPPED });
      seen.add(client.proc.pid!);
      await client.initialize();
      expect((await client.toolNames()).length).toBeGreaterThan(0);
      const tree = hubTree(home);
      expect(tree.some((pid) => cmdline(pid).includes("oathrion-local.cjs"))).toBe(true);
      expect(tree.some((pid) => cmdline(pid).includes("fake-stdio-mcp-server"))).toBe(true);

      client.proc.kill(signal);
      expect(await treeGone(home, 15_000)).toEqual([]);
    },
    40_000,
  );

  it("client tué net PENDANT le démarrage du pivot : rien ne reste, rien ne tourne à vide", async () => {
    const home = freshHome("oathrion-vie-demarrage-");
    const client = mcpClient(home, "carnet", "Cursor", { args: SHELL_WRAPPED });
    seen.add(client.proc.pid!);
    await until(() => hubTree(home).length > 0, 20_000, "le pivot lancé");
    client.proc.kill("SIGKILL");
    expect(await treeGone(home, 20_000)).toEqual([]);
  }, 50_000);

  it("fermer l'entrée du client arrête tout", async () => {
    const home = freshHome("oathrion-vie-entree-");
    const client = mcpClient(home, "carnet", "Cursor", { args: SHELL_WRAPPED });
    await client.initialize();
    expect(await client.close()).toBe(0);
    expect(await treeGone(home, 15_000)).toEqual([]);
  }, 40_000);

  it("deux clients qui démarrent ENSEMBLE : un seul pivot ; l'un part, l'autre garde son serveur", async () => {
    const home = freshHome("oathrion-vie-ensemble-");
    const cursor = mcpClient(home, "carnet", "Cursor");
    const claude = mcpClient(home, "carnet", "claude-code");
    await Promise.all([cursor.initialize(), claude.initialize()]);
    expect((await cursor.toolNames()).length).toBeGreaterThan(0);
    expect(hubTree(home).filter((pid) => cmdline(pid).includes("oathrion-local.cjs"))).toHaveLength(1);

    expect(await cursor.close()).toBe(0);
    await new Promise((done) => setTimeout(done, 1_500));
    expect((await claude.toolNames()).length).toBeGreaterThan(0);
    expect(await claude.close()).toBe(0);
    expect(await treeGone(home, 15_000)).toEqual([]);
  }, 60_000);
});
