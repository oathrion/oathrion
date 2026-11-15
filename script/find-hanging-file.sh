#!/usr/bin/env bash
# Bisection helper for P9-2: `npm test` printed its summary and then never
# exited. A leaked handle keeps the event loop alive after the last test has
# finished, and vitest's reporter gives no hint which module owns it.
#
# Strategy: binary-search the smallest PREFIX of the (sorted) file list whose
# run fails to terminate. If one module owns the handle, that property is
# monotonic in the prefix length, so log2(86) ≈ 7 runs identify it.
#
# The whole 86-file suite completes its assertions in ~75s on this machine, so a
# run still alive at TERM_TIMEOUT is not slow, it is stuck.
set -uo pipefail

TERM_TIMEOUT="${TERM_TIMEOUT:-150}"

mapfile -t ALL < <(find shared server client sdk cli examples -name '*.test.ts' | sort)
total=${#ALL[@]}
echo "total ${total} files, per-run timeout ${TERM_TIMEOUT}s"

# Returns 0 when the run TERMINATED, 1 when it hung.
terminates() {
  local -a subset=("$@")
  timeout "$TERM_TIMEOUT" npx vitest run "${subset[@]}" --reporter=dot \
    > /tmp/bisect.log 2>&1
  local code=$?
  [ "$code" -ne 124 ]
}

if terminates "${ALL[@]}"; then
  echo "WHOLE SET TERMINATED — nothing to bisect"
  exit 0
fi
echo "whole set: HANGS"

lo=1        # smallest prefix length not yet known to terminate
hi=$total   # known to hang
while [ "$lo" -lt "$hi" ]; do
  mid=$(( (lo + hi) / 2 ))
  echo "trying prefix n=${mid} ..."
  if terminates "${ALL[@]:0:mid}"; then
    echo "  n=${mid}: terminates"
    lo=$(( mid + 1 ))
  else
    echo "  n=${mid}: HANGS"
    hi=$mid
  fi
done

echo "SMALLEST HANGING PREFIX: n=${hi}"
echo "CULPRIT (last file of that prefix): ${ALL[$((hi-1))]}"
