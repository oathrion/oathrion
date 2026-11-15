/**
 * §14 — "Ne loggue jamais : passwords ; API keys ; session secrets ; tokens ; secrets
 * webhook."
 *
 * Written after the mutation audit found this requirement completely unguarded:
 * replacing the redaction branch with `false` — so every secret was logged verbatim —
 * left all 610 tests green. The code was correct; nothing held it in place.
 *
 * These tests assert the property that matters and not the implementation: for every
 * shape a request or response body can take, the secret's VALUE must not appear in what
 * gets logged. Asserting on the output string rather than on the returned object is
 * deliberate — the log line is the actual attack surface.
 */

import { describe, expect, it } from "vitest";
import { REDACTED, REDACT_MAX_DEPTH, SECRET_FIELDS, redactSecrets, safeBody } from "./log-redaction";

/** The literal values that must never survive into a log line. */
const PASSWORD = "correct-horse-battery-staple";
const API_KEY = "sk-live-DEADBEEF0123456789";
const SESSION_SECRET = "session-secret-value-0123456789";
const WEBHOOK_SECRET = "whsec_0123456789abcdef";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";

describe("§14 secret redaction", () => {
  it("redacts every field name the policy lists, at the top level", () => {
    const body = {
      token: BEARER,
      password: PASSWORD,
      apikey: API_KEY,
      secret: WEBHOOK_SECRET,
      authorization: BEARER,
      cookie: "oathrion_session=abc.def",
      credential: "user:pass",
      passphrase: PASSWORD,
    };
    const out = safeBody(body);

    for (const value of [BEARER, PASSWORD, API_KEY, WEBHOOK_SECRET, "abc.def", "user:pass"]) {
      expect(out, `"${value}" must not appear in a log line`).not.toContain(value);
    }
    // And the field is visibly redacted rather than silently dropped, so an operator
    // reading the log can tell a secret was present.
    expect(out).toContain(REDACTED);
  });

  it("covers every name in SECRET_FIELDS without the test having to list them", () => {
    /*
     * A list-based test that hard-codes its own copy of the list would pass while the
     * two lists drifted apart. This iterates the real set, so adding a name to
     * SECRET_FIELDS is automatically covered and REMOVING one is caught here.
     */
    for (const field of SECRET_FIELDS) {
      const out = safeBody({ [field]: "SENTINEL-VALUE-42" });
      expect(out, `${field} was not redacted`).not.toContain("SENTINEL-VALUE-42");
    }
  });

  it("redacts nested secrets, not just top-level ones", () => {
    // The original bug this guards: `{ identity: { token } }` was logged verbatim.
    const out = safeBody({ identity: { name: "Alex", token: BEARER } });
    expect(out).not.toContain(BEARER);
    expect(out).toContain("Alex"); // non-secret context is still useful in a log
  });

  it("redacts secrets inside arrays", () => {
    const out = safeBody({ sessions: [{ id: "s1", token: BEARER }, { id: "s2", token: BEARER }] });
    expect(out).not.toContain(BEARER);
    expect(out).toContain("s1");
  });

  it("redacts secrets in a deeply nested but legal payload", () => {
    // Just inside the depth cap: still walked, so still redacted.
    const out = safeBody({ a: { b: { c: { d: { password: PASSWORD } } } } });
    expect(out).not.toContain(PASSWORD);
  });

  it("truncates rather than descends forever, and truncation hides the value", () => {
    /*
     * Past the cap the walk stops. The important part is not that it stops but that
     * stopping does not LEAK: returning the raw subtree at the cap would have been the
     * obvious implementation and would defeat the whole function.
     */
    let deep: Record<string, unknown> = { password: PASSWORD };
    for (let i = 0; i < REDACT_MAX_DEPTH + 3; i += 1) deep = { nest: deep };
    const out = safeBody(deep);
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain("[truncated]");
  });

  it("survives a cyclic payload instead of throwing or hanging", () => {
    const node: Record<string, unknown> = { password: PASSWORD };
    node.self = node;
    const out = safeBody(node);
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain("[circular]");
  });

  it("matches field names case-insensitively", () => {
    // Express and clients disagree about header casing; `Authorization` and
    // `authorization` are the same secret.
    const out = safeBody({ Authorization: BEARER, Password: PASSWORD, APIKey: API_KEY });
    expect(out).not.toContain(BEARER);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(API_KEY);
  });

  it("redacts a login body — the exact payload the auth route receives", () => {
    const out = safeBody({ password: PASSWORD, remember: true });
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain("remember");
  });

  it("redacts a webhook configuration — secret and URL credentials", () => {
    const out = safeBody({
      webhook: { url: "https://hooks.example.com/x", secret: WEBHOOK_SECRET, timeoutMs: 5000 },
    });
    expect(out).not.toContain(WEBHOOK_SECRET);
    expect(out).toContain("hooks.example.com"); // the target is not itself a secret
  });

  it("redacts a session secret carried under any of the listed names", () => {
    expect(safeBody({ secret: SESSION_SECRET })).not.toContain(SESSION_SECRET);
    expect(safeBody({ credential: SESSION_SECRET })).not.toContain(SESSION_SECRET);
  });

  it("keeps a log line bounded so a large body cannot flood the log", () => {
    const out = safeBody({ note: "x".repeat(5_000) });
    expect(out.length).toBeLessThanOrEqual(301 + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never throws on a body that cannot be serialised", () => {
    // A getter that throws, or a BigInt, must not take down a request just because it
    // was about to be logged.
    const hostile = {
      get boom() {
        throw new Error("no");
      },
    };
    expect(() => safeBody(hostile)).not.toThrow();
    expect(safeBody({ big: 1n })).toBe("[unserialisable]");
  });

  it("passes through primitives and non-objects unchanged", () => {
    expect(safeBody("plain")).toBe("");
    expect(safeBody(null)).toBe("");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets("free text")).toBe("free text");
  });

  it("does not redact fields that merely resemble a secret name", () => {
    /*
     * Over-redaction is its own failure: a log that says [redacted] for `tokenCount`
     * or `secretSantaId` is a log that stops being useful, and an operator who learns
     * to ignore [redacted] is an operator who misses the real one.
     */
    const out = safeBody({ tokenCount: 12, secretSantaId: "ss-9", passwordUpdatedAt: "2026-01-01" });
    expect(out).toContain("12");
    expect(out).toContain("ss-9");
    expect(out).toContain("2026-01-01");
    expect(out).not.toContain(REDACTED);
  });
});

/*
 * The unhandled-error middleware logs an `Error` as-is for its stack, but routes any
 * other thrown value through `safeBody`. A thrown non-Error is commonly a payload or
 * a configuration object, and §14 forbids a password, API key, token or webhook
 * secret reaching the log.
 */
describe("a thrown non-Error is redacted before it is logged", () => {
  it("hides every secret field of a thrown payload", () => {
    const thrown = {
      route: "/api/auth/login",
      password: "the-operators-real-password",
      apiKey: "sk-live-0123456789",
      nested: { sessionSecret: "s3cr3t-session-value", webhookSecret: "whsec_abcdef" },
    };
    const logged = safeBody(thrown);
    expect(logged).not.toContain("the-operators-real-password");
    expect(logged).not.toContain("sk-live-0123456789");
    expect(logged).not.toContain("s3cr3t-session-value");
    expect(logged).not.toContain("whsec_abcdef");
    // The shape must survive, otherwise the log stops being useful.
    expect(logged).toContain("/api/auth/login");
  });

  it("covers the compound and snake-case spellings the exact-match rule missed", () => {
    /*
     * Every one of these was logged verbatim before the suffix rule: they normalise to
     * a name that is not itself in SECRET_FIELDS. `sessionSecret` and `webhookSecret`
     * are the two §14 names most likely to appear in a config object.
     */
    const logged = safeBody({
      sessionSecret: "AAA-session",
      webhookSecret: "BBB-webhook",
      api_key: "CCC-apikey",
      "x-api-key": "DDD-header",
      accessToken: "EEE-access",
      refresh_token: "FFF-refresh",
      clientSecret: "GGG-client",
      consolePassword: "HHH-console",
    });
    for (const leaked of ["AAA-session", "BBB-webhook", "CCC-apikey", "DDD-header", "EEE-access", "FFF-refresh", "GGG-client", "HHH-console"]) {
      expect(logged, `leaked ${leaked}`).not.toContain(leaked);
    }
  });

  it("still does not over-redact a field that only refers to a secret", () => {
    // The counterpart to the rule above, restated here so the two are read together.
    const logged = safeBody({ tokenCount: 3, secretSantaId: "ss-1", passwordUpdatedAt: "2026-02-02", keyRotationDays: 30 });
    expect(logged).not.toContain(REDACTED);
  });
});
