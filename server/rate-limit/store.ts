/**
 * Quota stores for the shared rate limiter (P0-7).
 *
 * ## One abstraction, two consumers
 *
 * The request limiter (`rateLimit()`) and the login throttle in `auth.ts` were two
 * separate `Map`s with two separate sweeps and two separate ceilings, doing the
 * same thing: count events against a key inside a fixed window and answer whether
 * the count is over a maximum. They are unified here — not for tidiness, but
 * because a shared store has to be implemented, tested and made fail-safe once.
 * Two implementations of a distributed counter is two chances to get atomicity
 * wrong.
 *
 * ## The contract
 *
 * `consume` is a single atomic operation: it increments and reports the decision
 * in one indivisible step. There is deliberately no `get`-then-`set` pair on this
 * interface, so no caller can construct the read-modify-write race that makes a
 * distributed limiter fail exactly when it matters — under concurrency.
 *
 * ## Window semantics: unchanged from the in-memory limiter
 *
 * Fixed window, not sliding. First event in a window sets the count to 1 and the
 * expiry to `now + windowMs`; the window is not extended by later events; when it
 * passes, the next event starts a fresh one. This is what the product does today
 * and it is preserved exactly, because silently changing a limiter's window
 * changes when customers get 429s.
 *
 * One observable difference, stated rather than buried: the old limiter did not
 * increment on a rejected request, this one does (saturating at `max + 1`). With a
 * fixed window the decision is identical — once the count reaches the maximum it
 * stays there for the rest of the window either way — and the saturating increment
 * is what lets the whole operation be one statement. Counting the rejection also
 * makes the counter mean "events seen", which is what an operator reading it
 * expects.
 */

export interface QuotaDecision {
  /** False means the caller is over the limit and must be refused. */
  allowed: boolean;
  /** Events counted in the current window, saturating at `max + 1`. */
  count: number;
  /** Epoch milliseconds at which the current window ends. */
  resetAt: number;
}

export interface QuotaStore {
  /** The name reported by `/api/health`-style diagnostics and by boot logging. */
  readonly kind: "memory" | "postgres";
  /**
   * Atomically counts one event against `key` and reports whether it is allowed.
   *
   * @param max      events permitted per window. A `max` of 0 refuses everything.
   * @param windowMs window length in milliseconds.
   * @param now      injectable clock in epoch milliseconds, so window expiry is
   *                 testable without sleeping. The PostgreSQL store passes it to
   *                 the server rather than using `now()` there — see below.
   */
  consume(key: string, max: number, windowMs: number, now?: number): Promise<QuotaDecision>;
  /**
   * Reports the current state of `key` without counting an event.
   *
   * Exists for one caller: the login throttle, which counts only *failed* attempts
   * and therefore has to ask "is this address already locked out?" before it knows
   * whether this attempt will fail. Nothing else uses it, and nothing else should:
   * a `peek` followed by a `consume` of the value just read is the read-modify-write
   * race `consume` exists to avoid.
   *
   * Stated plainly, because it is a real and pre-existing limitation rather than a
   * property of the shared store: the login *gate* is a read, so N requests arriving
   * together can all pass it before any of them records a failure. The bound is the
   * concurrency of the burst, not the length of the window — every one of those
   * attempts still increments the atomic counter, so the window closes and stays
   * closed. This is exactly how the in-process throttle behaved before P0-7; making
   * the gate itself consuming would count successful sign-ins and lock out a whole
   * office sharing one address, which buys nothing against someone who already knows
   * the password.
   */
  peek(key: string, max: number, now?: number): Promise<QuotaDecision>;
  /** Test and maintenance seam: forgets every bucket. */
  reset(): Promise<void>;
  /** Releases any connection the store holds. Never throws. */
  close(): Promise<void>;
}

/* ------------------------------- in memory -------------------------------- */

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Process-local store. Correct for a single instance, and the default.
 *
 * This is the previous limiter's data structure, sweep and ceiling, moved behind
 * the interface rather than rewritten: it is not the thing that was broken, and a
 * single-process deployment gets identical behaviour to before with no new
 * infrastructure to run.
 *
 * Its limitation is the whole reason P0-7 exists, and it is a property of the
 * store, not a bug in it: two instances each hold their own map, so each enforces
 * the limit independently. `server/test/rate-limit-shared.test.ts` asserts that
 * failure explicitly against this class, so the reason the PostgreSQL store exists
 * is demonstrated rather than asserted in a comment.
 */
export class MemoryQuotaStore implements QuotaStore {
  readonly kind = "memory" as const;

  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  /*
   * Bounded memory. Every distinct caller creates a bucket and the limiter's IP
   * fallback makes the key space effectively unbounded, so expired buckets are
   * swept lazily — at most once per interval, keeping the common path O(1) — and a
   * hard ceiling drops the oldest-resetting entries, which are the ones already
   * useless.
   */
  private static readonly SWEEP_INTERVAL_MS = 60_000;
  private static readonly MAX_BUCKETS = 10_000;

  private sweep(now: number): void {
    if (now - this.lastSweep < MemoryQuotaStore.SWEEP_INTERVAL_MS && this.buckets.size < MemoryQuotaStore.MAX_BUCKETS) {
      return;
    }
    this.lastSweep = now;

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt < now) this.buckets.delete(key);
    }

    if (this.buckets.size > MemoryQuotaStore.MAX_BUCKETS) {
      const oldestFirst = [...this.buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [key] of oldestFirst.slice(0, this.buckets.size - MemoryQuotaStore.MAX_BUCKETS)) {
        this.buckets.delete(key);
      }
    }
  }

  /*
   * Synchronous work behind an async signature. Node runs this to completion
   * without yielding, so the increment is atomic with respect to other requests on
   * this instance — single-threaded execution is what makes the in-memory case
   * safe, and it is exactly the guarantee that stops applying once there are two
   * processes.
   */
  consume(key: string, max: number, windowMs: number, now: number = Date.now()): Promise<QuotaDecision> {
    this.sweep(now);
    const existing = this.buckets.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      const bucket = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
      return Promise.resolve({ allowed: max >= 1, count: 1, resetAt: bucket.resetAt });
    }

    existing.count = Math.min(existing.count + 1, max + 1);
    return Promise.resolve({
      allowed: existing.count <= max,
      count: existing.count,
      resetAt: existing.resetAt,
    });
  }

  peek(key: string, max: number, now: number = Date.now()): Promise<QuotaDecision> {
    const existing = this.buckets.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      return Promise.resolve({ allowed: true, count: 0, resetAt: now });
    }
    return Promise.resolve({
      allowed: existing.count < max,
      count: existing.count,
      resetAt: existing.resetAt,
    });
  }

  reset(): Promise<void> {
    this.buckets.clear();
    this.lastSweep = 0;
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
