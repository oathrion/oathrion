/**
 * DEUX INSTANCES Oathrion RÉELLES, UNE SEULE IDENTITÉ — PHASE 12.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * `server/test/phase12-multiprocess-identity.test.ts` prouve que les magasins d'identité
 * partagent la base entre processus. Il n'exécute pas de serveur HTTP. L'affirmation
 * qu'un client achète est pourtant celle-ci :
 *
 *     instance A ─┐
 *                 ├── PostgreSQL   →  une clé révoquée sur A est refusée par B
 *     instance B ─┘                    au niveau de la requête, pas du magasin
 *
 * Donc ce script démarre `dist/index.cjs` DEUX fois, sur deux ports, contre un seul
 * PostgreSQL, avec `OATHRION_IDENTITY_PLANE=postgres`, et vérifie la chaîne complète :
 * émission de credential sur A → requête autorisée sur B → révocation sur A → même
 * requête refusée sur B, et **aucun effet en aval** après le refus.
 *
 * La règle §17 est vérifiée par comptage réel côté base :
 *   - Oathrion autorise  → l'agent est créé exactement une fois ;
 *   - Oathrion refuse    → zéro ligne créée.
 *
 * Exige un PostgreSQL joignable et un bundle construit. Sort en 2 s'il en manque un —
 * jamais un succès silencieux.
 *
 * Usage : DATABASE_URL=postgres://… npm run e2e:identity
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { Client } from "pg";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");

const PORT_A = 5231;
const PORT_B = 5232;

const BOOTSTRAP_KEY = "identity-e2e-admin-key-0123456789";
const SESSION_SECRET = "identity-e2e-session-secret-0123456789";
const CONSOLE_PASSWORD = "identity-e2e-console-password-01";
const CONSOLE_EMAIL = "admin@identity-e2e.test";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type BootedChild = ChildProcessByStdio<null, Readable, Readable>;

function boot(port: number, pgUrl: string): { child: BootedChild; output: () => string } {
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      /*
       * Le point du script : les deux plans sont sur PostgreSQL. Aucun OATHRION_DB, aucune
       * autorisation SQLite en production — si le processus ouvrait un fichier local
       * pour l'identité, la révocation ne traverserait pas et le test échouerait.
       */
      DATABASE_DRIVER: "postgres",
      DATABASE_URL: pgUrl,
      OATHRION_IDENTITY_PLANE: "postgres",
      OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: `Identity E2E Admin:admin:${BOOTSTRAP_KEY}`,
      OATHRION_CONSOLE_USERS: `${CONSOLE_EMAIL}:admin:${CONSOLE_PASSWORD}`,
      OATHRION_SEED: "",
      RATE_LIMIT_STORE: "postgres",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as BootedChild;
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  return { child, output: () => output };
}

async function waitForBoot(child: BootedChild, port: number, timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
      return true;
    } catch {
      await sleep(200);
    }
  }
  return false;
}

async function stop(child: BootedChild): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(8000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

interface Reply {
  status: number;
  body: unknown;
}

async function call(
  port: number,
  method: string,
  route: string,
  credential: string,
  body?: unknown,
): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function agentBody(id: string) {
  return {
    id,
    name: `Phase 12 ${id}`,
    description: "Créé par e2e-identity-instances",
    provider: "openai" as const,
    model: "gpt-4o",
    status: "active" as const,
    owner: "phase12",
    mandate: {
      maxTransactionAmount: 100,
      currency: "EUR" as const,
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
    permissions: [],
    policyIds: [],
    tags: [],
    currentTask: null,
    createdAt: new Date().toISOString().slice(0, 10),
    executions24h: 0,
    successRate: 0,
    cost24h: 0,
    costMonth: 0,
    riskLevel: "low" as const,
  };
}

async function main(): Promise<number> {
  // eslint-disable-next-line no-console
  console.log("=".repeat(78));
  // eslint-disable-next-line no-console
  console.log("Oathrion — DEUX INSTANCES, UNE IDENTITÉ POSTGRESQL (processus réels, base réelle)");
  // eslint-disable-next-line no-console
  console.log("=".repeat(78));

  if (!existsSync(BUNDLE)) {
    console.error("\nPas de bundle dans dist/index.cjs. Lancez d'abord `npm run build`.");
    return 2;
  }
  const pgUrl = process.env.DATABASE_URL ?? process.env.OATHRION_TEST_IDENTITY_PG_URL ?? "";
  if (pgUrl === "") {
    console.error("\nPas de DATABASE_URL. Ce script exige un PostgreSQL joignable ; refus de passer en silence.");
    return 2;
  }

  const probe = new Client({ connectionString: pgUrl });
  await probe.connect();
  const { rows } = await probe.query<{ version: number | null }>(
    "select max(version) as version from schema_migrations",
  );
  if ((rows[0]?.version ?? 0) < 14) {
    console.error("\nSchéma PostgreSQL absent ou en retard. Lancez `npm run migrate:postgres`.");
    await probe.end();
    return 2;
  }

  const suffix = Math.random().toString(16).slice(2, 8);
  const a = boot(PORT_A, pgUrl);
  const b = boot(PORT_B, pgUrl);
  try {
    const bootedA = await waitForBoot(a.child, PORT_A);
    const bootedB = await waitForBoot(b.child, PORT_B);
    record("les deux instances démarrent avec l'identité sur PostgreSQL", bootedA && bootedB);
    if (!bootedA || !bootedB) {
      console.error(`\n--- instance A ---\n${a.output()}\n--- instance B ---\n${b.output()}`);
      return 1;
    }
    // Aucune des deux instances n'a pu ouvrir de base d'identité locale.
    record(
      "aucun fichier d'identité SQLite n'est créé par une instance en mode postgres",
      !existsSync(path.join(ROOT, "identity.db")) && !existsSync(path.join(ROOT, "data.db")),
    );

    /*
     * La console d'abord : depuis la Phase 9, une clé machine ne peut pas émettre de
     * credential — seul un administrateur connecté le peut (durcissement délibéré, voir
     * la route /api/keys). C'est donc la session ouverte sur A qui émet la clé.
     */
    const loginRes = await fetch(`http://127.0.0.1:${PORT_A}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD }),
    });
    const loginBody = (await loginRes.json()) as { token?: string };
    const token = loginBody.token ?? "";
    record(
      "instance A ouvre une session de console",
      loginRes.status === 200 && token !== "",
      `status ${loginRes.status}`,
    );

    const sessionOnB = await call(PORT_B, "GET", "/api/auth/session", token);
    record(
      "instance B reconnaît la session ouverte sur A",
      sessionOnB.status === 200,
      `status ${sessionOnB.status}`,
    );

    // 1. A émet une clé d'API, avec la session administrateur.
    const issued = await call(PORT_A, "POST", "/api/keys", token, {
      name: `phase12-${suffix}`,
      role: "admin",
    });
    const secret = (issued.body as { secret?: string; key?: { id?: string } } | null)?.secret ?? "";
    const keyId = (issued.body as { key?: { id?: string } } | null)?.key?.id ?? "";
    record(
      "instance A émet une clé d'API (201) écrite dans PostgreSQL",
      issued.status === 201 && secret !== "" && keyId !== "",
      `status ${issued.status}`,
    );

    // 2. B, qui n'a jamais vu cette clé, l'accepte : la vérité vient de la base.
    const allowed = await call(PORT_B, "POST", "/api/agents", secret, agentBody(`agt_p12_${suffix}`));
    record(
      "instance B autorise la clé émise par A (aval exécuté exactement une fois)",
      allowed.status === 201,
      `status ${allowed.status}`,
    );
    const afterAllow = await probe.query<{ n: string }>(
      "select count(*)::text as n from agents where id = $1",
      [`agt_p12_${suffix}`],
    );
    record(
      "§17 — Oathrion autorise → exactement 1 ligne en aval",
      afterAllow.rows[0]?.n === "1",
      `lignes = ${afterAllow.rows[0]?.n ?? "?"}`,
    );

    // 3. A révoque la clé.
    const revoked = await call(PORT_A, "DELETE", `/api/keys/${keyId}`, token);
    record("instance A révoque la clé", revoked.status === 200, `status ${revoked.status}`);

    // 4. B refuse immédiatement, sans redémarrage ni invalidation de cache.
    const refusedId = `agt_p12_${suffix}_after_revoke`;
    const refused = await call(PORT_B, "POST", "/api/agents", secret, agentBody(refusedId));
    record(
      "instance B refuse la clé révoquée par A (401)",
      refused.status === 401,
      `status ${refused.status}`,
    );
    const afterRefuse = await probe.query<{ n: string }>(
      "select count(*)::text as n from agents where id = $1",
      [refusedId],
    );
    record(
      "§17 — Oathrion refuse → zéro ligne en aval",
      afterRefuse.rows[0]?.n === "0",
      `lignes = ${afterRefuse.rows[0]?.n ?? "?"}`,
    );

    // 5. La session : révoquée sur A, refusée par B — même mécanique, autre credential.
    // Déconnexion demandée à A : la révocation est côté serveur, donc partagée.
    const logout = await call(PORT_A, "POST", "/api/auth/logout", token);
    record("instance A révoque la session", logout.status === 200, `status ${logout.status}`);

    const afterLogout = await call(PORT_B, "GET", "/api/auth/session", token);
    record(
      "instance B refuse la session révoquée sur A (401)",
      afterLogout.status === 401,
      `status ${afterLogout.status}`,
    );

    const failures = checks.filter((c) => !c.ok);
    // eslint-disable-next-line no-console
    console.log(
      `\n${failures.length === 0 ? "PASS" : "FAIL"} — ${checks.length - failures.length}/${checks.length} vérifications`,
    );
    if (failures.length > 0) {
      console.error(`\n--- instance A ---\n${a.output()}\n--- instance B ---\n${b.output()}`);
    }
    return failures.length === 0 ? 0 : 1;
  } finally {
    await stop(a.child);
    await stop(b.child);
    await probe.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
