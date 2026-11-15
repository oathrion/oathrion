/**
 * Migration 6 — the shared rate-limit bucket store (P0-7).
 *
 * ## Why this table exists
 *
 * The request limiter and the login throttle both kept their counters in a
 * `Map` in the process. That is correct for exactly one instance. Behind two,
 * each process enforces the limit against its own counter, so a limit of 500
 * becomes 500 per instance: two instances at 499 requests each pass 998 requests
 * while both believe they are under the limit, and an attacker only has to open
 * new connections until the load balancer gives them a different one. A limit
 * that a second replica silently doubles is not a limit; it is a number in a log.
 *
 * ## Why PostgreSQL and not Redis
 *
 * Redis is the reflex answer and it is the wrong one here. It would be a second
 * piece of stateful infrastructure to run, secure, back up, monitor and pay for,
 * introduced for one counter. PostgreSQL is already the target production backend
 * (P0-4), and a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is atomic
 * — one round trip, one row locked, no read-modify-write window. At the volume a
 * control plane for agent decisions handles (hundreds of requests per minute per
 * credential, not hundreds of thousands per second), one indexed upsert per
 * guarded request is not the bottleneck; the tool calls being governed are orders
 * of magnitude slower.
 *
 * The point at which this stops being true is written down rather than left to be
 * discovered: sustained tens of thousands of limiter operations per second, or a
 * limiter latency budget under a millisecond. Neither is this product.
 *
 * ## Why this is PostgreSQL-only DDL
 *
 * A "shared" store on SQLite would share nothing: the SQLite deployment is a
 * single process holding a local file, and two instances pointing at the same file
 * over a network filesystem is a documented way to corrupt SQLite, not a way to
 * scale. On the SQLite driver the limiter therefore keeps the in-memory store,
 * which is honest for a single-process deployment, and no unused table is created
 * to suggest otherwise.
 *
 * The version is still recorded in the ledger on both engines, with zero
 * statements on SQLite, so the two histories stay the same length and a future
 * migration 7 means the same thing on both.
 */

import type { Migration, SchemaInspect } from "./types";

export const RATE_LIMIT_TABLE = "rate_limit_buckets";

export const rateLimitBuckets: Migration = {
  version: 6,
  name: "rate-limit-buckets",
  statements(schema: SchemaInspect): string[] {
    if (schema.dialect === "sqlite") return [];

    return [
      /*
       * `bucket_key` is the whole primary key and the whole access path. Every
       * operation is a point lookup on it, so the primary-key index is the only
       * index the hot path needs and no second one is created — an extra index here
       * would cost a write on every single guarded request.
       *
       * The key is composed by the application (`scope:subject`), not by the schema,
       * so a new limiter dimension needs no migration. That is deliberate: the
       * dimensions the product limits on are a policy decision, and freezing them
       * into the primary key would mean a schema change to add one.
       *
       * `window_count integer`, not bigint: it is bounded by the configured maximum
       * plus one (the store saturates it), so it cannot grow, and the saturation is
       * what makes a small type safe rather than optimistic.
       *
       * `reset_at timestamptz` so the comparison is the engine's, and so two
       * instances in different local zones cannot disagree about when a window ends
       * — which a naive `timestamp` would allow.
       */
      `CREATE TABLE IF NOT EXISTS ${RATE_LIMIT_TABLE} (
        bucket_key text NOT NULL,
        window_count integer NOT NULL,
        reset_at timestamptz NOT NULL,
        CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (bucket_key)
      )`,

      /*
       * Expired rows are swept by the store, but a sweep needs to find them without
       * reading every bucket in the deployment. This is the one secondary index, and
       * it serves exactly one statement (`DELETE ... WHERE reset_at < now()`).
       *
       * It is worth its write cost because the alternative is a full scan of a table
       * whose row count grows with the number of distinct callers ever seen — which
       * is unbounded, since the limiter's IP fallback lets an unauthenticated caller
       * mint new keys.
       */
      `CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON ${RATE_LIMIT_TABLE} (reset_at)`,
    ];
  },
};
