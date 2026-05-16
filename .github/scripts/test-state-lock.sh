#!/usr/bin/env bash
# Test that state-lock.sh respects the <subject> positional arg
# by mapping it into a per-subject git ref.
#
# Dry-run test (no remote operations); the script must support
# STATE_LOCK_DRY_RUN=1 to print the ref it would use and exit 0.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/state-lock.sh"

fail=0

test_subject_maps_to_ref() {
  local subject="$1"
  local expected_ref="$2"
  local actual_ref
  actual_ref=$(STATE_LOCK_DRY_RUN=1 bash "$SCRIPT" acquire "$subject" 2>&1 | grep -oE 'refs/heads/[^ ]+' | head -1)
  if [ "$actual_ref" != "$expected_ref" ]; then
    echo "FAIL: subject=$subject expected_ref=$expected_ref actual=$actual_ref" >&2
    fail=1
    return 1
  fi
  echo "PASS: subject=$subject → $actual_ref"
}

test_subject_maps_to_ref "durable-release" "refs/heads/github-actions/state-lock/durable-release"
test_subject_maps_to_ref "binaries-abi-v8" "refs/heads/github-actions/state-lock/binaries-abi-v8"
test_subject_maps_to_ref "pr-423-staging"  "refs/heads/github-actions/state-lock/pr-423-staging"

exit "$fail"
