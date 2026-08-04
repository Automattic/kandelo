#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$REPO_ROOT/scripts/build-homebrew-main-shell-closure.sh"
PRODUCT_BUILDER="$REPO_ROOT/scripts/build-homebrew-main-shell-product.sh"
PRODUCT_INPUT_PREPARER="$REPO_ROOT/scripts/prepare-homebrew-main-shell-inputs.sh"
PRODUCT_STATE_TOOL="$REPO_ROOT/scripts/homebrew-main-shell-product-state.py"
PRODUCT_STATE_TEST="$REPO_ROOT/scripts/test-homebrew-main-shell-product-state.sh"
CHECKER="$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs"
BREWFILE="$REPO_ROOT/homebrew/main-shell.Brewfile"
SOURCE_LOCK="$REPO_ROOT/homebrew/main-shell-migration-lock.json"
RUNTIME_SUPPORT="$REPO_ROOT/homebrew/main-shell-homebrew-runtime-support.json"
SELECTION_LOCK="$REPO_ROOT/homebrew/main-shell-selection-lock.json"
SELECTION_LOCK_TOOL="$REPO_ROOT/scripts/homebrew-main-shell-selection-lock.py"
SELECTION_CONTROLLER="$REPO_ROOT/scripts/homebrew-closed-selection-controller.py"
SELECTION_PUBLISHER="$REPO_ROOT/scripts/publish-homebrew-closed-selection-release.sh"
SELECTION_WORKFLOW="$REPO_ROOT/.github/workflows/reusable-homebrew-closed-selection-publish.yml"
LAZY_ARTIFACT_LOCK="$REPO_ROOT/homebrew/main-shell-lazy-artifact-lock.json"
LAZY_ARTIFACT_CHECKER="$REPO_ROOT/scripts/verify-homebrew-main-shell-artifact-lock.sh"
FINALIZER_TEST="$REPO_ROOT/scripts/test-finalize-homebrew-main-shell-release.py"
WORKFLOW="$REPO_ROOT/.github/workflows/homebrew-main-shell-ci.yml"
IMAGE_CONTRACT="$REPO_ROOT/scripts/homebrew-main-shell-image-contract.ts"
IMAGE_CONTRACT_TEST="$REPO_ROOT/scripts/homebrew-main-shell-image-contract.test.ts"
SUPPORT_DATA_INPUT_TEST="$REPO_ROOT/scripts/extract-homebrew-support-data-bottle.test.ts"
NODE_SMOKE="$REPO_ROOT/scripts/homebrew-main-shell-node-smoke.ts"
GUEST_LIFECYCLE_NODE="$REPO_ROOT/homebrew/test/homebrew_guest_lifecycle_node.ts"
GUEST_LIFECYCLE_FIXTURE="$REPO_ROOT/scripts/create-homebrew-guest-lifecycle-fixture.ts"
BROWSER_SMOKE="$REPO_ROOT/apps/browser-demos/test/kandelo-homebrew-main-shell.spec.ts"
CLOSED_ACCEPTANCE_TEST="$REPO_ROOT/apps/browser-demos/homebrew-closed-acceptance.test.ts"
PLAYWRIGHT_ACCEPTANCE_TEST="$REPO_ROOT/apps/browser-demos/playwright-closed-acceptance.test.ts"
SHELL_VFS_URL_TEST="$REPO_ROOT/apps/browser-demos/shell-vfs-image-url.test.ts"
TERMINAL_COMMAND_TEST="$REPO_ROOT/apps/browser-demos/test/support/terminal-command.test.ts"
EAGER_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts"
MATERIALIZED_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-materialized-vfs-image.ts"
STAGING_WORKFLOW="$REPO_ROOT/.github/workflows/staging-build.yml"
PREPARE_MERGE_WORKFLOW="$REPO_ROOT/.github/workflows/prepare-merge.yml"
FORCE_REBUILD_WORKFLOW="$REPO_ROOT/.github/workflows/force-rebuild.yml"
SHELL_BUILD_TOML="$REPO_ROOT/packages/registry/shell/build.toml"
SHELL_PACKAGE_TOML="$REPO_ROOT/packages/registry/shell/package.toml"
SHELL_BUILDER="$REPO_ROOT/packages/registry/shell/build-shell.sh"
HOMEBREW_BOOTSTRAP_PACKAGE_TOML="$REPO_ROOT/packages/registry/homebrew-bootstrap/package.toml"
PACKAGE_TREE_SPEC="$REPO_ROOT/homebrew/main-shell-brew-package-tree.json"
LAZY_ARCHIVE_RESOLVER="$REPO_ROOT/apps/browser-demos/lib/init/lazy-archives.ts"
SHELL_TOOL_PREPARER="$REPO_ROOT/packages/registry/shell/prepare-build-tools.sh"
SHELL_TOOL_PREPARER_TEST="$REPO_ROOT/packages/registry/shell/test-prepare-build-tools.sh"
RUN_SH="$REPO_ROOT/run.sh"
BROWSER_BOOTSTRAP_PREPARER="$REPO_ROOT/scripts/prepare-homebrew-browser-bootstrap.sh"
LOCAL_SHELL_INSTALLER="$REPO_ROOT/scripts/install-local-shell-artifact.sh"
LOCAL_SHELL_OVERRIDE="$REPO_ROOT/scripts/activate-local-shell-build-override.sh"
CI_BLOCKER_MATERIALIZER="$REPO_ROOT/scripts/materialize-ci-publication-blockers.sh"
CI_STAGING_SHELL_VERIFIER="$REPO_ROOT/scripts/verify-ci-staging-shell-handoff.sh"
CI_BROWSER_MIRROR_STATE="$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh"
CI_WORKSPACE_PACKER="$REPO_ROOT/scripts/pack-ci-test-workspace.sh"
CI_TEST_RUNNER="$REPO_ROOT/scripts/ci-run-test-suite.sh"
BUILD_PROGRAMS="$REPO_ROOT/scripts/build-programs.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-homebrew-main-shell-closure: $*" >&2
  exit 1
}

expect_failure() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    fail "command unexpectedly succeeded: $*"
  fi
  grep -Fq -- "$expected" <<<"$output" || {
    printf '%s\n' "$output" >&2
    fail "failure did not contain: $expected"
  }
}

check_candidate_mirror_publish_authority() {
  local workflow="$1"
  local block
  block="$(sed -n \
    '/- name: Recover the exact bottle mirror/,/- name: Create the exact closed Chromium lifecycle fixture/p' \
    "$workflow")"
  [ "$(grep -Fc 'scripts/create-homebrew-bottle-mirror-publish-manifest.ts' \
      <<<"$block")" -eq 1 ] || {
    echo "candidate mirror must create exactly one publish manifest" >&2
    return 1
  }
  # WHY: producing valid mirror bytes is not enough. The manifest also carries
  # the commit allowed to own a later release write, so the caller and its
  # postcondition must use the exact catalog checkout rather than github.sha.
  [ "$(grep -Fc -- \
      '--target-commitish "${{ steps.bottle_candidate.outputs.tap_sha }}" \' \
      <<<"$block")" -eq 1 ] || {
    echo "candidate mirror target must be the exact checked-out tap catalog" >&2
    return 1
  }
  [ "$(grep -Fc -- \
      '--arg target "${{ steps.bottle_candidate.outputs.tap_sha }}" \' \
      <<<"$block")" -eq 1 ] || {
    echo "candidate mirror postcondition must verify the same exact tap catalog" >&2
    return 1
  }
}

expect_candidate_mirror_contract_rejected() {
  local workflow="$1"
  local output
  if output="$(check_candidate_mirror_publish_authority "$workflow" 2>&1)"; then
    fail "candidate mirror authority mutation unexpectedly passed: $workflow"
  fi
  grep -Fq 'candidate mirror' <<<"$output" || {
    printf '%s\n' "$output" >&2
    fail "candidate mirror authority mutation failed without contract evidence"
  }
}

check_closed_browser_acceptance_contract() {
  local workflow="$1"
  local build_block browser_block build_closed_branch preview_closed_branch
  build_block="$(sed -n \
    '/- name: Build the sealed browser product tree/,/- name: Boot the exact installed bytes in Node/p' \
    "$workflow")"
  browser_block="$(sed -n \
    '/- name: Boot the current main-shell path in Chromium/,/- name: Upload exact closure evidence/p' \
    "$workflow")"
  build_closed_branch="$(awk '
    index($0, "if [ \"$SHELL_ACTIVATION_MODE\" = bottles ] &&") {
      inside = 1
    }
    inside { print }
    inside && $0 ~ /^[[:space:]]*fi$/ { exit }
  ' <<<"$build_block")"
  preview_closed_branch="$(awk '
    index($0, "if [ \"$KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE\" = closed ]; then") {
      inside = 1
    }
    inside { print }
    inside && index($0, "elif [ \"$KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE\" != public ]") {
      exit
    }
  ' <<<"$browser_block")"
  grep -Fq \
    'apps/browser-demos/homebrew-closed-acceptance-vite-config.test.ts' \
    "$workflow" ||
    return 1
  grep -Fq \
    'apps/browser-demos/playwright-closed-acceptance.test.ts' \
    "$workflow" ||
    return 1
  grep -Fq \
    'apps/browser-demos/shell-vfs-image-url.test.ts' \
    "$workflow" ||
    return 1
  grep -Fq \
    'apps/browser-demos/test/support/terminal-command.test.ts' \
    "$workflow" ||
    return 1

  grep -Fq 'if [ "$SHELL_ACTIVATION_MODE" = bottles ] &&' \
    <<<"$build_closed_branch" &&
    grep -Fq '[ "$TRANSPORT_MODE" = closed ]; then' \
      <<<"$build_closed_branch" &&
    [ "$(grep -Fc -- \
      'build_args+=(-- --mode homebrew-closed-acceptance)' \
      <<<"$build_closed_branch")" -eq 1 ] &&
    [ "$(grep -Fc \
      '"VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT=/homebrew-main-shell-bottles"' \
      <<<"$build_closed_branch")" -eq 1 ] &&
    [ "$(grep -Fc -- '--mode homebrew-closed-acceptance' \
      <<<"$build_block")" -eq 1 ] ||
    return 1

  # WHY: serving a sealed dist still loads Vite's config. Bind preview to the
  # same exact mode/root pair used to compile it so neither public bottles nor
  # source-rootfs runs can inherit the closed mirror by environment leakage.
  [ "$(grep -Fc \
    '"KANDELO_PLAYWRIGHT_VITE_MODE=homebrew-closed-acceptance"' \
    <<<"$preview_closed_branch")" -eq 1 ] &&
    [ "$(grep -Fc \
      '"KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT=/homebrew-main-shell-bottles"' \
      <<<"$preview_closed_branch")" -eq 1 ] &&
    [ "$(grep -Fc \
      '"VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT=/homebrew-main-shell-bottles"' \
      <<<"$preview_closed_branch")" -eq 0 ] &&
    [ "$(grep -Fc 'KANDELO_PLAYWRIGHT_VITE_MODE=homebrew-closed-acceptance' \
      <<<"$browser_block")" -eq 1 ] ||
    return 1
  grep -Fq \
    'process.env.KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT' \
    "$BROWSER_SMOKE" &&
    ! grep -Fq \
      'process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT' \
      "$BROWSER_SMOKE" ||
    return 1

  local offline_block
  offline_block="$(awk '
    index($0, "if [ \"$SHELL_ACTIVATION_MODE\" = bottles ] &&") {
      inside = 1
    }
    inside { print }
    inside && index($0, "# Run the rebooting live lifecycle") { exit }
  ' <<<"$browser_block")"
  grep -Fq \
    '[ "$KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE" = closed ]; then' \
    <<<"$offline_block" &&
    grep -Fq 'KANDELO_BROWSER_DEMO_INPUTS=homebrew-vfs-test' \
      <<<"$offline_block" ||
    return 1
}

expect_closed_browser_acceptance_contract_rejected() {
  local workflow="$1"
  if check_closed_browser_acceptance_contract "$workflow"; then
    fail "closed browser acceptance mutation unexpectedly passed: $workflow"
  fi
}

check_ordered_staging_shell_contract() {
  local workflow="$1"
  local test_gate prerequisites proof gate
  test_gate="$(sed -n \
    '/^  test-gate:/,/^  homebrew-main-shell-prerequisites:/p' \
    "$workflow")"
  prerequisites="$(sed -n \
    '/^  homebrew-main-shell-prerequisites:/,/^  homebrew-main-shell-proof:/p' \
    "$workflow")"
  proof="$(sed -n \
    '/^  homebrew-main-shell-proof:/,/^  homebrew-main-shell-gate:/p' \
    "$workflow")"
  gate="$(sed -n \
    '/^  homebrew-main-shell-gate:/,/^  # publish \/ generate-index/p' \
    "$workflow")"

  grep -Fq 'ready_for_review' "$workflow" &&
    grep -Fq \
      'staged_matrix: ${{ steps.compute.outputs.staged_matrix }}' \
      "$workflow" &&
    grep -Fq 'echo "staged_matrix=$staged_matrix" >> "$GITHUB_OUTPUT"' \
      "$workflow" &&
    grep -Fq 'package-release-lifecycle.sh seal-publish' \
      <<<"$test_gate" &&
    grep -Fq -- \
      '--target-commit '\''${{ github.event.pull_request.head.sha }}'\''' \
      <<<"$test_gate" &&
    grep -Fq 'needs: [change-scope, preflight, test-gate]' \
      <<<"$prerequisites" &&
    grep -Fq '[ "$TEST_GATE_RESULT" = success ]' \
      <<<"$prerequisites" &&
    grep -Fq \
      'expected_tag="pr-${{ github.event.pull_request.number }}-staging-run-${GITHUB_RUN_ID}-attempt-${GITHUB_RUN_ATTEMPT}"' \
      <<<"$prerequisites" &&
    grep -Fq '[ "$TARGET_TAG" = "$expected_tag" ]' \
      <<<"$prerequisites" &&
    grep -Fq 'uses: ./.github/workflows/homebrew-main-shell-ci.yml' \
      <<<"$proof" &&
    grep -Fq 'always() &&' <<<"$proof" &&
    grep -Fq 'caller_event_name: pull_request' <<<"$proof" &&
    grep -Fq \
      'pull_request_head_sha: ${{ github.event.pull_request.head.sha }}' \
      <<<"$proof" &&
    grep -Fq \
      "staging_required: \${{ needs.change-scope.outputs.package_staging_required == 'true' }}" \
      <<<"$proof" &&
    grep -Fq 'needs.preflight.outputs.target_tag' <<<"$proof" &&
    grep -Fq 'needs.preflight.outputs.staged_matrix' <<<"$proof" &&
    grep -Fq 'name: exact current lazy shell (Node + Chromium)' \
      <<<"$gate" &&
    grep -Fq 'if: |' <<<"$gate" &&
    grep -Fq 'always() &&' <<<"$gate" &&
    grep -Fq '[ "$PREREQUISITES_RESULT" = success ]' <<<"$gate" &&
    grep -Fq '[ "$PROOF_RESULT" = success ]' <<<"$gate"
}

expect_ordered_staging_shell_contract_rejected() {
  local workflow="$1"
  if check_ordered_staging_shell_contract "$workflow"; then
    fail "ordered staging-shell mutation unexpectedly passed: $workflow"
  fi
}

check_required_staging_verifier_contract() {
  local workflow="$1" generation
  generation="$(sed -n \
    '/- name: Select one verified package generation/,/- name: Resolve exact shell browser inputs/p' \
    "$workflow")"

  grep -Fq \
      'expected_tag="pr-${pr_number}-staging-run-${GITHUB_RUN_ID}-attempt-${GITHUB_RUN_ATTEMPT}"' \
      <<<"$generation" &&
    grep -Fq '[ "$STAGING_TAG" = "$expected_tag" ]' \
      <<<"$generation" &&
    grep -Fq 'package-release-lifecycle.sh \' <<<"$generation" &&
    grep -Fq 'verify-immutable \' <<<"$generation" &&
    grep -Fq -- '--tag "$target_tag" \' <<<"$generation" &&
    grep -Fq -- '--target-commit "$pr_head" \' <<<"$generation" &&
    grep -Fq -- '--title "$target_tag" \' <<<"$generation" &&
    grep -Fq -- '--body-file "$release_body" \' <<<"$generation" &&
    grep -Fq -- '--prerelease true' <<<"$generation" &&
    grep -Fq "printf '%s\\n' \"\$STAGED_MATRIX\"" <<<"$generation" &&
    grep -Fq 'split-staging-package-ledger.sh \' <<<"$generation" &&
    grep -Fq -- '--selected-matrix "$SELECTED_MATRIX" \' \
      <<<"$generation" &&
    grep -Fq -- '--selected-output "$TARGET_EXPECTED" \' \
      <<<"$generation" &&
    grep -Fq -- '--complement-output "$CANONICAL_EXPECTED"' \
      <<<"$generation" &&
    grep -Fq -- '--expected-ledger "$TARGET_EXPECTED" \' \
      <<<"$generation" &&
    grep -Fq -- '--materialize \' <<<"$generation" &&
    [ "$(grep -Fc -- '--materialize \' <<<"$generation")" -eq 1 ] &&
    grep -Fq -- '--expected-ledger "$CANONICAL_EXPECTED" \' \
      <<<"$generation" &&
    grep -Fq '"$xtask" staging-reuse compose \' <<<"$generation" &&
    grep -Fq -- '--base-snapshot "$base_snapshot" \' \
      <<<"$generation" &&
    grep -Fq -- '--overlay-snapshot "$TARGET_SNAPSHOT/snapshot.json" \' \
      <<<"$generation" &&
    grep -Fq -- '--complete-expected-ledger "$EXPECTED" \' \
      <<<"$generation" &&
    grep -Fq -- '-u HOMEBREW_DOCKER_REGISTRY_TOKEN \' \
      <<<"$generation" &&
    grep -Fq -- '-u ACTIONS_RUNTIME_TOKEN \' <<<"$generation" &&
    grep -Fq 'selected_url="file://${frozen_index}"' <<<"$generation" &&
    grep -Fq 'case "$STAGING_REQUIRED" in' <<<"$generation" &&
    grep -Fq \
      'echo "::error::non-staging call supplied release authority"' \
      <<<"$generation" &&
    ! grep -Fq '/releases?per_page=100' <<<"$generation" &&
    ! grep -Fq 'using canonical/source fallback' <<<"$generation"
}

expect_required_staging_verifier_contract_rejected() {
  local workflow="$1"
  if check_required_staging_verifier_contract "$workflow"; then
    fail "required staging verifier mutation unexpectedly passed: $workflow"
  fi
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v node >/dev/null 2>&1 || fail "node is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

bash "$REPO_ROOT/.github/scripts/test-homebrew-main-shell-change-scope.sh" ||
  fail "main-shell change-scope contract tests failed"

bash "$REPO_ROOT/.github/scripts/test-split-staging-package-ledger.sh" ||
  fail "staging package-ledger partition tests failed"

python3 "$FINALIZER_TEST" ||
  fail "main-shell release finalizer contract tests failed"

bash "$PRODUCT_STATE_TEST" ||
  fail "main-shell product-state contract tests failed"

SOURCE_ROOT_COUNT="$(jq -er '.packages | length' "$SOURCE_LOCK")"
SOURCE_CLOSURE_COUNT="$(jq -er '.formula_closure | length' "$SOURCE_LOCK")"
RUNTIME_FORMULA_COUNT="$(jq -er '.formula_order | length' "$RUNTIME_SUPPORT")"
AUDITED_FORMULA_COUNT="$(jq -er '
  [.availability.reusable_public_abi42,
   .availability.requires_rebuild,
   .availability.missing_metadata,
   .availability.can_be_deferred] | add | length
' "$RUNTIME_SUPPORT")"
ADDITIONAL_FORMULA_COUNT="$(jq -er \
  '.additional_formula_order | length' "$RUNTIME_SUPPORT")"
TOTAL_FORMULA_COUNT="$((SOURCE_CLOSURE_COUNT + ADDITIONAL_FORMULA_COUNT))"
EXPECTED_SHAPE_SUMMARY="$SOURCE_ROOT_COUNT reviewed migration roots, "
EXPECTED_SHAPE_SUMMARY+="$SOURCE_CLOSURE_COUNT base Formulae, "
EXPECTED_SHAPE_SUMMARY+="$RUNTIME_FORMULA_COUNT runtime Formulae, and "
EXPECTED_SHAPE_SUMMARY+="$AUDITED_FORMULA_COUNT audited Formulae; "
EXPECTED_SHAPE_SUMMARY+="the runtime adds $ADDITIONAL_FORMULA_COUNT beyond "
EXPECTED_SHAPE_SUMMARY+="the base, yielding $TOTAL_FORMULA_COUNT total Formulae"

main_shell_trigger_block="$(
  awk '
    /^on:$/ { inside = 1 }
    inside && /^concurrency:$/ { exit }
    inside { print }
  ' "$WORKFLOW"
)"
grep -Fxq '  workflow_call:' <<<"$main_shell_trigger_block" &&
  ! grep -Fxq '  pull_request:' <<<"$main_shell_trigger_block" &&
  grep -Fxq '  push:' <<<"$main_shell_trigger_block" &&
  grep -Fxq '    branches: [main]' <<<"$main_shell_trigger_block" ||
  fail "Homebrew main-shell CI must be called after PR staging and validate every main push"
if grep -Eq '^[[:space:]]+(paths|paths-ignore):' \
  <<<"$main_shell_trigger_block"; then
  fail "Homebrew main-shell CI must not filter reusable calls or main pushes by path"
fi
for workflow_input in \
  caller_event_name \
  pull_request_number \
  pull_request_base_sha \
  pull_request_head_sha \
  staging_required \
  staging_tag \
  staged_matrix
do
  grep -Fq "      $workflow_input:" <<<"$main_shell_trigger_block" ||
    fail "main-shell workflow_call omits $workflow_input"
done

check_ordered_staging_shell_contract "$STAGING_WORKFLOW" ||
  fail "staging must seal one exact attempt before its reusable shell proof"
sed '/ready_for_review/d' "$STAGING_WORKFLOW" \
  >"$TMP_ROOT/staging-shell-no-ready-rerun.yml"
expect_ordered_staging_shell_contract_rejected \
  "$TMP_ROOT/staging-shell-no-ready-rerun.yml"
sed '/package-release-lifecycle.sh seal-publish/d' "$STAGING_WORKFLOW" \
  >"$TMP_ROOT/staging-shell-no-seal.yml"
expect_ordered_staging_shell_contract_rejected \
  "$TMP_ROOT/staging-shell-no-seal.yml"
sed 's/\[ "$TEST_GATE_RESULT" = success \]/[ "$TEST_GATE_RESULT" = skipped ]/' \
  "$STAGING_WORKFLOW" >"$TMP_ROOT/staging-shell-accepts-skipped-producer.yml"
expect_ordered_staging_shell_contract_rejected \
  "$TMP_ROOT/staging-shell-accepts-skipped-producer.yml"
sed '/uses: \.\/\.github\/workflows\/homebrew-main-shell-ci.yml/d' \
  "$STAGING_WORKFLOW" >"$TMP_ROOT/staging-shell-no-reusable-call.yml"
expect_ordered_staging_shell_contract_rejected \
  "$TMP_ROOT/staging-shell-no-reusable-call.yml"
sed '/pull_request_head_sha:/d' "$STAGING_WORKFLOW" \
  >"$TMP_ROOT/staging-shell-no-explicit-head.yml"
expect_ordered_staging_shell_contract_rejected \
  "$TMP_ROOT/staging-shell-no-explicit-head.yml"
sed '/staged_matrix:/d' "$STAGING_WORKFLOW" \
  >"$TMP_ROOT/staging-shell-no-exact-matrix.yml"
expect_ordered_staging_shell_contract_rejected \
  "$TMP_ROOT/staging-shell-no-exact-matrix.yml"
sed '/\[ "$PROOF_RESULT" = success \]/d' "$STAGING_WORKFLOW" \
  >"$TMP_ROOT/staging-shell-aggregate-drops-proof.yml"
expect_ordered_staging_shell_contract_rejected \
  "$TMP_ROOT/staging-shell-aggregate-drops-proof.yml"

check_required_staging_verifier_contract "$WORKFLOW" ||
  fail "main-shell CI must verify its exact immutable staging authority"
sed '/verify-immutable \\/d' "$WORKFLOW" \
  >"$TMP_ROOT/main-shell-no-immutable-verifier.yml"
expect_required_staging_verifier_contract_rejected \
  "$TMP_ROOT/main-shell-no-immutable-verifier.yml"
sed '/split-staging-package-ledger.sh \\/d' "$WORKFLOW" \
  >"$TMP_ROOT/main-shell-no-ledger-partition.yml"
expect_required_staging_verifier_contract_rejected \
  "$TMP_ROOT/main-shell-no-ledger-partition.yml"
sed '/--materialize \\/d' "$WORKFLOW" \
  >"$TMP_ROOT/main-shell-no-selected-archive-proof.yml"
expect_required_staging_verifier_contract_rejected \
  "$TMP_ROOT/main-shell-no-selected-archive-proof.yml"
sed '/"$xtask" staging-reuse compose \\/d' "$WORKFLOW" \
  >"$TMP_ROOT/main-shell-no-exact-union.yml"
expect_required_staging_verifier_contract_rejected \
  "$TMP_ROOT/main-shell-no-exact-union.yml"
sed '/-u ACTIONS_RUNTIME_TOKEN \\/d' "$WORKFLOW" \
  >"$TMP_ROOT/main-shell-compose-keeps-runtime-token.yml"
expect_required_staging_verifier_contract_rejected \
  "$TMP_ROOT/main-shell-compose-keeps-runtime-token.yml"

setup_node_line="$(grep -n 'uses: actions/setup-node@' "$WORKFLOW" | cut -d: -f1 | head -1)"
checker_line="$(grep -n 'node scripts/check-homebrew-main-shell-brewfile.mjs' "$WORKFLOW" | cut -d: -f1 | head -1)"
[ -n "$setup_node_line" ] && [ -n "$checker_line" ] &&
  [ "$setup_node_line" -lt "$checker_line" ] ||
  fail "pinned Node setup must precede the main-shell contract checker"
[ "$(grep -Fc 'node scripts/check-homebrew-main-shell-brewfile.mjs' "$WORKFLOW")" -eq 1 ] &&
  grep -Fq 'scripts/homebrew-main-shell-selection-lock.py" verify' \
    "$PRODUCT_INPUT_PREPARER" &&
  grep -Fq 'validate_selected_formula_closure' "$SELECTION_LOCK_TOOL" ||
  fail "main-shell CI must validate its static contract and selected catalog"

check_candidate_mirror_publish_authority "$WORKFLOW" ||
  fail "candidate mirror publication authority contract is incomplete"
sed '/--target-commitish.*bottle_candidate.outputs.tap_sha/d' \
  "$WORKFLOW" >"$TMP_ROOT/mirror-missing-target.yml"
expect_candidate_mirror_contract_rejected \
  "$TMP_ROOT/mirror-missing-target.yml"
sed 's/steps\.bottle_candidate\.outputs\.tap_sha/github.sha/g' \
  "$WORKFLOW" >"$TMP_ROOT/mirror-wrong-target.yml"
expect_candidate_mirror_contract_rejected \
  "$TMP_ROOT/mirror-wrong-target.yml"
sed '/--target-commitish.*bottle_candidate.outputs.tap_sha/p' \
  "$WORKFLOW" >"$TMP_ROOT/mirror-duplicate-target.yml"
expect_candidate_mirror_contract_rejected \
  "$TMP_ROOT/mirror-duplicate-target.yml"

check_closed_browser_acceptance_contract "$WORKFLOW" ||
  fail "closed browser acceptance mode/input contract is incomplete"
sed '/build_args+=(-- --mode homebrew-closed-acceptance)/d' \
  "$WORKFLOW" >"$TMP_ROOT/closed-browser-missing-build-mode.yml"
expect_closed_browser_acceptance_contract_rejected \
  "$TMP_ROOT/closed-browser-missing-build-mode.yml"
sed '/KANDELO_PLAYWRIGHT_VITE_MODE=homebrew-closed-acceptance/d' \
  "$WORKFLOW" >"$TMP_ROOT/closed-browser-missing-preview-mode.yml"
expect_closed_browser_acceptance_contract_rejected \
  "$TMP_ROOT/closed-browser-missing-preview-mode.yml"
sed \
  's/"KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT=/"VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT=/' \
  "$WORKFLOW" >"$TMP_ROOT/closed-browser-leaked-preview-root.yml"
expect_closed_browser_acceptance_contract_rejected \
  "$TMP_ROOT/closed-browser-leaked-preview-root.yml"
sed 's/--mode homebrew-closed-acceptance/--mode production/' \
  "$WORKFLOW" >"$TMP_ROOT/closed-browser-wrong-build-mode.yml"
expect_closed_browser_acceptance_contract_rejected \
  "$TMP_ROOT/closed-browser-wrong-build-mode.yml"

generation_block="$(sed -n \
  '/- name: Select one verified package generation/,/- name: Resolve exact shell browser inputs/p' \
  "$WORKFLOW")"
grep -Fq 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}' <<<"$generation_block" ||
  fail "package-generation validation needs only the workflow's read token"
grep -Fq 'staging-reuse expected \' <<<"$generation_block" &&
  grep -Fq 'split-staging-package-ledger.sh \' <<<"$generation_block" &&
  grep -Fq 'validate-staging-release.sh \' <<<"$generation_block" &&
  grep -Fq -- '--mode current \' <<<"$generation_block" &&
  grep -Fq 'staging-reuse compose \' <<<"$generation_block" ||
  fail "main-shell CI must compose exact staged rows with the canonical complement"
grep -Fq -- '--complete-expected-ledger "$EXPECTED" \' \
    <<<"$generation_block" &&
  grep -Fq 'selected_url="file://${frozen_index}"' <<<"$generation_block" ||
  fail "main-shell CI must freeze the exact disjoint release union locally"
check_required_staging_verifier_contract "$WORKFLOW" ||
  fail "main-shell CI must require its exact sealed staging attempt"
grep -Fq 'env -u GH_TOKEN -u GITHUB_TOKEN \' <<<"$generation_block" &&
  grep -Fq -- '-u HOMEBREW_GITHUB_PACKAGES_TOKEN \' <<<"$generation_block" &&
  grep -Fq -- '-u HOMEBREW_DOCKER_REGISTRY_TOKEN \' \
    <<<"$generation_block" &&
  grep -Fq -- '-u ACTIONS_ID_TOKEN_REQUEST_TOKEN \' \
    <<<"$generation_block" &&
  grep -Fq -- '-u ACTIONS_RUNTIME_TOKEN \' <<<"$generation_block" ||
  fail "local index freezing must run without GitHub credentials"
grep -Fq 'selected_url="$canonical_url"' <<<"$generation_block" &&
  grep -Fq '[ "$STAGING_TAG" = not-required ]' \
    <<<"$generation_block" ||
  fail "main-shell CI must retain the canonical package generation"
grep -Fq 'echo "WASM_POSIX_BINARY_INDEX_URL=$selected_url" >> "$GITHUB_ENV"' \
  <<<"$generation_block" ||
  fail "main-shell CI must pass the selected generation through the resolver contract"
# WHY: the dev shell admits only declared environment. Assert the cache handoff
# at every nested boundary so source fallback and the sealed browser proof
# cannot silently resolve the same package names from different trust roots.
grep -Fq 'binary_cache="$RUNNER_TEMP/homebrew-main-shell-exact-cache"' \
  <<<"$generation_block" &&
  grep -Fq 'echo "WASM_POSIX_BINARY_CACHE_ROOT=$binary_cache" >> "$GITHUB_ENV"' \
    <<<"$generation_block" ||
  fail "every activation mode must establish one package-cache trust root"
grep -Fq 'echo "SOURCE_SHELL_BINARY_INDEX_URL=file://${empty_index}" >> "$GITHUB_ENV"' \
  <<<"$generation_block" &&
  grep -Fq 'source_cache="$binary_cache"' <<<"$generation_block" &&
  grep -Fq 'echo "SOURCE_SHELL_BINARY_CACHE_ROOT=$source_cache" >> "$GITHUB_ENV"' \
    <<<"$generation_block" ||
  fail "source activation must publish one closure-local empty index and cache root"

check_bootstrap_bottle_extraction_contract() {
  local block="$1"
  local preparer_line
  local builder_line

  grep -Fq 'scripts/prepare-homebrew-main-shell-inputs.sh \' \
    <<<"$block" &&
    grep -Fq 'scripts/build-homebrew-main-shell-product.sh \' \
      <<<"$block" || return 1
  grep -Fq 'scripts/extract-homebrew-support-data-bottle.ts" \' \
    "$PRODUCT_INPUT_PREPARER" &&
    grep -Fq -- '--tap-root "$SELECTION/tap" \' \
      "$PRODUCT_INPUT_PREPARER" &&
    grep -Fq -- '--expected-tap-sha "$EXPECTED_TAP_SHA" \' \
      "$PRODUCT_INPUT_PREPARER" &&
    grep -Fq -- '--tap-repository kandelo-dev/homebrew-tap-core \' \
      "$PRODUCT_INPUT_PREPARER" || return 1
  grep -Fq -- '--tap-name kandelo-dev/tap-core \' \
    "$PRODUCT_INPUT_PREPARER" &&
    grep -Fq -- '--package "$BOOTSTRAP_PACKAGE" \' \
      "$PRODUCT_INPUT_PREPARER" &&
    grep -Fq -- '--selection-verification-report "$AUTHORIZATION" \' \
      "$PRODUCT_INPUT_PREPARER" &&
    grep -Fq -- '--homebrew-bootstrap-bottle-report "$BOOTSTRAP/report.json"' \
      "$PRODUCT_BUILDER" ||
    return 1

  ! grep -Fq 'git -C "$tap_root" fetch' <<<"$block" || return 1
  ! grep -Fq -- '--tap-root "$tap_root"' <<<"$block" || return 1
  ! grep -Fq 'scripts/fetch-binaries.sh --package "$bootstrap_package"' \
    <<<"$block" || return 1
  ! grep -Fq 'programs/homebrew-bootstrap/' <<<"$block" || return 1

  preparer_line="$(grep -nF \
    'scripts/prepare-homebrew-main-shell-inputs.sh \' \
    <<<"$block" | cut -d: -f1)"
  builder_line="$(grep -nF \
    'scripts/build-homebrew-main-shell-product.sh \' \
    <<<"$block" | cut -d: -f1)"
  [ -n "$preparer_line" ] && [ -n "$builder_line" ] &&
    [ "$preparer_line" -lt "$builder_line" ]
}

check_browser_fetch_only_contract() {
  local workflow="$1"
  local block
  local assignment_count
  block="$(sed -n \
    '/- name: Resolve exact shell browser inputs/,/- name: Install the candidate/p' \
    "$workflow")"
  assignment_count="$(grep -Ec \
    '^[[:space:]]*fetch_args=\(' <<<"$block")"

  [ "$assignment_count" -eq 1 ] &&
    [ "$(grep -Fc 'fetch_args=(--fetch-only)' <<<"$block")" -eq 1 ] &&
    [ "$(grep -Fc \
      'bash scripts/fetch-binaries.sh "${fetch_args[@]}"' \
      <<<"$block")" -eq 1 ] &&
    ! grep -Fq -- '--force-source-build' <<<"$block" &&
    ! grep -Eq \
      '(^|[[:space:]])(unset[[:space:]]+fetch_args|fetch_args\[[^]]+\]=)' \
      <<<"$block"
}

bottle_candidate_workflow_block="$(sed -n \
  '/- name: Build the exact lazy shell from public bottles/,/- name: Select the source shell for dependent browser VFS builds/p' \
  "$WORKFLOW")"
check_bootstrap_bottle_extraction_contract "$bottle_candidate_workflow_block" ||
  fail "bottle composition must extract and bind its declared bootstrap files from the exact public bottle"

check_browser_fetch_only_contract "$WORKFLOW" ||
  fail "browser support inputs must remain fetch-only"
sed 's/fetch_args=(--fetch-only)/fetch_args=()/' \
  "$WORKFLOW" >"$TMP_ROOT/browser-fetch-only-removed.yml"
if check_browser_fetch_only_contract \
  "$TMP_ROOT/browser-fetch-only-removed.yml"
then
  fail "browser support contract accepted removed fetch-only resolution"
fi
# WHY: a literal newline after `a\` is accepted by both BSD and GNU sed.
sed '/fetch_args=(--fetch-only)/a\
          fetch_args=()
' \
  "$WORKFLOW" >"$TMP_ROOT/browser-fetch-only-overridden.yml"
if check_browser_fetch_only_contract \
  "$TMP_ROOT/browser-fetch-only-overridden.yml"
then
  fail "browser support contract accepted an overridden fetch-only vector"
fi

browser_support_block="$(sed -n \
  '/- name: Resolve exact shell browser inputs/,/- name: Install the candidate/p' \
  "$WORKFLOW")"
for browser_graph_binding in \
  '--html-entry index.html' \
  '--html-entry pages/homebrew-vfs-test/index.html' \
  '--local-capability kernel-wasm' \
  '--package-capability rootfs-vfs=rootfs'
do
  grep -Fq -- "$browser_graph_binding" <<<"$browser_support_block" ||
    fail "browser support graph lacks binding: $browser_graph_binding"
done
if grep -Fq -- '--include-package rootfs' <<<"$browser_support_block"; then
  fail "rootfs must be selected through its discovered virtual capability"
fi

grep -Fq 'GH_TOKEN:' <<<"$(sed -n \
  '/- name: Resolve exact shell browser inputs/,/- name: Build the exact lazy shell/p' \
  "$WORKFLOW")" &&
  fail "browser package resolution must not retain the staging-validation token"

grep -Fq '(.selection.requested_packages | length) == $expected_root_count' "$BUILDER" ||
  fail "$BUILDER does not bind the requested-root count to the migration lock"
grep -Fq '(.packages | length) == $expected_composition_count' "$BUILDER" ||
  fail "$BUILDER does not bind the Formula count to the base-plus-support composition"
grep -Fq 'MATERIALIZED_CANDIDATE' "$BUILDER" &&
  fail "$BUILDER still references the retired materialized-candidate mode"
grep -Fq '[.packages[].full_name] ==' "$BUILDER" ||
  fail "$BUILDER does not compare exact ordered Formula composition identities"
grep -Fq '$lock[0].formula_closure +' "$BUILDER" &&
  grep -Fq '$runtime_support[0].additional_formula_order' "$BUILDER" ||
  fail "$BUILDER does not bind composition identities to the base and runtime-support contracts"
grep -Fq 'migration lock has no package roots' "$IMAGE_CONTRACT" ||
  fail "post-archive image contract must reject an empty root set"
grep -Fq 'migration lock has no Formula closure' "$IMAGE_CONTRACT" ||
  fail "post-archive image contract must reject an empty Formula closure"
grep -Fq 'guest Homebrew requested_packages' "$IMAGE_CONTRACT" ||
  fail "post-archive image contract must compare exact requested-root identities"
grep -Fq 'assertPackageClosure(' "$IMAGE_CONTRACT" ||
  fail "post-archive image contract must compare exact Formula identities"
[ "$(grep -Fc 'export SOURCE_DATE_EPOCH=0' "$BUILDER")" -eq 1 ] ||
  fail "strict shell composer must own one canonical timestamp epoch"
bash "$LAZY_ARTIFACT_CHECKER" \
  --lock "$LAZY_ARTIFACT_LOCK" --expected-source-date-epoch 0 ||
  fail "lazy shell artifact lock is not an exact digest/size/timestamp contract"
[ "$(jq -er '.state' "$SELECTION_LOCK")" = pending ] ||
  fail "new shell selection authority must begin in review-only pending state"
# WHY: preparation runs without write credentials in the workflow's first
# job. The publisher receives only that same-run deterministic archive, so a
# token-bearing job never has to execute tap-controlled materialization code.
grep -Fq 'homebrew-closed-selection-controller.py' "$SELECTION_WORKFLOW" &&
  grep -Fq 'prepare \' "$SELECTION_WORKFLOW" &&
  grep -Fq 'prepare_selection_release' "$SELECTION_CONTROLLER" &&
  grep -Fq 'publish-homebrew-closed-selection-release.sh' \
    "$SELECTION_WORKFLOW" &&
  grep -Fq 'publish-immutable-github-release.sh' "$SELECTION_PUBLISHER" &&
  grep -Fq 'fetch-selection-release' "$SELECTION_PUBLISHER" ||
  fail "closed-selection workflow must prepare, publish, and read back one immutable selection"
grep -Fq 'fetch-selection-release' "$PRODUCT_INPUT_PREPARER" &&
  grep -Fq 'verify-selection-readback' "$PRODUCT_INPUT_PREPARER" &&
  grep -Fq -- '--report-out "$AUTHORIZATION"' \
    "$PRODUCT_INPUT_PREPARER" &&
  grep -Fq -- \
    '--selection-verification-report "$AUTHORIZATION"' \
    "$PRODUCT_INPUT_PREPARER" &&
  grep -Fq -- '--closed-selection-root "$SELECTION"' "$PRODUCT_BUILDER" &&
  grep -Fq -- '--closed-selection-receipt "$RECEIPT"' \
    "$PRODUCT_BUILDER" ||
  fail "main-shell workflow does not authorize its immutable closed selection"
grep -Fq 'validate_selected_formula_closure' "$SELECTION_LOCK_TOOL" &&
  grep -Fq 'filesystemGitTreeOid(tapRoot)' \
    "$REPO_ROOT/scripts/extract-homebrew-support-data-bottle.ts" ||
  fail "closed-selection consumers do not bind exact closure and tree identity"
[ "$(grep -Fc 'bash "$LAZY_ARTIFACT_CHECKER"' "$BUILDER")" -eq 2 ] ||
  fail "strict shell composer must validate its lock before and after composition"
grep -Fq -- '--artifact "$OUT"' "$BUILDER" ||
  fail "strict shell composer must verify the final compressed artifact"

for variable in \
  KANDELO_HOMEBREW_MAIN_SHELL_STRICT \
  KANDELO_HOMEBREW_MAIN_SHELL_SHA256 \
  KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_SHA256 \
  KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_BYTES
do
  grep -Fq -- "\"$variable=\$$variable\"" "$WORKFLOW" ||
    fail "main-shell workflow must pass $variable explicitly to its isolated consumer"
  grep -Fq -- "--keep $variable " "$REPO_ROOT/scripts/dev-shell.sh" &&
    fail "dev shell must not globally preserve main-shell-only input $variable"
done

grep -Fq 'persist-credentials: false' "$WORKFLOW" ||
  fail "main-shell proof checkout must not persist repository credentials"
submodule_line="$(grep -nF 'submodules: libc/musl' "$WORKFLOW" | cut -d: -f1)"
setup_nix_line="$(grep -nF 'uses: ./.github/actions/setup-nix' "$WORKFLOW" | cut -d: -f1)"
isolate_line="$(grep -nF 'git archive "$GITHUB_SHA" | tar -x -C "$source_root"' "$WORKFLOW" | cut -d: -f1)"
sysroot_line="$(grep -nF 'bash scripts/dev-shell.sh bash scripts/build-musl.sh' "$WORKFLOW" | cut -d: -f1)"
fetch_line="$(grep -nF 'scripts/fetch-binaries.sh "${fetch_args[@]}"' "$WORKFLOW" | cut -d: -f1)"
[ -n "$submodule_line" ] && [ -n "$setup_nix_line" ] &&
  [ -n "$isolate_line" ] && [ -n "$sysroot_line" ] && [ -n "$fetch_line" ] &&
  [ "$submodule_line" -lt "$isolate_line" ] &&
  [ "$setup_nix_line" -lt "$isolate_line" ] &&
  [ "$isolate_line" -lt "$sysroot_line" ] &&
  [ "$sysroot_line" -lt "$fetch_line" ] ||
  fail "main-shell source fallback must isolate musl and build the sysroot before package resolution"
[ "$(grep -Fc 'bash scripts/dev-shell.sh bash scripts/build-musl.sh' "$WORKFLOW")" -eq 1 ] ||
  fail "main-shell proof must build the source-fallback sysroot exactly once"
grep -Fq 'test -f sysroot/lib/libc.a' "$WORKFLOW" ||
  fail "main-shell proof must verify the source-fallback libc archive"
grep -Fq 'working-directory: ${{ steps.sysroot-source.outputs.path }}' "$WORKFLOW" ||
  fail "main-shell proof must build musl outside the package resolver source tree"
grep -Fq 'test ! -e "$source_root/.git"' "$WORKFLOW" ||
  fail "isolated sysroot source must remain a path input independent of shallow Git history"
grep -Fq 'test -z "$(git -C "$GITHUB_WORKSPACE/libc/musl" status --porcelain=v1 --untracked-files=all)"' "$WORKFLOW" ||
  fail "main-shell proof must verify that sysroot preparation leaves package cache inputs clean"
grep -Fq 'GH_TOKEN: ${{ github.token }}' "$WORKFLOW" &&
  fail "main-shell proof must not expose the implicit workflow token to package composition"
candidate_build_workflow_block="$(sed -n \
  '/- name: Build the exact lazy shell from public bottles/,/- name: Resolve exact shell browser inputs/p' \
  "$WORKFLOW")"
grep -Fq 'scripts/homebrew-checkout-public-tap.sh' "$WORKFLOW" &&
  fail "candidate proof must use its immutable closed selection"
grep -Fq 'bash packages/registry/shell/build-shell.sh' \
  <<<"$candidate_build_workflow_block" &&
  fail "candidate proof must not invoke the canonical shell package wrapper"
grep -Fq 'compute-cache-key-sha \' <<<"$candidate_build_workflow_block" &&
  fail "candidate proof must not compute or activate a canonical package identity"
grep -Fq 'archive-stage \' <<<"$candidate_build_workflow_block" &&
  fail "candidate proof must not publish or stage the canonical shell package"
grep -Fq 'git -C "$tap_root" fetch --depth=1 origin "$tap_sha"' \
  <<<"$candidate_build_workflow_block" &&
  fail "candidate proof must not substitute a raw source tap"
grep -Fq 'scripts/prepare-homebrew-main-shell-inputs.sh \' \
  <<<"$candidate_build_workflow_block" ||
  fail "candidate proof must prepare the immutable product inputs"
grep -Fq 'scripts/build-homebrew-main-shell-product.sh \' \
  <<<"$candidate_build_workflow_block" ||
  fail "candidate proof must invoke the canonical product composer"
grep -Fq -- '--lazy-shell' "$PRODUCT_BUILDER" ||
  fail "product composer must explicitly opt into lazy shell composition"
grep -Fq 'scripts/build-homebrew-main-shell-closure.sh' "$PRODUCT_BUILDER" ||
  fail "product composer must invoke the strict shell composer"
grep -Fq -- '--materialize-package-tree \' <<<"$candidate_build_workflow_block" &&
  fail "candidate proof must not publish a partial bootstrap-only eager runtime"
[ "$(grep -Fc -- 'homebrew/main-shell-brew-package-tree.json"' \
  "$PRODUCT_BUILDER")" -eq 1 ] ||
  fail "lazy candidate must use the reviewed package-tree recipe exactly once"
[ "$(grep -Fc -- '--package-tree-archive "$BOOTSTRAP/homebrew-bootstrap.zip"' \
  "$PRODUCT_BUILDER")" -eq 1 ] ||
  fail "lazy candidate must use the exact package output bytes exactly once"
grep -Fq 'scripts/extract-homebrew-support-data-bottle.ts" \' \
  "$PRODUCT_INPUT_PREPARER" ||
  fail "lazy candidate must extract bootstrap files from its public bottle"
grep -Fq -- '--homebrew-bootstrap-bottle-report "$BOOTSTRAP/report.json"' \
  "$PRODUCT_BUILDER" ||
  fail "lazy candidate must bind public-bottle provenance into shell evidence"
grep -Fq 'scripts/verify-homebrew-support-data-extraction.ts' "$BUILDER" &&
  grep -Fq -- '--output "archive=$PACKAGE_TREE_ARCHIVE"' "$BUILDER" &&
  grep -Fq -- '--output "environment=$HOMEBREW_BOOTSTRAP_ENV"' "$BUILDER" &&
  grep -Fq -- '--verified-report-out "$VERIFIED_BOOTSTRAP_REPORT"' \
    "$BUILDER" ||
  fail "shell composer must rebind detached bootstrap outputs through the shared typed verifier"
grep -Fq 'current_tap_formula_sha256' "$BUILDER" &&
  fail "shell composer must not duplicate the typed bootstrap report schema"
grep -Fq 'scripts/fetch-binaries.sh --package "$bootstrap_package"' \
  <<<"$candidate_build_workflow_block" &&
  fail "bottled product shell must not fetch bootstrap from the legacy registry"
grep -Fq 'programs/homebrew-bootstrap/homebrew-bootstrap.zip' \
  <<<"$candidate_build_workflow_block" &&
  fail "bottled product shell must not resolve the legacy bootstrap archive"
grep -Fq 'programs/homebrew-bootstrap/homebrew-brew.env' \
  <<<"$candidate_build_workflow_block" &&
  fail "bottled product shell must not resolve the legacy bootstrap environment"
for credential in \
  GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN
do
  grep -Fq -- "-u $credential" <<<"$candidate_build_workflow_block" ||
    fail "public bootstrap extraction must remove $credential"
done
grep -Fq 'package_deferred_trees[0].state' <<<"$candidate_build_workflow_block" &&
  grep -Fq '= deferred' <<<"$candidate_build_workflow_block" ||
  fail "candidate proof must require the complete Homebrew runtime to remain deferred"
candidate_install_workflow_block="$(sed -n \
  "/- name: Install the candidate's exact shell bytes/,/- name: Recover the exact bottle mirror/p" \
  "$WORKFLOW")"
grep -Fq 'scripts/install-local-shell-artifact.sh \' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must use the shared package installer"
grep -Fq '"$CANDIDATE_PATH" "$install_session"' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate and session must be passed to the shared installer as isolated arguments"
grep -Fq 'WASM_POSIX_LOCAL_INSTALL_SOURCE="$source_image"' \
  "$LOCAL_SHELL_INSTALLER" ||
  fail "candidate proof must give the exact candidate to the package installer"
grep -Fq 'WASM_POSIX_LOCAL_INSTALL_SESSION="$install_session"' \
  "$LOCAL_SHELL_INSTALLER" ||
  fail "candidate proof must give the package installer an explicit session"
grep -Fq '${GITHUB_RUN_ID}' <<<"$candidate_install_workflow_block" &&
  grep -Fq '${GITHUB_RUN_ATTEMPT}' <<<"$candidate_install_workflow_block" &&
  grep -Fq '${GITHUB_JOB}' <<<"$candidate_install_workflow_block" ||
  fail "candidate package-install session must be unique to one workflow job attempt"
grep -Fq 'build-deps \' "$LOCAL_SHELL_INSTALLER" &&
  grep -Fq -- '--arch wasm32 \' "$LOCAL_SHELL_INSTALLER" &&
  grep -Fq -- '--binaries-dir "$REPO_ROOT/local-binaries" \' \
    "$LOCAL_SHELL_INSTALLER" ||
  fail "candidate proof must publish through the wasm32 local package installer"
grep -Fq 'install-local-artifact shell shell.vfs.zst' \
  "$LOCAL_SHELL_INSTALLER" ||
  fail "candidate proof must install shell.vfs.zst as a declared shell artifact"
grep -Fq 'resolved="$(bash scripts/resolve-binary.sh programs/shell.vfs.zst)"' \
  "$LOCAL_SHELL_INSTALLER" ||
  fail "candidate proof must resolve the canonical installed shell artifact"
grep -Fq 'cmp "$source_image" "$resolved"' \
  "$LOCAL_SHELL_INSTALLER" ||
  fail "candidate proof must compare the canonical installed artifact with the candidate"
grep -Fq 'cp "$CANDIDATE_PATH" "$browser_copy"' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must retain a separate browser-public copy"
grep -Fq \
  'browser_bootstrap_copy=apps/browser-demos/public/homebrew-bootstrap.zip' \
  <<<"$candidate_install_workflow_block" &&
  grep -Fq \
    'cp "$CANDIDATE_BOOTSTRAP_PATH" "$browser_bootstrap_copy"' \
    <<<"$candidate_install_workflow_block" &&
  grep -Fq \
    'cmp "$CANDIDATE_BOOTSTRAP_PATH" "$browser_bootstrap_copy"' \
    <<<"$candidate_install_workflow_block" ||
  fail "browser proof must stage the verified bottle bootstrap at its lazy URL"
grep -Fq 'programs/homebrew-bootstrap/' \
  <<<"$candidate_install_workflow_block" &&
  fail "browser bootstrap staging must not resolve the legacy registry package"
grep -Eq '(^|[[:space:]])(cp|mv|install|ln)[[:space:]].*(local-binaries|\$installed)' \
  <<<"$candidate_install_workflow_block" &&
  fail "candidate proof must not write or copy directly into local-binaries"
source_alias_line="$(grep -nF -- '- name: Select the source shell for dependent browser VFS builds' \
  "$WORKFLOW" | cut -d: -f1)"
browser_resolve_line="$(grep -nF -- '- name: Resolve exact shell browser inputs' \
  "$WORKFLOW" | cut -d: -f1)"
[ -n "$source_alias_line" ] && [ -n "$browser_resolve_line" ] &&
  [ "$source_alias_line" -lt "$browser_resolve_line" ] ||
  fail "source shell selection must precede every derived browser VFS resolution"
source_alias_workflow_block="$(sed -n \
  '/- name: Select the source shell for dependent browser VFS builds/,/- name: Resolve exact shell browser inputs/p' \
  "$WORKFLOW")"
grep -Fq 'scripts/install-local-shell-artifact.sh \' \
  <<<"$source_alias_workflow_block" &&
  grep -Fq 'scripts/activate-local-shell-build-override.sh "$CANDIDATE_PATH"' \
    <<<"$source_alias_workflow_block" &&
  grep -Fq '${{ steps.source_alias.outputs.local_manifest }}' "$WORKFLOW" &&
  grep -Fq '${{ steps.source_alias.outputs.link_manifest }}' "$WORKFLOW" ||
  fail "source shell selection must pin and monitor the exact local dependency override"
grep -Fq 'local_libs="$REPO_ROOT/local-libs"' "$LOCAL_SHELL_OVERRIDE" &&
  grep -Fq 'override_path="$shell_dir/build"' "$LOCAL_SHELL_OVERRIDE" &&
  grep -Fq 'ln -s "$override_target" "$override_path"' "$LOCAL_SHELL_OVERRIDE" &&
  grep -Fq 'cmp -s "$source_image" "$override_path/shell.vfs.zst"' \
    "$LOCAL_SHELL_OVERRIDE" ||
  fail "source shell dependency override must use and verify build-deps' supported local-libs tier"
grep -Fq -- '--force-source-build \' "$CI_BLOCKER_MATERIALIZER" ||
  fail "publication blockers must rebuild their exact PR recipes rather than accept cached canonical bytes"
grep -Fq 'mirror_mode="$(jq -er '\''.mode'\'' "$mirror_state")"' \
  "$CI_BLOCKER_MATERIALIZER" &&
  grep -Fq 'mirror_required="$(jq -er '\''' \
    "$CI_BLOCKER_MATERIALIZER" &&
  grep -Fq 'if type == "boolean" then tostring' \
    "$CI_BLOCKER_MATERIALIZER" &&
  grep -Fq '[ "$mirror_mode" = publication-blocked-candidate ]' \
    "$CI_BLOCKER_MATERIALIZER" &&
  grep -Fq 'candidate shell must require its closed bottle mirror' \
    "$CI_BLOCKER_MATERIALIZER" &&
  grep -Fq 'scripts/verify-ci-staging-shell-handoff.sh \' \
    "$CI_BLOCKER_MATERIALIZER" &&
  grep -Fq 'reuse exact staged bottle shell' \
    "$CI_BLOCKER_MATERIALIZER" &&
  grep -Fq 'source shell must not claim a closed bottle mirror' \
    "$CI_BLOCKER_MATERIALIZER" &&
  grep -Fq 'plain blocked state cannot carry candidate authority' \
    "$CI_BLOCKER_MATERIALIZER" ||
  fail "publication blockers must distinguish a receipt-bound bottle shell from the source bridge"
grep -Fq 'exact_override_is_active' "$LOCAL_SHELL_OVERRIDE" &&
  [ "$(grep -Fc 'scripts/activate-local-shell-build-override.sh' "$WORKFLOW")" -eq 2 ] ||
  fail "source shell override must be idempotently verified before and after derived VFS resolution"
grep -Fq 'PACKAGE_OWNED_PROGRAM_MIRRORS=' "$BUILD_PROGRAMS" &&
  grep -Fq 'packages/registry/program-packages.json' "$BUILD_PROGRAMS" &&
  grep -Fq 'package_owns_direct_program_path "$arch" "${name}.wasm"' \
    "$BUILD_PROGRAMS" &&
  grep -Fq 'package-owned resolver mirror is already occupied' \
    "$BUILD_PROGRAMS" &&
  grep -Fq 'package resolver owns $arch/${name}.wasm' "$BUILD_PROGRAMS" ||
  fail "direct test-program builds must leave package-owned resolver mirrors unoccupied"

materializer_install_line="$(grep -nF 'scripts/install-local-shell-artifact.sh' \
  "$CI_BLOCKER_MATERIALIZER" | cut -d: -f1)"
materializer_override_line="$(grep -nF 'scripts/activate-local-shell-build-override.sh' \
  "$CI_BLOCKER_MATERIALIZER" | cut -d: -f1)"
materializer_resolve_line="$(grep -nF 'for package in "${blocked_packages[@]}"; do' \
  "$CI_BLOCKER_MATERIALIZER" | cut -d: -f1)"
[ "$materializer_install_line" -lt "$materializer_override_line" ] &&
  [ "$materializer_override_line" -lt "$materializer_resolve_line" ] &&
  grep -Fq '[ "$package" != "shell" ] || continue' \
    "$CI_BLOCKER_MATERIALIZER" ||
  fail "CI blocker materialization must activate the bridge before resolving shell dependents"

staging_snapshot_block="$(sed -n \
  '/^  staging-shell-snapshot:/,/^  # ---------------------------------------------------------------------/p' \
  "$PREPARE_MERGE_WORKFLOW")"
for staging_binding in \
  'staging_run_id: ${{ steps.staging.outputs.run_id }}' \
  'ref: ${{ needs.synthesize-merge.outputs.base_sha }}' \
  'artifact-ids: ${{ steps.locate.outputs.artifact_id }}' \
  'run-id: ${{ env.STAGING_RUN_ID }}' \
  'github-token: ${{ github.token }}' \
  '.head_sha == $head' \
  'EXPECTED_TREE_SHA: ${{ needs.synthesize-merge.outputs.tree_sha }}' \
  'if [ "$producer_tree" != "$EXPECTED_TREE_SHA" ]; then' \
  'producer_tree="$(jq -er '\''.head_commit.tree_id'\'' "$run_json")"' \
  'nested pull_requests object is a live PR projection' \
  'archive_sha256=${archive_digest#sha256:}' \
  'staging shell artifact exceeds the 128 MiB handoff limit'
do
  grep -Fq "$staging_binding" "$PREPARE_MERGE_WORKFLOW" ||
    fail "prepare merge does not bind the exact staging shell: $staging_binding"
done
if grep -Eq 'uses: \./|bash scripts/|node scripts/' \
    <<<"$staging_snapshot_block"; then
  fail "write-capable staging snapshot must not execute pull-request repository code"
fi
grep -Fq 'EXPECTED_TREE_SHA: ${{ needs.synthesize-merge.outputs.tree_sha }}' \
    <<<"$staging_snapshot_block" &&
  grep -Fq 'if [ "$producer_tree" != "$EXPECTED_TREE_SHA" ]; then' \
    <<<"$staging_snapshot_block" ||
  fail "trusted staging snapshot does not bind producer bytes to the synthetic merge tree"
no_artifact_line="$(grep -nF 'if [ "$count" -eq 0 ]; then' \
  <<<"$staging_snapshot_block" | cut -d: -f1)"
producer_tree_line="$(grep -nF \
  'if [ "$producer_tree" != "$EXPECTED_TREE_SHA" ]; then' \
  <<<"$staging_snapshot_block" | cut -d: -f1)"
[ "$no_artifact_line" -lt "$producer_tree_line" ] &&
  grep -Fq 'staging shell producer tree differs from the synthetic merge; use the source fallback' \
    <<<"$staging_snapshot_block" ||
  fail "a divergent producer without a usable shell artifact must preserve the synthetic-merge fallback"
for blocker_selected_binding in \
  'use_staging_shell_handoff=false' \
  'any(.entries[]; .package == "shell")' \
  '[ "$STAGING_SHELL_AVAILABLE" = true ]' \
  'if [ "$use_staging_shell_handoff" = true ]; then' \
  'if [ "$USE_STAGING_SHELL_HANDOFF" = true ]; then'
do
  grep -Fq "$blocker_selected_binding" "$PREPARE_MERGE_WORKFLOW" ||
    fail "staging handoff is not conditional on the current shell blocker: $blocker_selected_binding"
done
prepare_handoff_download_line="$(grep -nF \
  -- '- name: Download the trusted staging shell handoff' \
  "$PREPARE_MERGE_WORKFLOW" | cut -d: -f1)"
prepare_synthetic_checkout_line="$(grep -nF \
  -- '- name: Checkout synthesized PR merge' \
  "$PREPARE_MERGE_WORKFLOW" | tail -n 1 | cut -d: -f1)"
[ "$prepare_handoff_download_line" -lt "$prepare_synthetic_checkout_line" ] ||
  fail "trusted shell bytes must arrive before synthetic pull-request code runs"
for candidate_transport_binding in \
  'publication-blocked-candidate' \
  '--staging-shell-handoff' \
  '.ci-staging-shell-receipt.json' \
  '.ci-staging-shell-report.json'
do
  grep -Fq -- "$candidate_transport_binding" "$CI_BROWSER_MIRROR_STATE" \
    "$CI_WORKSPACE_PACKER" "$CI_BLOCKER_MATERIALIZER" ||
    fail "candidate shell transport lacks: $candidate_transport_binding"
done

handoff_probe="$TMP_ROOT/staging-shell-handoff"
mkdir -p "$handoff_probe"
handoff_image="$handoff_probe/main-shell.vfs.zst"
handoff_report="$handoff_probe/main-shell-report.json"
handoff_receipt="$handoff_probe/receipt.json"
printf 'exact bottle-composed shell bytes\n' > "$handoff_image"
abi="$(grep -oE 'ABI_VERSION: u32 = [0-9]+' \
  "$REPO_ROOT/crates/shared/src/lib.rs" | awk '{print $4}')"
jq -n \
  --arg repository Automattic/kandelo \
  --argjson abi "$abi" '
    {
      schema: 1,
      image: "main-shell.vfs.zst",
      metadata: {
        kandelo_repository: $repository,
        kandelo_abi: $abi
      },
      package_deferred_trees: [{
        state: "deferred",
        package: {name: "homebrew-bootstrap"}
      }],
      bottle_mirror: {assets: [{name: "bash"}]}
    }
  ' > "$handoff_report"
handoff_image_sha="$(sha256sum "$handoff_image" | awk '{print $1}')"
handoff_image_bytes="$(wc -c < "$handoff_image" | tr -d '[:space:]')"
handoff_report_sha="$(sha256sum "$handoff_report" | awk '{print $1}')"
handoff_report_bytes="$(wc -c < "$handoff_report" | tr -d '[:space:]')"
handoff_base="$(printf 'a%.0s' {1..40})"
handoff_head="$(printf 'b%.0s' {1..40})"
handoff_tree="$(printf 'c%.0s' {1..40})"
handoff_archive_sha="$(printf 'd%.0s' {1..64})"
jq -n \
  --arg base "$handoff_base" \
  --arg head "$handoff_head" \
  --arg tree "$handoff_tree" \
  --arg archive_sha "$handoff_archive_sha" \
  --arg image_sha "$handoff_image_sha" \
  --argjson image_bytes "$handoff_image_bytes" \
  --arg report_sha "$handoff_report_sha" \
  --argjson report_bytes "$handoff_report_bytes" '
    {
      schema: 1,
      kind: "kandelo-ci-staging-shell-handoff",
      repository: "Automattic/kandelo",
      workflow: ".github/workflows/staging-build.yml",
      validation_pull_request_number: 1160,
      validation_base_sha: $base,
      producer_head_sha: $head,
      producer_tree_sha: $tree,
      run_id: 30695913285,
      artifact: {
        id: 8817612908,
        name: "homebrew-main-shell-closure",
        archive_sha256: $archive_sha,
        bytes: 58453095
      },
      image: {sha256: $image_sha, bytes: $image_bytes},
      report: {sha256: $report_sha, bytes: $report_bytes}
    }
  ' > "$handoff_receipt"
bash "$CI_STAGING_SHELL_VERIFIER" \
  "$handoff_receipt" "$handoff_image" "$handoff_report" \
  "$handoff_base" "$handoff_head" "$handoff_tree" 30695913285
expect_failure "receipt does not match the expected staging run" \
  bash "$CI_STAGING_SHELL_VERIFIER" \
    "$handoff_receipt" "$handoff_image" "$handoff_report" \
    "$handoff_base" "$handoff_head" "$handoff_tree" 30695913286
expect_failure "receipt does not match the expected staging run" \
  bash "$CI_STAGING_SHELL_VERIFIER" \
    "$handoff_receipt" "$handoff_image" "$handoff_report" \
    "$handoff_base" "$handoff_head" \
    "$(printf 'e%.0s' {1..40})" 30695913285
tampered_image="$handoff_probe/tampered.vfs.zst"
cp "$handoff_image" "$tampered_image"
printf 'substitution\n' >> "$tampered_image"
expect_failure "shell image differs from its receipt" \
  bash "$CI_STAGING_SHELL_VERIFIER" \
    "$handoff_receipt" "$tampered_image" "$handoff_report" \
    "$handoff_base" "$handoff_head" "$handoff_tree" 30695913285
tampered_report="$handoff_probe/tampered-report.json"
jq '.bottle_mirror.assets = []' "$handoff_report" > "$tampered_report"
expect_failure "report is not a bottle-composed shell contract" \
  bash "$CI_STAGING_SHELL_VERIFIER" \
    "$handoff_receipt" "$handoff_image" "$tampered_report" \
    "$handoff_base" "$handoff_head" "$handoff_tree" 30695913285
symlink_image="$handoff_probe/symlink.vfs.zst"
ln -s "$handoff_image" "$symlink_image"
expect_failure "shell image must be a regular non-symlink file" \
  bash "$CI_STAGING_SHELL_VERIFIER" \
    "$handoff_receipt" "$symlink_image" "$handoff_report" \
    "$handoff_base" "$handoff_head" "$handoff_tree" 30695913285

handoff_expected="$handoff_probe/expected.json"
handoff_blockers="$handoff_probe/blockers.json"
handoff_index="$handoff_probe/index.toml"
handoff_state="$handoff_probe/state.json"
jq -n --argjson abi "$abi" '{abi_version: $abi, entries: []}' \
  > "$handoff_expected"
jq -n --argjson abi "$abi" '
  {
    abi_version: $abi,
    entries: [{package: "shell", blocker_chain: ["shell"]}]
  }
' > "$handoff_blockers"
printf 'abi_version = %s\n' "$abi" > "$handoff_index"
bash "$CI_BROWSER_MIRROR_STATE" create \
  "$handoff_expected" "$handoff_blockers" \
  "$handoff_index" https://invalid.example/index.toml \
  "$handoff_image" "$handoff_state" "$handoff_receipt"
[ "$(jq -r '.mode' "$handoff_state")" = \
    publication-blocked-candidate ] &&
  [ "$(jq -r '.schema' "$handoff_state")" = 3 ] &&
  [ "$(jq -r '.mirror_required' "$handoff_state")" = true ] ||
  fail "candidate shell state did not preserve its distinct authority"
bash "$CI_BROWSER_MIRROR_STATE" validate producer \
  "$handoff_state" "$handoff_blockers" \
  "$handoff_image" "$handoff_receipt"
tampered_receipt="$handoff_probe/tampered-receipt.json"
jq '.run_id += 1' "$handoff_receipt" > "$tampered_receipt"
expect_failure "staging receipt does not match state" \
  bash "$CI_BROWSER_MIRROR_STATE" validate producer \
    "$handoff_state" "$handoff_blockers" \
    "$handoff_image" "$tampered_receipt"
expect_failure "candidate shell receipt must be one regular file" \
  bash "$CI_BROWSER_MIRROR_STATE" validate producer \
    "$handoff_state" "$handoff_blockers" "$handoff_image" -

override_probe="$TMP_ROOT/local-shell-override"
override_generation="$override_probe/generation"
override_candidate="$override_probe/candidate.vfs.zst"
mkdir -p "$override_probe/scripts" "$override_generation"
cp "$LOCAL_SHELL_OVERRIDE" "$override_probe/scripts/"
printf 'exact shell bytes\n' >"$override_candidate"
cp "$override_candidate" "$override_generation/shell.vfs.zst"
cat >"$override_probe/scripts/resolve-binary.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' '$override_generation/shell.vfs.zst'
EOF
chmod +x "$override_probe/scripts/resolve-binary.sh"
bash "$override_probe/scripts/activate-local-shell-build-override.sh" \
  "$override_candidate"
[ -L "$override_probe/local-libs/shell/build" ] &&
  [ "$(readlink "$override_probe/local-libs/shell/build")" = \
      "$override_generation" ] ||
  fail "local shell override did not select the exact installed generation"
# An exact repeat is required because CI verifies the same ownership boundary
# after resolving every reverse-dependent browser package.
bash "$override_probe/scripts/activate-local-shell-build-override.sh" \
  "$override_candidate"
mkdir "$override_probe/local-libs/unowned"
expect_failure "refusing to replace existing local-libs" \
  bash "$override_probe/scripts/activate-local-shell-build-override.sh" \
    "$override_candidate"
candidate_kernel_workflow_block="$(sed -n \
  '/- name: Build the exact candidate kernel/,/- name: Build the exact source-rootfs activation shell/p' \
  "$WORKFLOW")"
for installed_kernel_contract in \
  'id: candidate_kernel' \
  'kernel_member="$(realpath local-binaries/kernel.wasm)"' \
  '.publication-claimed' \
  'printf "path=%s\n" "$kernel_member" >> "$GITHUB_OUTPUT"'
do
  grep -Fq "$installed_kernel_contract" \
    <<<"$candidate_kernel_workflow_block" ||
    fail "candidate kernel step does not expose its immutable installed member: $installed_kernel_contract"
done
node_smoke_workflow_block="$(sed -n \
  '/- name: Boot the exact installed bytes in Node/,/- name: Exercise the live first- and third-party lifecycle in Node/p' \
  "$WORKFLOW")"
grep -Fq -- '--image "${{ steps.image.outputs.path }}"' \
  <<<"$node_smoke_workflow_block" ||
  fail "Node proof must boot the exact candidate bytes directly"
grep -Fq -- '--kernel "${{ steps.candidate_kernel.outputs.path }}"' \
  <<<"$node_smoke_workflow_block" ||
  fail "source-rootfs Node proof must boot the immutable installed kernel member"
grep -Fq -- '--demo-profile-overlay homebrew/source-rootfs-shell-demo-profiles.json' \
  <<<"$node_smoke_workflow_block" ||
  fail "source-rootfs Node proof must validate its image-owned demo profiles"
grep -Fq -- '--migration-lock homebrew/main-shell-migration-lock.json' \
  <<<"$node_smoke_workflow_block" ||
  fail "post-archive Node proof must validate against the reviewed migration lock"
grep -Fq -- '--homebrew-bootstrap-spec homebrew/main-shell-brew-package-tree.json' \
  <<<"$node_smoke_workflow_block" ||
  fail "Node proof must derive the exact Homebrew package tree"
grep -Fq -- '--homebrew-bootstrap-archive "${{ steps.bottle_candidate.outputs.bootstrap }}"' \
  <<<"$node_smoke_workflow_block" ||
  fail "Node proof must bind the exact standalone Homebrew package bytes"
grep -Fq -- '--homebrew-bootstrap-state deferred' \
  <<<"$node_smoke_workflow_block" ||
  fail "Node proof must assert the deferred source state"
grep -Fq -- '--demo-config homebrew/main-shell-demo.json' \
  <<<"$node_smoke_workflow_block" ||
  fail "post-archive Node proof must validate the canonical demo config bytes"
grep -Fq 'node_smoke_args=(' <<<"$node_smoke_workflow_block" ||
  fail "Node proof must build one explicit transport-aware argument vector"
grep -Fq 'scripts/homebrew-main-shell-node-smoke.ts \' \
  <<<"$node_smoke_workflow_block" ||
  fail "Node proof must boot the deferred shell candidate"
grep -Fq 'materialized' <<<"$node_smoke_workflow_block" &&
  fail "Node proof must not boot a partial source-materialized derivative"
grep -Fq 'case "$SHELL_ACTIVATION_MODE" in' <<<"$node_smoke_workflow_block" ||
  fail "Node proof must preserve distinct source-rootfs and bottle activation lanes"
grep -Fq 'case "$TRANSPORT_MODE" in' <<<"$node_smoke_workflow_block" ||
  fail "Node proof must branch explicitly on closed versus public transport"
grep -Fq '"${node_smoke_args[@]}"' <<<"$node_smoke_workflow_block" ||
  fail "Node proof must invoke the smoke with its checked argument vector"
[ "$(grep -Fc -- '--bottle-mirror-plan' <<<"$node_smoke_workflow_block")" -eq 1 ] ||
  fail "Node proof must declare the closed bottle mirror plan exactly once"
closed_mode_line="$(grep -nF 'closed)' <<<"$node_smoke_workflow_block" | cut -d: -f1)"
mirror_plan_line="$(grep -nF -- '--bottle-mirror-plan' <<<"$node_smoke_workflow_block" | cut -d: -f1)"
public_mode_line="$(grep -nF 'public)' <<<"$node_smoke_workflow_block" | cut -d: -f1)"
[ -n "$closed_mode_line" ] && [ -n "$mirror_plan_line" ] && [ -n "$public_mode_line" ] &&
  [ "$closed_mode_line" -lt "$mirror_plan_line" ] &&
  [ "$mirror_plan_line" -lt "$public_mode_line" ] ||
  fail "Node proof must pass --bottle-mirror-plan only inside the closed transport branch"
grep -Fq '(mode === "closed" && !plan)' "$NODE_SMOKE" ||
  fail "Node smoke must require a local mirror plan in closed mode"
grep -Fq '(mode === "public" && plan !== undefined)' "$NODE_SMOKE" ||
  fail "Node smoke must reject a local mirror plan in public mode"

for input_contract in \
  "Exact live Kandelo default-branch commit M" \
  "Exact selected first-party bottle-catalog commit TF" \
  "Exact live first-party tap main commit TA" \
  "Exact live independent-canary tap commit C"
do
  grep -Fq "$input_contract" "$WORKFLOW" ||
    fail "manual live lifecycle is missing input contract: $input_contract"
done
jq -e '
  .lifecycle_installs[0].revision |
  type == "string" and test("^[0-9a-f]{40}$")
' "$RUNTIME_SUPPORT" >/dev/null ||
  fail "runtime support must bind one exact reviewed canary product revision"
grep -Fq \
  "SHELL_ACTIVATION_MODE: bottles" \
  "$WORKFLOW" ||
  fail "every Homebrew main-shell gate must select the bottled product lane"

live_input_block="$(sed -n \
  '/- name: Bind exact catalog and live lifecycle revisions/,/- name: Fetch musl submodule/p' \
  "$WORKFLOW")"
for exact_binding in \
  "(inputs.caller_event_name || github.event_name) == 'workflow_dispatch' && inputs.transport_mode == 'closed'" \
  '[ "$SHELL_ACTIVATION_MODE" = bottles ]' \
  '[[ "$revision" =~ ^[0-9a-f]{40}$ ]]' \
  '[ "$GITHUB_REF" = refs/heads/main ]' \
  '[ "$(git rev-parse HEAD)" = "$KANDELO_M" ]' \
  'env -u GH_TOKEN -u GITHUB_TOKEN git ls-remote' \
  'require_exact_live_main() {' \
  '"$repository" refs/heads/main' \
  '[ -n "$record" ]' \
  '[ "$(printf '\''%s\n'\'' "$record" | wc -l | tr -d '\''[:space:]'\'')" -eq 1 ]' \
  '[ "${record#*[[:space:]]}" = refs/heads/main ]' \
  '[ "${record%%[[:space:]]*}" = "$expected" ]' \
  '"https://github.com/${GITHUB_REPOSITORY}.git" "$KANDELO_M"' \
  '"https://github.com/Kandelo-dev/homebrew-tap-core.git" \' \
  '"$CORE_TAP_LIVE_TA"' \
  '"https://github.com/brandonpayton/homebrew-kandelo-canary.git" "$CANARY_C"' \
  'homebrew/main-shell-homebrew-runtime-support.json' \
  'homebrew/main-shell-migration-lock.json' \
  '"$CORE_TAP_CATALOG_TF" ]' \
  'jq -e --arg canary "$CANARY_C"' \
  '$installs[0].revision == $canary' \
  'git -C "$tap_authority_root" fetch --quiet --no-tags \' \
  '--filter=blob:none origin refs/heads/main' \
  'git -C "$tap_authority_root" merge-base --is-ancestor \' \
  '"$CORE_TAP_CATALOG_TF" "$CORE_TAP_LIVE_TA"' \
  'echo "m=$KANDELO_M"' \
  'echo "catalog=$CORE_TAP_CATALOG_TF"' \
  'echo "tap=$CORE_TAP_LIVE_TA"' \
  'echo "c=$CANARY_C"'
do
  grep -Fq -- "$exact_binding" <<<"$live_input_block" ||
    fail "manual lifecycle does not bind exact M/TF/TA/C input: $exact_binding"
done
grep -Fq 'mistakes reachability for live' <<<"$live_input_block" &&
  grep -Fq 'local locks separately own catalog TF' \
    <<<"$live_input_block" &&
  grep -Fq 'intentionally different' <<<"$live_input_block" ||
  fail "the M/TF/TA/C boundary needs its maintenance rationale inline"
runtime_tf_lock_line="$(grep -nF \
  'homebrew/main-shell-homebrew-runtime-support.json)" = \' \
  <<<"$live_input_block" | head -n1 | cut -d: -f1)"
migration_tf_lock_line="$(grep -nF \
  'homebrew/main-shell-migration-lock.json' <<<"$live_input_block" |
  head -n1 | cut -d: -f1)"
canary_product_lock_line="$(grep -nF \
  'jq -e --arg canary "$CANARY_C"' <<<"$live_input_block" |
  head -n1 | cut -d: -f1)"
live_helper_line="$(grep -nF \
  'require_exact_live_main() {' <<<"$live_input_block" |
  head -n1 | cut -d: -f1)"
kandelo_live_call_line="$(grep -nF \
  '"https://github.com/${GITHUB_REPOSITORY}.git" "$KANDELO_M"' \
  <<<"$live_input_block" | head -n1 | cut -d: -f1)"
core_live_call_line="$(grep -nF \
  '"https://github.com/Kandelo-dev/homebrew-tap-core.git" \' \
  <<<"$live_input_block" | head -n1 | cut -d: -f1)"
canary_live_call_line="$(grep -nF \
  '"https://github.com/brandonpayton/homebrew-kandelo-canary.git" "$CANARY_C"' \
  <<<"$live_input_block" | head -n1 | cut -d: -f1)"
tap_ancestry_line="$(grep -nF \
  'git -C "$tap_authority_root" merge-base --is-ancestor \' \
  <<<"$live_input_block" | head -n1 | cut -d: -f1)"
[ -n "$runtime_tf_lock_line" ] && [ -n "$migration_tf_lock_line" ] &&
  [ -n "$canary_product_lock_line" ] && [ -n "$live_helper_line" ] &&
  [ -n "$kandelo_live_call_line" ] && [ -n "$core_live_call_line" ] &&
  [ -n "$canary_live_call_line" ] && [ -n "$tap_ancestry_line" ] &&
  [ "$runtime_tf_lock_line" -lt "$live_helper_line" ] &&
  [ "$migration_tf_lock_line" -lt "$live_helper_line" ] &&
  [ "$canary_product_lock_line" -lt "$live_helper_line" ] &&
  [ "$live_helper_line" -lt "$kandelo_live_call_line" ] &&
  [ "$kandelo_live_call_line" -lt "$core_live_call_line" ] &&
  [ "$core_live_call_line" -lt "$canary_live_call_line" ] &&
  [ "$canary_live_call_line" -lt "$tap_ancestry_line" ] ||
  fail "catalog locks, live heads, and TF-to-TA ancestry are misordered"

live_head_matches_record() {
  local supplied_revision="$1"
  local main_record="$2"
  [ -n "$main_record" ] &&
    [ "$(printf '%s\n' "$main_record" | wc -l | tr -d '[:space:]')" -eq 1 ] &&
    [ "${main_record#*[[:space:]]}" = refs/heads/main ] &&
    [ "${main_record%%[[:space:]]*}" = "$supplied_revision" ]
}
exact_live_ta="1111111111111111111111111111111111111111"
stale_but_reachable_ta="2222222222222222222222222222222222222222"
exact_live_c="3333333333333333333333333333333333333333"
stale_but_reachable_c="4444444444444444444444444444444444444444"
synthetic_ta_main="$exact_live_ta"$'\trefs/heads/main'
synthetic_ta_reachable="$stale_but_reachable_ta"$'\trefs/tags/rehearsal'
synthetic_c_main="$exact_live_c"$'\trefs/heads/main'
synthetic_c_reachable="$stale_but_reachable_c"$'\trefs/tags/rehearsal'
live_head_matches_record "$exact_live_ta" "$synthetic_ta_main" ||
  fail "exact live TA must satisfy the anonymous main-head binding"
live_head_matches_record "$exact_live_c" "$synthetic_c_main" ||
  fail "exact live C must satisfy the anonymous main-head binding"
if live_head_matches_record "$stale_but_reachable_ta" "$synthetic_ta_main" ||
   live_head_matches_record "$stale_but_reachable_ta" "$synthetic_ta_reachable"
then
  fail "stale-but-reachable TA must not satisfy the live main-head binding"
fi
if live_head_matches_record "$stale_but_reachable_c" "$synthetic_c_main" ||
   live_head_matches_record "$stale_but_reachable_c" "$synthetic_c_reachable"
then
  fail "stale-but-reachable C must not satisfy the live main-head binding"
fi
if live_head_matches_record \
  "$exact_live_ta" "$synthetic_ta_main"$'\n'"$synthetic_ta_main"
then
  fail "duplicate live tap records must fail the exact-one-record binding"
fi

live_input_line="$(grep -nF -- \
  '- name: Bind exact catalog and live lifecycle revisions' \
  "$WORKFLOW" | cut -d: -f1)"
bottle_candidate_line="$(grep -nF -- '- name: Build the exact lazy shell from public bottles' \
  "$WORKFLOW" | cut -d: -f1)"
[ -n "$live_input_line" ] && [ -n "$bottle_candidate_line" ] &&
  [ "$live_input_line" -lt "$bottle_candidate_line" ] ||
  fail "live M/TF/TA/C validation must precede candidate and lifecycle work"

live_fixture_block="$(sed -n \
  '/- name: Create the exact closed Chromium lifecycle fixture/,/- name: Build the sealed browser product tree/p' \
  "$WORKFLOW")"
for fixture_binding in \
  "if: (inputs.caller_event_name || github.event_name) == 'workflow_dispatch' && inputs.transport_mode == 'closed'" \
  '[ "${{ steps.live-inputs.outputs.catalog }}" = \' \
  '"${{ steps.bottle_candidate.outputs.tap_sha }}" ]' \
  'scripts/create-homebrew-guest-lifecycle-fixture.ts' \
  'env -u GH_TOKEN -u GITHUB_TOKEN git ls-remote' \
  '.activation.atomic_group == $runtime_id' \
  '.materialization.runtime_support.package_order ==' \
  '$support[0].additional_formula_order' \
  '.materialization.runtime_support.tree_count ==' \
  '.materialization.runtime_support.deferred_relocation_formulae ==' \
  '$support[0].deferred_formulae[].package' \
  '.materialization.deferred_package_order +' \
  '[.bottle_mirror.assets[].package]' \
  '--image "${{ steps.bottle_candidate.outputs.image }}"' \
  '--homebrew-bootstrap-spec homebrew/main-shell-brew-package-tree.json' \
  '--homebrew-bootstrap-archive "${{ steps.bottle_candidate.outputs.bootstrap }}"' \
  '--homebrew-bootstrap-env "${{ steps.bottle_candidate.outputs.bootstrap_env }}"' \
  '--bottle-mirror "$RUNNER_TEMP/homebrew-main-shell-bottles"' \
  '--core-revision "${{ steps.live-inputs.outputs.tap }}"' \
  '--canary-revision "${{ steps.live-inputs.outputs.c }}"' \
  'install_browser_fixture_asset "${{ steps.bottle_candidate.outputs.image }}"' \
  'install_browser_fixture_asset homebrew/main-shell-brew-package-tree.json' \
  'install_browser_fixture_asset "${{ steps.bottle_candidate.outputs.bootstrap }}"' \
  'install_browser_fixture_asset "${{ steps.bottle_candidate.outputs.bootstrap_env }}"'
do
  grep -Fq -- "$fixture_binding" <<<"$live_fixture_block" ||
    fail "Chromium fixture does not bind the Node lifecycle input: $fixture_binding"
done
grep -Fq 'same already-verified candidate bytes' <<<"$live_fixture_block" ||
  fail "closed Chromium fixture routing needs its cross-host rationale inline"
grep -Fq 'shell bottle closure is not itself a brew runtime' <<<"$live_fixture_block" ||
  fail "live lifecycle atomic runtime precondition needs its rationale inline"

live_node_block="$(sed -n \
  '/- name: Exercise the live first- and third-party lifecycle in Node/,/- name: Boot the current main-shell path in Chromium/p' \
  "$WORKFLOW")"
grep -Fq \
  "if: (inputs.caller_event_name || github.event_name) == 'workflow_dispatch' && inputs.transport_mode == 'closed'" \
  <<<"$live_node_block" ||
  fail "the Node live lifecycle must remain manual and closed-transport only"
for node_binding in \
  'homebrew/test/homebrew_guest_lifecycle_node.ts' \
  '--image "${{ steps.bottle_candidate.outputs.image }}"' \
  '--homebrew-bootstrap-spec homebrew/main-shell-brew-package-tree.json' \
  '--homebrew-bootstrap-archive "${{ steps.bottle_candidate.outputs.bootstrap }}"' \
  '--homebrew-bootstrap-env "${{ steps.bottle_candidate.outputs.bootstrap_env }}"' \
  '--transport-mode closed' \
  '--bottle-mirror-plan "${{ steps.mirror.outputs.plan }}"' \
  '--proof-mode comprehensive' \
  '--core-revision "${{ steps.live-inputs.outputs.tap }}"' \
  '--canary-revision "${{ steps.live-inputs.outputs.c }}"'
do
  grep -Fq -- "$node_binding" <<<"$live_node_block" ||
    fail "product workflow does not invoke the exact Node lifecycle input: $node_binding"
done
grep -Fq 'await main();' "$GUEST_LIFECYCLE_NODE" ||
  fail "the product workflow target is not the executable Node lifecycle runner"
grep -Fq 'writeNewJson(out, validated)' "$GUEST_LIFECYCLE_FIXTURE" ||
  fail "Chromium fixture generator must write only the validated exact fixture"

grep -Fq '${{ steps.image.outputs.path }}' "$WORKFLOW" ||
  fail "main-shell evidence must retain the exact candidate image"
grep -Fq '${{ steps.bottle_candidate.outputs.report }}' "$WORKFLOW" ||
  fail "main-shell evidence must retain the candidate composition report"
for evidence in \
  '${{ steps.bottle_candidate.outputs.bootstrap }}' \
  '${{ steps.bottle_candidate.outputs.bootstrap_env }}' \
  '${{ steps.bottle_candidate.outputs.bootstrap_bottle_report }}' \
  '${{ runner.temp }}/homebrew-guest-lifecycle-browser-fixture.json' \
  '${{ runner.temp }}/homebrew-guest-lifecycle-playwright.json'
do
  grep -Fq "$evidence" "$WORKFLOW" ||
    fail "main-shell evidence must retain $evidence"
done
grep -Fq 'apps/browser-demos/test-results' "$WORKFLOW" ||
  fail "main-shell evidence must retain browser failure traces"
browser_smoke_workflow_block="$(sed -n \
  '/- name: Boot the current main-shell path in Chromium/,/- name: Upload exact closure evidence/p' \
  "$WORKFLOW")"
grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT"' \
  <<<"$browser_smoke_workflow_block" ||
  fail "sealed Chromium previews must retain the approved cache root inside dev-shell"
# WHY: process isolation is a contract of each heavyweight browser proof, not
# an incidental total invocation count. Name every standalone command so adding
# another legitimate proof cannot silently relabel which contracts are isolated.
browser_invocation_for() {
  local test_path="$1"
  awk -v test_path="$test_path" '
    index($0, "bash ../../scripts/dev-shell.sh env \\") {
      invocation = $0 ORS
      active = 1
      matched = 0
      next
    }
    active {
      invocation = invocation $0 ORS
      if (index($0, "npx playwright test " test_path " \\")) {
        matched = 1
      }
      if (matched && $0 !~ /\\[[:space:]]*$/) {
        printf "%s", invocation
        exit
      }
      if (!matched && $0 !~ /\\[[:space:]]*$/) {
        active = 0
      }
    }
  ' "$WORKFLOW"
}
guest_lifecycle_browser_invocation="$(
  browser_invocation_for "test/homebrew-guest-lifecycle.spec.ts"
)"
grep -Fq 'bash ../../scripts/dev-shell.sh env \' \
  <<<"$guest_lifecycle_browser_invocation" &&
  grep -Fq '"KANDELO_BROWSER_DEMO_INPUTS=homebrew-vfs-test"' \
    <<<"$guest_lifecycle_browser_invocation" &&
  grep -Fq -- '--grep "rejects a guest lifecycle fixture"' \
    <<<"$guest_lifecycle_browser_invocation" ||
  fail "offline guest-lifecycle rejection must run in its own browser process"
live_guest_lifecycle_browser_invocation="$(sed -n \
  '/# Run the rebooting live lifecycle/,/--reporter=json/p' \
  "$WORKFLOW")"
for live_browser_binding in \
  '"PLAYWRIGHT_JSON_OUTPUT_FILE=$lifecycle_report"' \
  '"KANDELO_BROWSER_DEMO_INPUTS=homebrew-vfs-test"' \
  '"KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE=1"' \
  '"KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH=${{ steps.live-fixture.outputs.fixture }}"' \
  'npx playwright test test/homebrew-guest-lifecycle.spec.ts' \
  '--grep "survives a Chromium rootfs reboot"' \
  '--reporter=json'
do
  grep -Fq -- "$live_browser_binding" \
    <<<"$live_guest_lifecycle_browser_invocation" ||
    fail "live Chromium lifecycle invocation is missing: $live_browser_binding"
done
grep -Fq 'same exact image/bootstrap/mirror as Node' \
  <<<"$live_guest_lifecycle_browser_invocation" ||
  fail "live Chromium lifecycle needs its Node-parity rationale inline"
shell_browser_invocation="$(
  browser_invocation_for '"$shell_spec"'
)"
grep -Fq 'bash ../../scripts/dev-shell.sh env \' \
  <<<"$shell_browser_invocation" &&
  grep -Fq '"PLAYWRIGHT_JSON_OUTPUT_FILE=$shell_report" \' \
    <<<"$shell_browser_invocation" &&
grep -Fq -- '--project=chromium --reporter=json' \
    <<<"$shell_browser_invocation" ||
  fail "shell acceptance must run in its own reporting browser process"
grep -Fq '"PLAYWRIGHT_JSON_OUTPUT_FILE=$shell_report"' "$WORKFLOW" ||
  fail "shell acceptance must have Playwright write JSON directly to its report file"
grep -Fq 'shell_spec=test/kandelo-homebrew-main-shell.spec.ts' "$WORKFLOW" &&
  grep -Fq 'npx playwright test "$shell_spec" \' "$WORKFLOW" ||
  fail "bottle activation must select and run the exact Homebrew shell proof"
[ "$(grep -Fc '.stats.expected == 1 and .stats.unexpected == 0 and' "$WORKFLOW")" -eq 2 ] ||
  fail "shell and lifecycle acceptance must each require one pristine browser proof"
modeset_browser_block="$(
  sed -n \
    '/# WHY: modeset and its launch profile/,/^            fi$/p' \
    "$WORKFLOW"
)"
[ "$(grep -Fc 'npx playwright test test/kandelo-modeset.spec.ts' "$WORKFLOW")" -eq 1 ] &&
  grep -Fq 'if [ "$SHELL_ACTIVATION_MODE" = bottles ]; then' \
    <<<"$modeset_browser_block" &&
  grep -Fq 'npx playwright test test/kandelo-modeset.spec.ts' \
    <<<"$modeset_browser_block" &&
  grep -Fq 'reports+=("$modeset_report")' <<<"$modeset_browser_block" &&
  grep -Fq 'reports=("$shell_report")' "$WORKFLOW" &&
  grep -Fq 'for report in "${reports[@]}"; do' "$WORKFLOW" ||
  fail "browser acceptance must validate shell plus only image-owned optional proofs"
grep -Fq "' \"\$lifecycle_report\" >/dev/null" "$WORKFLOW" ||
  fail "live lifecycle acceptance must validate its exact one-test report"
grep -Fq 'page.goto("/?demo=modeset"' "$BROWSER_SMOKE" &&
  fail "Homebrew shell acceptance must not start a second VFS in its browser process"
grep -Fq -- '--project=chromium --reporter=json >"$report"' "$WORKFLOW" &&
  fail "browser acceptance must not mix dev-shell stdout into the Playwright JSON report"
grep -Fq "jq -r '.packages[].registry.name' homebrew/main-shell-migration-lock.json" "$WORKFLOW" &&
  fail "main-shell workflow must not prefetch the legacy package-registry closure"
grep -Fq 'fetch_args+=(--package "$package")' "$WORKFLOW" ||
  fail "browser bundling input fetch must pass exact positive package selections"
grep -Fq 'scripts/fetch-binaries.sh "${fetch_args[@]}"' "$WORKFLOW" ||
  fail "binary fetch must materialize only direct browser bundling inputs"
browser_fetch_block="$(sed -n \
  "/- name: Resolve exact shell browser inputs/,/- name: Install the candidate's exact shell bytes/p" \
  "$WORKFLOW")"
grep -Fq 'while IFS= read -r -d '"'"''"'"' path &&' \
  <<<"$browser_fetch_block" &&
  fail "browser link verifier must not silently accept an odd manifest record"
grep -Fq 'while IFS= read -r -d '"'"''"'"' path; do' \
  <<<"$browser_fetch_block" &&
  grep -Fq 'selected shell link manifest has an incomplete record' \
    <<<"$browser_fetch_block" &&
  grep -Fq '[ "$(readlink "$path")" = "$expected_target" ]' \
    <<<"$browser_fetch_block" &&
  grep -Fq '[ "$verified_links" -gt 0 ]' <<<"$browser_fetch_block" &&
  ! grep -Fq 'cmp "${{ steps.source_alias.outputs.link_manifest }}"' \
    <<<"$browser_fetch_block" ||
  fail "browser resolution must preserve selected shell links while allowing new mirrors"
grep -Fq 'fetch_args=(--fetch-only)' <<<"$browser_fetch_block" ||
  fail "shell browser inputs must reject unpublished cache keys"
grep -Fq 'bash scripts/dev-shell.sh env \' <<<"$browser_fetch_block" &&
  grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    <<<"$browser_fetch_block" ||
  fail "browser package fetch must retain the approved cache root inside dev-shell"
grep -Fq 'fetch_args=()' <<<"$browser_fetch_block" &&
  fail "shell browser inputs must not permit source-build fallback"
grep -Fq 'WASM_POSIX_FETCH_SKIP_PKGS:' "$WORKFLOW" &&
  fail "main-shell proof must not use a negative package skip list"
grep -Fq 'node scripts/browser-binary-package-roots.mjs \' "$WORKFLOW" ||
  fail "main-shell workflow must derive browser package roots from source imports"
grep -Fq -- '--arch wasm32 \' "$WORKFLOW" ||
  fail "browser package derivation must select the candidate image architecture"
grep -Fq -- '--html-entry index.html \' <<<"$browser_fetch_block" &&
  grep -Fq -- '--html-entry pages/homebrew-vfs-test/index.html \' \
    <<<"$browser_fetch_block" ||
  fail "browser package derivation must follow the exact shell proof HTML entries"
grep -Fq -- '--arch wasm64 \' <<<"$browser_fetch_block" &&
  fail "wasm32 shell proof must not materialize unrelated wasm64 gallery roots"
grep -Fq -- '--exclude-package shell \' "$WORKFLOW" ||
  fail "browser package derivation must reserve shell for the exact bottle archive"
grep -Fq -- '--local-capability kernel-wasm \' \
  <<<"$browser_fetch_block" &&
  grep -Fq -- '--package-capability rootfs-vfs=rootfs \' \
    <<<"$browser_fetch_block" ||
  fail "browser package derivation must bind both virtual artifact capabilities"
grep -Fq -- '--include-package rootfs' <<<"$browser_fetch_block" &&
  fail "browser package derivation must not hand-maintain the rootfs alias"
grep -Fq 'mapfile -t browser_input_packages < "$browser_package_file"' "$WORKFLOW" ||
  fail "main-shell workflow must consume the derived browser package roots"
grep -Fq 'browser_input_packages=(' "$WORKFLOW" &&
  fail "main-shell workflow must not hand-maintain a partial browser package list"

browser_build_block="$(sed -n \
  '/- name: Build the sealed browser product tree/,/- name: Boot the exact installed bytes in Node/p' \
  "$WORKFLOW")"
grep -Fq 'bash ../../scripts/dev-shell.sh env \' <<<"$browser_build_block" &&
  grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    <<<"$browser_build_block" ||
  fail "sealed Vite build must retain the approved cache root inside dev-shell"
grep -Fq 'build_env+=("KANDELO_BROWSER_DEMO_INPUTS=main")' \
  <<<"$browser_build_block" ||
  fail "sealed shell proof must build only the real root product entry"
grep -Fq 'bash ../../scripts/verify-browser-shell-vfs-asset.sh \' \
  <<<"$browser_build_block" &&
  grep -Fq 'dist "${{ steps.image.outputs.path }}"' \
    <<<"$browser_build_block" &&
  ! grep -Fq 'dist/shell.vfs.zst' <<<"$browser_build_block" ||
  fail "sealed Vite build must verify its exact hashed shell asset"

for package_workflow in \
  "$STAGING_WORKFLOW" \
  "$PREPARE_MERGE_WORKFLOW" \
  "$FORCE_REBUILD_WORKFLOW"
do
  grep -Fq 'Install shell VFS composer dependencies' "$package_workflow" &&
    fail "$package_workflow must not own a shell-recipe prerequisite"
  grep -Fq 'npm --prefix tools/mkrootfs ci' "$package_workflow" &&
    fail "$package_workflow must let the shell source recipe install mkrootfs"
done

# WHY: publisher preflight already enters the repository dev shell before it
# runs this complete contract suite. Re-entering the wrapper would require the
# Nix command itself to be a package build tool, even though only the flake's
# declared build tools belong inside the purified shell. The suite's caller
# owns that one shell-entry boundary.
bash "$SHELL_TOOL_PREPARER_TEST" ||
  fail "shell source-build tool preparation tests failed"
[ "$(grep -Fc 'bash "$SCRIPT_DIR/prepare-build-tools.sh" "$SOURCE_ROOT"' "$SHELL_BUILDER")" -eq 1 ] ||
  fail "shell recipe must prepare its locked build tools exactly once"
preparer_line="$(grep -nF 'bash "$SCRIPT_DIR/prepare-build-tools.sh" "$SOURCE_ROOT"' \
  "$SHELL_BUILDER" | cut -d: -f1)"
composer_line="$(grep -nF 'bash "$SOURCE_ROOT/scripts/build-homebrew-main-shell-product.sh"' \
  "$SHELL_BUILDER" | tail -1 | cut -d: -f1)"
[ -n "$preparer_line" ] &&
  [ -n "$composer_line" ] &&
  [ "$preparer_line" -lt "$composer_line" ] ||
  fail "shell recipe must prepare locked tools before starting the composer"
grep -Fq '"packages/registry/shell/prepare-build-tools.sh"' \
  "$SHELL_BUILD_TOML" ||
  fail "shell cache identity must include its build-tool preparer"
grep -A4 -F 'name = "npm"' "$SHELL_PACKAGE_TOML" |
  grep -Fq 'version_constraint = ">=10.0"' ||
  fail "shell package must declare the npm host tool its recipe executes"
grep -A4 -F 'name = "python3"' "$SHELL_PACKAGE_TOML" |
  grep -Fq 'version_constraint = ">=3.11"' ||
  fail "shell package must declare Python with standard-library tomllib"
grep -Fq 'git jq node npm python3 ruby sha256sum tar wc' \
  "$REPO_ROOT/packages/registry/shell/build-tool-path.sh" ||
  fail "shell Nix-source validation must include Python"
grep -Fq '${PRODUCT_REVIEW_ARGS[@]+"${PRODUCT_REVIEW_ARGS[@]}"}' \
  "$SHELL_BUILDER" ||
  fail "publishable shell recipe must support Bash 3.2 with no review option"
grep -Fq '# WHY: the package resolver may source-build shell' \
  "$SHELL_TOOL_PREPARER" ||
  fail "shell tool ownership boundary must retain its WHY comment"
grep -Fq 'env -i \' "$SHELL_TOOL_PREPARER" ||
  fail "shell tool installs must start from a scrubbed environment"
grep -Fq 'npm_config_registry="https://registry.npmjs.org/"' \
  "$SHELL_TOOL_PREPARER" ||
  fail "shell tool installs must pin the public npm registry"
grep -Fq 'npm ci' "$SHELL_BUILDER" &&
  fail "shell wrapper must not mutate checkout-global dependency trees"

# The dev-shell wrapper intentionally reports Nix lookup and shell-hook details
# on stdout. Playwright must own the JSON file directly so those diagnostics can
# remain visible without corrupting machine-readable acceptance evidence.
playwright_report="$TMP_ROOT/playwright-report.json"
wrapper_log="$TMP_ROOT/dev-shell-stdout.log"
(
  echo "path does not contain a flake.nix, searching up"
  echo "kandelo dev shell — declared tools are ready"
  PLAYWRIGHT_JSON_OUTPUT_FILE="$playwright_report" node -e '
    const fs = require("node:fs");
    process.stdout.write("playwright command stdout remains diagnostic-only\n");
    fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
      stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    }));
  '
) >"$wrapper_log"
grep -Fq "path does not contain a flake.nix" "$wrapper_log" ||
  fail "noisy-wrapper fixture did not preserve dev-shell diagnostics"
grep -Fq "playwright command stdout remains diagnostic-only" "$wrapper_log" ||
  fail "noisy-wrapper fixture did not preserve command diagnostics"
jq -e '
  .stats.expected == 1 and .stats.unexpected == 0 and
  .stats.flaky == 0 and .stats.skipped == 0
' "$playwright_report" >/dev/null ||
  fail "direct Playwright JSON report was corrupted by noisy wrapper stdout"
grep -Fq "flake.nix" "$playwright_report" &&
  fail "dev-shell diagnostics leaked into the direct Playwright JSON report"

grep -Fq '[[git_inputs]]' "$SHELL_BUILD_TOML" &&
  fail "shell build.toml must not declare a raw tap beside its selection"
shell_revision="$(sed -nE \
  's/^revision[[:space:]]*=[[:space:]]*([1-9][0-9]*)$/\1/p' \
  "$SHELL_BUILD_TOML")"
[ -n "$shell_revision" ] &&
  [ "$(grep -Ec '^revision[[:space:]]*=' "$SHELL_BUILD_TOML")" -eq 1 ] ||
  fail "reduced lazy shell must declare one positive package revision"
artifact_state="$(jq -er '.state' "$LAZY_ARTIFACT_LOCK")"
case "$artifact_state" in
  sealed) expected_publication_state=ready ;;
  pending) expected_publication_state=pending ;;
  *) fail "lazy shell artifact lock has an unsupported state" ;;
esac
grep -Eq \
  "^publication_state[[:space:]]*=[[:space:]]*\"$expected_publication_state\"$" \
  "$SHELL_BUILD_TOML" ||
  fail "shell publication state must match its artifact lock"
for shell_input in \
  homebrew/main-shell-demo.json \
  web-libs/kandelo-session/src/demo-config.ts
do
  grep -Fq "\"$shell_input\"" "$SHELL_BUILD_TOML" ||
    fail "shell build cache inputs omit $shell_input"
done
for materialized_shell_input in \
  homebrew/main-shell-selection-lock.json \
  homebrew/main-shell-lazy-artifact-lock.json \
  homebrew/main-shell-materialization-policy.json \
  images/vfs/scripts/build-homebrew-materialized-vfs-image.ts \
  host/src/homebrew-bottle-mirror-plan.ts \
  host/src/homebrew-support-data-bottle.ts \
  host/src/homebrew-runtime-layer-consumer.ts \
  host/src/homebrew-vfs-composer.ts \
  host/src/homebrew-vfs-materialization-policy.ts \
  scripts/build-homebrew-main-shell-product.sh \
  scripts/prepare-homebrew-main-shell-inputs.sh \
  scripts/homebrew-main-shell-product-state.py \
  scripts/homebrew-main-shell-selection-lock.py \
  scripts/homebrew-prefix-campaign-executor.py \
  scripts/extract-homebrew-support-data-bottle.ts \
  scripts/verify-homebrew-support-data-extraction.ts \
  scripts/verify-homebrew-main-shell-artifact-lock.sh
do
  grep -Fq "\"$materialized_shell_input\"" "$SHELL_BUILD_TOML" ||
    fail "lazy shell build cache inputs omit $materialized_shell_input"
done
grep -Fq \
  'VFS_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts"' \
  "$BUILDER" || fail "canonical shell composition must select the eager image entrypoint"
grep -Fq \
  'VFS_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-materialized-vfs-image.ts"' \
  "$BUILDER" || fail "candidate shell composition must select its materialized entrypoint"
[ "$(grep -Fc '"$VFS_IMAGE_BUILDER"' "$BUILDER")" -eq 1 ] ||
  fail "shell composition must invoke exactly its selected image entrypoint"
grep -Fq 'homebrew-vfs-composer' "$EAGER_IMAGE_BUILDER" &&
  fail "canonical eager image entrypoint must not import the candidate composer"
grep -Fq 'from "../../../host/src/homebrew-vfs-composer"' \
  "$MATERIALIZED_IMAGE_BUILDER" ||
  fail "materialized image entrypoint must own the candidate composer import"
for generic_input in \
  WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_DIR \
  WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_COMMIT \
  WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR
do
  grep -Fq "$generic_input" "$SHELL_BUILDER" &&
    fail "shell builder must not consume transitional resolver input $generic_input"
done
grep -Fq 'KANDELO_HOMEBREW_MAIN_SHELL_TAP_' "$SHELL_BUILDER" &&
  fail "shell builder must not retain the workflow-only tap injection path"
grep -Fq 'scripts/prepare-homebrew-main-shell-inputs.sh' "$SHELL_BUILDER" &&
  grep -Fq 'scripts/build-homebrew-main-shell-product.sh' "$SHELL_BUILDER" ||
  fail "canonical package wrapper must use the shared product path"
grep -Fq 'build-shell-vfs-image.sh' "$SHELL_BUILDER" &&
  fail "shell builder must not retain the legacy registry-composition fallback"
for isolated_flag in \
  '--work-dir "$WORK_DIR"' \
  '--report "$REPORT"' \
  '--bottle-cache "$BOTTLE_CACHE"'
do
  grep -Fq -- "$isolated_flag" "$SHELL_BUILDER" ||
    fail "shell builder must pass isolated composer option $isolated_flag"
done
for product_flag in \
  '--package-tree-spec' \
  '--package-tree-archive "$BOOTSTRAP/homebrew-bootstrap.zip"' \
  '--homebrew-bootstrap-bottle-report "$BOOTSTRAP/report.json"'
do
  grep -Fq -- "$product_flag" "$PRODUCT_BUILDER" ||
    fail "product builder must pass canonical composer option $product_flag"
done
grep -Fq 'WORK_DIR="$REPO_ROOT/target/homebrew-main-shell"' "$BUILDER" &&
  fail "Homebrew composer must not use a shared repository target workspace"
grep -Fq 'homebrew-main-shell-node-smoke.ts' "$BUILDER" &&
  fail "cached shell composition must not consume ambient runtime acceptance artifacts"
grep -Fq 'scripts/homebrew-main-shell-node-smoke.ts' "$WORKFLOW" ||
  fail "exact candidate shell bytes must retain post-build Node acceptance"
jq -e '
  (keys | sort) == [
    "activation", "archive", "content_role", "id", "kind",
    "mount_prefix", "owner", "package", "schema"
  ] and
  .schema == 1 and
  .kind == "kandelo-package-deferred-zip-tree" and
  .id == "homebrew-bootstrap/source-tree" and
  .content_role == "source-tree" and
  .package == {
    name: "homebrew-bootstrap",
    output: "homebrew-bootstrap.zip"
  } and
  .archive == {
    url: "homebrew-bootstrap.zip",
    mode_policy: "portable-posix-v1"
  } and
  .mount_prefix == "/opt/kandelo/homebrew" and
  .owner == { uid: 1000, gid: 1000 } and
  .activation == {
    mode: "first-use",
    capabilities: ["homebrew:bootstrap", "homebrew:runtime"],
    roots: ["/opt/kandelo/homebrew/bin/brew"],
    atomic_group: "homebrew-runtime-support"
  }
' "$PACKAGE_TREE_SPEC" >/dev/null ||
  fail "Homebrew package-tree spec is not the exact reviewed contract"
grep -Fq 'depends_on = []' \
  "$SHELL_PACKAGE_TOML" ||
  fail "shell package must not retain the transitional bootstrap package dependency"
[ "$(grep -Fc '[[outputs]]' "$SHELL_PACKAGE_TOML")" -eq 1 ] ||
  fail "shell package must publish only its VFS image"
grep -Fq 'name = "homebrew-bootstrap"' "$HOMEBREW_BOOTSTRAP_PACKAGE_TOML" ||
  fail "standalone Homebrew source package is missing"
grep -Fq 'wasm = "homebrew-bootstrap.zip"' "$HOMEBREW_BOOTSTRAP_PACKAGE_TOML" ||
  fail "standalone Homebrew source package omits its exact ZIP output"
grep -Fq '"homebrew/main-shell-brew-package-tree.json"' "$SHELL_BUILD_TOML" ||
  fail "shell build identity omits the package-tree recipe"
grep -Fq '@binaries/programs/homebrew-bootstrap/' \
  "$LAZY_ARCHIVE_RESOLVER" &&
  fail "browser shell must not import bootstrap from the package registry"
grep -Fq \
  'const HOMEBREW_BOOTSTRAP_ARCHIVE = "homebrew-bootstrap.zip";' \
  "$LAZY_ARCHIVE_RESOLVER" &&
  grep -Fq \
    'return import.meta.env.BASE_URL + HOMEBREW_BOOTSTRAP_ARCHIVE;' \
    "$LAZY_ARCHIVE_RESOLVER" ||
  fail "browser shell does not bind the bottle-owned same-origin bootstrap"

shell_build_function="$TMP_ROOT/build-shell-vfs-function.sh"
sed -n '/^build_shell_vfs()/,/^}/p' "$RUN_SH" >"$shell_build_function"
grep -Fq 'resolve_args+=(resolve shell)' "$shell_build_function" ||
  fail "run.sh must resolve the shell package through the package system"
source_validate_function="$TMP_ROOT/validate-source-rootfs-shell-pages-function.sh"
source_initialize_function="$TMP_ROOT/initialize-source-rootfs-shell-pages-function.sh"
source_stage_function="$TMP_ROOT/stage-source-rootfs-shell-function.sh"
source_install_function="$TMP_ROOT/install-source-rootfs-shell-function.sh"
source_verify_function="$TMP_ROOT/verify-source-rootfs-shell-function.sh"
source_runtime_verify_function="$TMP_ROOT/verify-source-rootfs-shell-runtime-function.sh"
source_closure_function="$TMP_ROOT/verify-source-rootfs-shell-browser-closure-function.sh"
source_override_function="$TMP_ROOT/activate-source-rootfs-shell-resolver-override-function.sh"
source_release_function="$TMP_ROOT/release-source-rootfs-shell-resolver-override-function.sh"
source_cleanup_function="$TMP_ROOT/cleanup-source-rootfs-shell-work-root-function.sh"
source_exit_cleanup_function="$TMP_ROOT/source-rootfs-shell-exit-cleanup-function.sh"
source_clear_fetched_function="$TMP_ROOT/clear-source-rootfs-shell-transient-fetched-mirror-function.sh"
browser_fetch_function="$TMP_ROOT/fetch-browser-binaries-function.sh"
browser_bootstrap_function="$TMP_ROOT/prepare-browser-homebrew-bootstrap-function.sh"
prepare_browser_function="$TMP_ROOT/prepare-browser-function.sh"
browser_source_authority_function="$TMP_ROOT/validate-ci-browser-source-authority-function.sh"
ci_browser_state_function="$TMP_ROOT/validate-ci-homebrew-browser-state-function.sh"
ci_browser_prepare_function="$TMP_ROOT/prepare-ci-homebrew-browser-mirror-function.sh"
sed -n '/^validate_source_rootfs_shell_pages_mode()/,/^}/p' "$RUN_SH" \
  >"$source_validate_function"
sed -n '/^initialize_source_rootfs_shell_pages_mode()/,/^}/p' "$RUN_SH" \
  >"$source_initialize_function"
sed -n '/^stage_source_rootfs_shell_vfs()/,/^}/p' "$RUN_SH" \
  >"$source_stage_function"
sed -n '/^install_source_rootfs_shell_vfs()/,/^}/p' "$RUN_SH" \
  >"$source_install_function"
sed -n '/^verify_source_rootfs_shell_vfs()/,/^}/p' "$RUN_SH" \
  >"$source_verify_function"
sed -n '/^verify_source_rootfs_shell_runtime_vfs()/,/^}/p' "$RUN_SH" \
  >"$source_runtime_verify_function"
sed -n '/^verify_source_rootfs_shell_browser_closure()/,/^}/p' "$RUN_SH" \
  >"$source_closure_function"
sed -n '/^activate_source_rootfs_shell_resolver_override()/,/^}/p' "$RUN_SH" \
  >"$source_override_function"
sed -n '/^release_source_rootfs_shell_runtime_override()/,/^}/p' "$RUN_SH" \
  >"$source_release_function"
sed -n '/^cleanup_source_rootfs_shell_work_root()/,/^}/p' "$RUN_SH" \
  >"$source_cleanup_function"
sed -n '/^source_rootfs_shell_exit_cleanup()/,/^}/p' "$RUN_SH" \
  >"$source_exit_cleanup_function"
sed -n '/^clear_source_rootfs_shell_transient_fetched_mirror()/,/^}/p' "$RUN_SH" \
  >"$source_clear_fetched_function"
sed -n '/^fetch_browser_binaries()/,/^}/p' "$RUN_SH" \
  >"$browser_fetch_function"
sed -n '/^prepare_browser_homebrew_bootstrap()/,/^}/p' "$RUN_SH" \
  >"$browser_bootstrap_function"
sed -n '/^cmd_prepare_browser()/,/^}/p' "$RUN_SH" \
  >"$prepare_browser_function"
sed -n '/^validate_ci_browser_source_authority()/,/^}/p' "$RUN_SH" \
  >"$browser_source_authority_function"
sed -n '/^validate_ci_homebrew_browser_state()/,/^}/p' "$CI_TEST_RUNNER" \
  >"$ci_browser_state_function"
sed -n '/^prepare_ci_homebrew_browser_mirror()/,/^}/p' "$CI_TEST_RUNNER" \
  >"$ci_browser_prepare_function"
grep -Fq -- '--source-rootfs-shell)' "$RUN_SH" &&
grep -Fq \
    'export WASM_POSIX_SOURCE_ROOTFS_SHELL=$SOURCE_ROOTFS_SHELL' "$RUN_SH" ||
  fail "run.sh must expose one explicit source-rootfs browser preparation mode"
grep -Fq -- \
  '--source-rootfs-shell is internal to the GitHub Pages prepare-browser job.' \
  "$RUN_SH" ||
  fail "source-rootfs selection must be restricted to the Pages preparation command"
grep -Fq 'INTERNAL: Pages deploy job only.' "$RUN_SH" &&
  grep -Fq 'pages-exact-main-v1 attestation' "$RUN_SH" &&
  ! grep -Fq '  ./run.sh prepare-browser --source-rootfs-shell' "$RUN_SH" ||
  fail "ordinary help must identify source-rootfs mode as internal workflow plumbing"

for validation_contract in \
  'WASM_POSIX_SOURCE_ROOTFS_SHELL_ISOLATION:-}" = "pages-exact-main-v1"' \
  'GITHUB_ACTIONS:-}" = "true"' \
  'GITHUB_WORKFLOW:-}" = "Deploy GitHub Pages"' \
  'GITHUB_JOB:-}" = "deploy"' \
  'GITHUB_SERVER_URL:-}" = "https://github.com"' \
  'push|workflow_dispatch)' \
  'GITHUB_REF:-}" = "refs/heads/main"' \
  'GITHUB_REF_NAME:-}" = "main"' \
  'WASM_POSIX_SOURCE_ROOTFS_SHELL_RUNNER_ENVIRONMENT:-}" = "github-hosted"' \
  'RUNNER_OS:-}" = "Linux"' \
  'workspace_physical" = "$repo_physical"' \
  'source_repository" = "https://github.com/$github_repository"' \
  'source_commit" = "$GITHUB_SHA"' \
  'git -C "$REPO_ROOT" rev-parse HEAD' \
  'file:///*)' \
  'generator = "exact-main Pages source closure"' \
  'cache must be a nonexistent direct child of RUNNER_TEMP' \
  '"$REPO_ROOT/local-binaries"' \
  '"$REPO_ROOT/binaries"' \
  '"$REPO_ROOT/local-libs"' \
  '"$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"'
do
  grep -Fq "$validation_contract" "$source_validate_function" ||
    fail "source-rootfs Pages validation omits: $validation_contract"
done
grep -Fq '[ "$ALREADY_MATERIALIZED" -eq 0 ]' "$source_validate_function" &&
  grep -Fq '[ "${#FETCH_ONLY_ARGS[@]}" -eq 0 ]' "$source_validate_function" &&
  grep -Fq '[ "$USE_PR_STAGING" -eq 0 ]' "$source_validate_function" ||
  fail "source-rootfs Pages mode must reject incompatible materialization modes"

validation_probe="$TMP_ROOT/source-pages-validation"
validation_repo="$validation_probe/repo"
validation_runner_temp="$validation_probe/runner"
mkdir -p "$validation_repo/crates/shared/src" \
  "$validation_repo/apps/browser-demos/public" "$validation_runner_temp"
validation_runner_temp="$(cd "$validation_runner_temp" && pwd -P)"
printf 'pub const ABI_VERSION: u32 = 42;\n' \
  >"$validation_repo/crates/shared/src/lib.rs"
(
  cd "$validation_repo"
  git init -q
  git config user.email validation@example.invalid
  git config user.name Validation
  git add crates apps
  git commit -qm validation
)
validation_sha="$(git -C "$validation_repo" rev-parse HEAD)"
validation_index="$validation_runner_temp/empty-index.toml"
validation_cache="$validation_runner_temp/fresh-cache"
cat >"$validation_index" <<'EOF'
abi_version = 42
generated_at = "1970-01-01T00:00:00Z"
generator = "exact-main Pages source closure"
EOF
validation_runner="$validation_probe/validate.sh"
{
  printf 'set -euo pipefail\n'
  printf 'REPO_ROOT=%q\n' "$validation_repo"
  printf 'ALREADY_MATERIALIZED="${TEST_ALREADY_MATERIALIZED:-0}"\n'
  printf 'FETCH_ONLY_ARGS=()\n'
  printf '[ "${TEST_FETCH_ONLY:-0}" = 0 ] || FETCH_ONLY_ARGS=(--fetch-only)\n'
  printf 'USE_PR_STAGING="${TEST_PR_STAGING:-0}"\n'
  printf 'SOURCE_ROOTFS_SHELL_RUNNER_TEMP=""\n'
  printf 'SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED=0\n'
  printf 'err() { printf "%%s\\n" "$*" >&2; }\n'
  cat "$source_validate_function"
  printf 'validate_source_rootfs_shell_pages_mode\n'
} >"$validation_runner"
chmod +x "$validation_runner"
validation_env=(
  GITHUB_ACTIONS=true
  GITHUB_WORKFLOW="Deploy GitHub Pages"
  GITHUB_JOB=deploy
  GITHUB_SERVER_URL=https://github.com
  GITHUB_EVENT_NAME=push
  GITHUB_REF=refs/heads/main
  GITHUB_REF_NAME=main
  GITHUB_RUN_ID=123
  GITHUB_RUN_ATTEMPT=1
  GITHUB_WORKSPACE="$validation_repo"
  GITHUB_REPOSITORY=example/kandelo
  GITHUB_SHA="$validation_sha"
  RUNNER_OS=Linux
  RUNNER_TEMP="$validation_runner_temp"
  WASM_POSIX_SOURCE_ROOTFS_SHELL_ISOLATION=pages-exact-main-v1
  WASM_POSIX_SOURCE_ROOTFS_SHELL_RUNNER_ENVIRONMENT=github-hosted
  WASM_POSIX_SOURCE_ROOTFS_SHELL_REPOSITORY=https://github.com/example/kandelo
  WASM_POSIX_SOURCE_ROOTFS_SHELL_COMMIT="$validation_sha"
  WASM_POSIX_BINARY_INDEX_URL="file://$validation_index"
  WASM_POSIX_BINARY_CACHE_ROOT="$validation_cache"
)
env "${validation_env[@]}" bash "$validation_runner" ||
  fail "source-rootfs Pages validation rejected its exact isolated context"

expect_validation_rejected() {
  local expected="$1"
  shift
  expect_failure "$expected" env "${validation_env[@]}" "$@" \
    bash "$validation_runner"
}

expect_validation_rejected "Pages exact-main isolation contract" \
  WASM_POSIX_SOURCE_ROOTFS_SHELL_ISOLATION=
expect_validation_rejected "restricted to the Deploy GitHub Pages/deploy job" \
  GITHUB_ACTIONS=false
expect_validation_rejected "restricted to the Deploy GitHub Pages/deploy job" \
  GITHUB_WORKFLOW="Another workflow"
expect_validation_rejected "restricted to the Deploy GitHub Pages/deploy job" \
  GITHUB_JOB=test
expect_validation_rejected "supported github.com Pages event" \
  GITHUB_SERVER_URL=https://github.example.invalid
expect_validation_rejected "supported github.com Pages event" \
  GITHUB_EVENT_NAME=pull_request
expect_validation_rejected "exact main branch checkout" \
  GITHUB_REF=refs/heads/topic
expect_validation_rejected "real GitHub Actions run identity" \
  GITHUB_RUN_ID=not-a-run
expect_validation_rejected "attested GitHub-hosted Linux Pages runner" \
  WASM_POSIX_SOURCE_ROOTFS_SHELL_RUNNER_ENVIRONMENT=self-hosted
expect_validation_rejected "attested GitHub-hosted Linux Pages runner" \
  RUNNER_OS=macOS
expect_validation_rejected "GitHub Actions workspace root" \
  GITHUB_WORKSPACE="$validation_probe"
expect_validation_rejected "repository provenance must match" \
  GITHUB_REPOSITORY=other/kandelo
expect_validation_rejected "commit provenance must match" \
  WASM_POSIX_SOURCE_ROOTFS_SHELL_COMMIT=0000000000000000000000000000000000000000
expect_validation_rejected "workflow-created local empty index" \
  WASM_POSIX_BINARY_INDEX_URL=https://example.invalid/index.toml

wrong_abi_index="$validation_runner_temp/wrong-abi.toml"
cat >"$wrong_abi_index" <<'EOF'
abi_version = 41
generated_at = "1970-01-01T00:00:00Z"
generator = "exact-main Pages source closure"
EOF
expect_validation_rejected "exact empty current-ABI Pages index" \
  WASM_POSIX_BINARY_INDEX_URL="file://$wrong_abi_index"
nonempty_index="$validation_runner_temp/nonempty-index.toml"
cp "$validation_index" "$nonempty_index"
printf '\n[[packages]]\nname = "shell"\n' >>"$nonempty_index"
expect_validation_rejected "exact empty current-ABI Pages index" \
  WASM_POSIX_BINARY_INDEX_URL="file://$nonempty_index"
index_symlink="$validation_runner_temp/index-symlink.toml"
ln -s "$validation_index" "$index_symlink"
expect_validation_rejected "regular direct child of RUNNER_TEMP" \
  WASM_POSIX_BINARY_INDEX_URL="file://$index_symlink"

mkdir "$validation_cache"
expect_validation_rejected "cache must be a nonexistent direct child"
rmdir "$validation_cache"
cache_target="$validation_runner_temp/cache-target"
cache_symlink="$validation_runner_temp/cache-symlink"
mkdir "$cache_target"
ln -s "$cache_target" "$cache_symlink"
expect_validation_rejected "cache must be a nonexistent direct child" \
  WASM_POSIX_BINARY_CACHE_ROOT="$cache_symlink"
expect_validation_rejected "cannot combine with already-materialized" \
  TEST_ALREADY_MATERIALIZED=1
expect_validation_rejected "cannot combine with already-materialized" \
  TEST_FETCH_ONLY=1
expect_validation_rejected "cannot combine with already-materialized" \
  TEST_PR_STAGING=1
mkdir "$validation_repo/local-binaries"
expect_validation_rejected "requires an unmaterialized Pages workspace"
rmdir "$validation_repo/local-binaries"
[ ! -e "$validation_cache" ] && [ ! -L "$validation_cache" ] ||
  fail "rejected source-rootfs validation mutated the fresh cache path"

validation_call_line="$(grep -nF 'validate_source_rootfs_shell_pages_mode' \
  "$source_initialize_function" | cut -d: -f1)"
trap_line="$(grep -nF 'trap source_rootfs_shell_exit_cleanup EXIT' \
  "$source_initialize_function" | cut -d: -f1)"
work_mkdir_line="$(grep -nF 'mkdir "$SOURCE_ROOTFS_SHELL_WORK_ROOT"' \
  "$source_initialize_function" | cut -d: -f1)"
cache_mkdir_line="$(grep -nF 'mkdir "$WASM_POSIX_BINARY_CACHE_ROOT"' \
  "$source_initialize_function" | cut -d: -f1)"
[ "$validation_call_line" -lt "$trap_line" ] &&
  [ "$validation_call_line" -lt "$work_mkdir_line" ] &&
  [ "$validation_call_line" -lt "$cache_mkdir_line" ] ||
  fail "source-rootfs Pages validation must complete before any mutation"
grep -Fq '[ "$SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED" -eq 1 ]' \
  "$source_stage_function" ||
  fail "source-rootfs staging must require a completed Pages preflight"
initialize_line="$(grep -nF 'initialize_source_rootfs_shell_pages_mode' \
  "$source_install_function" | cut -d: -f1)"
stage_line="$(grep -nF 'stage_source_rootfs_shell_vfs' \
  "$source_install_function" | cut -d: -f1)"
install_xtask_line="$(grep -nF 'xtask="$(pkg_xtask_bin)"' \
  "$source_install_function" | cut -d: -f1)"
[ "$initialize_line" -lt "$stage_line" ] &&
  [ "$stage_line" -lt "$install_xtask_line" ] ||
  fail "source-rootfs install must preflight and inspect staging before canonical helpers"

grep -Fq -- \
  '--package "$REPO_ROOT/homebrew/source-rootfs-shell-package"' \
  "$source_stage_function" &&
  grep -Fq -- '--force-source-closure' "$source_stage_function" &&
  grep -Fq -- '--binaries-dir "$SOURCE_ROOTFS_SHELL_STAGE_BINARIES"' \
    "$source_stage_function" &&
  ! grep -Fq -- '--binaries-dir "$REPO_ROOT/local-binaries"' \
    "$source_stage_function" ||
  fail "source-rootfs mode must force-stage the distinct bridge recipe"
grep -Fq '[ "${package_names[0]}" = "source-rootfs-shell" ]' \
  "$source_stage_function" &&
  grep -Fq '[ "${repositories[0]}" = "$source_repository" ]' \
    "$source_stage_function" &&
  grep -Fq '[ "${commits[0]}" = "$source_commit" ]' \
    "$source_stage_function" &&
  grep -Fq 'grep -Fq "UNPUBLISHED" "$manifest"' \
    "$source_stage_function" ||
  fail "source-rootfs mode must inspect exact staged recipe and source provenance"
grep -Fq 'archive-extract-member \' "$source_stage_function" &&
  grep -Fq -- '--member manifest.toml \' "$source_stage_function" &&
  grep -Fq -- '--member artifacts/shell.vfs.zst \' \
    "$source_stage_function" ||
  fail "source-rootfs mode must use the bounded extractor for manifest and artifact"
grep -Fq 'WASM_POSIX_LOCAL_INSTALL_SOURCE="$SOURCE_ROOTFS_SHELL_CANDIDATE"' \
  "$source_install_function" &&
  grep -Fq 'install-local-artifact shell shell.vfs.zst' \
    "$source_install_function" &&
  grep -Fq 'cp -- "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP"' \
    "$source_install_function" &&
  grep -Fq 'cmp "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP"' \
    "$source_install_function" &&
  grep -Fq 'mv -- "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" "$browser_copy"' \
    "$source_install_function" ||
  fail "source-rootfs mode must install canonical bytes and atomically publish the verified public copy"
grep -Fq 'activate_source_rootfs_shell_resolver_override' \
  "$source_install_function" &&
  grep -Fq 'local shell_dir="$local_libs/shell"' "$source_override_function" &&
  grep -Fq 'local override_path="$shell_dir/build"' \
    "$source_override_function" &&
  grep -Fq \
    'resolved="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/shell.vfs.zst)"' \
    "$source_override_function" &&
  grep -Fq '[ -L "$resolved" ]' "$source_override_function" &&
  grep -Fq 'override_target="$(dirname "$resolved")"' \
    "$source_override_function" &&
  grep -Fq 'ln -s "$override_target" "$override_path"' \
    "$source_override_function" ||
  fail "source-rootfs mode must block transitive canonical shell builds through the supported resolver override"

source_override_probe="$TMP_ROOT/source-override-probe"
source_override_generation="$source_override_probe/local-binaries/.kandelo-local-generations/wasm32/shell/exact/session"
source_override_mirror="$source_override_probe/local-binaries/programs/wasm32/shell.vfs.zst"
source_override_candidate="$source_override_probe/candidate.vfs.zst"
mkdir -p "$source_override_probe/scripts" "$source_override_generation" \
  "$(dirname "$source_override_mirror")"
printf 'exact-source-shell\n' \
  >"$source_override_generation/shell.vfs.zst"
printf 'exact-source-shell\n' >"$source_override_candidate"
ln -s "$source_override_generation/shell.vfs.zst" "$source_override_mirror"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\n' \
  "$source_override_generation/shell.vfs.zst" \
  >"$source_override_probe/scripts/resolve-binary.sh"
chmod +x "$source_override_probe/scripts/resolve-binary.sh"
source_override_runner="$source_override_probe/run.sh"
{
  printf 'set -euo pipefail\n'
  printf 'REPO_ROOT=%q\n' "$source_override_probe"
  printf 'SOURCE_ROOTFS_SHELL_CANDIDATE=%q\n' "$source_override_candidate"
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_PATH=""\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET=""\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_SHELL_DIR_CREATED=0\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_LOCAL_LIBS_CREATED=0\n'
  printf 'SOURCE_ROOTFS_SHELL_FETCHED_MIRROR=""\n'
  printf 'SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET=""\n'
  printf 'err() { printf "%%s\\n" "$*" >&2; }\n'
  printf 'pkg_output_rel() { printf "shell.vfs.zst\\n"; }\n'
  sed -n '/^activate_source_rootfs_shell_resolver_override()/,/^}/p' "$RUN_SH"
  printf 'activate_source_rootfs_shell_resolver_override\n'
  printf '[ -L "$REPO_ROOT/local-binaries/programs/wasm32/shell.vfs.zst" ]\n'
  printf '[ "$(readlink "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH")" = %q ]\n' \
    "$source_override_generation"
  printf '[ "$SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET" = %q ]\n' \
    "$source_override_generation/shell.vfs.zst"
} >"$source_override_runner"
bash "$source_override_runner" ||
  fail "source-rootfs resolver override rejected a valid scalar mirror generation"

source_reject_probe="$TMP_ROOT/source-rejected-override-probe"
source_reject_generation="$source_reject_probe/local-binaries/.kandelo-local-generations/wasm32/shell/exact/session"
source_reject_candidate="$source_reject_probe/candidate.vfs.zst"
mkdir -p "$source_reject_probe/scripts" "$source_reject_generation" \
  "$source_reject_probe/local-libs"
printf 'exact-source-shell\n' \
  >"$source_reject_generation/shell.vfs.zst"
printf 'exact-source-shell\n' >"$source_reject_candidate"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\n' \
  "$source_reject_generation/shell.vfs.zst" \
  >"$source_reject_probe/scripts/resolve-binary.sh"
chmod +x "$source_reject_probe/scripts/resolve-binary.sh"
source_reject_runner="$source_reject_probe/run.sh"
{
  printf 'set -euo pipefail\n'
  printf 'REPO_ROOT=%q\n' "$source_reject_probe"
  printf 'SOURCE_ROOTFS_SHELL_CANDIDATE=%q\n' "$source_reject_candidate"
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_PATH=""\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET=""\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_SHELL_DIR_CREATED=0\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_LOCAL_LIBS_CREATED=0\n'
  printf 'SOURCE_ROOTFS_SHELL_FETCHED_MIRROR=""\n'
  printf 'SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET=""\n'
  printf 'err() { printf "%%s\\n" "$*" >&2; }\n'
  printf 'pkg_output_rel() { printf "shell.vfs.zst\\n"; }\n'
  sed -n '/^activate_source_rootfs_shell_resolver_override()/,/^}/p' "$RUN_SH"
  printf 'if activate_source_rootfs_shell_resolver_override; then exit 1; fi\n'
  printf '[ -d %q ]\n' "$source_reject_probe/local-libs"
  printf '[ -z "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH" ]\n'
  printf '[ -z "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR" ]\n'
} >"$source_reject_runner"
bash "$source_reject_runner" ||
  fail "rejected source-rootfs activation claimed a preexisting override or fetched link"

override_create_line="$(grep -nF 'ln -s "$override_target" "$override_path"' \
  "$source_override_function" | cut -d: -f1)"
override_ownership_line="$(grep -nF \
  'SOURCE_ROOTFS_SHELL_OVERRIDE_PATH="$override_path"' \
  "$source_override_function" | cut -d: -f1)"
fetched_ownership_line="$(grep -nF \
  'SOURCE_ROOTFS_SHELL_FETCHED_MIRROR="$fetched_mirror"' \
  "$source_override_function" | cut -d: -f1)"
override_mkdir_line="$(grep -nF 'mkdir "$local_libs"' \
  "$source_override_function" | cut -d: -f1)"
[ "$override_ownership_line" -lt "$override_mkdir_line" ] &&
  [ "$fetched_ownership_line" -lt "$override_mkdir_line" ] &&
  [ "$override_ownership_line" -lt "$override_create_line" ] &&
  [ "$fetched_ownership_line" -lt "$override_create_line" ] ||
  fail "source-rootfs cleanup ownership must precede every override mutation"

grep -Fq 'local install_session="source-rootfs-shell-' \
  "$source_install_function" &&
  grep -Fq '${work_suffix}-${BASHPID:-$$}' "$source_install_function" ||
  fail "source-rootfs reactivation must use a fresh portable local-install session"
grep -Fq 'cmp "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$resolved"' \
  "$source_verify_function" &&
  grep -Fq 'cmp "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$browser_copy"' \
    "$source_verify_function" ||
  fail "source-rootfs mode must compare both canonical browser paths with its staged bytes"
grep -Fq 'verify_source_rootfs_shell_vfs' "$source_runtime_verify_function" &&
  grep -Fq '[ ! -L "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH" ]' \
    "$source_runtime_verify_function" ||
  fail "source-rootfs runtime verification must bind the temporary override"
! grep -Fq 'homebrew-bootstrap' "$source_closure_function" ||
  fail "source-rootfs shell verification must not restore registry bootstrap ownership"
grep -Fq \
  '[ "$(readlink "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR")" = "$SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET" ]' \
  "$source_clear_fetched_function" &&
  grep -Fq 'rm -- "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR"' \
    "$source_clear_fetched_function" &&
  ! grep -Fq -- '--binaries-dir "$REPO_ROOT/binaries"' \
    "$source_install_function" "$source_override_function" \
    "$source_clear_fetched_function" ||
  fail "source-rootfs mode must remove its transient fetched-tier link rather than install an invalid local generation there"

source_clear_probe="$TMP_ROOT/source-clear-fetched-probe"
mkdir -p "$source_clear_probe/binaries/programs/wasm32" \
  "$source_clear_probe/local-libs/shell/build" "$source_clear_probe/unrelated"
source_clear_mirror="$source_clear_probe/binaries/programs/wasm32/shell.vfs.zst"
source_clear_transient="$source_clear_probe/local-libs/shell/build/shell.vfs.zst"
source_clear_canonical="$source_clear_probe/local-binaries/generation/shell.vfs.zst"
source_clear_unrelated="$source_clear_probe/unrelated/shell.vfs.zst"
printf 'source\n' >"$source_clear_transient"
mkdir -p "$(dirname "$source_clear_canonical")"
printf 'source\n' >"$source_clear_canonical"
printf 'bottle\n' >"$source_clear_unrelated"
# Match the resolver's ScalarMirrorPlan: it resolves the local-libs override
# and records the immutable generation path as the fetched-tier link target.
ln -s "$source_clear_canonical" "$source_clear_mirror"
source_clear_runner="$source_clear_probe/run.sh"
{
  printf 'set -euo pipefail\n'
  printf 'SOURCE_ROOTFS_SHELL_FETCHED_MIRROR=%q\n' "$source_clear_mirror"
  printf 'SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET=%q\n' \
    "$source_clear_canonical"
  printf 'SOURCE_CLEAR_UNRELATED=%q\n' "$source_clear_unrelated"
  printf 'err() { printf "%%s\\n" "$*" >&2; }\n'
  sed -n '/^clear_source_rootfs_shell_transient_fetched_mirror()/,/^}/p' \
    "$RUN_SH"
  printf 'clear_source_rootfs_shell_transient_fetched_mirror\n'
  printf '[ ! -e "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR" ] && '
  printf '[ ! -L "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR" ]\n'
  printf 'ln -s "$SOURCE_CLEAR_UNRELATED" "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR"\n'
  printf 'set +e\n'
  printf 'clear_source_rootfs_shell_transient_fetched_mirror\n'
  printf 'clear_status=$?\n'
  printf 'set -e\n'
  printf '[ "$clear_status" -ne 0 ]\n'
  printf '[ -L "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR" ] && '
  printf '[ "$(readlink "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR")" = "$SOURCE_CLEAR_UNRELATED" ]\n'
} >"$source_clear_runner"
bash "$source_clear_runner" ||
  fail "source-rootfs transient cleanup did not reject a changed fetched-tier link"

grep -Fq 'disabled_pkgs="$disabled_pkgs shell"' "$browser_fetch_function" ||
  fail "source-rootfs browser fetching must skip direct canonical shell resolution"
! grep -Fq 'SOURCE_ROOTFS_SHELL_MARKER' "$RUN_SH" &&
  ! grep -Fq 'deactivate_source_rootfs_shell_if_present' "$RUN_SH" ||
  fail "the internal Pages lane must not create an ordinary cross-invocation activation protocol"
grep -Fq 'trap source_rootfs_shell_exit_cleanup EXIT' \
  "$source_initialize_function" &&
  grep -Fq "trap 'exit 130' INT" "$source_initialize_function" &&
  grep -Fq "trap 'exit 143' TERM" "$source_initialize_function" ||
  fail "source-rootfs initialization must clean runtime state without swallowing cancellation signals"
grep -Fq 'local original_status=$?' "$source_exit_cleanup_function" &&
  grep -Fq 'trap - EXIT INT TERM' "$source_exit_cleanup_function" &&
  grep -Fq 'exit "$original_status"' "$source_exit_cleanup_function" ||
  fail "source-rootfs EXIT cleanup must preserve the triggering failure status"

interruption_harness="$TMP_ROOT/source-rootfs-interruption.sh"
{
  printf 'set -euo pipefail\n'
  printf 'REPO_ROOT="$1"\n'
  printf 'phase="$2"\n'
  printf 'termination="${3:-term}"\n'
  printf 'mkdir -p "$REPO_ROOT/apps/browser-demos/public"\n'
  printf 'SOURCE_ROOTFS_SHELL_RUNNER_TEMP="$REPO_ROOT/runner"\n'
  printf 'SOURCE_ROOTFS_SHELL_WORK_PREFIX="$REPO_ROOT/runner/kandelo-source-rootfs-shell."\n'
  printf 'SOURCE_ROOTFS_SHELL_WORK_ROOT="${SOURCE_ROOTFS_SHELL_WORK_PREFIX}123.1.$$"\n'
  printf 'SOURCE_ROOTFS_SHELL_STAGE_BINARIES="$SOURCE_ROOTFS_SHELL_WORK_ROOT/binaries"\n'
  printf 'SOURCE_ROOTFS_SHELL_CANDIDATE="$SOURCE_ROOTFS_SHELL_WORK_ROOT/shell.vfs.zst"\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_PATH=""\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET=""\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_SHELL_DIR_CREATED=0\n'
  printf 'SOURCE_ROOTFS_SHELL_OVERRIDE_LOCAL_LIBS_CREATED=0\n'
  printf 'SOURCE_ROOTFS_SHELL_FETCHED_MIRROR=""\n'
  printf 'SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET=""\n'
  printf 'SOURCE_ROOTFS_SHELL_PUBLIC_TEMP=""\n'
  printf 'SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED=1\n'
  printf 'err() { printf "%%s\\n" "$*" >&2; }\n'
  cat "$source_clear_fetched_function"
  cat "$source_release_function"
  cat "$source_cleanup_function"
  cat "$source_exit_cleanup_function"
  printf 'trap source_rootfs_shell_exit_cleanup EXIT\n'
  printf "trap 'exit 130' INT\n"
  printf "trap 'exit 143' TERM\n"
  printf 'mkdir -p "$SOURCE_ROOTFS_SHELL_STAGE_BINARIES"\n'
  printf 'if [ "$phase" -ge 2 ]; then\n'
  printf '  printf candidate >"$SOURCE_ROOTFS_SHELL_CANDIDATE"\n'
  printf 'fi\n'
  printf 'if [ "$phase" -ge 3 ]; then\n'
  printf '  mkdir -p "$REPO_ROOT/local-binaries/generation"\n'
  printf '  printf canonical >"$REPO_ROOT/local-binaries/generation/shell.vfs.zst"\n'
  printf 'fi\n'
  printf 'if [ "$phase" -ge 4 ]; then\n'
  printf '  SOURCE_ROOTFS_SHELL_OVERRIDE_PATH="$REPO_ROOT/local-libs/shell/build"\n'
  printf '  SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET="$REPO_ROOT/local-binaries/generation"\n'
  printf '  SOURCE_ROOTFS_SHELL_OVERRIDE_LOCAL_LIBS_CREATED=1\n'
  printf '  SOURCE_ROOTFS_SHELL_OVERRIDE_SHELL_DIR_CREATED=1\n'
  printf '  SOURCE_ROOTFS_SHELL_FETCHED_MIRROR="$REPO_ROOT/binaries/programs/wasm32/shell.vfs.zst"\n'
  printf '  SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET="$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH/shell.vfs.zst"\n'
  printf '  mkdir -p "$(dirname "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH")"\n'
  printf '  ln -s "$SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET" "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH"\n'
  printf 'fi\n'
  printf 'if [ "$phase" -eq 5 ]; then\n'
  printf '  SOURCE_ROOTFS_SHELL_PUBLIC_TEMP="$REPO_ROOT/apps/browser-demos/public/.shell.vfs.zst.source-rootfs-test"\n'
  printf '  printf temporary >"$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP"\n'
  printf 'fi\n'
  printf 'if [ "$phase" -ge 6 ]; then\n'
  printf '  printf published >"$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"\n'
  printf 'fi\n'
  printf 'if [ "$phase" -ge 7 ]; then\n'
  printf '  mkdir -p "$(dirname "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR")"\n'
  printf '  ln -s "$SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET" "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR"\n'
  printf 'fi\n'
  printf 'if [ "$termination" = fail ]; then\n'
  printf '  exit 37\n'
  printf 'fi\n'
  printf 'kill -TERM "$BASHPID"\n'
  printf 'touch "$REPO_ROOT/deployment-continued"\n'
} >"$interruption_harness"
chmod +x "$interruption_harness"

# Phase boundaries: isolated workspace, staged candidate, canonical install,
# resolver override, public temporary copy, atomic public rename, and final
# fetch/build verification with a transient fetched-tier link.
for interruption_phase in 1 2 3 4 5 6 7; do
  interruption_root="$TMP_ROOT/interruption-$interruption_phase"
  mkdir -p "$interruption_root/runner"
  set +e
  bash "$interruption_harness" "$interruption_root" "$interruption_phase"
  interruption_status=$?
  set -e
  [ "$interruption_status" -eq 143 ] ||
    fail "source-rootfs interruption phase $interruption_phase did not preserve TERM status"
  [ ! -e "$interruption_root/deployment-continued" ] ||
    fail "source-rootfs interruption phase $interruption_phase advanced to deployment"
  [ ! -e "$interruption_root/local-libs" ] &&
    [ ! -L "$interruption_root/local-libs" ] ||
    fail "source-rootfs interruption phase $interruption_phase retained a runtime override"
  [ -z "$(find "$interruption_root/runner" -mindepth 1 -maxdepth 1 -print -quit)" ] ||
    fail "source-rootfs interruption phase $interruption_phase retained its staging directory"
  [ ! -e "$interruption_root/apps/browser-demos/public/.shell.vfs.zst.source-rootfs-test" ] ||
    fail "source-rootfs interruption phase $interruption_phase retained its public temporary file"
  [ ! -L "$interruption_root/binaries/programs/wasm32/shell.vfs.zst" ] ||
    fail "source-rootfs interruption phase $interruption_phase retained its transient fetched link"
  if [ "$interruption_phase" -ge 3 ]; then
    [ -f "$interruption_root/local-binaries/generation/shell.vfs.zst" ] ||
      fail "interruption cleanup must not reinterpret canonical package state"
  fi
  if [ "$interruption_phase" -ge 6 ]; then
    [ -f "$interruption_root/apps/browser-demos/public/shell.vfs.zst" ] ||
      fail "interruption cleanup must not reinterpret an atomically published Pages artifact"
  fi
done

failure_root="$TMP_ROOT/interruption-nonzero"
mkdir -p "$failure_root/runner"
set +e
bash "$interruption_harness" "$failure_root" 4 fail
failure_status=$?
set -e
[ "$failure_status" -eq 37 ] ||
  fail "source-rootfs EXIT cleanup replaced the original failure status"
[ ! -e "$failure_root/deployment-continued" ] &&
  [ ! -e "$failure_root/local-libs" ] &&
  [ -f "$failure_root/local-binaries/generation/shell.vfs.zst" ] ||
  fail "source-rootfs nonzero failure cleanup crossed its ownership boundary"

source_branch_line="$(grep -nF 'if [ "$SOURCE_ROOTFS_SHELL" -eq 1 ]; then' \
  "$shell_build_function" | head -n 1 | cut -d: -f1)"
source_verify_line="$(grep -nF 'verify_source_rootfs_shell_runtime_browser_closure' \
  "$shell_build_function" | head -n 1 | cut -d: -f1)"
source_return_line="$(awk -v start="$source_verify_line" \
  'NR > start && /^        return$/ { print NR; exit }' "$shell_build_function")"
canonical_resolve_line="$(grep -nF 'resolve_args+=(resolve shell)' \
  "$shell_build_function" | cut -d: -f1)"
[ "$source_branch_line" -lt "$source_verify_line" ] &&
  [ "$source_verify_line" -lt "$source_return_line" ] &&
  [ "$source_return_line" -lt "$canonical_resolve_line" ] ||
  fail "source and canonical shell activations must remain mutually exclusive"

source_install_line="$(grep -nF 'install_source_rootfs_shell_vfs' \
  "$prepare_browser_function" | cut -d: -f1)"
browser_fetch_line="$(grep -nF 'fetch_browser_binaries' \
  "$prepare_browser_function" | cut -d: -f1)"
browser_build_line="$(grep -nF '    build_browser' \
  "$prepare_browser_function" | cut -d: -f1)"
final_source_runtime_verify_line="$(grep -nF 'verify_source_rootfs_shell_runtime_browser_closure' \
  "$prepare_browser_function" | tail -n 1 | cut -d: -f1)"
final_source_release_line="$(grep -nF 'release_source_rootfs_shell_runtime_override' \
  "$prepare_browser_function" | tail -n 1 | cut -d: -f1)"
final_source_verify_line="$(grep -nF 'verify_source_rootfs_shell_browser_closure' \
  "$prepare_browser_function" | tail -n 1 | cut -d: -f1)"
browser_bootstrap_line="$(grep -nF 'prepare_browser_homebrew_bootstrap' \
  "$prepare_browser_function" | cut -d: -f1)"
[ "$source_install_line" -lt "$browser_fetch_line" ] &&
  [ "$source_install_line" -lt "$browser_bootstrap_line" ] &&
  [ "$browser_bootstrap_line" -lt "$browser_fetch_line" ] &&
  [ "$browser_fetch_line" -lt "$browser_build_line" ] &&
  [ "$browser_build_line" -lt "$final_source_runtime_verify_line" ] &&
  [ "$final_source_runtime_verify_line" -lt "$final_source_release_line" ] &&
  [ "$final_source_release_line" -lt "$final_source_verify_line" ] &&
  [ "$browser_build_line" -lt "$final_source_verify_line" ] ||
  fail "browser prep must admit Homebrew early, then release and reverify runtime activation"
grep -Fq 'need_shell_vfs_build_tools' "$RUN_SH" &&
  fail "run.sh must not duplicate prerequisites owned by the shell recipe"
grep -Fq 'if [ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ]; then' \
  "$shell_build_function" ||
  fail "run.sh must preserve an explicit fetch-only resolve"
grep -Fq 'resolve_args+=("${FETCH_ONLY_ARGS[@]}")' \
  "$shell_build_function" ||
  fail "run.sh must forward the caller's fetch-only contract to the shell resolver"
fetch_condition_line="$(grep -nF 'if [ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ]; then' \
  "$shell_build_function" | cut -d: -f1)"
fetch_forward_line="$(grep -nF 'resolve_args+=("${FETCH_ONLY_ARGS[@]}")' \
  "$shell_build_function" | cut -d: -f1)"
fetch_fi_line="$(awk -v start="$fetch_forward_line" \
  'NR > start && /^    fi$/ { print NR; exit }' "$shell_build_function")"
[ "$fetch_condition_line" -lt "$fetch_forward_line" ] &&
  [ "$fetch_forward_line" -lt "$fetch_fi_line" ] ||
  fail "run.sh must limit fetch-only forwarding to the explicit branch"
grep -Fq 'npm ci' "$shell_build_function" &&
  fail "run.sh must not predict whether the package resolver will source-build shell"
grep -Fq -- '--binaries-dir "$REPO_ROOT/local-binaries"' "$RUN_SH" ||
  fail "run.sh must materialize the resolved shell package for local consumers"
grep -Fq 'pkg_has_output shell shell.vfs.zst' "$RUN_SH" ||
  fail "run.sh must validate the shell package's declared output"
has_shell_vfs_function="$TMP_ROOT/has-shell-vfs-function.sh"
sed -n '/^has_shell_vfs()/,/^}/p' "$RUN_SH" >"$has_shell_vfs_function"
! grep -Fq 'homebrew-bootstrap' "$has_shell_vfs_function" ||
  fail "shell image availability must not depend on the retired bootstrap package"
! grep -Fq 'homebrew-bootstrap' "$shell_build_function" ||
  fail "shell image resolution must not require the retired bootstrap package"
grep -Fq 'homebrew-bootstrap' "$browser_fetch_function" &&
  fail "browser package fetching must skip the retired bootstrap package"
grep -Fq \
  'BROWSER_FETCH_SKIP_PKGS=(spidermonkey node homebrew-bootstrap)' \
  "$RUN_SH" ||
  fail "browser package selection must exclude the retired bootstrap package"
grep -Fq 'scripts/prepare-homebrew-browser-bootstrap.sh' \
  "$browser_bootstrap_function" &&
  grep -Fq \
    'apps/browser-demos/public/homebrew-bootstrap.zip' \
    "$browser_bootstrap_function" &&
  grep -Fq -- '--require-sealed' "$browser_bootstrap_function" ||
  fail "browser preparation must stage the selected Formula bottle asset"

for source_authority_contract in \
  'source-rootfs-mirror-state-v1' \
  '[ "$ALREADY_MATERIALIZED" -ne 1 ]' \
  '[ "${#FETCH_ONLY_ARGS[@]}" -eq 0 ]' \
  '[ "$REQUIRE_SEALED_HOMEBREW_SELECTION" -ne 0 ]'
do
  grep -Fq "$source_authority_contract" \
    "$browser_source_authority_function" ||
    fail "internal source-shell authority omits: $source_authority_contract"
done
grep -Fq 'if [ -n "$CI_BROWSER_SOURCE_AUTHORITY" ]; then' \
  "$browser_bootstrap_function" ||
  fail "browser bootstrap does not recognize validated source-shell authority"
grep -Fq 'WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY' \
  "$ci_browser_state_function" ||
  fail "CI source-shell validation does not reject ambient authority"
if grep -Fq 'export KANDELO_PLAYWRIGHT_' "$ci_browser_state_function"; then
  fail "initial CI state validation must not grant Playwright authority"
fi

ci_materialize_line="$(grep -nF \
  'bash scripts/materialize-ci-publication-blockers.sh' \
  "$CI_TEST_RUNNER" | tail -n 1 | cut -d: -f1)"
ci_initial_state_line="$(grep -nF 'validate_ci_homebrew_browser_state' \
  "$CI_TEST_RUNNER" | tail -n 1 | cut -d: -f1)"
ci_source_authority_line="$(grep -nF \
  'WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY="$CI_HOMEBREW_BROWSER_SOURCE_AUTHORITY"' \
  "$CI_TEST_RUNNER" | tail -n 1 | cut -d: -f1)"
ci_browser_run_line="$(grep -nF \
  './run.sh --already-materialized --fetch-only prepare-browser' \
  "$CI_TEST_RUNNER" | tail -n 1 | cut -d: -f1)"
ci_product_build_line="$(grep -nF 'run_pages_shaped_browser_build' \
  "$CI_TEST_RUNNER" | tail -n 1 | cut -d: -f1)"
ci_mirror_line="$(grep -nF 'prepare_ci_homebrew_browser_mirror' \
  "$CI_TEST_RUNNER" | tail -n 1 | cut -d: -f1)"
[ "$ci_materialize_line" -lt "$ci_initial_state_line" ] &&
  [ "$ci_initial_state_line" -lt "$ci_source_authority_line" ] &&
  [ "$ci_source_authority_line" -lt "$ci_browser_run_line" ] &&
  [ "$ci_browser_run_line" -lt "$ci_product_build_line" ] &&
  [ "$ci_product_build_line" -lt "$ci_mirror_line" ] ||
  fail "CI must authenticate source state before run.sh and recover the mirror after the product build"

[ "$(grep -Ec '^[[:space:]]+validate_ci_homebrew_browser_state$' \
  "$CI_TEST_RUNNER")" -eq 2 ] ||
  fail "CI must validate browser state exactly before and after browser preparation"
ci_prepare_state_line="$(grep -nF 'validate_ci_homebrew_browser_state' \
  "$ci_browser_prepare_function" | cut -d: -f1)"
ci_prepare_source_line="$(grep -nF \
  'export KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL=1' \
  "$ci_browser_prepare_function" | cut -d: -f1)"
ci_prepare_recovery_line="$(grep -nF \
  'npx tsx scripts/recover-homebrew-bottle-mirror.ts' \
  "$ci_browser_prepare_function" | cut -d: -f1)"
[ "$ci_prepare_state_line" -lt "$ci_prepare_source_line" ] &&
  [ "$ci_prepare_state_line" -lt "$ci_prepare_recovery_line" ] ||
  fail "CI must revalidate browser state before granting final browser authority"

ci_prepare_probe_root="$TMP_ROOT/ci-browser-prepare-revalidation"
ci_prepare_probe="$ci_prepare_probe_root/probe.sh"
ci_prepare_probe_log="$ci_prepare_probe_root/revalidated"
mkdir -p "$ci_prepare_probe_root/apps/browser-demos/public"
{
  printf 'set -euo pipefail\n'
  printf 'REPO_ROOT=%q\n' "$ci_prepare_probe_root"
  printf 'CI_HOMEBREW_BROWSER_STATE_VALIDATED=1\n'
  printf 'CI_HOMEBREW_BROWSER_STATE_MODE=unvalidated\n'
  printf 'CI_HOMEBREW_BROWSER_MIRROR_REQUIRED=""\n'
  printf 'CI_HOMEBREW_BROWSER_IMAGE=""\n'
  printf 'CI_HOMEBREW_BROWSER_REPORT_ROOT=""\n'
  printf 'CI_HOMEBREW_BROWSER_MIRROR=""\n'
  printf 'validate_ci_homebrew_browser_state() {\n'
  printf '  printf revalidated >%q\n' "$ci_prepare_probe_log"
  printf '  if [ "${TEST_REVALIDATE_FAIL:-0}" = 1 ]; then\n'
  printf '    echo "browser state changed before final authority" >&2\n'
  printf '    return 73\n'
  printf '  fi\n'
  printf '  CI_HOMEBREW_BROWSER_STATE_MODE=publication-blocked\n'
  printf '}\n'
  cat "$ci_browser_prepare_function"
  printf 'prepare_ci_homebrew_browser_mirror\n'
  printf 'printf "authority=%%s\\n" "${KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL:-}"\n'
} >"$ci_prepare_probe"
[ "$(bash "$ci_prepare_probe")" = 'authority=1' ] &&
  [ -f "$ci_prepare_probe_log" ] ||
  fail "CI browser preparation did not revalidate before source authority"
rm -f "$ci_prepare_probe_log"
expect_failure "browser state changed before final authority" \
  env TEST_REVALIDATE_FAIL=1 bash "$ci_prepare_probe"
[ -f "$ci_prepare_probe_log" ] ||
  fail "CI browser preparation did not run its final state validation"

ci_state_probe="$TMP_ROOT/ci-browser-state-authority.sh"
{
  printf 'set -euo pipefail\n'
  printf 'REPO_ROOT=%q\n' "$REPO_ROOT"
  printf 'CI_HOMEBREW_BROWSER_IMAGE=""\n'
  printf 'CI_HOMEBREW_BROWSER_MIRROR_REQUIRED=""\n'
  printf 'CI_HOMEBREW_BROWSER_SOURCE_AUTHORITY=""\n'
  printf 'CI_HOMEBREW_BROWSER_STATE_MODE=""\n'
  printf 'CI_HOMEBREW_BROWSER_STATE_VALIDATED=0\n'
  cat "$ci_browser_state_function"
  printf 'validate_ci_homebrew_browser_state\n'
} >"$ci_state_probe"
expect_failure \
  'ambient closed Homebrew browser authority is forbidden: WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY' \
  env WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY=source-rootfs-mirror-state-v1 \
    bash "$ci_state_probe"

source_authority_probe="$TMP_ROOT/browser-source-authority.sh"
{
  printf 'set -euo pipefail\n'
  printf 'err() { printf "%%s\\n" "$*" >&2; }\n'
  printf 'CI_BROWSER_SOURCE_AUTHORITY="${TEST_AUTHORITY:-}"\n'
  printf 'ALREADY_MATERIALIZED="${TEST_ALREADY_MATERIALIZED:-1}"\n'
  printf 'FETCH_ONLY_ARGS=()\n'
  printf '[ "${TEST_FETCH_ONLY:-1}" = 0 ] || FETCH_ONLY_ARGS=(--fetch-only)\n'
  printf 'SOURCE_ROOTFS_SHELL="${TEST_SOURCE_ROOTFS:-0}"\n'
  printf 'REQUIRE_SEALED_HOMEBREW_SELECTION="${TEST_REQUIRE_SEALED:-0}"\n'
  printf 'USE_PR_STAGING="${TEST_PR_STAGING:-0}"\n'
  printf 'COMMAND_ARGS=(prepare-browser)\n'
  printf 'case "${TEST_COMMAND_SHAPE:-exact}" in\n'
  printf '  wrong) COMMAND_ARGS=(build) ;;\n'
  printf '  extra) COMMAND_ARGS=(prepare-browser extra) ;;\n'
  printf 'esac\n'
  cat "$browser_source_authority_function"
  printf 'validate_ci_browser_source_authority "${COMMAND_ARGS[@]}"\n'
} >"$source_authority_probe"
TEST_AUTHORITY=source-rootfs-mirror-state-v1 \
  bash "$source_authority_probe" ||
  fail "exact CI source-shell authority was rejected"
expect_failure "Unknown internal browser source authority" \
  env TEST_AUTHORITY=unreviewed bash "$source_authority_probe"
expect_failure "requires isolated CI preparation" \
  env TEST_AUTHORITY=source-rootfs-mirror-state-v1 \
    TEST_ALREADY_MATERIALIZED=0 bash "$source_authority_probe"
expect_failure "requires isolated CI preparation" \
  env TEST_AUTHORITY=source-rootfs-mirror-state-v1 TEST_FETCH_ONLY=0 \
    bash "$source_authority_probe"
expect_failure "requires isolated CI preparation" \
  env TEST_AUTHORITY=source-rootfs-mirror-state-v1 TEST_REQUIRE_SEALED=1 \
    bash "$source_authority_probe"
expect_failure "requires isolated CI preparation" \
  env TEST_AUTHORITY=source-rootfs-mirror-state-v1 TEST_SOURCE_ROOTFS=1 \
    bash "$source_authority_probe"
expect_failure "requires isolated CI preparation" \
  env TEST_AUTHORITY=source-rootfs-mirror-state-v1 TEST_PR_STAGING=1 \
    bash "$source_authority_probe"
expect_failure "requires isolated CI preparation" \
  env TEST_AUTHORITY=source-rootfs-mirror-state-v1 TEST_COMMAND_SHAPE=wrong \
    bash "$source_authority_probe"
expect_failure "requires isolated CI preparation" \
  env TEST_AUTHORITY=source-rootfs-mirror-state-v1 TEST_COMMAND_SHAPE=extra \
    bash "$source_authority_probe"

bootstrap_probe_root="$TMP_ROOT/browser-bootstrap-product-path"
bootstrap_probe_log="$bootstrap_probe_root/calls.log"
mkdir -p "$bootstrap_probe_root/node_modules/.bin" \
  "$bootstrap_probe_root/apps/browser-demos/public" \
  "$bootstrap_probe_root/scripts"
: >"$bootstrap_probe_root/node_modules/.bin/tsx"
chmod 0755 "$bootstrap_probe_root/node_modules/.bin/tsx"
cat >"$bootstrap_probe_root/scripts/prepare-homebrew-browser-bootstrap.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TEST_BOOTSTRAP_LOG"
EOF
chmod 0755 \
  "$bootstrap_probe_root/scripts/prepare-homebrew-browser-bootstrap.sh"
bootstrap_probe="$bootstrap_probe_root/run.sh"
{
  printf 'set -euo pipefail\n'
  printf 'REPO_ROOT=%q\n' "$bootstrap_probe_root"
  printf 'CI_BROWSER_SOURCE_AUTHORITY="${TEST_AUTHORITY:-}"\n'
  printf 'REQUIRE_SEALED_HOMEBREW_SELECTION="${TEST_REQUIRE_SEALED:-0}"\n'
  printf 'step() { :; }\n'
  cat "$browser_bootstrap_function"
  printf 'prepare_browser_homebrew_bootstrap\n'
} >"$bootstrap_probe"
TEST_BOOTSTRAP_LOG="$bootstrap_probe_log" bash "$bootstrap_probe"
grep -Fq -- '--browser-asset' "$bootstrap_probe_log" ||
  fail "ordinary browser preparation skipped the Homebrew bootstrap"
: >"$bootstrap_probe_log"
TEST_BOOTSTRAP_LOG="$bootstrap_probe_log" TEST_REQUIRE_SEALED=1 \
  bash "$bootstrap_probe"
grep -Fq -- '--require-sealed' "$bootstrap_probe_log" ||
  fail "publishable browser preparation did not require a sealed bootstrap"
: >"$bootstrap_probe_log"
TEST_BOOTSTRAP_LOG="$bootstrap_probe_log" \
  TEST_AUTHORITY=source-rootfs-mirror-state-v1 bash "$bootstrap_probe"
[ ! -s "$bootstrap_probe_log" ] ||
  fail "authenticated source-rootfs preparation fetched a Homebrew bootstrap"

[ -x "$BROWSER_BOOTSTRAP_PREPARER" ] ||
  fail "the shared browser bootstrap preparer must be executable"
for contract in \
  'fetch-selection-release' \
  'verify-selection-readback' \
  'homebrew-main-shell-selection-lock.py' \
  'extract-homebrew-support-data-bottle.ts' \
  'env -u GH_TOKEN -u GITHUB_TOKEN' \
  'mv -f -- "$staged_browser_asset" "$BROWSER_ASSET"'
do
  grep -Fq "$contract" "$BROWSER_BOOTSTRAP_PREPARER" ||
    fail "browser bootstrap preparer omits contract: $contract"
done
expect_failure "a pending selection cannot replace a sealed selection" \
  bash "$BROWSER_BOOTSTRAP_PREPARER" --require-sealed \
    --pending-selection-root "$TMP_ROOT/untrusted-pending-selection" \
    --output-directory "$TMP_ROOT/strict-bootstrap-output"
grep -Fq 'packages/registry/shell/build-shell.sh' "$RUN_SH" &&
  fail "run.sh must not bypass the resolver by invoking the shell recipe directly"
grep -Fq 'build_fbdoom' "$shell_build_function" &&
  fail "the bottle-built shell resolver path must not retain the obsolete fbdoom prerequisite"
grep -Fq '[ "${KANDELO_REBUILD_TARGET:-}" != "shell-vfs" ] && has_shell_vfs' \
  "$shell_build_function" ||
  fail "rebuild shell-vfs must not short-circuit on a fetched or local artifact"
grep -Fq 'KANDELO_REBUILD_TARGET="$t" build_target "$t"' "$RUN_SH" ||
  fail "run.sh rebuild must identify the target whose availability guard is bypassed"

local_output_function="$TMP_ROOT/pkg-local-output-path-function.sh"
sed -n '/^pkg_local_output_path()/,/^}/p' "$RUN_SH" >"$local_output_function"
grep -Fq 'rel=$(pkg_output_rel "$pkg" "$wasm" "$arch")' "$local_output_function" ||
  fail "local package cleanup must derive output layout from package metadata"
clean_target_function="$TMP_ROOT/clean-target-function.sh"
sed -n '/^clean_target()/,/^}/p' "$RUN_SH" >"$clean_target_function"
shell_clean_case="$TMP_ROOT/clean-shell-vfs-case.sh"
sed -n '/^        shell-vfs)/,/;;/p' "$clean_target_function" >"$shell_clean_case"
grep -Fq 'pkg_remove_local_output shell shell.vfs.zst wasm32' "$shell_clean_case" ||
  fail "clean shell-vfs must remove the resolver-owned local output"
grep -Fq '"$REPO_ROOT/binaries/' "$shell_clean_case" &&
  fail "clean shell-vfs must preserve immutable fetched package artifacts"

for shell_derived_package in lamp node-vfs wordpress; do
  shell_derived_build="$REPO_ROOT/packages/registry/$shell_derived_package/build.toml"
  grep -Fq '"web-libs/kandelo-session/src/vfs-capacity.ts"' "$shell_derived_build" ||
    fail "$shell_derived_package must bind its cache key to the shell-derived capacity contract"
done

(
  cd "$REPO_ROOT"
  npx tsx --test \
    "$CLOSED_ACCEPTANCE_TEST" \
    "$SUPPORT_DATA_INPUT_TEST" \
    "$IMAGE_CONTRACT_TEST" \
    "$PLAYWRIGHT_ACCEPTANCE_TEST" \
    "$SHELL_VFS_URL_TEST" \
    "$TERMINAL_COMMAND_TEST"
) || fail "post-archive image contract unit tests failed"

# Exercise the package wrapper twice at once while replacing only its composer
# subprocess. Each invocation must receive an exclusive resolver-owned
# workspace, publish only the declared VFS, discard its report/cache scratch,
# and remove every ambient GitHub/Homebrew credential before composition.
fake_bin="$TMP_ROOT/fake-composer-bin"
fake_log="$TMP_ROOT/fake-composer.log"
mkdir -p "$fake_bin"
apply_fake_composer="$fake_bin/bash"
cat >"$apply_fake_composer" <<'FAKE_COMPOSER'
#!/bin/bash
set -euo pipefail
composer="${1:-}"
shift
if [[ "$composer" == */packages/registry/shell/prepare-build-tools.sh ]]; then
  for token in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
    HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN \
    NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS NODE_PATH \
    NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
    npm_config_userconfig npm_config_globalconfig npm_config_registry; do
    if [ "${!token+x}" = x ]; then
      echo "credential leaked to build-tool preparer: $token" >&2
      exit 82
    fi
  done
  # Run the real snapshot preparer. npm itself is replaced below, so this
  # exercises two concurrent Git-owned source snapshots without network I/O.
  exec /bin/bash "$composer" "$@"
fi
for token in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN \
  NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS NODE_PATH \
  NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
  npm_config_userconfig npm_config_globalconfig npm_config_registry; do
  if [ "${!token+x}" = x ]; then
    echo "credential leaked to composer: $token" >&2
    exit 80
  fi
done
[ "${SOURCE_DATE_EPOCH:-}" = 0 ] || {
  echo "canonical shell wrapper did not pin SOURCE_DATE_EPOCH=0" >&2
  exit 79
}
if [[ "$composer" == */scripts/prepare-homebrew-main-shell-inputs.sh ]]; then
  [ "${1:-}" = --output-directory ]
  prepared="${2:-}"
  [ -n "$prepared" ] && [ ! -e "$prepared" ]
  mkdir -p "$prepared/selection/tap/Kandelo" "$prepared/bootstrap"
  printf '{}\n' >"$prepared/selection/selection.json"
  printf '{}\n' >"$prepared/selection/tap/Kandelo/metadata.json"
  printf '{}\n' >"$prepared/selection-receipt.json"
  printf 'Formula-owned Homebrew source\n' \
    >"$prepared/bootstrap/homebrew-bootstrap.zip"
  printf 'Formula-owned portable Ruby\n' \
    >"$prepared/bootstrap/homebrew-portable-ruby.zip"
  printf 'HOMEBREW_NO_ANALYTICS=1\n' \
    >"$prepared/bootstrap/homebrew-brew.env"
  printf '{}\n' >"$prepared/bootstrap/report.json"
  exit 0
fi

[[ "$composer" == */scripts/build-homebrew-main-shell-product.sh ]]
# The package must pass the shared product wrapper from its private source
# snapshot. Accepting the checkout-global helper here would reintroduce the
# concurrent mutation race that prepare-build-tools.sh prevents.
source_root="${composer%/scripts/build-homebrew-main-shell-product.sh}"
[ "$source_root" != "$composer" ]
work="" report="" cache="" out="" prepared="" review=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prepared-inputs) prepared="$2"; shift 2 ;;
    --work-dir) work="$2"; shift 2 ;;
    --report) report="$2"; shift 2 ;;
    --bottle-cache) cache="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --review-pending-artifact) review=true; shift ;;
    *) echo "unexpected fake-composer option: $1" >&2; exit 81 ;;
  esac
done
[ -n "$work" ] && [ -n "$report" ] && [ -n "$cache" ] && [ -n "$out" ] &&
  [ "$prepared" = "$WASM_POSIX_DEP_OUT_DIR/.homebrew-shell-build/prepared-inputs" ] &&
  [ -f "$prepared/bootstrap/homebrew-bootstrap.zip" ] &&
  [ -f "$prepared/bootstrap/homebrew-portable-ruby.zip" ] &&
  [ "$review" = "${FAKE_EXPECT_REVIEW:-true}" ]
[ ! -e "$work" ] && [ ! -L "$work" ]
mkdir "$work"
mkdir "$cache"
printf '%s\n' "$WASM_POSIX_DEP_OUT_DIR" >"$out"
printf '{}\n' >"$report"
printf '%s|%s|%s|%s|%s|%s|%s\n' \
  "$WASM_POSIX_DEP_OUT_DIR" "$work" "$report" "$cache" "$out" "$prepared" \
  "$review" \
  >>"$FAKE_COMPOSER_LOG"
FAKE_COMPOSER
cat >"$fake_bin/python3" <<'FAKE_PYTHON'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == */scripts/homebrew-main-shell-product-state.py ]]; then
  printf '%s\n' "${FAKE_PRODUCT_STATE:-candidate}"
  exit 0
fi
exec /usr/bin/env -u PATH PATH=/usr/bin:/bin python3 "$@"
FAKE_PYTHON
cat >"$fake_bin/npm" <<'FAKE_NPM'
#!/bin/bash
set -euo pipefail
prefix="$(pwd -P)"
[ -n "$prefix" ]
if [[ "$prefix" == */tools/mkrootfs ]]; then
  mkdir -p "$prefix/node_modules/fflate"
else
  mkdir -p "$prefix/node_modules/.bin"
  : >"$prefix/node_modules/.bin/tsx"
fi
FAKE_NPM
cat >"$fake_bin/tar" <<'FAKE_TAR'
#!/bin/bash
exec /usr/bin/tar "$@"
FAKE_TAR
chmod 0755 \
  "$apply_fake_composer" \
  "$fake_bin/npm" \
  "$fake_bin/python3" \
  "$fake_bin/tar"
parallel_one="$TMP_ROOT/parallel-shell-one"
parallel_two="$TMP_ROOT/parallel-shell-two"
publishable="$TMP_ROOT/publishable-shell"
mkdir "$parallel_one" "$parallel_two" "$publishable"
run_fake_shell_build() {
  local out_dir="$1"
  local product_state="${2:-candidate}"
  local expected_review="${3:-true}"
  # This fixture intentionally replaces bash/npm to observe the wrapper. Run
  # it through the recipe's supported external-resolver mode; the separate
  # preparer test exercises and verifies the authoritative Nix-only path.
  env -u KANDELO_DEV_SHELL_TOOL_PATH \
    PATH="$fake_bin:$PATH" \
    FAKE_COMPOSER_LOG="$fake_log" \
    FAKE_PRODUCT_STATE="$product_state" \
    FAKE_EXPECT_REVIEW="$expected_review" \
    PACKAGE_TREE_SPEC="$PACKAGE_TREE_SPEC" \
    GH_TOKEN=forbidden \
    GITHUB_TOKEN=forbidden \
    HOMEBREW_GITHUB_API_TOKEN=forbidden \
    HOMEBREW_GITHUB_PACKAGES_TOKEN=forbidden \
    HOMEBREW_DOCKER_REGISTRY_TOKEN=forbidden \
    NPM_TOKEN=forbidden \
    NODE_AUTH_TOKEN=forbidden \
    NODE_OPTIONS=--trace-warnings \
    NODE_PATH="$TMP_ROOT/forbidden-node-path" \
    NPM_CONFIG_USERCONFIG="$TMP_ROOT/forbidden-user.npmrc" \
    NPM_CONFIG_GLOBALCONFIG="$TMP_ROOT/forbidden-global.npmrc" \
    NPM_CONFIG_REGISTRY=https://attacker.invalid/ \
    npm_config_userconfig="$TMP_ROOT/forbidden-lower-user.npmrc" \
    npm_config_globalconfig="$TMP_ROOT/forbidden-lower-global.npmrc" \
    npm_config_registry=https://lower-attacker.invalid/ \
    WASM_POSIX_DEP_OUT_DIR="$out_dir" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    /bin/bash "$SHELL_BUILDER"
}
run_fake_shell_build "$parallel_one" &
parallel_one_pid=$!
run_fake_shell_build "$parallel_two" &
parallel_two_pid=$!
wait "$parallel_one_pid" || fail "first concurrent shell wrapper failed"
wait "$parallel_two_pid" || fail "second concurrent shell wrapper failed"
run_fake_shell_build "$publishable" publishable false ||
  fail "publishable shell wrapper failed"

[ "$(wc -l <"$fake_log" | tr -d '[:space:]')" -eq 3 ] ||
  fail "candidate and publishable wrappers did not produce three records"
for out_dir in "$parallel_one" "$parallel_two" "$publishable"; do
  [ -f "$out_dir/shell.vfs.zst" ] || fail "shell wrapper omitted final VFS in $out_dir"
  [ "$(find "$out_dir" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d '[:space:]')" -eq 1 ] ||
    fail "shell wrapper leaked scratch outputs into $out_dir"
  [ ! -e "$out_dir/.homebrew-shell-build" ] ||
    fail "shell wrapper did not clean resolver-owned scratch in $out_dir"
  grep -Fq "$out_dir|$out_dir/.homebrew-shell-build/work|" "$fake_log" ||
    fail "composer did not receive the exclusive workspace below $out_dir"
done
[ "$(cut -d'|' -f2 "$fake_log" | sort -u | wc -l | tr -d '[:space:]')" -eq 3 ] ||
  fail "shell wrappers shared one composer workspace"
awk -F'|' \
  -v one="$parallel_one" \
  -v two="$parallel_two" '
    ($1 == one || $1 == two) && $7 == "true" { seen[$1] = 1 }
    END { exit !(seen[one] && seen[two]) }
  ' "$fake_log" ||
  fail "candidate package build did not request pending-artifact review"
awk -F'|' -v out="$publishable" '
    $1 == out && $7 == "false" { found = 1 }
    END { exit !found }
  ' "$fake_log" ||
  fail "publishable package build bypassed the strict product path"
grep -Fq "$REPO_ROOT/target/homebrew-main-shell" "$fake_log" &&
  fail "composer reused the repository-global Homebrew target workspace"

mkdir "$TMP_ROOT/pending-selection"
expect_failure "shell package awaits its immutable bottle selection" \
  env -u KANDELO_DEV_SHELL_TOOL_PATH \
    PATH="$fake_bin:$PATH" \
    FAKE_PRODUCT_STATE=awaiting-selection \
    WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/pending-selection" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
  /bin/bash "$SHELL_BUILDER"

tap="$TMP_ROOT/tap"
mkdir -p "$tap/Kandelo"
git -C "$tap" init -q
git -C "$tap" config user.email "homebrew-contract-test@example.invalid"
git -C "$tap" config user.name "Homebrew contract test"
printf '%s\n' \
  '{"tap_repository":"kandelo-dev/homebrew-tap-core","tap_name":"kandelo-dev/tap-core"}' \
  >"$tap/Kandelo/metadata.json"
git -C "$tap" add Kandelo/metadata.json
git -C "$tap" commit -qm "Homebrew: Add canonical test metadata"
tap_sha="$(git -C "$tap" rev-parse HEAD)"
lock="$TMP_ROOT/main-shell-migration-lock.json"
jq --arg sha "$tap_sha" '.catalog.tap_commit = $sha' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"

expect_failure "must match locked catalog" \
  "$BUILDER" --tap-root "$tap" \
  --work-dir "$TMP_ROOT/work-mismatched-catalog" \
  --migration-lock "$lock" \
  --expected-tap-sha 0000000000000000000000000000000000000000

expect_failure "package-tree spec and archive must be provided together" \
  "$BUILDER" --tap-root "$tap" \
  --work-dir "$TMP_ROOT/work-package-tree-without-archive" \
  --migration-lock "$lock" --package-tree-spec "$PACKAGE_TREE_SPEC"
expect_failure "--materialize-package-tree requires a package tree" \
  "$BUILDER" --tap-root "$tap" \
  --work-dir "$TMP_ROOT/work-materialize-without-package-tree" \
  --migration-lock "$lock" --materialize-package-tree
expect_failure "--review-pending-artifact requires --lazy-shell" \
  "$BUILDER" --tap-root "$tap" \
  --work-dir "$TMP_ROOT/work-review-without-lazy-shell" \
  --migration-lock "$lock" --review-pending-artifact

printf '%s\n' "untracked" >"$tap/untracked-file"
expect_failure "exact tap checkout is dirty" \
  "$BUILDER" --tap-root "$tap" --work-dir "$TMP_ROOT/work-dirty-tap" \
  --migration-lock "$lock"
rm "$tap/untracked-file"

tap_worktree="$TMP_ROOT/tap-worktree"
git -C "$tap" worktree add --detach "$tap_worktree" "$tap_sha" >/dev/null
[ -f "$tap_worktree/.git" ] ||
  fail "linked tap fixture does not exercise a .git worktree file"

bootstrap_dir="$TMP_ROOT/transitional-bootstrap-fixture"
mkdir "$bootstrap_dir"
printf '%s\n' "untrusted Homebrew source" \
  >"$bootstrap_dir/homebrew-bootstrap.zip"
printf '%s\n' "HOMEBREW_NO_ANALYTICS=1" \
  >"$bootstrap_dir/homebrew-brew.env"
printf '%s\n' "untrusted portable Ruby" \
  >"$bootstrap_dir/homebrew-portable-ruby.zip"

# A manual composer invocation must not be able to seal a locally generated or
# stale ZIP under the trusted homebrew-bootstrap package name. The package's
# source lock owns the only bytes accepted by the deferred-tree descriptor.
expect_failure "homebrew-bootstrap source lock: output archive has" \
  "$BUILDER" --lazy-shell --tap-root "$tap_worktree" \
  --work-dir "$TMP_ROOT/work-wrong-bootstrap-archive" \
  --migration-lock "$lock" \
  --package-tree-spec "$PACKAGE_TREE_SPEC" \
  --package-tree-archive "$bootstrap_dir/homebrew-bootstrap.zip" \
  --homebrew-portable-ruby-archive \
    "$bootstrap_dir/homebrew-portable-ruby.zip" \
  --homebrew-bootstrap-env "$bootstrap_dir/homebrew-brew.env"

wrong_epoch_lock="$TMP_ROOT/main-shell-wrong-epoch-lock.json"
jq '.source_date_epoch = 1' "$LAZY_ARTIFACT_LOCK" >"$wrong_epoch_lock"
expect_failure "lock is invalid or uses a different timestamp epoch" \
  "$BUILDER" --lazy-shell --tap-root "$tap_worktree" \
  --work-dir "$TMP_ROOT/work-wrong-lazy-epoch" --migration-lock "$lock" \
  --lazy-artifact-lock "$wrong_epoch_lock"
old_schema_lock="$TMP_ROOT/main-shell-old-schema-lock.json"
jq '.schema = 2' "$LAZY_ARTIFACT_LOCK" >"$old_schema_lock"
expect_failure "lock is invalid or uses a different timestamp epoch" \
  bash "$LAZY_ARTIFACT_CHECKER" \
    --lock "$old_schema_lock" --expected-source-date-epoch 0
extra_field_lock="$TMP_ROOT/main-shell-extra-field-lock.json"
jq '.unexpected = true' "$LAZY_ARTIFACT_LOCK" >"$extra_field_lock"
expect_failure "lock is invalid or uses a different timestamp epoch" \
  "$BUILDER" --lazy-shell --tap-root "$tap_worktree" \
  --work-dir "$TMP_ROOT/work-extra-lazy-lock-field" --migration-lock "$lock" \
  --lazy-artifact-lock "$extra_field_lock"
sealed_fixture_lock="$TMP_ROOT/main-shell-sealed-artifact-lock.json"
# WHY: source updates truthfully return the checked-in artifact lock to
# pending. Build the opposite-state fixture explicitly so this rejection test
# covers a sealed lock in both release phases instead of assuming repository
# state happens to be sealed.
jq '
  .state = "sealed" |
  .image = {
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    bytes: 1
  }
' "$LAZY_ARTIFACT_LOCK" >"$sealed_fixture_lock"
expect_failure "--review-pending-artifact requires a pending artifact lock" \
  "$BUILDER" --lazy-shell --tap-root "$tap_worktree" \
  --work-dir "$TMP_ROOT/work-review-sealed-lazy-lock" \
  --migration-lock "$lock" \
  --lazy-artifact-lock "$sealed_fixture_lock" \
  --review-pending-artifact
# Exercise the verifier against an actual changed input rather than only
# changing the reviewed digest. The copied checker resolves its repository root
# from this isolated fixture, so this does not mutate the working checkout.
artifact_checker_root="$TMP_ROOT/artifact-checker-root"
mkdir -p "$artifact_checker_root/scripts" "$artifact_checker_root/homebrew"
cp "$LAZY_ARTIFACT_CHECKER" "$artifact_checker_root/scripts/"
for relative_path in \
  homebrew/main-shell-brew-package-tree.json \
  homebrew/main-shell.Brewfile \
  homebrew/main-shell-default.json \
  homebrew/main-shell-demo.json \
  homebrew/main-shell-materialization-policy.json \
  homebrew/main-shell-migration-lock.json \
  homebrew/main-shell-homebrew-runtime-support.json \
  homebrew/main-shell-selection-lock.json \
  homebrew/main-shell-lazy-artifact-lock.json
do
  cp "$REPO_ROOT/$relative_path" "$artifact_checker_root/$relative_path"
done
fixture_checker="$artifact_checker_root/scripts/verify-homebrew-main-shell-artifact-lock.sh"
fixture_checked_lock="$artifact_checker_root/homebrew/main-shell-lazy-artifact-lock.json"
bash "$fixture_checker" \
  --lock "$fixture_checked_lock" --expected-source-date-epoch 0 ||
  fail "artifact checker rejected its exact shell-config binding"
printf '\n' >>"$artifact_checker_root/homebrew/main-shell-default.json"
expect_failure \
  "bound input digest changed: homebrew/main-shell-default.json" \
  bash "$fixture_checker" \
    --lock "$fixture_checked_lock" --expected-source-date-epoch 0

# Exercise the final compressed-artifact checks without rebuilding the full
# bottle closure. SHA-256 and byte count are independent promises: matching one
# must not let a mismatch in the other pass.
artifact_fixture="$TMP_ROOT/lazy-shell-artifact.vfs.zst"
printf '%s\n' "exact lazy shell artifact fixture" >"$artifact_fixture"
artifact_sha="$(sha256sum "$artifact_fixture")"
artifact_sha="${artifact_sha%% *}"
artifact_bytes="$(wc -c <"$artifact_fixture" | tr -d '[:space:]')"
fixture_lock="$TMP_ROOT/lazy-shell-artifact-lock.json"
jq --arg sha "$artifact_sha" --argjson bytes "$artifact_bytes" \
  '.state = "sealed" | .image = {sha256: $sha, bytes: $bytes}' \
  "$LAZY_ARTIFACT_LOCK" >"$fixture_lock"
pending_fixture_lock="$TMP_ROOT/lazy-shell-pending-artifact-lock.json"
# WHY: the checked-in lock advances from pending to sealed after a reviewed
# artifact is reproduced. Keep testing the pre-publication fail-closed state
# explicitly instead of making this test depend on that release phase.
jq '.state = "pending" | .image = null' \
  "$LAZY_ARTIFACT_LOCK" >"$pending_fixture_lock"
bash "$LAZY_ARTIFACT_CHECKER" \
  --lock "$fixture_lock" --expected-source-date-epoch 0 \
  --artifact "$artifact_fixture" ||
  fail "artifact checker rejected the exact digest and byte count"
expect_failure "reviewed artifact identity is still pending" \
  bash "$LAZY_ARTIFACT_CHECKER" \
    --lock "$pending_fixture_lock" --expected-source-date-epoch 0 \
    --artifact "$artifact_fixture"

grep -Fq 'candidate) PRODUCT_REVIEW_ARGS=(--review-pending-artifact)' \
  "$SHELL_BUILDER" &&
  grep -Fq 'publishable) ;;' "$SHELL_BUILDER" &&
  grep -Fq 'scripts/homebrew-main-shell-product-state.py' "$SHELL_BUILDER" ||
  fail "shell package must separate candidate review from publishable bytes"
for shipping_workflow in \
  "$REPO_ROOT/.github/workflows/browser-demos-pages.yml" \
  "$REPO_ROOT/.github/workflows/reusable-homebrew-main-shell-mirror-publish.yml"
do
  grep -Fq -- '--review-pending-artifact' "$shipping_workflow" &&
    fail "shipping workflow bypasses the reviewed artifact seal:" \
      "$shipping_workflow"
done

check_candidate_artifact_review_contract() {
  local workflow="$1"
  local block

  block="$(sed -n \
    '/- name: Build the exact lazy shell from public bottles/,/- name: Select the source shell for dependent browser VFS builds/p' \
    "$workflow")"
  grep -Fq 'case "$CALLER_EVENT_NAME:$artifact_state" in' <<<"$block" &&
    grep -Fq 'pull_request:pending|push:pending)' <<<"$block" &&
    grep -Fq 'artifact_review_args=(--review-pending-artifact)' \
      <<<"$block" &&
    grep -Fq '*:sealed)' <<<"$block" &&
    grep -Fq 'artifact_review_args=()' <<<"$block" &&
    grep -Fq '"${artifact_review_args[@]}"' <<<"$block" &&
    [ "$(grep -Fc -- '--review-pending-artifact' "$workflow")" -eq 1 ]
}

# A changed catalog makes the prior image identity stale before the
# replacement bytes can be known. Exact PR and protected-main CI may
# exercise that deterministic candidate, but manual shipping must keep
# failing closed until the artifact digest and byte count are sealed.
check_candidate_artifact_review_contract "$WORKFLOW" ||
  fail "candidate CI confuses review bytes with sealed shipping bytes"

sed 's/pull_request:pending|push:pending)/*:pending)/' \
  "$WORKFLOW" >"$TMP_ROOT/main-shell-manual-pending-review.yml"
if check_candidate_artifact_review_contract \
  "$TMP_ROOT/main-shell-manual-pending-review.yml"
then
  fail "candidate review contract accepted manual pending shipping"
fi
sed '/"${artifact_review_args\[@\]}"/d' \
  "$WORKFLOW" >"$TMP_ROOT/main-shell-drops-pending-review-argument.yml"
if check_candidate_artifact_review_contract \
  "$TMP_ROOT/main-shell-drops-pending-review-argument.yml"
then
  fail "candidate review contract accepted a missing composer argument"
fi
sed '/\*:sealed)/d' "$WORKFLOW" \
  >"$TMP_ROOT/main-shell-drops-sealed-review-path.yml"
if check_candidate_artifact_review_contract \
  "$TMP_ROOT/main-shell-drops-sealed-review-path.yml"
then
  fail "candidate review contract accepted a missing sealed path"
fi
sed '1i\
# --review-pending-artifact
' "$WORKFLOW" \
  >"$TMP_ROOT/main-shell-adds-second-review-bypass.yml"
if check_candidate_artifact_review_contract \
  "$TMP_ROOT/main-shell-adds-second-review-bypass.yml"
then
  fail "candidate review contract accepted a second review bypass"
fi

wrong_sha_lock="$TMP_ROOT/lazy-shell-wrong-sha-lock.json"
jq '.image.sha256 = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "$fixture_lock" >"$wrong_sha_lock"
expect_failure "artifact SHA-256 does not match the reviewed lock" \
  bash "$LAZY_ARTIFACT_CHECKER" \
    --lock "$wrong_sha_lock" --expected-source-date-epoch 0 \
    --artifact "$artifact_fixture"

wrong_bytes_lock="$TMP_ROOT/lazy-shell-wrong-bytes-lock.json"
jq --argjson bytes "$((artifact_bytes + 1))" '.image.bytes = $bytes' \
  "$fixture_lock" >"$wrong_bytes_lock"
expect_failure "artifact byte count does not match the reviewed lock" \
  bash "$LAZY_ARTIFACT_CHECKER" \
    --lock "$wrong_bytes_lock" --expected-source-date-epoch 0 \
    --artifact "$artifact_fixture"

artifact_symlink="$TMP_ROOT/lazy-shell-artifact-symlink.vfs.zst"
ln -s "$artifact_fixture" "$artifact_symlink"
expect_failure "--artifact must be a regular non-symlink file" \
  bash "$LAZY_ARTIFACT_CHECKER" \
    --lock "$fixture_lock" --expected-source-date-epoch 0 \
    --artifact "$artifact_symlink"
expect_failure "--max-bytes must match the locked consumer capacity" \
  "$BUILDER" --tap-root "$tap_worktree" --work-dir "$TMP_ROOT/work-bad-capacity" \
  --migration-lock "$lock" --max-bytes 4096

printf '%s\n' \
  '{"tap_repository":"example/wrong-tap","tap_name":"example/wrong"}' \
  >"$tap/Kandelo/metadata.json"
git -C "$tap" add Kandelo/metadata.json
git -C "$tap" commit -qm "Homebrew: Make test identity invalid"
tap_sha="$(git -C "$tap" rev-parse HEAD)"
jq --arg sha "$tap_sha" '.catalog.tap_commit = $sha' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"
expect_failure "tap metadata has the wrong repository identity" \
  "$BUILDER" --tap-root "$tap" --work-dir "$TMP_ROOT/work-wrong-tap" \
  --migration-lock "$lock"

baseline_output="$(node "$CHECKER")"
grep -Fq "$EXPECTED_SHAPE_SUMMARY" \
  <<<"$baseline_output" ||
  fail "main-shell checker does not report its derived Formula counts"

metadata="$TMP_ROOT/main-shell-metadata.json"
jq --slurpfile support "$RUNTIME_SUPPORT" '
  def dependencies:
    if . == "bash" then ["ncurses"]
    elif . == "ncurses" then ["libcxx"]
    elif . == "m4" then ["dash"]
    elif . == "file-formula" then ["libmagic"]
    elif . == "diffutils" then ["coreutils", "ed"]
    elif . == "tar" then ["dash", "gzip"]
    elif . == "curl" then ["libcurl", "openssl", "zlib"]
    elif . == "git" then
      ["coreutils", "dash", "diffutils", "grep", "less", "libcurl", "openssl", "sed", "vim", "zlib"]
    elif . == "libcurl" then ["openssl", "zlib"]
    elif . == "less" or . == "vim" then ["ncurses"]
    elif . == "ruby" then ["zlib"]
    else []
    end;
  . as $lock |
  ($support[0].availability.audited_catalog) as $audit |
  ([.packages[].formula | {
      name,
      version: (if .revision == 0 then .version else "\(.version)_\(.revision)" end),
      formula_revision: .revision,
      bottle_rebuild
    }]) as $locked_formulae |
  ($locked_formulae | map(.name)) as $locked_names |
  (
    $locked_formulae +
    [
      $support[0].availability.reusable_public_abi42[] |
      split("/")[-1] |
      select(. as $name | $locked_names | index($name) | not) |
      {
        name: .,
        version: "1.0",
        formula_revision: 0,
        bottle_rebuild: 0
      }
    ]
  ) as $formulae |
  {
    schema: 1,
    tap_repository: $lock.tap_repository,
    tap_name: $lock.tap_name,
    tap_commit: $audit.metadata_tap_commit,
    kandelo_commit: $audit.kandelo_commit,
    kandelo_abi: $audit.kandelo_abi,
    release_tag: $audit.release_tag,
    packages: [$formulae[] | . as $formula | {
      name: $formula.name,
      full_name: ("kandelo-dev/tap-core/" + $formula.name),
      version: $formula.version,
      formula_revision: $formula.formula_revision,
      bottle_rebuild: $formula.bottle_rebuild,
      dependencies: [($formula.name | dependencies)[] | . as $dependency | {
        name: $dependency,
        full_name: ("kandelo-dev/tap-core/" + $dependency)
      }],
      bottles: [{
        arch: "wasm32",
        bottle_tag: "wasm32_kandelo",
        status: "success",
        kandelo_abi: 42,
        bytes: 1,
        sha256: ("a" * 64),
        cache_key_sha: ("a" * 64),
        url: (
          "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/" +
          $formula.name +
          "/blobs/sha256:" +
          ("a" * 64)
        ),
        runtime_support: ["node"],
        built_from: {
          tap_repository: "kandelo-dev/homebrew-tap-core",
          tap_commit: $audit.metadata_tap_commit,
          kandelo_repository: "Automattic/kandelo",
          # Model the real incremental catalog: unchanged immutable bottles can
          # truthfully predate the aggregate metadata publication.
          kandelo_commit: (
            if $formula.name == "gawk"
            then ("c" * 40)
            else $audit.kandelo_commit
            end
          ),
          formula_sha256: ("b" * 64)
        }
      }]
    }]
  }
' "$SOURCE_LOCK" >"$metadata"

baseline_provenance_sha="$(node "$CHECKER" \
  --print-runtime-bottle-provenance-sha256 \
  "$metadata" "$RUNTIME_SUPPORT")"

checker_with_metadata() {
  local lock_path="$1"
  local metadata_path="$2"
  local support_path="$TMP_ROOT/synthetic-runtime-support.json"
  local metadata_sha
  metadata_sha="$(sha256sum "$metadata_path")"
  metadata_sha="${metadata_sha%% *}"
  jq --arg metadata_sha "$metadata_sha" \
    --arg provenance_sha "$baseline_provenance_sha" '
      .availability.audited_catalog.metadata_sha256 = $metadata_sha |
      .availability.audited_catalog.runtime_bottle_provenance_sha256 =
        $provenance_sha
    ' \
    "$RUNTIME_SUPPORT" >"$support_path"
  node "$CHECKER" "$BREWFILE" "$lock_path" "$metadata_path" "$support_path"
}

jq -e '
  .kandelo_commit !=
    (.packages[] | select(.name == "gawk") |
      .bottles[] | select(.arch == "wasm32") |
      .built_from.kandelo_commit)
' "$metadata" >/dev/null ||
  fail "synthetic runtime catalog does not exercise mixed bottle producers"
metadata_output="$(checker_with_metadata "$SOURCE_LOCK" "$metadata")"
grep -Fq "$EXPECTED_SHAPE_SUMMARY" \
  <<<"$metadata_output" ||
  fail "main-shell checker did not validate the exact synthetic tap closure"

provenance_drift="$TMP_ROOT/runtime-provenance-drift.json"
jq '
  (.packages[] | select(.name == "gawk") |
    .bottles[] | select(.arch == "wasm32") |
    .built_from.kandelo_commit) = ("d" * 40)
' "$metadata" >"$provenance_drift"
provenance_drift_metadata_sha="$(sha256sum "$provenance_drift")"
provenance_drift_metadata_sha="${provenance_drift_metadata_sha%% *}"
provenance_drift_support="$TMP_ROOT/runtime-provenance-drift-support.json"
jq --arg metadata_sha "$provenance_drift_metadata_sha" \
  --arg provenance_sha "$baseline_provenance_sha" '
    .availability.audited_catalog.metadata_sha256 = $metadata_sha |
    .availability.audited_catalog.runtime_bottle_provenance_sha256 =
      $provenance_sha
  ' "$RUNTIME_SUPPORT" >"$provenance_drift_support"
expect_failure "runtime-support bottle provenance digest differs from the reviewed cohort" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" \
    "$provenance_drift" "$provenance_drift_support"

aggregate_drift="$TMP_ROOT/runtime-aggregate-authority-drift.json"
jq '.kandelo_commit = ("e" * 40)' "$metadata" >"$aggregate_drift"
aggregate_drift_metadata_sha="$(sha256sum "$aggregate_drift")"
aggregate_drift_metadata_sha="${aggregate_drift_metadata_sha%% *}"
aggregate_drift_support="$TMP_ROOT/runtime-aggregate-authority-drift-support.json"
jq --arg metadata_sha "$aggregate_drift_metadata_sha" \
  --arg provenance_sha "$baseline_provenance_sha" '
    .availability.audited_catalog.metadata_sha256 = $metadata_sha |
    .availability.audited_catalog.runtime_bottle_provenance_sha256 =
      $provenance_sha
  ' "$RUNTIME_SUPPORT" >"$aggregate_drift_support"
expect_failure "tap metadata differs from the exact audited ABI-42 catalog" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" \
    "$aggregate_drift" "$aggregate_drift_support"

unknown_provenance_support="$TMP_ROOT/runtime-unknown-provenance-support.json"
jq '
  .availability.reusable_public_abi42[0] =
    "kandelo-dev/tap-core/unknown"
' "$RUNTIME_SUPPORT" >"$unknown_provenance_support"
expect_failure "Formula unknown has no admitted package metadata" \
  node "$CHECKER" --print-runtime-bottle-provenance-sha256 \
    "$metadata" "$unknown_provenance_support"

duplicate_provenance_support="$TMP_ROOT/runtime-duplicate-provenance-support.json"
jq '
  .availability.reusable_public_abi42 +=
    [.availability.reusable_public_abi42[0]]
' "$RUNTIME_SUPPORT" >"$duplicate_provenance_support"
expect_failure "runtime-support provenance cohort contains duplicate" \
  node "$CHECKER" --print-runtime-bottle-provenance-sha256 \
    "$metadata" "$duplicate_provenance_support"

duplicate_runtime_bottle="$TMP_ROOT/duplicate-runtime-bottle.json"
jq '
  (.packages[] | select(.name == "gawk") | .bottles) +=
    [(.packages[] | select(.name == "gawk") | .bottles[0])]
' "$metadata" >"$duplicate_runtime_bottle"
expect_failure "Formula gawk has 2 wasm32 bottle identities, expected one" \
  node "$CHECKER" --print-runtime-bottle-provenance-sha256 \
    "$duplicate_runtime_bottle" "$RUNTIME_SUPPORT"

jq 'del(.formula_closure)' "$SOURCE_LOCK" >"$lock"
expect_failure "packages/formula_closure/substitutions must be arrays" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.formula_closure = []' "$SOURCE_LOCK" >"$lock"
expect_failure "must contain roots and a closure" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.formula_closure[-1] = .formula_closure[-2]' "$SOURCE_LOCK" >"$lock"
expect_failure "migration lock formula_closure contains duplicate" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.formula_closure[] | select(. == "kandelo-dev/tap-core/dash")) =
  "kandelo-dev/tap-core/replacement-root"' "$SOURCE_LOCK" >"$lock"
expect_failure "formula_closure omits registry-root Formulae" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.formula_closure[0] = "other/tap/dash"' "$SOURCE_LOCK" >"$lock"
expect_failure "must be a canonical kandelo-dev/tap-core/<formula> identity" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.packages |= map(select(.name != "libmagic"))' \
  "$metadata" >"$TMP_ROOT/missing-dependency.json"
expect_failure "missing dependency of file-formula Formula libmagic" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/missing-dependency.json"

jq '(.packages[] | select(.name == "file-formula") | .dependencies) = []' \
  "$metadata" >"$TMP_ROOT/short-closure.json"
expect_failure "resolves $((SOURCE_CLOSURE_COUNT - 1)) main-shell Formulae" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/short-closure.json"

jq '
  (.packages[] | select(.name == "dash") | .dependencies) +=
    [{"name":"unexpected","full_name":"kandelo-dev/tap-core/unexpected"}] |
  .packages += [{
    "name":"unexpected",
    "full_name":"kandelo-dev/tap-core/unexpected",
    "version":"1.0",
    "formula_revision":0,
    "bottle_rebuild":0,
    "dependencies":[]
  }]
' "$metadata" >"$TMP_ROOT/long-closure.json"
expect_failure "resolves $((SOURCE_CLOSURE_COUNT + 1)) main-shell Formulae" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/long-closure.json"

jq '
  (.packages[] | select(.name == "file-formula") | .dependencies[] |
    select(.name == "libmagic")) =
      {"name":"unexpected","full_name":"kandelo-dev/tap-core/unexpected"} |
  .packages += [{
    "name":"unexpected",
    "full_name":"kandelo-dev/tap-core/unexpected",
    "version":"1.0",
    "formula_revision":0,
    "bottle_rebuild":0,
    "dependencies":[]
  }]
' "$metadata" >"$TMP_ROOT/wrong-closure.json"
expect_failure "tap metadata dependency closure does not match reviewed formula_closure" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/wrong-closure.json"

jq '(.packages[] | select(.name == "libcxx") | .dependencies) =
  [{"name":"ncurses","full_name":"kandelo-dev/tap-core/ncurses"}]' \
  "$metadata" >"$TMP_ROOT/cyclic-closure.json"
expect_failure "tap metadata dependency cycle: ncurses -> libcxx -> ncurses" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/cyclic-closure.json"

jq '.packages += [.packages[0]]' "$metadata" >"$TMP_ROOT/duplicate-formula.json"
expect_failure "tap metadata contains duplicate Formula" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/duplicate-formula.json"

jq '(.packages[] | select(.name == "bash") | .dependencies[0].full_name) =
  "other/tap/ncurses"' "$metadata" >"$TMP_ROOT/cross-tap-dependency.json"
expect_failure "is not a canonical same-tap dependency" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/cross-tap-dependency.json"

jq '(.packages[] | select(.name == "gawk") | .bottles[0].status) = "failed"' \
  "$metadata" >"$TMP_ROOT/failed-runtime-bottle.json"
expect_failure "Formula gawk lacks an admitted public wasm32 ABI-42 bottle identity" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/failed-runtime-bottle.json"

jq '(.packages[] | select(.name == "gawk") | .bottles) = []' \
  "$metadata" >"$TMP_ROOT/missing-runtime-bottle.json"
expect_failure "Formula gawk has 0 wasm32 bottle identities, expected one" \
  checker_with_metadata "$SOURCE_LOCK" "$TMP_ROOT/missing-runtime-bottle.json"

jq 'del(.catalog)' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "must pin one exact catalog commit" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.catalog.tap_commit = "main"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "must pin one exact catalog commit" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.reviewed_substitutions[0]) |= del(.reason)' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "reviewed_substitutions[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.reviewed_substitutions += [{
  "kind":"formula_identity",
  "registry":"undeclared@1.0",
  "formula":"kandelo-dev/tap-core/undeclared-formula@1.0",
  "reason":"Synthetic undeclared substitution."
}]' "$SOURCE_LOCK" >"$lock"
expect_failure "extra: formula_identity:undeclared@1.0->kandelo-dev/tap-core/undeclared-formula@1.0" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.reviewed_substitutions += [.reviewed_substitutions[0]]' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "reviewed migration substitutions contains duplicate" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.reviewed_substitutions |= map(select(.registry != "m4@1.4.19"))' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "missing: version:m4@1.4.19->kandelo-dev/tap-core/m4@1.4.21" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.reviewed_substitutions[] | select(.kind == "version" and
  .registry == "m4@1.4.19") | .formula) = "kandelo-dev/tap-core/m4@1.4.22"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "extra: version:m4@1.4.19->kandelo-dev/tap-core/m4@1.4.22" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.packages[] | select(.registry.name == "m4") | .formula.version) = "1.4.19"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "extra: version:m4@1.4.19->kandelo-dev/tap-core/m4@1.4.21" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.consumer.max_vfs_byte_length = 268435456' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "must declare the 512 MiB consumer profile" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.link_conflict_owners[0].package = "kandelo-dev/tap-core/not-locked"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility.link_conflict_owners[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq 'del(.compatibility.aliases[0].source_kind)' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility.aliases[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

last_alias_index="$(jq -er '.compatibility.aliases | length - 1' "$SOURCE_LOCK")"
jq '(.compatibility.aliases[-1].package) = "kandelo-dev/tap-core/not-locked"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility.aliases[$last_alias_index] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.aliases[1].targets[0] = .compatibility.aliases[0].targets[0]' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility alias target is duplicated" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq 'del(.compatibility.public_commands)' "$SOURCE_LOCK" >"$lock"
expect_failure "main-shell migration compatibility policy is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.public_commands.usr_bin_only +=
  [.compatibility.public_commands.mirrored_names[0]] |
  .compatibility.public_commands.usr_bin_only |= sort' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "public command names across path cohorts contains duplicate" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.public_commands.supporting_paths[0].package =
  "kandelo-dev/tap-core/not-locked"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "public_commands.supporting_paths[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq 'del(.compatibility.runtime_state)' "$SOURCE_LOCK" >"$lock"
expect_failure "main-shell migration compatibility policy is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.runtime_state = [{
  "requires_package":"kandelo-dev/tap-core/not-locked",
  "path":"/var/lib/homebrew",
  "kind":"directory",
  "mode":493,
  "uid":0,
  "gid":0,
  "reason":"Synthetic invalid base runtime state."
}]' "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility.runtime_state[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

echo "test-homebrew-main-shell-closure: ok"
