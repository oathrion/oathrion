/**
 * Fault-injection bench — "what does Oathrion do when the world misbehaves?"
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm test` proves the system does the right thing when its inputs are the ones
 * the tests thought of. `npm run smoke` proves the shipped bundle starts. Neither
 * asks the question an operator actually cares about at 03:00: *when something
 * outside the process breaks, does Oathrion fail in a way a human can act on?*
 *
 * The failure modes that matter here are not exotic. A typo in `PORT`. A database
 * directory that does not exist. A disk that filled up. A webhook receiver that
 * accepts the connection and then never answers. A clock that jumps. Each of these
 * has three possible outcomes, and only one is acceptable:
 *
 *   1. **Loud and clear** — refuse to start, or refuse the request, with a message
 *      naming the cause. Acceptable.
 *   2. **Loud and cryptic** — crash with a stack trace that names a library
 *      internal instead of the operator's mistake. Survivable but expensive: it
 *      turns a 30-second fix into an hour of reading source.
 *   3. **Silent** — start anyway, in a broken or half-broken state, and serve
 *      traffic. Unacceptable. This is the outcome that produces incidents,
 *      because monitoring says the process is up.
 *
 * So each scenario below asserts on OBSERVABLE behaviour — exit code, what was
 * written to stderr, what the HTTP surface answers — and not on internals. A
 * scenario "passes" when the outcome is (1). Outcome (2) is reported as a warning
 * with the message that was actually printed, so the reader can judge. Outcome (3)
 * fails the run.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It does not mutate source, and it does not stay resident. Every scenario boots a
 * throwaway process against a throwaway database in a `mkdtemp` directory, on its
 * own port, and tears it down. Running it twice in a row must give the same answer.
 *
 * Run with `npm run chaos`. Filter with `npm run chaos -- storage,config`.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "dist", "index.cjs");

/** Credentials used by every scenario. Obviously fake, and never read from a file. */
const API_KEY = "chaos-api-key-0123456789abcdef";
const SESSION_SECRET = "chaos-session-secret-0123456789abcdef";
const CONSOLE_PASSWORD = "chaos-console-password-0123";

/**
 * The address the console user below actually signs in with.
 *
 * `goodEnv()` configures `OATHRION_CONSOLE_USERS` with the DISPLAY NAME "Chaos Admin",
 * not an e-mail address. Since P0-2, sign-in needs an identifier, so `server/auth.ts`
 * derives one from the name: `<slug(name)>@<slug(organization) || "default">.aria.local`.
 * For "Chaos Admin" with no organization prefix that is the constant below, and it was
 * confirmed against a running bundle rather than read off the rule.
 *
 * Kept as a named constant next to the password, instead of inlined at the call site,
 * so the coupling to that derivation rule is visible. If the rule ever changes this
 * scenario fails loudly — which it now can, because a bench malfunction no longer
 * exits 0 (see the `error` verdict below).
 */
const CONSOLE_EMAIL = "chaos-admin@default.aria.local";

/**
 * The exact shape `spawn` returns for `stdio: ["ignore", "pipe", "pipe"]`.
 * See the same note in `smoke.ts`: casting to `ChildProcessWithoutNullStreams`
 * would claim a writable `stdin` this process does not have.
 */
type BootedChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * `error` and `unsupported` used to be the same verdict, and that conflation is what
 * let a broken bench report success.
 *
 *   - `unsupported` — the fault CANNOT be injected in this environment (a true ENOSPC
 *     needs a privileged loopback mount). Nothing is wrong; there is simply no
 *     evidence either way. Never a build failure.
 *   - `error` — the bench itself could not complete the scenario: it failed to boot a
 *     healthy server, failed to log in, got no token. The system under test was never
 *     exercised, so a green run would be a lie. ALWAYS a build failure.
 *
 * Both previously printed as "SKIP" under a heading that read "Not simulated here", and
 * both returned exit 0. `resilience/session-survives-restart` therefore sat in that list
 * saying "THE BENCH DID NOT LOG IN" while `npm run chaos` exited 0 and CI read it as a
 * pass — the verification tool was the thing that was broken.
 */
type Verdict = "handled" | "cryptic" | "silent" | "unsupported" | "error";

interface Outcome {
  verdict: Verdict;
  /** What actually happened, in the words of the system under test where possible. */
  detail: string;
}

interface Scenario {
  id: string;
  category: string;
  /** The fault being injected, in plain language. */
  what: string;
  /** The behaviour that would be acceptable. */
  expect: string;
  run: () => Promise<Outcome>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ports are allocated per scenario so a leaked process cannot poison the next one. */
let nextPort = 5300;
const takePort = () => nextPort++;

const tempDirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "placet-chaos-"));
  tempDirs.push(d);
  return d;
}

interface BootResult {
  child: BootedChild;
  /** Everything the process wrote to stdout and stderr, concatenated. */
  output: () => string;
  exited: () => number | null;
  stop: () => Promise<void>;
}

function launch(env: Record<string, string | undefined>, cwd = ROOT): BootResult {
  const child = spawn("node", [BUNDLE], {
    cwd,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  child.stdout.on("data", (c: Buffer) => (buffer += c.toString()));
  child.stderr.on("data", (c: Buffer) => (buffer += c.toString()));
  // A scenario that boots a process which then dies must not take the bench with it.
  child.on("error", (e) => (buffer += `\n[spawn error] ${e.message}\n`));

  return {
    child,
    output: () => buffer,
    exited: () => child.exitCode,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGKILL");
      await sleep(120);
    },
  };
}

/**
 * Baseline environment: a valid configuration. Scenarios break one thing at a time.
 *
 * ## Why this is NOT NODE_ENV=production any more
 *
 * Seven of the scenarios below are about the SQLite *file* — deleted underneath a
 * running server, made read-only, corrupted, exclusively locked, out of disk. Those
 * failure modes only exist on SQLite, which Phase 12.2 made unavailable in production:
 * `NODE_ENV=production` now requires PostgreSQL on every plane and no variable opts out.
 *
 * So this bench runs on the SQLite engine OUTSIDE production mode, which is exactly what
 * SQLite is still supported for. That is a real reduction in what it covers, stated
 * rather than hidden: the engine-agnostic scenarios here (malformed input, SIGKILL and
 * restart, port conflicts, concurrent approvals) no longer exercise the production
 * configuration.
 *
 * PostgreSQL's equivalent failure modes are connection-level rather than file-level —
 * the server stopping underneath a running instance, and recovering — and they are
 * covered separately, in production mode, by `script/chaos-postgres.ts`.
 */
function goodEnv(port: number, dbPath: string): Record<string, string> {
  return {
    /*
     * Stated, not inherited. `launch` spreads `process.env` under this, so leaving
     * NODE_ENV out would make the bench mean different things depending on the shell
     * that started it — and in a production shell every scenario would fail on the
     * PostgreSQL requirement instead of testing what it claims to test.
     */
    NODE_ENV: "development",
    PORT: String(port),
    OATHRION_DB: dbPath,
    OATHRION_API_KEYS: `chaos:admin:${API_KEY}`,
    OATHRION_CONSOLE_USERS: `Chaos Admin:admin:${CONSOLE_PASSWORD}`,
    OATHRION_SESSION_SECRET: SESSION_SECRET,
    OATHRION_SEED: "none",
  };
}

interface Res {
  status: number;
  body: string;
  /** 0 means the connection itself failed — nothing was listening, or it hung. */
  transportError?: string;
}

async function req(
  port: number,
  path: string,
  init: { method?: string; body?: string; key?: string | null; timeoutMs?: number } = {},
): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // The API authenticates with `Authorization: Bearer <key>`. Getting this wrong
  // makes every scenario silently unauthenticated, which reads as a fault in the
  // system under test rather than in the bench — it did, on the first run.
  if (init.key !== null) headers.Authorization = `Bearer ${init.key ?? API_KEY}`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 5_000),
    });
    /*
     * The body used to be truncated to 2 000 characters here, and every caller
     * parsed that truncated string. `GET /api/agents` on a seeded database is larger
     * than that, so `JSON.parse` failed and a substring search for a newly created
     * agent — last in the list — missed it. The bench reported "a committed write was
     * INVISIBLE to the other instance", a serious-sounding data-integrity fault that
     * did not exist: a direct read of the SQLite file showed the row present and both
     * instances returned it. Full body kept; truncation happens only where a message
     * is printed.
     */
    const text = await res.text();
    return { status: res.status, body: text.length > 1_000_000 ? text.slice(0, 1_000_000) : text };
  } catch (e) {
    return { status: 0, body: "", transportError: (e as Error).message };
  }
}

/**
 * How many agents the API reports, or `null` if the answer was not an agent list.
 * Returning `null` rather than a sentinel number keeps a bench defect (wrong header,
 * unexpected shape) from being reported as a fault in the system under test.
 */
function agentCount(res: Res): number | null {
  if (res.status !== 200) return null;
  try {
    const parsed: unknown = JSON.parse(res.body);
    if (Array.isArray(parsed)) return parsed.length;
    for (const key of ["agents", "items", "data"]) {
      const v = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v.length;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A body that `POST /api/agents` actually accepts.
 *
 * The first version of this bench sent a plausible-looking five-field object. The
 * schema is a `strictObject` with eleven required fields and a `status` enum that
 * does not contain "idle", so every write scenario got a 400 from validation and
 * never reached storage at all — and the bench scored that as the system handling
 * the injected fault. The `baseline/control-write-succeeds` scenario exists so that
 * mistake fails loudly instead of reading as a pass.
 */
function validAgent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "agt_chaos",
    name: "Chaos Agent",
    description: "created by the fault-injection bench",
    provider: "openai",
    model: "gpt-4",
    status: "active",
    owner: "chaos@example.test",
    mandate: {
      maxTransactionAmount: 100,
      currency: "EUR",
      allowedCategories: ["Office supplies"],
      blockedCategories: [],
      allowedDomains: ["vendor.company.com"],
    },
    permissions: [],
    policyIds: [],
    tags: [],
    ...overrides,
  });
}

/**
 * How many webhook delivery attempts `GET /api/notifications` reports, or `null` if
 * the answer was not a delivery list. A network scenario that records zero attempts
 * never exercised the transport, and must report itself as inconclusive rather than
 * as a pass.
 */
function deliveryCount(res: Res): number | null {
  if (res.status !== 200) return null;
  try {
    const parsed: unknown = JSON.parse(res.body);
    const d = (parsed as { deliveries?: unknown }).deliveries;
    return Array.isArray(d) ? d.length : null;
  } catch {
    return null;
  }
}

/**
 * Issues an API key BOUND to one agent, the way a real operator does.
 *
 * ## Why the bench needs this
 *
 * Six scenarios here drive a decision as an agent, and they used the env-declared admin
 * key to do it. That key can never be bound: `OATHRION_API_KEYS` is `name:role:key` and has
 * no field for an agent. Agent binding is ON in the shipped bundle — `script/build.ts`
 * compiles `process.env.NODE_ENV` to the literal `"production"`, so the requirement is
 * permanent in `dist/index.cjs` regardless of the runtime environment — so every one of
 * those six was refused with 403 before it could inject anything, and reported itself as
 * "THE BENCH DID NOT REACH THE WEBHOOK".
 *
 * The bench was wrong, not the server. Setting `OATHRION_REQUIRE_AGENT_BINDING=false`, or
 * putting the requirement back behind a runtime NODE_ENV read, would have turned a
 * working security control into a bench convenience — and these scenarios would then be
 * proving the opposite of what the product ships. `script/smoke-postgres.ts` reached the
 * same conclusion for the same reason; this is the same fix.
 *
 * Returns null rather than throwing: a scenario that cannot get a credential must report
 * itself unrunnable, which is the whole point of this bench's error verdict.
 */
async function mintBoundKey(port: number, agentId: string): Promise<string | null> {
  const signIn = await req(port, "/api/auth/login", {
    method: "POST",
    key: null,
    body: JSON.stringify({ email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD }),
  });
  if (signIn.status !== 200) return null;
  let token = "";
  try {
    token = (JSON.parse(signIn.body) as { token?: string }).token ?? "";
  } catch {
    return null;
  }
  if (token === "") return null;

  // Only a signed-in administrator may issue a credential (Phase 9); a machine key
  // cannot mint another, which is why the console session above is required.
  const issued = await req(port, "/api/keys", {
    method: "POST",
    key: token,
    body: JSON.stringify({ name: `chaos bound ${agentId}`, role: "operator", agentId }),
  });
  if (issued.status !== 201) return null;
  try {
    return (JSON.parse(issued.body) as { secret?: string }).secret ?? null;
  } catch {
    return null;
  }
}

/**
 * Boots one more instance on the same database but with a *rotated* console password,
 * then probes the old token. A session that outlives the credential it came from is a
 * revocation failure, not a convenience.
 */
async function launchProbe(_dir: string, db: string, token: string): Promise<number> {
  const port = takePort();
  const proc = launch({
    ...goodEnv(port, db),
    OATHRION_CONSOLE_USERS: `Chaos Admin:admin:rotated-console-password-9876`,
  });
  const up = await waitUntilServing(port, proc);
  if (!up.serving) {
    await proc.stop();
    return -1;
  }
  const res = await req(port, "/api/agents", { key: token });
  await proc.stop();
  return res.status;
}

/** Poll until the process answers or dies. Returns why it stopped waiting. */
async function waitUntilServing(
  port: number,
  boot: BootResult,
  timeoutMs = 20_000,
): Promise<{ serving: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (boot.exited() !== null) {
      return { serving: false, reason: `exited with code ${boot.exited()}` };
    }
    const res = await req(port, "/api/health", { key: null });
    if (res.status !== 0) return { serving: true, reason: `answered ${res.status}` };
    await sleep(200);
  }
  return { serving: false, reason: `never answered within ${timeoutMs}ms` };
}

/** Wait for the process to exit on its own. */
async function waitExit(boot: BootResult, timeoutMs = 20_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (boot.exited() !== null) return boot.exited();
    await sleep(100);
  }
  return null;
}

/**
 * The part of the output an operator would actually read.
 *
 * The first version of this helper returned the LAST few lines, which for a Node
 * crash is the stack tail and the runtime version — the two least informative
 * lines available. Node prints the message first and the frames after, so the
 * useful content is found by dropping stack frames and internal noise, not by
 * taking a suffix.
 */
function lastLines(text: string, n = 3): string {
  const noise =
    /^(at\s|\^+$|throw\s|Node\.js v|\}$|\{$|code:|requireStack:|errno:|syscall:|\[?nodejs\]?)/i;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !noise.test(l))
    .filter((l) => !/^[/\w.-]+:\d+$/.test(l));
  // An explicit Error line is the single most informative thing in a crash dump.
  const errLine = lines.find((l) => /^[A-Za-z]*Error[:\s]/.test(l));
  const picked = errLine ? [errLine, ...lines.filter((l) => l !== errLine)] : lines;
  return picked.slice(0, n).join(" / ").slice(0, 400) || "(no output)";
}

/**
 * A boot that must fail. Verdict depends on WHY the operator can tell it failed:
 * a message containing one of `nameMustMention` is `handled`; a non-zero exit with
 * an unrelated message is `cryptic`; a process that starts anyway is `silent`.
 */
async function expectRefusedBoot(
  port: number,
  boot: BootResult,
  nameMustMention: string[],
): Promise<Outcome> {
  const serving = await waitUntilServing(port, boot, 8_000);
  const out = boot.output();

  if (serving.serving) {
    await boot.stop();
    return {
      verdict: "silent",
      detail: `started and served traffic anyway (health answered). Output: ${lastLines(out)}`,
    };
  }

  const code = await waitExit(boot, 5_000);
  await boot.stop();

  if (code === null) {
    return { verdict: "silent", detail: `neither served nor exited — hung. Output: ${lastLines(out)}` };
  }

  const lower = out.toLowerCase();
  const mentioned = nameMustMention.some((m) => lower.includes(m.toLowerCase()));
  return mentioned
    ? { verdict: "handled", detail: `refused to start (code ${code}): ${lastLines(out, 2)}` }
    : {
        verdict: "cryptic",
        detail: `exited ${code} but the message never mentions ${nameMustMention.join(" / ")}: ${lastLines(out, 2)}`,
      };
}

// ---------------------------------------------------------------------------
// CONTROL — the bench proves it can drive the system before it accuses it
// ---------------------------------------------------------------------------

const controlScenarios: Scenario[] = [
  {
    id: "baseline/control-write-succeeds",
    category: "baseline",
    what: "no fault at all — a healthy server, a valid write, a valid read",
    expect: "the write must succeed; if it does not, every write-path verdict below is meaningless",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")) });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        return { verdict: "error", detail: `could not boot a healthy server: ${serving.reason}` };
      }
      const write = await req(port, "/api/agents", { method: "POST", body: validAgent() });
      const list = await req(port, "/api/agents");
      const count = agentCount(list);
      await boot.stop();
      if (write.status >= 300) {
        return {
          verdict: "silent",
          detail: `THE BENCH IS BROKEN, NOT THE SYSTEM: a valid write returned ${write.status}: ${write.body.slice(0, 200)}`,
        };
      }
      if (count !== 1) {
        return {
          verdict: "silent",
          detail: `THE BENCH IS BROKEN, NOT THE SYSTEM: wrote one agent, read back ${count}`,
        };
      }
      return { verdict: "handled", detail: `control path works: write ${write.status}, one agent read back` };
    },
  },
];

// ---------------------------------------------------------------------------
// A — CONFIGURATION AND BOOT
// ---------------------------------------------------------------------------

const configScenarios: Scenario[] = [
  {
    id: "config/port-not-a-number",
    category: "config",
    what: "PORT is a typo — `PORT=80o0` instead of `8000`",
    expect: "refuse to start and name PORT; binding a random port would be silent breakage",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")), PORT: "80o0" });
      // The requested port is nonsense, so nothing should be listening anywhere.
      // If the process is alive after the settle window it bound *something*.
      await sleep(3_000);
      const out = boot.output();
      const alive = boot.exited() === null;
      if (alive) {
        await boot.stop();
        return {
          verdict: "silent",
          detail: `still running with PORT="80o0" — it bound a port nobody asked for. Output: ${lastLines(out)}`,
        };
      }
      const lower = out.toLowerCase();
      return lower.includes("port")
        ? { verdict: "handled", detail: `refused: ${lastLines(out, 2)}` }
        : { verdict: "cryptic", detail: `exited ${boot.exited()} without naming PORT: ${lastLines(out, 2)}` };
    },
  },
  {
    id: "config/port-out-of-range",
    category: "config",
    what: "PORT=99999 — above the 16-bit port space",
    expect: "refuse to start and name PORT",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")), PORT: "99999" });
      return expectRefusedBoot(port, boot, ["port"]);
    },
  },
  {
    id: "config/port-privileged",
    category: "config",
    what: "PORT=80 as an unprivileged user",
    expect: "refuse to start, naming the port or the permission problem",
    run: async () => {
      const boot = launch({ ...goodEnv(80, join(tempDir(), "data.db")), PORT: "80" });
      return expectRefusedBoot(80, boot, ["port", "eacces", "permission"]);
    },
  },
  {
    id: "config/db-directory-missing",
    category: "config",
    what: "OATHRION_DB points into a directory that does not exist",
    expect: "refuse to start and name the path, not an SQLite internal",
    run: async () => {
      const port = takePort();
      const missing = join(tempDir(), "no", "such", "dir", "data.db");
      const boot = launch({ ...goodEnv(port, missing) });
      return expectRefusedBoot(port, boot, ["no/such/dir", "data.db", "directory", "unable to open"]);
    },
  },
  {
    id: "config/db-read-only-dir",
    category: "config",
    what: "the database directory is read-only (a mounted secret, a squashed image)",
    expect: "refuse to start and name the path or the permission",
    run: async () => {
      const port = takePort();
      const dir = tempDir();
      chmodSync(dir, 0o500);
      const boot = launch({ ...goodEnv(port, join(dir, "data.db")) });
      const outcome = await expectRefusedBoot(port, boot, ["readonly", "read-only", "permission", "data.db", "unable to open"]);
      chmodSync(dir, 0o700);
      return outcome;
    },
  },
  {
    id: "config/db-file-corrupt",
    category: "config",
    what: "data.db exists but is not an SQLite file (a truncated restore, a wrong volume)",
    expect: "refuse to start and say the file is not a database",
    run: async () => {
      const port = takePort();
      const db = join(tempDir(), "data.db");
      writeFileSync(db, "this is not a database, it is a log file someone renamed\n".repeat(50));
      const boot = launch({ ...goodEnv(port, db) });
      return expectRefusedBoot(port, boot, ["not a database", "malformed", "encrypted", "data.db"]);
    },
  },
  {
    id: "config/seed-unknown-value",
    category: "config",
    what: "OATHRION_SEED=prod — a value that does not exist",
    expect: "either refuse, or start with NO seed data; silently seeding demo agents would be worst",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")), OATHRION_SEED: "prod" });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        const out = boot.output();
        await boot.stop();
        return { verdict: "handled", detail: `refused to start: ${lastLines(out, 2)}` };
      }
      const agents = await req(port, "/api/agents");
      await boot.stop();
      const count = agentCount(agents);
      if (count === null) {
        return {
          verdict: "error",
          detail: `could not read the agent list (status ${agents.status}): ${agents.body.slice(0, 160)}`,
        };
      }
      if (count === 0) {
        return { verdict: "handled", detail: "started with zero agents — an unrecognised mode is treated as 'none'" };
      }
      return {
        verdict: "silent",
        detail: `started and seeded ${count} agent(s) from an unrecognised OATHRION_SEED value`,
      };
    },
  },
  {
    id: "config/trust-proxy-garbage",
    category: "config",
    what: "OATHRION_TRUST_PROXY is set to a meaningless string",
    expect: "must NOT end up trusting a forwarded IP header — that would let a caller forge its own rate-limit identity",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")), OATHRION_TRUST_PROXY: "yes-please" });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        const out = boot.output();
        await boot.stop();
        return { verdict: "handled", detail: `refused to start: ${lastLines(out, 2)}` };
      }
      // If X-Forwarded-For were trusted, the server would attribute this request to
      // 1.2.3.4. We cannot read the attribution directly, so assert the safe default
      // held: the process is up and the header did not change the auth outcome.
      const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
        headers: { Authorization: `Bearer ${API_KEY}`, "x-forwarded-for": "1.2.3.4" },
      });
      await boot.stop();
      return res.status === 200
        ? { verdict: "handled", detail: "started with the safe default; a forged X-Forwarded-For changed nothing" }
        : { verdict: "cryptic", detail: `unexpected status ${res.status} with a forged forwarded header` };
    },
  },
];

// ---------------------------------------------------------------------------
// B — STORAGE FAULTS AFTER A SUCCESSFUL BOOT
// ---------------------------------------------------------------------------

const storageScenarios: Scenario[] = [
  {
    id: "storage/db-deleted-while-running",
    category: "storage",
    what: "data.db is deleted underneath a running process (a stray cleanup job, a volume swap)",
    expect: "the health probe must stop saying 'ok' so the orchestrator can act",
    run: async () => {
      const port = takePort();
      const dir = tempDir();
      const db = join(dir, "data.db");
      const boot = launch({ ...goodEnv(port, db) });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        return { verdict: "error", detail: `could not boot the baseline: ${serving.reason}` };
      }
      // On POSIX the open descriptor survives unlink, so the process keeps working
      // from an unlinked inode. That is not a crash, but it means the data is gone
      // on restart. Either answer is defensible; a 500 storm is not.
      for (const f of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(f)) rmSync(f, { force: true });
      const health = await req(port, "/api/health", { key: null });
      const agents = await req(port, "/api/agents");
      await boot.stop();
      if (health.status === 0 || agents.status === 0) {
        return { verdict: "silent", detail: "stopped answering entirely after the file vanished" };
      }
      if (agents.status >= 500) {
        return {
          verdict: health.status === 200 && health.body.includes('"ok"')
            ? "silent"
            : "handled",
          detail: `reads fail (${agents.status}) and health says ${health.status} ${health.body.slice(0, 120)}`,
        };
      }
      return {
        verdict: "handled",
        detail: `kept serving from the unlinked inode (health ${health.status}, reads ${agents.status}) — POSIX behaviour, data lost on restart`,
      };
    },
  },
  {
    id: "storage/db-made-read-only-while-running",
    category: "storage",
    what: "the filesystem holding the database is remounted read-only mid-flight",
    expect: "reads keep working, writes fail with a retryable 5xx, health stops claiming 'ok'",
    run: async () => {
      // HONEST LIMITATION. The first version of this scenario chmod-ed the directory
      // and the database file, then asserted that a write failed. The write returned
      // 201 — correctly. On POSIX, permissions are checked at open(2), not at write(2),
      // so a process that already holds the descriptor keeps writing, and in WAL mode
      // the bytes land in the -wal file it already has open. chmod therefore does not
      // simulate a read-only filesystem at all; only a real remount or an immutable
      // attribute does, and both need privileges this sandbox does not have.
      //
      // Rather than keep a test that proves nothing, the underlying question — "what
      // does a failed write look like to the caller?" — is asked by
      // `storage/exclusive-lock-held-elsewhere` below, with a fault that can actually
      // be injected here.
      return {
        verdict: "unsupported",
        detail:
          "NOT SIMULATED — chmod does not affect already-open descriptors, so this cannot be faked without privileges. Covered indirectly by storage/exclusive-lock-held-elsewhere.",
      };
    },
  },
  {
    id: "storage/exclusive-lock-held-elsewhere",
    category: "storage",
    what: "another process holds a BEGIN EXCLUSIVE transaction on the database while a write arrives",
    expect:
      "the write must fail with a retryable 5xx and no storage internals; a 4xx would tell the caller to discard work it should retry, and a hang is worse than either",
    run: async () => {
      const port = takePort();
      const dir = tempDir();
      const db = join(dir, "data.db");
      const boot = launch({ ...goodEnv(port, db) });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        return { verdict: "error", detail: `could not boot: ${serving.reason}` };
      }

      // A separate process takes the writer lock and holds it. `unsafeMode` is not
      // needed; a plain exclusive transaction is enough to block every other writer.
      const holder = spawn(
        "node",
        [
          "-e",
          `const D=require(${JSON.stringify(join(ROOT, "node_modules", "better-sqlite3"))});` +
            `const d=new D(${JSON.stringify(db)});d.pragma("journal_mode = WAL");` +
            `d.exec("BEGIN EXCLUSIVE");console.log("LOCKED");setTimeout(()=>process.exit(0),20000);`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let holderOut = "";
      holder.stdout.on("data", (c: Buffer) => (holderOut += c.toString()));
      holder.stderr.on("data", (c: Buffer) => (holderOut += c.toString()));
      const lockDeadline = Date.now() + 6_000;
      while (!holderOut.includes("LOCKED") && Date.now() < lockDeadline) await sleep(100);
      if (!holderOut.includes("LOCKED")) {
        holder.kill("SIGKILL");
        await boot.stop();
        return { verdict: "error", detail: `could not acquire the exclusive lock: ${holderOut.slice(0, 200)}` };
      }

      const started = Date.now();
      const write = await req(port, "/api/agents", { method: "POST", body: validAgent(), timeoutMs: 30_000 });
      const waited = Date.now() - started;
      const read = await req(port, "/api/agents");
      const health = await req(port, "/api/health", { key: null });
      const alive = boot.exited() === null;

      holder.kill("SIGKILL");
      await sleep(200);
      // After the lock is released the system must accept writes again, otherwise a
      // transient contention has become a permanent outage.
      const afterRelease = await req(port, "/api/agents", {
        method: "POST",
        body: validAgent({ id: "agt_chaos_after" }),
        timeoutMs: 15_000,
      });
      await boot.stop();

      if (!alive) return { verdict: "silent", detail: "the process died on lock contention" };
      if (write.status === 0) {
        return { verdict: "silent", detail: `the write never returned — waited ${waited}ms and gave up` };
      }
      const leaks = /SQLITE_|sqlite|\.db\b|\/tmp\//i.test(write.body);
      const recovered = afterRelease.status < 300;
      const parts = [
        `write answered ${write.status} after ${waited}ms`,
        `reads ${read.status}`,
        `health ${health.status}`,
        recovered ? "accepted writes again once the lock was released" : `STILL refusing writes after release (${afterRelease.status})`,
      ];
      if (!recovered) return { verdict: "silent", detail: parts.join("; ") };
      if (write.status < 400) {
        return { verdict: "silent", detail: `reported SUCCESS while another process held the writer lock; ${parts.join("; ")}` };
      }
      if (leaks) {
        return { verdict: "cryptic", detail: `leaks storage internals to the caller: ${write.body.slice(0, 160)}; ${parts.join("; ")}` };
      }
      if (write.status < 500) {
        return {
          verdict: "cryptic",
          detail: `answered ${write.status} — a client error for a transient server-side contention, so a caller is told not to retry; ${parts.join("; ")}`,
        };
      }
      return { verdict: "handled", detail: parts.join("; ") };
    },
  },
  {
    id: "storage/disk-full-on-write",
    category: "storage",
    what: "the filesystem is full when a write lands (simulated with a tiny quota)",
    expect: "the write fails with a 5xx and no internals; the process must survive",
    run: async () => {
      // A real ENOSPC needs a loopback filesystem, which needs privileges this
      // sandbox does not have. The closest faithful approximation available is a
      // read-only store, already covered above. Report honestly rather than
      // pretending a weaker test is the same thing.
      return {
        verdict: "unsupported",
        detail: "NOT SIMULATED — a true ENOSPC requires a loopback mount (privileged). See report.",
      };
    },
  },
];

// ---------------------------------------------------------------------------
// C — HOSTILE INPUT
// ---------------------------------------------------------------------------

const inputScenarios: Scenario[] = [
  {
    id: "input/malformed-json",
    category: "input",
    what: "a POST body that is not valid JSON",
    expect: "400, and the reply must not echo a parser stack trace",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")) });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        return { verdict: "error", detail: `could not boot: ${serving.reason}` };
      }
      const res = await req(port, "/api/agents", { method: "POST", body: "{not json" });
      await boot.stop();
      const leaks = /at \w+\.|node_modules|body-parser|SyntaxError:.*position/i.test(res.body);
      if (res.status !== 400) {
        return { verdict: res.status >= 500 ? "cryptic" : "silent", detail: `answered ${res.status}: ${res.body.slice(0, 160)}` };
      }
      return leaks
        ? { verdict: "cryptic", detail: `400 but leaks parser internals: ${res.body.slice(0, 200)}` }
        : { verdict: "handled", detail: `400 with a clean body: ${res.body.slice(0, 120)}` };
    },
  },
  {
    id: "input/oversized-body",
    category: "input",
    what: "a 12 MB JSON body",
    expect: "413 or 400 — never buffered wholesale into memory and never a crash",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")) });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        return { verdict: "error", detail: `could not boot: ${serving.reason}` };
      }
      const huge = JSON.stringify({ name: "x".repeat(12 * 1024 * 1024) });
      const res = await req(port, "/api/agents", { method: "POST", body: huge, timeoutMs: 20_000 });
      const alive = boot.exited() === null;
      const stillServes = alive ? (await req(port, "/api/health", { key: null })).status : 0;
      await boot.stop();
      if (!alive) return { verdict: "silent", detail: "the process died on an oversized body" };
      if (res.status === 413 || res.status === 400) {
        return { verdict: "handled", detail: `rejected with ${res.status}; still serving (health ${stillServes})` };
      }
      return { verdict: "silent", detail: `accepted a 12 MB body with status ${res.status}` };
    },
  },
  {
    id: "input/prototype-pollution",
    category: "input",
    what: "a body carrying __proto__ and constructor.prototype keys",
    expect: "rejected or ignored; must never alter Object.prototype in the server",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")) });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        return { verdict: "error", detail: `could not boot: ${serving.reason}` };
      }
      const body = '{"name":"p","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}';
      const res = await req(port, "/api/agents", { method: "POST", body });
      // If Object.prototype were polluted, unrelated endpoints would start behaving
      // oddly. The cheapest observable proof is that a later request is unaffected.
      const after = await req(port, "/api/health", { key: null });
      await boot.stop();
      const polluted = after.status !== 200 || after.body.includes("polluted");
      if (polluted) return { verdict: "silent", detail: "a later request shows signs of prototype pollution" };
      return {
        verdict: "handled",
        detail: `body answered ${res.status}; subsequent health still clean (${after.status})`,
      };
    },
  },
  {
    id: "input/null-bytes-and-unicode",
    category: "input",
    what: "an agent name with a NUL byte, RTL override and 4-byte emoji",
    expect: "either rejected or stored and returned intact — never a 500, never truncation that changes meaning",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")) });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        return { verdict: "error", detail: `could not boot: ${serving.reason}` };
      }
      const name = "A\u0000B\u202Eevil\u202C\u{1F600}";
      const res = await req(port, "/api/agents", { method: "POST", body: validAgent({ name }) });
      const listed = await req(port, "/api/agents");
      await boot.stop();
      if (res.status >= 500) return { verdict: "cryptic", detail: `500 on hostile unicode: ${res.body.slice(0, 160)}` };
      if (res.status >= 400) {
        return { verdict: "handled", detail: `rejected with ${res.status} — refusing the name is a defensible choice` };
      }
      // Accepted. It must come back as it went in: a name silently truncated at the
      // NUL byte would display as "A" in the console while the audit trail refers to
      // something else.
      const intact = listed.body.includes("\\u0000") || listed.body.includes("A\u0000B");
      return {
        verdict: intact ? "handled" : "cryptic",
        detail: intact
          ? `stored and returned intact (create ${res.status})`
          : `accepted (${res.status}) but the stored name does not round-trip — possible silent truncation`,
      };
    },
  },
  {
    id: "input/deeply-nested-json",
    category: "input",
    what: "JSON nested 50 000 levels deep",
    expect: "rejected; a stack overflow in the parser must not take the process down",
    run: async () => {
      const port = takePort();
      const boot = launch({ ...goodEnv(port, join(tempDir(), "data.db")) });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        return { verdict: "error", detail: `could not boot: ${serving.reason}` };
      }
      const depth = 50_000;
      const body = `{"context":${"[".repeat(depth)}1${"]".repeat(depth)}}`;
      const res = await req(port, "/api/evaluate", { method: "POST", body, timeoutMs: 20_000 });
      const alive = boot.exited() === null;
      const after = alive ? (await req(port, "/api/health", { key: null })).status : 0;
      await boot.stop();
      if (!alive) return { verdict: "silent", detail: "the process died parsing deeply nested JSON" };
      return {
        verdict: res.status >= 400 && after === 200 ? "handled" : "cryptic",
        detail: `answered ${res.status}, still serving afterwards (health ${after})`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// D — NETWORK: the webhook receiver misbehaves
// ---------------------------------------------------------------------------

/** A receiver whose behaviour each scenario chooses. */
function receiver(behaviour: "hang" | "slow" | "flood" | "500" | "redirect"): {
  server: Server;
  close: () => Promise<void>;
} {
  const server = createServer((req, res) => {
    req.resume();
    switch (behaviour) {
      case "hang":
        // Accept the connection and never answer. The classic way a well-behaved
        // client turns into a resource leak.
        return;
      case "slow":
        return void setTimeout(() => res.writeHead(204).end(), 30_000);
      case "flood":
        res.writeHead(200, { "content-type": "application/octet-stream" });
        // Stream far more than any client should accept.
        return void (function pump() {
          if (res.write(Buffer.alloc(1024 * 512))) setImmediate(pump);
          else res.once("drain", pump);
        })();
      case "500":
        return void res.writeHead(500).end("receiver exploded");
      case "redirect":
        return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    }
  });
  return {
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/*
 * A receiver that answers correctly and *remembers*. The behaviour-driven `receiver`
 * above exists to break the client; this one exists to count what reached the wire.
 * A dispatch count is the only direct evidence that a held action was released once
 * and not twice.
 */
function countingReceiver(): { server: Server; close: () => Promise<void>; bodies: () => string[] } {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(204).end();
    });
  });
  return {
    server,
    bodies: () => [...bodies],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

function webhookScenario(
  id: string,
  behaviour: Parameters<typeof receiver>[0],
  what: string,
  expect: string,
): Scenario {
  return {
    id,
    category: "network",
    what,
    expect,
    run: async () => {
      const rec = receiver(behaviour);
      const recPort = await listen(rec.server);
      const port = takePort();
      const boot = launch({
        ...goodEnv(port, join(tempDir(), "data.db")),
        OATHRION_SEED: "config",
        OATHRION_WEBHOOK_URL: `http://127.0.0.1:${recPort}/hook`,
        OATHRION_WEBHOOK_SECRET: "chaos-webhook-secret-0123456789",
        OATHRION_WEBHOOK_TIMEOUT_MS: "1500",
        OATHRION_WEBHOOK_ALLOW_PRIVATE: "true",
      });
      const serving = await waitUntilServing(port, boot);
      if (!serving.serving) {
        await boot.stop();
        await rec.close();
        return { verdict: "error", detail: `could not boot: ${serving.reason} :: ${lastLines(boot.output(), 3)}` };
      }

      // Acting as an agent needs a credential bound to it; the env-declared key cannot be.
      const agentKey = await mintBoundKey(port, "agt_procurement");
      if (agentKey === null) {
        const out = boot.output();
        await boot.stop();
        await rec.close();
        return {
          verdict: "error",
          detail: `THE BENCH COULD NOT MINT A BOUND CREDENTIAL, so the webhook path was never reached :: ${lastLines(out, 3)}`,
        };
      }

      const started = Date.now();
      /*
       * `persist: true` and a `target` are both required to reach a notification.
       * The first version of this bench omitted both: `/api/evaluate` is a dry run by
       * default and `target` is mandatory, so every network scenario got a 400 in
       * under 15ms, no webhook was ever attempted, and the bench scored five passes
       * for a code path it never entered. `deliveries` is asserted below so that can
       * no longer happen quietly.
       */
      const decision = await req(port, "/api/evaluate", {
        method: "POST",
        key: agentKey,
        body: JSON.stringify({
          agentId: "agt_procurement",
          action: "purchase",
          target: "amazon.com",
          // Above agt_procurement's 500 EUR mandate ceiling on purpose. A notification
          // is emitted only when an approval is created, a decision is BLOCK, or an
          // approval is resolved (decision-service.ts:233/253/352); an allowed 42 EUR
          // purchase is silent by design, which is why the earlier payload reached no
          // webhook. Each scenario uses a fresh database, so the daily-spend counter
          // never carries over between scenarios.
          amount: 4000,
          currency: "EUR",
          category: "Office supplies",
          persist: true,
        }),
        timeoutMs: 15_000,
      });
      const requestMs = Date.now() - started;

      // The API call must not inherit the receiver's latency, and the process must
      // stay healthy afterwards.
      await sleep(2_500);
      const alive = boot.exited() === null;
      const health = alive ? await req(port, "/api/health", { key: null }) : { status: 0, body: "" };
      const notif = alive ? await req(port, "/api/notifications") : { status: 0, body: "" };
      const out = boot.output();
      await boot.stop();
      await rec.close();

      if (!alive) return { verdict: "silent", detail: `the process died. Output: ${lastLines(out, 4)}` };
      if (decision.status === 0) {
        return { verdict: "silent", detail: `the API call itself never returned (waited ${requestMs}ms)` };
      }
      if (decision.status >= 300) {
        return {
          verdict: "error",
          detail: `THE BENCH DID NOT REACH THE WEBHOOK: the decision itself was refused with ${decision.status}: ${decision.body.slice(0, 200)}`,
        };
      }
      const attempts = deliveryCount(notif);
      if (attempts === null || attempts === 0) {
        return {
          verdict: "error",
          detail: `THE BENCH DID NOT REACH THE WEBHOOK: no delivery attempt was recorded (notifications ${notif.status}): ${notif.body.slice(0, 200)}`,
        };
      }
      const leaks = /127\.0\.0\.1|:\d{4,5}\b/.test(notif.body);
      // The decision must not inherit the receiver's latency: notification is a
      // side channel, and a hung receiver holding an API request hostage would make
      // one broken webhook look like a total outage.
      const blocked = requestMs > 3_000;
      const parts = [
        `decision ${decision.status} in ${requestMs}ms`,
        `${attempts} delivery attempt(s) recorded`,
        `health ${health.status}`,
        leaks ? "delivery detail LEAKS the receiver address" : "delivery detail carries no address",
      ];
      if (blocked) {
        return { verdict: "cryptic", detail: `the API request waited on the receiver — ${parts.join("; ")}` };
      }
      return { verdict: leaks ? "cryptic" : "handled", detail: parts.join("; ") };
    },
  };
}

const networkScenarios: Scenario[] = [
  webhookScenario(
    "network/receiver-hangs",
    "hang",
    "the webhook receiver accepts the connection and never answers",
    "the decision request must not block on it, and the socket must be abandoned at the timeout",
  ),
  webhookScenario(
    "network/receiver-slow",
    "slow",
    "the receiver answers after 30 s, far beyond the configured timeout",
    "the delivery is abandoned at the timeout; the API stays responsive",
  ),
  webhookScenario(
    "network/receiver-floods",
    "flood",
    "the receiver streams an unbounded response body",
    "the body is capped and the socket destroyed; memory must not grow without limit",
  ),
  webhookScenario(
    "network/receiver-500",
    "500",
    "the receiver answers 500 with a body",
    "recorded as a failed delivery; the receiver's text must not be echoed verbatim to a viewer",
  ),
  webhookScenario(
    "network/receiver-redirects-to-metadata",
    "redirect",
    "the receiver answers 302 pointing at the cloud metadata service",
    "the redirect must NOT be followed — this is the SSRF vector",
  ),
];

// ---------------------------------------------------------------------------
// E — ABRUPT DEATH AND RESOURCE LIMITS
// ---------------------------------------------------------------------------

const resilienceScenarios: Scenario[] = [
  {
    id: "resilience/sigkill-then-restart",
    category: "resilience",
    what: "SIGKILL (no graceful shutdown at all) followed by a restart on the same database",
    expect: "the next process must open the database and serve; a WAL left mid-write must not be fatal",
    run: async () => {
      const dir = tempDir();
      const db = join(dir, "data.db");
      const p1 = takePort();
      const first = launch({ ...goodEnv(p1, db), OATHRION_SEED: "config" });
      const s1 = await waitUntilServing(p1, first);
      if (!s1.serving) {
        await first.stop();
        return { verdict: "error", detail: `could not boot the first process: ${s1.reason}` };
      }
      // Put load on it, then kill it with no warning in the middle.
      const inflight = Promise.allSettled(
        Array.from({ length: 25 }, () =>
          req(p1, "/api/evaluate", {
            method: "POST",
            body: JSON.stringify({
              agentId: "agt_procurement",
              action: "purchase",
              amount: 10,
              currency: "EUR",
              category: "Office supplies",
            }),
            timeoutMs: 4_000,
          }),
        ),
      );
      await sleep(300);
      first.child.kill("SIGKILL");
      await inflight;
      await sleep(300);

      const p2 = takePort();
      const second = launch({ ...goodEnv(p2, db), OATHRION_SEED: "config" });
      const s2 = await waitUntilServing(p2, second);
      const out = second.output();
      if (!s2.serving) {
        await second.stop();
        return {
          verdict: "silent",
          detail: `the restart could not open a database left behind by SIGKILL: ${s2.reason} :: ${lastLines(out, 3)}`,
        };
      }
      const agents = await req(p2, "/api/agents");
      await second.stop();
      return {
        verdict: agents.status === 200 ? "handled" : "cryptic",
        detail: `restarted cleanly on the same file and served agents with ${agents.status}`,
      };
    },
  },
  {
    id: "resilience/second-instance-same-port",
    category: "resilience",
    what: "a second instance is started on a port already bound",
    expect: "the second must refuse loudly, not bind silently and serve half the traffic",
    run: async () => {
      const port = takePort();
      const first = launch({ ...goodEnv(port, join(tempDir(), "data.db")) });
      const s1 = await waitUntilServing(port, first);
      if (!s1.serving) {
        await first.stop();
        return { verdict: "error", detail: `could not boot the first process: ${s1.reason}` };
      }
      const second = launch({ ...goodEnv(port, join(tempDir(), "data.db")) });
      const code = await waitExit(second, 8_000);
      const out = second.output();
      await second.stop();
      await first.stop();
      if (code === null) {
        return { verdict: "silent", detail: "the second instance neither exited nor complained — it may have bound the port" };
      }
      return /already in use|eaddrinuse/i.test(out)
        ? { verdict: "handled", detail: `second instance refused (code ${code}): ${lastLines(out, 1)}` }
        : { verdict: "cryptic", detail: `second instance exited ${code} without naming the port: ${lastLines(out, 2)}` };
    },
  },
  {
    id: "resilience/two-instances-same-database",
    category: "resilience",
    what: "two processes on different ports sharing one SQLite file",
    expect: "both must work, or the second must refuse — silent corruption is the unacceptable outcome",
    run: async () => {
      const db = join(tempDir(), "data.db");
      const p1 = takePort();
      const p2 = takePort();
      const a = launch({ ...goodEnv(p1, db), OATHRION_SEED: "config" });
      const sa = await waitUntilServing(p1, a);
      if (!sa.serving) {
        await a.stop();
        return { verdict: "error", detail: `first process would not boot: ${sa.reason}` };
      }
      const b = launch({ ...goodEnv(p2, db) });
      const sb = await waitUntilServing(p2, b);
      if (!sb.serving) {
        const out = b.output();
        await a.stop();
        await b.stop();
        return { verdict: "handled", detail: `the second refused to share the file: ${lastLines(out, 2)}` };
      }
      // Both are up. Write through one and read through the other: they must agree,
      // otherwise each process is serving its own idea of the truth.
      const created = await req(p1, "/api/agents", {
        method: "POST",
        body: validAgent({ id: "agt_shared", name: "Shared Write" }),
      });
      await sleep(300);
      const seenByOther = await req(p2, "/api/agents");
      await a.stop();
      await b.stop();
      // Checked by id, and reported with what the other instance actually returned.
      // An earlier version tested `body.includes("Shared Write")` and reported
      // "INVISIBLE" without saying what it saw — which turned out to be a defect in
      // this bench rather than a fault in the system, and cost a diagnosis.
      const visible = seenByOther.body.includes("agt_shared");
      if (created.status >= 400) {
        return {
          verdict: "error",
          detail: `THE BENCH DID NOT TEST SHARING: the write itself failed with ${created.status}: ${created.body.slice(0, 160)}`,
        };
      }
      return visible
        ? {
            verdict: "handled",
            detail: `both instances up; the write through one was visible through the other (${agentCount(seenByOther) ?? "?"} agents)`,
          }
        : {
            verdict: "silent",
            detail: `both instances up but a committed write was INVISIBLE to the other (read status ${seenByOther.status}, ${agentCount(seenByOther) ?? "?"} agents): ${seenByOther.body.slice(0, 200)}`,
          };
    },
  },
  {
    id: "resilience/concurrent-approval-two-processes",
    category: "resilience",
    what: "two separate processes on one SQLite file resolve the SAME pending approval at the same instant",
    expect:
      "exactly one process may claim the approval and release the action to its tool; a double dispatch of a held action is the worst outcome this system can produce",
    run: async () => {
      /*
       * This scenario exists to settle a claim the report could only reason about.
       * The approval resolve path guards itself with a single conditional UPDATE
       * (`WHERE status = 'pending'`) and reads `info.changes === 1` to decide who won.
       * That is the right shape, but the in-process test suite *cannot* falsify it:
       * better-sqlite3 is synchronous, so two `Promise.all` calls inside one process
       * never actually interleave — the first runs to completion before the second
       * starts. The barrier was therefore "reasoned, not proven".
       *
       * Two OS processes against one file is a real race, and it is the deployment
       * shape the pilot conditions allow. If the conditional UPDATE were replaced by
       * a read-then-write, this is where it would show.
       */
      const dir = tempDir();
      const db = join(dir, "data.db");
      const p1 = takePort();
      const p2 = takePort();
      /*
       * Both processes point at one counting receiver. Without a webhook channel the
       * delivery count is always 0, which would look like proof of no double dispatch
       * while proving nothing at all — an earlier version of this scenario reported
       * exactly that "0 delivery attempt(s)" and it was meaningless.
       */
      const rec = countingReceiver();
      const recPort = await listen(rec.server);
      const hook = {
        OATHRION_WEBHOOK_URL: `http://127.0.0.1:${recPort}/hook`,
        OATHRION_WEBHOOK_SECRET: "chaos-webhook-secret-0123456789",
        OATHRION_WEBHOOK_TIMEOUT_MS: "1500",
        OATHRION_WEBHOOK_ALLOW_PRIVATE: "true",
      };
      const a = launch({ ...goodEnv(p1, db), ...hook, OATHRION_SEED: "config" });
      const sa = await waitUntilServing(p1, a);
      if (!sa.serving) {
        await a.stop();
        await rec.close();
        return { verdict: "error", detail: `first process would not boot: ${sa.reason}` };
      }
      const b = launch({ ...goodEnv(p2, db), ...hook });
      const sb = await waitUntilServing(p2, b);
      if (!sb.serving) {
        await a.stop();
        await b.stop();
        await rec.close();
        return {
          verdict: "error",
          detail: "the second process would not share the file, so the race could not be run",
        };
      }

      // Provoke a genuine APPROVAL_REQUIRED rather than fabricating a row: the
      // interesting code is the resolve path of a real pending approval.
      // `agt_sales` carries send:email with no category mandate, so the org policy
      // decides and holds the action.
      /*
       * A credential bound to `agt_sales`. The env-declared admin key cannot act as an
       * agent — `OATHRION_API_KEYS` has no field for a binding — and binding is permanently
       * on in the bundle, so without this the decision below is refused 403 and the race
       * is never reached. The approve calls further down keep using the admin key: a
       * human resolving an approval is not acting as the agent.
       */
      const salesKey = await mintBoundKey(p1, "agt_sales");
      if (salesKey === null) {
        await a.stop();
        await b.stop();
        await rec.close();
        return {
          verdict: "error",
          detail: "THE BENCH COULD NOT MINT A BOUND CREDENTIAL for agt_sales, so the race was never reached",
        };
      }

      const decision = await req(p1, "/api/decision", {
        method: "POST",
        key: salesKey,
        body: JSON.stringify({
          agentId: "agt_sales",
          action: "send_email",
          target: "external_email",
          metadata: { recipient: "someone@outside.example", cost: 0 },
        }),
      });
      let approvalId: string | null = null;
      try {
        const parsed = JSON.parse(decision.body) as { decision?: string; approvalId?: string };
        if (parsed.decision !== "APPROVAL_REQUIRED") {
          await a.stop();
          await b.stop();
          await rec.close();
          return {
            verdict: "error",
            detail: `THE BENCH DID NOT TEST THE RACE: expected APPROVAL_REQUIRED, got ${parsed.decision ?? decision.status}: ${decision.body.slice(0, 160)}`,
          };
        }
        approvalId = parsed.approvalId ?? null;
      } catch {
        await a.stop();
        await b.stop();
        await rec.close();
        return {
          verdict: "error",
          detail: `THE BENCH DID NOT TEST THE RACE: decision was ${decision.status}: ${decision.body.slice(0, 160)}`,
        };
      }
      if (!approvalId) {
        await a.stop();
        await b.stop();
        await rec.close();
        return { verdict: "error", detail: "no approvalId came back, so there was nothing to race for" };
      }

      // Fire both at once, from two processes. No sleep between them.
      const [ra, rb] = await Promise.all([
        req(p1, `/api/approvals/${approvalId}/approve`, { method: "POST", body: "{}" }),
        req(p2, `/api/approvals/${approvalId}/approve`, { method: "POST", body: "{}" }),
      ]);

      const claims = [ra, rb].map((r) => {
        try {
          const parsed = JSON.parse(r.body) as { executed?: boolean; attempted?: boolean };
          return { status: r.status, executed: parsed.executed === true, attempted: parsed.attempted === true };
        } catch {
          return { status: r.status, executed: false, attempted: false };
        }
      });
      const winners = claims.filter((c) => c.executed).length;
      // The dispatch count is the property that actually matters: a second
      // `approval.resolved` on the wire means the held action went out twice.
      await sleep(800);
      const resolved = rec.bodies().filter((body) => body.includes("approval.resolved")).length;
      await a.stop();
      await b.stop();
      await rec.close();

      const shape = claims.map((c) => `${c.status}/executed=${c.executed}`).join(" + ");
      if (winners === 1 && resolved > 1) {
        // One winner but two notifications on the wire is still a double release.
        return {
          verdict: "silent",
          detail: `one process claimed the approval (${shape}) but ${resolved} approval.resolved notifications reached the receiver`,
        };
      }
      if (winners === 1) {
        return {
          verdict: "handled",
          detail: `exactly one of two OS processes claimed the approval (${shape}); ${resolved} approval.resolved notification(s) reached the receiver`,
        };
      }
      if (winners === 0) {
        // Nobody executed: not a double dispatch, so not the catastrophic outcome,
        // but the approval was not honoured either. Loud rather than silent.
        return {
          verdict: "cryptic",
          detail: `NEITHER process claimed the approval (${shape}) — the approver's decision was lost rather than duplicated`,
        };
      }
      return {
        verdict: "silent",
        detail: `DOUBLE DISPATCH: ${winners} processes both believed they released the action (${shape}); ${resolved} approval.resolved notification(s) reached the receiver`,
      };
    },
  },
  {
    id: "resilience/session-survives-restart",
    category: "resilience",
    what: "a console session token is issued, then the server is restarted under it",
    expect:
      "the token must still be accepted after the restart; if the signing secret were generated at boot, every deployment would silently log every operator out",
    run: async () => {
      /*
       * THE LOGIN BODY HAS BEEN WRONG TWICE. Recorded in full because the second
       * version looked like a fix and was not.
       *
       *   1. `{username, password}` + a search for a Set-Cookie header. Wrong twice
       *      over: the route answers with a signed token in the JSON body, there is no
       *      cookie anywhere, and `username` is not a field it knows.
       *   2. `{password}` alone, on the belief that the body was a `strictObject`
       *      carrying only a password. That was true before P0-2 introduced real user
       *      accounts; the route has required BOTH `email` and `password` ever since,
       *      so every run answered `400 {"error":"email and password are required"}`.
       *
       * Version 2 is the interesting one: it made the scenario report `error`, which the
       * bench filed under "not simulated" and exited 0 for. So the fix looked applied,
       * CI stayed green, and session durability across a restart went unverified.
       *
       * `CONSOLE_EMAIL` is the address derived from the display name in `goodEnv()` —
       * see the constant for why it is derived rather than configured.
       */
      const p1 = takePort();
      const dir = tempDir();
      const db = join(dir, "data.db");
      const first = launch({ ...goodEnv(p1, db) });
      const s1 = await waitUntilServing(p1, first);
      if (!s1.serving) {
        await first.stop();
        return { verdict: "error", detail: `could not boot: ${s1.reason}` };
      }

      const login = await req(p1, "/api/auth/login", {
        method: "POST",
        key: null,
        body: JSON.stringify({ email: CONSOLE_EMAIL, password: CONSOLE_PASSWORD }),
      });
      if (login.status !== 200) {
        await first.stop();
        return { verdict: "error", detail: `THE BENCH DID NOT LOG IN: ${login.status} ${login.body.slice(0, 160)}` };
      }
      let token: string | null = null;
      try {
        token = (JSON.parse(login.body) as { token?: string }).token ?? null;
      } catch {
        token = null;
      }
      if (!token) {
        await first.stop();
        return { verdict: "error", detail: `no token in the login response: ${login.body.slice(0, 160)}` };
      }

      // The token must work before the restart, otherwise the comparison is meaningless.
      const before = await req(p1, "/api/agents", { key: token });
      await first.stop();
      if (before.status !== 200) {
        return { verdict: "error", detail: `THE BENCH IS BROKEN: a fresh token was refused with ${before.status}` };
      }

      const second = launch({ ...goodEnv(p1, db) });
      const s2 = await waitUntilServing(p1, second);
      if (!s2.serving) {
        await second.stop();
        return { verdict: "silent", detail: `the second instance did not come back up: ${s2.reason}` };
      }
      const after = await req(p1, "/api/agents", { key: token });
      // A token must not be accepted once the operator's password is rotated away.
      const rotated = launchProbe(dir, db, token);
      await second.stop();
      const afterRotation = await rotated;

      if (after.status === 200 && afterRotation === 401) {
        return {
          verdict: "handled",
          detail: "the token survived the restart (200) and was correctly refused (401) after the console password was rotated",
        };
      }
      if (after.status === 401) {
        return {
          verdict: "cryptic",
          detail:
            "the token was refused (401) after a plain restart — the session secret is not stable across boots, so every deploy logs every operator out with no message",
        };
      }
      if (afterRotation !== 401) {
        return {
          verdict: "silent",
          detail: `the token was STILL accepted (${afterRotation}) after the console password was rotated — revocation does not work`,
        };
      }
      return { verdict: "cryptic", detail: `unexpected pair: after restart ${after.status}, after rotation ${afterRotation}` };
    },
  },
];

// ---------------------------------------------------------------------------

const ALL: Scenario[] = [
  ...controlScenarios,
  ...configScenarios,
  ...storageScenarios,
  ...inputScenarios,
  ...networkScenarios,
  ...resilienceScenarios,
];

const SYMBOL: Record<Verdict, string> = {
  handled: "PASS",
  cryptic: "WARN",
  silent: "FAIL",
  unsupported: "N/A",
  // Deliberately not "SKIP". A skip reads as a choice; this is the bench failing to
  // run the check at all, and it fails the build.
  error: "BENCH BROKEN",
};

async function main(): Promise<number> {
  if (!existsSync(BUNDLE)) {
    console.error(`dist/index.cjs is missing — run \`npm run build\` first.`);
    return 2;
  }

  const filter = process.argv[2]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const selected = filter.length
    ? ALL.filter((s) => filter.some((f) => s.id.includes(f) || s.category === f))
    : ALL;

  console.log(`\nFault-injection bench — ${selected.length} scenario(s)\n${"=".repeat(78)}`);

  const results: Array<{ s: Scenario; o: Outcome }> = [];
  for (const [i, s] of selected.entries()) {
    process.stdout.write(`[${i + 1}/${selected.length}] ${s.id} … `);
    let o: Outcome;
    try {
      o = await s.run();
    } catch (e) {
      o = { verdict: "error", detail: `the scenario itself threw: ${(e as Error).message}` };
    }
    results.push({ s, o });
    console.log(`${SYMBOL[o.verdict]}\n        ${o.detail}`);
  }

  console.log("=".repeat(78));
  const by = (v: Verdict) => results.filter((r) => r.o.verdict === v);
  const fails = by("silent");
  const warns = by("cryptic");
  const unsupported = by("unsupported");
  const broken = by("error");
  console.log(
    `handled: ${by("handled").length}   cryptic: ${warns.length}   SILENT FAILURES: ${fails.length}   not simulated: ${unsupported.length}   BENCH BROKEN: ${broken.length}`,
  );

  if (warns.length) {
    console.log(`\nCryptic (survivable, but the operator pays for it):`);
    for (const r of warns) console.log(`  - ${r.s.id}: ${r.o.detail}`);
  }
  if (fails.length) {
    console.log(`\nSILENT FAILURES — these are the ones that cause incidents:`);
    for (const r of fails) console.log(`  - ${r.s.id}\n      injected: ${r.s.what}\n      expected: ${r.s.expect}\n      observed: ${r.o.detail}`);
  }
  if (unsupported.length) {
    console.log(`\nNot simulated here (the fault cannot be injected in this environment):`);
    for (const r of unsupported) console.log(`  - ${r.s.id}: ${r.o.detail}`);
  }
  if (broken.length) {
    console.log(`\nBENCH BROKEN — these scenarios never reached the system under test, so this run proves nothing about them:`);
    for (const r of broken) console.log(`  - ${r.s.id}\n      wanted to inject: ${r.s.what}\n      the bench failed with: ${r.o.detail}`);
  }

  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* a chmod-ed directory may resist; the OS reaps tmp anyway */
    }
  }

  console.log("");
  /*
   * A broken bench fails the run just as hard as a silent failure it detects.
   *
   * This used to be `fails.length ? 1 : 0`, so the 27 `error` sites — could not boot,
   * could not log in, no token came back — all exited 0. That is the worse of the two
   * bugs: a detected silent failure is at least reported, whereas an unrunnable check
   * reported success and no one looked again.
   */
  if (broken.length) {
    console.log(
      `FAIL — ${broken.length} scenario(s) could not be run by the bench. Fix the bench: an unrunnable check is not a passing check.`,
    );
  }
  return fails.length || broken.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("chaos bench crashed:", e);
    process.exit(3);
  });
