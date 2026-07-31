#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-homebrew-public-chromium-proof-recovery-workflow.rb"
WORKFLOW="$REPO_ROOT/.github/workflows/homebrew-public-chromium-proof-recovery.yml"
LOCK="$REPO_ROOT/homebrew/public-proof-recovery-lock.json"
RUNNER="$REPO_ROOT/homebrew/test/run_homebrew_guest_browser_shipping_scope.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

ruby "$CHECK"

expect_workflow_rejected() {
  local fixture="$1"
  if ruby "$CHECK" "$fixture" "$LOCK" "$RUNNER" >/dev/null 2>&1; then
    echo "Chromium checker accepted invalid workflow: $fixture" >&2
    exit 1
  fi
}

expect_lock_rejected() {
  local fixture="$1"
  if ruby "$CHECK" "$WORKFLOW" "$fixture" "$RUNNER" >/dev/null 2>&1; then
    echo "Chromium checker accepted invalid lock: $fixture" >&2
    exit 1
  fi
}

expect_runner_rejected() {
  local fixture="$1"
  if ruby "$CHECK" "$WORKFLOW" "$LOCK" "$fixture" >/dev/null 2>&1; then
    echo "Chromium checker accepted invalid runner: $fixture" >&2
    exit 1
  fi
}

sed 's/contents: read/contents: write/' \
  "$WORKFLOW" >"$TMP_ROOT/write-permission.yml"
expect_workflow_rejected "$TMP_ROOT/write-permission.yml"

sed '/name: homebrew-public-browser-runtime-handoff/a\
          run-id: 1' "$WORKFLOW" >"$TMP_ROOT/cross-run.yml"
expect_workflow_rejected "$TMP_ROOT/cross-run.yml"

sed '/          - canary/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-canary.yml"
expect_workflow_rejected "$TMP_ROOT/no-canary.yml"

sed '/- name: Verify the exact browser handoff/a\
      - name: Rebuild on the consumer\
        run: bash scripts/dev-shell.sh ./run.sh prepare-browser' \
  "$WORKFLOW" >"$TMP_ROOT/rebuild-in-proof.yml"
expect_workflow_rejected "$TMP_ROOT/rebuild-in-proof.yml"

sed '/env -u GH_TOKEN -u GITHUB_TOKEN/d' \
  "$WORKFLOW" >"$TMP_ROOT/credentialed-readback.yml"
expect_workflow_rejected "$TMP_ROOT/credentialed-readback.yml"

sed 's/timeout-minutes: 25/timeout-minutes: 26/' \
  "$WORKFLOW" >"$TMP_ROOT/long-guest.yml"
expect_workflow_rejected "$TMP_ROOT/long-guest.yml"

jq '.mirror.immutable = false' \
  "$LOCK" >"$TMP_ROOT/mutable-mirror.json"
expect_lock_rejected "$TMP_ROOT/mutable-mirror.json"

jq '.mirror.asset_count -= 1' \
  "$LOCK" >"$TMP_ROOT/wrong-mirror-count.json"
expect_lock_rejected "$TMP_ROOT/wrong-mirror-count.json"

sed '/baseline_oom=/d' \
  "$RUNNER" >"$TMP_ROOT/no-oom-baseline.sh"
expect_runner_rejected "$TMP_ROOT/no-oom-baseline.sh"

sed 's/final_oom > baseline_oom/final_oom < baseline_oom/' \
  "$RUNNER" >"$TMP_ROOT/reversed-oom-check.sh"
expect_runner_rejected "$TMP_ROOT/reversed-oom-check.sh"

echo "test-homebrew-public-chromium-proof-recovery-workflow.sh: ok"
