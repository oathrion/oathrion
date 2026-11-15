/**
 * Mutation audit — proves the test suite actually enforces what it claims to.
 *
 * WHY THIS EXISTS
 * ---------------
 * "603 tests pass" is not evidence. A suite can be green because the code is correct
 * OR because the tests never look at the thing that matters, and from the outside the
 * two are indistinguishable. §23 asks for a SECURITY AUDIT that passes, and a green
 * suite over vacuous assertions would let a real regression ship while the gate stayed
 * green.
 *
 * So each mutation below deliberately BREAKS one safety invariant — an off-by-one on a
 * spending ceiling, an accepted revoked session, a disabled RBAC check — and the suite
 * is re-run. A mutation that leaves the suite green is a hole: that invariant is
 * currently unguarded, whatever the code happens to say today. A mutation that turns it
 * red names the test that guards it.
 *
 * Every mutation targets a barrier that was FIXED during this engagement, plus the
 * pre-existing barriers that guard money movement, identity and authorisation.
 *
 * The mutations are applied to the real source files, one at a time, and the original
 * is restored afterwards.
 *
 * SAFETY — WHY THERE IS A MANIFEST ON DISK
 * ---------------------------------------
 * An earlier version of this script kept the originals in memory only, restored them in
 * a `finally` and on SIGINT, and re-read the files at the end to confirm. That is not
 * enough. This script was killed mid-run by a harness timeout — SIGKILL, which no
 * handler can intercept — and it left `amount > maxTransactionAmount + 1` in
 * shared/policy/mandate.ts: a live spending-ceiling bypass sitting in the working tree,
 * with the in-memory original gone along with the process. A cursory grep for the
 * mutation text missed it because the grep pattern did not match the real source line,
 * and the next full test run went red in a way that looked like flaky tests rather than
 * like sabotage.
 *
 * So the pristine bytes are now written to a MANIFEST FILE (`.mutation-backup/`) BEFORE
 * the first mutation is applied, and every subsequent run starts by checking it:
 *
 *   - if the manifest exists and any tracked file differs from it, the script refuses to
 *     run and offers `--restore`, because it cannot tell a leftover mutation from a
 *     legitimate edit and must not overwrite either silently;
 *   - `npx tsx script/mutation-audit.ts --restore` puts every tracked file back and
 *     clears the manifest.
 *
 * The manifest survives SIGKILL, which the in-memory copy did not. Recovery no longer
 * depends on this process staying alive.
 *
 * Usage:
 *   npx tsx script/mutation-audit.ts            # every mutation
 *   npx tsx script/mutation-audit.ts ceiling    # only ids containing "ceiling"
 *
 * This script is a diagnostic and is NOT part of the build or the test suite: it
 * rewrites source files, so it must never run concurrently with anything else.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface Mutation {
  /** Stable id, used to filter runs. */
  id: string;
  /** The invariant that is supposed to be enforced. */
  invariant: string;
  /** What breaking it would mean in production. */
  impact: string;
  file: string;
  /** Must occur exactly once in the file, or the mutation is reported as stale. */
  find: string;
  replace: string;
  /**
   * Additional edits applied together with the main one.
   *
   * For invariants held by more than one layer. Mutating a single layer of a
   * defence-in-depth guard produces an EQUIVALENT mutation: the behaviour does not
   * change, so no test can fail, and "SURVIVED" would be a false accusation against the
   * suite. Where the redundancy is deliberate, the mutation must remove the whole
   * defence to say anything useful about coverage.
   */
  also?: { file: string; find: string; replace: string }[];
}

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Pristine copies of every file this script touches, written before the first mutation.
 *
 * On disk, not in memory, precisely because the failure this guards against is the
 * process dying without running any of its own code.
 */
const BACKUP_DIR = path.join(ROOT, ".mutation-backup");

/** Flat, collision-free name for a nested source path. */
function backupPathFor(file: string): string {
  return path.join(BACKUP_DIR, file.replace(/[/\\]/g, "__"));
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/* ------------------------------- The mutations ------------------------------- */

const MUTATIONS: Mutation[] = [
  /* --- Money: the ceilings --- */
  {
    id: "ceiling-policy-off-by-one",
    invariant: "A MAX_TRANSACTION_AMOUNT policy allows an amount only when amount <= max.",
    impact: "An amount one unit over the organisation's cap is approved autonomously.",
    file: "shared/policy/rules.ts",
    find: "  if (amount <= max) {",
    replace: "  if (amount <= max + 1) {",
  },
  {
    id: "ceiling-mandate-off-by-one",
    invariant: "The agent's mandate escalates as soon as amount > maxTransactionAmount.",
    impact: "An agent spends above its autonomous limit with no human in the loop.",
    file: "shared/policy/mandate.ts",
    find: "} else if (amount > mandate.maxTransactionAmount) {",
    replace: "} else if (amount > mandate.maxTransactionAmount + 1) {",
  },
  {
    id: "ceiling-missing-amount-fail-open",
    invariant: "A spending action that declares no numeric amount is refused, not waved through.",
    impact:
      "Renaming `amount` to `total` skips the mandate ceiling entirely — a ceiling that can be bypassed by renaming a field is not a ceiling.",
    file: "shared/policy/mandate.ts",
    find: "} else if (amount === null) {",
    replace: "} else if (false as boolean) {",
  },
  {
    id: "money-negative-amount-accepted",
    invariant: "A negative amount is treated as uncheckable, never as satisfying a ceiling.",
    impact:
      "`amount: -50000` satisfies every `<= max` comparison by construction and is ALLOWed, and a negative cost erodes the daily budget of future legitimate spend.",
    file: "shared/policy/matchers.ts",
    find: "  if (typeof raw === \"number\" && Number.isFinite(raw) && raw >= 0) return raw;",
    replace: "  if (typeof raw === \"number\" && Number.isFinite(raw)) return raw;",
  },

  /* --- Identity --- */
  {
    id: "auth-secret-comparison-always-true",
    invariant: "Secrets are compared, not assumed equal.",
    impact: "Any password and any API key authenticates as the configured identity.",
    file: "server/auth.ts",
    find: "  return crypto.timingSafeEqual(ah, bh);",
    replace: "  return ah.length === bh.length || true;",
  },
  {
    id: "session-revocation-ignored",
    invariant: "A revoked session is rejected.",
    impact: "Logging out or revoking a stolen session has no effect; the token keeps working.",
    file: "server/repositories/sessions.ts",
    find: "    if (record.revokedAt) return null;",
    replace: "    if (record.revokedAt && false) return null;",
  },
  {
    id: "session-expiry-ignored",
    invariant: "An expired session is rejected.",
    impact: "Sessions never expire; OATHRION_SESSION_TTL_MS becomes decorative.",
    file: "server/repositories/sessions.ts",
    find: "    if (Date.parse(record.expiresAt) <= now.getTime()) return null;",
    replace: "    if (Date.parse(record.expiresAt) <= now.getTime() && false) return null;",
  },

  /* --- Authorisation --- */
  {
    id: "rbac-capability-check-disabled",
    invariant: "A route guarded by requireCapability refuses a role that lacks it.",
    impact: "A viewer can execute actions and resolve approvals.",
    file: "server/auth.ts",
    find: "    if (!can(identity.role, capability)) {",
    replace: "    if (!can(identity.role, capability) && false) {",
  },
  {
    id: "rbac-in-handler-check-disabled",
    invariant: "Body-dependent capability checks are enforced in-handler.",
    impact:
      "Routes whose required capability depends on the payload lose their check while the middleware still looks present.",
    file: "server/auth.ts",
    find: "  if (can(identity.role, capability)) return true;",
    replace: "  if (can(identity.role, capability) || true) return true;",
  },

  /* --- Reliability barriers added during this engagement --- */
  {
    id: "retry-ceiling-removed",
    invariant: "The gateway refuses a retry once MAX_TOOL_ATTEMPTS attempts are spent.",
    impact:
      "An operator can re-dispatch a failing payment tool without limit, one real side effect per click.",
    file: "server/gateway/agent-gateway.ts",
    find: "    if (attempts >= MAX_TOOL_ATTEMPTS) {",
    replace: "    if (attempts >= MAX_TOOL_ATTEMPTS * 1000) {",
  },
  {
    id: "retryability-disagrees-with-server",
    invariant:
      "The `retry` block the API reports agrees with what the retry endpoint will actually do.",
    impact:
      "The console offers an enabled Retry button on an execution the server always refuses — the §8 truth gap, reopened.",
    file: "server/gateway/retryability.ts",
    find: "  if (attempts >= maxAttempts) {",
    replace: "  if (attempts >= maxAttempts && false) {",
  },
  {
    id: "audit-append-loses-writes",
    invariant: "Audit entries are appended to the STORED trail, not to a caller's snapshot.",
    impact:
      "Two concurrent writers each overwrite the other's audit entry: the trail silently loses records of who approved what.",
    file: "server/repositories/sqlite.ts",
    find: "      const current = parse<AuditEntry[]>(row.audit, []);",
    replace: "      const current: AuditEntry[] = [];",
  },

  /* --- Network egress --- */
  {
    id: "ssrf-loopback-allowed",
    invariant: "A webhook URL resolving to loopback is refused.",
    impact:
      "A webhook target of 127.0.0.1 turns the notifier into a request forwarder against services that trust localhost.",
    file: "server/notifications/webhook-url.ts",
    find: "    if (a === 127) return \"IPv4 loopback (127.0.0.0/8)\";",
    replace: "    if (a === 127 && false) return \"IPv4 loopback (127.0.0.0/8)\";",
  },
  {
    id: "webhook-signature-wrong-secret",
    invariant: "Webhook payloads are signed with the configured shared secret.",
    impact:
      "The receiver cannot authenticate the sender, and every delivery fails signature verification silently.",
    file: "server/notifications/webhook.ts",
    find: "        .createHmac(\"sha256\", this.options.secret)",
    replace: "        .createHmac(\"sha256\", `${this.options.secret}-mutated`)",
  },

  /* --- Availability --- */
  {
    id: "readiness-always-ok",
    invariant: "The health probe reports 503 when the process is not ready to serve.",
    impact:
      "A load balancer keeps routing traffic to an instance whose database is unreachable or which is draining.",
    file: "server/routes.ts",
    /*
     * Anchored on the whole `/api/ready` handler, not on the status line alone.
     *
     * The original anchor (`res.status(ready ? 200 : 503).json({`) went stale
     * twice over: the handler now passes a prepared `body`, so the text no
     * longer matched, AND `/api/health` was added as an alias with an identical
     * body, so the status line occurs twice. Either fault alone makes this
     * mutation report STALE, and this invariant then goes unmeasured while the
     * summary still says 30 mutations.
     */
    find:
      '  app.get("/api/ready", async (_req, res) => {\n' +
      "    const { ready, body } = await readiness();\n" +
      "    res.status(ready ? 200 : 503).json(body);",
    replace:
      '  app.get("/api/ready", async (_req, res) => {\n' +
      "    const { ready, body } = await readiness();\n" +
      "    res.status(200).json(body);",
  },
  {
    id: "rate-limit-disabled",
    invariant: "The rate limiter refuses requests past `max` in a window.",
    impact: "The login route loses its brute-force ceiling.",
    /*
     * ANCHOR MOVED IN P0-7. `server/rate-limit.ts` became the directory
     * `server/rate-limit/`, and the ceiling comparison moved out of the middleware
     * into the store: the middleware now calls `quotaStore().consume(key, max,
     * windowMs)` and the decision is `allowed` in the store's reply. The old anchor
     * `if (entry.count >= max) {` no longer exists anywhere.
     *
     * This one did not report as stale, it CRASHED the whole audit with ENOENT,
     * because a missing anchor is handled but a missing *file* is not — so every
     * mutation after it went unrun too.
     *
     * The memory store is the target rather than the Postgres one because the suite
     * runs on it by default; `MemoryQuotaStore` and the SQL ceiling in
     * `postgres-store.ts` are two implementations of the same rule, and the Postgres
     * one is covered by `server/test/postgres.test.ts` against a real server.
     */
    file: "server/rate-limit/store.ts",
    find: "      allowed: existing.count <= max,",
    replace: "      allowed: existing.count <= max * 10_000,",
  },

  /* --- Wave 2: barriers the first wave did not probe --- */
  {
    id: "mandate-currency-mismatch-ignored",
    invariant: "An amount denominated in another currency is not compared to the ceiling.",
    impact:
      "A ¥900 purchase is judged against a $500 limit as though the numbers were comparable — the engine knows no exchange rates, so guessing is how a large spend gets approved as a small one.",
    file: "shared/policy/mandate.ts",
    find: "    if (currency === \"INVALID\" || (currency !== null && currency !== mandate.currency)) {",
    replace: "    if (false as boolean) {",
  },
  {
    id: "mandate-blocked-category-ignored",
    invariant: "A category on the mandate's blocklist is refused outright.",
    impact: "An agent explicitly forbidden a spend category transacts in it anyway.",
    file: "shared/policy/mandate.ts",
    find: "    const blocked = mandate.blockedCategories.some((c) => normalizeToken(c) === token);",
    replace: "    const blocked = false;",
  },
  {
    id: "mandate-domain-allowlist-ignored",
    invariant: "An outbound action to a domain outside the allowlist is refused.",
    impact: "An agent scoped to two suppliers sends outbound requests to any host.",
    file: "shared/policy/mandate.ts",
    find: "    } else if (!mandate.allowedDomains.some((d) => matchesDomain(host, d))) {",
    replace: "    } else if (!mandate.allowedDomains.some((d) => matchesDomain(host, d)) && false) {",
  },
  {
    id: "daily-budget-off-by-one",
    invariant: "A daily spend policy escalates as soon as the projected total exceeds the budget.",
    impact: "The daily budget can be overshot, one unit per action, indefinitely.",
    file: "shared/policy/rules.ts",
    find: "  if (projected <= max) {",
    replace: "  if (projected <= max + 1) {",
  },
  {
    id: "action-normalisation-removed",
    invariant:
      "Action and category tokens are compared case- and separator-insensitively.",
    impact:
      "`Refund`, `re-fund` and ` refund ` evade a policy written against `refund` — the whole class of evasion the normaliser exists to close.",
    file: "shared/policy/matchers.ts",
    find: "  return value.trim().toLowerCase().replace(/[\\s-]+/g, \"_\");",
    replace: "  return value;",
  },
  {
    id: "dangerous-verb-uncatalogued",
    invariant:
      "Every dangerous verb the system can dispatch is declared in ACTION_CATALOG with its required scope.",
    impact:
      "A dangerous verb exists with no declared scope, no risk level and no financial flag — §6's silent-bypass scenario, where adding a tool quietly skips policy/mandate/security.",
    file: "shared/policy/actions.ts",
    find: "    action: \"refund\",\n    requiredScope: \"execute:payments\",",
    replace: "    action: \"refund_DISABLED\",\n    requiredScope: \"execute:payments\",",
  },
  {
    /*
     * This mutation originally targeted the early return in decision-service
     * (`if (before.status !== "pending")`) and SURVIVED — which looked like a test gap
     * and was not one. Idempotency here is defence in depth: the early return is a
     * fast path, and the real barrier is the conditional UPDATE below, which only
     * reports `claimed` when it actually changed a pending row. Disabling the fast path
     * alone leaves the barrier standing, so the suite is right to stay green — a
     * textbook EQUIVALENT mutation.
     *
     * Verified rather than assumed: disabling BOTH layers at once turned
     * "does not dispatch, or re-audit, on a repeated approve" and "does not append a
     * second approval event to the audit trail" red. So the mutation now targets the
     * barrier that actually enforces the invariant.
     */
    id: "approval-idempotency-removed",
    invariant: "Re-resolving an already-resolved approval changes nothing and runs no tool.",
    impact:
      "Clicking Approve twice dispatches the payment tool twice — two real side effects for one human decision.",
    file: "server/repositories/sqlite.ts",
    find: "    return { approval, claimed: info.changes === 1 };",
    replace: "    return { approval, claimed: true };",
    /*
     * Both layers, because either one alone holds the line and the mutation is
     * therefore equivalent. This was measured, not guessed: the early return alone
     * survived, the conditional UPDATE alone survived, and the pair turns two tests red.
     *
     * The deeper reason a single-layer mutation cannot be caught in-process is that
     * better-sqlite3 is synchronous, so two "concurrent" approvals never actually
     * interleave inside one Node process — the early return always sees the committed
     * first resolution. The atomic UPDATE is what protects a MULTI-PROCESS deployment,
     * which this suite cannot simulate. Recorded as a known limit rather than papered
     * over with a test that would only pretend to exercise it.
     */
    also: [
      {
        file: "server/services/decision-service.ts",
        find: '    if (before.status !== "pending") {',
        replace: '    if (before.status !== "pending" && false) {',
      },
    ],
  },
  {
    id: "secret-redaction-removed",
    invariant: "Secret-named fields are redacted before anything is logged (§14).",
    impact:
      "Passwords, API keys, session secrets and webhook secrets are written to the request log in plaintext.",
    // Moved out of server/index.ts into its own module precisely so this could be
    // tested: index.ts starts the server on import, so §14's only enforcement point
    // was unreachable from a test.
    file: "server/log-redaction.ts",
    // Anchor updated when the exact-match rule became `isSecretKey`. The previous
    // anchor stopped matching and the audit reported this mutation as *stale* —
    // silently no longer verifying §14 at all. A stale mutation is lost coverage
    // wearing the appearance of a passing suite.
    find: "    redacted[key] = isSecretKey(key)",
    replace: "    redacted[key] = false",
  },

  /* --- Barriers added by the fault-injection pass (script/chaos.ts) --- */
  {
    id: "secret-redaction-suffix-rule-removed",
    invariant:
      "Compound secret names are redacted, not only exact matches: sessionSecret, webhookSecret, api_key, x-api-key (§14).",
    impact:
      "A configuration object or thrown payload containing sessionSecret or webhookSecret is written to the log in plaintext — the two names §14 lists explicitly.",
    file: "server/log-redaction.ts",
    find: "    if (normalised.length > marker.length && normalised.endsWith(marker)) return true;",
    replace: "    if (normalised.length > marker.length && normalised.endsWith(marker) && false) return true;",
  },
  {
    id: "session-credential-binding-ignored",
    invariant:
      "A session stops being accepted once the console password it was issued from is rotated, or its user removed.",
    impact:
      "A leaked operator password cannot be revoked by changing it: every session it opened keeps full access for the rest of its TTL. Rotating the password is the first move in an incident, and it would do nothing.",
    file: "server/auth.ts",
    find: "      if (!credentialStillValid(record)) {",
    replace: "      if (!credentialStillValid(record) && false) {",
  },
  {
    id: "port-format-validation-removed",
    invariant: "PORT is refused when it is not exactly a run of digits.",
    impact:
      "parseInt-style truncation returns: PORT=\"5e3\" becomes port 5 and the process comes up healthy on an address nobody configured, while every client sees connection refused on the intended port.",
    file: "server/config-check.ts",
    find: "  if (!/^\\d+$/.test(value)) {",
    replace: "  if (!/^\\d+$/.test(value) && false) {",
  },
  {
    id: "executions-timestamp-index-removed",
    /*
     * ANCHOR MOVED, AND THE INVARIANT ITSELF CHANGED. Both are recorded because
     * repointing the anchor without rereading the invariant would have re-armed a
     * mutation that no longer describes the system.
     *
     * The DDL left `server/db.ts` for `server/migrations/`, so the anchor went stale.
     * But `idx_executions_ts` was not merely moved: migration `003-tenancy` DROPs it
     * and `server/test/migrations.test.ts` now asserts it is ABSENT. An index leading
     * with `timestamp` cannot serve a read that leads with `organization_id = ?`, so
     * it was replaced by `idx_executions_org_ts (organization_id, timestamp)` — the
     * same shape with the tenant discriminator prepended.
     *
     * So the invariant is no longer "an index on timestamp alone" but "a
     * tenant-leading index that still yields timestamp order". Mutating the copy in
     * `001-baseline` would prove nothing: migration 3 drops that index regardless, so
     * the final schema would be identical and the mutation would report a false HOLE.
     * The anchor is the SQLite branch of migration 3, which is the branch the suite
     * runs; the Postgres branch above it carries the same statement with `"timestamp"`
     * quoted and is covered by `server/test/postgres.test.ts`.
     */
    invariant:
      "The executions table carries a tenant-leading index that still yields timestamp order (idx_executions_org_ts), so the console's newest-first reads do not sort the whole table.",
    impact:
      "GET /api/executions and GET /api/audit fall back to SCAN plus a temporary b-tree over every execution ever recorded. Invisible on a fresh install; measured at 187.3 ms per console page load on 145,600 rows against 4.8 ms with the index.",
    file: "server/migrations/003-tenancy.ts",
    find: "      `CREATE INDEX IF NOT EXISTS idx_executions_org_ts ON executions (organization_id, timestamp)`,",
    replace: "      `CREATE INDEX IF NOT EXISTS idx_executions_org_ts_disabled ON executions (status)`,",
  },
  {
    id: "approval-resolved-cap-removed",
    invariant:
      "GET /api/approvals caps resolved history while always returning every pending approval.",
    impact:
      "The response returns to being unbounded: 5,760 rows and 2.1 MB on ninety days of one pilot company's traffic, downloaded on every console page load.",
    file: "server/repositories/sqlite.ts",
    find: "      .limit(resolvedLimit)",
    replace: "      .limit(resolvedLimit * 1000)",
  },
  {
    id: "trust-proxy-validation-removed",
    invariant: "OATHRION_TRUST_PROXY is validated before Express receives it.",
    impact:
      "A wrong value reaches proxy-addr and surfaces as `TypeError: invalid IP address` with a minified stack, naming no variable the operator can act on.",
    file: "server/config-check.ts",
    find: "    if (/^\\d+$/.test(item) || TRUST_PROXY_KEYWORDS.has(item.toLowerCase())) continue;",
    replace: "    if (/^\\d+$/.test(item) || TRUST_PROXY_KEYWORDS.has(item.toLowerCase()) || true) continue;",
  },
];

/* --------------------------------- Runner ---------------------------------- */

interface Outcome {
  mutation: Mutation;
  status: "caught" | "SURVIVED" | "stale";
  failed: number;
  passed: number;
  /** Names of the tests that caught it (capped for readability). */
  catchers: string[];
  note?: string;
}

const reportDir = mkdtempSync(path.join(tmpdir(), "placet-mutation-"));

/**
 * Runs the suite and returns the counts plus the names of failing tests.
 *
 * A non-zero exit is the EXPECTED case here, so the exit code alone tells us nothing;
 * the JSON report is the source of truth. If the report cannot be read at all we report
 * that rather than guessing, because "no report" and "zero failures" must not be
 * conflated — that would mark a surviving mutation as caught.
 */
function runSuite(
  tag: string,
): { failed: number; passed: number; catchers: string[]; failedSuites: number } | null {
  const out = path.join(reportDir, `${tag}.json`);
  try {
    execFileSync(
      "npx",
      ["vitest", "run", "--reporter=json", "--outputFile", out, "--silent"],
      { cwd: ROOT, stdio: "ignore", timeout: 15 * 60_000 },
    );
  } catch {
    // Expected when tests fail. The report below is what we actually read.
  }

  let raw: string;
  try {
    raw = readFileSync(out, "utf8");
  } catch {
    return null;
  }

  interface Assertion {
    fullName?: string;
    title?: string;
    status?: string;
  }
  interface Report {
    numFailedTests?: number;
    numPassedTests?: number;
    /*
     * Counted as well as `numFailedTests`, because the two are NOT redundant.
     *
     * When a mutation stops a module from loading, every test file that imports
     * it fails at COLLECTION time: no assertion ever runs, so `numFailedTests`
     * is 0 while `numFailedTestSuites` is large. Reading only the former made
     * the most destructive mutations look like the safest ones.
     *
     * Measured, not theorised: `dangerous-verb-uncatalogued` (removing "refund"
     * from the action catalogue) trips a start-up consistency check that refuses
     * to boot a tool wired to an undeclared action. That collapsed 51 of 90 test
     * files, and this harness reported "782 passed (782)" — which the verdict
     * logic below would have read as *** SURVIVED ***, for a mutation that
     * actually breaks the entire application at boot.
     */
    numFailedTestSuites?: number;
    testResults?: { assertionResults?: Assertion[]; status?: string }[];
  }

  let parsed: Report;
  try {
    parsed = JSON.parse(raw) as Report;
  } catch {
    return null;
  }

  const catchers: string[] = [];
  for (const file of parsed.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if (a.status === "failed") catchers.push(a.fullName ?? a.title ?? "(unnamed)");
    }
  }

  const failedSuites =
    parsed.numFailedTestSuites ??
    (parsed.testResults ?? []).filter((f) => f.status === "failed").length;

  return {
    failed: parsed.numFailedTests ?? 0,
    passed: parsed.numPassedTests ?? 0,
    catchers,
    failedSuites,
  };
}

const originals = new Map<string, string>();

/** Every file any mutation could touch — snapshotted up front, not lazily. */
const TRACKED_FILES = [
  ...new Set(MUTATIONS.flatMap((m) => [m.file, ...(m.also ?? []).map((a) => a.file)])),
].sort();

/*
 * PRESENT vs MISSING, split before any file is read.
 *
 * `writeBackups` below reads every tracked file up front, so one file that no longer
 * exists threw ENOENT there — before the baseline, before a single mutation ran — and
 * cancelled the whole audit. That is how P0-7 moving `server/rate-limit.ts` into a
 * directory stopped 14 unrelated invariants from being verified at all, while the only
 * visible symptom was a stack trace.
 *
 * The asymmetry it removes: a missing *anchor* was always handled (reported stale, run
 * continues), a missing *file* was not. Both mean the same thing.
 *
 * Missing files are not dropped quietly. Every mutation naming one is reported as
 * `stale` in the loop below, and `stale` already forces a non-zero exit, so the audit
 * still refuses to claim success — it just no longer takes the other 29 invariants down
 * with it. The three restore/verify helpers work from PRESENT_FILES for the same reason:
 * a file that does not exist has nothing to back up, compare or restore, and treating
 * its absence as a failure there would block the recovery path (`--restore`) exactly
 * when it is needed.
 */
const PRESENT_FILES = TRACKED_FILES.filter((f) => existsSync(path.join(ROOT, f)));
const MISSING_FILES = TRACKED_FILES.filter((f) => !existsSync(path.join(ROOT, f)));

/**
 * Writes the pristine bytes of every tracked file to `.mutation-backup/`.
 *
 * Up front and for ALL tracked files, not lazily per mutation: a lazy snapshot only
 * covers files the run has already reached, so a kill during mutation 2 leaves
 * mutations 3..24's files unprotected.
 */
function writeBackups(): void {
  mkdirSync(BACKUP_DIR, { recursive: true });
  for (const file of PRESENT_FILES) {
    const content = readFileSync(path.join(ROOT, file), "utf8");
    originals.set(file, content);
    writeFileSync(backupPathFor(file), content);
  }
}

/**
 * Refuses to start when a previous run left the tree dirty.
 *
 * Deliberately not "restore automatically and continue": a difference could be a
 * leftover mutation OR a legitimate edit made since, and silently overwriting real work
 * would be worse than stopping. The operator decides, with `--restore`.
 */
function checkPristine(): string[] {
  if (!existsSync(BACKUP_DIR)) return [];
  const dirty: string[] = [];
  for (const file of PRESENT_FILES) {
    const backup = backupPathFor(file);
    if (!existsSync(backup)) continue;
    const saved = readFileSync(backup, "utf8");
    const live = readFileSync(path.join(ROOT, file), "utf8");
    if (saved !== live) dirty.push(`${file}  (backup ${sha(saved)} vs tree ${sha(live)})`);
  }
  return dirty;
}

function restoreFromBackups(): string[] {
  if (!existsSync(BACKUP_DIR)) return [];
  const restored: string[] = [];
  for (const file of PRESENT_FILES) {
    const backup = backupPathFor(file);
    if (!existsSync(backup)) continue;
    const saved = readFileSync(backup, "utf8");
    const abs = path.join(ROOT, file);
    if (readFileSync(abs, "utf8") !== saved) {
      writeFileSync(abs, saved);
      restored.push(file);
    }
  }
  return restored;
}

function readOriginal(file: string): string {
  const abs = path.join(ROOT, file);
  if (!originals.has(file)) originals.set(file, readFileSync(abs, "utf8"));
  return originals.get(file)!;
}

function restoreAll(): void {
  for (const [file, content] of originals) {
    writeFileSync(path.join(ROOT, file), content);
  }
}

// A crash or a Ctrl-C must not leave a sabotaged spending ceiling in the tree.
process.on("SIGINT", () => {
  restoreAll();
  console.error("\nInterrupted — all files restored.");
  process.exit(130);
});
process.on("uncaughtException", (err) => {
  restoreAll();
  console.error("Crashed — all files restored.", err);
  process.exit(1);
});

async function main(): Promise<number> {
  // Comma-separated substrings, so a subset of unrelated ids can be re-audited
  // after a fix without paying for the whole run.
  const arg = process.argv[2];

  if (arg === "--restore") {
    const restored = restoreFromBackups();
    if (restored.length === 0) {
      console.log("Nothing to restore: every tracked file already matches its backup.");
    } else {
      console.log(`Restored ${restored.length} file(s):`);
      for (const f of restored) console.log(`  - ${f}`);
    }
    rmSync(BACKUP_DIR, { recursive: true, force: true });
    return 0;
  }

  // Refuse to start on a dirty tree. Mutating a file that is already mutated would
  // produce a meaningless verdict and back up the sabotage as if it were pristine.
  const preexisting = checkPristine();
  if (preexisting.length > 0) {
    console.error("A previous run left tracked files modified:\n");
    for (const d of preexisting) console.error(`  - ${d}`);
    console.error("\nRun `npx tsx script/mutation-audit.ts --restore` first.");
    return 2;
  }

  const filter = arg;
  const needles = filter ? filter.split(",").map((f) => f.trim()).filter(Boolean) : [];
  const selected =
    needles.length > 0 ? MUTATIONS.filter((m) => needles.some((n) => m.id.includes(n))) : MUTATIONS;

  if (selected.length === 0) {
    console.error(`No mutation id contains "${filter}".`);
    return 2;
  }

  console.log("=".repeat(78));
  console.log("MUTATION AUDIT — does the suite actually enforce its invariants?");
  console.log("=".repeat(78));

  // Announced before the run rather than only in the results, because this is the
  // failure that used to present as a stack trace: the operator should know which
  // mutations cannot possibly run before spending twenty minutes on the rest.
  if (MISSING_FILES.length > 0) {
    console.log(`\n${MISSING_FILES.length} tracked file(s) no longer exist:`);
    for (const f of MISSING_FILES) console.log(`  - ${f}`);
    console.log(
      "  The mutations naming them will be reported STALE and the audit will exit\n" +
        "  non-zero. Repoint them at the code's new home, or drop them.",
    );
  }

  // Before anything is touched, and for every file, so a SIGKILL at any point leaves a
  // complete recovery path on disk.
  writeBackups();
  console.log(`\nBacked up ${PRESENT_FILES.length} file(s) to ${path.basename(BACKUP_DIR)}/`);

  // Baseline first. Auditing a suite that is already red tells us nothing, and every
  // "caught" verdict below is relative to this number.
  console.log("\nBaseline (unmutated)…");
  const baseline = runSuite("baseline");
  if (!baseline) {
    console.error("Could not read the baseline report. Aborting.");
    return 2;
  }
  if (baseline.failed > 0) {
    console.error(`Baseline is RED (${baseline.failed} failing). Fix the suite first.`);
    return 2;
  }
  console.log(`  ${baseline.passed} passed, 0 failed.\n`);

  const outcomes: Outcome[] = [];

  for (const [i, mutation] of selected.entries()) {
    const label = `[${i + 1}/${selected.length}] ${mutation.id}`;
    // Main edit plus any `also` edits, treated uniformly: every anchor must be unique,
    // and every touched file is restored, whichever list it came from.
    const edits = [
      { file: mutation.file, find: mutation.find, replace: mutation.replace },
      ...(mutation.also ?? []),
    ];
    /*
     * Checked before `readOriginal`, which is where the raw ENOENT came from. Every
     * edit's file is checked, not just `mutation.file`: an `also` edit can name a file
     * that moved just as easily as the main one can.
     *
     * Verdict is `stale`, deliberately not a new one. In the chaos bench two meanings
     * had to be split because they had opposite severities — "not injectable here" is
     * fine, "the bench broke" is not. Here both cases say one thing to the operator,
     * with one remedy: the code moved, this mutation did not run, repoint it.
     */
    const gone = edits.map((e) => e.file).filter((f) => !existsSync(path.join(ROOT, f)));
    if (gone.length > 0) {
      console.log(`${label}: STALE — file no longer exists: ${gone.join(", ")}`);
      outcomes.push({
        mutation,
        status: "stale",
        failed: 0,
        passed: 0,
        catchers: [],
        note: `file no longer exists: ${gone.join(", ")} — repoint this mutation at the code's new home, or drop it`,
      });
      continue;
    }

    const original = readOriginal(mutation.file);
    const occurrences = Math.min(
      ...edits.map((e) => readOriginal(e.file).split(e.find).length - 1),
    );

    if (occurrences !== 1) {
      // The code moved. Reporting this as "caught" would be a lie, and reporting it as
      // "survived" would be a false alarm: the mutation simply never happened.
      console.log(`${label}: STALE — anchor found ${occurrences}× in ${mutation.file}`);
      outcomes.push({
        mutation,
        status: "stale",
        failed: 0,
        passed: 0,
        catchers: [],
        note: `anchor occurs ${occurrences}× (expected exactly 1)`,
      });
      continue;
    }

    process.stdout.write(`${label}: applying… `);
    for (const e of edits) {
      const src = readOriginal(e.file);
      writeFileSync(path.join(ROOT, e.file), src.replace(e.find, e.replace));
    }

    const result = runSuite(mutation.id);
    for (const e of edits) writeFileSync(path.join(ROOT, e.file), readOriginal(e.file));

    if (!result) {
      console.log("STALE — no report produced (mutation may not compile)");
      outcomes.push({
        mutation,
        status: "stale",
        failed: 0,
        passed: 0,
        catchers: [],
        note: "no JSON report — the mutated source probably failed to load",
      });
      continue;
    }

    /*
     * A mutation is caught if it broke a test OR if it stopped a test file from
     * loading at all. See the note on `numFailedTestSuites` above: the second
     * case is the one a "failed tests" count silently reports as survival.
     */
    const caught = result.failed > 0 || result.failedSuites > 0;
    const how =
      result.failed > 0
        ? `caught by ${result.failed} test${result.failed === 1 ? "" : "s"}` +
          (result.failedSuites > 0 ? `, and ${result.failedSuites} file(s) failed to load` : "")
        : `caught at load time — ${result.failedSuites} test file(s) could not be imported`;
    console.log(caught ? how : "*** SURVIVED ***");
    outcomes.push({
      mutation,
      status: caught ? "caught" : "SURVIVED",
      failed: result.failed,
      passed: result.passed,
      catchers: result.catchers.slice(0, 4),
    });
  }

  restoreAll();

  // Paranoia, not ceremony: this script edits security-critical files, so it proves the
  // tree is byte-identical rather than trusting that it restored correctly.
  const dirty = checkPristine();

  /* ------------------------------- Report ------------------------------- */

  console.log(`\n${"=".repeat(78)}`);
  console.log("RESULTS");
  console.log("=".repeat(78));

  const survived = outcomes.filter((o) => o.status === "SURVIVED");
  const stale = outcomes.filter((o) => o.status === "stale");
  const caught = outcomes.filter((o) => o.status === "caught");

  for (const o of outcomes) {
    const mark = o.status === "caught" ? "OK  " : o.status === "stale" ? "??  " : "HOLE";
    console.log(`\n${mark} ${o.mutation.id}`);
    console.log(`     invariant: ${o.mutation.invariant}`);
    if (o.status === "caught") {
      console.log(`     ${o.failed} test(s) went red, e.g.:`);
      for (const c of o.catchers) console.log(`       - ${c}`);
    } else if (o.status === "stale") {
      console.log(`     ${o.note}`);
    } else {
      console.log(`     NOTHING FAILED. Unguarded. Impact: ${o.mutation.impact}`);
    }
  }

  console.log(`\n${"-".repeat(78)}`);
  console.log(
    `caught: ${caught.length}   survived: ${survived.length}   stale: ${stale.length}   of ${outcomes.length}`,
  );
  if (dirty.length > 0) {
    console.log(`\n!! FILES NOT RESTORED:`);
    for (const d of dirty) console.log(`   - ${d}`);
    console.log("   Run `npx tsx script/mutation-audit.ts --restore`.");
  } else {
    console.log(
      `All ${PRESENT_FILES.length} tracked file(s) verified byte-identical to their backups.`,
    );
    // Only cleared on a verified-clean finish: if anything is off, the manifest is the
    // recovery path and must survive.
    rmSync(BACKUP_DIR, { recursive: true, force: true });
  }

  rmSync(reportDir, { recursive: true, force: true });

  // Survivors and stale anchors both mean the audit did not establish what it set out
  // to establish, so both are a non-zero exit.
  return survived.length + stale.length + dirty.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    restoreAll();
    console.error(err);
    process.exit(1);
  },
);
