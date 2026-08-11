#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="${1:-$DEFAULT_REPO_ROOT}"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
PAGES_WORKFLOW="$WORKFLOWS_DIR/browser-demos-pages.yml"
CANARY_WORKFLOW="$WORKFLOWS_DIR/abi-staging-pages-canary.yml"

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

workflow_step_line() {
  local workflow="$1"
  local step="$2"
  grep -nF -- "- name: $step" "$workflow" 2>/dev/null |
    head -n 1 |
    cut -d: -f1 || true
}

[ -f "$CANARY_WORKFLOW" ] ||
  fail "native atomic Pages canary does not exist: $CANARY_WORKFLOW"
grep -Fxq 'name: ABI staging Pages canary' "$CANARY_WORKFLOW" ||
  fail "the Pages canary must have its reviewed observe-only identity"

canary_trigger_block="$(
  awk '
    /^on:$/ { inside = 1 }
    inside && /^concurrency:$/ { exit }
    inside { print }
  ' "$CANARY_WORKFLOW"
)"
if grep -Eq '^  (pull_request|pull_request_target):' \
    <<<"$canary_trigger_block"; then
  fail "canary must not run for pull requests"
fi
if grep -Eq '^[[:space:]]+(paths|paths-ignore):' \
    <<<"$canary_trigger_block"; then
  fail "canary must run for every protected main push"
fi
canary_event_keys="$(
  awk '
    /^  [A-Za-z0-9_-]+:$/ {
      key = $1
      sub(/:$/, "", key)
      print key
    }
  ' <<<"$canary_trigger_block"
)"
[ "$canary_event_keys" = "push" ] &&
  grep -Fxq '    branches: [main]' <<<"$canary_trigger_block" ||
  fail "canary must be authorized only by protected main pushes"
grep -Fxq '  group: abi-staging-pages-canary' "$CANARY_WORKFLOW" &&
  grep -Fxq '  cancel-in-progress: true' "$CANARY_WORKFLOW" ||
  fail "canary must supersede older current-main observations"

canary_workflow_header="$(sed -n '1,/^jobs:$/p' "$CANARY_WORKFLOW")"
canary_top_permissions_count="$(
  awk '/^permissions:/ { count += 1 } END { print count + 0 }' \
    <<<"$canary_workflow_header"
)"
[ "$canary_top_permissions_count" -eq 1 ] &&
  grep -Fxq 'permissions: {}' <<<"$canary_workflow_header" ||
  fail "canary workflow permissions must be empty"

canary_job_names="$(
  awk '
    /^jobs:$/ { inside = 1; next }
    inside && /^  [A-Za-z0-9_.-]+:$/ {
      job = $1
      sub(/:$/, "", job)
      print job
    }
  ' "$CANARY_WORKFLOW"
)"
[ "$canary_job_names" = "canary" ] ||
  fail "the Pages canary must have exactly one observe-only job"
canary_job_block="$(job_block "$CANARY_WORKFLOW" "canary")"
grep -Fxq '    runs-on: ubuntu-latest' <<<"$canary_job_block" ||
  fail "the Pages canary must use the reviewed GitHub-hosted Ubuntu runner"
canary_job_permissions="$(
  awk '
    $0 == "    permissions:" { inside = 1 }
    inside && $0 == "    steps:" { exit }
    inside { print }
  ' <<<"$canary_job_block"
)"
expected_canary_job_permissions=$'    permissions:\n      actions: read\n      contents: read'
[ "$canary_job_permissions" = "$expected_canary_job_permissions" ] ||
  fail "canary job permissions must be exactly Actions and contents read"
if grep -Eq '\$\{\{[[:space:]]*secrets\.' "$CANARY_WORKFLOW"; then
  fail "canary must not receive repository or environment secrets"
fi

canary_checkout_block="$(
  step_block "$CANARY_WORKFLOW" "Check out the exact protected source commit"
)"
grep -Eq \
  'uses: actions/checkout@[0-9a-f]{40}[[:space:]]+# v[0-9]+\.[0-9]+\.[0-9]+' \
  <<<"$canary_checkout_block" ||
  fail "canary checkout must use one full-SHA pinned action"
grep -Fxq '          persist-credentials: false' \
  <<<"$canary_checkout_block" ||
  fail "canary checkout must not persist credentials"
if grep -Eq '^[[:space:]]+ref:' <<<"$canary_checkout_block"; then
  fail "canary checkout must use the event source SHA"
fi
canary_checkout_count="$(
  awk '/^[[:space:]]+uses: actions\/checkout@/ { count += 1 }
       END { print count + 0 }' "$CANARY_WORKFLOW"
)"
[ "$canary_checkout_count" -eq 1 ] ||
  fail "canary must build from exactly one checkout"

canary_setup_node_block="$(step_block "$CANARY_WORKFLOW" "Set up Node")"
grep -Fxq '          package-manager-cache: false' \
  <<<"$canary_setup_node_block" ||
  fail "canary dependency setup must not write durable caches"
if grep -Eq '^[[:space:]]+(cache|cache-dependency-path):' \
    <<<"$canary_setup_node_block"; then
  fail "canary dependency setup must not write durable caches"
fi
if grep -Eq '^[[:space:]]+uses:[[:space:]]+actions/cache@' \
    "$CANARY_WORKFLOW"; then
  fail "canary dependency setup must not write durable caches"
fi

authority_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Verify exact protected current-main authorities"
)"
isolation_line="$(
  workflow_step_line "$CANARY_WORKFLOW" "Isolate current package resolution"
)"
runtime_line="$(
  workflow_step_line "$CANARY_WORKFLOW" "Prepare exact uncredentialed runtime"
)"
inputs_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Materialize exact current product inputs"
)"
site_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Build the complete browser documentation and API site"
)"
handoff_line="$(
  workflow_step_line "$CANARY_WORKFLOW" "Write the bounded production handoff"
)"
producer_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Produce admitted canonical Pages products"
)"
validation_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Validate the complete canonical Pages tree"
)"
canary_freshness_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Confirm this is the newest Pages canary run"
)"
canary_upload_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Upload the complete inert Pages canary"
)"
[ -n "$authority_line" ] && [ -n "$isolation_line" ] &&
  [ -n "$runtime_line" ] &&
  [ -n "$inputs_line" ] && [ -n "$site_line" ] &&
  [ -n "$handoff_line" ] && [ -n "$producer_line" ] &&
  [ -n "$validation_line" ] && [ -n "$canary_freshness_line" ] &&
  [ -n "$canary_upload_line" ] &&
  [ "$authority_line" -lt "$isolation_line" ] &&
  [ "$isolation_line" -lt "$runtime_line" ] &&
  [ "$runtime_line" -lt "$inputs_line" ] &&
  [ "$inputs_line" -lt "$site_line" ] &&
  [ "$site_line" -lt "$handoff_line" ] &&
  [ "$handoff_line" -lt "$producer_line" ] &&
  [ "$producer_line" -lt "$validation_line" ] &&
  [ "$validation_line" -lt "$canary_freshness_line" ] &&
  [ "$canary_freshness_line" -lt "$canary_upload_line" ] ||
  fail "canary must build, produce, validate, freshness-check, then upload one tree"

authority_block="$(
  step_block "$CANARY_WORKFLOW" "Verify exact protected current-main authorities"
)"
grep -Fq '[[ "$GITHUB_REPOSITORY" == Automattic/kandelo ]]' \
  <<<"$authority_block" &&
  grep -Fq '[[ "$GITHUB_EVENT_NAME" == push ]]' <<<"$authority_block" &&
  grep -Fq '[[ "$GITHUB_REF" == refs/heads/main ]]' <<<"$authority_block" &&
  grep -Fq 'abi-staging-pages-canary.yml@refs/heads/main' \
    <<<"$authority_block" &&
  grep -Fq '[[ $(git rev-parse HEAD) == "$GITHUB_SHA" ]]' \
    <<<"$authority_block" &&
  grep -Fq "git rev-parse 'HEAD^{tree}'" <<<"$authority_block" &&
  grep -Fq 'git status --porcelain=v1 --untracked-files=all' \
    <<<"$authority_block" ||
  fail "canary must bind one exact clean protected current-main checkout"
grep -Fq 'build-deps program-index-check' <<<"$authority_block" &&
  grep -Fq 'abi-staging products check' <<<"$authority_block" &&
  grep -Fq 'abi-staging evidence-definitions check' <<<"$authority_block" &&
  grep -Fq 'abi-staging request-policy check' <<<"$authority_block" &&
  grep -Fq 'node scripts/check-pages-vfs-product-registry.mjs' \
    <<<"$authority_block" ||
  fail "canary must verify every generated current-main authority"

isolation_block="$(
  step_block "$CANARY_WORKFLOW" "Isolate current package resolution"
)"
grep -Fq \
  'package_cache="$RUNNER_TEMP/abi-staging-pages-package-cache"' \
  <<<"$isolation_block" &&
  grep -Fq 'test ! -e "$package_cache"' <<<"$isolation_block" &&
  grep -Fq 'mkdir -m 0700 "$package_cache"' <<<"$isolation_block" &&
  grep -Fq \
    'echo "WASM_POSIX_BINARY_CACHE_ROOT=$package_cache" >>"$GITHUB_ENV"' \
    <<<"$isolation_block" ||
  fail "canary must create one fresh runner-temporary package cache"

playwright_install_block="$(
  step_block "$CANARY_WORKFLOW" "Install browser dependencies and Chromium"
)"
grep -Fq \
  'playwright_browsers="$RUNNER_TEMP/abi-staging-pages-playwright"' \
  <<<"$playwright_install_block" &&
  grep -Fq 'test ! -e "$playwright_browsers"' \
    <<<"$playwright_install_block" &&
  grep -Fq \
    'echo "PLAYWRIGHT_BROWSERS_PATH=$playwright_browsers" >>"$GITHUB_ENV"' \
    <<<"$playwright_install_block" &&
  grep -Fq \
    'PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers" npx playwright install \' \
    <<<"$playwright_install_block" ||
  fail "canary must install and run Chromium from one explicit browser root"

runtime_block="$(
  step_block "$CANARY_WORKFLOW" "Prepare exact uncredentialed runtime"
)"
grep -Fq 'env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_RUNTIME_TOKEN \' \
  <<<"$runtime_block" &&
  grep -Fq 'scripts/abi-staging-prepare-runtime.sh' <<<"$runtime_block" &&
  grep -Fq -- '--source-commit "$source_commit"' <<<"$runtime_block" &&
  grep -Fq -- '--source-tree "$source_tree"' <<<"$runtime_block" &&
  grep -Fq -- '--target-abi "$target_abi"' <<<"$runtime_block" &&
  grep -Fq -- '--snapshot-sha256 "$snapshot_sha"' <<<"$runtime_block" &&
  grep -Fq -- '--build-policy-sha256 "$policy_sha"' <<<"$runtime_block" ||
  fail "canary runtime must be an uncredentialed exact-current-source artifact"

inputs_block="$(
  step_block "$CANARY_WORKFLOW" "Materialize exact current product inputs"
)"
exact_pages_registry='apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json'
grep -Fq "registry=\"$exact_pages_registry\"" <<<"$inputs_block" ||
  fail "canary must bind the exact protected Pages registry"
pages_catalog_projection_count="$(
  grep -Fc '($pages[0].products | map(.id) | index($id))' \
    <<<"$inputs_block" || true
)"
[ "$pages_catalog_projection_count" -eq 2 ] &&
  grep -Fq '.software.package[].name' <<<"$inputs_block" &&
  grep -Fq '.software.archive[]' <<<"$inputs_block" &&
  grep -Fq 'done < <(jq -r '\''.products[].id'\'' "$registry")' \
    <<<"$inputs_block" ||
  fail "canary must bind the complete protected Pages registry"
grep -Fq 'fetch_args=(--fetch-only)' <<<"$inputs_block" &&
  grep -Fq 'fetch_args+=(--package "$package")' <<<"$inputs_block" &&
  grep -Fq 'bash scripts/fetch-binaries.sh "${fetch_args[@]}"' \
    <<<"$inputs_block" &&
  grep -Fq 'if [ "$package" != homebrew-bootstrap ]; then' \
    <<<"$inputs_block" &&
  grep -Fq 'scripts/prepare-homebrew-browser-bootstrap.sh \' \
    <<<"$inputs_block" &&
  grep -Fq -- '--require-sealed' <<<"$inputs_block" &&
  grep -Fq './run.sh --fetch-only \' <<<"$inputs_block" &&
  grep -Fq -- '--require-sealed-homebrew-selection prepare-browser' \
    <<<"$inputs_block" &&
  grep -Fq '"$xtask" build-deps --arch wasm32 path "$package"' \
    <<<"$inputs_block" &&
  grep -Fq '[ -d "$package_root" ] && [ ! -L "$package_root" ]' \
    <<<"$inputs_block" ||
  fail "canary input materialization must forbid source fallback"
grep -Fq 'bash scripts/dev-shell.sh env \' <<<"$inputs_block" &&
  grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    <<<"$inputs_block" ||
  fail "canary must retain the isolated package cache inside dev-shell"
grep -Fq "curl --fail --location --proto '=https'" <<<"$inputs_block" &&
  grep -Fq -- "--proto-redir '=https' --tlsv1.2" <<<"$inputs_block" &&
  grep -Fq -- '--max-filesize 536870912' <<<"$inputs_block" &&
  grep -Fq '((archive_bytes > 0 && archive_bytes <= 536870912))' \
    <<<"$inputs_block" &&
  grep -Fq 'sha256sum --check --status' <<<"$inputs_block" &&
  grep -Fq 'package-roots.json' <<<"$inputs_block" &&
  grep -Fq 'archive-files.json' <<<"$inputs_block" ||
  fail "canary must materialize exact anonymous package and archive maps"
if grep -Fq -- '--allow-stale' <<<"$inputs_block" ||
   grep -Fq -- '--force-source-build' <<<"$inputs_block" ||
   grep -Fq -- '--source-rootfs-shell' <<<"$inputs_block"; then
  fail "canary input materialization must forbid source fallback"
fi

site_block="$(
  step_block "$CANARY_WORKFLOW" \
    "Build the complete browser documentation and API site"
)"
grep -Fq 'npm run build' <<<"$site_block" &&
  grep -Fq 'node --test docs-site/.vitepress/homebrew-doc-links.test.mjs' \
    <<<"$site_block" &&
  grep -Fq 'VITEPRESS_BASE=/kandelo/guide/ npm run docs:build' \
    <<<"$site_block" &&
  grep -Fq 'node --test docs-site/.vitepress/homebrew-doc-output.test.mjs' \
    <<<"$site_block" &&
  grep -Fq 'npx tsc --noEmit -p tsconfig.docs.json' <<<"$site_block" &&
  grep -Fq 'npx typedoc' <<<"$site_block" &&
  grep -Fq 'cp -R docs-site/.vitepress/dist "$site_root/guide"' \
    <<<"$site_block" &&
  grep -Fq 'cp -R host/docs "$site_root/api"' <<<"$site_block" &&
  grep -Fq 'find "$site_root" -type l' <<<"$site_block" ||
  fail "canary must assemble the complete browser, guide, and API source tree"

handoff_block="$(
  step_block "$CANARY_WORKFLOW" "Write the bounded production handoff"
)"
grep -Fq "registry=\"$exact_pages_registry\"" <<<"$handoff_block" ||
  fail "canary must bind the exact protected Pages registry"
grep -Fq 'kind: "kandelo-pages-production-handoff"' \
  <<<"$handoff_block" &&
  grep -Fq 'current_inputs:' <<<"$handoff_block" &&
  grep -Fq 'runtime_bundle: $runtime_bundle' <<<"$handoff_block" &&
  grep -Fq 'runtime_root: $runtime_root' <<<"$handoff_block" &&
  grep -Fq 'site_source_root: $site_source_root' <<<"$handoff_block" &&
  grep -Fq 'source_root: $source_root' <<<"$handoff_block" &&
  grep -Fq 'target_abi: {snapshot_sha256: $snapshot, version: $abi}' \
    <<<"$handoff_block" &&
  grep -Fq '[[ "$source_commit" == "$GITHUB_SHA" ]]' \
    <<<"$handoff_block" &&
  grep -Fq 'git status --porcelain=v1 --untracked-files=all' \
    <<<"$handoff_block" ||
  fail "canary must write one exact bounded production handoff"

if grep -Eq -- '--candidate-vfs|candidate[._-]vfs|lazy[-_ ]bod(y|ies)' \
    "$CANARY_WORKFLOW"; then
  fail "canary must never consume candidate VFS or lazy bodies"
fi
candidate_rejection_count="$(
  grep -Fc -- '-candidates/' "$CANARY_WORKFLOW" || true
)"
[ "$candidate_rejection_count" -eq 2 ] ||
  fail "canary output must not contain a candidate reference"

producer_block="$(
  step_block "$CANARY_WORKFLOW" "Produce admitted canonical Pages products"
)"
grep -Fq 'bash scripts/dev-shell.sh env \' <<<"$producer_block" &&
  grep -Fq '"PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" \' \
    <<<"$producer_block" ||
  fail "canary must install and run Chromium from one explicit browser root"
grep -Fq 'env -u GH_TOKEN -u GITHUB_TOKEN -u ACTIONS_RUNTIME_TOKEN \' \
  <<<"$producer_block" &&
  grep -Fq 'scripts/abi-staging-pages-producer.ts produce \' \
    <<<"$producer_block" ||
  fail "canary must invoke only the production Pages producer CLI"
if grep -Eq 'fixture|testDependencies|test-only|producer-fixture' \
    <<<"$producer_block"; then
  fail "canary must invoke only the production Pages producer CLI"
fi
producer_last="$(awk 'NF { line = $0 } END { print line }' <<<"$producer_block")"
[ "$producer_last" = '                --output-root "$pages_output"' ] ||
  fail "canary producer must be the final failure-propagating command"

validation_block="$(
  step_block "$CANARY_WORKFLOW" \
    "Validate the complete canonical Pages tree"
)"
grep -Fq "registry=\"$exact_pages_registry\"" <<<"$validation_block" ||
  fail "canary must bind the exact protected Pages registry"
grep -Fq 'abi-staging pages-readiness validate-readiness "$readiness"' \
  <<<"$validation_block" &&
  grep -Fq 'abi-staging pages-readiness validate-site "$site_manifest"' \
    <<<"$validation_block" &&
  grep -Fq '.ready == true' <<<"$validation_block" &&
  grep -Fq '.blockers == []' <<<"$validation_block" &&
  grep -Fq '($registry[0].products | map(.id))' <<<"$validation_block" &&
  grep -Fq '(.node_receipts | length > 0)' <<<"$validation_block" &&
  grep -Fq '(.browser_receipts | length > 0)' <<<"$validation_block" ||
  fail "canary must require every product Node and browser receipt"
grep -Fq 'deployment_path = ".well-known/kandelo/pages-deployment.json"' \
  <<<"$validation_block" &&
  grep -Fq 'actual.sort(key=lambda entry: entry["path"])' \
    <<<"$validation_block" &&
  grep -Fq 'if inventory != manifest["files"]:' <<<"$validation_block" &&
  grep -Fq 'node scripts/check-pages-publish-size.mjs "$site_root" 1000000000' \
    <<<"$validation_block" ||
  fail "canary must validate the exact complete Pages inventory and size bound"

if grep -Eq 'KANDELO_[A-Z0-9_]*(RECORD|TAG)[A-Z0-9_]*:[[:space:]]*latest|@latest|/latest([/:[:space:]]|$)' \
    "$CANARY_WORKFLOW"; then
  fail "canary must not select mutable product records"
fi
if grep -Eq '^[[:space:]]+continue-on-error:' "$CANARY_WORKFLOW" ||
   grep -Fq '|| true' "$CANARY_WORKFLOW"; then
  fail "canary preparation and upload must remain failure-intolerant"
fi
if grep -Eq '^[[:space:]]+if:[[:space:]]*always\(\)' \
    "$CANARY_WORKFLOW"; then
  fail "canary pre-upload work must remain success-gated"
fi

canary_freshness_block="$(
  step_block "$CANARY_WORKFLOW" "Confirm this is the newest Pages canary run"
)"
grep -Fq 'id: upload_freshness' <<<"$canary_freshness_block" &&
  grep -Fq 'GH_TOKEN: ${{ github.token }}' <<<"$canary_freshness_block" ||
  fail "canary newest-run guard must retain read-only Actions authority"
grep -Fq 'PAGES_WORKFLOW_FILE: abi-staging-pages-canary.yml' \
  <<<"$canary_freshness_block" ||
  fail "canary newest-run guard must query only the canary workflow"
grep -Fq 'run: bash scripts/check-pages-run-freshness.sh' \
  <<<"$canary_freshness_block" ||
  fail "canary upload authority must come from the tested newest-run checker"

if grep -Eq 'actions/deploy-pages@|peaceiris/actions-gh-pages@' \
    "$CANARY_WORKFLOW"; then
  fail "canary must never deploy Pages"
fi
if grep -Eq 'git[[:space:]]+push|gh-pages' "$CANARY_WORKFLOW"; then
  fail "canary must not mutate a publication branch"
fi
if grep -Eq '(^|[[:space:]])(npm publish|docker push|oras push|gh release create)' \
    "$CANARY_WORKFLOW"; then
  fail "canary must remain observe-only and publish no package state"
fi

canary_pages_artifact_count="$(
  awk '/^[[:space:]]+uses: actions\/upload-pages-artifact@/ { count += 1 }
       END { print count + 0 }' "$CANARY_WORKFLOW"
)"
[ "$canary_pages_artifact_count" -eq 1 ] ||
  fail "canary must upload exactly one inert Pages artifact"
if grep -Eq '^[[:space:]]+uses: actions/upload-artifact@' \
    "$CANARY_WORKFLOW"; then
  fail "canary must upload exactly one inert Pages artifact"
fi
canary_upload_block="$(
  step_block "$CANARY_WORKFLOW" "Upload the complete inert Pages canary"
)"
grep -Fxq \
  '        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0' \
  <<<"$canary_upload_block" ||
  fail "canary must upload exactly one inert Pages artifact"
grep -Fxq "        if: steps.upload_freshness.outputs.upload == 'true'" \
  <<<"$canary_upload_block" ||
  fail "canary upload authority must come from the tested newest-run checker"
grep -Fxq \
  '          path: ${{ runner.temp }}/abi-staging-pages-output/source-tree' \
  <<<"$canary_upload_block" ||
  fail "canary must upload the complete canonical Pages source tree"
grep -Fxq '          include-hidden-files: true' \
  <<<"$canary_upload_block" ||
  fail "canary must retain the exact hidden deployment manifest"
grep -Fxq '          retention-days: 7' <<<"$canary_upload_block" ||
  fail "canary must retain its inert artifact for seven days"
grep -Fq 'name: abi-staging-pages-canary-${{ github.run_id }}' \
  <<<"$canary_upload_block" ||
  fail "canary artifact identity must be unique to the exact workflow run"

between_canary_freshness_and_upload="$(
  sed -n "${canary_freshness_line},${canary_upload_line}p" \
    "$CANARY_WORKFLOW" |
    awk '/^      - name:/ { count += 1 } END { print count + 0 }'
)"
[ "$between_canary_freshness_and_upload" -eq 2 ] ||
  fail "canary newest-run guard must be immediately before upload"
canary_if_count="$(
  awk '/^[[:space:]]+if:/ { count += 1 } END { print count + 0 }' \
    "$CANARY_WORKFLOW"
)"
[ "$canary_if_count" -eq 1 ] ||
  fail "canary pre-upload work must remain success-gated"

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
