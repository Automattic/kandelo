#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$REPO_ROOT/scripts/build-homebrew-main-shell-closure.sh"
CHECKER="$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs"
BREWFILE="$REPO_ROOT/homebrew/main-shell.Brewfile"
SOURCE_LOCK="$REPO_ROOT/homebrew/main-shell-migration-lock.json"
LAZY_ARTIFACT_LOCK="$REPO_ROOT/homebrew/main-shell-lazy-artifact-lock.json"
LAZY_ARTIFACT_CHECKER="$REPO_ROOT/scripts/verify-homebrew-main-shell-artifact-lock.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/homebrew-main-shell-ci.yml"
IMAGE_CONTRACT="$REPO_ROOT/scripts/homebrew-main-shell-image-contract.ts"
IMAGE_CONTRACT_TEST="$REPO_ROOT/scripts/homebrew-main-shell-image-contract.test.ts"
NODE_SMOKE="$REPO_ROOT/scripts/homebrew-main-shell-node-smoke.ts"
BROWSER_SMOKE="$REPO_ROOT/apps/browser-demos/test/kandelo-homebrew-main-shell.spec.ts"
MODESET_SMOKE="$REPO_ROOT/apps/browser-demos/test/kandelo-modeset.spec.ts"
EAGER_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts"
MATERIALIZED_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-materialized-vfs-image.ts"
STAGING_WORKFLOW="$REPO_ROOT/.github/workflows/staging-build.yml"
PREPARE_MERGE_WORKFLOW="$REPO_ROOT/.github/workflows/prepare-merge.yml"
FORCE_REBUILD_WORKFLOW="$REPO_ROOT/.github/workflows/force-rebuild.yml"
SHELL_BUILD_TOML="$REPO_ROOT/packages/registry/shell/build.toml"
SHELL_BUILDER="$REPO_ROOT/packages/registry/shell/build-shell.sh"
SHELL_PACKAGE_TOML="$REPO_ROOT/packages/registry/shell/package.toml"
HOMEBREW_BOOTSTRAP_PACKAGE_TOML="$REPO_ROOT/packages/registry/homebrew-bootstrap/package.toml"
PACKAGE_TREE_SPEC="$REPO_ROOT/homebrew/main-shell-brew-package-tree.json"
LAZY_ARCHIVE_RESOLVER="$REPO_ROOT/apps/browser-demos/lib/init/lazy-archives.ts"
RUN_SH="$REPO_ROOT/run.sh"
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

command -v git >/dev/null 2>&1 || fail "git is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v node >/dev/null 2>&1 || fail "node is required"

SOURCE_ROOT_COUNT="$(jq -er '.packages | length' "$SOURCE_LOCK")"
SOURCE_CLOSURE_COUNT="$(jq -er '.formula_closure | length' "$SOURCE_LOCK")"

pull_paths="$(awk '
  /^  pull_request:$/ { active = 1; next }
  /^  push:$/ { active = 0 }
  active && /^      - "/ { line = $0; sub(/^      - "/, "", line); sub(/"$/, "", line); print line }
' "$WORKFLOW")"
push_paths="$(awk '
  /^  push:$/ { active = 1; next }
  /^  workflow_dispatch:$/ { active = 0 }
  active && /^      - "/ { line = $0; sub(/^      - "/, "", line); sub(/"$/, "", line); print line }
' "$WORKFLOW")"
[ "$pull_paths" = "$push_paths" ] ||
  fail "Homebrew main-shell pull_request and push path filters must stay aligned"

for required_path in \
  ".github/actions/fetch-submodules/**" \
  ".github/actions/setup-nix/**" \
  ".gitmodules" \
  "MANIFEST" \
  "apps/browser-demos/**" \
  "crates/shared/**" \
  "homebrew/main-shell*" \
  "host/src/**" \
  "host/test/**" \
  "images/rootfs/**" \
  "images/vfs/scripts/build-homebrew-materialized-vfs-image.ts" \
  "images/vfs/scripts/build-shell-vfs-image.ts" \
  "images/vfs/scripts/main-shell-demo-config.ts" \
  "images/vfs/scripts/vfs-image-helpers.ts" \
  "libc/**" \
  "packages/registry/**" \
  "sdk/**" \
  "scripts/build-musl.sh" \
  "scripts/dev-shell.sh" \
  "scripts/browser-binary-package-roots.mjs" \
  "scripts/create-homebrew-bottle-mirror-publish-manifest.ts" \
  "scripts/fetch-binaries.sh" \
  "scripts/homebrew-brewfile-selection.rb" \
  "scripts/homebrew-language-runtime-contract.ts" \
  "scripts/homebrew-main-shell-image-contract*.ts" \
  "scripts/install-local-binary.sh" \
  "scripts/install-overlay-headers.sh" \
  "scripts/resolve-binary.sh" \
  "scripts/resolve-binary.ts" \
  "scripts/resolve-binary.bundle.mjs" \
  "scripts/resolve-binary.bundle.LICENSES.txt" \
  "scripts/build-resolve-binary-bundle.sh" \
  "scripts/test-resolve-binary-bundle.sh" \
  "scripts/recover-homebrew-bottle-mirror.ts" \
  "scripts/run-wasm-fork-instrument.sh" \
  "scripts/verify-homebrew-main-shell-artifact-lock.sh" \
  "tests/package-system/browser-binary-dependencies.test.ts" \
  "tests/package-system/homebrew-bottle-mirror-recovery.test.ts" \
  "tools/mkrootfs/**" \
  "tools/xtask/**" \
  "web-libs/kandelo-session/**"
do
  grep -Fxq "$required_path" <<<"$pull_paths" ||
    fail "Homebrew main-shell workflow does not watch authoritative input $required_path"
done

setup_node_line="$(grep -n 'uses: actions/setup-node@' "$WORKFLOW" | cut -d: -f1)"
checker_line="$(grep -n 'node scripts/check-homebrew-main-shell-brewfile.mjs' "$WORKFLOW" | cut -d: -f1)"
[ -n "$setup_node_line" ] && [ -n "$checker_line" ] &&
  [ "$setup_node_line" -lt "$checker_line" ] ||
  fail "pinned Node setup must precede the main-shell contract checker"

generation_block="$(sed -n \
  '/- name: Select one verified package generation/,/- name: Resolve current direct browser bundling inputs/p' \
  "$WORKFLOW")"
grep -Fq 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}' <<<"$generation_block" ||
  fail "package-generation validation needs only the workflow's read token"
grep -Fq 'staging-reuse expected \' <<<"$generation_block" &&
  grep -Fq 'validate-staging-release.sh \' <<<"$generation_block" &&
  grep -Fq -- '--mode current \' <<<"$generation_block" ||
  fail "main-shell CI must accept only a complete current PR package generation"
grep -Fq 'index-candidate seed \' <<<"$generation_block" &&
  grep -Fq 'selected_url="file://${frozen_index}"' <<<"$generation_block" ||
  fail "main-shell CI must freeze the validated mutable staging index locally"
grep -Fq 'env -u GH_TOKEN -u GITHUB_TOKEN \' <<<"$generation_block" &&
  grep -Fq -- '-u HOMEBREW_GITHUB_PACKAGES_TOKEN \' <<<"$generation_block" ||
  fail "local index freezing must run without GitHub credentials"
grep -Fq 'selected_url="$canonical_url"' <<<"$generation_block" ||
  fail "main-shell CI must retain the canonical/source-build fallback"
grep -Fq 'echo "WASM_POSIX_BINARY_INDEX_URL=$selected_url" >> "$GITHUB_ENV"' \
  <<<"$generation_block" ||
  fail "main-shell CI must pass the selected generation through the resolver contract"
grep -Fq 'GH_TOKEN:' <<<"$(sed -n \
  '/- name: Resolve current direct browser bundling inputs/,/- name: Build the exact lazy shell from public bottles/p' \
  "$WORKFLOW")" &&
  fail "browser package resolution must not retain the staging-validation token"

grep -Fq '(.selection.requested_packages | length) == $expected_root_count' "$BUILDER" ||
  fail "$BUILDER does not bind the requested-root count to the migration lock"
grep -Fq '(.packages | length) == $expected_closure_count' "$BUILDER" ||
  fail "$BUILDER does not bind the Formula count to the migration lock"
grep -Fq 'MATERIALIZED_CANDIDATE' "$BUILDER" &&
  fail "$BUILDER still references the retired materialized-candidate mode"
grep -Fq '[.packages[].full_name] | sort' "$BUILDER" ||
  fail "$BUILDER does not compare exact Formula composition identities"
grep -Fq 'formula_closure | sort' "$BUILDER" ||
  fail "$BUILDER does not bind composition identities to the migration lock"
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
grep -Fq 'scripts/homebrew-checkout-public-tap.sh' "$WORKFLOW" &&
  fail "candidate proof must use its one explicit exact tap checkout"
grep -Fq 'bash packages/registry/shell/build-shell.sh' "$WORKFLOW" &&
  fail "candidate proof must not invoke the canonical shell package wrapper"
grep -Fq 'compute-cache-key-sha \' "$WORKFLOW" &&
  fail "candidate proof must not compute or activate a canonical package identity"
grep -Fq 'archive-stage \' "$WORKFLOW" &&
  fail "candidate proof must not publish or stage the canonical shell package"
grep -Fq 'git -C "$tap_root" fetch --depth=1 origin "$tap_sha"' "$WORKFLOW" ||
  fail "candidate proof must fetch the exact reviewed tap commit"
grep -Fq 'test "$(git -C "$tap_root" rev-parse HEAD)" = "$tap_sha"' "$WORKFLOW" ||
  fail "candidate proof must verify the exact checked-out tap commit"
grep -Fq -- '--lazy-shell \' "$WORKFLOW" ||
  fail "candidate proof must explicitly opt into lazy shell composition"
grep -Fq 'scripts/build-homebrew-main-shell-closure.sh \' "$WORKFLOW" ||
  fail "candidate proof must invoke the strict shell composer"
[ "$(grep -Fc -- '--materialize-package-tree \' "$WORKFLOW")" -eq 1 ] ||
  fail "candidate proof must build exactly one source-materialized derivative"
[ "$(grep -Fc -- '--package-tree-spec homebrew/main-shell-brew-package-tree.json' \
  "$WORKFLOW")" -eq 2 ] ||
  fail "lazy and eager candidate builds must use the same package-tree recipe"
[ "$(grep -Fc -- '--package-tree-archive "$bootstrap"' "$WORKFLOW")" -eq 2 ] ||
  fail "lazy and eager candidate builds must use the same package output bytes"
grep -Fq 'del(.state)' "$WORKFLOW" ||
  fail "candidate proof must compare lazy and eager package-tree identity"
candidate_install_workflow_block="$(sed -n \
  "/- name: Install the candidate's exact shell bytes/,/- name: Recover the exact bottle mirror/p" \
  "$WORKFLOW")"
grep -Fq 'WASM_POSIX_LOCAL_INSTALL_SOURCE="$1"' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must give the exact candidate to the package installer"
grep -Fq 'WASM_POSIX_LOCAL_INSTALL_SESSION="$2"' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must give the package installer an explicit session"
grep -Fq 'bash "$CANDIDATE_PATH" "$install_session"' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate and session must be passed into the installer shell as isolated arguments"
grep -Fq '${GITHUB_RUN_ID}' <<<"$candidate_install_workflow_block" &&
  grep -Fq '${GITHUB_RUN_ATTEMPT}' <<<"$candidate_install_workflow_block" &&
  grep -Fq '${GITHUB_JOB}' <<<"$candidate_install_workflow_block" ||
  fail "candidate package-install session must be unique to one workflow job attempt"
grep -Fq 'build-deps --arch wasm32 --binaries-dir local-binaries \' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must publish through the wasm32 local package installer"
grep -Fq 'install-local-artifact shell shell.vfs.zst' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must install shell.vfs.zst as a declared shell artifact"
grep -Fq 'resolved=$(bash scripts/resolve-binary.sh programs/shell.vfs.zst)' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must resolve the canonical installed shell artifact"
grep -Fq 'cmp "$CANDIDATE_PATH" "$resolved"' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must compare the canonical installed artifact with the candidate"
grep -Fq 'cp "$CANDIDATE_PATH" "$browser_copy"' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate proof must retain a separate browser-public copy"
[ "$(grep -Fc 'local-binaries' <<<"$candidate_install_workflow_block")" -eq 1 ] ||
  fail "candidate proof must access local-binaries only through the package installer"
grep -Eq '(^|[[:space:]])(cp|mv|install|ln)[[:space:]].*(local-binaries|\$installed)' \
  <<<"$candidate_install_workflow_block" &&
  fail "candidate proof must not write or copy directly into local-binaries"
grep -Fq -- '--image "${{ steps.candidate.outputs.image }}"' "$WORKFLOW" ||
  fail "Node proof must boot the exact candidate bytes directly"
grep -Fq -- '--migration-lock homebrew/main-shell-migration-lock.json' "$WORKFLOW" ||
  fail "post-archive Node proof must validate against the reviewed migration lock"
grep -Fq -- '--homebrew-bootstrap-spec homebrew/main-shell-brew-package-tree.json' \
  "$WORKFLOW" ||
  fail "Node proof must derive the exact Homebrew package tree"
grep -Fq -- '--homebrew-bootstrap-archive "${{ steps.candidate.outputs.bootstrap }}"' \
  "$WORKFLOW" ||
  fail "Node proof must bind the exact standalone Homebrew package bytes"
grep -Fq -- '--homebrew-bootstrap-state "$state"' "$WORKFLOW" ||
  fail "Node proof must assert lazy versus eager source state"
grep -Fq -- '--demo-config homebrew/main-shell-demo.json' "$WORKFLOW" ||
  fail "post-archive Node proof must validate the canonical demo config bytes"
node_smoke_workflow_block="$(sed -n \
  '/- name: Boot the exact installed bytes in Node/,/- name: Boot the current main-shell path in Chromium/p' \
  "$WORKFLOW")"
grep -Fq 'node_smoke_args=(' <<<"$node_smoke_workflow_block" ||
  fail "Node proof must build one explicit transport-aware argument vector"
grep -Fq 'run_node_smoke "${{ steps.candidate.outputs.image }}" deferred' \
  <<<"$node_smoke_workflow_block" ||
  fail "Node proof must boot the deferred shell candidate"
grep -Fq 'run_node_smoke "${{ steps.candidate.outputs.eager_image }}" materialized' \
  <<<"$node_smoke_workflow_block" ||
  fail "Node proof must boot the source-materialized derivative"
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
grep -Fq '${{ steps.candidate.outputs.image }}' "$WORKFLOW" ||
  fail "main-shell evidence must retain the exact candidate image"
grep -Fq '${{ steps.candidate.outputs.report }}' "$WORKFLOW" ||
  fail "main-shell evidence must retain the candidate composition report"
for evidence in \
  '${{ steps.candidate.outputs.bootstrap }}' \
  '${{ steps.candidate.outputs.eager_image }}' \
  '${{ steps.candidate.outputs.eager_report }}'
do
  grep -Fq "$evidence" "$WORKFLOW" ||
    fail "main-shell evidence must retain $evidence"
done
grep -Fq 'apps/browser-demos/test-results' "$WORKFLOW" ||
  fail "main-shell evidence must retain browser failure traces"
grep -Fq '${{ runner.temp }}/homebrew-main-shell-modeset-playwright.json' \
  "$WORKFLOW" ||
  fail "main-shell evidence must retain the isolated MODESET report"
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
  grep -Fq -- '--grep "rejects a guest lifecycle fixture"' \
    <<<"$guest_lifecycle_browser_invocation" ||
  fail "offline guest-lifecycle rejection must run in its own browser process"
shell_browser_invocation="$(
  browser_invocation_for "test/kandelo-homebrew-main-shell.spec.ts"
)"
grep -Fq 'bash ../../scripts/dev-shell.sh env \' \
  <<<"$shell_browser_invocation" &&
  grep -Fq '"PLAYWRIGHT_JSON_OUTPUT_FILE=$shell_report" \' \
    <<<"$shell_browser_invocation" &&
  grep -Fq -- '--project=chromium --reporter=json' \
    <<<"$shell_browser_invocation" ||
  fail "shell acceptance must run in its own reporting browser process"
modeset_browser_invocation="$(
  browser_invocation_for "test/kandelo-modeset.spec.ts"
)"
grep -Fq 'bash ../../scripts/dev-shell.sh env \' \
  <<<"$modeset_browser_invocation" &&
  grep -Fq '"PLAYWRIGHT_JSON_OUTPUT_FILE=$modeset_report" \' \
    <<<"$modeset_browser_invocation" &&
  grep -Fq -- '--project=chromium --reporter=json' \
    <<<"$modeset_browser_invocation" ||
  fail "MODESET acceptance must run in its own reporting browser process"
grep -Fq '"PLAYWRIGHT_JSON_OUTPUT_FILE=$shell_report"' "$WORKFLOW" ||
  fail "shell acceptance must have Playwright write JSON directly to its report file"
grep -Fq '"PLAYWRIGHT_JSON_OUTPUT_FILE=$modeset_report"' "$WORKFLOW" ||
  fail "MODESET acceptance must have Playwright write JSON directly to its report file"
grep -Fq 'npx playwright test test/kandelo-homebrew-main-shell.spec.ts \' "$WORKFLOW" ||
  fail "browser acceptance must run the exact Homebrew shell proof"
grep -Fq 'npx playwright test test/kandelo-modeset.spec.ts \' "$WORKFLOW" ||
  fail "browser acceptance must preserve MODESET in a fresh process"
[ "$(grep -Fc '.stats.expected == 2 and .stats.unexpected == 0 and' "$WORKFLOW")" -eq 1 ] ||
  fail "shell acceptance must require both pristine-machine browser proofs"
grep -Fq "' \"\$shell_report\" >/dev/null" "$WORKFLOW" ||
  fail "shell acceptance must validate its exact two-test report"
[ "$(grep -Fc '.stats.expected == 1 and .stats.unexpected == 0 and' "$WORKFLOW")" -eq 1 ] ||
  fail "MODESET acceptance must remain one browser proof"
grep -Fq "' \"\$modeset_report\" >/dev/null" "$WORKFLOW" ||
  fail "MODESET acceptance must validate its isolated report"
grep -Fq 'page.goto("/?demo=modeset"' "$BROWSER_SMOKE" &&
  fail "Homebrew shell acceptance must not start a second VFS in its browser process"
grep -Fq 'gotoOrSkip(page, "/?demo=modeset")' "$MODESET_SMOKE" ||
  fail "isolated MODESET acceptance must boot the MODESET demo"
grep -Fq -- '--project=chromium --reporter=json >"$report"' "$WORKFLOW" &&
  fail "browser acceptance must not mix dev-shell stdout into the Playwright JSON report"
grep -Fq "jq -r '.packages[].registry.name' homebrew/main-shell-migration-lock.json" "$WORKFLOW" &&
  fail "main-shell workflow must not prefetch the legacy package-registry closure"
grep -Fq 'fetch_args+=(--package "$package")' "$WORKFLOW" ||
  fail "browser bundling input fetch must pass exact positive package selections"
grep -Fq 'scripts/fetch-binaries.sh "${fetch_args[@]}"' "$WORKFLOW" ||
  fail "binary fetch must materialize only direct browser bundling inputs"
browser_fetch_block="$(sed -n \
  '/- name: Resolve current direct browser bundling inputs/,/- name: Build the exact lazy shell from public bottles/p' \
  "$WORKFLOW")"
grep -Fq 'fetch_args=()' <<<"$browser_fetch_block" ||
  fail "browser support inputs must use the normal current-recipe resolver path"
grep -Fq 'fetch_args=(--fetch-only)' <<<"$browser_fetch_block" &&
  fail "browser support inputs must source-build when the current recipe is newer than the public archive"
grep -Fq 'WASM_POSIX_FETCH_SKIP_PKGS:' "$WORKFLOW" &&
  fail "main-shell proof must not use a negative package skip list"
grep -Fq 'node scripts/browser-binary-package-roots.mjs \' "$WORKFLOW" ||
  fail "main-shell workflow must derive browser package roots from source imports"
grep -Fq -- '--exclude-package shell \' "$WORKFLOW" ||
  fail "browser package derivation must reserve shell for the exact bottle archive"
grep -Fq -- '--include-package rootfs \' "$WORKFLOW" ||
  fail "browser package derivation must include the non-@binaries rootfs alias"
grep -Fq 'mapfile -t browser_input_packages < "$browser_package_file"' "$WORKFLOW" ||
  fail "main-shell workflow must consume the derived browser package roots"
grep -Fq 'browser_input_packages=(' "$WORKFLOW" &&
  fail "main-shell workflow must not hand-maintain a partial browser package list"

for package_workflow in \
  "$STAGING_WORKFLOW" \
  "$PREPARE_MERGE_WORKFLOW" \
  "$FORCE_REBUILD_WORKFLOW"
do
  [ "$(grep -Fc 'npm --prefix tools/mkrootfs ci --no-audit --no-fund' "$package_workflow")" -eq 1 ] ||
    fail "$package_workflow must install mkrootfs exactly once for the shell program wave"
  grep -Fq "if: \${{ matrix.package == 'shell' }}" "$package_workflow" ||
    fail "$package_workflow must limit the mkrootfs prerequisite to the shell package"
  install_line="$(grep -nF 'npm --prefix tools/mkrootfs ci --no-audit --no-fund' "$package_workflow" | cut -d: -f1)"
  if [ "$package_workflow" = "$FORCE_REBUILD_WORKFLOW" ]; then
    build_line="$(grep -nF '              archive-stage \' "$package_workflow" | tail -1 | cut -d: -f1)"
  else
    build_line="$(grep -nF 'uses: ./.github/actions/package-archive-build' "$package_workflow" | tail -1 | cut -d: -f1)"
  fi
  [ -n "$install_line" ] && [ -n "$build_line" ] && [ "$install_line" -lt "$build_line" ] ||
    fail "$package_workflow must install mkrootfs before the shell archive build"
done

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

grep -Fq 'name = "homebrew_tap_core"' "$SHELL_BUILD_TOML" ||
  fail "shell build.toml must declare the canonical tap Git input"
grep -Fq 'repository = "https://github.com/Kandelo-dev/homebrew-tap-core.git"' \
  "$SHELL_BUILD_TOML" ||
  fail "shell Git input must use the public canonical tap repository"
locked_tap_sha="$(jq -er '.catalog.tap_commit' "$SOURCE_LOCK")"
grep -Fq "commit = \"$locked_tap_sha\"" "$SHELL_BUILD_TOML" ||
  fail "shell Git input commit must equal the reviewed migration lock"
grep -Eq '^revision[[:space:]]*=[[:space:]]*19$' "$SHELL_BUILD_TOML" ||
  fail "brew-enabled lazy shell must publish canonical shell revision 19"
for shell_input in \
  homebrew/main-shell-demo.json \
  web-libs/kandelo-session/src/demo-config.ts
do
  grep -Fq "\"$shell_input\"" "$SHELL_BUILD_TOML" ||
    fail "shell build cache inputs omit $shell_input"
done
for materialized_shell_input in \
  homebrew/main-shell-lazy-artifact-lock.json \
  homebrew/main-shell-materialization-policy.json \
  images/vfs/scripts/build-homebrew-materialized-vfs-image.ts \
  host/src/homebrew-bottle-mirror-plan.ts \
  host/src/homebrew-runtime-layer-consumer.ts \
  host/src/homebrew-vfs-composer.ts \
  host/src/homebrew-vfs-materialization-policy.ts \
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
  grep -Fq "$generic_input" "$SHELL_BUILDER" ||
    fail "shell builder must consume generic resolver input $generic_input"
done
grep -Fq 'KANDELO_HOMEBREW_MAIN_SHELL_TAP_' "$SHELL_BUILDER" &&
  fail "shell builder must not retain the workflow-only tap injection path"
[ "$(grep -Fc -- '--lazy-shell' "$SHELL_BUILDER")" -eq 1 ] ||
  fail "canonical package wrapper must activate lazy composition exactly once"
grep -Fq 'build-shell-vfs-image.sh' "$SHELL_BUILDER" &&
  fail "shell builder must not retain the legacy registry-composition fallback"
for isolated_flag in \
  '--work-dir "$WORK_DIR"' \
  '--report "$REPORT"' \
  '--bottle-cache "$BOTTLE_CACHE"' \
  '--package-tree-spec "$REPO_ROOT/homebrew/main-shell-brew-package-tree.json"' \
  '--package-tree-archive "$HOMEBREW_BOOTSTRAP"'
do
  grep -Fq -- "$isolated_flag" "$SHELL_BUILDER" ||
    fail "shell builder must pass isolated composer option $isolated_flag"
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
  .mount_prefix == "/home/linuxbrew/.linuxbrew" and
  .owner == { uid: 1000, gid: 1000 } and
  .activation == {
    mode: "first-use",
    capabilities: ["homebrew:bootstrap"],
    roots: ["/home/linuxbrew/.linuxbrew/bin/brew"]
  }
' "$PACKAGE_TREE_SPEC" >/dev/null ||
  fail "Homebrew package-tree spec is not the exact reviewed contract"
grep -Fq 'depends_on = ["homebrew-bootstrap@6.0.3-4-g4ead861"]' \
  "$SHELL_PACKAGE_TOML" ||
  fail "shell package must depend on the exact standalone Homebrew source package"
[ "$(grep -Fc '[[outputs]]' "$SHELL_PACKAGE_TOML")" -eq 1 ] ||
  fail "shell package must publish only its VFS image"
grep -Fq 'name = "homebrew-bootstrap"' "$HOMEBREW_BOOTSTRAP_PACKAGE_TOML" ||
  fail "standalone Homebrew source package is missing"
grep -Fq 'wasm = "homebrew-bootstrap.zip"' "$HOMEBREW_BOOTSTRAP_PACKAGE_TOML" ||
  fail "standalone Homebrew source package omits its exact ZIP output"
grep -Fq '"homebrew/main-shell-brew-package-tree.json"' "$SHELL_BUILD_TOML" ||
  fail "shell build identity omits the package-tree recipe"
grep -Fq \
  'import homebrewBootstrapZipUrl from "@binaries/programs/homebrew-bootstrap/homebrew-bootstrap.zip?url";' \
  "$LAZY_ARCHIVE_RESOLVER" ||
  fail "browser shell does not resolve the standalone Homebrew package output"
grep -Fq '"homebrew-bootstrap.zip": homebrewBootstrapZipUrl' \
  "$LAZY_ARCHIVE_RESOLVER" ||
  fail "browser shell does not bind the descriptor-relative Homebrew asset"

shell_build_function="$TMP_ROOT/build-shell-vfs-function.sh"
sed -n '/^build_shell_vfs()/,/^}/p' "$RUN_SH" >"$shell_build_function"
grep -Fq 'resolve_args+=(resolve shell)' "$shell_build_function" ||
  fail "run.sh must resolve the shell package through the package system"
grep -Fq 'need_shell_vfs_build_tools' "$shell_build_function" ||
  fail "run.sh must prepare lockfile-owned tools before shell source fallback"
grep -Fq 'if [ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ]; then' \
  "$shell_build_function" ||
  fail "run.sh must distinguish an explicit fetch-only resolve from normal fallback"
grep -Fq 'resolve_args+=("${FETCH_ONLY_ARGS[@]}")' \
  "$shell_build_function" ||
  fail "run.sh must forward the caller's fetch-only contract to the shell resolver"
fetch_condition_line="$(grep -nF 'if [ "${#FETCH_ONLY_ARGS[@]}" -gt 0 ]; then' \
  "$shell_build_function" | cut -d: -f1)"
fetch_forward_line="$(grep -nF 'resolve_args+=("${FETCH_ONLY_ARGS[@]}")' \
  "$shell_build_function" | cut -d: -f1)"
fallback_else_line="$(grep -nE '^    else$' "$shell_build_function" | cut -d: -f1)"
fallback_tools_line="$(grep -nF '        need_shell_vfs_build_tools' \
  "$shell_build_function" | cut -d: -f1)"
fallback_fi_line="$(awk -v start="$fallback_tools_line" \
  'NR > start && /^    fi$/ { print NR; exit }' "$shell_build_function")"
[ "$fetch_condition_line" -lt "$fetch_forward_line" ] &&
  [ "$fetch_forward_line" -lt "$fallback_else_line" ] &&
  [ "$fallback_else_line" -lt "$fallback_tools_line" ] &&
  [ "$fallback_tools_line" -lt "$fallback_fi_line" ] ||
  fail "run.sh must skip composer tools only on the fetch-only branch"
shell_tools_function="$TMP_ROOT/need-shell-vfs-build-tools-function.sh"
sed -n '/^need_shell_vfs_build_tools()/,/^}/p' "$RUN_SH" >"$shell_tools_function"
grep -Fq 'npm ci --no-audit --no-fund --prefer-offline' \
  "$shell_tools_function" ||
  fail "run.sh must install root shell-composer dependencies from the lockfile"
grep -Fq 'npm --prefix "$REPO_ROOT/tools/mkrootfs" ci' \
  "$shell_tools_function" ||
  fail "run.sh must install mkrootfs dependencies from the lockfile"
grep -Eq '(^|[[:space:]])if[[:space:]]' "$shell_tools_function" &&
  fail "shell source fallback must not accept dependency presence as lockfile identity"
grep -Fq -- '--binaries-dir "$REPO_ROOT/local-binaries"' "$RUN_SH" ||
  fail "run.sh must materialize the resolved shell package for local consumers"
grep -Fq 'pkg_has_output shell shell.vfs.zst' "$RUN_SH" ||
  fail "run.sh must validate the shell package's declared output"
has_shell_vfs_function="$TMP_ROOT/has-shell-vfs-function.sh"
sed -n '/^has_shell_vfs()/,/^}/p' "$RUN_SH" >"$has_shell_vfs_function"
grep -Fq 'pkg_has_output homebrew-bootstrap homebrew-bootstrap.zip' \
  "$has_shell_vfs_function" ||
  fail "shell availability must include its lazily served Homebrew package"
grep -Fq "Package resolver did not materialize shell's Homebrew source dependency" \
  "$shell_build_function" ||
  fail "shell resolution must verify its Homebrew package dependency"
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
  npx tsx --test "$IMAGE_CONTRACT_TEST"
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
[[ "$composer" == */scripts/build-homebrew-main-shell-closure.sh ]]
for token in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN; do
  if [ "${!token+x}" = x ]; then
    echo "credential leaked to composer: $token" >&2
    exit 80
  fi
done
[ "${SOURCE_DATE_EPOCH:-}" = 0 ] || {
  echo "canonical shell wrapper did not pin SOURCE_DATE_EPOCH=0" >&2
  exit 79
}
work="" report="" cache="" out="" spec="" archive="" bootstrap_env="" lazy_shell=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lazy-shell) lazy_shell=true; shift ;;
    --work-dir) work="$2"; shift 2 ;;
    --report) report="$2"; shift 2 ;;
    --bottle-cache) cache="$2"; shift 2 ;;
    --package-tree-spec) spec="$2"; shift 2 ;;
    --package-tree-archive) archive="$2"; shift 2 ;;
    --homebrew-bootstrap-env) bootstrap_env="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --tap-root|--expected-tap-sha) shift 2 ;;
    *) echo "unexpected fake-composer option: $1" >&2; exit 81 ;;
  esac
done
[ -n "$work" ] && [ -n "$report" ] && [ -n "$cache" ] && [ -n "$out" ] &&
  [ "$spec" = "$PACKAGE_TREE_SPEC" ] &&
  [ "$archive" = "$WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR/homebrew-bootstrap.zip" ] &&
  [ "$bootstrap_env" = "$WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR/homebrew-brew.env" ]
[ "$lazy_shell" = true ]
[ ! -e "$work" ] && [ ! -L "$work" ]
mkdir "$work"
mkdir "$cache"
printf '%s\n' "$WASM_POSIX_DEP_OUT_DIR" >"$out"
printf '{}\n' >"$report"
printf '%s|%s|%s|%s|%s|%s|%s\n' \
  "$WASM_POSIX_DEP_OUT_DIR" "$work" "$report" "$cache" "$out" "$archive" \
  "$bootstrap_env" \
  >>"$FAKE_COMPOSER_LOG"
FAKE_COMPOSER
chmod 0755 "$apply_fake_composer"

tap_sha=1111111111111111111111111111111111111111
bootstrap_dir="$TMP_ROOT/homebrew-bootstrap-dependency"
mkdir "$bootstrap_dir"
printf '%s\n' 'exact standalone Homebrew package bytes' > \
  "$bootstrap_dir/homebrew-bootstrap.zip"
printf '%s\n' \
  'HOMEBREW_NO_ANALYTICS=1' \
  'HOMEBREW_NO_AUTO_UPDATE=1' \
  'HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1' \
  'HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo' \
  >"$bootstrap_dir/homebrew-brew.env"
parallel_one="$TMP_ROOT/parallel-shell-one"
parallel_two="$TMP_ROOT/parallel-shell-two"
mkdir "$parallel_one" "$parallel_two"
run_fake_shell_build() {
  local out_dir="$1"
  env \
    PATH="$fake_bin:$PATH" \
    FAKE_COMPOSER_LOG="$fake_log" \
    PACKAGE_TREE_SPEC="$PACKAGE_TREE_SPEC" \
    GH_TOKEN=forbidden \
    GITHUB_TOKEN=forbidden \
    HOMEBREW_GITHUB_API_TOKEN=forbidden \
    HOMEBREW_GITHUB_PACKAGES_TOKEN=forbidden \
    HOMEBREW_DOCKER_REGISTRY_TOKEN=forbidden \
    WASM_POSIX_DEP_OUT_DIR="$out_dir" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_DIR="$TMP_ROOT/fake-tap" \
    WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_COMMIT="$tap_sha" \
    WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR="$bootstrap_dir" \
    /bin/bash "$SHELL_BUILDER"
}
run_fake_shell_build "$parallel_one" &
parallel_one_pid=$!
run_fake_shell_build "$parallel_two" &
parallel_two_pid=$!
wait "$parallel_one_pid" || fail "first concurrent shell wrapper failed"
wait "$parallel_two_pid" || fail "second concurrent shell wrapper failed"

[ "$(wc -l <"$fake_log" | tr -d '[:space:]')" -eq 2 ] ||
  fail "concurrent shell wrappers did not produce two composer records"
for out_dir in "$parallel_one" "$parallel_two"; do
  [ -f "$out_dir/shell.vfs.zst" ] || fail "shell wrapper omitted final VFS in $out_dir"
  [ "$(find "$out_dir" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d '[:space:]')" -eq 1 ] ||
    fail "shell wrapper leaked scratch outputs into $out_dir"
  [ ! -e "$out_dir/.homebrew-shell-build" ] ||
    fail "shell wrapper did not clean resolver-owned scratch in $out_dir"
  grep -Fq "$out_dir|$out_dir/.homebrew-shell-build/work|" "$fake_log" ||
    fail "composer did not receive the exclusive workspace below $out_dir"
done
[ "$(cut -d'|' -f2 "$fake_log" | sort -u | wc -l | tr -d '[:space:]')" -eq 2 ] ||
  fail "concurrent shell wrappers shared one composer workspace"
grep -Fq "$REPO_ROOT/target/homebrew-main-shell" "$fake_log" &&
  fail "composer reused the repository-global Homebrew target workspace"

expect_failure "requires build.toml git input homebrew_tap_core" \
  env WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/missing-git-input" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
  bash "$SHELL_BUILDER"

expect_failure "requires its declared homebrew-bootstrap dependency" \
  env WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/missing-bootstrap-input" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_DIR="$TMP_ROOT/fake-tap" \
    WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_COMMIT="$tap_sha" \
  bash "$SHELL_BUILDER"

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

printf '%s\n' "untracked" >"$tap/untracked-file"
expect_failure "exact tap checkout is dirty" \
  "$BUILDER" --tap-root "$tap" --work-dir "$TMP_ROOT/work-dirty-tap" \
  --migration-lock "$lock"
rm "$tap/untracked-file"

tap_worktree="$TMP_ROOT/tap-worktree"
git -C "$tap" worktree add --detach "$tap_worktree" "$tap_sha" >/dev/null
[ -f "$tap_worktree/.git" ] ||
  fail "linked tap fixture does not exercise a .git worktree file"
wrong_epoch_lock="$TMP_ROOT/main-shell-wrong-epoch-lock.json"
jq '.source_date_epoch = 1' "$LAZY_ARTIFACT_LOCK" >"$wrong_epoch_lock"
expect_failure "lock is invalid or uses a different timestamp epoch" \
  "$BUILDER" --lazy-shell --tap-root "$tap_worktree" \
  --work-dir "$TMP_ROOT/work-wrong-lazy-epoch" --migration-lock "$lock" \
  --lazy-artifact-lock "$wrong_epoch_lock"
extra_field_lock="$TMP_ROOT/main-shell-extra-field-lock.json"
jq '.unexpected = true' "$LAZY_ARTIFACT_LOCK" >"$extra_field_lock"
expect_failure "lock is invalid or uses a different timestamp epoch" \
  "$BUILDER" --lazy-shell --tap-root "$tap_worktree" \
  --work-dir "$TMP_ROOT/work-extra-lazy-lock-field" --migration-lock "$lock" \
  --lazy-artifact-lock "$extra_field_lock"

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
  '.image.sha256 = $sha | .image.bytes = $bytes' \
  "$LAZY_ARTIFACT_LOCK" >"$fixture_lock"
bash "$LAZY_ARTIFACT_CHECKER" \
  --lock "$fixture_lock" --expected-source-date-epoch 0 \
  --artifact "$artifact_fixture" ||
  fail "artifact checker rejected the exact digest and byte count"

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
grep -Fq "$SOURCE_ROOT_COUNT reviewed migration roots and $SOURCE_CLOSURE_COUNT Formulae" \
  <<<"$baseline_output" ||
  fail "main-shell checker does not report both exact closure counts"

metadata="$TMP_ROOT/main-shell-metadata.json"
jq '
  def dependencies:
    if . == "bash" then ["ncurses"]
    elif . == "ncurses" then ["libcxx"]
    elif . == "file-formula" then ["bzip2", "libmagic", "xz", "zlib"]
    elif . == "m4" or . == "make" then ["dash"]
    elif . == "diffutils" then ["coreutils", "ed"]
    elif . == "tar" then ["dash", "gzip"]
    elif . == "curl" then ["libcurl", "openssl", "zlib"]
    elif . == "wget" then ["openssl", "zlib"]
    elif . == "git" then
      ["coreutils", "dash", "diffutils", "grep", "less", "libcurl", "openssl", "sed", "vim", "zlib"]
    elif . == "zip" then ["unzip"]
    elif . == "libmagic" then ["bzip2", "xz", "zlib"]
    elif . == "libcurl" then ["openssl", "zlib"]
    elif . == "python" or . == "ruby" then ["zlib"]
    else []
    end;
  (
    [.packages[].formula | {
      name,
      version: (if .revision == 0 then .version else "\(.version)_\(.revision)" end),
      formula_revision: .revision,
      bottle_rebuild
    }] + [
      {"name":"libcxx","version":"21.1.7_1","formula_revision":1,"bottle_rebuild":0},
      {"name":"zlib","version":"1.3.1_4","formula_revision":4,"bottle_rebuild":1},
      {"name":"libmagic","version":"5.45","formula_revision":0,"bottle_rebuild":0},
      {"name":"ed","version":"1.22.5_1","formula_revision":1,"bottle_rebuild":0},
      {"name":"openssl","version":"3.3.2_2","formula_revision":2,"bottle_rebuild":1},
      {"name":"libcurl","version":"8.11.1_1","formula_revision":1,"bottle_rebuild":2}
    ]
  ) as $formulae |
  {
    schema: 1,
    tap_repository,
    tap_name,
    packages: [$formulae[] | . as $formula | {
      name: $formula.name,
      full_name: ("kandelo-dev/tap-core/" + $formula.name),
      version: $formula.version,
      formula_revision: $formula.formula_revision,
      bottle_rebuild: $formula.bottle_rebuild,
      dependencies: [($formula.name | dependencies)[] | . as $dependency | {
        name: $dependency,
        full_name: ("kandelo-dev/tap-core/" + $dependency)
      }]
    }]
  }
' "$SOURCE_LOCK" >"$metadata"

metadata_output="$(node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$metadata")"
grep -Fq "$SOURCE_ROOT_COUNT reviewed migration roots and $SOURCE_CLOSURE_COUNT Formulae" \
  <<<"$metadata_output" ||
  fail "main-shell checker did not validate the exact synthetic tap closure"

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

jq '(.formula_closure[] | select(. == "kandelo-dev/tap-core/libmagic")) =
  "kandelo-dev/tap-core/unexpected"' "$SOURCE_LOCK" >"$lock"
expect_failure "tap metadata dependency closure does not match reviewed formula_closure" \
  node "$CHECKER" "$BREWFILE" "$lock" "$metadata"

jq '.packages |= map(select(.name != "libmagic"))' "$metadata" >"$TMP_ROOT/missing-dependency.json"
expect_failure "missing dependency of file-formula Formula libmagic" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/missing-dependency.json"

jq '(.packages[] | select(.name == "file-formula") | .dependencies) |=
  map(select(.name != "libmagic"))' "$metadata" >"$TMP_ROOT/short-closure.json"
expect_failure "resolves $((SOURCE_CLOSURE_COUNT - 1)) main-shell Formulae" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/short-closure.json"

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
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/long-closure.json"

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
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/wrong-closure.json"

jq '(.packages[] | select(.name == "libcxx") | .dependencies) =
  [{"name":"ncurses","full_name":"kandelo-dev/tap-core/ncurses"}]' \
  "$metadata" >"$TMP_ROOT/cyclic-closure.json"
expect_failure "tap metadata dependency cycle: ncurses -> libcxx -> ncurses" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/cyclic-closure.json"

jq '.packages += [.packages[0]]' "$metadata" >"$TMP_ROOT/duplicate-formula.json"
expect_failure "tap metadata contains duplicate Formula" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/duplicate-formula.json"

jq '(.packages[] | select(.name == "bash") | .dependencies[0].full_name) =
  "other/tap/ncurses"' "$metadata" >"$TMP_ROOT/cross-tap-dependency.json"
expect_failure "is not a canonical same-tap dependency" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/cross-tap-dependency.json"

jq 'del(.catalog)' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "must pin one exact catalog commit" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.catalog.tap_commit = "main"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "must pin one exact catalog commit" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.reviewed_substitutions[] | select(.kind == "formula_identity" and
  .registry == "file@5.45")) |= del(.reason)' \
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

jq '.reviewed_substitutions |= map(select(.registry != "file@5.45"))' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "missing: formula_identity:file@5.45->kandelo-dev/tap-core/file-formula@5.45" \
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

jq '.compatibility.aliases[1].targets[0] = .compatibility.aliases[0].targets[0]' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility alias target is duplicated" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq 'del(.compatibility.runtime_state)' "$SOURCE_LOCK" >"$lock"
expect_failure "main-shell migration compatibility policy is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.runtime_state[0].requires_package =
  "kandelo-dev/tap-core/not-locked"' "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility.runtime_state[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.runtime_state[1].path = .compatibility.runtime_state[0].path' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility runtime state path is duplicated" \
  node "$CHECKER" "$BREWFILE" "$lock"

echo "test-homebrew-main-shell-closure: ok"
