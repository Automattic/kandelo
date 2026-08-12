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
grep -Fxq '  workflow_dispatch:' <<<"$trigger_block" ||
  fail "the complete Pages publisher must run only after activation dispatch"
if grep -Eq '^  (push|pull_request|pull_request_target|schedule):' \
  <<<"$trigger_block"; then
  fail "the Pages publisher must run only after activation dispatch"
fi
for input in source_sha candidate_tag canonical_index_sha256; do
  grep -Fxq "      $input:" <<<"$trigger_block" ||
    fail "workflow dispatch must bind the exact source, candidate, and canonical index"
done

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

requested_source_block="$(
  step_block "$PAGES_WORKFLOW" "Validate the requested source generation"
)"
for evidence in \
  'EVENT_NAME: ${{ github.event_name }}' \
  'REQUESTED_SOURCE_SHA: ${{ inputs.source_sha }}' \
  'REQUESTED_CANDIDATE_TAG: ${{ inputs.candidate_tag }}' \
  'REQUESTED_CANONICAL_INDEX_SHA256: ${{ inputs.canonical_index_sha256 }}' \
  '^[0-9a-f]{40}$' \
  '^merge-candidate-abi-v[0-9]+-pr-[0-9]+-run-[0-9]+-attempt-[0-9]+$' \
  '^[0-9a-f]{64}$'
do
  grep -Fq "$evidence" <<<"$requested_source_block" ||
    fail "workflow dispatch must validate every exact generation input before checkout"
done

checkout_block="$(step_block "$PAGES_WORKFLOW" "Check out the source commit")"
grep -Eq 'uses: actions/checkout@[0-9a-f]{40}' <<<"$checkout_block" ||
  fail "the complete publisher must check out one pinned source commit"
grep -Fq 'persist-credentials: false' <<<"$checkout_block" ||
  fail "the product-building Pages checkout must not persist write credentials"
grep -Fq 'ref: ${{ inputs.source_sha }}' <<<"$checkout_block" ||
  fail "the Pages checkout must use the exact activated source SHA"
checkout_ref_count="$(
  awk '/^[[:space:]]+ref:/ { count += 1 } END { print count + 0 }' \
    <<<"$checkout_block"
)"
[ "$checkout_ref_count" -eq 1 ] ||
  fail "the Pages checkout must use one exact source selector"
checkout_count="$(
  awk '/^[[:space:]]+uses: actions\/checkout@/ { count += 1 }
       END { print count + 0 }' "$PAGES_WORKFLOW"
)"
[ "$checkout_count" -eq 1 ] ||
  fail "all Pages outputs must be built from one checkout"

checked_source_block="$(
  step_block "$PAGES_WORKFLOW" "Verify the checked-out source generation"
)"
grep -Fq 'actual_source_sha=$(git rev-parse HEAD)' \
  <<<"$checked_source_block" &&
  grep -Fq '[ "$actual_source_sha" = "$REQUESTED_SOURCE_SHA" ]' \
    <<<"$checked_source_block" &&
  grep -Fq 'refs/remotes/origin/$DEFAULT_BRANCH' \
    <<<"$checked_source_block" ||
  fail "Pages must verify the exact requested source is the current default tip"

projection_line="$(step_line "Verify browser package projection is current")"
package_generation_line="$(step_line "Verify the requested package generation")"
musl_line="$(
  step_line "Fetch musl for repository-owned browser support programs"
)"
isolation_line="$(step_line "Isolate canonical package resolution")"
prepare_browser_line="$(step_line "Prepare browser demo assets")"
package_products_line="$(step_line "Bind canonical package images")"
mirror_line="$(step_line "Verify the public Homebrew bottle mirror")"
browser_build_line="$(step_line "Build browser demos for GitHub Pages")"
guide_build_line="$(step_line "Build user guide for the complete Pages tree")"
api_build_line="$(step_line "Build API docs for the complete Pages tree")"
assembly_line="$(step_line "Add documentation to the complete Pages tree")"
manifest_line="$(step_line "Record the deployed generation")"
flat_boot_line="$(step_line "Boot the canonical lazy Pages shell in Chromium")"
node_acceptance_line="$(step_line "Run exact Pages Node npm acceptance")"
size_line="$(step_line "Enforce the GitHub Pages published-site size limit")"
freshness_line="$(step_line "Confirm this is the newest Pages run")"
deploy_line="$(step_line "Deploy to gh-pages")"

[ -n "$musl_line" ] && [ -n "$package_generation_line" ] &&
  [ -n "$projection_line" ] &&
  [ -n "$isolation_line" ] &&
  [ -n "$prepare_browser_line" ] && [ -n "$package_products_line" ] &&
  [ "$musl_line" -lt "$prepare_browser_line" ] &&
  [ "$package_generation_line" -lt "$projection_line" ] &&
  [ "$projection_line" -lt "$prepare_browser_line" ] &&
  [ "$projection_line" -lt "$isolation_line" ] &&
  [ "$isolation_line" -lt "$prepare_browser_line" ] &&
  [ "$prepare_browser_line" -lt "$package_products_line" ] &&
  [ -n "$mirror_line" ] &&
  [ "$package_products_line" -lt "$mirror_line" ] &&
  [ -n "$browser_build_line" ] &&
  [ "$mirror_line" -lt "$browser_build_line" ] &&
  [ "$browser_build_line" -lt "$guide_build_line" ] &&
  [ -n "$guide_build_line" ] && [ -n "$api_build_line" ] &&
  [ -n "$assembly_line" ] && [ -n "$manifest_line" ] &&
  [ -n "$flat_boot_line" ] &&
  [ -n "$node_acceptance_line" ] &&
  [ -n "$size_line" ] &&
  [ -n "$freshness_line" ] && [ -n "$deploy_line" ] &&
  [ "$guide_build_line" -lt "$assembly_line" ] &&
  [ "$api_build_line" -lt "$assembly_line" ] &&
  [ "$assembly_line" -lt "$manifest_line" ] &&
  [ "$manifest_line" -lt "$flat_boot_line" ] &&
  [ "$flat_boot_line" -lt "$node_acceptance_line" ] &&
  [ "$node_acceptance_line" -lt "$size_line" ] &&
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

package_generation_block="$(
  step_block "$PAGES_WORKFLOW" "Verify the requested package generation"
)"
for evidence in \
  'id: package_generation' \
  'scripts/release-index-state.sh snapshot' \
  'REQUESTED_CANONICAL_INDEX_SHA256' \
  'REQUESTED_CANDIDATE_TAG' \
  'ready.json' \
  'activated.json' \
  'del(.merge_commit_sha, .canonical_index_sha256, .activated_at, .activation_run)' \
  'git merge-base --is-ancestor "$merge_commit_sha" HEAD'
do
  grep -Fq "$evidence" <<<"$package_generation_block" ||
    fail "Pages must authenticate the requested canonical package generation"
done

projection_block="$(
  step_block "$PAGES_WORKFLOW" "Verify browser package projection is current"
)"
grep -Fq 'build-deps program-index-check' <<<"$projection_block" &&
  grep -Fq 'packages/registry packages/registry/program-packages.json' \
    <<<"$projection_block" ||
  fail "the Pages publisher must verify the generated package projection before preparing assets"

isolation_block="$(
  step_block "$PAGES_WORKFLOW" "Isolate canonical package resolution"
)"
grep -Fq 'product_cache="$RUNNER_TEMP/pages-canonical-package-cache"' \
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
grep -Fxq '            ./run.sh --fetch-only prepare-browser' \
  <<<"$prepare_browser_block" ||
  fail "browser preparation must consume canonical packages without fallback"
prepare_browser_last="$(
  awk 'NF { line = $0 } END { print line }' <<<"$prepare_browser_block"
)"
[ "$prepare_browser_last" = \
    '            ./run.sh --fetch-only prepare-browser' ] ||
  fail "canonical browser preparation must be the final failure-propagating command"
if grep -Fq -- '--source-rootfs-shell' "$PAGES_WORKFLOW" ||
   grep -Fq 'WASM_POSIX_SOURCE_ROOTFS_SHELL_' "$PAGES_WORKFLOW" ||
   grep -Fq -- '--allow-stale' "$PAGES_WORKFLOW" ||
   grep -Fq -- '--require-sealed-homebrew-selection' "$PAGES_WORKFLOW";
then
  fail "the canonical Pages product must not activate source or lazy-shell recovery"
fi

package_products_block="$(
  step_block "$PAGES_WORKFLOW" "Bind canonical package images"
)"
grep -Fq 'id: package_products' <<<"$package_products_block" &&
  grep -Fq \
    'shell_image=$(bash scripts/resolve-binary.sh programs/shell.vfs.zst)' \
    <<<"$package_products_block" &&
grep -Fq \
    'node_image=$(bash scripts/resolve-binary.sh programs/node-vfs.vfs.zst)' \
    <<<"$package_products_block" &&
  grep -Fq \
    'bootstrap=$(bash scripts/resolve-binary.sh programs/homebrew-bootstrap/homebrew-bootstrap.zip)' \
    <<<"$package_products_block" &&
  grep -Fq 'cmp "$bootstrap" apps/browser-demos/public/homebrew-bootstrap.zip' \
    <<<"$package_products_block" ||
  fail "Pages must bind the resolver-selected canonical shell, Node, and bootstrap products"
grep -Fq 'scripts/inspect-homebrew-main-shell-public-product.test.ts' \
  <<<"$package_products_block" &&
  grep -Fq 'scripts/inspect-homebrew-main-shell-public-product.ts' \
    <<<"$package_products_block" &&
  grep -Fq -- '--selection homebrew/main-shell-flat-selection.json' \
    <<<"$package_products_block" &&
  grep -Fq -- 'homebrew/main-shell-materialization-policy.json' \
    <<<"$package_products_block" &&
  grep -Fq -- 'homebrew/main-shell-runtime-support-policy.json' \
    <<<"$package_products_block" &&
  grep -Fq -- 'homebrew/main-shell-flat-lazy-mirror-plan.json' \
    <<<"$package_products_block" &&
  grep -Fq -- '--homebrew-bootstrap-archive "$bootstrap"' \
    <<<"$package_products_block" ||
  fail "Pages must run the lazy public-product inspector and its rejection tests"
grep -Fq 'echo "shell_sha256=$(jq -er' \
  <<<"$package_products_block" &&
  grep -Fq \
    'echo "node_sha256=$(sha256sum "$node_image"' \
    <<<"$package_products_block" &&
  grep -Fq 'echo "bootstrap_sha256=$(jq -er' \
    <<<"$package_products_block" &&
  grep -Fq 'echo "bootstrap_bytes=$(jq -er' \
    <<<"$package_products_block" &&
  grep -Fq 'echo "mirror_plan_url=$(jq -er' \
    <<<"$package_products_block" ||
  fail "Pages must record the exact canonical shell, Node, bootstrap, and mirror identities"
for retired_input in \
  main-shell-lazy-artifact-lock \
  verify-homebrew-main-shell-artifact-lock \
  inspect-canonical-flat-shell \
  recover-homebrew-bottle-mirror \
  flat-self-contained
do
  if grep -Fq "$retired_input" "$PAGES_WORKFLOW"; then
    fail "Pages retains retired lazy-shell input: $retired_input"
  fi
done

mirror_block="$(
  step_block "$PAGES_WORKFLOW" "Verify the public Homebrew bottle mirror"
)"
grep -Fq 'env -u GH_TOKEN -u GITHUB_TOKEN node \' <<<"$mirror_block" &&
  grep -Fq 'scripts/verify-public-homebrew-bottle-mirror.mjs \' \
    <<<"$mirror_block" &&
  grep -Fq -- 'homebrew/main-shell-flat-lazy-mirror-plan.json' \
    <<<"$mirror_block" &&
  grep -Fq -- '--out "$RUNNER_TEMP/pages-homebrew-mirror-receipt.json"' \
    <<<"$mirror_block" ||
  fail "Pages must anonymously verify the checked-in public mirror before building"

# WHY: Pages is the full-gallery publication gate. Its focused browser proofs
# may select one entry, but applying either selector to the production build
# could silently omit valid gallery routes from the deployed tree.
browser_build_block="$(
  step_block "$PAGES_WORKFLOW" "Build browser demos for GitHub Pages"
)"
asset_verifier_count="$(
  grep -Fc 'bash ../../scripts/verify-browser-shell-vfs-asset.sh \' \
    <<<"$browser_build_block"
)"
grep -Fxq '          npm run build' <<<"$browser_build_block" &&
  [ "$asset_verifier_count" -eq 2 ] &&
  grep -Fxq \
    '            dist "${{ steps.package_products.outputs.shell_image }}"' \
    <<<"$browser_build_block" &&
  grep -Fxq \
    '            dist "${{ steps.package_products.outputs.node_image }}" node-vfs.vfs' \
    <<<"$browser_build_block" &&
  grep -Fq \
    'cmp "${{ steps.package_products.outputs.bootstrap }}" \' \
    <<<"$browser_build_block" &&
  grep -Fq 'dist/homebrew-bootstrap.zip' \
    <<<"$browser_build_block" ||
  fail "the Pages build must verify its exact shell, Node, and bootstrap assets"
if grep -Fq 'dist/shell.vfs.zst' "$PAGES_WORKFLOW" ||
   grep -Fq 'apps/browser-demos/public/shell.vfs.zst' "$PAGES_WORKFLOW" ||
   grep -Fq 'dist/node-vfs.vfs.zst' "$PAGES_WORKFLOW" ||
   grep -Fq 'apps/browser-demos/public/node-vfs.vfs.zst' "$PAGES_WORKFLOW";
then
  fail "Pages must not trust optional unhashed public package images"
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

flat_boot_block="$(
  step_block "$PAGES_WORKFLOW" "Boot the canonical lazy Pages shell in Chromium"
)"
grep -Fq 'VITE_BASE: /kandelo/' <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_BROWSER_DEMO_INPUTS: main' \
    <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_HOMEBREW_MAIN_SHELL_STRICT: "1"' \
    <<<"$flat_boot_block" &&
  grep -Fq \
    'KANDELO_HOMEBREW_MAIN_SHELL_SHA256: ${{ steps.package_products.outputs.shell_sha256 }}' \
    <<<"$flat_boot_block" &&
  grep -Fq \
    'KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_SHA256: ${{ steps.package_products.outputs.bootstrap_sha256 }}' \
    <<<"$flat_boot_block" &&
  grep -Fq \
    'KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_BYTES: ${{ steps.package_products.outputs.bootstrap_bytes }}' \
    <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE: public' \
    <<<"$flat_boot_block" &&
  grep -Fq \
    'KANDELO_HOMEBREW_MAIN_SHELL_MIRROR_PLAN_URL: ${{ steps.package_products.outputs.mirror_plan_url }}' \
    <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_PLAYWRIGHT_SERVE_DIST: "1"' <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_TEST_BASE_URL: http://127.0.0.1:5401/kandelo/' \
    <<<"$flat_boot_block" &&
  grep -Fq 'bash ../../scripts/dev-shell.sh env \' <<<"$flat_boot_block" &&
  grep -Fq 'test/kandelo-homebrew-main-shell.spec.ts' \
    <<<"$flat_boot_block" &&
  grep -Fq -- '--project=chromium' <<<"$flat_boot_block" ||
  fail "the Pages preview must prove the canonical lazy shell at the published base"
for binding in \
  '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
  '"VITE_BASE=$VITE_BASE" \' \
  '"KANDELO_BROWSER_DEMO_INPUTS=$KANDELO_BROWSER_DEMO_INPUTS" \' \
  '"KANDELO_HOMEBREW_MAIN_SHELL_STRICT=$KANDELO_HOMEBREW_MAIN_SHELL_STRICT" \' \
  '"KANDELO_HOMEBREW_MAIN_SHELL_SHA256=$KANDELO_HOMEBREW_MAIN_SHELL_SHA256" \' \
  '"KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_SHA256=$KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_SHA256" \' \
  '"KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_BYTES=$KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_BYTES" \' \
  '"KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE=$KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE" \' \
  '"KANDELO_HOMEBREW_MAIN_SHELL_MIRROR_PLAN_URL=$KANDELO_HOMEBREW_MAIN_SHELL_MIRROR_PLAN_URL" \' \
  '"KANDELO_PLAYWRIGHT_SERVE_DIST=$KANDELO_PLAYWRIGHT_SERVE_DIST" \' \
  '"KANDELO_TEST_BASE_URL=$KANDELO_TEST_BASE_URL" \'
do
  grep -Fq "$binding" <<<"$flat_boot_block" ||
    fail "the lazy-shell preview must carry its exact inputs through dev-shell"
done

node_acceptance_block="$(
  step_block "$PAGES_WORKFLOW" "Run exact Pages Node npm acceptance"
)"
grep -Fq 'VITE_BASE: /kandelo/' <<<"$node_acceptance_block" &&
  grep -Fq 'KANDELO_BROWSER_DEMO_INPUTS: main' \
    <<<"$node_acceptance_block" &&
  grep -Fq 'KANDELO_NODE_VFS_STRICT: "1"' \
    <<<"$node_acceptance_block" &&
  grep -Fq \
    'KANDELO_NODE_VFS_SHA256: ${{ steps.package_products.outputs.node_sha256 }}' \
    <<<"$node_acceptance_block" &&
  grep -Fq 'KANDELO_PLAYWRIGHT_SERVE_DIST: "1"' \
  <<<"$node_acceptance_block" &&
  grep -Fq 'KANDELO_TEST_BASE_URL: http://127.0.0.1:5401/kandelo/' \
    <<<"$node_acceptance_block" &&
  grep -Fq 'npx playwright test test/kandelo-node.spec.ts' \
    <<<"$node_acceptance_block" &&
  grep -Fq -- "--grep '@node-npm-acceptance'" \
    <<<"$node_acceptance_block" &&
  grep -Fq -- '--project=chromium' <<<"$node_acceptance_block" ||
  fail "the Pages preview must install and execute cowsay from the canonical Node image"
for binding in \
  '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
  '"VITE_BASE=$VITE_BASE" \' \
  '"KANDELO_BROWSER_DEMO_INPUTS=$KANDELO_BROWSER_DEMO_INPUTS" \' \
  '"KANDELO_NODE_VFS_STRICT=$KANDELO_NODE_VFS_STRICT" \' \
  '"KANDELO_NODE_VFS_SHA256=$KANDELO_NODE_VFS_SHA256" \' \
  '"KANDELO_PLAYWRIGHT_SERVE_DIST=$KANDELO_PLAYWRIGHT_SERVE_DIST" \' \
  '"KANDELO_TEST_BASE_URL=$KANDELO_TEST_BASE_URL" \'
do
  grep -Fq "$binding" <<<"$node_acceptance_block" ||
    fail "the Node preview must carry its exact inputs through dev-shell"
done
for forbidden in \
  KANDELO_NODE_LOCAL_BOOT_ASSET_ROOT \
  KANDELO_NODE_LOCAL_PROXY_PORT \
  recover-homebrew-bottle-mirror.ts
do
  ! grep -Fq "$forbidden" <<<"$node_acceptance_block" ||
    fail "the Pages Node acceptance must use the public production transport"
done

manifest_block="$(
  step_block "$PAGES_WORKFLOW" "Record the deployed generation"
)"
grep -Fq 'steps.package_generation.outputs.source_sha' \
  <<<"$manifest_block" &&
  grep -Fq 'steps.package_generation.outputs.candidate_tag' \
    <<<"$manifest_block" &&
  grep -Fq 'steps.package_generation.outputs.canonical_index_sha256' \
    <<<"$manifest_block" &&
  grep -Fq 'apps/browser-demos/dist/kandelo-deployment.json' \
    <<<"$manifest_block" ||
  fail "Pages must publish its exact source and package generation evidence"

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
