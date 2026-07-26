#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="${1:-$DEFAULT_REPO_ROOT}"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
PAGES_WORKFLOW="$WORKFLOWS_DIR/browser-demos-pages.yml"

fail() {
  echo "ci-check-pages-deployment: $*" >&2
  exit 1
}

[ -d "$WORKFLOWS_DIR" ] ||
  fail "workflow directory does not exist: $WORKFLOWS_DIR"
[ -f "$PAGES_WORKFLOW" ] ||
  fail "complete Pages publisher does not exist: $PAGES_WORKFLOW"
grep -Fxq 'name: Deploy GitHub Pages' "$PAGES_WORKFLOW" ||
  fail "the single complete publisher must have an accurate workflow name"

step_block() {
  local workflow="$1"
  local step="$2"
  awk -v step="$step" '
    $0 == "      - name: " step { inside = 1 }
    inside && $0 ~ /^      - name:/ && $0 != "      - name: " step { exit }
    inside { print }
  ' "$workflow"
}

step_line() {
  local step="$1"
  grep -nF -- "- name: $step" "$PAGES_WORKFLOW" 2>/dev/null |
    head -n 1 |
    cut -d: -f1 || true
}

job_block() {
  local workflow="$1"
  local job="$2"
  awk -v job="$job" '
    $0 == "  " job ":" { inside = 1 }
    inside && $0 ~ /^  [A-Za-z0-9_.-]+:$/ &&
      $0 != "  " job ":" { exit }
    inside { print }
  ' "$workflow"
}

# Any workflow that names gh-pages can potentially become another writer.
# Keep the scan intentionally conservative so a second action or shell-based
# publisher cannot silently bypass the single-writer contract.
pages_workflows="$(
  grep -lR --include='*.yml' --include='*.yaml' 'gh-pages' "$WORKFLOWS_DIR" 2>/dev/null ||
    true
)"
pages_workflow_count="$(
  awk 'NF { count += 1 } END { print count + 0 }' <<<"$pages_workflows"
)"
[ "$pages_workflow_count" -eq 1 ] && [ "$pages_workflows" = "$PAGES_WORKFLOW" ] ||
  fail "exactly one workflow may mention or publish gh-pages"

pages_action_count="$(
  awk '/^[[:space:]]+uses: peaceiris\/actions-gh-pages@[0-9a-f]{40}/ { count += 1 }
       END { print count + 0 }' "$PAGES_WORKFLOW"
)"
[ "$pages_action_count" -eq 1 ] ||
  fail "the complete publisher must contain exactly one pinned Pages action"

grep -Fxq '  group: kandelo-gh-pages' "$PAGES_WORKFLOW" ||
  fail "the Pages publisher must use the stable deployment concurrency group"
grep -Fxq '  cancel-in-progress: true' "$PAGES_WORKFLOW" ||
  fail "new Pages runs must cancel in-progress work for superseded commits"
if grep -Fq '  cancel-in-progress: false' "$PAGES_WORKFLOW"; then
  fail "the Pages publisher must not retain superseded in-progress work"
fi
grep -Fxq '  actions: read' "$PAGES_WORKFLOW" ||
  fail "the Pages publisher needs read access to verify workflow run order"
deploy_job_block="$(job_block "$PAGES_WORKFLOW" "deploy")"
deploy_runner_count="$(
  awk '/^    runs-on:/ { count += 1 } END { print count + 0 }' \
    <<<"$deploy_job_block"
)"
[ "$deploy_runner_count" -eq 1 ] &&
  grep -Fxq '    runs-on: ubuntu-latest' <<<"$deploy_job_block" ||
  fail "the Pages publisher must use the reviewed GitHub-hosted Ubuntu runner"
if grep -Eq '^[[:space:]]+continue-on-error:' "$PAGES_WORKFLOW"; then
  fail "Pages preparation and publication must remain failure-intolerant"
fi

checkout_block="$(step_block "$PAGES_WORKFLOW" "Check out the source commit")"
grep -Eq 'uses: actions/checkout@[0-9a-f]{40}' <<<"$checkout_block" ||
  fail "the complete publisher must check out one pinned source commit"
grep -Fq 'persist-credentials: false' <<<"$checkout_block" ||
  fail "the source-building Pages checkout must not persist write credentials"
if grep -Eq '^[[:space:]]+ref:' <<<"$checkout_block"; then
  fail "the Pages checkout must use the workflow event source SHA"
fi
checkout_count="$(
  awk '/^[[:space:]]+uses: actions\/checkout@/ { count += 1 }
       END { print count + 0 }' "$PAGES_WORKFLOW"
)"
[ "$checkout_count" -eq 1 ] ||
  fail "all Pages outputs must be built from one checkout"

for required_path in \
  '.github/workflows/browser-demos-pages.yml' \
  'docs-site/**' \
  'host/src/**' \
  'host/typedoc.json' \
  'host/package.json' \
  'host/package-lock.json' \
  'host/tsconfig.json' \
  'host/tsconfig.docs.json' \
  'host/tsup.config.ts' \
  'package.json' \
  'package-lock.json' \
  'packages/registry/**' \
  'homebrew/main-shell-demo.json' \
  'homebrew/source-rootfs-shell-package/**' \
  'homebrew/source-rootfs-shell-default.json' \
  'homebrew/source-rootfs-shell-dependencies.json' \
  'scripts/browser-binary-package-roots.mjs' \
  'scripts/generate-rootfs-package-manifest.mjs' \
  'scripts/source-rootfs-shell-dependency-contract.mjs' \
  'scripts/package-build-roots.sh' \
  'scripts/check-pages-publish-size.mjs' \
  'scripts/check-pages-run-freshness.sh' \
  'scripts/ci-check-pages-deployment.sh' \
  'scripts/test-pages-deployment-contract.sh' \
  'scripts/test-pages-publish-size.sh' \
  'scripts/test-pages-run-freshness.sh'; do
  grep -Fq -- "- \"$required_path\"" "$PAGES_WORKFLOW" ||
    fail "the complete Pages publisher does not watch $required_path"
done

projection_line="$(step_line "Verify browser package projection is current")"
sysroot_line="$(step_line "Build current wasm32 sysroot for source-built browser packages")"
prepare_browser_line="$(step_line "Prepare browser demo assets")"
guide_build_line="$(step_line "Build user guide for the complete Pages tree")"
api_build_line="$(step_line "Build API docs for the complete Pages tree")"
assembly_line="$(step_line "Add documentation to the complete Pages tree")"
sealed_boot_line="$(step_line "Boot the sealed Pages shell product in Chromium")"
size_line="$(step_line "Enforce the GitHub Pages published-site size limit")"
freshness_line="$(step_line "Confirm this is the newest Pages run")"
deploy_line="$(step_line "Deploy to gh-pages")"

[ -n "$projection_line" ] && [ -n "$sysroot_line" ] &&
  [ -n "$prepare_browser_line" ] &&
  [ "$projection_line" -lt "$prepare_browser_line" ] &&
  [ "$projection_line" -lt "$sysroot_line" ] &&
  [ "$sysroot_line" -lt "$prepare_browser_line" ] &&
  [ -n "$guide_build_line" ] && [ -n "$api_build_line" ] &&
  [ -n "$assembly_line" ] && [ -n "$sealed_boot_line" ] &&
  [ -n "$size_line" ] &&
  [ -n "$freshness_line" ] && [ -n "$deploy_line" ] &&
  [ "$guide_build_line" -lt "$assembly_line" ] &&
  [ "$api_build_line" -lt "$assembly_line" ] &&
  [ "$assembly_line" -lt "$sealed_boot_line" ] &&
  [ "$sealed_boot_line" -lt "$size_line" ] &&
  [ "$size_line" -lt "$freshness_line" ] &&
  [ "$freshness_line" -lt "$deploy_line" ] ||
  fail "one job must assemble and size-check the complete tree before its freshness check and deployment"

projection_block="$(
  step_block "$PAGES_WORKFLOW" "Verify browser package projection is current"
)"
grep -Fq 'build-deps program-index-check' <<<"$projection_block" &&
  grep -Fq 'packages/registry packages/registry/program-packages.json' \
    <<<"$projection_block" ||
  fail "the Pages publisher must verify the generated package projection before preparing assets"

sysroot_block="$(
  step_block "$PAGES_WORKFLOW" "Build current wasm32 sysroot for source-built browser packages"
)"
grep -Fq 'bash scripts/dev-shell.sh bash scripts/build-musl.sh' <<<"$sysroot_block" &&
  grep -Fq 'test -f sysroot/lib/libc.a' <<<"$sysroot_block" ||
  fail "the Pages publisher must build and verify the current source-fallback sysroot"

isolation_block="$(
  step_block "$PAGES_WORKFLOW" "Isolate the exact-main source package closure"
)"
grep -Fq 'echo "WASM_POSIX_BINARY_CACHE_ROOT=$source_cache" >> "$GITHUB_ENV"' \
  <<<"$isolation_block" ||
  fail "the Pages publisher must establish one exact-main package-cache root"

prepare_browser_block="$(
  step_block "$PAGES_WORKFLOW" "Prepare browser demo assets"
)"
grep -Fq 'bash scripts/dev-shell.sh env \' <<<"$prepare_browser_block" &&
  grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    <<<"$prepare_browser_block" ||
  fail "browser preparation must retain the exact-main cache root inside dev-shell"
grep -Fq \
  '"WASM_POSIX_SOURCE_ROOTFS_SHELL_ISOLATION=pages-exact-main-v1" \' \
  <<<"$prepare_browser_block" &&
  grep -Fq \
  '"WASM_POSIX_SOURCE_ROOTFS_SHELL_RUNNER_ENVIRONMENT=${{ runner.environment }}" \' \
  <<<"$prepare_browser_block" &&
  grep -Fq \
  '"WASM_POSIX_SOURCE_ROOTFS_SHELL_REPOSITORY=https://github.com/$GITHUB_REPOSITORY" \' \
  <<<"$prepare_browser_block" &&
  grep -Fq '"WASM_POSIX_SOURCE_ROOTFS_SHELL_COMMIT=$GITHUB_SHA" \' \
    <<<"$prepare_browser_block" &&
  grep -Fxq \
    '            ./run.sh prepare-browser --source-rootfs-shell --allow-stale' \
    <<<"$prepare_browser_block" ||
  fail "browser preparation must select the source-rootfs recipe with exact event provenance"
prepare_browser_last="$(
  awk 'NF { line = $0 } END { print line }' <<<"$prepare_browser_block"
)"
[ "$prepare_browser_last" = \
    '            ./run.sh prepare-browser --source-rootfs-shell --allow-stale' ] ||
  fail "source-rootfs preparation must be the final failure-propagating command in its step"

sealed_boot_block="$(
  step_block "$PAGES_WORKFLOW" "Boot the sealed Pages shell product in Chromium"
)"
grep -Fq 'VITE_BASE: /kandelo/' <<<"$sealed_boot_block" &&
  grep -Fq 'KANDELO_PLAYWRIGHT_SERVE_DIST: "1"' <<<"$sealed_boot_block" &&
  grep -Fq 'KANDELO_TEST_BASE_URL: http://127.0.0.1:5401/kandelo/' \
    <<<"$sealed_boot_block" &&
  grep -Fq 'bash ../../scripts/dev-shell.sh env \' <<<"$sealed_boot_block" &&
  grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    <<<"$sealed_boot_block" ||
  fail "the sealed Pages preview must boot with the same /kandelo/ base as the published build"

between_freshness_and_deploy="$(
  sed -n "${freshness_line},${deploy_line}p" "$PAGES_WORKFLOW" |
    awk '/^      - name:/ { count += 1 } END { print count + 0 }'
)"
[ "$between_freshness_and_deploy" -eq 2 ] ||
  fail "the newest-run freshness check must be immediately before deployment"

grep -Fq 'cp -R docs-site/.vitepress/dist apps/browser-demos/dist/guide' "$PAGES_WORKFLOW" ||
  fail "the complete Pages tree does not include the user guide"
grep -Fq 'cp -R host/docs apps/browser-demos/dist/api' "$PAGES_WORKFLOW" ||
  fail "the complete Pages tree does not include the API docs"

size_block="$(step_block "$PAGES_WORKFLOW" "Enforce the GitHub Pages published-site size limit")"
grep -Fq 'run: node scripts/check-pages-publish-size.mjs apps/browser-demos/dist 1000000000' <<<"$size_block" ||
  fail "the complete publisher must enforce GitHub's 1,000,000,000-byte site limit"

freshness_block="$(step_block "$PAGES_WORKFLOW" "Confirm this is the newest Pages run")"
grep -Fq 'id: publish_freshness' <<<"$freshness_block" ||
  fail "the freshness step must expose a deployment decision"
grep -Fq 'GH_TOKEN: ${{ github.token }}' <<<"$freshness_block" ||
  fail "the newest-run check must authenticate with the workflow token"
grep -Fq 'run: bash scripts/check-pages-run-freshness.sh' <<<"$freshness_block" ||
  fail "deployment authority must come from the tested newest-run checker"

deploy_block="$(step_block "$PAGES_WORKFLOW" "Deploy to gh-pages")"
grep -Fxq "        if: steps.publish_freshness.outputs.publish == 'true'" \
  <<<"$deploy_block" ||
  fail "deployment must be conditional on the main-branch freshness decision"
if_count="$(
  awk '/^[[:space:]]+if:/ { count += 1 } END { print count + 0 }' \
    "$PAGES_WORKFLOW"
)"
[ "$if_count" -eq 1 ] ||
  fail "all pre-deployment Pages work must remain success-gated"
grep -Fq 'publish_dir: apps/browser-demos/dist' <<<"$deploy_block" ||
  fail "the sole publisher must publish the assembled complete tree"
grep -Fq 'force_orphan: true' <<<"$deploy_block" ||
  fail "the root publisher must replace gh-pages with a fresh orphan commit"
if grep -Fq 'keep_files:' <<<"$deploy_block"; then
  fail "the root publisher must not retain obsolete Pages files"
fi
if grep -Fq 'destination_dir:' <<<"$deploy_block"; then
  fail "the sole publisher must replace the branch root, not one subtree"
fi

echo "ci-check-pages-deployment: ok"
