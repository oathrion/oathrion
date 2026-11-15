#!/usr/bin/env bash
#
# Mutation checks for the Phase 7 barriers.
#
# A green suite proves the Phase 7 code exists. It does not prove any test
# depends on it. This script removes one barrier at a time and REQUIRES the
# targeted tests to fail; a mutation that leaves them green is SURVIVED, which
# means the corresponding claim in PHASE-7-REPORT.md is not evidenced and must
# not be written as though it were.
#
# THREE OUTCOMES, NOT TWO
# -----------------------
# Same discipline as `script/phase6-mutations.sh`, and for the same reason: a
# patch that failed to apply must never be reported as SURVIVED (a barrier
# declared unprotected when nothing was changed) nor as KILLED (a barrier
# declared proven when nothing was changed). Application is verified twice —
# the patch command must succeed, and `git diff --quiet` must show the tree
# actually changed.
#
# WHAT THE SEVEN MUTATIONS ACTUALLY TARGET
# ----------------------------------------
# Stated honestly, because these are not seven independent barriers:
#
#   A, B  -> INSPECTED_TABLES. Two mutations, one list: remove each of the two
#            names this phase added. Both must be caught by the engine-free
#            guard, and A must ALSO be caught by the live-PostgreSQL test when a
#            server is present.
#   C     -> migration 011 itself: emit nothing on PostgreSQL. Must be caught by
#            the timestamptz pin, which only runs with a server — so C is
#            reported as NOT APPLICABLE without one rather than as KILLED.
#   D     -> migration 011's append-only property: renumber it as 7. Must be
#            caught by the registry pin.
#   E, F  -> the agent lifecycle. E lets a non-active agent through the policy
#            engine; F refuses draft -> active at the write schema, which is the
#            deadlock this phase went looking for.
#   G     -> the downstream boundary: let the gateway dispatch even when the
#            decision is not ALLOW.
#
# G IS NOT TARGETED AT THE LIFECYCLE TEST, AND THAT IS A FINDING
# --------------------------------------------------------------
# It was, on the first run of this script, and it SURVIVED. The cause is worth
# recording rather than quietly retargeting:
#
#   `agent-gateway.ts` guards dispatch with
#       if (outcome.decision !== "ALLOW" || !execution) return base;
#   and a BLOCKed action never creates an execution. So with the decision half
#   disabled, the `!execution` half still stopped the draft agent, the mock
#   downstream stayed at zero calls, and the lifecycle test passed.
#
# Removing the OTHER half instead (decision check intact, `!execution` disabled)
# leaves all 49 downstream/lifecycle tests green — because an ALLOW always has
# an execution. So `!execution` is a type-narrowing null guard, not a second
# security barrier, and the decision check is the only real one. Two clauses,
# one barrier; the report says so instead of counting it as defence in depth.
#
# G therefore runs against the tests that actually own that boundary — the
# downstream scenario suites — where it kills 9 tests. The lifecycle test's own
# downstream assertions remain worthwhile (they are what mutation E and G's
# sibling barriers act on) but they are corroborating evidence, not the primary
# proof that a non-ALLOW never dispatches.
#
# So: four distinct enforcement sites (the inspected-table list, migration 011,
# agent status enforcement, the downstream boundary), exercised through seven
# mutations. That is the claim the report makes.
#
# Every mutation is reverted with `git checkout --` before the next runs, and
# the script refuses to start on a dirty tree so a failed revert can never be
# mistaken for a real edit.
#
# Usage: bash script/phase7-mutations.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PGDRIVER="server/migrations/postgres-driver.ts"
MIG011="server/migrations/011-usage-counter-timestamp.ts"
ENGINE="shared/policy/engine.ts"
ROUTES="server/routes.ts"
GATEWAY="server/gateway/agent-gateway.ts"

DOWNSTREAM="server/test/mcp-e2e-downstream.test.ts server/test/reference-scenarios.test.ts"
COVERAGE="server/test/migration-inspection-coverage.test.ts"
PGTEST="server/test/postgres.test.ts"
LIFECYCLE="server/test/agent-lifecycle-transitions.test.ts"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING TO RUN: the working tree is dirty."
  echo "Every mutation is reverted with 'git checkout --', which would destroy"
  echo "uncommitted work and could also hide a failed revert. Commit or stash first."
  exit 2
fi

# Is a PostgreSQL server reachable? Mutation C can only be killed by a test that
# needs one, so without a server it is reported NOT APPLICABLE rather than
# counted either way. Fabricating a KILLED here is exactly the dishonesty the
# brief forbids.
PG_URL="${OATHRION_TEST_PG_URL:-${PLACET_TEST_PG_URL:-postgres://user@localhost:55432/postgres}}"
if node -e "
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.argv[1], max: 1, connectionTimeoutMillis: 2000 });
p.query('SELECT 1').then(() => p.end()).then(() => process.exit(0)).catch(() => process.exit(1));
" "$PG_URL" >/dev/null 2>&1; then
  PG_AVAILABLE=1
  echo "PostgreSQL: reachable. Mutations that need a server will be run."
else
  PG_AVAILABLE=0
  echo "PostgreSQL: NOT reachable. Mutation C will be reported NOT APPLICABLE."
fi
echo

KILLED=0
SURVIVED=0
NOT_APPLIED=0
NOT_APPLICABLE=0
declare -a RESULTS=()

# run_mutation <label> <description> <files-to-revert> <target-tests> <patch-command>
run_mutation() {
  local label="$1" description="$2" revert="$3" targets="$4" patch="$5"

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

  echo "  applied; running: $targets"
  if npx vitest run $targets >/tmp/p7-mutation-$label.log 2>&1; then
    echo "  SURVIVED — the targeted tests PASSED with the barrier removed."
    echo "  (log: /tmp/p7-mutation-$label.log)"
    SURVIVED=$((SURVIVED + 1))
    RESULTS+=("$label SURVIVED")
  else
    local failed
    failed=$(sed -e 's/\x1b\[[0-9;]*m//g' /tmp/p7-mutation-$label.log | grep -c "^ FAIL\|× ")
    echo "  KILLED — the targeted tests failed as required ($failed failing assertion line(s))."
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

# ---------------------------------------------------------------------------
# A — usage_counters removed from INSPECTED_TABLES.
#     The exact defect Phase 7 found. Must be caught without a database.
# ---------------------------------------------------------------------------
run_mutation A \
  "INSPECTED_TABLES forgets usage_counters again" \
  "$PGDRIVER" \
  "$COVERAGE $PGTEST" \
  "perl -0pi -e 's/^  \"usage_counters\",\n//m' $PGDRIVER && grep -q 'identity_tokens' $PGDRIVER && ! grep -q '\"usage_counters\",' $PGDRIVER"

# ---------------------------------------------------------------------------
# B — identity_tokens removed from INSPECTED_TABLES.
#     The second table that was missing. Separate mutation because a guard that
#     only knows about one of the two is not a guard on the list.
# ---------------------------------------------------------------------------
run_mutation B \
  "INSPECTED_TABLES forgets identity_tokens again" \
  "$PGDRIVER" \
  "$COVERAGE $PGTEST" \
  "perl -0pi -e 's/^  \"identity_tokens\",\n//m' $PGDRIVER && ! grep -q '\"identity_tokens\",' $PGDRIVER"

# ---------------------------------------------------------------------------
# C — migration 011 emits nothing on PostgreSQL, leaving updated_at as text.
#     Only a live server can see this, so it is NOT APPLICABLE without one.
# ---------------------------------------------------------------------------
if [ "$PG_AVAILABLE" = "1" ]; then
  run_mutation C \
    "migration 011 stops converting updated_at on PostgreSQL" \
    "$MIG011" \
    "$PGTEST" \
    "perl -0pi -e 's/if \(schema\.dialect === \"sqlite\"\) return \[\];/return [];/' $MIG011 && grep -q 'return \[\];' $MIG011"
else
  echo "=============================================================="
  echo "MUTATION C — migration 011 stops converting updated_at"
  echo "=============================================================="
  echo "  NOT APPLICABLE: no PostgreSQL server reachable, and the only test that"
  echo "  can observe a column type needs one. Not counted as KILLED."
  NOT_APPLICABLE=$((NOT_APPLICABLE + 1))
  RESULTS+=("C NOT_APPLICABLE")
  echo
fi

# ---------------------------------------------------------------------------
# D — migration 011 renumbered onto an applied version.
#     The append-only rule, which is what keeps `assertHistoryMatches` able to
#     refuse a rewritten history at all.
# ---------------------------------------------------------------------------
run_mutation D \
  "migration 011 is renumbered as version 7, rewriting applied history" \
  "$MIG011" \
  "$COVERAGE" \
  "perl -0pi -e 's/  version: 11,/  version: 7,/' $MIG011 && grep -q 'version: 7,' $MIG011"

# ---------------------------------------------------------------------------
# E — the policy engine stops blocking a non-active agent.
#     Kills the lifecycle test's DRAFT and PAUSED refusals. If this survived,
#     those refusals would be measuring something else.
# ---------------------------------------------------------------------------
run_mutation E \
  "the policy engine lets a draft or paused agent act" \
  "$ENGINE" \
  "$LIFECYCLE" \
  "perl -0pi -e 's/(agent\.status !== \"active\")/false \&\& \$1/' $ENGINE && grep -q 'false && agent.status' $ENGINE"

# ---------------------------------------------------------------------------
# F — the write schema refuses `active`, recreating the deadlock directly.
#     A draft agent that can never be activated is the failure the brief names.
# ---------------------------------------------------------------------------
run_mutation F \
  "the PATCH /api/agents/:id schema refuses status=active, recreating the DRAFT deadlock" \
  "$ROUTES" \
  "$LIFECYCLE" \
  "perl -0pi -e 's/z\.enum\(\[\"active\", \"paused\", \"draft\", \"review\"\]\)\.optional\(\)/z.enum([\"paused\", \"draft\", \"review\"]).optional()/' $ROUTES && ! grep -q 'z.enum(\[\"active\", \"paused\", \"draft\", \"review\"\]).optional()' $ROUTES"

# ---------------------------------------------------------------------------
# G — the downstream boundary. Run against the downstream scenario suites for
#     the reason set out in the header: the lifecycle test cannot kill it,
#     because the `!execution` half of the same condition stops a BLOCK first.
# ---------------------------------------------------------------------------
run_mutation G \
  "the gateway dispatches downstream even when the decision is not ALLOW" \
  "$GATEWAY" \
  "$DOWNSTREAM $LIFECYCLE" \
  "perl -0pi -e 's/(decision !== \"ALLOW\")/false \&\& \$1/' $GATEWAY && grep -q 'false && decision' $GATEWAY"

echo "=============================================================="
echo "PHASE 7 MUTATION SUMMARY"
echo "=============================================================="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo
echo "  KILLED         $KILLED"
echo "  SURVIVED       $SURVIVED"
echo "  NOT APPLIED    $NOT_APPLIED"
echo "  NOT APPLICABLE $NOT_APPLICABLE"
echo

if [ "$SURVIVED" -gt 0 ] || [ "$NOT_APPLIED" -gt 0 ]; then
  echo "RESULT: not clean. A SURVIVED mutation means the claim it covers is"
  echo "unevidenced; a NOT APPLIED mutation means nothing was measured at all."
  exit 1
fi
echo "RESULT: every applied mutation was killed."
