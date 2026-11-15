#!/usr/bin/env bash
#
# Mutation checks for the Phase 8 barriers.
#
# A green suite proves the Phase 8 code exists. It does not prove any test
# depends on it. This script removes one barrier at a time and REQUIRES the
# targeted tests to fail; a mutation that leaves them green is SURVIVED, which
# means the corresponding claim in PHASE-8-REPORT.md is not evidenced and must
# not be written as though it were.
#
# THREE OUTCOMES, NOT TWO
# -----------------------
# Same discipline as phases 5, 6 and 7, and for the same reason: a patch that
# failed to apply must never be reported as SURVIVED (a barrier declared
# unprotected when nothing was changed) nor as KILLED (a barrier declared proven
# when nothing was changed). Application is verified twice — the patch command
# must succeed, AND `git diff --quiet` must show the tree actually changed.
#
# This mattered here. The first, ad-hoc version of these Phase 8 mutations was
# run with shell-escaped one-liners and no application check, and reported all
# seven CLI mutations as SURVIVED. Every one of those was false: the patches had
# never applied. Had that output been believed, this phase would have reported
# the CLI's exit-code contract as unprotected by its own tests. The check below
# is the entire reason that is not what happened, and it is why the harness is a
# committed script rather than something typed at a prompt.
#
# TWO RUNNERS
# -----------
# Phase 8 ships a Python SDK, so a mutation may need pytest-free stdlib
# unittest rather than vitest. Each mutation declares its runner. Note that
# `python3 -m unittest` exits non-zero on failure exactly as vitest does, so the
# KILLED/SURVIVED logic is identical.
#
# WHAT THE MUTATIONS TARGET
# -------------------------
# Grouped honestly — these are not 19 independent barriers, they are four
# surfaces each defending the same small set of properties, which is the point.
# The same fail-open must be caught on EVERY surface, because a caller reaching
# Oathrion through the Python SDK is not protected by a TypeScript test.
#
#   TS-*   TypeScript SDK    the decision must come from the server, and
#   PY-*   Python SDK        APPROVAL_REQUIRED must never become permission.
#   CLI-*  command line      exit code 0 must mean ALLOW and nothing else.
#   SRV-*  server            the entry point must validate before it looks up.
#
set -uo pipefail
cd "$(dirname "$0")/.."

echo "=============================================================="
echo "Phase 8 mutation checks"
echo "=============================================================="
echo

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING TO RUN: the working tree is dirty."
  echo "Every mutation is reverted with 'git checkout --', which would destroy"
  echo "uncommitted work and could also hide a failed revert. Commit or stash first."
  exit 2
fi

TS_CLIENT="sdk/typescript/src/client.ts"
PY_CLIENT="sdk/python/placet/client.py"
CLI_CODES="cli/exit-codes.ts"
CLI_MAIN="cli/main.ts"
CLI_ARGS="cli/args.ts"
CONTRACT="shared/api/evaluate-contract.ts"

TS_TESTS="sdk/typescript/src/client.test.ts"
CLI_TESTS="cli/main.test.ts"
SRV_TESTS="server/test/evaluate-contract.test.ts"
ADAPTER="examples/framework-adapter/with-placet.ts"
ADAPTER_TESTS="examples/framework-adapter/with-placet.test.ts"
PARITY_TESTS="server/test/surface-parity.test.ts"

KILLED=0
SURVIVED=0
NOT_APPLIED=0
declare -a RESULTS=()

# run_mutation <label> <description> <runner> <files-to-revert> <targets> <patch>
run_mutation() {
  local label="$1" description="$2" runner="$3" revert="$4" targets="$5" patch="$6"

  echo "=============================================================="
  echo "MUTATION $label — $description"
  echo "=============================================================="

  if ! eval "$patch"; then
    echo "  NOT APPLIED: the patch command failed."
    git checkout -- $revert 2>/dev/null
    NOT_APPLIED=$((NOT_APPLIED + 1))
    RESULTS+=("$label NOT_APPLIED")
    return
  fi

  # Independent of the patch's own exit code: did the tree actually change?
  if git diff --quiet; then
    echo "  NOT APPLIED: the patch exited 0 but changed nothing."
    NOT_APPLIED=$((NOT_APPLIED + 1))
    RESULTS+=("$label NOT_APPLIED")
    return
  fi

  echo "  applied; running ($runner): $targets"
  local ok=0
  case "$runner" in
    vitest) npx vitest run $targets >"/tmp/p8-mutation-$label.log" 2>&1 && ok=1 ;;
    python) python3 -m unittest discover -s sdk/python -t sdk/python \
              >"/tmp/p8-mutation-$label.log" 2>&1 && ok=1 ;;
    *) echo "  unknown runner: $runner"; exit 4 ;;
  esac

  if [ "$ok" = "1" ]; then
    echo "  SURVIVED — the targeted tests PASSED with the barrier removed."
    echo "  (log: /tmp/p8-mutation-$label.log)"
    SURVIVED=$((SURVIVED + 1))
    RESULTS+=("$label SURVIVED")
  else
    local failed
    failed=$(sed -e 's/\x1b\[[0-9;]*m//g' "/tmp/p8-mutation-$label.log" \
             | grep -c "^ FAIL\|× \|^FAIL:\|^ERROR:")
    echo "  KILLED — the targeted tests failed as required ($failed failing line(s))."
    KILLED=$((KILLED + 1))
    RESULTS+=("$label KILLED")
  fi

  git checkout -- $revert
  if ! git diff --quiet; then
    echo "  WARNING: revert left the tree dirty. Stopping to avoid compounding edits."
    exit 3
  fi
  echo
}

# ===========================================================================
# TypeScript SDK
# ===========================================================================

# TS-M1 — the single most dangerous mistake an SDK can make: treating a hold as
# permission. A held action has NOT been authorised; a human has not answered
# yet. If `allowed` is true for it, every `if (d.allowed)` in every integration
# silently executes actions nobody approved.
run_mutation TS-M1 \
  "TypeScript: allowed is true for APPROVAL_REQUIRED" \
  vitest "$TS_CLIENT" "$TS_TESTS" \
  "perl -0pi -e 's/allowed: response\.decision === \"ALLOW\",/allowed: response.decision === \"ALLOW\" || response.decision === \"APPROVAL_REQUIRED\",/' $TS_CLIENT && grep -q 'APPROVAL_REQUIRED\",\$' $TS_CLIENT"

# TS-M2 — the SDK inventing a decision when it cannot reach Oathrion. This is the
# fail-open the whole product is against: unreachable is not allowed, and an
# SDK that answers on the server's behalf has become a second decision engine.
run_mutation TS-M2 \
  "TypeScript: a connection failure synthesises an ALLOW" \
  vitest "$TS_CLIENT" "$TS_TESTS" \
  "perl -0pi -e 's/(    throw new OathrionConnectionError\()/    return { decision: \"ALLOW\", reason: \"offline\", allowed: true, blocked: false, pendingApproval: true } as never;\n\$1/' $TS_CLIENT && grep -q 'offline' $TS_CLIENT"

# TS-M3 — the unknown decision string. A 200 whose `decision` is "PERMIT", or
# "allow", or null, is not a decision this SDK understands, and guessing is
# how a protocol drift becomes an authorisation bypass. Must throw, not coerce.
run_mutation TS-M3 \
  "TypeScript: an unrecognised decision string is coerced to ALLOW" \
  vitest "$TS_CLIENT" "$TS_TESTS" \
  "perl -0pi -e 's/  return typeof value === \"string\" && \(DECISIONS as readonly string\[\]\)\.includes\(value\);/  return typeof value === \"string\";/' $TS_CLIENT && ! grep -q 'DECISIONS as readonly string\[\]).includes' $TS_CLIENT"

# TS-M4 — `blocked` defined as the negation of `allowed`. Reads as a harmless
# simplification and is not: with three decisions, `!allowed` folds
# APPROVAL_REQUIRED into BLOCK. That direction is safe, but it is the mirror of
# the one that is not, and the exhaustive form is what keeps the pair honest.
run_mutation TS-M4 \
  "TypeScript: blocked is defined as !allowed" \
  vitest "$TS_CLIENT" "$TS_TESTS" \
  "perl -0pi -e 's/    blocked: response\.decision === \"BLOCK\",/    blocked: response.decision !== \"ALLOW\",/' $TS_CLIENT && grep -q 'blocked: response.decision !== ' $TS_CLIENT"

# ===========================================================================
# Python SDK — the same properties, on the surface a TypeScript test cannot see
# ===========================================================================

run_mutation PY-M1 \
  "Python: allowed is true for APPROVAL_REQUIRED" \
  python "$PY_CLIENT" "" \
  "perl -0pi -e 's/        return self\.decision == \"ALLOW\"/        return self.decision in (\"ALLOW\", \"APPROVAL_REQUIRED\")/' $PY_CLIENT && grep -q 'in (\"ALLOW\", \"APPROVAL_REQUIRED\")' $PY_CLIENT"

run_mutation PY-M2 \
  "Python: an unrecognised decision string is accepted" \
  python "$PY_CLIENT" "" \
  "perl -0pi -e 's/        if decision not in DECISIONS:/        if False:/' $PY_CLIENT && grep -q 'if False:' $PY_CLIENT"

run_mutation PY-M3 \
  "Python: require_allow tolerates a hold" \
  python "$PY_CLIENT" "" \
  "perl -0pi -e 's/        if not decision\.allowed:/        if decision.blocked:/' $PY_CLIENT && grep -q 'if decision.blocked:' $PY_CLIENT"

run_mutation PY-M4 \
  "Python: blocked is defined as not allowed" \
  python "$PY_CLIENT" "" \
  "perl -0pi -e 's/        return self\.decision == \"BLOCK\"/        return self.decision != \"ALLOW\"/' $PY_CLIENT && grep -q 'return self.decision != \"ALLOW\"' $PY_CLIENT"

# ===========================================================================
# CLI — exit code 0 must mean ALLOW and nothing else
# ===========================================================================

# CLI-M1 is the mutation that matters most in this whole file. `placet evaluate
# ... && ./issue-refund.sh` runs the refund on exit 0. If a hold exits 0, the
# approval gate is decorative and the money moves before anyone answers.
run_mutation CLI-M1 \
  "CLI: APPROVAL_REQUIRED exits 0" \
  vitest "$CLI_CODES" "$CLI_TESTS" \
  "perl -0pi -e 's/  APPROVAL_REQUIRED: 2,/  APPROVAL_REQUIRED: 0,/' $CLI_CODES && grep -q 'APPROVAL_REQUIRED: 0,' $CLI_CODES"

# CLI-M2 — an unreachable Oathrion exiting 0. Nothing decided anything, and the
# shell would proceed as though something had.
run_mutation CLI-M2 \
  "CLI: an unreachable server exits 0" \
  vitest "$CLI_CODES" "$CLI_TESTS" \
  "perl -0pi -e 's/  UNREACHABLE: 4,/  UNREACHABLE: 0,/' $CLI_CODES && grep -q 'UNREACHABLE: 0,' $CLI_CODES"

# CLI-M3 — an unrecognised decision string exiting 0 instead of PROTOCOL.
run_mutation CLI-M3 \
  "CLI: an unknown decision string maps to ALLOW" \
  vitest "$CLI_CODES" "$CLI_TESTS" \
  "perl -0pi -e 's/      return EXIT\.PROTOCOL;/      return EXIT.ALLOW;/' $CLI_CODES && grep -q 'return EXIT.ALLOW;' $CLI_CODES"

# CLI-M4 — a rejected credential exiting 0. 401 is not permission.
run_mutation CLI-M4 \
  "CLI: an HTTP failure (401/403/5xx) exits 0" \
  vitest "$CLI_CODES" "$CLI_TESTS" \
  "perl -0pi -e 's/  HTTP: 5,/  HTTP: 0,/' $CLI_CODES && grep -q 'HTTP: 0,' $CLI_CODES"

# CLI-M5 — unknown flags ignored rather than refused. A typo'd `--amont 75`
# would silently evaluate an action with no amount at all, which is a DIFFERENT
# action from the one the operator typed, and may well be allowed.
run_mutation CLI-M5 \
  "CLI: unknown flags are silently ignored" \
  vitest "$CLI_ARGS" "$CLI_TESTS" \
  "perl -0pi -e 's/      if \(!KNOWN_FLAGS\.has\(name\)\) \{/      if (false as boolean) {/' $CLI_ARGS && grep -q 'if (false as boolean)' $CLI_ARGS"

# CLI-M6 — bare `placet` exiting 0. A script testing the status of a mistyped
# command would read success.
run_mutation CLI-M6 \
  "CLI: no command at all exits 0" \
  vitest "$CLI_MAIN" "$CLI_TESTS" \
  "perl -0pi -e 's/    return parsed\.flags\.help === true \? EXIT\.ALLOW : EXIT\.USAGE;/    return EXIT.ALLOW;/' $CLI_MAIN && grep -q 'return EXIT.ALLOW;\$' $CLI_MAIN"

# ===========================================================================
# Server — P8-4: the entry point must validate the agent id before it looks it up
# ===========================================================================

# SRV-M1 — restore the pre-P8-4 schema, where agentId was any non-empty string.
# The authorization entry point then carried arbitrary input into a registry
# lookup, and an impossible id came back 404 (a lookup result) rather than 400
# (a rejected request). Neither is a decision, but only one of them is honest
# about where the input failed.
run_mutation SRV-M1 \
  "Server: agentId accepts any non-empty string again (pre-P8-4)" \
  vitest "$CONTRACT" "$SRV_TESTS" \
  "perl -0pi -e 's/  agentId: agentIdSchema\.optional\(\),/  agentId: z.string().min(1).optional(),/' $CONTRACT && grep -q 'z.string().min(1).optional()' $CONTRACT"

# ===========================================================================
# Framework adapter and cross-surface parity
# ===========================================================================

# ADP-M1 — the adapter treating a hold as permission.
#
# This is TS-M1 one layer out, and it is worth testing separately because the
# adapter is the layer that actually CALLS the tool. The SDK returning a wrong
# flag is a wrong answer; the adapter acting on it is a refund that happened.
#
# The guard is written `if (!decision.allowed) throw` rather than
# `if (decision.blocked) throw` precisely so that APPROVAL_REQUIRED falls on the
# refusing side. This mutation is that exact regression.
#
# Note the patch targets the executable line and the check greps for the code
# form, NOT the string: the surrounding comment quotes both spellings verbatim,
# so a naive substitution rewrites the COMMENT and leaves the logic untouched.
# That happened while writing this file, the tree diffed dirty, and the mutation
# looked applied while proving nothing. Hence `-e 's/^      if ...'` anchored to
# the indentation of the statement.
run_mutation ADP-M1 \
  "Adapter: a held action reaches the tool (blocked instead of !allowed)" \
  vitest "$ADAPTER" "$ADAPTER_TESTS $PARITY_TESTS" \
  "perl -0pi -e 's/^      if \\(!decision\\.allowed\\) \\{/      if (decision.blocked) {/m' $ADAPTER && grep -q '^      if (decision.blocked) {' $ADAPTER"

# ADP-M2 — the adapter running the tool first and authorising afterwards.
#
# A wrapper that awaits the tool and then checks the decision still throws on a
# BLOCK, so every test asserting `rejects.toThrow()` continues to pass while the
# side effect has already happened. Only an assertion on the CALL COUNT catches
# it, which is why every refusal test in this suite counts invocations instead
# of catching errors.
run_mutation ADP-M2 \
  "Adapter: the tool runs before the decision is checked" \
  vitest "$ADAPTER" "$ADAPTER_TESTS $PARITY_TESTS" \
  "perl -0pi -e 's/^      const decision = await client\\.evaluate\\(\\{/      const __r = await tool.execute(args);\n      const decision = await client.evaluate({/m' $ADAPTER && grep -q '__r = await tool.execute' $ADAPTER"

# ===========================================================================

echo "=============================================================="
echo "SUMMARY"
echo "=============================================================="
for line in "${RESULTS[@]}"; do echo "  $line"; done
echo
echo "  KILLED:      $KILLED"
echo "  SURVIVED:    $SURVIVED"
echo "  NOT_APPLIED: $NOT_APPLIED"
echo

if [ "$NOT_APPLIED" -gt 0 ]; then
  echo "RESULT: INCONCLUSIVE — $NOT_APPLIED mutation(s) never applied."
  echo "A mutation that did not apply proves nothing in either direction and"
  echo "must not be counted as evidence. Fix the patch and re-run."
  exit 1
fi

if [ "$SURVIVED" -gt 0 ]; then
  echo "RESULT: FAIL — $SURVIVED barrier(s) are not protected by any test."
  exit 1
fi

echo "RESULT: PASS — all $KILLED mutations were killed by the targeted tests."
