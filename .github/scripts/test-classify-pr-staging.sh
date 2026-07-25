#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLASSIFIER="$SCRIPT_DIR/classify-pr-staging.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

assert_decision() {
  local name="$1"
  local expected="$2"
  local state="$3"
  local merged_at="$4"
  local labels="$5"
  local fixture="$TMP_ROOT/$name.json"

  jq -n \
    --arg state "$state" \
    --argjson merged_at "$merged_at" \
    --argjson labels "$labels" \
    '{state:$state,mergedAt:$merged_at,labels:$labels}' >"$fixture"
  actual="$(bash "$CLASSIFIER" "$fixture")"
  if [ "$actual" != "$expected" ]; then
    echo "$name: expected $expected, got $actual" >&2
    exit 1
  fi
}

assert_decision open retain-open OPEN null '[]'
assert_decision open-labeled retain-open OPEN null \
  '[{"name":"retain-package-staging"}]'
assert_decision merged-labeled retain-merged MERGED '"2026-07-25T12:00:00Z"' \
  '[{"name":"retain-package-staging"}]'
assert_decision closed-merged-labeled retain-merged CLOSED '"2026-07-25T12:00:00Z"' \
  '[{"name":"retain-package-staging"}]'
assert_decision merged-unlabeled delete MERGED '"2026-07-25T12:00:00Z"' '[]'
assert_decision merged-similar-label delete MERGED '"2026-07-25T12:00:00Z"' \
  '[{"name":"retain-package-staging-later"}]'
assert_decision abandoned-labeled delete CLOSED null \
  '[{"name":"retain-package-staging"}]'
assert_decision abandoned delete CLOSED null '[]'

for malformed in \
  '[]' \
  '{"state":"UNKNOWN","mergedAt":null,"labels":[]}' \
  '{"state":"OPEN","mergedAt":null}' \
  '{"state":"MERGED","mergedAt":17,"labels":[{"name":"retain-package-staging"}]}' \
  '{"state":"MERGED","mergedAt":"2026-07-25T12:00:00Z","labels":["retain-package-staging"]}'
do
  printf '%s\n' "$malformed" >"$TMP_ROOT/malformed.json"
  if bash "$CLASSIFIER" "$TMP_ROOT/malformed.json" >/dev/null 2>&1; then
    echo "malformed PR state was accepted: $malformed" >&2
    exit 1
  fi
done

if bash "$CLASSIFIER" "$TMP_ROOT/missing.json" >/dev/null 2>&1; then
  echo "missing PR state was accepted" >&2
  exit 1
fi

echo "PR staging classification tests passed"
