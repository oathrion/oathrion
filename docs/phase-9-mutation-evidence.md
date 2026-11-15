# Phase 9 mutation evidence (measured, not claimed)

Method: revert-after-each. Each mutant is applied to shipped source, the named
test file(s) are run, then the original is restored from a backup and the tests
re-run green to prove the restore. "KILLED" = at least one test failed.

## Round 1 — MCP destination / SSRF (server/gateway/tools/mcp-destination.ts, mcp-client.ts)
Tests: server/test/mcp-destination-security.test.ts

| # | Mutant | Result (first run) | After test fix |
|---|---|---|---|
| M1 | allowlist membership check disabled | KILLED (2 failed) | KILLED |
| M2 | address rules skipped for the destination (`allowLoopback=true`) | **SURVIVED** | KILLED (1 failed) |
| M3 | empty allowlist permits everything | KILLED (2 failed) | KILLED |
| M4 | IPv4-mapped-IPv6 unmapping disabled (webhook-url.ts) | KILLED (1 failed) | KILLED |
| M5 | dangerous-port check removed | KILLED (1 failed) | KILLED |
| M6 | client reverts to bare `fetch` | KILLED (1 failed) | KILLED |
| M7 | timeout removed (`timeoutMs: 0`) | KILLED (1 failed) | KILLED |
| M8 | destination address check deleted entirely | KILLED (5 failed) | — |
| M9 | allowlist parser skips per-entry safety | KILLED (1 failed) | — |
| M10 | `*` accepted in the allowlist | KILLED (1 failed) | — |
| M11 | both-variables-set refusal removed | KILLED (1 failed) | — |

**M2 was a genuine hole in the tests, not in the code.** The `remote()` helper put
the destination on the allowlist too (the realistic operator config), so every
unsafe destination was caught twice and the primary gate could be removed
unnoticed. Fixed by adding `describe("each gate is proven on its own, not through
the other")` — 6 tests that isolate each gate behind a clean allowlist.

Final: **11/11 killed**, 41 tests in the file.

## Round 2 — policy engine fail-closed (shared/policy/engine.ts)
Tests: shared/policy/undeclared-action-posture.test.ts, server/test/evaluate-contract.test.ts

| # | Mutant | Result (first run) | After test fix |
|---|---|---|---|
| M12 | undeclared verdict decision forced to ALLOW | KILLED (8 failed) | — |
| M13 | undeclared verdict priority 95 -> 1 | **SURVIVED** | KILLED (1 failed) |
| M14 | undeclared verdict priority 95 -> 89 | not run initially | KILLED (1 failed) |
| M15 | `namesActionLiterally()` forced true | not run initially | KILLED (11 failed) |

**M13 was a genuine hole in the tests.** `engine.ts` documents that priority 95
places the undeclared verdict above `sys_unknown_dangerous_action` (90) and
`sys_ungoverned_money` (88) so the caller reads the most fundamental reason. Every
existing test asserted only the *decision*, and all three synthetic verdicts
BLOCK — so the documented ordering was unmeasured. `policyId` and `reason` are
what a developer acts on and what the audit records as the justification, so the
ordering is a real guarantee. Fixed by adding `describe("which synthetic verdict
the caller is told about")`.

### Behaviours discovered while closing M13 (previously undocumented)
1. A policy naming a verb **literally** disarms the dangerous-name heuristic as
   well as the undeclared verdict. A **wildcard** (`vendor.*`) disarms only the
   undeclared verdict. Both are now pinned.
2. An `amountAtMost` policy applied to an action carrying no numeric amount
   **fails closed to BLOCK** ("cannot be checked"), not to the policy's own
   `action`. Now pinned.
3. The amount is read from `metadata`, not from a top-level field. A top-level
   `amount:` is silently ignored — which is how (2) was found.
4. A literal declaration **can** reach a plain ALLOW for a dangerous-looking,
   undeclared verb when the policy's condition is satisfied. This is the escape
   hatch working as intended. The guarantee is "nothing reaches ALLOW without a
   human having named it", NOT "dangerous-looking verbs can never be allowed".
   Now pinned and documented in the test.

## Layering note (measured)
Golden scenario D over the MCP transport is refused by the **MCP tool-catalog
gate**, before the policy engine is consulted: running the downstream E2E file
with `PLACET_UNDECLARED_ACTION=allow` still refuses all 25 cases. The policy
engine's fail-closed behaviour is proven separately on the HTTP surface
(`evaluate-contract.test.ts`, `undeclared-action-posture.test.ts`). Two
independent layers, each measured on the surface where it acts.

## Round 3 — execution barrier, exactly-once, tenant-scoped writes
Chokepoints: `server/gateway/agent-gateway.ts`, `server/repositories/sqlite.ts`
Tests: NEW `server/test/execution-barrier-inner-layer.test.ts` (10 tests)

First sweep, against the pre-existing suite
(`concurrency.test.ts`, `retry-ceiling.test.ts`, `tenant-isolation.test.ts`,
`mcp-e2e-downstream.test.ts`):

| # | Mutant | Pre-existing suite | After new file |
|---|---|---|---|
| S1 | `if (!claimed)` -> `if (false)` — dispatch after LOSING the claim | **SURVIVED** | KILLED |
| S2 | stale-run window always matches — re-claim an in-flight run | **SURVIVED** | KILLED |
| S3 | `completeToolRun` success branch drops `organization_id` | **SURVIVED** | KILLED |
| S4 | `completeToolRun` failure branch drops `organization_id` | — | KILLED |
| S5 | `retry` ignores `decision !== "allow"` | **SURVIVED** | KILLED |
| S6 | `retry` ignores `runState !== "failed"` | KILLED | KILLED |
| — | claim always returns true | KILLED | — |
| — | attempts ceiling removed | KILLED | — |
| — | `claimToolRun` drops `organization_id` | KILLED | — |
| — | agent `list()` unscoped | KILLED | — |

**Why S1/S2/S3/S5 survived: the route guard shadowed the inner guard.**
`POST /api/executions/:id/retry` refuses a non-retryable execution before the
gateway is reached, so every existing test went through the outer layer and the
inner one was never exercised. Defence in depth whose inner layer was untested —
the exactly-once guarantee was resting on a line no test touched.

### Three of my own tests were vacuous before they were correct
Recorded because the same trap catches the next reader:

1. **S1**: the first draft compared tool invocations to the number of outcomes
   reporting `attempted`. Self-consistent and worthless — a mutant that
   dispatches after losing the claim reports `attempted` for those calls too, so
   both numbers move together. Fixed by asserting against the DB `attempts`
   column, which is incremented by the same atomic UPDATE that grants the claim
   and so cannot be influenced by the dispatch path.
2. **S2**: the first draft used a *succeeding* tool. That leaves the run in
   `succeeded`, a state `claimToolRun` refuses outright, so the row never reached
   `running`, the assertion sat behind an `if (runState === "running")` that never
   fired, and the test passed asserting nothing. Fixed with a failing tool and no
   conditionals anywhere in the test.
3. **S5**: the first draft asserted only HTTP 409. A blocked execution also has a
   non-`failed` run state, so the *second* guard refuses it too and the status
   stays 409 with the decision guard removed. Fixed by asserting the refusal
   *reason*, which pins which guard spoke — a distinction callers act on
   differently ("refused by policy" is final; "not in a retryable state" invites
   retrying later).

Also asserted: a refused claim must not increment `attempts` (otherwise a refusal
still burns the ceiling), and a stale run MUST remain recoverable so a crashed
worker is not a permanent stall.

## Verified totals after round 3
- `npx tsc --noEmit`: exit 0
- `npm run lint`: 0 errors, 0 warnings
- `npx vitest run`: **90 files / 1854 tests passed**, exit 0, ~78s
- Mutants killed across all three rounds: **21/21** (4 initially survived, all
  closed by strengthening tests, then re-verified)

## Round 4 — approvals, rate limiting, secret redaction
Method as before. These areas were audited by mutation *before* writing any new
test, so the report can distinguish "already covered" from "covered because I
covered it".

### Approvals — already covered, nothing added
Tests: `approval-ttl.test.ts`, `approval-expiry-e2e.test.ts`,
`approval-expiry-single-path.test.ts`, `concurrency.test.ts` (86 tests)

| Mutant | Result |
|---|---|
| expiry ignored on resolve (`expired \|\|` removed) | KILLED |
| `status !== "approved"` ignored — a REJECTED approval executes | KILLED |
| `!changed` ignored — a double approval executes twice | KILLED |
| retry ignores an expired approval window | KILLED (2 tests) |

4/4 killed by the pre-existing suite. The approval gate is genuinely tested; I
added nothing here, and the report says so rather than claiming credit.

### Secret redaction — already covered, nothing added
Tests: `log-redaction.test.ts`, `notifications.test.ts`,
`delivery-detail.test.ts` (45 tests)

| Mutant | Result |
|---|---|
| `REDACT_MAX_DEPTH` -> 0 (nested secrets logged verbatim) | KILLED (10 tests) |
| `"authorization"` removed from the sensitive set | KILLED (2) |
| `"password"` removed | KILLED (7) |
| `"secret"` removed | KILLED (5) |
| `"token"` removed | KILLED (4) |

5/5 killed. §14 is enforced by a real barrier, not by convention.

### Rate limiting — one gap, closed
Tests: `rate-limit.test.ts`, `rate-limit-fail-mode.test.ts`

| Mutant | Before | After |
|---|---|---|
| fail mode default flipped to `open` | KILLED (3) | KILLED |
| `quotaKey` drops the identity, keys on IP | KILLED (1) | KILLED (4) |
| `quotaKey` drops the SCOPE — every route shares one budget | **SURVIVED** | KILLED (1) |
| `quotaKey` drops the subject — every caller shares one budget | not run | KILLED (4) |

Shared scope is not a bypass — it makes the limiter stricter — but it is a
reliability defect that only appears under load: the chattiest route silently
consumes every other route's budget, so exhausting `/api/decision` would start
returning 429 on the approvals path, locking a human out of releasing a held
action by way of unrelated read traffic. Closed with 6 unit tests on `quotaKey`.

**Observed and recorded, not fixed:** an unidentified caller whose `req.ip`
equalled the string `key_alice` would land in that credential's bucket, since
both are interpolated into the same position in the key. Not exploitable —
`req.ip` is an address parsed by Express — so it is pinned as observed behaviour
in the test rather than reported as a vulnerability. The test is where the
assumption is written down if that fallback ever widens to a caller-supplied
value.

## Running mutation total
**28 mutants applied, 28 killed** after test strengthening. 5 survived on first
contact (M2, M13, S1, S2, S3, S5 — six occurrences across four defects), every
one a hole in the TESTS rather than in the code, each closed and re-verified.

## Round 5 — the shipped harness itself (`npm run test:mutations`, 30 mutants)

Running the project's own mutation suite end-to-end surfaced three defects **in
the harness**, not in the product. A mutation harness that miscounts is worse
than none: it produces a confident number that is wrong in the safe-looking
direction.

### D1 — a killed run left the tree mutated, and it could not self-heal
The first attempt was killed by an external timeout mid-mutation. It left
`server/repositories/sessions.ts` holding a live mutation:

```
-    if (record.revokedAt) return null;
+    if (record.revokedAt && false) return null;
```

i.e. **a revoked session still authenticates**. The harness refuses to start on a
dirty tree (correct) and offers `--restore` from `.mutation-backup/`, but the
Phase 8 ZIP shipped **without a `.git` directory**, and the revert path relies on
git. Restored by diffing all 17 backups against the tree; only that one differed.
Fixed structurally by initialising a repository (§41 asks for a Git commit
anyway), after which `git checkout -- .` is a reliable second recovery route.
Recorded because the same trap catches the next person: **a mutation harness is
a program that deliberately sabotages your source, so its recovery path is a
safety control, not a convenience.**

### D2 — a mutation that breaks the whole application was reported as survivable
`dangerous-verb-uncatalogued` removes `refund` from `ACTION_CATALOG`. A start-up
consistency check then refuses to boot a tool wired to an undeclared action, so
**51 of 90 test files fail at collection time** — no assertion runs, and vitest
reports `numFailedTests: 0`. The harness printed `782 passed (782)` and its
verdict line (`const caught = result.failed > 0`) would have called the most
destructive mutation in the set *** SURVIVED ***.

Fixed by also reading `numFailedTestSuites` (with a per-file fallback) and
treating a load-time collapse as a catch, reported distinctly:

```
[2/2] dangerous-verb-uncatalogued: applying… caught at load time — 51 test file(s) could not be imported
```

The invariant is in fact enforced *harder* than by a test: it is a fail-closed
boot check.

### D3 — a stale anchor silently removed an invariant from the run
`readiness-always-ok` anchored on `res.status(ready ? 200 : 503).json({`. The
handler now passes a prepared `body`, and `/api/health` was since added as an
alias with an identical body — so the anchor matched **0×** after the refactor
and would match **2×** once repaired naively. The harness honestly printed
`STALE` rather than `caught` (good design), but the summary still said 30
mutations while 29 ran. Re-anchored on the whole `/api/ready` handler.

After the fix: `caught by 5 tests, and 3 file(s) failed to load`.

### Result of the 30-mutant shipped suite
Measured across the interrupted first run plus a per-mutant completion using the
same revert-after-each method (the full 1860-test suite takes ~80 s per mutant
here; the two apparent stalls were resource contention, not the mutants — both
mutants kill in under 3 s when scoped to the relevant files):

**30 applied, 30 caught, 0 survived, 0 stale.**

Per-mutant catch counts for the ten completed individually: readiness 5 (+3
files), action-normalisation 2, dangerous-verb 51 files at load, secret-redaction
12, secret-redaction-suffix 2, session-credential-binding 8, port-format 2,
executions-timestamp-index 4, approval-resolved-cap 1, trust-proxy 2. The two
previously-STALE mutants were separately confirmed killed when scoped:
`mandate-domain-allowlist-ignored` 1 failed / 193 (3 s),
`daily-budget-off-by-one` 2 failed / 161 (1.7 s).

## Grand total
- **28 mutants** of my own design (rounds 1–4): 28 caught, 6 initially survived,
  every survivor a hole in the TESTS, each closed and re-verified.
- **30 mutants** shipped with the project (round 5): 30 caught, 0 survived,
  after fixing three defects in the harness that were hiding two of them.
- **58 mutants applied in total, 58 caught.** No mutant is currently known to
  survive. This is a floor, not a proof of completeness: it says the suite
  detects these 58 specific sabotages, nothing more.
