#!/usr/bin/env bash
# Phase 9 verification harness.
#
# WHY THIS EXISTS
# ---------------
# `npx vitest run` runs 86 files in one worker (`fileParallelism: false`). On a
# 2-vCPU machine one hanging file therefore stalls the entire suite with no
# indication of which file it was: the run simply stops producing output. That
# is exactly what happened on the first Phase 9 baseline attempt, and a suite
# whose failure mode is "no result at all" cannot be used as evidence.
#
# This runner executes each file as its own vitest invocation under `timeout`,
# so a hang is attributed to a file, bounded in time, and reported as TIMEOUT
# rather than silently swallowing every other file's result. Slower in wall
# clock, but it produces a per-file record instead of a single opaque verdict.
#
# Output: one line per file in $OUT, plus a machine-readable summary.
set -uo pipefail

OUT="${OUT:-/tmp/suite-per-file.txt}"
PER_FILE_TIMEOUT="${PER_FILE_TIMEOUT:-240}"

: > "$OUT"

mapfile -t FILES < <(
  find shared server client sdk cli examples -name '*.test.ts' 2>/dev/null | sort
)

pass_files=0
fail_files=0
timeout_files=0
total_tests=0
failed_tests=0

for f in "${FILES[@]}"; do
  log="$(mktemp)"
  timeout "$PER_FILE_TIMEOUT" npx vitest run "$f" --reporter=dot --testTimeout=20000 \
    > "$log" 2>&1
  code=$?
  plain="$(sed -e 's/\x1b\[[0-9;]*m//g' "$log")"
  # `Tests  12 passed (12)` / `Tests  1 failed | 11 passed (12)`
  line="$(printf '%s' "$plain" | grep -E '^ *Tests +' | tail -1)"
  n_pass="$(printf '%s' "$line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || true)"
  n_fail="$(printf '%s' "$line" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || true)"
  n_pass="${n_pass:-0}"; n_fail="${n_fail:-0}"
  total_tests=$(( total_tests + n_pass + n_fail ))
  failed_tests=$(( failed_tests + n_fail ))

  if [ "$code" -eq 124 ]; then
    timeout_files=$(( timeout_files + 1 ))
    echo "TIMEOUT  $f  (>${PER_FILE_TIMEOUT}s)" >> "$OUT"
    cp "$log" "/tmp/timeout-$(basename "$f").log"
  elif [ "$code" -eq 0 ]; then
    pass_files=$(( pass_files + 1 ))
    echo "PASS     $f  ${n_pass} tests" >> "$OUT"
  else
    fail_files=$(( fail_files + 1 ))
    echo "FAIL     $f  exit=${code} ${n_fail} failed / ${n_pass} passed" >> "$OUT"
    cp "$log" "/tmp/fail-$(basename "$f").log"
  fi
  rm -f "$log"
done

{
  echo "---"
  echo "FILES_PASS=$pass_files"
  echo "FILES_FAIL=$fail_files"
  echo "FILES_TIMEOUT=$timeout_files"
  echo "TESTS_TOTAL=$total_tests"
  echo "TESTS_FAILED=$failed_tests"
} >> "$OUT"

cat "$OUT"
[ "$fail_files" -eq 0 ] && [ "$timeout_files" -eq 0 ]
