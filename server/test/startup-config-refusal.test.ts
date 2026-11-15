/**
 * Un réglage illisible refuse le démarrage EN LE NOMMANT, sur le VRAI serveur.
 *
 * Relevé en essayant le logiciel sur la machine de l'utilisateur : `server/routes.ts` était
 * importé en tête de `server/index.ts`, donc évalué AVANT `runtimeConfigProblems()`. Les
 * modules qui lisent leur configuration au chargement (`OATHRION_INTERCEPTS`,
 * `OATHRION_INTERCEPT_PACKS`, `OATHRION_TOOLS`) faisaient planter le processus avec une
 * trace de pile et du code compilé à l'écran. Le texte de l'erreur était juste, mais noyé.
 *
 * Ce fichier démarre `server/index.ts` comme un processus séparé : c'est l'ORDRE des
 * imports qui est en cause, et aucune fonction appelée isolément ne le montrerait.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let workDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

/** Lance le serveur avec un réglage, et rend sa sortie une fois le processus terminé. */
function startupOutput(extraEnv: Record<string, string>): Promise<{ code: number | null; log: string }> {
  workDir = mkdtempSync(path.join(os.tmpdir(), "oathrion-refusal-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    PORT: "0",
    OATHRION_DB: path.join(workDir, "oathrion.db"),
    OATHRION_SESSION_SECRET: "refus-au-demarrage-0123456789abcdef",
    OATHRION_ACCOUNTS: "database",
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
    /* Un serveur qui démarre quand même est un échec du test : on l'arrête et on le dit. */
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, log });
    });
  });
}

describe("un réglage lu au chargement refuse le démarrage par le message nommé", () => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ["OATHRION_INTERCEPTS illisible", { OATHRION_INTERCEPTS: "[" }, /✗ OATHRION_INTERCEPTS: the value is not valid JSON/],
    ["un paquet inconnu", { OATHRION_INTERCEPT_PACKS: "opanai" }, /✗ OATHRION_INTERCEPT_PACKS: the pack "opanai" does not exist/],
    ["OATHRION_TOOLS illisible", { OATHRION_TOOLS: "[" }, /✗ OATHRION_TOOLS: /],
  ];

  for (const [label, extraEnv, named] of cases) {
    it(label, async () => {
      const { code, log } = await startupOutput(extraEnv);
      expect(code).toBe(1);
      expect(log).toMatch(/Oathrion cannot start — the runtime environment is not valid\./);
      expect(log).toMatch(named);
      /* Pas de trace de pile : c'est elle qui noyait le message. */
      expect(log).not.toMatch(/^\s+at /m);
    }, 90_000);
  }
});
