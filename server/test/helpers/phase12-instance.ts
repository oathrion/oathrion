/**
 * PHASE 12 — lancement d'une instance Oathrion réelle dans son propre processus.
 *
 * Partagé par les suites multi-processus et redémarrage. `spawnSync` est volontaire :
 * les affirmations testées sont causales (A ouvre, B vérifie, C révoque, D refuse), et
 * un déroulé séquentiel est exactement ce que l'on veut observer.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE12_IDENTITY_URL =
  process.env.OATHRION_TEST_IDENTITY_PG_URL?.trim() ?? process.env.OATHRION_TEST_POSTGRES_URL?.trim() ?? "";

export const PHASE12_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const FIXTURE = path.join(
  PHASE12_REPO_ROOT,
  "server/test/fixtures/phase12-identity-instance.ts",
);

export interface OperationResult {
  op: string;
  [key: string]: unknown;
}

/** Environnement d'une instance : pilote PostgreSQL, plan d'identité PostgreSQL, rien d'implicite. */
export function phase12Env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_DRIVER: "postgres",
    DATABASE_URL: PHASE12_IDENTITY_URL,
    OATHRION_IDENTITY_PLANE: "postgres",
    // Exigé depuis la Phase 12 : identité et autorisation sur le même moteur.
    OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
    OATHRION_SESSION_SECRET: "phase12-multiprocess-session-secret",
    OATHRION_API_KEYS: "Phase12/CI:admin:phase12-multiprocess-bootstrap-key",
    ...extra,
  };
}

/** Lance une instance et renvoie le processus brut — utilisé quand un refus de démarrage est le résultat attendu. */
export function spawnInstance(
  ops: unknown[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 120_000,
): SpawnSyncReturns<string> {
  return spawnSync("npx", ["tsx", FIXTURE, JSON.stringify({ ops })], {
    cwd: PHASE12_REPO_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    env: phase12Env(extraEnv),
  });
}

/** Lance une instance et renvoie les résultats de son plan. Lève si l'instance n'a rien renvoyé. */
export function runInstance(
  ops: unknown[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 120_000,
): OperationResult[] {
  const result = spawnInstance(ops, extraEnv, timeoutMs);
  return parseInstanceOutput(result);
}

/** Extrait la ligne `RESULT:` de la sortie d'une instance. */
export function parseInstanceOutput(result: SpawnSyncReturns<string>): OperationResult[] {
  const stdout = result.stdout ?? "";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("RESULT:"));
  if (line === undefined) {
    throw new Error(
      `l'instance n'a rien renvoyé (code ${String(result.status)}).\nstdout: ${stdout}\nstderr: ${result.stderr ?? ""}`,
    );
  }
  return JSON.parse(line.slice("RESULT:".length)) as OperationResult[];
}

/** Applique les migrations PostgreSQL (idempotent, jamais au démarrage d'une instance). */
export function migratePhase12Database(): void {
  const migrate = spawnSync("npx", ["tsx", "script/migrate-postgres.ts"], {
    cwd: PHASE12_REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: PHASE12_IDENTITY_URL },
  });
  if (migrate.status !== 0) {
    throw new Error(`migrate-postgres a échoué : ${migrate.stdout}\n${migrate.stderr}`);
  }
}
