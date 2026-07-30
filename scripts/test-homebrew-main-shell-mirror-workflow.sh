#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/reusable-homebrew-main-shell-mirror-publish.yml"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

ruby "$REPO_ROOT/scripts/check-homebrew-main-shell-mirror-workflow.rb"
python3 \
  "$REPO_ROOT/.github/scripts/test-check-homebrew-main-shell-release-locks.py"

expect_rejected() {
  local fixture="$1"
  if ruby "$REPO_ROOT/scripts/check-homebrew-main-shell-mirror-workflow.rb" \
    "$fixture" >/dev/null 2>&1; then
    echo "test-homebrew-main-shell-mirror-workflow: accepted $fixture" >&2
    exit 1
  fi
}

sed 's/contents: write/contents: read/' "$WORKFLOW" >"$TMP_ROOT/no-write.yml"
expect_rejected "$TMP_ROOT/no-write.yml"
sed 's/retention-days: 1/retention-days: 30/' \
  "$WORKFLOW" >"$TMP_ROOT/long-handoff.yml"
expect_rejected "$TMP_ROOT/long-handoff.yml"
sed '/name: homebrew-main-shell-mirror-handoff/a\
          run-id: 123' "$WORKFLOW" >"$TMP_ROOT/cross-run.yml"
expect_rejected "$TMP_ROOT/cross-run.yml"
sed 's/--transport-mode public/--transport-mode closed/' \
  "$WORKFLOW" >"$TMP_ROOT/closed-proof.yml"
expect_rejected "$TMP_ROOT/closed-proof.yml"
sed 's/--target-commitish "$TAP_AUTHORITY_REF"/--target-commitish "$TAP_CATALOG_REF"/' \
  "$WORKFLOW" >"$TMP_ROOT/catalog-as-authority.yml"
expect_rejected "$TMP_ROOT/catalog-as-authority.yml"
sed 's/--core-revision "$TAP_CATALOG_REF"/--core-revision "$TAP_AUTHORITY_REF"/' \
  "$WORKFLOW" >"$TMP_ROOT/authority-as-catalog.yml"
expect_rejected "$TMP_ROOT/authority-as-catalog.yml"
sed '/check-homebrew-main-shell-release-locks.py/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-structured-lock-check.yml"
expect_rejected "$TMP_ROOT/no-structured-lock-check.yml"
sed '/--package homebrew-bootstrap/d' \
  "$WORKFLOW" >"$TMP_ROOT/unfetched-direct-product.yml"
expect_rejected "$TMP_ROOT/unfetched-direct-product.yml"
sed '/      - name: Upload immutable publication receipt/i\
      - name: Injected write-capable command\
        shell: bash\
        run: echo unsafe' \
  "$WORKFLOW" >"$TMP_ROOT/extra-publish-step.yml"
expect_rejected "$TMP_ROOT/extra-publish-step.yml"
sed '/      - name: Check out exact tap authority/,/      - name: Check out exact Kandelo publisher/{
  s/persist-credentials: false/persist-credentials: true/
}' \
  "$WORKFLOW" >"$TMP_ROOT/persisted-publish-credentials.yml"
expect_rejected "$TMP_ROOT/persisted-publish-credentials.yml"
sed '/^concurrency:/i\
env:\
  BASH_ENV: /tmp/unreviewed-write-hook\
' "$WORKFLOW" >"$TMP_ROOT/workflow-env.yml"
expect_rejected "$TMP_ROOT/workflow-env.yml"

echo "test-homebrew-main-shell-mirror-workflow.sh: ok"
