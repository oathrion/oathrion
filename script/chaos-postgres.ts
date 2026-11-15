/**
 * CHAOS, POSTGRESQL EDITION — the database is taken away underneath a running Oathrion.
 *
 * ## Why this exists alongside script/chaos.ts
 *
 * `script/chaos.ts` injects SQLite *file* failures: deleted underneath the server, made
 * read-only, corrupted, exclusively locked, out of disk. None of those exist on
 * PostgreSQL, and since Phase 12.2 SQLite cannot run in production at all — so that bench
 * now runs outside production mode, and the production engine had no chaos coverage.
 *
 * PostgreSQL fails differently: the server goes away, and later comes back. Two
 * properties matter when it does, and neither can be established by a unit test:
 *
 *   FAIL CLOSED   with the database gone, Oathrion authorises nothing, reports itself
 *                 unready, and never opens a local SQLite file instead. No request that
 *                 was refused leaves a row behind.
 *   RECOVER       when the database returns, the SAME process serves again. Needing a
 *                 restart would mean a database blip requires an operator.
 *
 * ## Why this does not replace server/test/phase12-restart-reconnect.test.ts
 *
 * That suite drives a Debian system cluster through `sudo -n pg_ctlcluster`. On a host
 * without a system cluster or without passwordless sudo it skips, loudly — which is
 * honest, but means the property goes unproven on exactly the machines most developers
 * use. This script proves the same thing by cycling a Docker container instead, so the
 * two cover each other's blind spot.
 *
 * ## Running it
 *
 * Needs a PostgreSQL in a container this script is allowed to stop and start, a migrated
 * database, and a build. Nothing is destroyed: `docker stop` is a clean shutdown and the
 * data lives in the container's volume, so the schema and every row survive the cycle.
 *
 *   OATHRION_TEST_PG_DOCKER=placet-p12-2-postgres \
 *   DATABASE_URL=postgres://user:password@127.0.0.1:55432/placet \
 *   npm run chaos:postgres
 *
 * Without `OATHRION_TEST_PG_DOCKER` it SKIPS and says so, exiting 0: this script stops a
 * shared service, so it must never do that to a database nobody named. A skip is
 * reported as a skip — it is never counted as a pass.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "pg";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");

const CONTAINER = process.env.OATHRION_TEST_PG_DOCKER?.trim() ?? "";
/*
 * Alternative to Docker: a system cluster driven by `sudo -n pg_ctlcluster`, e.g.
 * OATHRION_TEST_PG_CTLCLUSTER="18 main". Same safety rule — it must be named explicitly,
 * and `sudo -n` fails instead of prompting. Used when no container runtime exists.
 */
const CLUSTER = process.env.OATHRION_TEST_PG_CTLCLUSTER?.trim() ?? "";
const TARGET = CONTAINER !== "" ? `container "${CONTAINER}"` : `cluster "${CLUSTER}"`;
const PG_URL = process.env.DATABASE_URL?.trim() ?? "";

/* Credentials for this run only. */
const SESSION_SECRET = "chaos-pg-session-secret-0123456789";
const CONSOLE_EMAIL = "chaos-pg@placet.invalid";
const CONSOLE_PASSWORD = "chaos-pg-console-password-01";
const BOOTSTRAP_KEY = "chaos-pg-admin-key-0123456789";

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

function docker(...args: string[]) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
}

function pgctl(action: "stop" | "start") {
  const [version, name = "main"] = CLUSTER.split(/\s+/);
  return spawnSync("sudo", ["-n", "pg_ctlcluster", version, name, action, "--skip-systemctl-redirect"], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** Stops / starts whichever target was named. */
function stopDatabase() {
  return CONTAINER !== "" ? docker("stop", CONTAINER) : pgctl("stop");
}
function startDatabase() {
  return CONTAINER !== "" ? docker("start", CONTAINER) : pgctl("start");
}

/** True when the target PostgreSQL reports that it is accepting connections. */
function pgReady(): boolean {
  if (CONTAINER !== "") return docker("exec", CONTAINER, "pg_isready", "-q").status === 0;
  const url = new URL(PG_URL);
  return spawnSync("pg_isready", ["-q", "-h", url.hostname, "-p", url.port || "5432"], { timeout: 10_000 }).status === 0;
}

async function waitPg(up: boolean, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let state = false;
    try {
      state = pgReady();
    } catch {
      state = false;
    }
    if (state === up) return true;
    await sleep(500);
  }
  return false;
}

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
}

/**
 * A request that cannot be made is reported as status 0.
 *
 * Deliberate: this script asks "was anything authorised", and a refused connection or a
 * timeout is not an authorisation. Letting the error propagate would abort the run at the
 * exact moment the interesting thing is happening.
 */
async function call(
  port: number,
  method: string,
  route: string,
  credential?: string,
  body?: unknown,
): Promise<Reply> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

function agentBody(id: string) {
  return {
    id,
    name: `Chaos PG ${id}`,
    description: "Créé par chaos-postgres",
    provider: "openai" as const,
    model: "gpt-4o",
    status: "active" as const,
    owner: "chaos-pg",
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
  console.log("Oathrion — CHAOS ON POSTGRESQL (the database is stopped under a live instance)");
  // eslint-disable-next-line no-console
  console.log("=".repeat(78));

  if ((CONTAINER === "" && CLUSTER === "") || PG_URL === "") {
    // eslint-disable-next-line no-console
    console.log(
      "\nSKIPPED — this bench stops and starts a PostgreSQL container, so it refuses to run\n" +
        "against a database nobody named. Set both and retry:\n" +
        "  OATHRION_TEST_PG_DOCKER=<container name>   (or OATHRION_TEST_PG_CTLCLUSTER=\"18 main\")\n" +
        "  DATABASE_URL=postgres://user:password@host:port/database\n" +
        "Nothing was tested. This is a SKIP, not a pass: fail-closed on database loss and\n" +
        "recovery afterwards remain UNPROVEN on this machine.",
    );
    return 0;
  }

  if (!existsSync(BUNDLE)) {
    console.error("\nNo bundle at dist/index.cjs. Run `npm run build` first.");
    return 2;
  }
  if (!(await waitPg(true, 20_000))) {
    console.error(`\nPostgreSQL ${TARGET} is not up to begin with; refusing to start.`);
    return 2;
  }

  const port = await freePort();
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_DRIVER: "postgres",
      DATABASE_URL: PG_URL,
      OATHRION_IDENTITY_PLANE: "postgres",
      OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
      RATE_LIMIT_STORE: "postgres",
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: `Chaos PG Admin:admin:${BOOTSTRAP_KEY}`,
      OATHRION_CONSOLE_USERS: `${CONSOLE_EMAIL}:admin:${CONSOLE_PASSWORD}`,
      OATHRION_SEED: "",
      OATHRION_DB: undefined,
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));

  const tag = Math.random().toString(16).slice(2, 8);
  const idBefore = `agt_chaospg_${tag}_before`;
  const idDuring = `agt_chaospg_${tag}_during`;
  const idAfter = `agt_chaospg_${tag}_after`;

  try {
    let booted = false;
    for (let i = 0; i < 120 && !booted; i += 1) {
      if (child.exitCode !== null) break;
      const probe = await call(port, "GET", "/api/ready");
      if (probe.status !== 0) booted = true;
      else await sleep(300);
    }
    record("the instance boots in production mode on PostgreSQL", booted, booted ? `port ${port}` : output.slice(-400));
    if (!booted) return 1;

    /* --- baseline, database up ------------------------------------------- */
    const ready = await call(port, "GET", "/api/ready");
    record("baseline: /api/ready answers 200", ready.status === 200, `status ${ready.status}`);

    const login = await call(port, "POST", "/api/auth/login", undefined, {
      email: CONSOLE_EMAIL,
      password: CONSOLE_PASSWORD,
    });
    const token = (login.body as { token?: string } | null)?.token ?? "";
    record("baseline: a console session opens", login.status === 200 && token !== "", `status ${login.status}`);

    const allowed = await call(port, "POST", "/api/agents", token, agentBody(idBefore));
    record("baseline: an authorised write succeeds", allowed.status === 201, `status ${allowed.status}`);

    /* --- the database is taken away --------------------------------------- */
    // eslint-disable-next-line no-console
    console.log(`\n  -- stopping ${TARGET} (clean shutdown, the data persists) --`);
    stopDatabase();
    record("the database is confirmed down", await waitPg(false));

    const readyDown = await call(port, "GET", "/api/ready");
    record("FAIL CLOSED: /api/ready reports not ready (503)", readyDown.status === 503, `status ${readyDown.status}`);

    const writeDown = await call(port, "POST", "/api/agents", token, agentBody(idDuring));
    record(
      "FAIL CLOSED: nothing is authorised while the datastore is gone",
      writeDown.status !== 201,
      `status ${writeDown.status} (201 would be an authorisation)`,
    );

    const sessionDown = await call(port, "GET", "/api/auth/session", token);
    record(
      "FAIL CLOSED: a session cannot be validated without the identity plane",
      sessionDown.status !== 200,
      `status ${sessionDown.status}`,
    );

    record(
      "FAIL CLOSED: no SQLite file is opened as a fallback",
      !existsSync(path.join(ROOT, "data.db")) && !existsSync(path.join(ROOT, "identity.db")),
    );

    record(
      "the process stays up instead of dying on the first failed query",
      child.exitCode === null,
      child.exitCode === null ? "still running" : `exited ${child.exitCode}`,
    );

    /* --- and comes back --------------------------------------------------- */
    // eslint-disable-next-line no-console
    console.log(`\n  -- starting ${TARGET} again --`);
    startDatabase();
    record("the database is back up", await waitPg(true));

    let readyAgain: Reply = { status: 0, body: null };
    for (let i = 0; i < 90; i += 1) {
      readyAgain = await call(port, "GET", "/api/ready");
      if (readyAgain.status === 200) break;
      await sleep(1000);
    }
    record(
      "RECOVER: the same process becomes ready again, with no restart",
      readyAgain.status === 200,
      `status ${readyAgain.status}`,
    );

    const probe = new Client({ connectionString: PG_URL });
    await probe.connect();
    try {
      const refused = await probe.query<{ n: string }>(
        "select count(*)::text as n from agents where id = $1",
        [idDuring],
      );
      record(
        "FAIL CLOSED: the refused write left zero rows behind",
        refused.rows[0]?.n === "0",
        `rows = ${refused.rows[0]?.n ?? "?"}`,
      );

      const login2 = await call(port, "POST", "/api/auth/login", undefined, {
        email: CONSOLE_EMAIL,
        password: CONSOLE_PASSWORD,
      });
      const token2 = (login2.body as { token?: string } | null)?.token ?? token;
      const after = await call(port, "POST", "/api/agents", token2, agentBody(idAfter));
      record("RECOVER: authorised writes work again", after.status === 201, `status ${after.status}`);

      const survived = await probe.query<{ v: string | null }>(
        "select max(version)::text as v from schema_migrations",
      );
      record(
        "the schema survived the cycle",
        survived.rows[0]?.v !== null,
        `migration version ${survived.rows[0]?.v ?? "?"}`,
      );
    } finally {
      await probe.end();
    }

    const failures = checks.filter((c) => !c.ok);
    // eslint-disable-next-line no-console
    console.log(
      `\n${"=".repeat(78)}\n${failures.length === 0 ? "PASS" : "FAIL"} — ` +
        `${checks.length - failures.length}/${checks.length} checks\n${"=".repeat(78)}`,
    );
    if (failures.length > 0) console.error(`\n--- instance output (tail) ---\n${output.slice(-2500)}`);
    return failures.length === 0 ? 0 : 1;
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await sleep(2000);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    /*
     * The container is brought back whatever happened above. A bench that leaves a
     * developer's database stopped after a failure has caused a second problem while
     * reporting the first.
     */
    try {
      if (!pgReady()) {
        startDatabase();
        await waitPg(true);
      }
    } catch {
      console.error(`\n[chaos-postgres] could not confirm ${TARGET} is running again — check it.`);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
