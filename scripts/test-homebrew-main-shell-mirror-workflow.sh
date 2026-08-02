#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/reusable-homebrew-main-shell-mirror-publish.yml"
NODE_SCOPE_RUNNER="$REPO_ROOT/homebrew/test/run_homebrew_guest_shipping_scope.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

ruby "$REPO_ROOT/scripts/check-homebrew-main-shell-mirror-workflow.rb"
python3 \
  "$REPO_ROOT/.github/scripts/test-check-homebrew-main-shell-release-locks.py"
bash "$REPO_ROOT/scripts/test-verify-browser-shell-vfs-asset.sh"

expect_rejected() {
  local fixture="$1"
  local node_scope_runner="${2:-$NODE_SCOPE_RUNNER}"
  if ruby "$REPO_ROOT/scripts/check-homebrew-main-shell-mirror-workflow.rb" \
    "$fixture" "$node_scope_runner" >/dev/null 2>&1; then
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
sed \
  's#bash kandelo/scripts/publish-immutable-github-release.sh#true#' \
  "$WORKFLOW" >"$TMP_ROOT/no-lifecycle-publisher.yml"
expect_rejected "$TMP_ROOT/no-lifecycle-publisher.yml"
sed \
  's#bash kandelo/scripts/verify-existing-immutable-github-release.sh#true#' \
  "$WORKFLOW" >"$TMP_ROOT/no-mirror-verifier.yml"
expect_rejected "$TMP_ROOT/no-mirror-verifier.yml"
sed \
  's#verify-existing-immutable-github-release.sh#publish-immutable-github-release.sh#' \
  "$WORKFLOW" >"$TMP_ROOT/republished-mirror.yml"
expect_rejected "$TMP_ROOT/republished-mirror.yml"
sed 's/(.assets | length) == 4/(.assets | length) == 3/' \
  "$WORKFLOW" >"$TMP_ROOT/wrong-lifecycle-asset-count.yml"
expect_rejected "$TMP_ROOT/wrong-lifecycle-asset-count.yml"
sed 's|cmp "$lifecycle/$name" "$RUNNER_TEMP/public-$name"|true|' \
  "$WORKFLOW" >"$TMP_ROOT/no-lifecycle-public-compare.yml"
expect_rejected "$TMP_ROOT/no-lifecycle-public-compare.yml"
sed 's/--target-commitish "$TAP_MIRROR_AUTHORITY_REF"/--target-commitish "$TAP_CATALOG_REF"/' \
  "$WORKFLOW" >"$TMP_ROOT/catalog-as-authority.yml"
expect_rejected "$TMP_ROOT/catalog-as-authority.yml"
sed 's/--core-revision "$TAP_CATALOG_REF"/--core-revision "$TAP_CALLER_AUTHORITY_REF"/' \
  "$WORKFLOW" >"$TMP_ROOT/authority-as-catalog.yml"
expect_rejected "$TMP_ROOT/authority-as-catalog.yml"
sed '/      mirror-authority-ref:/,/        default: ""/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-mirror-authority-input.yml"
expect_rejected "$TMP_ROOT/no-mirror-authority-input.yml"
sed '/      publication-mode:/,/        required: true/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-publication-mode.yml"
expect_rejected "$TMP_ROOT/no-publication-mode.yml"
sed 's/\[ -z "$REQUESTED_MIRROR_AUTHORITY_REF" \]/true/' \
  "$WORKFLOW" >"$TMP_ROOT/ta0-accepts-requested-authority.yml"
expect_rejected "$TMP_ROOT/ta0-accepts-requested-authority.yml"
sed "s/if: inputs.publication-mode == 'create-mirror'/if: inputs.publication-mode == 'publish-lifecycle'/" \
  "$WORKFLOW" >"$TMP_ROOT/ta0-publisher-runs-as-ta1.yml"
expect_rejected "$TMP_ROOT/ta0-publisher-runs-as-ta1.yml"
sed "s/if: inputs.publication-mode == 'publish-lifecycle'/if: inputs.publication-mode == 'create-mirror'/" \
  "$WORKFLOW" >"$TMP_ROOT/ta0-receives-lifecycle-inputs.yml"
expect_rejected "$TMP_ROOT/ta0-receives-lifecycle-inputs.yml"
sed '/      - name: Create and anonymously re-read the immutable mirror/,/      - name: Verify the existing mirror and publish only lifecycle inputs/{
  s/publish-immutable-github-release.sh/verify-existing-immutable-github-release.sh/
}' "$WORKFLOW" >"$TMP_ROOT/ta0-does-not-create-mirror.yml"
expect_rejected "$TMP_ROOT/ta0-does-not-create-mirror.yml"
sed '/      - name: Verify the existing mirror and publish only lifecycle inputs/,/      - name: Upload immutable mirror publication receipt/{
  s/verify-existing-immutable-github-release.sh/publish-immutable-github-release.sh/
}' "$WORKFLOW" >"$TMP_ROOT/ta1-republishes-mirror.yml"
expect_rejected "$TMP_ROOT/ta1-republishes-mirror.yml"
awk '
  /git -C tap-authority merge-base --is-ancestor/ {
    ancestry += 1
    if (ancestry == 2) {
      print "          true # omitted TA0 -> TA1 ancestry"
      getline
      next
    }
  }
  { print }
' "$WORKFLOW" >"$TMP_ROOT/no-caller-ancestry.yml"
expect_rejected "$TMP_ROOT/no-caller-ancestry.yml"
sed '/check-homebrew-main-shell-release-locks.py/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-structured-lock-check.yml"
expect_rejected "$TMP_ROOT/no-structured-lock-check.yml"
sed '/scripts\/prepare-homebrew-browser-bootstrap.sh/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-bottle-bootstrap-extractor.yml"
expect_rejected "$TMP_ROOT/no-bottle-bootstrap-extractor.yml"
sed \
  's#\$PWD/apps/browser-demos/public/homebrew-bootstrap.zip#programs/homebrew-bootstrap/homebrew-bootstrap.zip#' \
  "$WORKFLOW" >"$TMP_ROOT/registry-bootstrap-browser-proof.yml"
expect_rejected "$TMP_ROOT/registry-bootstrap-browser-proof.yml"
sed \
  '/      - name: Fetch musl submodule for browser source-build fallback/,/          submodules: libc\/musl/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-public-chromium-proof-musl.yml"
expect_rejected "$TMP_ROOT/no-public-chromium-proof-musl.yml"
sed \
  's/--fetch-only --package kernel/--fetch-only --package kernel --package shell/' \
  "$WORKFLOW" >"$TMP_ROOT/node-fetches-shell.yml"
expect_rejected "$TMP_ROOT/node-fetches-shell.yml"
sed '/npm --prefix host run build/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-compiled-node-worker.yml"
expect_rejected "$TMP_ROOT/no-compiled-node-worker.yml"
sed 's/memory.current/memory.stat/' \
  "$NODE_SCOPE_RUNNER" >"$TMP_ROOT/no-node-current-memory-telemetry.sh"
expect_rejected \
  "$WORKFLOW" "$TMP_ROOT/no-node-current-memory-telemetry.sh"
sed \
  's#homebrew/test/homebrew_guest_lifecycle_node.ts#scripts/homebrew-main-shell-node-smoke.ts#' \
  "$NODE_SCOPE_RUNNER" >"$TMP_ROOT/no-node-shipping-proof.sh"
expect_rejected "$WORKFLOW" "$TMP_ROOT/no-node-shipping-proof.sh"
sed '/--proof-mode "$scope"/d' \
  "$NODE_SCOPE_RUNNER" >"$TMP_ROOT/no-node-shipping-selection.sh"
expect_rejected "$WORKFLOW" "$TMP_ROOT/no-node-shipping-selection.sh"
awk '
  !inserted && /^bash scripts\/dev-shell\.sh npx tsx/ {
    print "exit 0"
    inserted = 1
  }
  { print }
  END { if (!inserted) exit 2 }
' "$NODE_SCOPE_RUNNER" >"$TMP_ROOT/early-success-node-scope.sh"
expect_rejected "$WORKFLOW" "$TMP_ROOT/early-success-node-scope.sh"
for scope in shipping-core shipping-canary; do
  sed "/^[[:space:]]*$scope[[:space:]]*$/d" \
    "$WORKFLOW" >"$TMP_ROOT/omitted-$scope.yml"
  expect_rejected "$TMP_ROOT/omitted-$scope.yml"
  sed "/^[[:space:]]*$scope[[:space:]]*$/p" \
    "$WORKFLOW" >"$TMP_ROOT/duplicated-$scope.yml"
  expect_rejected "$TMP_ROOT/duplicated-$scope.yml"
  awk -v scope="$scope" '
    index($0, "- name: Prove " scope " public bottle installs in Node") {
      in_scope = 1
    }
    in_scope && /timeout-minutes: 20/ {
      sub(/timeout-minutes: 20/, "timeout-minutes: 21")
      in_scope = 0
    }
    { print }
  ' "$WORKFLOW" >"$TMP_ROOT/wrong-$scope-timeout.yml"
  expect_rejected "$TMP_ROOT/wrong-$scope-timeout.yml"
done
sed \
  '/"KANDELO_BROWSER_DEMO_INPUTS=\$KANDELO_BROWSER_DEMO_INPUTS"/d' \
  "$WORKFLOW" >"$TMP_ROOT/dropped-chromium-input-selection.yml"
expect_rejected "$TMP_ROOT/dropped-chromium-input-selection.yml"
for forwarded in \
  KANDELO_BROWSER_DEMO_INPUTS \
  KANDELO_PLAYWRIGHT_SERVE_DIST \
  WASM_POSIX_BINARY_CACHE_ROOT \
  KANDELO_HOMEBREW_MAIN_SHELL_STRICT \
  KANDELO_HOMEBREW_MAIN_SHELL_SHA256 \
  KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_SHA256 \
  KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_BYTES \
  KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE \
  KANDELO_HOMEBREW_MAIN_SHELL_MIRROR_PLAN_URL
do
  needle="\"${forwarded}=\$${forwarded}\""
  awk -v needle="$needle" \
    'index($0, needle) == 0 { print }' \
    "$WORKFLOW" >"$TMP_ROOT/omitted-$forwarded.yml"
  expect_rejected "$TMP_ROOT/omitted-$forwarded.yml"
  awk -v needle="$needle" \
    '{ print; if (index($0, needle) != 0) print }' \
    "$WORKFLOW" >"$TMP_ROOT/duplicated-$forwarded.yml"
  expect_rejected "$TMP_ROOT/duplicated-$forwarded.yml"
done
sed \
  's/run_public_playwright npx playwright test/npx playwright test/' \
  "$WORKFLOW" >"$TMP_ROOT/bypassed-public-playwright-helper.yml"
expect_rejected "$TMP_ROOT/bypassed-public-playwright-helper.yml"
sed '/verify-browser-shell-vfs-asset.sh/d' \
  "$WORKFLOW" >"$TMP_ROOT/no-browser-shell-asset-verifier.yml"
expect_rejected "$TMP_ROOT/no-browser-shell-asset-verifier.yml"
sed '/verify-browser-shell-vfs-asset.sh/p' \
  "$WORKFLOW" >"$TMP_ROOT/duplicated-browser-shell-asset-verifier.yml"
expect_rejected "$TMP_ROOT/duplicated-browser-shell-asset-verifier.yml"
sed '/      - name: Upload mirror verification and lifecycle publication receipts/i\
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
