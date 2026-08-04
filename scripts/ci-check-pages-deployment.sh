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
trigger_block="$(
  awk '
    /^on:$/ { inside = 1 }
    inside && /^concurrency:$/ { exit }
    inside { print }
  ' "$PAGES_WORKFLOW"
)"
grep -Fxq '  push:' <<<"$trigger_block" &&
  grep -Fxq '    branches: [main]' <<<"$trigger_block" ||
  fail "the complete Pages publisher must run for every main push"
if grep -Eq '^  (pull_request|pull_request_target):' <<<"$trigger_block"; then
  fail "the Pages publisher must not deploy pull-request revisions"
fi
if grep -Eq '^[[:space:]]+(paths|paths-ignore):' <<<"$trigger_block"; then
  fail "the complete Pages publisher must not filter main pushes by path"
fi

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
  fail "the product-building Pages checkout must not persist write credentials"
if grep -Eq '^[[:space:]]+ref:' <<<"$checkout_block"; then
  fail "the Pages checkout must use the workflow event source SHA"
fi
checkout_count="$(
  awk '/^[[:space:]]+uses: actions\/checkout@/ { count += 1 }
       END { print count + 0 }' "$PAGES_WORKFLOW"
)"
[ "$checkout_count" -eq 1 ] ||
  fail "all Pages outputs must be built from one checkout"

projection_line="$(step_line "Verify browser package projection is current")"
musl_line="$(
  step_line "Fetch musl for repository-owned browser support programs"
)"
isolation_line="$(step_line "Isolate the canonical bottled browser product")"
prepare_browser_line="$(step_line "Prepare browser demo assets")"
shell_product_line="$(step_line "Bind the canonical bottled shell product")"
browser_build_line="$(step_line "Build browser demos for GitHub Pages")"
guide_build_line="$(step_line "Build user guide for the complete Pages tree")"
api_build_line="$(step_line "Build API docs for the complete Pages tree")"
assembly_line="$(step_line "Add documentation to the complete Pages tree")"
sealed_boot_line="$(step_line "Boot the canonical bottled Pages shell in Chromium")"
size_line="$(step_line "Enforce the GitHub Pages published-site size limit")"
freshness_line="$(step_line "Confirm this is the newest Pages run")"
deploy_line="$(step_line "Deploy to gh-pages")"

[ -n "$musl_line" ] && [ -n "$projection_line" ] &&
  [ -n "$isolation_line" ] &&
  [ -n "$prepare_browser_line" ] && [ -n "$shell_product_line" ] &&
  [ "$musl_line" -lt "$prepare_browser_line" ] &&
  [ "$projection_line" -lt "$prepare_browser_line" ] &&
  [ "$projection_line" -lt "$isolation_line" ] &&
  [ "$isolation_line" -lt "$prepare_browser_line" ] &&
  [ "$prepare_browser_line" -lt "$shell_product_line" ] &&
  [ -n "$browser_build_line" ] &&
  [ "$shell_product_line" -lt "$browser_build_line" ] &&
  [ "$browser_build_line" -lt "$guide_build_line" ] &&
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

musl_block="$(
  step_block \
    "$PAGES_WORKFLOW" \
    "Fetch musl for repository-owned browser support programs"
)"
grep -Fxq '        uses: ./.github/actions/fetch-submodules' \
  <<<"$musl_block" &&
  grep -Fxq '          submodules: libc/musl' <<<"$musl_block" ||
  fail "Pages must fetch musl for its repository-owned support programs"

projection_block="$(
  step_block "$PAGES_WORKFLOW" "Verify browser package projection is current"
)"
grep -Fq 'build-deps program-index-check' <<<"$projection_block" &&
  grep -Fq 'packages/registry packages/registry/program-packages.json' \
    <<<"$projection_block" ||
  fail "the Pages publisher must verify the generated package projection before preparing assets"

isolation_block="$(
  step_block "$PAGES_WORKFLOW" "Isolate the canonical bottled browser product"
)"
grep -Fq 'product_cache="$RUNNER_TEMP/pages-canonical-bottle-cache"' \
  <<<"$isolation_block" &&
  grep -Fq 'test ! -e "$product_cache"' <<<"$isolation_block" &&
  grep -Fq \
    'echo "WASM_POSIX_BINARY_CACHE_ROOT=$product_cache" >> "$GITHUB_ENV"' \
    <<<"$isolation_block" ||
  fail "the Pages publisher must establish one fresh canonical package cache"

prepare_browser_block="$(
  step_block "$PAGES_WORKFLOW" "Prepare browser demo assets"
)"
grep -Fq 'bash scripts/dev-shell.sh env \' <<<"$prepare_browser_block" &&
  grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    <<<"$prepare_browser_block" ||
  fail "browser preparation must retain the canonical cache inside dev-shell"
grep -Fxq '            ./run.sh --fetch-only \' \
  <<<"$prepare_browser_block" &&
  grep -Fq \
    '              --require-sealed-homebrew-selection prepare-browser' \
    <<<"$prepare_browser_block" ||
  fail "browser preparation must require sealed bottle inputs"
prepare_browser_last="$(
  awk 'NF { line = $0 } END { print line }' <<<"$prepare_browser_block"
)"
[ "$prepare_browser_last" = \
    '              --require-sealed-homebrew-selection prepare-browser' ] ||
  fail "canonical browser preparation must be the final failure-propagating command"
if grep -Fq -- '--source-rootfs-shell' "$PAGES_WORKFLOW" ||
   grep -Fq 'WASM_POSIX_SOURCE_ROOTFS_SHELL_' "$PAGES_WORKFLOW" ||
   grep -Fq -- '--allow-stale' "$PAGES_WORKFLOW"; then
  fail "the canonical Pages product must not activate the source bridge"
fi

shell_product_block="$(
  step_block "$PAGES_WORKFLOW" "Bind the canonical bottled shell product"
)"
grep -Fq 'id: shell_product' <<<"$shell_product_block" &&
  grep -Fq \
    'image=$(bash scripts/resolve-binary.sh programs/shell.vfs.zst)' \
    <<<"$shell_product_block" &&
  grep -Fq \
    'bootstrap="$PWD/apps/browser-demos/public/homebrew-bootstrap.zip"' \
    <<<"$shell_product_block" &&
  grep -Fq \
    'portable_ruby="$PWD/apps/browser-demos/public/homebrew-portable-ruby.zip"' \
    <<<"$shell_product_block" &&
  grep -Fq 'scripts/verify-homebrew-main-shell-artifact-lock.sh' \
    <<<"$shell_product_block" &&
  grep -Fq 'scripts/inspect-homebrew-main-shell-public-product.ts' \
    <<<"$shell_product_block" &&
  grep -Fq 'homebrew/main-shell-brew-package-tree.json' \
    <<<"$shell_product_block" &&
  grep -Fq 'homebrew/main-shell-homebrew-runtime-support.json' \
    <<<"$shell_product_block" &&
  grep -Fq 'mirror_plan_url=$(jq -er' <<<"$shell_product_block" ||
  fail "Pages must bind the canonical shell, bootstrap, and embedded mirror plan"
if grep -Fq 'programs/homebrew-bootstrap/' "$PAGES_WORKFLOW" ||
   grep -Fq 'fetch-selection-release' <<<"$shell_product_block" ||
   grep -Fq 'scripts/extract-homebrew-support-data-bottle.ts' \
     <<<"$shell_product_block"; then
  fail "Pages must use the one prepared Formula-bottle bootstrap asset"
fi
grep -Fq 'npx tsx --test \' <<<"$shell_product_block" &&
  grep -Fq 'scripts/inspect-homebrew-main-shell-public-product.test.ts' \
    <<<"$shell_product_block" ||
  fail "Pages must run the public-product inspector rejection tests"
if grep -Fq 'recover-homebrew-bottle-mirror' <<<"$shell_product_block"; then
  fail "Pages inspection must not eagerly download the complete bottle mirror"
fi

# WHY: the Homebrew shell PR gate intentionally builds one product entry.
# Pages is the compensating full-gallery build gate, so only its focused boot
# may select the shell entry. Applying that selector to the production build
# could silently omit valid gallery routes from the deployed tree.
browser_build_block="$(
  step_block "$PAGES_WORKFLOW" "Build browser demos for GitHub Pages"
)"
grep -Fxq '          npm run build' <<<"$browser_build_block" &&
  grep -Fq 'dist/homebrew-bootstrap.zip' <<<"$browser_build_block" &&
  grep -Fq 'dist/homebrew-portable-ruby.zip' \
    <<<"$browser_build_block" &&
  grep -Fq 'bash ../../scripts/verify-browser-shell-vfs-asset.sh \' \
    <<<"$browser_build_block" &&
  grep -Fxq \
    '            dist "${{ steps.shell_product.outputs.image }}"' \
    <<<"$browser_build_block" ||
  fail "the Pages build must verify its exact hashed shell asset"
if grep -Fq 'dist/shell.vfs.zst' "$PAGES_WORKFLOW" ||
   grep -Fq 'apps/browser-demos/public/shell.vfs.zst' "$PAGES_WORKFLOW"; then
  fail "Pages must not trust Vite's optional unhashed public shell copy"
fi
if grep -Fq 'KANDELO_BROWSER_DEMO_INPUTS' <<<"$browser_build_block"; then
  fail "the Pages publisher must build the complete browser entry set"
fi

guide_build_block="$(
  step_block "$PAGES_WORKFLOW" "Build user guide for the complete Pages tree"
)"
guide_build_commands="$(
  awk '
    $0 == "        run: |" { inside = 1; next }
    inside && /^          #/ { next }
    inside && /^          [^[:space:]]/ { print; next }
    inside && NF { exit }
  ' <<<"$guide_build_block"
)"
expected_guide_build_commands=$'          set -euo pipefail\n          node --test docs-site/.vitepress/homebrew-doc-links.test.mjs\n          npm run docs:build\n          node --test docs-site/.vitepress/homebrew-doc-output.test.mjs'
# WHY: run the source-link test before VitePress consumes the Markdown.
# Run the generated-output test only after the site exists. This exact,
# failure-propagating order prevents publication of an unchecked guide.
[ "$guide_build_commands" = "$expected_guide_build_commands" ] ||
  fail "the Pages guide must run strict source checks, build, then output checks"

sealed_boot_block="$(
  step_block "$PAGES_WORKFLOW" "Boot the canonical bottled Pages shell in Chromium"
)"
grep -Fq 'VITE_BASE: /kandelo/' <<<"$sealed_boot_block" &&
  grep -Fq 'KANDELO_BROWSER_DEMO_INPUTS: main' \
    <<<"$sealed_boot_block" &&
  grep -Fq 'KANDELO_HOMEBREW_MAIN_SHELL_STRICT: "1"' \
    <<<"$sealed_boot_block" &&
  grep -Fq \
    'KANDELO_HOMEBREW_MAIN_SHELL_SHA256: ${{ steps.shell_product.outputs.image_sha256 }}' \
    <<<"$sealed_boot_block" &&
  grep -Fq \
    'KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_SHA256: ${{ steps.shell_product.outputs.bootstrap_sha256 }}' \
    <<<"$sealed_boot_block" &&
  grep -Fq \
    'KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_BYTES: ${{ steps.shell_product.outputs.bootstrap_bytes }}' \
    <<<"$sealed_boot_block" &&
  grep -Fq 'KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE: public' \
    <<<"$sealed_boot_block" &&
  grep -Fq \
    'KANDELO_HOMEBREW_MAIN_SHELL_MIRROR_PLAN_URL: ${{ steps.shell_product.outputs.mirror_plan_url }}' \
    <<<"$sealed_boot_block" &&
  grep -Fq 'KANDELO_PLAYWRIGHT_SERVE_DIST: "1"' <<<"$sealed_boot_block" &&
  grep -Fq 'KANDELO_TEST_BASE_URL: http://127.0.0.1:5401/kandelo/' \
    <<<"$sealed_boot_block" &&
  grep -Fq 'bash ../../scripts/dev-shell.sh env \' <<<"$sealed_boot_block" &&
  grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    <<<"$sealed_boot_block" &&
  grep -Fq 'test/kandelo-homebrew-main-shell.spec.ts' \
    <<<"$sealed_boot_block" ||
  fail "the Pages preview must prove the public bottled shell at the published base"

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
