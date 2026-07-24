#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/staging-finalization-outcome.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

run_case() {
  local name="$1" selected="$2" library="$3" program="$4" finalizer="$5" failures="$6"
  bash "$SCRIPT" \
    --matrix-selected "$selected" \
    --library-result "$library" \
    --program-result "$program" \
    --finalizer-result "$finalizer" \
    --had-failures "$failures" \
    --output "$TMP_ROOT/$name.json"
}

# Full success publishes one complete snapshot, runs tests, and leaves the
# package result green.
run_case success true success success success 0
jq -e '
  .publication_succeeded and .test_ready and
  (.artifact_failures | not) and .had_failures == 0
' "$TMP_ROOT/success.json" >/dev/null

# A partial matrix failure still runs tests against the successfully published
# exact fallback union. The later package-result job remains red.
run_case partial true failure success success 1
jq -e '
  .publication_succeeded and .test_ready and
  .artifact_failures and .had_failures == 1
' "$TMP_ROOT/partial.json" >/dev/null

# Publication failure never lets the test consumer claim it exercised the
# remote snapshot, even when every producer job was green.
run_case publication-failed true success success failure 0
jq -e '
  (.publication_succeeded | not) and (.test_ready | not) and
  (.artifact_failures | not)
' "$TMP_ROOT/publication-failed.json" >/dev/null

# A genuine zero-build reuse/runtime-only flow skips all package jobs but still
# permits the ordinary test gate.
run_case zero-build false skipped skipped skipped ""
jq -e '
  (.matrix_selected | not) and .finalization_ready and .test_ready
' "$TMP_ROOT/zero-build.json" >/dev/null

if run_case invalid true success success success ""; then
  echo "staging outcome accepted successful publication without finalizer evidence" >&2
  exit 1
fi

echo "staging finalization outcome tests passed"
