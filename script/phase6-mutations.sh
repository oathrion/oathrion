#!/usr/bin/env bash
#
# Mutation checks for the Phase 6 credential -> agent barriers.
#
# A green suite proves the binding code exists. It does not prove any test
# depends on it. This script removes one barrier at a time and REQUIRES the
# targeted tests to fail; a mutation that leaves them green is SURVIVED, which
# means the corresponding claim in PHASE-6-REPORT.md is not evidenced and must
# not be written as though it were.
#
# THREE OUTCOMES, NOT TWO
# -----------------------
# Applying a mutation is itself fallible: these are textual patches against real
# source, and source moves. A failed application counted as SURVIVED would be
# the worst possible reading — it would report a barrier as unprotected when
# nothing had in fact been changed. Worse, a failed application counted as
# KILLED would report a barrier as proven when nothing had been changed either.
#
# So application is verified independently of the test result, twice:
#   1. the patch script must exit 0 (its own assertions on match counts), and
#   2. `git diff --quiet` must show the tree ACTUALLY changed.
#
# Check 2 is stronger than what `script/phase5-mutations.sh` did. The Phase 5
# harness already separated NOT APPLIED from SURVIVED via the patch exit code,
# which was correct, but a patch that exited 0 without editing anything would
# still have been counted as applied. That gap was theoretical there — every
# Phase 5 patch asserted its match count — and it is closed here rather than
# left to be relied upon.
#
# HONEST STRUCTURE OF THESE SEVEN MUTATIONS
# ----------------------------------------
# The brief names seven mutations, A through G. They are NOT seven independent
# barriers, and reporting them that way would inflate the result. The truth:
#
#   A, B, F  -> all three live in `resolveActingAgent()`. One function, three
#               different ways to break it (honour the requested id; collapse
#               confinement to org level; treat a bound credential as unbound).
#   C, G     -> both target the MCP path. C removes the chokepoint call; G lets
#               the `X-Oathrion-Agent-Id` header win at the lookup afterwards.
#   D        -> the three HTTP decision endpoints, at their call sites.
#   E        -> the retry endpoint, which is a genuinely separate barrier
#               (`mayActOnExecution`) because a retry names no agent at all.
#
# So: four distinct enforcement sites, exercised through seven mutations. That
# is the claim the report makes.
#
# Every mutation is reverted with `git checkout --` before the next runs, and
# the script refuses to start on a dirty tree so a failed revert can never be
# mistaken for a real edit.
#
# Usage: bash script/phase6-mutations.sh

set -uo pipefail
cd "$(dirname "$0")/.."

BINDING="server/identity/agent-binding.ts"
ROUTES="server/routes.ts"
MCP="server/mcp/router.ts"

ADV="server/test/agent-binding-adversarial.test.ts"
STRUCT="server/test/agent-binding-single-path.test.ts"
LIFE="server/test/identity-lifecycle.test.ts"
SESSION="server/test/session-credential-binding.test.ts"

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

# Records whether the preceding patch actually changed the tree.
# Two independent conditions: the patch exited 0, AND the files really differ.
check_applied() {
  local status="$1"
  local name="$2"
  shift 2
  applied=1
  if [ "$status" -ne 0 ]; then
    report_not_applied "$name" "the patch script refused: pattern no longer matches the source"
    return
  fi
  if git diff --quiet -- "$@"; then
    report_not_applied "$name" "the patch exited 0 but the tree is unchanged: nothing was mutated"
    return
  fi
}

report_not_applied() {
  echo ""
  echo "------------------------------------------------------------------"
  echo "MUTATION: $1"
  echo "------------------------------------------------------------------"
  echo "  RESULT: NOT APPLIED  <- $2"
  echo "          This is a broken check, NOT a surviving mutation, and it is"
  echo "          NOT a killed one either. The barrier was not tested at all."
  errored=$((errored + 1))
  applied=0
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
  if ./node_modules/.bin/vitest run "$@" >/tmp/p6-mutation.log 2>&1; then
    echo "  RESULT: SURVIVED  <- the barrier is NOT load-bearing; no test depends on it"
    survived=$((survived + 1))
  else
    echo "  RESULT: KILLED    <- removing the barrier breaks the suite, as it must"
    killed=$((killed + 1))
    # Vitest colours its output, so strip escapes before matching, otherwise the
    # evidence is invisible and the summary looks unsupported.
    sed -r 's/\x1B\[[0-9;]*[mGKH]//g' /tmp/p6-mutation.log > /tmp/p6-mutation.txt
    grep -E "^ +Tests +" /tmp/p6-mutation.txt | tail -1 | sed 's/^ */          /'
    grep -E "^ +(×|x) " /tmp/p6-mutation.txt | head -5 |
      sed -r 's/^ *(×|x) /          broke: /'
  fi
  # shellcheck disable=SC2086
  git checkout -- $revert
}

echo "=================================================================="
echo "Phase 6 mutation checks - credential -> agent barriers"
echo "Seven mutations across four enforcement sites. Every one MUST be KILLED."
echo "=================================================================="

# ---------------------------------------------------------------------------
# A. The bound-vs-requested comparison stops refusing.
#
# The single most important line of Phase 6. A credential bound to agt_billing
# that names agt_sales gets to BE agt_sales. Note the mutation keeps the equal
# path intact, so the legitimate case still works and only the refusal is gone -
# which is what a careless "simplification" would actually look like.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/identity/agent-binding.ts")
s = p.read_text()
old = """    if (asked === null || asked === bound) {
      return { ok: true, agentId: bound, bound: true };
    }"""
if s.count(old) != 1:
    sys.exit(f"expected exactly one bound-vs-asked comparison, found {s.count(old)}")
new = old + """
    return { ok: true, agentId: asked, bound: true };"""
p.write_text(s.replace(old, new))
PATCH
check_applied $? "A: bound-vs-requested comparison honours the requested id" "$BINDING"
run_mutation "A: bound-vs-requested comparison honours the requested id" "$BINDING" "$ADV"

# ---------------------------------------------------------------------------
# B. Confinement collapses from credential->agent to credential->organization.
#
# The distinct failure this guards against: someone decides tenant scoping is
# "enough", since the caller can only ever name agents in its own org anyway.
# It is not enough - that is precisely the difference between an org boundary
# and an agent boundary, and it is the whole point of the phase.
#
# Removes the refusal branch outright rather than reordering it, so a bound
# credential behaves exactly like an org-scoped one.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/identity/agent-binding.ts")
s = p.read_text()
marker = "  if (bound) {"
if s.count(marker) != 1:
    sys.exit(f"expected exactly one bound branch, found {s.count(marker)}")
p.write_text(s.replace(marker, """  if (bound) {
    return { ok: true, agentId: asked ?? bound, bound: true };""", 1))
PATCH
check_applied $? "B: confinement collapses to org-only isolation" "$BINDING"
run_mutation "B: confinement collapses to org-only isolation" "$BINDING" "$ADV" "$LIFE"

# ---------------------------------------------------------------------------
# C. The MCP router stops calling the chokepoint.
#
# Restores the pre-Phase-6 behaviour exactly: trust the declared header, look up
# whatever it names. This is the regression to fear most, because it is not a
# deletion of a check - it is a plausible-looking simplification back to the
# code that was there before.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/mcp/router.ts")
s = p.read_text()
old = "  const outcome = resolveActingAgent(ctx.identity, ctx.declaredAgentId);"
if s.count(old) != 1:
    sys.exit(f"expected exactly one chokepoint call in the MCP router, found {s.count(old)}")
new = """  const outcome: { ok: true; agentId: string; bound: boolean } | { ok: false; refusal: "agent_not_declared"; reason: string } =
    ctx.declaredAgentId
      ? { ok: true, agentId: ctx.declaredAgentId, bound: false }
      : { ok: false, refusal: "agent_not_declared", reason: "No agent declared." };"""
p.write_text(s.replace(old, new))
PATCH
check_applied $? "C: MCP resolveAgent() bypasses the chokepoint" "$MCP"
run_mutation "C: MCP resolveAgent() bypasses the chokepoint" "$MCP" "$ADV" "$STRUCT"

# ---------------------------------------------------------------------------
# D. /api/decision, /api/execute and /api/evaluate use the caller's id directly.
#
# Patches the FIRST THREE call sites only, in source order - decision (1635),
# execute (1684), evaluate (1716) - leaving POST /api/executions (1804) intact.
# Targeting three of four deliberately: it proves the tests distinguish the
# routes instead of passing because some other route still refuses.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/routes.ts")
s = p.read_text()
old = "const agentId = actingAgent(req, res, parsed.data.agentId ?? null);"
new = "const agentId = parsed.data.agentId ?? null;"
if s.count(old) != 4:
    sys.exit(f"expected exactly four actingAgent call sites, found {s.count(old)}")
# Order matters: the first three occurrences are decision, execute, evaluate.
p.write_text(s.replace(old, new, 3))
PATCH
check_applied $? "D: decision/execute/evaluate bypass the binding check" "$ROUTES"
run_mutation "D: decision/execute/evaluate bypass the binding check" "$ROUTES" "$ADV" "$STRUCT"

# ---------------------------------------------------------------------------
# E. The retry endpoint stops checking who owns the execution.
#
# A separate barrier, not a variant of A: a retry names no agent, so nothing in
# `resolveActingAgent` ever sees the agent it is about to act as. The agent comes
# from the stored row. Without `mayActOnExecution`, a credential bound to
# agt_billing can re-dispatch agt_finance's failed transfer without ever
# uttering the word agt_finance.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/identity/agent-binding.ts")
s = p.read_text()
old = "  if (bound !== executionAgentId) {"
if s.count(old) != 1:
    sys.exit(f"expected exactly one execution-ownership comparison, found {s.count(old)}")
p.write_text(s.replace(old, "  if (false && bound !== executionAgentId) {"))
PATCH
check_applied $? "E: retry allows acting on another agent's execution" "$BINDING"
run_mutation "E: retry allows acting on another agent's execution" "$BINDING" "$ADV"

# ---------------------------------------------------------------------------
# F. A bound credential is read as unbound.
#
# Not the same bug as A. Here the comparison is untouched and still correct - it
# is simply never reached, because the credential's own binding is dropped on
# the floor. This is the shape of an ORM/serialisation regression: `agent_id`
# stops being selected, or stops being mapped onto the Identity, and every
# barrier above silently becomes a no-op while looking perfectly intact in the
# diff. It is the reason `schema-parity.test.ts` exists.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, sys
p = pathlib.Path("server/identity/agent-binding.ts")
s = p.read_text()
old = "  const bound = identity.agentId ?? null;\n  const asked ="
if s.count(old) != 1:
    sys.exit(f"expected exactly one binding read in resolveActingAgent, found {s.count(old)}")
p.write_text(s.replace(old, "  const bound: string | null = null;\n  const asked ="))
PATCH
check_applied $? "F: a bound credential is treated as unbound" "$BINDING"
run_mutation "F: a bound credential is treated as unbound" "$BINDING" "$ADV" "$SESSION"

# ---------------------------------------------------------------------------
# G. The spoofed X-Oathrion-Agent-Id header wins: the refusal is dropped AND the
#    header is used for the lookup.
#
# THE FIRST FORMULATION OF G WAS AN EQUIVALENT MUTANT. It is recorded here
# rather than deleted, because the wrong version passing quietly would have been
# the more likely outcome and the reasoning is the useful part.
#
# That version changed only the lookup:
#   findById(outcome.agentId) -> findById(ctx.declaredAgentId ?? outcome.agentId)
# and it SURVIVED twice. It could not do otherwise. By the time that line runs,
# `resolveActingAgent` has already returned, and it returns `ok` only when the
# requested id is null or equal to the bound id - so the header there is either
# null, in which case `??` falls through to the resolved id, or it is the very
# same string. There was nothing for a test to detect.
#
# The second attempt to kill it was also wrong, and measuring said so: a test
# was added sending "  agt_billing  " on the assumption the chokepoint's trim
# was the only normalisation and the mutation would therefore 404. It passed
# under the mutation too. The reason is that HTTP strips optional leading and
# trailing whitespace from a field value before Express ever sees it, so the
# padded header and the plain one are the same string by the time either code
# path runs. The chokepoint's trim is defence for non-HTTP callers, not for this.
#
# So G is reformulated to express the threat it was always meant to express -
# a spoofed header actually being honoured - which requires the REFUSAL to be
# dropped, not just the lookup rerouted. This version is non-equivalent and
# killable, which is the only kind of mutation worth counting.
#
# It is deliberately NOT the same as C: C deletes the chokepoint call, this
# keeps the call and ignores its answer. Both are plausible regressions and they
# fail in different ways - under C nothing is ever refused, under G the refusal
# is computed, logged-worthy, and then thrown away.
# ---------------------------------------------------------------------------
python3 - <<'PATCH'
import pathlib, re, sys
p = pathlib.Path("server/mcp/router.ts")
s = p.read_text()

lookup = "  const agent = await ctx.repositories.agents.findById(outcome.agentId);"
if s.count(lookup) != 1:
    sys.exit(f"expected exactly one agent lookup by resolved id, found {s.count(lookup)}")

# Drop the refusal: keep the chokepoint call, discard its verdict.
guard = re.search(r"\n  if \(!outcome\.ok\) \{.*?\n  \}\n", s, re.S)
if not guard:
    sys.exit("could not locate the !outcome.ok refusal block in resolveAgent()")
s = s[: guard.start()] + "\n" + s[guard.end() :]

# ...and honour the caller-declared header instead of the resolved id.
s = s.replace(
    lookup,
    "  const agent = await ctx.repositories.agents.findById(ctx.declaredAgentId ?? outcome.agentId);",
)
p.write_text(s)
PATCH
check_applied $? "G: the refusal is dropped and the spoofed header is honoured" "$MCP"
run_mutation "G: the refusal is dropped and the spoofed header is honoured" "$MCP" "$ADV" "$STRUCT"

echo ""
echo "=================================================================="
echo "KILLED:      $killed"
echo "SURVIVED:    $survived"
echo "NOT APPLIED: $errored"
if [ "$errored" -ne 0 ]; then
  echo ""
  echo "One or more mutations could not be applied, so those barriers were not"
  echo "tested at all. They are neither killed nor survived. Fix the patterns"
  echo "before reading anything into this run."
  exit 4
fi
if [ "$survived" -ne 0 ]; then
  echo ""
  echo "A SURVIVED mutation means a barrier has no test depending on it."
  echo "The corresponding claim must not be presented as evidenced."
  exit 1
fi
echo "Every credential -> agent barrier checked is load-bearing."
echo "=================================================================="

# Final integrity check: the tree must be exactly as it was.
if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: tree is dirty after the run - a revert did not take."
  git status --short
  exit 3
fi
