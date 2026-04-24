#!/usr/bin/env bash
# examples/libs/nodejs/test/run-mjsunit.sh — Phase 6 mjsunit pass-list.
#
# Runs every file in PASS_LIST through the Phase-5 host d8 using V8's
# mjsunit.js harness (provides assertTrue / assertFalse / assertThrows
# / assertEquals). Each test is expected to run to completion with
# exit 0 and empty stderr. The "experimental features" banner is dropped.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SRC="${HERE}/../build/node"
D8="${D8:-${NODE_SRC}/out/Release/d8}"
MJSUNIT_DIR="${NODE_SRC}/deps/v8/test/mjsunit"
if [ ! -x "$D8" ]; then
  echo "error: d8 not found or not executable at $D8" >&2
  echo "Run 'bash examples/libs/nodejs/build-v8-host-phase5.sh' first." >&2
  exit 1
fi
if [ ! -f "${MJSUNIT_DIR}/mjsunit.js" ]; then
  echo "error: mjsunit.js not found at ${MJSUNIT_DIR}" >&2
  exit 1
fi

# Pass-list grows as Phase 6 progresses. Each entry is a path relative
# to MJSUNIT_DIR. Adding a new entry requires its Torque builtins to be
# whitelisted and green through cctest + d8-smoke first.
PASS_LIST=(
  "array-isarray.js"
  "number-is.js"
)

cd "${MJSUNIT_DIR}"
pass=0; fail=0
for test in "${PASS_LIST[@]}"; do
  if [ ! -f "${test}" ]; then
    echo "[FAIL] ${test} — missing"; fail=$((fail+1)); continue
  fi
  # mjsunit.js must be loaded before the test file. Drop d8's
  # experimental-features banner (stderr) the same way d8-smoke.sh does.
  if output="$("${D8}" mjsunit.js "${test}" 2>/dev/null)"; then
    if [ -n "${output}" ]; then
      echo "[FAIL] ${test} — unexpected output"
      echo "       ${output}"
      fail=$((fail+1))
    else
      echo "[pass] ${test}"
      pass=$((pass+1))
    fi
  else
    rc=$?
    echo "[FAIL] ${test} — d8 exit ${rc}"
    "${D8}" mjsunit.js "${test}" 2>&1 | head -20 | sed 's/^/       /'
    fail=$((fail+1))
  fi
done
echo
echo "mjsunit: ${pass} passed, ${fail} failed"
[ "${fail}" = 0 ]
