/**
 * L'adresse d'écoute, éprouvée sur le VRAI serveur et à travers une VRAIE interface.
 *
 * Le serveur écoutait sur `0.0.0.0` en dur : une instance lancée sur un poste de
 * développement ou de démonstration était joignable depuis tout le réseau local
 * (relevé pendant la campagne d'endurance, docs/STRESS-TEST-LOG.md). Le défaut est
 * désormais la boucle locale, et `OATHRION_HOST` déclare tout autre choix.
 *
 * Ce fichier démarre `server/index.ts` comme un processus séparé — c'est l'appel à
 * `listen` qui est en cause, pas une fonction de configuration — puis tente une connexion
 * par l'adresse de la machine sur le réseau local. Par défaut elle doit être REFUSÉE ;
 * avec `OATHRION_HOST=0.0.0.0` elle doit aboutir, ce qui prouve que le test sait voir la
 * différence. Dans les deux cas, une route protégée reste fermée sans credential.
 *
 * Sans interface réseau autre que la boucle locale (conteneur de CI isolé), la partie
 * « interface réseau » ne peut pas s'exécuter : elle est ignorée et le dit, au lieu de
 * passer en silence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Une adresse IPv4 de la machine qui n'est pas la boucle locale, ou null. */
function networkAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

const LAN = networkAddress();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Une connexion TCP qui aboutit (true) ou est refusée / n'aboutit pas (false). */
function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

let child: ChildProcess | null = null;
let workDir: string | null = null;

afterEach(() => {
  child?.kill("SIGTERM");
  child = null;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

async function startServer(extraEnv: Record<string, string>): Promise<{ port: number; log: () => string }> {
  const port = await freePort();
  workDir = mkdtempSync(path.join(os.tmpdir(), "placet-binding-"));
  let log = "";
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    PORT: String(port),
    OATHRION_DB: path.join(workDir, "placet.db"),
    OATHRION_SESSION_SECRET: "liaison-reseau-0123456789abcdef",
    OATHRION_ACCOUNTS: "database",
    ...extraEnv,
  };
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`le serveur s'est arrêté :\n${log}`);
    /* Prêt quand il répond par la boucle locale — pas quand il imprime un message. */
    const ready = await fetch(`http://127.0.0.1:${port}/api/live`).then((r) => r.ok, () => false);
    if (ready) return { port, log: () => log };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`le serveur n'a pas démarré en 60 s :\n${log}`);
}

async function status(url: string): Promise<number> {
  const reply = await fetch(url);
  await reply.arrayBuffer();
  return reply.status;
}

describe("l'adresse d'écoute du serveur", () => {
  it("par défaut : boucle locale seulement, et le serveur le dit", async () => {
    const { port, log } = await startServer({});
    expect(log()).toMatch(new RegExp(`listening on 127\\.0\\.0\\.1:${port} — loopback only`));
    expect(await connects("127.0.0.1", port)).toBe(true);
    expect(await status(`http://127.0.0.1:${port}/api/live`)).toBe(200);
    // L'authentification reste exigée sur l'interface prévue.
    expect(await status(`http://127.0.0.1:${port}/api/agents`)).toBe(401);
  }, 90_000);

  it.skipIf(LAN === null)(
    `par défaut : une connexion par l'interface réseau ${LAN ?? "(aucune ici)"} est refusée`,
    async () => {
      const { port } = await startServer({});
      expect(await connects(LAN!, port)).toBe(false);
    },
    90_000,
  );

  it.skipIf(LAN === null)(
    "avec OATHRION_HOST=0.0.0.0 : la même connexion aboutit — le test voit bien la différence — et l'authentification reste exigée",
    async () => {
      const { port, log } = await startServer({ OATHRION_HOST: "0.0.0.0" });
      expect(log()).toMatch(/listening on 0\.0\.0\.0:\d+ — NOT loopback/);
      expect(await connects(LAN!, port)).toBe(true);
      expect(await status(`http://${LAN}:${port}/api/agents`)).toBe(401);
    },
    90_000,
  );

  it("refuse de démarrer sur un nom d'hôte", async () => {
    await expect(startServer({ OATHRION_HOST: "intranet.exemple" })).rejects.toThrow(/OATHRION_HOST must be an IP address/);
  }, 90_000);
});
