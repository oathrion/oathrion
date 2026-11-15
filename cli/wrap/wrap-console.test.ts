/**
 * `oathrion console` et le pivot local — une console pour toute la machine.
 *
 * La vraie commande compilée, comme la personne la lancera :
 *
 *   · sans client : la console lance le pivot, n'a rien à relancer, et le dit ;
 *   · client fermé : elle relance les serveurs connus ; son lien ouvre une session une fois,
 *     pas deux ; la racine mène à la console ; un client qui arrive PARTAGE le pivot, sans
 *     refus ni « reprise », et garde son serveur quand la console se ferme ;
 *   · client ouvert : un lien neuf, et la main rendue ;
 *   · chemin relatif, console pendant le démarrage d'un client lent, nom déjà pris.
 *
 * Le test ne suit que les processus de SON pivot (repérés par leur dossier de travail).
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { alive, cli, FAKE, freshHome, hubTree, mcpClient, ready, until } from "./hub-test-kit";

if (!ready) console.warn("[wrap-console.test] SAUTÉ — il faut Linux et « npm run build ».");

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
const track = (home: string) => {
  for (const pid of hubTree(home)) seen.add(pid);
};
const linkIn = (text: string) => /Direct sign-in \(works once, for two minutes\): (\S+)/.exec(text)?.[1];

describe.skipIf(!ready)("oathrion console", () => {
  it("sans aucun client : le pivot est lancé, rien à relancer, et la console le dit ; Ctrl+C la ferme", async () => {
    const home = freshHome("oathrion-console-vide-");
    const run = cli(home, ["console", "--sans-navigateur"]);
    seen.add(run.proc.pid!);
    await until(() => /Ctrl\+C to close/.test(run.stdout()), 30_000, "la console");
    track(home);
    expect(run.stdout()).toMatch(/No server yet: start your client once/);
    expect(linkIn(run.stdout())).toMatch(/\/console#\/connexion-locale\?ticket=v1\./);
    run.proc.kill("SIGINT");
    expect(await run.exited()).toBe(0);
    expect(run.stdout()).toMatch(/Console closed\./);
  }, 60_000);

  it("sans terminal (l'outil d'un agent) : ni lien, ni ticket, ni navigateur ; la base est lisible par la seule personne", async () => {
    const home = freshHome("oathrion-console-sans-terminal-");
    /* Ni terminal ni réglage de test : comme l'outil Bash d'un agent. */
    const run = cli(home, ["console"], { env: { OATHRION_CONSOLE_LIEN: "" } });
    seen.add(run.proc.pid!);
    await until(() => /Ctrl\+C to close/.test(run.stdout()), 30_000, "la console");
    track(home);
    expect(run.stdout()).toMatch(/The sign-in link is only given in a terminal/);
    expect(run.stdout()).not.toMatch(/ticket=/);
    expect(linkIn(run.stdout())).toBeUndefined();
    expect(statSync(join(home, "_local", "oathrion.db")).mode & 0o777).toBe(0o600);
    run.proc.kill("SIGINT");
    expect(await run.exited()).toBe(0);
  }, 60_000);

  it("client fermé : le serveur relancé, le lien connecte une fois, et un client qui arrive partage le pivot", async () => {
    const home = freshHome("oathrion-console-");
    const first = mcpClient(home, "carnet", "Cursor");
    await first.initialize();
    expect(await first.close()).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, "_local", "serveurs", "carnet", "commande.json"), "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ command: process.execPath, args: [FAKE] });
    expect(saved).not.toHaveProperty("env");

    const consoleRun = cli(home, ["console", "--sans-navigateur"]);
    seen.add(consoleRun.proc.pid!);
    await until(() => /Ctrl\+C to close/.test(consoleRun.stdout()), 30_000, "la console");
    track(home);
    expect(consoleRun.stdout()).toMatch(/"carnet" restarted/);
    const port = readFileSync(join(home, "_local", "port"), "utf8").trim();
    const base = `http://127.0.0.1:${port}`;

    /* La page de connexion apprend qu'elle est locale, et qu'elle parle au pivot. */
    expect(await (await fetch(`${base}/api/local/login`)).json()).toEqual({ local: true, hub: true, name: null, build: expect.stringMatching(/^\d+:\d+$/) });
    const ticket = new URLSearchParams(linkIn(consoleRun.stdout())!.split("?")[1]).get("ticket")!;
    const signIn = () => fetch(`${base}/api/local/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
    const opened = await signIn();
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { identity: { role: string } }).identity.role).toBe("admin");
    expect((await signIn()).status).toBe(403);
    const root = await fetch(`${base}/`, { redirect: "manual" });
    expect([root.status, root.headers.get("location")]).toEqual([302, "/console"]);

    /* Un client arrive : il partage le pivot (aucun refus), et voit son serveur. */
    const client = mcpClient(home, "carnet", "claude-code");
    await client.initialize();
    expect(await client.toolNames()).toContain("read_note");

    /* La console se ferme : le client garde son serveur. */
    consoleRun.proc.kill("SIGINT");
    expect(await consoleRun.exited()).toBe(0);
    expect(await client.toolNames()).toContain("read_note");
    expect(await client.close()).toBe(0);
  }, 90_000);

  it("client ouvert : un lien neuf vers la console déjà ouverte, et la main rendue", async () => {
    const home = freshHome("oathrion-console-ouverte-");
    const client = mcpClient(home, "carnet", "Cursor");
    await client.initialize();
    track(home);
    const run = cli(home, ["console", "--sans-navigateur"]);
    expect(await run.exited()).toBe(0);
    expect(run.stdout()).toMatch(/already open \(your client is running\)/);
    expect(linkIn(run.stdout())).toMatch(/\/console#\/connexion-locale\?ticket=v1\./);
    expect(await client.close()).toBe(0);
  }, 60_000);
});

describe.skipIf(!ready)("le pivot, devant plusieurs lancements", () => {
  it("un chemin RELATIF à la commande : le serveur démarre là où « wrap » a été lancé", async () => {
    const home = freshHome("oathrion-relatif-");
    const client = mcpClient(home, "relatif", "Cursor", { cwd: dirname(FAKE), args: [process.execPath, "./fake-stdio-mcp-server.cjs"] });
    await client.initialize();
    track(home);
    expect((await client.toolNames()).length, client.stderr()).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(home, "_local", "serveurs", "relatif", "commande.json"), "utf8"))).toMatchObject({ cwd: dirname(FAKE) });
    expect(await client.close()).toBe(0);
  }, 60_000);

  it("la console lancée PENDANT que le client démarre un serveur lent : aucun conflit, le client garde son serveur", async () => {
    const home = freshHome("oathrion-course-");
    const client = mcpClient(home, "lent", "Cursor", { args: ["sh", "-c", `sleep 3; exec "${process.execPath}" "${FAKE}"`] });
    await until(() => hubTree(home).length > 0, 20_000, "le pivot lancé");
    track(home);
    const consoleRun = cli(home, ["console", "--sans-navigateur"]);
    seen.add(consoleRun.proc.pid!);
    await until(() => /Direct sign-in/.test(consoleRun.stdout()), 30_000, "le lien de la console");

    await client.initialize();
    expect(await client.toolNames()).toContain("read_note");
    consoleRun.proc.kill("SIGINT");
    await consoleRun.exited();
    expect(await client.toolNames()).toContain("read_note");
    expect(await client.close()).toBe(0);
  }, 90_000);

  it("le même nom pour une AUTRE commande : refusé, et il dit pourquoi", async () => {
    const home = freshHome("oathrion-nom-pris-");
    const first = mcpClient(home, "carnet", "Cursor");
    await first.initialize();
    track(home);
    const other = mcpClient(home, "carnet", "claude-code", { args: [process.execPath, FAKE, "--autre"] });
    expect(await other.exited()).toBe(4);
    expect(other.stderr()).toMatch(/The name "carnet" is already taken by another command[\s\S]*--name/);
    expect(await first.close()).toBe(0);
  }, 60_000);
});
