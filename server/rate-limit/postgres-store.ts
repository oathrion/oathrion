/**
 * PostgreSQL-backed shared quota store (P0-7).
 *
 * Every instance of the server points at the same table, so one policy is enforced
 * across all of them: the 499 + 499 scenario that passes 998 requests through a
 * limit of 500 cannot happen, because there is one counter, not one per process.
 */

import { Client, Pool, type ClientConfig } from "pg";
import { guardPoolClients } from "../sql/pg-client-guard";
import { RATE_LIMIT_TABLE } from "../migrations/006-rate-limit";
import type { QuotaDecision, QuotaStore } from "./store";

/**
 * The entire operation, in one statement.
 *
 * This is the part that has to be right, so it is worth reading closely.
 *
 * A limiter implemented as SELECT the counter, add one, UPDATE it has a window
 * between the read and the write in which another request — on this instance or any
 * other — reads the same value. Both then believe they saw the last remaining unit
 * of quota and both are allowed. The limit is exceeded precisely under the
 * concurrency it exists to control, which is the failure mode that makes a
 * distributed limiter theatre. No amount of application-level care closes that
 * window; only the database can.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` is a single statement. PostgreSQL takes a row
 * lock for the duration of the upsert, so two concurrent executions are serialised
 * on that row: the second one sees the first one's increment, not the value the
 * first one started from. `RETURNING` hands back the post-increment state, so the
 * decision is made from the same atomic step that produced it and there is no
 * second round trip to be raced.
 *
 * The three branches of the CASE:
 *
 *   1. the stored window has passed  -> count 1, new expiry. The reset is part of
 *      the same atomic step, so two requests arriving at the instant a window ends
 *      cannot both reset it and both start at 1.
 *   2. already at or over the maximum -> count unchanged... except it is set to
 *      `max + 1`, which saturates. Without the clamp a client hammering a closed
 *      window would drive the integer up indefinitely; with it, the column's range
 *      is bounded by configuration, which is why `integer` is a safe type in the
 *      migration rather than an optimistic one.
 *   3. otherwise -> increment.
 *
 * `allowed` is then simply `count <= max`, which is unambiguous *because* of the
 * clamp: in the rejecting branch the count is strictly greater than the maximum.
 * Returning the count unchanged would make `count = max` mean both "the request
 * that reached the limit" (allow) and "a request after it" (refuse).
 *
 * Timestamps are compared against a parameter, not `now()`. Two reasons, and the
 * second is the one that matters: it makes window expiry testable without sleeping,
 * and it keeps the clock in one place. Mixing an application clock (used to compute
 * `reset_at`) with the database clock (used to compare it) means a skew between an
 * instance and the database silently shifts window boundaries. One clock, passed
 * explicitly.
 */
const CONSUME_SQL = `
  INSERT INTO ${RATE_LIMIT_TABLE} (bucket_key, window_count, reset_at)
       VALUES ($1, 1, $2)
  ON CONFLICT (bucket_key) DO UPDATE
     SET window_count = CASE
           WHEN ${RATE_LIMIT_TABLE}.reset_at <= $3 THEN 1
           WHEN ${RATE_LIMIT_TABLE}.window_count >= $4 THEN $4 + 1
           ELSE ${RATE_LIMIT_TABLE}.window_count + 1
         END,
         reset_at = CASE
           WHEN ${RATE_LIMIT_TABLE}.reset_at <= $3 THEN $2
           ELSE ${RATE_LIMIT_TABLE}.reset_at
         END
    RETURNING window_count, reset_at`;

interface ConsumeRow {
  window_count: number | string;
  reset_at: Date;
}

/** Opening a connection to the limiter's PostgreSQL gives up after this long. */
export const RATE_LIMIT_CONNECT_TIMEOUT_MS = 2_000;

/**
 * A `pg` client whose own connect timeout is fixed at RATE_LIMIT_CONNECT_TIMEOUT_MS,
 * independently of the pool's queue wait (see the constructor below).
 */
class ConnectTimeoutClient extends Client {
  constructor(config?: ClientConfig) {
    super({ ...config, connectionTimeoutMillis: RATE_LIMIT_CONNECT_TIMEOUT_MS });
  }
}

export class PostgresQuotaStore implements QuotaStore {
  readonly kind = "postgres" as const;

  private readonly pool: Pool;
  private lastSweep = 0;

  /*
   * Expired rows are deleted at most once per interval, on the request that notices
   * the interval has passed. A background timer was the alternative and was
   * rejected: it keeps the event loop alive (so the process no longer exits on
   * SIGTERM without extra teardown) and every instance would run its own sweep of
   * the same rows. Lazily, on one request, is enough for rows whose only cost is
   * disk.
   *
   * The sweep is fire-and-forget precisely because it must never make a request
   * fail: a failed cleanup is a slightly larger table, and turning that into a 503
   * for the caller would be a self-inflicted outage.
   */
  private static readonly SWEEP_INTERVAL_MS = 60_000;
  /** Longest a request waits for a busy pool connection before the fail mode applies. */
  static readonly QUEUE_WAIT_MS = 10_000;

  constructor(connectionString: string, options: { max?: number } = {}) {
    /*
     * A small pool, sized for what this store does: one short statement per guarded
     * request. `connectionTimeoutMillis` is the important one — without it, a
     * PostgreSQL server that is unreachable rather than refusing leaves every
     * request waiting on a connection that will never arrive, so an unavailable
     * limiter store becomes an unavailable API. With it, the failure surfaces in two
     * seconds and the configured fail mode decides what to do about it.
     */
    this.pool = new Pool({
      connectionString,
      max: options.max ?? 4,
      /*
       * Two different waits, deliberately given two different bounds.
       *
       * pg-pool uses `connectionTimeoutMillis` for BOTH: opening a new connection and
       * waiting in the pool's queue for a busy one. With a single 2 s value, a burst on
       * one bucket (every consume serialises on that row's lock) on a slow but healthy
       * database made queued requests fail with "timeout exceeded when trying to
       * connect" — a 503 "could not be rate-limited" on a database that was up. Found
       * by `npm run e2e:instances` under load; reproduced by rate-limit-shared.test.ts.
       *
       *   opening a connection → 2 s, set on the client below: an unreachable
       *                          PostgreSQL is still reported in 2 s, as before;
       *   waiting for a slot   → QUEUE_WAIT_MS: being behind other limiter queries
       *                          is contention, not an outage. Still bounded, so a
       *                          wedged store still ends in the fail mode, not a hang.
       */
      connectionTimeoutMillis: PostgresQuotaStore.QUEUE_WAIT_MS,
      Client: ConnectTimeoutClient,
      idleTimeoutMillis: 30_000,
    });

    /*
     * A pool emits 'error' for a connection that dies while idle. Unhandled, that
     * event is an uncaught exception that takes the process down — an idle
     * PostgreSQL connection dropped by a network device would crash the API server
     * because of the rate limiter. Logged and swallowed; the pool replaces the
     * connection itself.
     */
    this.pool.on("error", (error) => {
      console.error("[rate-limit] idle PostgreSQL connection error:", error.message);
    });
    guardPoolClients(this.pool, "rate-limit");
  }

  async consume(key: string, max: number, windowMs: number, now: number = Date.now()): Promise<QuotaDecision> {
    const nowDate = new Date(now);
    const resetDate = new Date(now + windowMs);

    const result = await this.pool.query<ConsumeRow>(CONSUME_SQL, [key, resetDate, nowDate, max]);
    const row = result.rows[0];
    if (row === undefined) {
      /*
       * An upsert with RETURNING always returns its row. Reaching here means the
       * statement did something other than what it says, so the caller is told the
       * store failed rather than being handed a fabricated decision — the fail mode
       * then applies. Guessing "allowed" here would be a silent bypass produced by
       * an impossible branch, which is the worst kind.
       */
      throw new Error("the rate-limit upsert returned no row");
    }

    void this.maybeSweep(now);

    const count = Number(row.window_count);
    return { allowed: count <= max, count, resetAt: row.reset_at.getTime() };
  }

  /**
   * A plain point read on the primary key. No lock, no write, so it costs a single
   * index lookup — which matters because it runs on every sign-in attempt, including
   * the ones that succeed.
   *
   * An expired stored window reads as an empty one rather than being deleted here:
   * a read path that writes turns every sign-in into a write, and the sweep already
   * removes the row.
   */
  async peek(key: string, max: number, now: number = Date.now()): Promise<QuotaDecision> {
    const result = await this.pool.query<ConsumeRow>(
      `SELECT window_count, reset_at FROM ${RATE_LIMIT_TABLE} WHERE bucket_key = $1`,
      [key],
    );
    const row = result.rows[0];
    if (row === undefined) return { allowed: true, count: 0, resetAt: now };

    const resetAt = row.reset_at.getTime();
    if (resetAt <= now) return { allowed: true, count: 0, resetAt: now };

    const count = Number(row.window_count);
    return { allowed: count < max, count, resetAt };
  }

  /**
   * Deletes every window that has already expired.
   *
   * Public and unthrottled, unlike `maybeSweep`, for two callers: a test that needs to
   * observe the deletion happening rather than wait for a fifteen-minute interval, and
   * an operator running maintenance by hand. Expired rows are harmless to read — a
   * stale window reads as an empty one — so this is housekeeping, not correctness.
   */
  async sweep(now: number = Date.now()): Promise<number> {
    const result = await this.pool.query(`DELETE FROM ${RATE_LIMIT_TABLE} WHERE reset_at < $1`, [
      new Date(now),
    ]);
    this.lastSweep = now;
    return result.rowCount ?? 0;
  }

  private async maybeSweep(now: number): Promise<void> {
    if (now - this.lastSweep < PostgresQuotaStore.SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    try {
      await this.sweep(now);
    } catch (error) {
      console.error(
        "[rate-limit] could not sweep expired buckets:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Truncates the table. Used by tests and by an operator clearing a stuck window. */
  async reset(): Promise<void> {
    await this.pool.query(`DELETE FROM ${RATE_LIMIT_TABLE}`);
    this.lastSweep = 0;
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch (error) {
      // Shutdown must not be blocked by a pool that will not close.
      console.error("[rate-limit] error while closing the PostgreSQL pool:", error);
    }
  }
}
