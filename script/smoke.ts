/**
 * Production smoke test — boots the artefact that actually ships.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm run verify` proves the source typechecks, lints, passes the suite and builds.
 * None of that boots `dist/index.cjs`. The test suite imports TypeScript modules through
 * Vitest and starts Express in-process; the bundle is a different artefact, produced by a
 * different tool, with a different module system (CJS), different externals, and a native
 * addon (`better-sqlite3`) deliberately left unbundled and resolved from node_modules at
 * runtime. Every one of those is a way for a green suite to ship a binary that exits on
 * line one.
 *
 * §23 is explicit that compiling is not the finish line. So this runs the real command an
 * operator runs — `NODE_ENV=production node dist/index.cjs` — against a throwaway
 * database, and checks the handful of properties that decide whether a deployment is
 * alive or a page at 3am:
 *
 *   1. it boots at all, and binds the port;
 *   2. the probes a load balancer and an orchestrator call are reachable WITHOUT
 *      credentials, and liveness is a *different* answer from readiness — pointing a
 *      livenessProbe at the readiness check restarts every replica during a database
 *      outage (DEPLOYMENT.md § Sondes);
 *  2b. every response carries an X-Request-Id, and a malformed inbound one is replaced
 *      rather than echoed into the log;
 *   3. the console HTML is served (the client build landed in dist/public);
 *   4. an unauthenticated API call is refused, in the one error shape the console can
 *      actually render;
 *   5. an authenticated API call succeeds — so 4 was authentication, not a broken route;
 *   6. production ships with no seeded demo data;
 *   7. nothing secret appears in what the process wrote to stdout (§14, end to end —
 *      the unit tests cover the redactor, this covers the wiring);
 *   8. SIGTERM produces a clean, prompt exit rather than a hang or a crash.
 *
 * Deliberately NOT part of `npm run verify`: it needs a built dist/ and binds a real
 * port. It is a separate, explicit `npm run smoke`, meant to run after `npm run build`
 * in CI and before promoting a release.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  baseUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const CONSOLE_HTML = path.join(ROOT, "dist", "public", "index.html");

/** A free-ish high port, away from the 5000 the dev server uses. */
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;

/*
 * Credentials invented for this run only. They are long enough to satisfy the
 * production credential rules and are printed nowhere; check 7 asserts that the
 * process did not echo them into its own log.
 */
const API_KEY = "smoke-api-key-0123456789abcdef";
const SESSION_SECRET = "smoke-session-secret-0123456789abcdef";
const CONSOLE_PASSWORD = "smoke-console-password-0123456789";

/**
 * The exact shape `spawn` returns for `stdio: ["ignore", "pipe", "pipe"]`: no stdin,
 * readable stdout and stderr. Spelled out rather than cast to
 * `ChildProcessWithoutNullStreams`, which would claim a writable `stdin` that does not
 * exist — a lie the runtime tolerates and the typechecker does not.
 */
type BootedChild = ChildProcessByStdio<null, Readable, Readable>;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One request, returning status, body text and response headers, never throwing.
 *
 * Headers are returned because the correlation id is a *header* contract: checking only
 * the body would let the header quietly disappear while every check still passed.
 */
async function req(
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; headers: Headers }> {
  try {
    const res = await fetch(`${BASE}${pathname}`, init);
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
      headers: new Headers(),
    };
  }
}

/** Polls the public probe until the server answers, or gives up. */
async function waitForBoot(child: BootedChild, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { booted: false, reason: `exited with code ${child.exitCode}` };
    const res = await req("/api/health");
    if (res.status !== 0) return { booted: true, reason: `answered in ${timeoutMs - (deadline - Date.now())}ms` };
    await sleep(250);
  }
  return { booted: false, reason: `no answer within ${timeoutMs}ms` };
}

async function main(): Promise<number> {
  console.log("=".repeat(78));
  console.log("PRODUCTION SMOKE TEST — does the shipped bundle actually run?");
  console.log("=".repeat(78));

  // Fail loudly rather than "passing" against a stale or missing build: a smoke test
  // that silently tests nothing is worse than no smoke test.
  if (!existsSync(BUNDLE)) {
    console.error(`\nNo bundle at dist/index.cjs. Run \`npm run build\` first.`);
    return 2;
  }
  if (!existsSync(CONSOLE_HTML)) {
    console.error(`\nNo console at dist/public/index.html. Run \`npm run build\` first.`);
    return 2;
  }

  /*
   * A throwaway PostgreSQL database, created and migrated for this run alone.
   *
   * This used to be a temporary SQLite file. Since Phase 12.2, NODE_ENV=production
   * requires every plane to be on PostgreSQL and no variable opts out — so testing
   * "what the operator actually runs" means testing it on the engine the operator
   * actually runs. The database is dropped in the `finally` below.
   */
  let database: ThrowawayDatabase;
  try {
    database = await createThrowawayDatabase("oathrion_smoke");
    console.log(`\nDatabase for this run: ${database.name} on ${redactUrl(baseUrl())}`);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  console.log(`\nBooting ${path.relative(ROOT, BUNDLE)} on port ${PORT}…`);

  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(database.url),
      // Cleared so a path in the caller's shell cannot put records in a local file.
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: `Smoke Admin:admin:${API_KEY}`,
      OATHRION_CONSOLE_USERS: `Smoke Admin:admin:${CONSOLE_PASSWORD}`,
      // No OATHRION_SEED: check 6 asserts production starts empty.
      OATHRION_SEED: "",
      /*
       * P3 — a deliberately impossible ceiling on ONE counter, so the refusal path can
       * be exercised against the shipped bundle.
       *
       * `policies` and not `agents`: the checks above read `/api/agents` to prove
       * production starts empty, and this script must not change what they observe. The
       * two counters go through the same guard, so refusing one proves the mechanism.
       *
       * Setting it here also proves the boot path end to end — a malformed value would
       * stop the process before it listened, and every check below would fail loudly
       * rather than skip.
       */
      OATHRION_QUOTAS: "default:policies=0",
      OATHRION_QUOTA_MODE: "enforce",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  /** Everything the process wrote, for the §14 assertion and for diagnosis. */
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));

  let exitSignal: NodeJS.Signals | null = null;
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });

  try {
    /* --- 1. it boots --------------------------------------------------------- */
    const boot = await waitForBoot(child);
    record("the bundle boots and binds the port", boot.booted, boot.reason);
    if (!boot.booted) {
      console.log(`\n--- process output ---\n${output.trim() || "(nothing)"}`);
      return 1;
    }

    /* --- 2. the probe is public and healthy ---------------------------------- */
    const health = await req("/api/health");
    let healthOk = false;
    let healthDetail = `status ${health.status}`;
    try {
      const parsed = JSON.parse(health.body) as {
        status?: string;
        checks?: { database?: { ok?: boolean }; accepting?: { ok?: boolean } };
      };
      healthOk =
        health.status === 200 &&
        parsed.status === "ok" &&
        parsed.checks?.database?.ok === true &&
        parsed.checks?.accepting?.ok === true;
      healthDetail = `status ${health.status}, database=${parsed.checks?.database?.ok}, accepting=${parsed.checks?.accepting?.ok}`;
    } catch {
      healthDetail = `status ${health.status}, body was not JSON`;
    }
    // Unauthenticated on purpose: a load balancer has no credential, so a probe that
    // needs one is a probe that reports the service as permanently down.
    record("/api/health answers 200 ok without credentials", healthOk, healthDetail);

    /* --- 2b. liveness is a different question from readiness (P1-1) ---------- */
    /*
     * Checked against the shipped bundle, not only in the harness: this is the endpoint
     * an orchestrator's livenessProbe will point at, and a deployment that restarts every
     * replica during a database outage is the failure being prevented. If `/api/live` is
     * missing from the bundle, the operator following DEPLOYMENT.md configures a probe
     * against a 401 and every container is killed on a loop.
     */
    const live = await req("/api/live");
    let liveOk = false;
    let liveDetail = `status ${live.status}`;
    try {
      const parsed = JSON.parse(live.body) as Record<string, unknown>;
      const keys = Object.keys(parsed).sort().join(",");
      // Key-for-key: this endpoint is unauthenticated, so it must not grow a version,
      // a hostname or a row count.
      liveOk = live.status === 200 && parsed.status === "alive" && keys === "status,uptimeSeconds";
      liveDetail = `status ${live.status}, body keys {${keys}}`;
    } catch {
      liveDetail = `status ${live.status}, body was not JSON`;
    }
    record("/api/live answers 200 alive without credentials, and discloses nothing else", liveOk, liveDetail);

    const ready = await req("/api/ready");
    // Same answer as /api/health, which is kept as an alias. Compared here because the
    // Dockerfile HEALTHCHECK points at one and operators read the other; the two drifting
    // apart would mean a load balancer and a human disagreeing about the same instance.
    const readyOk = ready.status === 200 && ready.status === health.status && ready.body === health.body;
    record(
      "/api/ready answers identically to /api/health",
      readyOk,
      `ready ${ready.status}, health ${health.status}, bodies ${ready.body === health.body ? "identical" : "DIFFER"}`,
    );

    /* --- 2c. every response carries a correlation id (P1-2) ------------------ */
    const idHeader = live.headers.get("x-request-id");
    const idOk = typeof idHeader === "string" && /^[A-Za-z0-9._:-]{8,64}$/.test(idHeader);
    record(
      "every response carries an X-Request-Id",
      idOk,
      idHeader ? `X-Request-Id: ${idHeader}` : "header absent",
    );

    // A hostile inbound id must be replaced, not echoed: the value is written into the
    // server log, so echoing an attacker-chosen string is a writable log. `fetch` refuses
    // a literal newline in a header value, so the hostile shape used here is one it will
    // send — too short to be a real id, and containing a character the pattern excludes.
    const forged = await req("/api/live", { headers: { "x-request-id": "a b" } });
    const forgedReturned = forged.headers.get("x-request-id");
    const forgedOk =
      forgedReturned !== "a b" && /^[A-Za-z0-9._:-]{8,64}$/.test(forgedReturned ?? "");
    record(
      "a malformed inbound X-Request-Id is replaced, not echoed",
      forgedOk,
      `sent "a b", returned ${forgedReturned ? `"${forgedReturned}"` : "nothing"}`,
    );

    /* --- 3. the console was built and is served ----------------------------- */
    /*
     * `/console`, pas `/` : la racine sert désormais le site public. Les deux documents
     * portent `<div id="root"`, donc viser la racine aurait laissé ce contrôle vert tout
     * en cessant de parler de la console.
     */
    const consoleRes = await req("/console");
    const consoleOk = consoleRes.status === 200 && consoleRes.body.includes("<div id=\"root\"");
    record(
      "the console HTML is served from dist/public at /console",
      consoleOk,
      `status ${consoleRes.status}, ${consoleRes.body.length} bytes`,
    );

    /* --- 4. and 5. authentication is on, and is what refused ---------------- */
    const anon = await req("/api/agents");
    record("an unauthenticated API call is refused", anon.status === 401, `status ${anon.status}`);

    /*
     * The refusal must be usable by both kinds of caller (P1-3). Before this phase the
     * shipped bundle answered `{"error":…}` here and the console read only `message`, so
     * the user was shown the raw JSON of this exact response — the most frequently seen
     * error in the product. Checked against the bundle because that is what a user meets.
     */
    let shapeOk = false;
    let shapeDetail = anon.body.slice(0, 80);
    try {
      const parsed = JSON.parse(anon.body) as Record<string, unknown>;
      shapeOk =
        typeof parsed.error === "string" &&
        parsed.message === parsed.error &&
        parsed.code === "unauthenticated" &&
        typeof parsed.requestId === "string" &&
        parsed.requestId === anon.headers.get("x-request-id");
      shapeDetail = `code=${String(parsed.code)}, error+message present=${
        typeof parsed.error === "string" && typeof parsed.message === "string"
      }, requestId matches header=${parsed.requestId === anon.headers.get("x-request-id")}`;
    } catch {
      shapeDetail = "body was not JSON";
    }
    record("the refusal carries error, message, code and a matching requestId", shapeOk, shapeDetail);

    const authed = await req("/api/agents", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    record(
      "the same call succeeds with a valid API key",
      authed.status === 200,
      `status ${authed.status}`,
    );

    /* --- 5b. a human can actually sign in (P0-2) ---------------------------- */
    /*
     * The API-key check above passes even if console sign-in is completely broken:
     * keys are read from the environment, while a console password is verified against
     * a scrypt hash in a `users` row created at boot by adoption. So this is the only
     * check that proves the shipped bundle ran migration 4, adopted the configured
     * user, and can verify a password — the path every human takes.
     *
     * The configuration carries a display name, not an address, exactly as an existing
     * deployment's does, so the derived address is what is signed in with.
     */
    const signIn = await req("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "smoke-admin@default.aria.local",
        password: CONSOLE_PASSWORD,
      }),
    });
    let sessionToken = "";
    try {
      sessionToken = (JSON.parse(signIn.body) as { token?: string }).token ?? "";
    } catch {
      sessionToken = "";
    }
    record(
      "a console user can sign in with an e-mail and password",
      signIn.status === 200 && sessionToken.length > 20,
      `status ${signIn.status}, token ${sessionToken.length} chars`,
    );

    const asUser = await req("/api/agents", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    record(
      "the issued session token is itself a working credential",
      asUser.status === 200,
      `status ${asUser.status}`,
    );

    const wrongPassword = await req("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "smoke-admin@default.aria.local",
        password: "definitely-not-the-password",
      }),
    });
    record(
      "a wrong password is refused by the shipped bundle",
      wrongPassword.status === 401,
      `status ${wrongPassword.status}`,
    );

    /* --- 5c. a key can be issued and revoked in production (P0-5) ----------- */
    /*
     * The console's key tab was three fabricated rows and a disabled button until P0-5.
     * This is the check that the replacement is real in the shipped bundle: issue a
     * credential over HTTP, use it as a machine caller, revoke it, and confirm it stops
     * working — no restart in between, which is the whole point of moving keys into the
     * database.
     */
    const issued = await req("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ name: "Smoke integration", role: "viewer" }),
    });
    let issuedSecret = "";
    let issuedId = "";
    try {
      const parsedKey = JSON.parse(issued.body) as { secret?: string; key?: { id?: string } };
      issuedSecret = parsedKey.secret ?? "";
      issuedId = parsedKey.key?.id ?? "";
    } catch {
      issuedSecret = "";
    }
    record(
      "an administrator can issue an API key",
      issued.status === 201 && issuedSecret.startsWith("oathrion_"),
      `status ${issued.status}, secret ${issuedSecret.slice(0, 5)}… (${issuedSecret.length} chars)`,
    );

    const withIssued = await req("/api/agents", {
      headers: { Authorization: `Bearer ${issuedSecret}` },
    });
    record(
      "the issued key authenticates a machine caller",
      withIssued.status === 200,
      `status ${withIssued.status}`,
    );

    const revoked = await req(`/api/keys/${issuedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const afterRevoke = await req("/api/agents", {
      headers: { Authorization: `Bearer ${issuedSecret}` },
    });
    record(
      "revoking the key stops it on the next request, with no restart",
      revoked.status === 200 && afterRevoke.status === 401,
      `revoke ${revoked.status}, reuse ${afterRevoke.status}`,
    );

    /* --- 6. no demo data in production ------------------------------------- */
    let empty = false;
    try {
      empty = authed.status === 200 && Array.isArray(JSON.parse(authed.body)) && JSON.parse(authed.body).length === 0;
    } catch {
      empty = false;
    }
    // Shipping the seeded demo agents would put fictional agents with real
    // `execute:payments` scope into a production install.
    record("production starts with no seeded demo agents", empty, `agents: ${authed.body.slice(0, 60)}`);

    /* --- 6bis. P2 — the versioned prefix, in the shipped bundle ------------- */
    /*
     * The integration suite already proves parity against the app booted in-process.
     * These checks prove it against the built `dist/index.cjs` running in production
     * mode, which is what a customer actually deploys — a rewrite that works under
     * `tsx` and not in the bundle would otherwise ship undetected.
     */
    const versionedLive = await req("/api/v1/live");
    record(
      "/api/v1/live answers 200 without credentials, like /api/live",
      versionedLive.status === 200 && versionedLive.body.includes("alive"),
      `status ${versionedLive.status}`,
    );

    const versionedAgents = await req("/api/v1/agents", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    record(
      "/api/v1/agents returns exactly what /api/agents returns",
      versionedAgents.status === authed.status && versionedAgents.body === authed.body,
      `versioned ${versionedAgents.status}, unversioned ${authed.status}`,
    );

    const unknownVersion = await req("/api/v2/agents", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    let unknownVersionOk = false;
    try {
      // A caller pinned to a version this build does not serve must be told that, not
      // told its credential or its path is wrong.
      unknownVersionOk =
        unknownVersion.status === 404 &&
        (JSON.parse(unknownVersion.body) as { code?: string }).code === "unsupported_api_version";
    } catch {
      unknownVersionOk = false;
    }
    record(
      "/api/v2/... is refused as an unsupported version, not as a missing resource",
      unknownVersionOk,
      `status ${unknownVersion.status}, body ${unknownVersion.body.slice(0, 80)}`,
    );

    /*
     * Sign in through the VERSIONED path. Two things are being proven at once: that it
     * works, and — in the §14 check just below, which inspects everything the process
     * has written — that the token it returns did not reach the log.
     *
     * That second point is the whole reason this call is here rather than in a unit test.
     * The request logger suppressed response bodies with `startsWith("/api/auth")`, which
     * stopped matching the moment `/api/v1/auth/login` existed. The predicate is now
     * derived from the unversioned path; this is the end-to-end evidence.
     */
    const versionedSignIn = await req("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "smoke-admin@default.aria.local",
        password: CONSOLE_PASSWORD,
      }),
    });
    let versionedToken = "";
    try {
      versionedToken = (JSON.parse(versionedSignIn.body) as { token?: string }).token ?? "";
    } catch {
      versionedToken = "";
    }
    record(
      "/api/v1/auth/login signs in and issues a token",
      versionedSignIn.status === 200 && versionedToken.length > 0,
      `status ${versionedSignIn.status}`,
    );

    /* --- 7. §14 end to end -------------------------------------------------- */
    /* --- 6ter. P3 — quotas, in the shipped bundle --------------------------- */
    /*
     * The unit suite proves the arithmetic and the refusal shape against the app booted
     * in-process. These checks prove the same thing about `dist/index.cjs` running with
     * NODE_ENV=production and a real environment variable, which is what a customer
     * deploys. A quota that works under `tsx` and not in the bundle would be worse than
     * no quota: the operator would believe a ceiling is in place.
     */
    const usage = await req("/api/usage", { headers: { Authorization: `Bearer ${API_KEY}` } });
    let usageOk = false;
    let usageDetail = usage.body.slice(0, 120);
    try {
      const parsed = JSON.parse(usage.body) as {
        organizationId?: string;
        counters?: { counter: string; limit: number; used: number; remaining: number }[];
      };
      const counters = parsed.counters ?? [];
      const policies = counters.find((c) => c.counter === "policies");
      usageOk =
        usage.status === 200 &&
        typeof parsed.organizationId === "string" &&
        counters.length === 3 &&
        // The ceiling set in the environment above arrived intact through boot parsing.
        policies?.limit === 0 &&
        policies?.remaining === 0;
      usageDetail = `status ${usage.status}, counters ${counters.length}, policies limit ${policies?.limit}`;
    } catch {
      usageOk = false;
    }
    record("GET /api/usage reports the three counters and the configured ceiling", usageOk, usageDetail);

    const refused = await req("/api/policies", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "pol_smoke_quota",
        name: "Smoke quota probe",
        description: "Should be refused by the policies ceiling.",
        type: "MAX_TRANSACTION_AMOUNT",
        condition: { kind: "amountAtMost", max: 100 },
        scope: "organization",
        appliesTo: "All agents",
        effect: "require_approval",
        action: "APPROVAL_REQUIRED",
        risk: "medium",
        priority: 45,
        // Disabled, so that if the quota ever failed to refuse this the created policy
        // still could not change any verdict the checks above rely on.
        status: "disabled",
      }),
    });
    let refusalOk = false;
    let refusalDetail = `status ${refused.status}, body ${refused.body.slice(0, 120)}`;
    try {
      const parsed = JSON.parse(refused.body) as {
        code?: string;
        counter?: string;
        limit?: number;
        resetAt?: string | null;
      };
      refusalOk =
        // 409 and not 429: a ceiling on live rows is not resolved by waiting.
        refused.status === 409 &&
        parsed.code === "quota_exceeded" &&
        parsed.counter === "policies" &&
        parsed.limit === 0 &&
        parsed.resetAt === null &&
        // And no Retry-After, which would invite a client to retry a wall.
        refused.headers.get("retry-after") === null;
      refusalDetail = `status ${refused.status}, code ${parsed.code}, counter ${parsed.counter}, retry-after ${refused.headers.get("retry-after") ?? "absent"}`;
    } catch {
      refusalOk = false;
    }
    record(
      "a write over the quota is refused with 409 quota_exceeded and no Retry-After",
      refusalOk,
      refusalDetail,
    );

    // The configuration an operator set must be visible in the first log lines, or a
    // mistyped organization id is undiscoverable until a support ticket arrives.
    record(
      "the boot log reports the quota configuration",
      output.includes("[quotas]") && output.includes("policies"),
      output.includes("[quotas]") ? "found the [quotas] boot line" : "no [quotas] line in the output",
    );

    // The unit tests prove the redactor redacts. This proves the redactor is actually
    // wired into the path that writes log lines, in the bundle, in production mode.
    const leaked = [
      ["API key", API_KEY],
      ["session secret", SESSION_SECRET],
      ["console password", CONSOLE_PASSWORD],
      /*
       * P2 — the token minted through `/api/v1/auth/login`. Included because the versioned
       * path is precisely the one whose response body the logger stopped recognising as an
       * auth response. Guarded against an empty string, which `includes` would match
       * against any output and report a leak that did not happen.
       */
      ["versioned session token", versionedToken || "\u0000never-matches"],
    ].filter(([, value]) => output.includes(value));
    record(
      "no credential appears in the process output (§14)",
      leaked.length === 0,
      leaked.length === 0 ? `${output.length} bytes of log inspected` : `LEAKED: ${leaked.map(([n]) => n).join(", ")}`,
    );

    /* --- 8. graceful shutdown ---------------------------------------------- */
    const before = Date.now();
    child.kill("SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      sleep(15_000).then(() => true),
    ]);
    const took = Date.now() - before;
    // A container runtime sends SIGTERM and then SIGKILLs after a grace period. A
    // process that ignores SIGTERM has its in-flight work killed mid-write.
    record(
      "SIGTERM produces a clean exit",
      !timedOut && (exitCode === 0 || exitSignal === "SIGTERM"),
      timedOut ? `still running after 15s` : `exited in ${took}ms (code=${exitCode}, signal=${exitSignal})`,
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await database.dispose();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log("\nFAILED:");
    for (const c of failed) console.log(`  - ${c.name}: ${c.detail}`);
    console.log(`\n--- process output ---\n${output.trim() || "(nothing)"}`);
    return 1;
  }
  console.log("SMOKE PASS — the shipped bundle boots, serves, authenticates and stops.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
