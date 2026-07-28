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
sed '/lifecycle-artifact-digest:/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-lifecycle-digest.yml"
expect_rejected "$TMP_ROOT/no-lifecycle-digest.yml"
sed 's/homebrew-guest-lifecycle-inputs-handoff/homebrew-guest-lifecycle-inputs-cache/g' \
  "$WORKFLOW" >"$TMP_ROOT/renamed-lifecycle-handoff.yml"
expect_rejected "$TMP_ROOT/renamed-lifecycle-handoff.yml"
sed '/name: homebrew-main-shell-mirror-handoff/a\
          run-id: 123' "$WORKFLOW" >"$TMP_ROOT/cross-run.yml"
expect_rejected "$TMP_ROOT/cross-run.yml"
sed '/scripts\/create-homebrew-guest-lifecycle-fixture.ts/,/--out "$fixture"/{
  s/--transport-mode public/--transport-mode closed/
}' \
  "$WORKFLOW" >"$TMP_ROOT/closed-proof.yml"
expect_rejected "$TMP_ROOT/closed-proof.yml"
sed '/- name: Prove public shell and live tap lifecycle in Chromium/,/run: |/{
  /        env:/a\
          VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT: /tmp/closed-inputs
}' "$WORKFLOW" >"$TMP_ROOT/closed-browser-env.yml"
expect_rejected "$TMP_ROOT/closed-browser-env.yml"
sed 's#--manifest "$lifecycle/publish.json"#--manifest "$handoff/publish.json"#' \
  "$WORKFLOW" >"$TMP_ROOT/lifecycle-published-as-mirror.yml"
expect_rejected "$TMP_ROOT/lifecycle-published-as-mirror.yml"
awk '
  /bash kandelo\/scripts\/publish-immutable-github-release\.sh/ {
    publishers += 1
    if (publishers == 2) {
      sub(/bash kandelo\/scripts\/publish-immutable-github-release\.sh/,
          "true # omitted second immutable publisher")
    }
  }
  { print }
' "$WORKFLOW" >"$TMP_ROOT/no-lifecycle-publisher.yml"
expect_rejected "$TMP_ROOT/no-lifecycle-publisher.yml"
sed 's/(.assets | length) == 4/(.assets | length) == 3/' \
  "$WORKFLOW" >"$TMP_ROOT/wrong-lifecycle-asset-count.yml"
expect_rejected "$TMP_ROOT/wrong-lifecycle-asset-count.yml"
sed 's|cmp "$lifecycle/$name" "$RUNNER_TEMP/public-$name"|true|' \
  "$WORKFLOW" >"$TMP_ROOT/no-lifecycle-public-compare.yml"
expect_rejected "$TMP_ROOT/no-lifecycle-public-compare.yml"
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
