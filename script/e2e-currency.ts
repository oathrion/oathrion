/**
 * UN TENANT EN FRANCS CFA, DE BOUT EN BOUT (processus réel, PostgreSQL réel).
 *
 * ## Pourquoi ce script existe
 *
 * `shared/money.test.ts` et `shared/policy/currency.test.ts` prouvent la logique
 * monétaire, mais ce sont des tests du moteur : ils appellent une fonction pure. La
 * revendication qu'un client achète est différente :
 *
 *     une organisation déclarée en XOF  →  ses plafonds sont jugés en XOF
 *                                       →  ses refus et ses journaux parlent en francs
 *                                       →  un montant en EUR est refusé, jamais converti
 *
 * Ces propriétés traversent HTTP, le service de décision, la base et le rendu des
 * motifs. Un test unitaire ne peut pas les établir : il suffirait qu'une seule couche
 * substitue l'euro — le formateur, la gateway, le connecteur — pour que la décision soit
 * juste et l'effet faux.
 *
 * ## Ce que le script NE prouve pas
 *
 * Aucun appel à un vrai fournisseur de paiement. L'effet aval est compté dans la base,
 * pas chez un prestataire. Aucune conversion n'est testée parce qu'Oathrion n'en fait aucune :
 * c'est précisément la propriété vérifiée ici.
 *
 * Exige une base PostgreSQL joignable et un bundle construit. Sort en 2 s'il en manque
 * un — jamais un succès silencieux.
 *
 *   DATABASE_URL=postgres://user:password@host:5432/postgres npm run e2e:currency
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { Client } from "pg";

import { createThrowawayDatabase, baseUrl, redactUrl, productionPostgresEnv } from "./lib/throwaway-postgres";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");

const SESSION_SECRET = "currency-e2e-session-secret-0123456789";
const CONSOLE_EMAIL = "admin@currency-e2e.test";
const CONSOLE_PASSWORD = "currency-e2e-console-password-01";
const BOOTSTRAP_KEY = "currency-e2e-admin-key-0123456789";

/** The tenant under test. Declared in francs CFA (BCEAO), not in euros. */
const TENANT_CURRENCY = "XOF";

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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

interface Reply {
  status: number;
  body: unknown;
  text: string;
}

async function call(
  port: number,
  method: string,
  route: string,
  credential?: string,
  body?: unknown,
): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

/** An agent whose mandate ceiling is 500 000 XOF — about 760 €. */
function agentBody(id: string) {
  return {
    id,
    name: "Agent achats Dakar",
    description: "Créé par e2e-currency",
    provider: "openai" as const,
    model: "gpt-4o",
    status: "active" as const,
    owner: "e2e-currency",
    mandate: {
      maxTransactionAmount: 500_000,
      currency: TENANT_CURRENCY,
      allowedCategories: [],
      blockedCategories: [],
      allowedDomains: [],
    },
    permissions: [
      {
        scope: "execute:payments" as const,
        label: "Paiements",
        description: "",
        granted: true,
        risk: "high" as const,
      },
    ],
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
  console.log("Oathrion — UN TENANT EN FRANCS CFA (XOF), DE BOUT EN BOUT");
  // eslint-disable-next-line no-console
  console.log("=".repeat(78));

  if (!existsSync(BUNDLE)) {
    console.error("\nPas de bundle dans dist/index.cjs. Lancez d'abord `npm run build`.");
    return 2;
  }

  let database;
  try {
    database = await createThrowawayDatabase("oathrion_currency");
    // eslint-disable-next-line no-console
    console.log(`\nBase de ce test : ${database.name} sur ${redactUrl(baseUrl())}`);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const port = await freePort();
  const org = "org_default";
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(database.url),
      OATHRION_DB: undefined,
      PORT: String(port),
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: `Currency E2E Admin:admin:${BOOTSTRAP_KEY}`,
      OATHRION_CONSOLE_USERS: `${CONSOLE_EMAIL}:admin:${CONSOLE_PASSWORD}`,
      OATHRION_SEED: "",
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }) as BootedChild;
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));

  const probe = new Client({ connectionString: database.url });

  try {
    let booted = false;
    for (let i = 0; i < 120 && !booted; i += 1) {
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(5000) });
        if (r.status === 200) booted = true;
      } catch {
        await sleep(300);
      }
    }
    record("l'instance démarre en production sur PostgreSQL", booted, booted ? `port ${port}` : output.slice(-400));
    if (!booted) return 1;

    await probe.connect();

    /*
     * The tenant is declared in XOF by the operator, directly on the registry table —
     * there is no API for it yet, which is recorded as a remaining gap rather than
     * papered over here. The process is then restarted because tenant scopes (and the
     * currency they resolve) are built once per process in `routes.ts`.
     */
    const updated = await probe.query("UPDATE organizations SET currency = $1 WHERE id = $2", [
      TENANT_CURRENCY,
      org,
    ]);
    record(
      `l'organisation est déclarée en ${TENANT_CURRENCY}`,
      updated.rowCount === 1,
      `${updated.rowCount} ligne(s) mise(s) à jour`,
    );
    if (updated.rowCount !== 1) return 1;

    child.kill("SIGTERM");
    await sleep(2500);
    const restarted = spawn("node", [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...productionPostgresEnv(database.url),
        OATHRION_DB: undefined,
        PORT: String(port),
        OATHRION_SESSION_SECRET: SESSION_SECRET,
        OATHRION_API_KEYS: `Currency E2E Admin:admin:${BOOTSTRAP_KEY}`,
        OATHRION_CONSOLE_USERS: `${CONSOLE_EMAIL}:admin:${CONSOLE_PASSWORD}`,
        OATHRION_SEED: "",
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }) as BootedChild;
    restarted.stdout.on("data", (c: Buffer) => (output += c.toString()));
    restarted.stderr.on("data", (c: Buffer) => (output += c.toString()));

    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
      if (restarted.exitCode !== null) break;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(5000) });
        if (r.status === 200) up = true;
      } catch {
        await sleep(300);
      }
    }
    record("l'instance redémarre avec le tenant en francs CFA", up);
    if (!up) return 1;

    const login = await call(port, "POST", "/api/auth/login", undefined, {
      email: CONSOLE_EMAIL,
      password: CONSOLE_PASSWORD,
    });
    const token = (login.body as { token?: string } | null)?.token ?? "";
    record("une session de console s'ouvre", login.status === 200 && token !== "", `status ${login.status}`);
    if (token === "") return 1;

    // 1. An agent whose mandate is denominated in XOF is accepted by the write contract.
    const agentId = `agt_xof_${Math.random().toString(16).slice(2, 8)}`;
    const created = await call(port, "POST", "/api/agents", token, agentBody(agentId));
    record(
      `un mandat libellé en ${TENANT_CURRENCY} est accepté par l'API`,
      created.status === 201,
      `status ${created.status}${created.status >= 400 ? ` — ${created.text.slice(0, 200)}` : ""}`,
    );
    if (created.status !== 201) return 1;

    // A credential bound to that agent: production requires binding.
    const issued = await call(port, "POST", "/api/keys", token, {
      name: "Clé agent XOF",
      role: "operator",
      agentId,
    });
    const agentKey = (issued.body as { secret?: string } | null)?.secret ?? "";
    record("une clé liée à l'agent est émise", issued.status === 201 && agentKey !== "", `status ${issued.status}`);
    if (agentKey === "") return 1;

    // 2. 400 000 XOF is under the 500 000 ceiling → ALLOW, and the reason speaks francs.
    const under = await call(port, "POST", "/api/evaluate", agentKey, {
      agentId,
      action: "purchase",
      target: "fournisseur.sn",
      amount: 400_000,
      currency: TENANT_CURRENCY,
    });
    const underBody = under.body as { decision?: string; reason?: string } | null;
    record(
      "400 000 XOF sous le plafond → ALLOW",
      under.status === 200 && underBody?.decision === "ALLOW",
      `${under.status} / ${underBody?.decision ?? "?"}`,
    );
    record(
      "le motif ne contient aucun symbole euro",
      !(underBody?.reason ?? "").includes("€"),
      `motif : ${(underBody?.reason ?? "").slice(0, 120)}`,
    );

    // 3. 900 000 XOF exceeds the mandate → held, not allowed.
    const over = await call(port, "POST", "/api/evaluate", agentKey, {
      agentId,
      action: "purchase",
      target: "fournisseur.sn",
      amount: 900_000,
      currency: TENANT_CURRENCY,
    });
    const overBody = over.body as { decision?: string; reason?: string } | null;
    record(
      "900 000 XOF au-dessus du plafond → n'est pas ALLOW",
      overBody?.decision !== "ALLOW",
      `${over.status} / ${overBody?.decision ?? "?"}`,
    );

    /*
     * 4. The case the whole exercise is about. 400 000 EUR is roughly 262 milliards de
     * francs CFA. Compared as bare numbers against a 500 000 ceiling it looks ALLOWABLE,
     * which is exactly what a single-currency engine did with a currency it could not
     * represent. It must be refused, and not converted.
     */
    const wrongCurrency = await call(port, "POST", "/api/evaluate", agentKey, {
      agentId,
      action: "purchase",
      target: "fournisseur.sn",
      amount: 400_000,
      currency: "EUR",
    });
    const wrongBody = wrongCurrency.body as { decision?: string; reason?: string } | null;
    record(
      "400 000 EUR chez un tenant XOF → refusé, jamais converti",
      wrongCurrency.status >= 400 || wrongBody?.decision === "BLOCK",
      `${wrongCurrency.status} / ${wrongBody?.decision ?? "?"}`,
    );

    // 5. An unknown code is a mistake, not a currency: "CFA" is ambiguous between XOF and XAF.
    const unknown = await call(port, "POST", "/api/evaluate", agentKey, {
      agentId,
      action: "purchase",
      target: "fournisseur.sn",
      amount: 1000,
      currency: "CFA",
    });
    const unknownBody = unknown.body as { decision?: string } | null;
    record(
      "une devise inconnue (« CFA ») est refusée plutôt que devinée",
      unknown.status >= 400 || unknownBody?.decision === "BLOCK",
      `${unknown.status} / ${unknownBody?.decision ?? "?"}`,
    );

    // 6. A fractional franc is refused rather than rounded.
    const fractional = await call(port, "POST", "/api/evaluate", agentKey, {
      agentId,
      action: "purchase",
      target: "fournisseur.sn",
      amount: 1000.5,
      currency: TENANT_CURRENCY,
    });
    const fractionalBody = fractional.body as { decision?: string } | null;
    record(
      "1000,5 XOF (franc fractionnaire) est refusé plutôt qu'arrondi",
      fractional.status >= 400 || fractionalBody?.decision === "BLOCK",
      `${fractional.status} / ${fractionalBody?.decision ?? "?"}`,
    );

    // 7. The audit trail of this tenant must never render euros.
    const audit = await call(port, "GET", "/api/audit", token);
    record(
      "le journal d'audit du tenant ne contient aucun montant en euros",
      !audit.text.includes("€"),
      `${audit.status}, ${audit.text.length} octets inspectés`,
    );

    const failures = checks.filter((c) => !c.ok);
    // eslint-disable-next-line no-console
    console.log(
      `\n${"=".repeat(78)}\n${failures.length === 0 ? "PASS" : "FAIL"} — ` +
        `${checks.length - failures.length}/${checks.length} vérifications\n${"=".repeat(78)}`,
    );
    if (failures.length > 0) console.error(`\n--- sortie de l'instance ---\n${output.slice(-2500)}`);

    if (restarted.exitCode === null) restarted.kill("SIGTERM");
    return failures.length === 0 ? 0 : 1;
  } finally {
    for (const c of [child]) if (c.exitCode === null) c.kill("SIGKILL");
    await probe.end().catch(() => undefined);
    await database.dispose();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
