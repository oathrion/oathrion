/**
 * §14 — secret redaction for log lines.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * This lived in `server/index.ts`, which is the process entrypoint: importing it opens
 * the SQLite handle and starts listening. So the one piece of code standing between a
 * password and the log file could not be imported by a test, and the mutation audit
 * confirmed the consequence — replacing the whole redaction branch with `false` left
 * every one of 610 tests green. §14 ("never log passwords, API keys, session secrets,
 * tokens, webhook secrets") had no barrier at all; it held only because nobody had
 * touched the code.
 *
 * Moving it here changes no behaviour: `index.ts` imports these and its own logging path
 * is unchanged. It just makes the requirement testable.
 */

/** Field names that must never reach a log line or a log aggregator. */
export const SECRET_FIELDS: ReadonlySet<string> = new Set([
  "token",
  "password",
  "apikey",
  "secret",
  "authorization",
  "cookie",
  "credential",
  "passphrase",
]);

/** Maximum object depth walked while redacting; deeper values are dropped. */
export const REDACT_MAX_DEPTH = 6;

/** The marker written in place of a secret. Asserted by tests, so it is a constant. */
export const REDACTED = "[redacted]";

/**
 * Recursively redacts secrets anywhere in the payload — not just at the top level.
 * A nested `{ identity: { token } }` used to be logged verbatim. Cycles are tolerated,
 * and the walk is depth-capped so a pathological structure cannot turn a log line into
 * a stack overflow.
 *
 * Matching normalises the key — lower-cased with separators removed — and then accepts
 * either an exact match or a *suffix* match against the listed names.
 *
 * The suffix rule was added after a test showed the exact-match version missing the two
 * things §14 of the brief names explicitly: `sessionSecret` and `webhookSecret` both
 * normalise to something that is not in the set, so both were logged verbatim. `api_key`
 * and `x-api-key` were missed for the same reason, and the old comment here claimed
 * they were covered when they were not.
 *
 * A suffix rule rather than a substring rule, because over-redaction is its own
 * failure: `tokenCount`, `secretSantaId` and `passwordUpdatedAt` must survive, and a
 * substring rule would redact all three. The last word of a field name is what says
 * whether the field holds a secret or merely refers to one.
 */
function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_FIELDS.has(normalised)) return true;
  for (const marker of SECRET_FIELDS) {
    if (normalised.length > marker.length && normalised.endsWith(marker)) return true;
  }
  return false;
}

/**
 * Recursively redacts secrets anywhere in the payload — not just at the top level.
 * A nested `{ identity: { token } }` used to be logged verbatim. Cycles are tolerated,
 * and the walk is depth-capped so a pathological structure cannot turn a log line into
 * a stack overflow. Key matching is delegated to `isSecretKey` above.
 */
export function redactSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= REDACT_MAX_DEPTH) return "[truncated]";
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSecretKey(key)
      ? REDACTED
      : redactSecrets(child, depth + 1, seen);
  }
  return redacted;
}

/** Redacts secrets at any depth, then truncates so a log line stays a log line. */
export function safeBody(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  let json: string;
  try {
    json = JSON.stringify(redactSecrets(body)) ?? "";
  } catch {
    // A getter that throws, or a BigInt, must never take down a request.
    return "[unserialisable]";
  }
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}
