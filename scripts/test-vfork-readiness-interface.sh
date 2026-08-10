#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
gate="$repo_root/scripts/run-vfork-readiness.sh"
expected="usage: scripts/run-vfork-readiness.sh mechanism|integration"

assert_extra_argument_rejected() {
  local mode="$1"
  local output status
  set +e
  output="$(cd "$repo_root/host" && "$gate" "$mode" unexpected 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 2 ]; then
    echo "expected $mode plus an extra argument to exit 2, got $status" >&2
    exit 1
  fi
  if [ "$output" != "$expected" ]; then
    echo "unexpected $mode plus an extra argument output: $output" >&2
    exit 1
  fi
}

assert_extra_argument_rejected mechanism
assert_extra_argument_rejected integration
echo "test-vfork-readiness-interface.sh: passed"
