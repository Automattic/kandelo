#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-homebrew-public-node-proof-recovery-workflow.rb"
WORKFLOW="$REPO_ROOT/.github/workflows/homebrew-public-node-proof-recovery.yml"
LOCK="$REPO_ROOT/homebrew/public-proof-recovery-lock.json"
RUNNER="$REPO_ROOT/homebrew/test/run_homebrew_guest_shipping_scope.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

ruby "$CHECK"

expect_workflow_rejected() {
  local fixture="$1"
  if ruby "$CHECK" "$fixture" "$LOCK" "$RUNNER" >/dev/null 2>&1; then
    echo "recovery checker accepted invalid workflow: $fixture" >&2
    exit 1
  fi
}

expect_lock_rejected() {
  local fixture="$1"
  if ruby "$CHECK" "$WORKFLOW" "$fixture" "$RUNNER" >/dev/null 2>&1; then
    echo "recovery checker accepted invalid lock: $fixture" >&2
    exit 1
  fi
}

sed '/  workflow_dispatch:/i\
  pull_request:' "$WORKFLOW" >"$TMP_ROOT/automatic-pr-proof.yml"
expect_workflow_rejected "$TMP_ROOT/automatic-pr-proof.yml"

sed 's/contents: read/contents: write/' \
  "$WORKFLOW" >"$TMP_ROOT/write-permission.yml"
expect_workflow_rejected "$TMP_ROOT/write-permission.yml"

sed '/name: homebrew-public-node-runtime-handoff/a\
          run-id: 1' "$WORKFLOW" >"$TMP_ROOT/cross-run.yml"
expect_workflow_rejected "$TMP_ROOT/cross-run.yml"

sed '/          - shipping-canary/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-canary.yml"
expect_workflow_rejected "$TMP_ROOT/no-canary.yml"

sed 's/timeout-minutes: 20/timeout-minutes: 21/' \
  "$WORKFLOW" >"$TMP_ROOT/long-guest.yml"
expect_workflow_rejected "$TMP_ROOT/long-guest.yml"

# The mutation must match the literal runner expression.
# shellcheck disable=SC2016
sed 's/node "$node_entry"/node --expose-gc "$node_entry"/' \
  "$RUNNER" >"$TMP_ROOT/forced-gc-runner.sh"
if ruby "$CHECK" "$WORKFLOW" "$LOCK" \
  "$TMP_ROOT/forced-gc-runner.sh" >/dev/null 2>&1; then
  echo "recovery checker accepted forced guest GC" >&2
  exit 1
fi

sed '/- name: Verify runtime and fetch immutable public inputs/a\
      - name: Reinstall npm dependencies in proof\
        run: npm ci' "$WORKFLOW" >"$TMP_ROOT/npm-in-proof.yml"
expect_workflow_rejected "$TMP_ROOT/npm-in-proof.yml"

sed 's#\./\.github/actions/setup-nix#DeterminateSystems/nix-installer-action@main#' \
  "$WORKFLOW" >"$TMP_ROOT/direct-nix-action.yml"
expect_workflow_rejected "$TMP_ROOT/direct-nix-action.yml"

# The mutation must match the literal workflow expression.
# shellcheck disable=SC2016
sed '\#cd "$GITHUB_WORKSPACE/product"#d' \
  "$WORKFLOW" >"$TMP_ROOT/unpinned-builder-node.yml"
expect_workflow_rejected "$TMP_ROOT/unpinned-builder-node.yml"

sed '/env -u GH_TOKEN -u GITHUB_TOKEN/d' \
  "$WORKFLOW" >"$TMP_ROOT/credentialed-readback.yml"
expect_workflow_rejected "$TMP_ROOT/credentialed-readback.yml"

jq '.release.immutable = false' \
  "$LOCK" >"$TMP_ROOT/mutable-release.json"
expect_lock_rejected "$TMP_ROOT/mutable-release.json"

jq '.release.assets["main-shell.vfs.zst"].bytes += 1' \
  "$LOCK" >"$TMP_ROOT/wrong-image-size.json"
expect_lock_rejected "$TMP_ROOT/wrong-image-size.json"

echo "test-homebrew-public-node-proof-recovery-workflow.sh: ok"
