#!/usr/bin/env bash
#
# Mutation checks for the Phase 5 expiry guards.
#
# A passing test suite proves the guards are present. It does not prove they are
# doing anything: a guard that is never the reason a test passes is decoration,
# and the next refactor will delete it with no signal.
#
# So each mutation below removes exactly one guard, runs the tests that are
# supposed to depend on it, and REQUIRES them to fail. A mutation that leaves the
# suite green is reported as SURVIVED, meaning the corresponding claim in the
# phase report is not actually evidenced.
#
# Applying a mutation is itself fallible — these patterns are matched against
# real source, and source moves. A failed application counted as SURVIVED would
# be the worst outcome available: it would report a guard as unprotected when in
# fact nothing had been changed. So application is checked separately from the
# test result, and reported as NOT APPLIED.
#
# Every mutation is reverted with `git checkout --` before the next one runs, and
# the script refuses to start on a dirty tree so a failed revert can never be
# mistaken for a real edit.
#
# Usage: bash script/phase5-mutations.sh

set -uo pipefail
cd "$(dirname "$0")/.."

GATEWAY="server/gateway/agent-gateway.ts"
REPO="server/repositories/sqlite.ts"
TTL="shared/approvals/ttl.ts"
SERVICE="server/services/decision-service.ts"

E2E="server/test/approval-expiry-e2e.test.ts"
UNIT="server/test/approval-ttl.test.ts"
STRUCT="server/test/approval-expiry-single-path.test.ts"

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSING TO RUN: working tree is dirty."
  echo "Mutations are reverted with 'git checkout --', which would discard real edits."
  git status --short
  exit 2
fi

survived=0
killed=0
errored=0
applied=1

# Records whether the preceding patch script actually changed anything.
check_applied() {
  if [ "$1" -ne 0 ]; then
    echo ""
    echo "------------------------------------------------------------------"
    echo "MUTATION: $2"
    echo "------------------------------------------------------------------"
    echo "  RESULT: NOT APPLIED  <- the pattern no longer matches the source."
    echo "          This is a broken check, NOT a surviving mutation."
    errored=$((errored + 1))
    applied=0
  else
    applied=1
  fi
}

# run_mutation <name> <files-to-revert> <test-files...>
# The mutation is applied by the caller; this expects the tests to FAIL.
run_mutation() {
  local name="$1"; shift
  local revert="$1"; shift
  if [ "$applied" -ne 1 ]; then
    # shellcheck disable=SC2086
    git checkout -- $revert 2>/dev/null
    return
  fi
  echo ""
  echo "------------------------------------------------------------------"
  echo "MUTATION: $name"
  echo "------------------------------------------------------------------"
  if ./node_modules/.bin/vitest run "$@" >/tmp/mutation.log 2>&1; then
    echo "  RESULT: SURVIVED  <- the guard is NOT load-bearing; no test depends on it"
    survived=$((survived + 1))
  else
    echo "  RESULT: KILLED    <- removing the guard breaks the suite, as it must"
    killed=$((killed + 1))
    # Vitest colours its output, so strip escape sequences before matching —
    # otherwise the counts are invisible and the summary looks unsupported.
    sed -r 's/\x1B\[[0-9;]*[mGKH]//g' /tmp/mutation.log > /tmp/mutation.txt
    grep -E "^ +Tests +" /tmp/mutation.txt | tail -1 | sed 's/^ */          /'
    grep -E "^ +. " /tmp/mutation.txt | grep -E "^ +(×|x) " | head -4 |
      sed -r 's/^ *(×|x) /          broke: /'
  fi
  # shellcheck disable=SC2086
  git checkout -- $revert
}

echo "=================================================================="
echo "Phase 5 mutation checks"
echo "Each mutation removes one guard. Every one MUST be KILLED."
echo "=================================================================="

# ---------------------------------------------------------------------------
# 1. The gateway release guard loses its `expired` term.
#
# The most dangerous single line in the phase. An expiry returns changed:true,
# with a non-null execution, for a caller who asked to approve — so every OTHER
# term in that guard is satisfied on the late-approve path. Without this term a
# late approve falls straight through to dispatch().
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/gateway/agent-gateway.ts")
s = p.read_text()
old = 'if (expired || status !== "approved" || !execution || !changed) {'
new = 'if (status !== "approved" || !execution || !changed) {'
if s.count(old) != 1:
    sys.exit(f"expected exactly one release guard, found {s.count(old)}")
p.write_text(s.replace(old, new))
PATCH
check_applied $? "gateway release guard loses the 'expired' term"
run_mutation "gateway release guard loses the 'expired' term" "$GATEWAY" "$E2E" "$STRUCT"

# ---------------------------------------------------------------------------
# 2. The resolve() UPDATE loses its deadline predicates.
#
# This is the actual barrier. Without these two terms the conditional UPDATE
# claims a past-deadline row and the approval is released.
#
# Located by unique literal, not by slicing between method names: `expire()` is
# defined ABOVE `resolve()` in this file, so slicing from one to the other
# silently yields nothing — which is exactly how an earlier version of this
# script reported a false SURVIVED.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/repositories/sqlite.ts")
s = p.read_text()
predicates = [
    "          isNotNull(approvalRows.expiresAt),\n",
    "          gt(approvalRows.expiresAt, now),\n",
]
for literal in predicates:
    if s.count(literal) != 1:
        sys.exit(f"expected exactly one {literal.strip()!r}, found {s.count(literal)}")
for literal in predicates:
    s = s.replace(literal, "")
p.write_text(s)
PATCH
check_applied $? "resolve() UPDATE loses its deadline predicates"
run_mutation "resolve() UPDATE loses its deadline predicates" "$REPO" "$UNIT" "$E2E" "$STRUCT"

# ---------------------------------------------------------------------------
# 3. retry() loses its lapsed-authorisation refusal.
#
# The replay window this phase closes. Approving rewrites the execution to
# decision "allow", which is all retry requires, and the retry endpoint asks
# only for `execute` — not `approve`.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/gateway/agent-gateway.ts")
s = p.read_text()
marker = "if (gating && isExpired(gating.expiresAt)) {"
if s.count(marker) != 1:
    sys.exit(f"expected exactly one retry guard, found {s.count(marker)}")
# Make the condition unsatisfiable, leaving the rest of the method untouched so
# the retry path itself still works and only the refusal disappears.
p.write_text(s.replace(marker, "if (false && gating && isExpired(gating.expiresAt)) {"))
PATCH
check_applied $? "retry() loses its lapsed-authorisation refusal"
run_mutation "retry() loses its lapsed-authorisation refusal" "$GATEWAY" "$E2E"

# ---------------------------------------------------------------------------
# 4. isExpired() fails OPEN instead of closed.
#
# The premise of the whole design. A row nobody stamped is a bug, and reading a
# bug as "valid forever" is the failure mode this inverts.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("shared/approvals/ttl.ts")
s = p.read_text()
branches = [
    ('if (expiresAt === null || expiresAt === undefined || expiresAt.trim() === "") return true;',
     'if (expiresAt === null || expiresAt === undefined || expiresAt.trim() === "") return false;'),
    ("if (!Number.isFinite(deadline)) return true;",
     "if (!Number.isFinite(deadline)) return false;"),
]
for old, _new in branches:
    if s.count(old) != 1:
        sys.exit(f"expected exactly one {old!r}, found {s.count(old)}")
for old, new in branches:
    s = s.replace(old, new)
p.write_text(s)
PATCH
check_applied $? "isExpired() fails open on an unreadable deadline"
run_mutation "isExpired() fails open on an unreadable deadline" "$TTL" "$UNIT" "$E2E"

# ---------------------------------------------------------------------------
# 5. Expiry stops closing the execution.
#
# markSkipped is what makes the execution unclaimable. Without it the row stays
# in a state claimToolRun accepts, so the action remains dispatchable by
# anything that claims work.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, re, sys
p = pathlib.Path("server/services/decision-service.ts")
s = p.read_text()
mutated, n = re.subn(r"await this\.repos\.executions\.markSkipped\(", "await Promise.resolve(", s)
if n < 1:
    sys.exit("markSkipped call not found")
p.write_text(mutated)
PATCH
check_applied $? "expiry stops marking the execution skipped"
run_mutation "expiry stops marking the execution skipped" "$SERVICE" "$E2E"

# ---------------------------------------------------------------------------
# 6. BOTH barriers removed at once.
#
# Mutations 1 and 5 are each killed, but neither on its own actually releases
# the action: with the gateway term gone, dispatch() is reached and the claim is
# refused because the execution is already `skipped`; with markSkipped gone, the
# gateway term still returns before dispatch() is reached.
#
# That makes "either one alone would release the action" a false claim, and this
# mutation is what establishes the true one. With both removed, the refund
# reaches the mock downstream over HTTP — so the two are genuinely independent
# barriers and both are load-bearing, which is a weaker and more accurate
# statement than the one a single mutation would have supported.
# ---------------------------------------------------------------------------
python3 - <<'BOTH'
import pathlib, re, sys
g = pathlib.Path("server/gateway/agent-gateway.ts")
s = g.read_text()
old = 'if (expired || status !== "approved" || !execution || !changed) {'
if s.count(old) != 1:
    sys.exit("release guard not found")
g.write_text(s.replace(old, 'if (status !== "approved" || !execution || !changed) {'))

d = pathlib.Path("server/services/decision-service.ts")
t = d.read_text()
mutated, n = re.subn(r"await this\.repos\.executions\.markSkipped\(", "await Promise.resolve(", t)
if n < 1:
    sys.exit("markSkipped call not found")
d.write_text(mutated)
BOTH
check_applied $? "BOTH the gateway term and markSkipped removed"
run_mutation "BOTH the gateway term and markSkipped removed" "$GATEWAY $SERVICE" "$E2E"

echo ""
echo "=================================================================="
echo "KILLED:      $killed"
echo "SURVIVED:    $survived"
echo "NOT APPLIED: $errored"
if [ "$errored" -ne 0 ]; then
  echo ""
  echo "One or more mutations could not be applied, so those guards were not"
  echo "tested at all. Fix the patterns before reading anything into this run."
  exit 4
fi
if [ "$survived" -ne 0 ]; then
  echo ""
  echo "A SURVIVED mutation means a guard has no test depending on it."
  echo "The corresponding claim must not be presented as evidenced."
  exit 1
fi
echo "Every guard checked is load-bearing."
echo "=================================================================="

# Final integrity check: the tree must be exactly as it was.
if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: tree is dirty after the run — a revert did not take."
  git status --short
  exit 3
fi
