/**
 * Shared rate-limit tests (P0-7).
 *
 * The behaviour under test is not "does the limiter count" — the previous in-process
 * limiter counted correctly. It is "does it count *once* for a deployment", which is
 * only observable with more than one limiter object over one store. Every
 * multi-instance test here builds two separate `PostgresQuotaStore` objects with
 * separate connection pools: that is what a second replica actually is from the
 * store's point of view, and it is why a single shared object would be a test that
 * proves nothing.
 *
 * Like `postgres.test.ts`, this file skips loudly when no PostgreSQL is reachable, so
 * a green run on a machine without one does not mean the shared path was exercised.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { MemoryQuotaStore, type QuotaStore } from "../rate-limit/store";
import { PostgresQuotaStore } from "../rate-limit/postgres-store";
import { MIGRATIONS, migratePostgres, RATE_LIMIT_TABLE } from "../migrations";

const BASE_URL = process.env.OATHRION_TEST_PG_URL ?? "postgres://user@localhost:55432/postgres";
const DB_NAME = `oathrion_rltest_${process.pid}_${Date.now().toString(36)}`;

function urlFor(database: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

let available = false;
let url = "";
const opened: QuotaStore[] = [];

/** Every store this file builds is registered so `afterAll` can close its pool. */
function track<T extends QuotaStore>(store: T): T {
  opened.push(store);
  return store;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: BASE_URL, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    await admin.query("SELECT 1");
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    url = urlFor(DB_NAME);
    await migratePostgres(url, MIGRATIONS);
    available = true;
  } catch (error) {
    console.warn(
      `\n[rate-limit-shared.test] SKIPPED: no PostgreSQL reachable ` +
        `(${error instanceof Error ? error.message : String(error)}).\n` +
        `           The shared rate-limit path was NOT exercised in this run.\n`,
    );
  } finally {
    await admin.end();
  }
}, 60_000);

afterEach(async () => {
  if (!available) return;
  /*
   * Cleared between tests through a throwaway store rather than by leaving state
   * behind: a limiter test that inherits another test's counters passes or fails for
   * the wrong reason.
   */
  const cleaner = new PostgresQuotaStore(url);
  try {
    await cleaner.reset();
  } finally {
    await cleaner.close();
  }
});

afterAll(async () => {
  for (const store of opened) await store.close();
  if (!available) return;
  const admin = new Pool({ connectionString: BASE_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}, 60_000);

const ready = () => available;

describe("shared quota store: single instance", () => {
  it("allows requests up to the configured limit", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url));
    for (let i = 1; i <= 5; i += 1) {
      const decision = await store.consume("k:normal", 5, 60_000);
      expect(decision.allowed, `request ${i}`).toBe(true);
      expect(decision.count).toBe(i);
    }
  });

  it("refuses the request past the limit and keeps refusing", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url));
    for (let i = 0; i < 3; i += 1) await store.consume("k:over", 3, 60_000);

    const first = await store.consume("k:over", 3, 60_000);
    expect(first.allowed).toBe(false);
    const second = await store.consume("k:over", 3, 60_000);
    expect(second.allowed).toBe(false);
    /*
     * The count saturates at max + 1 instead of climbing. A limiter whose counter grows
     * without bound under a flood is a memory (here, an integer) problem of its own, and
     * the caller only ever needs "over or not".
     */
    expect(second.count).toBe(4);
  });

  it("reports the same reset instant to every caller in the window", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url));
    const now = Date.now();
    const a = await store.consume("k:reset-stable", 5, 60_000, now);
    const b = await store.consume("k:reset-stable", 5, 60_000, now + 1_000);
    // The window is anchored on its first request, not slid forward by later ones —
    // otherwise a steady stream of traffic would keep the window open indefinitely and
    // `Retry-After` would be a lie.
    expect(b.resetAt).toBe(a.resetAt);
  });

  it("starts a fresh window once the old one expires", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url));
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) await store.consume("k:window", 3, 1_000, now);
    expect((await store.consume("k:window", 3, 1_000, now)).allowed).toBe(false);

    const after = await store.consume("k:window", 3, 1_000, now + 1_001);
    expect(after.allowed).toBe(true);
    expect(after.count).toBe(1);
    expect(after.resetAt).toBe(now + 1_001 + 1_000);
  });

  it("keeps different identities independent", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url));
    for (let i = 0; i < 3; i += 1) await store.consume("decision:usr_alice", 3, 60_000);
    expect((await store.consume("decision:usr_alice", 3, 60_000)).allowed).toBe(false);
    // Blocking Alice must not block Bob: a shared counter that is shared too widely is
    // a denial-of-service anyone can trigger for everyone else.
    expect((await store.consume("decision:usr_bob", 3, 60_000)).allowed).toBe(true);
    // Nor may a different scope for the same identity be affected.
    expect((await store.consume("write:usr_alice", 3, 60_000)).allowed).toBe(true);
  });

  it("honours a different limit and a different window on the same store", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url));
    for (let i = 0; i < 2; i += 1) expect((await store.consume("k:small", 2, 60_000)).allowed).toBe(true);
    expect((await store.consume("k:small", 2, 60_000)).allowed).toBe(false);

    const now = Date.now();
    const wide = await store.consume("k:wide", 100, 3_600_000, now);
    expect(wide.allowed).toBe(true);
    expect(wide.resetAt).toBe(now + 3_600_000);
  });

  it("never exceeds the limit under concurrent consumption of one key", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url));
    /*
     * Fifty simultaneous requests against a limit of ten. A read-modify-write limiter
     * lets far more than ten through here, because every one of the fifty reads the same
     * pre-increment value. Exactly ten must be allowed — not "about ten".
     */
    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.consume("k:race", 10, 60_000)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    // And the allowed ones must be numbered 1..10 with no duplicates: a duplicated count
     // is the signature of a lost update even when the total happens to come out right.
    expect(results.filter((r) => r.allowed).map((r) => r.count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  }, 30_000);
});

describe("shared quota store: several instances", () => {
  it("counts one budget for one identity across two instances", async () => {
    if (!ready()) return;
    const instanceA = track(new PostgresQuotaStore(url));
    const instanceB = track(new PostgresQuotaStore(url));

    // Six requests spread over two replicas against a limit of six.
    for (let i = 0; i < 3; i += 1) {
      expect((await instanceA.consume("decision:usr_shared", 6, 60_000)).allowed).toBe(true);
      expect((await instanceB.consume("decision:usr_shared", 6, 60_000)).allowed).toBe(true);
    }
    // The seventh is refused wherever it lands.
    expect((await instanceA.consume("decision:usr_shared", 6, 60_000)).allowed).toBe(false);
    expect((await instanceB.consume("decision:usr_shared", 6, 60_000)).allowed).toBe(false);
  }, 30_000);

  it("blocks the exact scenario from the brief: 499 on A plus 499 on B is not 998", async () => {
    if (!ready()) return;
    const instanceA = track(new PostgresQuotaStore(url));
    const instanceB = track(new PostgresQuotaStore(url));

    /*
     * The failure this lot exists to fix, written as a test. With a per-process limiter
     * and a global limit of 500, an attacker sends 499 to each replica and gets 998
     * through while both replicas report themselves as under the limit.
     */
    const perInstance = 499;
    const limit = 500;
    const key = "decision:usr_attacker";

    /*
     * 998 calls, issued interleaved A/B in bounded waves rather than as one
     * `Promise.all` over all 998.
     *
     * WHY BOUNDED. The single `Promise.all` version failed once in four full-suite runs
     * — and passed in isolation every time, including three consecutive clean suites
     * afterwards. Two stores of `max: 4` connections cannot serve 998 simultaneous
     * acquisitions, so every call beyond the eighth queues in `pg`'s pool; when the rest
     * of the suite is also holding PostgreSQL connections, one of those waits can exceed
     * its timeout, `consume` throws (the store fails closed rather than pretending to
     * allow — see `postgres-store.ts`), `Promise.all` rejects, and the test fails for a
     * reason that has nothing to do with the invariant it exists to prove. The root
     * cause was environmental, not a defect in the limiter: a waiting client is not an
     * over-budget client.
     *
     * WHAT IS NOT WEAKENED. Each wave is still genuinely concurrent and still alternates
     * instances, so two processes still race for the same counter — the condition the
     * old shared-nothing limiter lost. The assertions below are untouched: EXACTLY 500
     * allowed and EXACTLY 498 refused across both instances. A per-process limiter still
     * fails this test, waves or not.
     */
    const WAVE = 50;
    const outcomes: Awaited<ReturnType<typeof instanceA.consume>>[] = [];
    for (let sent = 0; sent < perInstance; sent += WAVE) {
      const size = Math.min(WAVE, perInstance - sent);
      const wave = Array.from({ length: size }, (_, i) =>
        // Alternating, so the two instances contend inside every wave.
        (i % 2 === 0 ? instanceA : instanceB).consume(key, limit, 60_000),
      ).concat(
        Array.from({ length: size }, (_, i) =>
          (i % 2 === 0 ? instanceB : instanceA).consume(key, limit, 60_000),
        ),
      );
      outcomes.push(...(await Promise.all(wave)));
    }
    expect(outcomes).toHaveLength(2 * perInstance);

    expect(outcomes.filter((o) => o.allowed)).toHaveLength(limit);
    expect(outcomes.filter((o) => !o.allowed)).toHaveLength(2 * perInstance - limit);
  }, 60_000);

  it("keeps two instances independent for two identities", async () => {
    if (!ready()) return;
    const instanceA = track(new PostgresQuotaStore(url));
    const instanceB = track(new PostgresQuotaStore(url));

    for (let i = 0; i < 4; i += 1) await instanceA.consume("decision:usr_noisy", 4, 60_000);
    expect((await instanceA.consume("decision:usr_noisy", 4, 60_000)).allowed).toBe(false);
    expect((await instanceB.consume("decision:usr_noisy", 4, 60_000)).allowed).toBe(false);
    // A quiet tenant is unaffected by a noisy one on either replica.
    expect((await instanceB.consume("decision:usr_quiet", 4, 60_000)).allowed).toBe(true);
    expect((await instanceA.consume("decision:usr_quiet", 4, 60_000)).allowed).toBe(true);
  }, 30_000);

  it("sees a reset performed by one instance from the other", async () => {
    if (!ready()) return;
    const instanceA = track(new PostgresQuotaStore(url));
    const instanceB = track(new PostgresQuotaStore(url));

    for (let i = 0; i < 2; i += 1) await instanceA.consume("k:cross-reset", 2, 60_000);
    expect((await instanceB.consume("k:cross-reset", 2, 60_000)).allowed).toBe(false);
    await instanceB.reset();
    expect((await instanceA.consume("k:cross-reset", 2, 60_000)).allowed).toBe(true);
  }, 30_000);

  it("survives concurrent consumption from both instances at once", async () => {
    if (!ready()) return;
    const instanceA = track(new PostgresQuotaStore(url));
    const instanceB = track(new PostgresQuotaStore(url));

    // Interleaved rather than sequential: the two replicas are genuinely contending for
    // the same row, which is where a non-atomic increment loses updates.
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 === 0 ? instanceA : instanceB).consume("k:both", 12, 60_000),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(12);
  }, 30_000);
});

describe("the old local limiter would have allowed this", () => {
  /*
   * The test the brief asked for: it must FAIL with the previous in-process limiter and
   * PASS with the shared one. `MemoryQuotaStore` *is* the previous limiter — the same
   * map, sweep and ceiling, moved behind the store interface — so instantiating two of
   * them is a faithful reproduction of two replicas each holding their own counters.
   *
   * Both halves are asserted in one test on purpose. A test that only checked the new
   * behaviour would still pass if the shared store quietly became per-process again,
   * as long as the assertion was loose; asserting the old failure mode in the same test
   * pins the difference itself.
   */
  const LIMIT = 10;
  const PER_INSTANCE = 8;
  const KEY = "decision:usr_two_replicas";

  const drive = async (a: QuotaStore, b: QuotaStore) => {
    const outcomes: boolean[] = [];
    for (let i = 0; i < PER_INSTANCE; i += 1) {
      outcomes.push((await a.consume(KEY, LIMIT, 60_000)).allowed);
      outcomes.push((await b.consume(KEY, LIMIT, 60_000)).allowed);
    }
    return outcomes.filter(Boolean).length;
  };

  it("lets 16 requests through a limit of 10 with two in-process limiters", async () => {
    const allowed = await drive(new MemoryQuotaStore(), new MemoryQuotaStore());
    // 8 per replica, each replica believing it is well under 10. This is the bug.
    expect(allowed).toBe(2 * PER_INSTANCE);
    expect(allowed).toBeGreaterThan(LIMIT);
  });

  it("lets exactly 10 through the same traffic with two shared-store limiters", async () => {
    if (!ready()) return;
    const allowed = await drive(
      track(new PostgresQuotaStore(url)),
      track(new PostgresQuotaStore(url)),
    );
    expect(allowed).toBe(LIMIT);
  }, 30_000);
});

describe("when the store is unavailable", () => {
  it("reports the failure instead of silently allowing the request", async () => {
    if (!ready()) return;
    /*
     * A pool pointed at a database that does not exist: a real connection failure, not a
     * thrown mock. `consume` must reject. What matters is what it does NOT do — return
     * `{allowed: true}`. A store failure that reads as "under the limit" turns any
     * limiter outage into a silent removal of every quota in the product, which is the
     * single worst outcome available here and the reason the middleware defaults to
     * refusing rather than allowing.
     */
    const broken = track(new PostgresQuotaStore(urlFor("oathrion_no_such_database")));
    await expect(broken.consume("k:down", 5, 60_000)).rejects.toThrow();
  }, 30_000);

  it("does not lose the counters it had once the store comes back", async () => {
    if (!ready()) return;
    const before = track(new PostgresQuotaStore(url));
    for (let i = 0; i < 3; i += 1) await before.consume("k:durable", 3, 60_000);

    // A replica restarting is a new store object against the same rows. With the old
    // in-process limiter a restart handed the caller a fresh budget, which made
    // "restart the process" a way to clear a block.
    const afterRestart = track(new PostgresQuotaStore(url));
    expect((await afterRestart.consume("k:durable", 3, 60_000)).allowed).toBe(false);
  }, 30_000);
});

describe("a busy store is not an unavailable store (e2e:instances anomaly)", () => {
  /*
   * Reproduces, deterministically and without machine load, the anomaly seen in
   * `npm run e2e:instances`: a burst on one bucket while PostgreSQL is slow. Every
   * consume on one key serialises on that key's row lock; while a pool connection waits
   * on the lock, the next request waits for a pool slot. pg-pool applies
   * `connectionTimeoutMillis` to that queue wait as well as to opening a connection,
   * so a 2 s connect timeout turned "waiting behind other limiter queries" into
   * "timeout exceeded when trying to connect" → 503, on a database that was up.
   */
  it("a request queued behind a slow one waits for it instead of failing", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url, { max: 1 }));
    await store.consume("k:busy", 100, 60_000); // creates the row
    const locker = new Pool({ connectionString: url, max: 1 });
    const client = await locker.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT 1 FROM rate_limit_buckets WHERE bucket_key = $1 FOR UPDATE`, ["k:busy"]);
      // First consume takes the only pool connection and blocks on the row lock;
      // the second waits for the pool slot. The lock is held past 2 s.
      // Rejections are captured as values so a failure is an assertion, not an
      // unhandled rejection.
      const first = store.consume("k:busy", 100, 60_000).catch((e: unknown) => e);
      const second = store.consume("k:busy", 100, 60_000).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 3_000));
      await client.query("COMMIT");
      const [a, b] = await Promise.all([first, second]);
      expect(a).not.toBeInstanceOf(Error);
      expect(b).not.toBeInstanceOf(Error);
      expect((a as { allowed: boolean }).allowed).toBe(true);
      expect((b as { allowed: boolean; count: number }).allowed).toBe(true);
      expect((b as { count: number }).count).toBe(3);
    } finally {
      client.release();
      await locker.end();
    }
  }, 30_000);

  it("an unreachable server is still reported within seconds, not after the queue wait", async () => {
    if (!ready()) return;
    // Nothing listens on port 1: the connection attempt itself must fail, fast.
    const down = track(new PostgresQuotaStore("postgres://placet:x@127.0.0.1:1/placet"));
    const started = Date.now();
    await expect(down.consume("k:down-fast", 5, 60_000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it("a server that never answers (black-holed address) is reported after the 2 s connect timeout, not the 10 s queue wait", async () => {
    if (!ready()) return;
    // 10.255.255.1 is non-routable: the SYN is dropped, so only the connect timer can
    // end the attempt (on a network that rejects it instantly, this still passes).
    const blackhole = track(new PostgresQuotaStore("postgres://placet:x@10.255.255.1:5432/placet"));
    const started = Date.now();
    await expect(blackhole.consume("k:down-blackhole", 5, 60_000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);
});

describe("the shared bucket table", () => {
  it("stores one row per key and expires it on sweep", async () => {
    if (!ready()) return;
    const store = track(new PostgresQuotaStore(url));
    const now = Date.now();
    await store.consume("k:sweep-a", 5, 1_000, now);
    await store.consume("k:sweep-b", 5, 600_000, now);

    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      const rows = await pool.query<{ bucket_key: string }>(
        `SELECT bucket_key FROM ${RATE_LIMIT_TABLE} ORDER BY bucket_key`,
      );
      expect(rows.rows.map((r) => r.bucket_key)).toEqual(["k:sweep-a", "k:sweep-b"]);

      await store.sweep(now + 2_000);
      const left = await pool.query<{ bucket_key: string }>(
        `SELECT bucket_key FROM ${RATE_LIMIT_TABLE}`,
      );
      // Only the expired window is removed; the live one is untouched. A sweep that
      // deleted live rows would hand out fresh budgets on a timer.
      expect(left.rows.map((r) => r.bucket_key)).toEqual(["k:sweep-b"]);
    } finally {
      await pool.end();
    }
  }, 30_000);
});
