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
SOURCE_NODE_SMOKE="$REPO_ROOT/scripts/source-rootfs-shell-node-smoke.ts"
BROWSER_SMOKE="$REPO_ROOT/apps/browser-demos/test/kandelo-homebrew-main-shell.spec.ts"
SOURCE_BROWSER_SMOKE="$REPO_ROOT/apps/browser-demos/test/kandelo-source-rootfs-shell.spec.ts"
MODESET_SMOKE="$REPO_ROOT/apps/browser-demos/test/kandelo-modeset.spec.ts"
EAGER_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts"
MATERIALIZED_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-materialized-vfs-image.ts"
STAGING_WORKFLOW="$REPO_ROOT/.github/workflows/staging-build.yml"
PREPARE_MERGE_WORKFLOW="$REPO_ROOT/.github/workflows/prepare-merge.yml"
FORCE_REBUILD_WORKFLOW="$REPO_ROOT/.github/workflows/force-rebuild.yml"
SHELL_BUILD_TOML="$REPO_ROOT/packages/registry/shell/build.toml"
SHELL_PACKAGE_TOML="$REPO_ROOT/packages/registry/shell/package.toml"
SHELL_BUILDER="$REPO_ROOT/packages/registry/shell/build-shell.sh"
SHELL_TOOL_PREPARER="$REPO_ROOT/packages/registry/shell/prepare-build-tools.sh"
SHELL_TOOL_PREPARER_TEST="$REPO_ROOT/packages/registry/shell/test-prepare-build-tools.sh"
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
  "homebrew/source-rootfs-shell-default.json" \
  "homebrew/source-rootfs-shell-dependencies.json" \
  "host/src/**" \
  "host/test/**" \
  "images/rootfs/**" \
  "images/vfs/scripts/build-homebrew-materialized-vfs-image.ts" \
  "images/vfs/scripts/build-shell-vfs-image.ts" \
  "images/vfs/scripts/build-source-rootfs-shell-image.ts" \
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
  "scripts/source-rootfs-shell-node-smoke.ts" \
  "scripts/source-rootfs-shell-dependency-contract.mjs" \
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
  '/- name: Select one verified package generation/,/- name: Build the exact candidate kernel/p' \
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
grep -Fq 'echo "SOURCE_SHELL_BINARY_INDEX_URL=file://${empty_index}" >> "$GITHUB_ENV"' \
  <<<"$generation_block" &&
  grep -Fq 'echo "SOURCE_SHELL_BINARY_CACHE_ROOT=$source_cache" >> "$GITHUB_ENV"' \
    <<<"$generation_block" ||
  fail "source activation must publish a closure-local empty index and fresh cache"
grep -Fq 'exit 0' <<<"$generation_block" &&
  fail "source activation must still select a normal generation for unrelated browser roots"
grep -Fq 'GH_TOKEN:' <<<"$(sed -n \
  '/- name: Build the exact candidate kernel/,/- name: Install the candidate\x27s exact shell bytes/p' \
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

for variable in KANDELO_HOMEBREW_MAIN_SHELL_STRICT KANDELO_HOMEBREW_MAIN_SHELL_SHA256; do
  grep -Fq -- "--keep $variable " "$REPO_ROOT/scripts/dev-shell.sh" &&
    fail "dev shell must not globally preserve main-shell-only input $variable"
done
grep -Fq 'SHELL_ACTIVATION_MODE: source-rootfs' "$WORKFLOW" ||
  fail "required main-shell CI must select the temporary source-rootfs bridge"
grep -Fq '"KANDELO_SOURCE_ROOTFS_SHELL_STRICT=1"' "$WORKFLOW" ||
  fail "source-rootfs browser proof must be enabled only by the activation branch"
browser_smoke_workflow_block="$(sed -n \
  '/- name: Boot the current main-shell path in Chromium/,/- name: Upload acceptance evidence/p' \
  "$WORKFLOW")"
grep -Fq 'source-rootfs)' <<<"$browser_smoke_workflow_block" &&
  grep -Fq '"KANDELO_SOURCE_ROOTFS_SHELL_STRICT=1"' \
    <<<"$browser_smoke_workflow_block" ||
  fail "source-rootfs branch must pass only its explicit strict smoke selector"
grep -Fq 'bottles)' <<<"$browser_smoke_workflow_block" &&
  grep -Fq '"KANDELO_HOMEBREW_MAIN_SHELL_STRICT=1"' \
    <<<"$browser_smoke_workflow_block" &&
  grep -Fq \
    '"KANDELO_HOMEBREW_MAIN_SHELL_SHA256=$KANDELO_MAIN_SHELL_SHA256"' \
    <<<"$browser_smoke_workflow_block" ||
  fail "bottle branch must pass its strict mode and exact image digest explicitly"
grep -Fq -- '--keep KANDELO_SOURCE_ROOTFS_SHELL_STRICT ' \
  "$REPO_ROOT/scripts/dev-shell.sh" &&
  fail "dev shell must not globally preserve the source-rootfs smoke selector"

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
source_candidate_block="$(sed -n \
  '/- name: Build the exact source-rootfs activation shell/,/- name: Build the exact lazy shell from public bottles/p' \
  "$WORKFLOW")"
grep -Fq "if: env.SHELL_ACTIVATION_MODE == 'source-rootfs'" \
  <<<"$source_candidate_block" ||
  fail "source-rootfs candidate must be selected only during activation"
grep -Fq 'archive-stage \' <<<"$source_candidate_block" &&
  grep -Fq -- '--package packages/registry/shell \' <<<"$source_candidate_block" &&
  grep -Fq -- '--force-source-closure' <<<"$source_candidate_block" ||
  fail "activation CI must force-build every buildable package in the exact current shell closure"
grep -Fq -- '--cache-root "$WASM_POSIX_BINARY_CACHE_ROOT" \' \
  <<<"$source_candidate_block" ||
  fail "activation CI must isolate its complete source-built package cache"
grep -Fq 'WASM_POSIX_BINARY_INDEX_URL="$SOURCE_SHELL_BINARY_INDEX_URL" \' \
  <<<"$source_candidate_block" &&
  grep -Fq 'WASM_POSIX_BINARY_CACHE_ROOT="$SOURCE_SHELL_BINARY_CACHE_ROOT" \' \
    <<<"$source_candidate_block" ||
  fail "only the forced shell closure may use the empty source index and fresh cache"
grep -Fq -- '--binaries-dir local-binaries \' <<<"$source_candidate_block" ||
  fail "source-rootfs candidate must publish through the resolver artifact tree"
grep -Fq -- '--source-repository "https://github.com/${GITHUB_REPOSITORY}" \' \
  <<<"$source_candidate_block" &&
  grep -Fq -- '--source-commit "$GITHUB_SHA" \' \
    <<<"$source_candidate_block" ||
  fail "source-rootfs candidate must record its exact checked-out source identity"
grep -Fq 'zstd -dc -- "${archives[0]}" | tar -xOf - manifest.toml >"$manifest"' \
  <<<"$source_candidate_block" &&
  grep -Fq '[ "$archive_repository" = \' \
    <<<"$source_candidate_block" &&
  grep -Fq '"https://github.com/${GITHUB_REPOSITORY}" ]' \
    <<<"$source_candidate_block" &&
  grep -Fq '[ "$archive_commit" = "$GITHUB_SHA" ]' \
    <<<"$source_candidate_block" &&
  grep -Fq '! grep -Fq "UNPUBLISHED" "$manifest"' \
    <<<"$source_candidate_block" ||
  fail "source-rootfs candidate must verify exact provenance in its staged archive"
grep -Fq '"$xtask" archive-extract-member \' <<<"$source_candidate_block" &&
  grep -Fq -- '--archive "${archives[0]}" \' <<<"$source_candidate_block" &&
  grep -Fq -- '--member artifacts/shell.vfs.zst \' <<<"$source_candidate_block" &&
  grep -Fq -- '--out "$candidate_root/main-shell.vfs.zst"' \
    <<<"$source_candidate_block" &&
  ! grep -Fq 'resolve-binary.sh programs/shell.vfs.zst' \
    <<<"$source_candidate_block" ||
  fail "source-rootfs candidate must extract the exact staged shell archive member"
grep -Fq 'kind: "kandelo-source-rootfs-shell-activation"' \
  <<<"$source_candidate_block" ||
  fail "source-rootfs candidate must emit explicit activation evidence"
grep -Fq 'echo "local_manifest=$source_assets"' \
  <<<"$source_candidate_block" &&
  grep -Fq 'find local-binaries \( -type f -o -type l \) -print0' \
    <<<"$source_candidate_block" &&
  grep -Fq 'echo "link_manifest=$source_links"' \
    <<<"$source_candidate_block" &&
  grep -Fq 'readlink "$path"' <<<"$source_candidate_block" ||
  fail "source-rootfs candidate must record the exact local closure bytes"
grep -Fq "if: env.SHELL_ACTIVATION_MODE == 'bottles'" "$WORKFLOW" ||
  fail "strict bottle candidate must remain dormant until exact-main cutover"
grep -Fq 'git -C "$tap_root" fetch --depth=1 origin "$tap_sha"' "$WORKFLOW" ||
  fail "candidate proof must fetch the exact reviewed tap commit"
grep -Fq 'test "$(git -C "$tap_root" rev-parse HEAD)" = "$tap_sha"' "$WORKFLOW" ||
  fail "candidate proof must verify the exact checked-out tap commit"
grep -Fq -- '--lazy-shell \' "$WORKFLOW" ||
  fail "candidate proof must explicitly opt into lazy shell composition"
grep -Fq 'scripts/build-homebrew-main-shell-closure.sh \' "$WORKFLOW" ||
  fail "candidate proof must invoke the strict shell composer"
candidate_install_workflow_block="$(sed -n \
  "/- name: Install the candidate's exact shell bytes/,/- name: Recover the exact bottle mirror/p" \
  "$WORKFLOW")"
grep -Fq '${{ steps.source_candidate.outputs.image || steps.bottle_candidate.outputs.image }}' \
  <<<"$candidate_install_workflow_block" ||
  fail "candidate installer must select exactly one activation or bottle image"
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
grep -Fq -- '--image "${{ steps.image.outputs.path }}"' "$WORKFLOW" ||
  fail "Node proofs must boot the exact installed candidate bytes directly"
grep -Fq -- '--kernel local-binaries/kernel.wasm' "$WORKFLOW" ||
  fail "source-rootfs Node proof must boot the exact current candidate kernel"
grep -Fq -- '--migration-lock homebrew/main-shell-migration-lock.json' "$WORKFLOW" ||
  fail "post-archive Node proof must validate against the reviewed migration lock"
grep -Fq -- '--shell-config homebrew/source-rootfs-shell-default.json' "$WORKFLOW" ||
  fail "source-rootfs Node proof must validate the tracked shell config bytes"
grep -Fq -- '--demo-config homebrew/main-shell-demo.json' "$WORKFLOW" ||
  fail "post-archive Node proof must validate the canonical demo config bytes"
node_smoke_workflow_block="$(sed -n \
  '/- name: Boot the exact installed bytes in Node/,/- name: Boot the current main-shell path in Chromium/p' \
  "$WORKFLOW")"
grep -Fq 'node_smoke_args=(' <<<"$node_smoke_workflow_block" ||
  fail "dormant bottle Node proof must build one transport-aware argument vector"
grep -Fq 'scripts/source-rootfs-shell-node-smoke.ts \' \
  <<<"$node_smoke_workflow_block" ||
  fail "activation Node proof must execute the source-rootfs smoke"
grep -Fq 'case "$SHELL_ACTIVATION_MODE" in' <<<"$node_smoke_workflow_block" ||
  fail "Node proof must select source-rootfs or bottle semantics explicitly"
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
grep -Fq '${{ steps.image.outputs.path }}' "$WORKFLOW" ||
  fail "main-shell evidence must retain the exact selected image"
grep -Fq '${{ steps.source_candidate.outputs.report }}' "$WORKFLOW" &&
  grep -Fq '${{ steps.bottle_candidate.outputs.report }}' "$WORKFLOW" ||
  fail "main-shell evidence must retain the selected candidate report"
grep -Fq 'apps/browser-demos/test-results' "$WORKFLOW" ||
  fail "main-shell evidence must retain browser failure traces"
grep -Fq '${{ runner.temp }}/homebrew-main-shell-modeset-playwright.json' \
  "$WORKFLOW" ||
  fail "main-shell evidence must retain the isolated MODESET report"
[ "$(grep -Fc 'bash ../../scripts/dev-shell.sh env \' "$WORKFLOW")" -eq 2 ] ||
  fail "shell and MODESET proofs must run in separate isolated browser processes"
grep -Fq '"PLAYWRIGHT_JSON_OUTPUT_FILE=$shell_report"' "$WORKFLOW" ||
  fail "shell acceptance must have Playwright write JSON directly to its report file"
grep -Fq '"PLAYWRIGHT_JSON_OUTPUT_FILE=$modeset_report"' "$WORKFLOW" ||
  fail "MODESET acceptance must have Playwright write JSON directly to its report file"
grep -Fq 'shell_spec=test/kandelo-source-rootfs-shell.spec.ts' "$WORKFLOW" &&
  grep -Fq 'shell_spec=test/kandelo-homebrew-main-shell.spec.ts' "$WORKFLOW" &&
  grep -Fq 'npx playwright test "$shell_spec" \' "$WORKFLOW" ||
  fail "browser acceptance must select the exact activation or bottle shell proof"
grep -Fq 'npx playwright test test/kandelo-modeset.spec.ts \' "$WORKFLOW" ||
  fail "browser acceptance must preserve MODESET in a fresh process"
grep -Fq 'for report in "$shell_report" "$modeset_report"; do' "$WORKFLOW" ||
  fail "browser acceptance must validate both isolated Playwright reports"
grep -Fq 'page.goto("/?demo=modeset"' "$BROWSER_SMOKE" &&
  fail "Homebrew shell acceptance must not start a second VFS in its browser process"
grep -Fq 'page.goto("/?demo=modeset"' "$SOURCE_BROWSER_SMOKE" &&
  fail "source-rootfs shell acceptance must not start a second VFS in its browser process"
grep -Fq 'fs.isPathDeferred("/bin/grep")' "$SOURCE_NODE_SMOKE" ||
  fail "source-rootfs Node smoke must prove an unrelated program remains deferred"
grep -Fq 'source-rootfs-shell-node-ok:' "$SOURCE_NODE_SMOKE" ||
  fail "source-rootfs Node smoke must execute image-owned Bash"
grep -Fq 'SOURCE_ROOTFS_GREP_OK' "$SOURCE_BROWSER_SMOKE" ||
  fail "source-rootfs browser smoke must execute a retained lazy program"
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
  '/- name: Resolve current direct browser bundling inputs/,/- name: Install the candidate\x27s exact shell bytes/p' \
  "$WORKFLOW")"
grep -Fq 'fetch_args=()' <<<"$browser_fetch_block" ||
  fail "browser support inputs must use the normal current-recipe resolver path"
grep -Fq 'fetch_args=(--fetch-only)' <<<"$browser_fetch_block" &&
  fail "browser support inputs must source-build when the current recipe is newer than the public archive"
grep -Fq 'WASM_POSIX_FETCH_SKIP_PKGS:' "$WORKFLOW" &&
  fail "main-shell proof must not use a negative package skip list"
grep -Fq 'node scripts/browser-binary-package-roots.mjs \' "$WORKFLOW" ||
  fail "main-shell workflow must derive browser package roots from source imports"
grep -Fq -- '--arch wasm32 \' "$WORKFLOW" ||
  fail "browser package derivation must include architecture-scoped wasm32 roots"
grep -Fq -- '--arch wasm64 \' "$WORKFLOW" ||
  fail "browser package derivation must include architecture-scoped wasm64 roots"
grep -Fq -- '--exclude-package shell \' "$WORKFLOW" ||
  fail "browser package derivation must reserve shell for the exact candidate build"
# WHY: rootfs may be the final argument (no continuation) or move earlier in
# the command; validate the CLI token instead of enforcing YAML formatting.
grep -Eq -- '^[[:space:]]*--include-package[[:space:]]+rootfs([[:space:]]*\\)?[[:space:]]*$' \
  <<<"$browser_fetch_block" ||
  fail "browser package derivation must include the non-@binaries rootfs alias"
grep -Fq 'mapfile -t browser_input_packages < "$browser_package_file"' "$WORKFLOW" ||
  fail "main-shell workflow must consume the derived browser package roots"
grep -Fq 'browser_input_packages=(' "$WORKFLOW" &&
  fail "main-shell workflow must not hand-maintain a partial browser package list"
grep -Fq 'sha256sum --check \' <<<"$browser_fetch_block" &&
  grep -Fq '${{ steps.source_candidate.outputs.local_manifest }}' \
    <<<"$browser_fetch_block" &&
  grep -Fq '${{ steps.source_candidate.outputs.link_manifest }}' \
    <<<"$browser_fetch_block" &&
  grep -Fq 'cmp "${{ steps.source_candidate.outputs.link_manifest }}" \' \
    <<<"$browser_fetch_block" ||
  fail "unrelated browser resolution must not replace exact-source shell closure bytes"

for package_workflow in \
  "$STAGING_WORKFLOW" \
  "$PREPARE_MERGE_WORKFLOW" \
  "$FORCE_REBUILD_WORKFLOW"
do
  grep -Fq 'Install shell VFS composer dependencies' "$package_workflow" &&
    fail "$package_workflow must not own a shell-recipe prerequisite"
done

# The old preparer remains covered because the strict bottle composer will use
# it again after exact-main bottles exist. The temporary source bridge must not
# execute or cache-key that network-capable tool installation path.
bash "$SHELL_TOOL_PREPARER_TEST" ||
  fail "dormant bottle build-tool preparation tests failed"
grep -Fq 'prepare-build-tools.sh' "$SHELL_BUILDER" &&
  fail "source-rootfs shell bridge must not install composer dependencies"
grep -Fq '"packages/registry/shell/prepare-build-tools.sh"' \
  "$SHELL_BUILD_TOML" &&
  fail "source-rootfs shell cache identity must exclude dormant bottle tooling"
grep -A4 -F 'name = "node"' "$SHELL_PACKAGE_TOML" |
  grep -Fq 'version_constraint = ">=20.0"' ||
  fail "source-rootfs shell package must declare its Node host tool"
grep -Fq 'name = "npm"' "$SHELL_PACKAGE_TOML" &&
  fail "source-rootfs shell package must not declare an npm tool it never executes"
grep -Fq '# WHY: the package resolver may source-build shell' \
  "$SHELL_TOOL_PREPARER" ||
  fail "dormant bottle tool ownership boundary must retain its WHY comment"
grep -Fq 'env -i \' "$SHELL_TOOL_PREPARER" ||
  fail "dormant bottle tool installs must start from a scrubbed environment"
grep -Fq 'npm_config_registry="https://registry.npmjs.org/"' \
  "$SHELL_TOOL_PREPARER" ||
  fail "dormant bottle tool installs must pin the public npm registry"
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
  fail "source-rootfs shell bridge must not declare a tap Git input"
grep -Eq '^revision[[:space:]]*=[[:space:]]*21$' "$SHELL_BUILD_TOML" ||
  fail "source-rootfs activation bridge must publish shell revision 21"
for shell_input in \
  homebrew/source-rootfs-shell-default.json \
  homebrew/source-rootfs-shell-dependencies.json \
  homebrew/main-shell-demo.json \
  scripts/source-rootfs-shell-dependency-contract.mjs \
  images/vfs/scripts/build-source-rootfs-shell-image.ts \
  images/vfs/scripts/shell-vfs-build.ts \
  images/vfs/scripts/shell-lazy-archives.ts \
  images/vfs/lib/init/shell-binaries.ts \
  web-libs/kandelo-session/src/shell-config.ts \
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
  grep -Fq "\"$materialized_shell_input\"" "$SHELL_BUILD_TOML" &&
    fail "source-rootfs bridge cache identity includes dormant bottle input $materialized_shell_input"
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
  WASM_POSIX_DEP_ROOTFS_DIR \
  WASM_POSIX_DEP_BASH_DIR \
  WASM_POSIX_DEP_FBDOOM_DIR \
  WASM_POSIX_DEP_MODESET_DIR
do
  grep -Fq "$generic_input" "$SHELL_BUILDER" ||
    fail "shell builder must consume generic resolver input $generic_input"
done
grep -Fq 'KANDELO_HOMEBREW_MAIN_SHELL_TAP_' "$SHELL_BUILDER" &&
  fail "shell builder must not retain the workflow-only tap injection path"
grep -Fq 'WASM_POSIX_BUILD_GIT_' "$SHELL_BUILDER" &&
  fail "source-rootfs shell bridge must not consume a Git/tap input"
grep -Fq 'build-homebrew-main-shell-closure.sh' "$SHELL_BUILDER" &&
  fail "source-rootfs shell bridge must not execute the bottle composer"
grep -Fq 'build-shell-vfs-image.sh' "$SHELL_BUILDER" &&
  fail "shell builder must not retain the legacy registry-composition fallback"
grep -Fq -- '--rootfs "$ROOTFS"' "$SHELL_BUILDER" ||
  fail "source-rootfs shell wrapper must pass the exact rootfs dependency"
grep -Fq -- '--bash "$BASH"' "$SHELL_BUILDER" ||
  fail "source-rootfs shell wrapper must pass the exact eager Bash dependency"
grep -Fq -- '--fbdoom "$FBDOOM"' "$SHELL_BUILDER" ||
  fail "source-rootfs shell wrapper must pass the exact fbdoom dependency"
grep -Fq -- '--modeset "$MODESET"' "$SHELL_BUILDER" ||
  fail "source-rootfs shell wrapper must pass the exact modeset dependency"
grep -Fq 'WORK_DIR="$REPO_ROOT/target/homebrew-main-shell"' "$BUILDER" &&
  fail "Homebrew composer must not use a shared repository target workspace"
grep -Fq 'homebrew-main-shell-node-smoke.ts' "$BUILDER" &&
  fail "cached shell composition must not consume ambient runtime acceptance artifacts"
grep -Fq 'scripts/homebrew-main-shell-node-smoke.ts' "$WORKFLOW" ||
  fail "exact candidate shell bytes must retain post-build Node acceptance"
grep -Fq 'source-rootfs-shell-dependency-contract.mjs' "$SHELL_BUILDER" ||
  fail "source-rootfs shell wrapper must derive resolver inputs from the shared dependency contract"

shell_build_function="$TMP_ROOT/build-shell-vfs-function.sh"
sed -n '/^build_shell_vfs()/,/^}/p' "$RUN_SH" >"$shell_build_function"
grep -Fq 'resolve_args+=(resolve shell)' "$shell_build_function" ||
  fail "run.sh must resolve the shell package through the package system"
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
grep -Fq 'packages/registry/shell/build-shell.sh' "$RUN_SH" &&
  fail "run.sh must not bypass the resolver by invoking the shell recipe directly"
grep -Fq 'build_fbdoom' "$shell_build_function" &&
  fail "run.sh must let the resolver own the shell package's fbdoom dependency"
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

# Exercise the temporary source bridge twice at once while replacing only its
# Node process. Each invocation must receive exact resolver-owned dependency
# files, use an exclusive work directory, publish only the declared VFS, and
# remove ambient credentials/module/network configuration before composition.
fake_bin="$TMP_ROOT/fake-source-composer-bin"
fake_log="$TMP_ROOT/fake-composer.log"
mkdir -p "$fake_bin"
fake_node="$fake_bin/node"
real_node="$(command -v node)"
cat >"$fake_node" <<'FAKE_NODE'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == */scripts/source-rootfs-shell-dependency-contract.mjs ]]; then
  exec "$FAKE_REAL_NODE" "$@"
fi
tsx_cli="${1:-}"
composer="${2:-}"
shift 2
[[ "$tsx_cli" == */node_modules/tsx/dist/cli.mjs ]]
[[ "$composer" == */images/vfs/scripts/build-source-rootfs-shell-image.ts ]]
for token in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN \
  NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS NODE_PATH \
  NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
  npm_config_userconfig npm_config_globalconfig npm_config_registry \
  ALL_PROXY HTTPS_PROXY HTTP_PROXY NO_PROXY \
  all_proxy https_proxy http_proxy no_proxy; do
  if [ "${!token+x}" = x ]; then
    echo "credential leaked to composer: $token" >&2
    exit 80
  fi
done
[ "${SOURCE_DATE_EPOCH:-}" = 0 ] || {
  echo "canonical shell wrapper did not pin SOURCE_DATE_EPOCH=0" >&2
  exit 79
}
rootfs="" bash="" fbdoom="" modeset="" shell_config="" demo_config="" out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rootfs) rootfs="$2"; shift 2 ;;
    --bash) bash="$2"; shift 2 ;;
    --fbdoom) fbdoom="$2"; shift 2 ;;
    --modeset) modeset="$2"; shift 2 ;;
    --shell-config) shell_config="$2"; shift 2 ;;
    --demo-config) demo_config="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unexpected source-composer option: $1" >&2; exit 81 ;;
  esac
done
for input in "$rootfs" "$bash" "$fbdoom" "$modeset" "$shell_config" "$demo_config"; do
  [ -f "$input" ] && [ ! -L "$input" ]
done
[ "$rootfs" = "$WASM_POSIX_DEP_ROOTFS_DIR/rootfs.vfs" ]
[ "$bash" = "$WASM_POSIX_DEP_BASH_DIR/bash.wasm" ]
[ "$fbdoom" = "$WASM_POSIX_DEP_FBDOOM_DIR/fbdoom.wasm" ]
[ "$modeset" = "$WASM_POSIX_DEP_MODESET_DIR/modeset.wasm" ]
[[ "$out" == "$WASM_POSIX_DEP_WORK_DIR"/source-rootfs-shell.*/shell.vfs.zst ]]
printf '%s\n' "source-rootfs-shell" >"$out"
printf '%s|%s|%s|%s|%s|%s|%s\n' \
  "$WASM_POSIX_DEP_OUT_DIR" "$WASM_POSIX_DEP_WORK_DIR" "$out" \
  "$rootfs" "$bash" "$fbdoom" "$modeset" \
  >>"$FAKE_COMPOSER_LOG"
FAKE_NODE
chmod 0755 "$fake_node"

dependency_root="$TMP_ROOT/source-shell-dependencies"
mkdir -p \
  "$dependency_root/rootfs" \
  "$dependency_root/bash" \
  "$dependency_root/fbdoom" \
  "$dependency_root/modeset"
printf '%s\n' rootfs >"$dependency_root/rootfs/rootfs.vfs"
printf '%s\n' bash >"$dependency_root/bash/bash.wasm"
printf '%s\n' fbdoom >"$dependency_root/fbdoom/fbdoom.wasm"
printf '%s\n' modeset >"$dependency_root/modeset/modeset.wasm"
mapfile -t source_extended_dependencies < <(
  node "$REPO_ROOT/scripts/source-rootfs-shell-dependency-contract.mjs" \
    --print-resolver-owned \
    "$REPO_ROOT/homebrew/source-rootfs-shell-dependencies.json"
)
[ "${#source_extended_dependencies[@]}" -gt 0 ] ||
  fail "source dependency contract fixture produced no resolver inputs"
for dependency in "${source_extended_dependencies[@]}"; do
  mkdir -p "$dependency_root/$dependency"
done
parallel_one="$TMP_ROOT/parallel-shell-one"
parallel_two="$TMP_ROOT/parallel-shell-two"
mkdir -p \
  "$parallel_one/out" "$parallel_one/work" \
  "$parallel_two/out" "$parallel_two/work"
run_fake_shell_build() {
  local invocation_root="$1"
  local dependency
  local dependency_key
  local resolver_env=()
  for dependency in "${source_extended_dependencies[@]}"; do
    dependency_key="$(printf '%s' "$dependency" | tr '[:lower:]-' '[:upper:]_')"
    resolver_env+=(
      "WASM_POSIX_DEP_${dependency_key}_DIR=$dependency_root/$dependency"
    )
  done
  env \
    PATH="$fake_bin:$PATH" \
    KANDELO_DEV_SHELL_TOOL_PATH="$fake_bin" \
    FAKE_REAL_NODE="$real_node" \
    FAKE_COMPOSER_LOG="$fake_log" \
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
    HTTP_PROXY=https://proxy.invalid/ \
    HTTPS_PROXY=https://proxy.invalid/ \
    ALL_PROXY=https://proxy.invalid/ \
    NO_PROXY=attacker.invalid \
    WASM_POSIX_DEP_OUT_DIR="$invocation_root/out" \
    WASM_POSIX_DEP_WORK_DIR="$invocation_root/work" \
    WASM_POSIX_DEP_ROOTFS_DIR="$dependency_root/rootfs" \
    WASM_POSIX_DEP_BASH_DIR="$dependency_root/bash" \
    WASM_POSIX_DEP_FBDOOM_DIR="$dependency_root/fbdoom" \
    WASM_POSIX_DEP_MODESET_DIR="$dependency_root/modeset" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    "${resolver_env[@]}" \
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
for invocation_root in "$parallel_one" "$parallel_two"; do
  out_dir="$invocation_root/out"
  [ -f "$out_dir/shell.vfs.zst" ] || fail "shell wrapper omitted final VFS in $out_dir"
  [ "$(find "$out_dir" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d '[:space:]')" -eq 1 ] ||
    fail "shell wrapper leaked scratch outputs into $out_dir"
  [ "$(find "$invocation_root/work" -mindepth 1 -print | wc -l | tr -d '[:space:]')" -eq 0 ] ||
    fail "shell wrapper did not clean resolver-owned composition scratch"
  grep -Fq "$out_dir|$invocation_root/work|" "$fake_log" ||
    fail "composer did not receive its resolver-owned output and work roots"
done
[ "$(cut -d'|' -f3 "$fake_log" | sort -u | wc -l | tr -d '[:space:]')" -eq 2 ] ||
  fail "concurrent shell wrappers shared one composer workspace"
grep -Fq "$REPO_ROOT/target/homebrew-main-shell" "$fake_log" &&
  fail "composer reused the repository-global Homebrew target workspace"

expect_failure "WASM_POSIX_DEP_ROOTFS_DIR is required" \
  env KANDELO_DEV_SHELL_TOOL_PATH="$fake_bin" \
    WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/missing-rootfs/out" \
    WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/missing-rootfs/work" \
    WASM_POSIX_DEP_BASH_DIR="$dependency_root/bash" \
    WASM_POSIX_DEP_FBDOOM_DIR="$dependency_root/fbdoom" \
    WASM_POSIX_DEP_MODESET_DIR="$dependency_root/modeset" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
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
