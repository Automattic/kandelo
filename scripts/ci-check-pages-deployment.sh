#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="${1:-$DEFAULT_REPO_ROOT}"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"
PAGES_WORKFLOW="$WORKFLOWS_DIR/browser-demos-pages.yml"
CANARY_WORKFLOW="$WORKFLOWS_DIR/abi-staging-pages-canary.yml"
PAGES_PLAN="$REPO_ROOT/docs/superpowers/plans/2026-08-08-abi-staging-promotion-pages-and-retirement.md"
BROWSER_SUPPORT="$REPO_ROOT/docs/browser-support.md"
ATOMIC_GATE="$REPO_ROOT/scripts/test-abi-staging-pages-atomic.sh"
CHECK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-pages-deployment-check.XXXXXX")"

cleanup() {
  case "$CHECK_ROOT" in
    "${TMPDIR:-/tmp}"/kandelo-pages-deployment-check.*)
      rm -rf -- "$CHECK_ROOT"
      ;;
  esac
}
trap cleanup EXIT

fail() {
  echo "ci-check-pages-deployment: $*" >&2
  exit 1
}

[ -d "$WORKFLOWS_DIR" ] ||
  fail "workflow directory does not exist: $WORKFLOWS_DIR"
[ -f "$ATOMIC_GATE" ] ||
  fail "native atomic Pages gate does not exist: $ATOMIC_GATE"
mkdir -p "$CHECK_ROOT/bin" "$CHECK_ROOT/browsers"
atomic_trace="$CHECK_ROOT/atomic-trace"
cat >"$CHECK_ROOT/bin/npx" <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "atomic Chromium command probe: $*" >&2
  exit 91
}

if [ "$#" -eq 4 ] && [ "$1" = tsx ] && [ "$2" = --test ] &&
   [ "$3" = "--test-name-pattern=produces one exact seven-product assembled-site fixture for Chromium" ] &&
   [ "$4" = scripts/abi-staging-pages-producer.test.ts ]; then
  : "${KANDELO_ABI_STAGING_ASSEMBLED_SITE_OUTPUT:?missing producer output}"
  mkdir -p "$KANDELO_ABI_STAGING_ASSEMBLED_SITE_OUTPUT/source-tree"
  printf 'producer\t%s\n' "$KANDELO_ABI_STAGING_ASSEMBLED_SITE_OUTPUT" >>"$KANDELO_ATOMIC_TRACE"
  exit 0
fi

if [ "$#" -eq 7 ] && [ "$1" = --prefix ] && [ "$2" = apps/browser-demos ] &&
   [ "$3" = playwright ] && [ "$4" = test ] &&
   [ "$5" = --config=apps/browser-demos/playwright.config.ts ] &&
   [ "$6" = apps/browser-demos/test/abi-staging-pages-assembled-site.spec.ts ] &&
   [ "$7" = --project=chromium ]; then
  producer_output="$(awk -F '\t' '$1 == "producer" { print $2 }' "$KANDELO_ATOMIC_TRACE")"
  [ -n "$producer_output" ] || fail "Playwright ran before the producer"
  [ "${KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT:-}" = "$producer_output/source-tree" ] ||
    fail "Playwright did not receive the producer-returned source tree"
  [ "${KANDELO_PLAYWRIGHT_SERVE_DIST:-}" = 1 ] || fail "Playwright did not serve production output"
  [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || fail "Playwright browser authority is missing"
  printf 'playwright\t%s\n' "$KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT" >>"$KANDELO_ATOMIC_TRACE"
  exit 0
fi

fail "unexpected npx argv: $*"
PROBE
chmod +x "$CHECK_ROOT/bin/npx"
if ! env \
  PATH="$CHECK_ROOT/bin:$PATH" \
  PLAYWRIGHT_BROWSERS_PATH="$CHECK_ROOT/browsers" \
  KANDELO_ATOMIC_TRACE="$atomic_trace" \
  KANDELO_ABI_STAGING_ATOMIC_CHROMIUM_ONLY=1 \
  KANDELO_DEV_SHELL_TOOL_PATH="${KANDELO_DEV_SHELL_TOOL_PATH:-checker-probe}" \
  bash "$ATOMIC_GATE"; then
  fail "atomic gate must run the exact assembled-site Chromium proof"
fi
[ "$(wc -l <"$atomic_trace" | tr -d ' ')" = 2 ] &&
  awk -F '\t' '
    $1 == "producer" && $2 ~ /^\// { producer += 1 }
    $1 == "playwright" && $2 ~ /^\// && $2 ~ /\/source-tree$/ { playwright += 1 }
    END { exit !(producer == 1 && playwright == 1) }
  ' "$atomic_trace" ||
  fail "atomic gate must run the exact assembled-site Chromium proof"
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
production_inputs="$(
  awk '
    /^      [A-Za-z0-9_-]+:$/ {
      key = $1
      sub(/:$/, "", key)
      print key
    }
  ' <<<"$trigger_block"
)"
[ "$production_inputs" = source_sha ] ||
  fail "workflow dispatch must bind only the exact protected source"

step_block() {
  local workflow="$1"
  local step="$2"
  awk -v step="$step" '
    $0 == "      - name: " step { inside = 1 }
    inside && $0 ~ /^      - name:/ && $0 != "      - name: " step { exit }
    inside { print }
  ' "$workflow"
}

check_filtered_host_target() {
  local block="$1"
  local role="$2"
  local sequence
  local assignment_count

  sequence=$'          host_target=$(bash scripts/dev-shell.sh rustc -vV |\n            awk \'/^host: / { print $2 }\')\n          [[ "$host_target" =~ ^[A-Za-z0-9_.-]+$ ]]'
  assignment_count="$(grep -Fc 'host_target=$(' <<<"$block" || true)"
  [ "$assignment_count" -eq 1 ] && [[ "$block" == *"$sequence"* ]] ||
    fail "$role does not filter then immediately validate noisy dev-shell target output"
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
  fail "native direct Pages canary does not exist: $CANARY_WORKFLOW"
grep -Fxq 'name: ABI staging Pages canary' "$CANARY_WORKFLOW" ||
  fail "the Pages canary must have its reviewed observe-only identity"

canary_trigger_block="$(
  awk '
    /^on:$/ { inside = 1 }
    inside && /^concurrency:$/ { exit }
    inside { print }
  ' "$CANARY_WORKFLOW"
)"
if grep -Eq '^  (pull_request|pull_request_target|workflow_dispatch):' \
    <<<"$canary_trigger_block"; then
  fail "canary must be authorized only by protected main pushes"
fi
[ "$(awk '/^  [A-Za-z0-9_-]+:$/ { key=$1; sub(/:$/, "", key); print key }' \
  <<<"$canary_trigger_block")" = push ] &&
  grep -Fxq '    branches: [main]' <<<"$canary_trigger_block" ||
  fail "canary must run for every protected main push"
grep -Fxq '  group: abi-staging-pages-canary' "$CANARY_WORKFLOW" &&
  grep -Fxq '  cancel-in-progress: true' "$CANARY_WORKFLOW" ||
  fail "canary must supersede older current-main observations"

canary_header="$(sed -n '1,/^jobs:$/p' "$CANARY_WORKFLOW")"
[ "$(awk '/^permissions:/ { count += 1 } END { print count + 0 }' \
  <<<"$canary_header")" -eq 1 ] &&
  grep -Fxq 'permissions: {}' <<<"$canary_header" ||
  fail "canary workflow permissions must be empty"
canary_job_names="$(
  awk '/^jobs:$/ { inside=1; next } inside && /^  [A-Za-z0-9_.-]+:$/ {
    key=$1; sub(/:$/, "", key); print key
  }' "$CANARY_WORKFLOW"
)"
[ "$canary_job_names" = canary ] ||
  fail "the Pages canary must have exactly one observe-only job"
canary_job_block="$(job_block "$CANARY_WORKFLOW" canary)"
grep -Fxq '    runs-on: ubuntu-latest' <<<"$canary_job_block" ||
  fail "the Pages canary must use the reviewed GitHub-hosted Ubuntu runner"
expected_canary_permissions=$'    permissions:\n      actions: read\n      contents: read'
[ "$(awk '/^    permissions:$/ { inside=1 } inside { print } inside && /^    steps:$/ { exit }' \
  <<<"$canary_job_block" | sed '$d')" = "$expected_canary_permissions" ] ||
  fail "canary job permissions must be exactly Actions and contents read"
if grep -Eq 'secrets\.|packages:[[:space:]]*write|contents:[[:space:]]*write|pages:[[:space:]]*write|id-token:[[:space:]]*write' \
    <<<"$canary_job_block"; then
  fail "canary must remain uncredentialed and observe-only"
fi

canary_checkout="$(step_block "$CANARY_WORKFLOW" "Check out the exact protected source commit")"
grep -Eq 'uses: actions/checkout@[0-9a-f]{40} # v[0-9]' <<<"$canary_checkout" &&
  grep -Fxq '          persist-credentials: false' <<<"$canary_checkout" &&
  ! grep -Eq '^[[:space:]]+ref:' <<<"$canary_checkout" ||
  fail "canary checkout must use the exact event source without credentials"

if grep -Eq 'fetch-binaries\.sh|package-roots|package_roots|producer\.ts produce|admission' \
    "$CANARY_WORKFLOW"; then
  fail "canary must not retain legacy package or admission preparation"
fi
preflight_line="$(workflow_step_line "$CANARY_WORKFLOW" "Preflight the complete canonical bottle closure")"
inputs_line="$(workflow_step_line "$CANARY_WORKFLOW" "Materialize exact current product inputs")"
runtime_line="$(workflow_step_line "$CANARY_WORKFLOW" "Prepare exact uncredentialed runtime")"
handoff_line="$(workflow_step_line "$CANARY_WORKFLOW" "Write the bounded production handoff")"
producer_line="$(workflow_step_line "$CANARY_WORKFLOW" "Build the seven ABI products directly for shipping")"
validation_line="$(workflow_step_line "$CANARY_WORKFLOW" "Validate the direct shipping tree")"
smoke_line="$(workflow_step_line "$CANARY_WORKFLOW" "Smoke-test the exact assembled ABI 43 site in Chromium")"
freshness_line="$(workflow_step_line "$CANARY_WORKFLOW" "Confirm this is the newest Pages canary run")"
upload_line="$(workflow_step_line "$CANARY_WORKFLOW" "Upload the complete inert Pages canary")"
[ -n "$preflight_line" ] && [ -n "$inputs_line" ] && [ -n "$runtime_line" ] &&
  [ -n "$handoff_line" ] && [ -n "$producer_line" ] && [ -n "$validation_line" ] &&
  [ -n "$smoke_line" ] && [ -n "$freshness_line" ] && [ -n "$upload_line" ] &&
  [ "$preflight_line" -lt "$runtime_line" ] && [ "$inputs_line" -lt "$runtime_line" ] &&
  [ "$runtime_line" -lt "$handoff_line" ] && [ "$handoff_line" -lt "$producer_line" ] &&
  [ "$producer_line" -lt "$validation_line" ] && [ "$validation_line" -lt "$smoke_line" ] &&
  [ "$smoke_line" -lt "$freshness_line" ] && [ "$freshness_line" -lt "$upload_line" ] ||
  fail "canary must preflight, build, prove, freshness-check, then retain one direct tree"

preflight_block="$(step_block "$CANARY_WORKFLOW" "Preflight the complete canonical bottle closure")"
grep -Fq '(.software["package"] // []) | length' <<<"$preflight_block" &&
  grep -Fq 'scripts/abi-staging-pages-producer.ts preflight' <<<"$preflight_block" &&
  grep -Fq -- '--tap-root "$KANDELO_PAGES_TAP_ROOT"' <<<"$preflight_block" &&
  grep -Fq -- '--formula-list "$formula_list"' <<<"$preflight_block" ||
  fail "canary must preflight the complete package-free canonical bottle closure"
inputs_block="$(step_block "$CANARY_WORKFLOW" "Materialize exact current product inputs")"
grep -Fq 'archive-files.json' <<<"$inputs_block" &&
  ! grep -Eq 'package|fetch-binaries' <<<"$inputs_block" ||
  fail "canary must materialize only declared archive files"
handoff_block="$(step_block "$CANARY_WORKFLOW" "Write the bounded production handoff")"
grep -Fq 'archive_files:' <<<"$handoff_block" &&
  grep -Fq 'program_index:' <<<"$handoff_block" &&
  ! grep -Eq 'package[_-]roots|package-output' <<<"$handoff_block" ||
  fail "canary handoff must contain no package-root authority"
producer_block="$(step_block "$CANARY_WORKFLOW" "Build the seven ABI products directly for shipping")"
grep -Fq 'scripts/abi-staging-pages-producer.ts ship' <<<"$producer_block" &&
  grep -Fq 'PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH' <<<"$producer_block" &&
  ! grep -Eq 'fixture|testDependencies|producer-fixture' <<<"$producer_block" ||
  fail "canary must invoke the direct production Pages shipping CLI"
validation_block="$(step_block "$CANARY_WORKFLOW" "Validate the direct shipping tree")"
grep -Fq 'shipping_mode == "direct-canonical-bottles"' <<<"$validation_block" &&
  grep -Fq 'Pages artifact differs from its exact site inventory' <<<"$validation_block" ||
  fail "canary must validate the exact direct shipping tree"
smoke_block="$(step_block "$CANARY_WORKFLOW" "Smoke-test the exact assembled ABI 43 site in Chromium")"
grep -Fq 'abi-staging-pages-assembled-site.spec.ts' <<<"$smoke_block" &&
  grep -Fq -- '--project=chromium' <<<"$smoke_block" ||
  fail "canary must smoke-test the exact assembled tree in Chromium"
freshness_block="$(step_block "$CANARY_WORKFLOW" "Confirm this is the newest Pages canary run")"
grep -Fq 'id: retention_freshness' <<<"$freshness_block" &&
  grep -Fq 'PAGES_WORKFLOW_FILE: abi-staging-pages-canary.yml' <<<"$freshness_block" &&
  grep -Fq 'GH_TOKEN: ${{ github.token }}' <<<"$freshness_block" ||
  fail "canary must retain only the newest exact run"
upload_block="$(step_block "$CANARY_WORKFLOW" "Upload the complete inert Pages canary")"
grep -Eq 'uses: actions/upload-pages-artifact@[0-9a-f]{40} # v[0-9]' <<<"$upload_block" &&
  grep -Fq "if: steps.retention_freshness.outputs.retain == 'true'" <<<"$upload_block" &&
  grep -Fxq '          path: ${{ runner.temp }}/abi-staging-pages-output/source-tree' <<<"$upload_block" &&
  grep -Fxq '          retention-days: 7' <<<"$upload_block" &&
  grep -Fxq '          include-hidden-files: true' <<<"$upload_block" ||
  fail "canary must upload one complete inert direct tree"
if grep -Eq 'actions/deploy-pages|git push|create-release|oras push' "$CANARY_WORKFLOW"; then
  fail "canary must never deploy or publish package state"
fi

production_header="$(sed -n '1,/^jobs:$/p' "$PAGES_WORKFLOW")"
production_top_permissions_count="$(
  awk '/^permissions:/ { count += 1 } END { print count + 0 }' \
    <<<"$production_header"
)"
[ "$production_top_permissions_count" -eq 1 ] &&
  grep -Fxq 'permissions: {}' <<<"$production_header" ||
  fail "production Pages workflow permissions must be empty"
grep -Fxq '  group: kandelo-pages-production' "$PAGES_WORKFLOW" &&
  grep -Fxq '  cancel-in-progress: true' "$PAGES_WORKFLOW" ||
  fail "production Pages must supersede older incomplete deployments"

production_job_names="$(
  awk '
    /^jobs:$/ { inside = 1; next }
    inside && /^  [A-Za-z0-9_.-]+:$/ {
      job = $1
      sub(/:$/, "", job)
      print job
    }
  ' "$PAGES_WORKFLOW"
)"
[ "$production_job_names" = $'build-complete-site\ndeploy-complete-site' ] ||
  fail "production Pages must have exactly one build job and one deploy job"

production_build_block="$(job_block "$PAGES_WORKFLOW" "build-complete-site")"
production_deploy_block="$(job_block "$PAGES_WORKFLOW" "deploy-complete-site")"
grep -Fxq '    runs-on: ubuntu-latest' <<<"$production_build_block" &&
  grep -Fxq '    timeout-minutes: 360' <<<"$production_build_block" ||
  fail "production Pages build must use the bounded GitHub-hosted runner"
production_build_permissions="$(
  awk '
    $0 == "    permissions:" { inside = 1 }
    inside && $0 == "    outputs:" { exit }
    inside { print }
  ' <<<"$production_build_block"
)"
grep -Fxq '      actions: read' <<<"$production_build_permissions" &&
  grep -Fxq '      contents: read' <<<"$production_build_permissions" &&
  [ "$(awk '/^      [A-Za-z-]+:/ { count += 1 } END { print count + 0 }' \
      <<<"$production_build_permissions")" -eq 2 ] ||
  fail "production Pages build permissions must be read-only"
grep -Fq 'steps.shipping.outputs.ready' <<<"$production_build_block" &&
  grep -Fq 'steps.publish_freshness.outputs.publish' <<<"$production_build_block" ||
  fail "production Pages deploy output must bind direct shipping and freshness"

activation_document="$(cat "$REPO_ROOT/abi/staging/pages-activation.toml")"
[ "$activation_document" = $'schema = 1\nkind = "kandelo-pages-activation"\nmode = "observe"' ] ||
  fail "inactive production Pages preparation must remain in observe mode"
activation_block="$(step_block "$PAGES_WORKFLOW" "Validate inactive Pages activation")"
for evidence in \
  'id: activation' \
  '[[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]' \
  '[[ "$GITHUB_REF" == refs/heads/main ]]' \
  '[[ "$REQUESTED_SOURCE_SHA" == "$GITHUB_SHA" ]]' \
  '[[ $(git rev-parse HEAD) == "$REQUESTED_SOURCE_SHA" ]]' \
  'observe) active=false' \
  'active) active=true' \
  'echo "active=$active" >>"$GITHUB_OUTPUT"'
do
  grep -Fq "$evidence" <<<"$activation_block" ||
    fail "production Pages activation must bind the exact protected main source"
done

production_checkout_block="$(
  step_block "$PAGES_WORKFLOW" "Check out the exact protected source commit"
)"
grep -Eq 'uses: actions/checkout@[0-9a-f]{40} # v[0-9]' \
  <<<"$production_checkout_block" &&
  grep -Fq 'ref: ${{ inputs.source_sha }}' <<<"$production_checkout_block" &&
  grep -Fq 'persist-credentials: false' <<<"$production_checkout_block" ||
  fail "production Pages must check out one exact uncredentialed source"
production_checkout_count="$(
  awk '/^[[:space:]]+uses: actions\/checkout@/ { count += 1 }
       END { print count + 0 }' "$PAGES_WORKFLOW"
)"
[ "$production_checkout_count" -eq 1 ] ||
  fail "production Pages must build every output from one checkout"
if grep -Eq 'candidate_tag|canonical_index_sha256|ghcr\.io/[^[:space:]]*-candidates/' \
    "$PAGES_WORKFLOW"; then
  fail "production Pages must not consume candidate artifact authority"
fi
production_inputs_block="$(
  step_block "$PAGES_WORKFLOW" "Materialize exact current product inputs"
)"
if grep -Eq 'software\.package|fetch-binaries\.sh|package-roots|package_roots|packages/registry/mariadb' \
    "$PAGES_WORKFLOW"; then
  fail "production Pages must not materialize Kandelo package roots"
fi
grep -Fq '.software.archive[]' <<<"$production_inputs_block" &&
  grep -Fq 'archive-files.json' <<<"$production_inputs_block" &&
  grep -Fq 'sha256sum --check --status' <<<"$production_inputs_block" ||
  fail "production Pages must materialize only exact declared archive files"

bottle_preflight_line="$(step_line "Preflight the complete canonical bottle closure")"
runtime_line="$(step_line "Prepare exact uncredentialed runtime")"
[ -n "$bottle_preflight_line" ] && [ -n "$runtime_line" ] &&
  [ "$bottle_preflight_line" -lt "$runtime_line" ] ||
  fail "production Pages must preflight every canonical bottle before runtime work"
bottle_preflight_block="$(
  step_block "$PAGES_WORKFLOW" "Preflight the complete canonical bottle closure"
)"
grep -Fq 'scripts/abi-staging-pages-producer.ts preflight' \
    <<<"$bottle_preflight_block" &&
  grep -Fq -- '--tap-root "$KANDELO_PAGES_TAP_ROOT"' \
    <<<"$bottle_preflight_block" &&
  grep -Fq -- '--formula-list "$formula_list"' <<<"$bottle_preflight_block" &&
  grep -Fq -- '--abi "$target_abi"' <<<"$bottle_preflight_block" ||
  fail "production Pages bottle preflight must bind the tap, Formula closure, and ABI"

production_handoff_block="$(
  step_block "$PAGES_WORKFLOW" "Write the bounded production handoff"
)"
if grep -Eq 'package[_-]roots|package_roots' <<<"$production_handoff_block"; then
  fail "production Pages handoff must not carry Kandelo package roots"
fi
grep -Fq 'current_inputs:' <<<"$production_handoff_block" &&
  grep -Fq 'archive_files:' <<<"$production_handoff_block" &&
  grep -Fq 'program_index:' <<<"$production_handoff_block" ||
  fail "production Pages handoff must carry only archive and program authorities"

producer_line="$(step_line "Build the seven ABI products directly for shipping")"
tree_line="$(step_line "Validate the direct shipping tree")"
chromium_line="$(step_line "Smoke-test the exact assembled ABI 43 site in Chromium")"
freshness_line="$(step_line "Confirm this is the newest Pages run")"
pages_upload_line="$(step_line "Upload the smoke-tested Pages deployment artifact")"
[ -n "$producer_line" ] && [ -n "$tree_line" ] &&
  [ -n "$chromium_line" ] && [ -n "$freshness_line" ] &&
  [ -n "$pages_upload_line" ] &&
  [ "$producer_line" -lt "$tree_line" ] &&
  [ "$tree_line" -lt "$chromium_line" ] &&
  [ "$chromium_line" -lt "$freshness_line" ] &&
  [ "$freshness_line" -lt "$pages_upload_line" ] ||
  fail "production Pages must build, validate, smoke-test, freshness-check, then upload one tree"
producer_block="$(step_block "$PAGES_WORKFLOW" "Build the seven ABI products directly for shipping")"
grep -Fq 'id: shipping' <<<"$producer_block" &&
  grep -Fq 'scripts/abi-staging-pages-producer.ts ship' <<<"$producer_block" &&
  grep -Fq 'pages_output="$RUNNER_TEMP/abi-staging-pages-output"' \
    <<<"$producer_block" &&
  grep -Fq -- '--output-root "$pages_output"' \
    <<<"$producer_block" &&
  grep -Fq 'echo "ready=true" >>"$GITHUB_OUTPUT"' <<<"$producer_block" ||
  fail "production Pages must run the direct seven-product shipping producer"
tree_block="$(step_block "$PAGES_WORKFLOW" "Validate the direct shipping tree")"
grep -Fq '.shipping_mode == "direct-canonical-bottles"' <<<"$tree_block" &&
  grep -Fq 'Pages artifact differs from its exact site inventory' \
    <<<"$tree_block" &&
  grep -Fq 'check-pages-publish-size.mjs "$site_root" 1000000000' \
    <<<"$tree_block" ||
  fail "production Pages must validate the direct exact tree before upload"
chromium_block="$(
  step_block "$PAGES_WORKFLOW" "Smoke-test the exact assembled ABI 43 site in Chromium"
)"
grep -Fq 'KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT="$RUNNER_TEMP/abi-staging-pages-output/source-tree"' \
    <<<"$chromium_block" &&
  grep -Fq 'apps/browser-demos/test/abi-staging-pages-assembled-site.spec.ts' \
    <<<"$chromium_block" &&
  grep -Fq -- '--project=chromium' <<<"$chromium_block" ||
  fail "production Pages must smoke-test the exact returned tree in Chromium"

freshness_block="$(step_block "$PAGES_WORKFLOW" "Confirm this is the newest Pages run")"
grep -Fq 'id: publish_freshness' <<<"$freshness_block" &&
  grep -Fq 'GH_TOKEN: ${{ github.token }}' <<<"$freshness_block" &&
  grep -Fq 'PAGES_WORKFLOW_FILE: browser-demos-pages.yml' <<<"$freshness_block" &&
  grep -Fq 'run: bash scripts/check-pages-run-freshness.sh' \
    <<<"$freshness_block" ||
  fail "production Pages must use the tested production freshness guard"

pages_upload_block="$(
  step_block "$PAGES_WORKFLOW" "Upload the smoke-tested Pages deployment artifact"
)"
grep -Fxq \
  "        if: steps.publish_freshness.outputs.publish == 'true'" \
  <<<"$pages_upload_block" &&
  grep -Fq 'uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0' \
    <<<"$pages_upload_block" &&
  grep -Fxq '          name: github-pages' <<<"$pages_upload_block" &&
  grep -Fxq \
    '          path: ${{ runner.temp }}/abi-staging-pages-output/source-tree' \
    <<<"$pages_upload_block" &&
  grep -Fxq '          include-hidden-files: true' <<<"$pages_upload_block" ||
  fail "production Pages must upload exactly one complete native Pages artifact"

grep -Fxq '    needs: build-complete-site' <<<"$production_deploy_block" &&
  grep -Fxq \
    "    if: needs.build-complete-site.outputs.deploy == 'true'" \
    <<<"$production_deploy_block" &&
  grep -Fxq '    runs-on: ubuntu-latest' <<<"$production_deploy_block" ||
  fail "native Pages deployment must consume only the successful build output"
production_deploy_permissions="$(
  awk '
    $0 == "    permissions:" { inside = 1 }
    inside && $0 == "    environment:" { exit }
    inside { print }
  ' <<<"$production_deploy_block"
)"
grep -Fxq '      pages: write' <<<"$production_deploy_permissions" &&
  grep -Fxq '      id-token: write' <<<"$production_deploy_permissions" &&
  [ "$(awk '/^      [A-Za-z-]+:/ { count += 1 } END { print count + 0 }' \
      <<<"$production_deploy_permissions")" -eq 2 ] ||
  fail "native Pages deployment permissions must contain only pages and id-token writes"
grep -Fxq '      name: github-pages' <<<"$production_deploy_block" &&
  grep -Fq 'url: ${{ steps.deployment.outputs.page_url }}' \
    <<<"$production_deploy_block" &&
  grep -Fq 'id: deployment' <<<"$production_deploy_block" &&
  grep -Fq 'uses: actions/deploy-pages@f29b9056696d8d80070d321737a6805413dbdea1 # v4.0.5' \
    <<<"$production_deploy_block" ||
  fail "native Pages deployment must use the pinned GitHub deployment action"
if grep -Eq '^[[:space:]]+(- )?run:|^[[:space:]]+uses: actions/(checkout|upload)' \
    <<<"$production_deploy_block"; then
  fail "native Pages deploy job must not rebuild or replace the proven artifact"
fi

if grep -Eq 'peaceiris/actions-gh-pages@|contents: write|git push.*gh-pages' \
    "$PAGES_WORKFLOW"; then
  fail "legacy branch publication must be absent from native Pages deployment"
fi
production_deploy_action_count="$(
  awk '/^[[:space:]]+uses: actions\/deploy-pages@/ { count += 1 }
       END { print count + 0 }' "$PAGES_WORKFLOW"
)"
[ "$production_deploy_action_count" -eq 1 ] ||
  fail "production Pages must contain exactly one native deploy action"
pages_writers="$(
  grep -lRE --include='*.yml' --include='*.yaml' \
    'actions/deploy-pages@|peaceiris/actions-gh-pages@|git push.*gh-pages' \
    "$WORKFLOWS_DIR" 2>/dev/null || true
)"
[ "$pages_writers" = "$PAGES_WORKFLOW" ] ||
  fail "exactly one workflow may publish GitHub Pages"

echo "ci-check-pages-deployment: ok"
