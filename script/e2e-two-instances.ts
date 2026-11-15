/**
 * TWO REAL INSTANCES, ONE SHARED QUOTA.
 *
 * WHY A SEPARATE SCRIPT
 * ---------------------
 * P0-7 is asserted in three places already: unit tests build two `PostgresQuotaStore`
 * objects and prove one budget; `smoke:postgres` proves the shipped bundle's limiter
 * writes to PostgreSQL and that a second store sees its counters. Neither of them runs
 * **two servers**. The claim a customer cares about is about processes, not objects:
 *
 *     instance A ─┐
 *                 ├── PostgreSQL   →  a limit of N is N in total, not N per instance
 *     instance B ─┘
 *
 * So this boots `dist/index.cjs` twice, on two ports, against one PostgreSQL, with the
 * same credential, and floods both concurrently. The same run then repeats the flood
 * with the in-memory limiter, which is the pre-P0-7 behaviour, and requires it to allow
 * strictly more — the demonstration that the shared store is what fixed it, rather than
 * the flood being too small to reach any limit.
 *
 * Requires a reachable PostgreSQL. Exits 2 if there is none — never a silent pass.
 *
 * Usage: DATABASE_URL=postgres://… npm run e2e:instances
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");

const PORT_A = 5221;
const PORT_B = 5222;

const API_KEY = "two-instance-admin-key-0123456789";
const SESSION_SECRET = "two-instance-session-secret-0123456789";
const CONSOLE_PASSWORD = "two-instance-console-password-01";

/**
 * The limiter dimension under test is the `write` scope: 30 requests per 60 s per
 * identity. Both instances are driven with the SAME API key, so both resolve the same
 * bucket — which is the entire point. A different key per instance would pass even with
 * the old broken limiter.
 */
const WRITE_LIMIT = 30;
/** Enough per instance that an unshared limiter would visibly allow about 2 × the cap. */
const PER_INSTANCE = 25;

type BootedChild = ChildProcessByStdio<null, Readable, Readable>;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot(port: number, dbPath: string, limiter: "postgres" | "memory", pgUrl: string) {
  /*
   * The two halves of this script now run in two different modes, because
   * NODE_ENV=production requires the whole PostgreSQL set — driver, identity plane,
   * action authority AND the shared limiter — and no variable opts out of it.
   *
   *   postgres half : the real production shape. Both instances share one PostgreSQL,
   *                   so the shared quota is proven where a deployment would meet it.
   *   memory half   : NOT production. A per-process limiter is refused in production by
   *                   design, so the "each instance limits separately" contrast can only
   *                   be shown outside it. The claim does not need production mode; it
   *                   needs two processes and a limiter that is not shared.
   *
   * Records used to stay in per-instance SQLite files so the limiter was the only thing
   * the processes shared. In the postgres half they now share the database as well,
   * which is what a real deployment looks like; the contrast against the memory half is
   * what still isolates the limiter's behaviour.
   */
  const shared =
    limiter === "postgres"
      ? {
          NODE_ENV: "production",
          DATABASE_DRIVER: "postgres",
          DATABASE_URL: pgUrl,
          OATHRION_IDENTITY_PLANE: "postgres",
          OATHRION_ACTION_AUTHORITY_DRIVER: "postgres",
          RATE_LIMIT_STORE: "postgres",
        }
      : {
          // Development mode on a throwaway file, one per instance: nothing is shared,
          // which is the point of this half.
          OATHRION_DB: dbPath,
          RATE_LIMIT_STORE: "memory",
          // A connection string is still exported by the caller. Saying so keeps the
          // "DATABASE_URL that nothing reads" refusal strict everywhere else.
          OATHRION_IGNORE_DATABASE_URL: "true",
        };

  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Cleared so the postgres half cannot silently inherit a SQLite path, and the
      // memory half cannot inherit a production NODE_ENV from the caller's shell.
      NODE_ENV: undefined,
      OATHRION_DB: undefined,
      PORT: String(port),
      OATHRION_SESSION_SECRET: SESSION_SECRET,
      OATHRION_API_KEYS: `Flood Admin:admin:${API_KEY}`,
      OATHRION_CONSOLE_USERS: `admin@flood.test:admin:${CONSOLE_PASSWORD}`,
      OATHRION_SEED: "",
      ...shared,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as BootedChild;
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  return { child, output: () => output };
}

async function waitForBoot(child: BootedChild, port: number, timeoutMs = 30_000) {
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

/**
 * Every answer that is neither 400 (allowed, then rejected by validation) nor 429
 * (refused by the limiter) is kept whole — instance, status, body, timing — so an
 * unexpected status is diagnosable from the report instead of being a bare count.
 */
interface Unexpected {
  port: number;
  index: number;
  status: number;
  body: string;
  ms: number;
}
const unexpected: Unexpected[] = [];

/** One write request. Returns its status; 0 on a transport failure. */
async function write(port: number, index: number): Promise<number> {
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/policies`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      // A deliberately invalid body: the limiter middleware runs BEFORE validation, so
      // every request is counted, and none of them writes a row. The flood therefore
      // measures the limiter and nothing else.
      body: JSON.stringify({ id: `pol_flood_${port}_${index}` }),
    });
    const text = await res.text();
    if (res.status !== 400 && res.status !== 429) {
      unexpected.push({ port, index, status: res.status, body: text.slice(0, 300), ms: Date.now() - started });
    }
    return res.status;
  } catch (error) {
    unexpected.push({
      port,
      index,
      status: 0,
      body: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    });
    return 0;
  }
}

/** Floods both instances concurrently and counts what each answered. */
async function flood(): Promise<{ allowed: number; limited: number; other: number; otherStatuses: number[] }> {
  const calls: Promise<number>[] = [];
  for (let i = 0; i < PER_INSTANCE; i += 1) {
    // Interleaved on purpose: alternating ports maximises the chance that a
    // read-then-write limiter loses an increment.
    calls.push(write(PORT_A, i));
    calls.push(write(PORT_B, i));
  }
  const statuses = await Promise.all(calls);
  return {
    // 400 is an accepted request that then failed validation — i.e. the limiter let it
    // through, which is what "allowed" means here.
    allowed: statuses.filter((s) => s === 400).length,
    limited: statuses.filter((s) => s === 429).length,
    other: statuses.filter((s) => s !== 400 && s !== 429).length,
    // Named in the report so an unexpected answer is diagnosable, not just counted.
    otherStatuses: statuses.filter((s) => s !== 400 && s !== 429),
  };
}

async function main(): Promise<number> {
  console.log("=".repeat(78));
  console.log("Oathrion — TWO INSTANCES, ONE SHARED QUOTA (real processes, real PostgreSQL)");
  console.log("=".repeat(78));

  if (!existsSync(BUNDLE)) {
    console.error("\nNo bundle at dist/index.cjs. Run `npm run build` first.");
    return 2;
  }

  const pgUrl = process.env.DATABASE_URL ?? process.env.OATHRION_TEST_PG_URL ?? "";
  if (!pgUrl) {
    console.error("\nNo DATABASE_URL. This script needs a reachable PostgreSQL; refusing to pass silently.");
    return 2;
  }

  // The limiter table must exist — `npm run migrate:postgres` is the operator's step,
  // and it is verified here rather than assumed, so a missing migration is reported as
  // a setup failure and not as a limiter defect.
  const probe = new Client({ connectionString: pgUrl });
  try {
    await probe.connect();
    const { rows } = await probe.query<{ exists: boolean }>(
      "select exists (select 1 from information_schema.tables where table_name = 'rate_limit_buckets') as exists",
    );
    if (!rows[0]?.exists) {
      console.error("\nNo rate_limit_buckets table. Run `npm run migrate:postgres` first.");
      return 2;
    }
    // Start from a clean slate so a previous run's counters cannot decide this one.
    await probe.query("delete from rate_limit_buckets");
  } catch (error) {
    console.error(`\nPostgreSQL is not reachable: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    await probe.end().catch(() => undefined);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "placet-two-"));

  /* ---------------- the shared limiter (P0-7) --------------------------- */
  console.log("\n── shared PostgreSQL limiter ───────────────────────────────────────────");
  const a = boot(PORT_A, path.join(dir, "a.db"), "postgres", pgUrl);
  const b = boot(PORT_B, path.join(dir, "b.db"), "postgres", pgUrl);
  let sharedAllowed = 0;
  try {
    const bootedA = await waitForBoot(a.child, PORT_A);
    const bootedB = await waitForBoot(b.child, PORT_B);
    record("two instances boot against one PostgreSQL", bootedA && bootedB, `A=${bootedA}, B=${bootedB}`);
    if (!bootedA || !bootedB) {
      console.log(`\n--- A ---\n${a.output()}\n--- B ---\n${b.output()}`);
      return 1;
    }

    const result = await flood();
    sharedAllowed = result.allowed;
    record(
      `a limit of ${WRITE_LIMIT} is ${WRITE_LIMIT} in total across both instances`,
      result.allowed <= WRITE_LIMIT && result.limited > 0 && result.other === 0,
      `${PER_INSTANCE * 2} requests sent, ${result.allowed} allowed, ${result.limited} refused with 429` +
        (result.other ? `, other statuses: ${result.otherStatuses.join(",")}` : ""),
    );
    if (result.other > 0) {
      for (const u of unexpected) {
        console.log(`    unexpected: instance ${u.port === PORT_A ? "A" : "B"} (:${u.port}) request #${u.index} → ${u.status} after ${u.ms} ms: ${u.body}`);
      }
      const logs = (label: string, out: string) =>
        out.split("\n").filter((l) => /rate-limit|error|Error|timeout/i.test(l)).slice(0, 10).forEach((l) => console.log(`    [${label} log] ${l}`));
      logs("A", a.output());
      logs("B", b.output());
    }
    record(
      "the flood was large enough to matter — it exceeded the cap",
      PER_INSTANCE * 2 > WRITE_LIMIT,
      `${PER_INSTANCE * 2} sent against a cap of ${WRITE_LIMIT}`,
    );

    // The counter must live in the database, not in either process.
    const client = new Client({ connectionString: pgUrl });
    await client.connect();
    const { rows } = await client.query<{ bucket_key: string; window_count: string }>(
      "select bucket_key, window_count from rate_limit_buckets order by window_count desc limit 1",
    );
    await client.end();
    record(
      "the counter is in PostgreSQL, shared by both processes",
      rows.length === 1 && Number(rows[0].window_count) >= WRITE_LIMIT,
      rows.length ? `busiest bucket: ${Number(rows[0].window_count)}` : "no bucket row",
    );
  } finally {
    await stop(a.child);
    await stop(b.child);
  }

  /* ---------------- the old local limiter, for contrast ----------------- */
  console.log("\n── in-memory limiter (the pre-P0-7 behaviour) ──────────────────────────");
  const c = boot(PORT_A, path.join(dir, "c.db"), "memory", pgUrl);
  const d = boot(PORT_B, path.join(dir, "d.db"), "memory", pgUrl);
  try {
    const bootedC = await waitForBoot(c.child, PORT_A);
    const bootedD = await waitForBoot(d.child, PORT_B);
    if (!bootedC || !bootedD) {
      record("two instances boot with the in-memory limiter", false, "one did not start");
      return 1;
    }
    const result = await flood();
    record(
      "with a per-process limiter the same flood gets more through — the defect",
      result.allowed > sharedAllowed,
      `${result.allowed} allowed locally vs ${sharedAllowed} shared (cap ${WRITE_LIMIT})`,
    );
    record(
      "and it exceeds the global cap, which is precisely what P0-7 fixes",
      result.allowed > WRITE_LIMIT,
      `${result.allowed} allowed against a global cap of ${WRITE_LIMIT}`,
    );
  } finally {
    await stop(c.child);
    await stop(d.child);
    rmSync(dir, { recursive: true, force: true });

    const passed = checks.filter((x) => x.ok).length;
    console.log(`\n${"=".repeat(78)}`);
    for (const f of checks.filter((x) => !x.ok)) console.log(`  ✗ ${f.name} — ${f.detail}`);
    console.log(`${passed}/${checks.length} checks passed`);
    console.log("=".repeat(78));
  }

  return checks.every((x) => x.ok) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
