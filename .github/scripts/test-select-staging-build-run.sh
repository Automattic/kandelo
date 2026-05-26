#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FILTER="$REPO_ROOT/.github/scripts/select-staging-build-run.jq"

fail=0

test_case() {
  local name="$1"
  local input="$2"
  local expected_state="$3"
  local expected_run_id="${4:-}"
  local actual
  local state
  local run_id

  actual=$(jq -c -f "$FILTER" <<<"$input")
  state=$(jq -r '.state' <<<"$actual")
  run_id=$(jq -r '.run_id' <<<"$actual")

  if [ "$state" != "$expected_state" ] || [ "$run_id" != "$expected_run_id" ]; then
    echo "FAIL: $name" >&2
    echo "  expected state=$expected_state run_id=$expected_run_id" >&2
    echo "  actual   state=$state run_id=$run_id" >&2
    echo "  output:  $actual" >&2
    fail=1
    return
  fi

  echo "PASS: $name -> state=$state run_id=$run_id"
}

test_case \
  "successful real run proceeds" \
  '[{"databaseId":101,"status":"completed","conclusion":"success","createdAt":"2026-05-26T10:00:00Z"}]' \
  "real_success" \
  "101"

test_case \
  "failed real run behind newer skipped label event blocks" \
  '[{"databaseId":202,"status":"completed","conclusion":"skipped","createdAt":"2026-05-26T10:02:00Z"},{"databaseId":201,"status":"completed","conclusion":"failure","createdAt":"2026-05-26T10:01:00Z"},{"databaseId":200,"status":"completed","conclusion":"success","createdAt":"2026-05-26T10:00:00Z"}]' \
  "real_failed" \
  "201"

test_case \
  "newer successful real rerun supersedes older failure" \
  '[{"databaseId":503,"status":"completed","conclusion":"skipped","createdAt":"2026-05-26T10:03:00Z"},{"databaseId":502,"status":"completed","conclusion":"success","createdAt":"2026-05-26T10:02:00Z"},{"databaseId":501,"status":"completed","conclusion":"failure","createdAt":"2026-05-26T10:01:00Z"}]' \
  "real_success" \
  "502"

test_case \
  "in-progress real run is waited on" \
  '[{"databaseId":301,"status":"in_progress","conclusion":null,"createdAt":"2026-05-26T10:01:00Z"},{"databaseId":300,"status":"completed","conclusion":"skipped","createdAt":"2026-05-26T10:00:00Z"}]' \
  "real_in_progress" \
  "301"

test_case \
  "only skipped ready-to-ship run falls through to prepare-merge validation" \
  '[{"databaseId":401,"status":"completed","conclusion":"skipped","createdAt":"2026-05-26T10:00:00Z"}]' \
  "only_skipped"

test_case \
  "no staging run exists falls through to prepare-merge validation" \
  '[]' \
  "no_runs"

exit "$fail"
