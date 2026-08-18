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
handoff_line="$(
  workflow_step_line "$CANARY_WORKFLOW" "Write the bounded production handoff"
)"
producer_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Produce admitted canonical Pages products"
)"
readiness_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Validate Pages readiness and select ready or hold"
)"
site_validation_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Validate the complete canonical Pages tree"
)"
canary_freshness_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Confirm this is the newest Pages canary run"
)"
canary_hold_upload_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Upload the incomplete Pages hold"
)"
canary_ready_upload_line="$(
  workflow_step_line "$CANARY_WORKFLOW" \
    "Upload the complete inert Pages canary"
)"
[ -n "$authority_line" ] && [ -n "$isolation_line" ] &&
  [ -n "$runtime_line" ] &&
  [ -n "$inputs_line" ] &&
  [ -n "$handoff_line" ] && [ -n "$producer_line" ] &&
  [ -n "$readiness_line" ] && [ -n "$site_validation_line" ] &&
  [ -n "$canary_freshness_line" ] &&
  [ -n "$canary_hold_upload_line" ] &&
  [ -n "$canary_ready_upload_line" ] &&
  [ "$authority_line" -lt "$isolation_line" ] &&
  [ "$isolation_line" -lt "$inputs_line" ] &&
  [ "$inputs_line" -lt "$runtime_line" ] &&
  [ "$inputs_line" -lt "$handoff_line" ] &&
  [ "$runtime_line" -lt "$handoff_line" ] &&
  [ "$handoff_line" -lt "$producer_line" ] &&
  [ "$producer_line" -lt "$readiness_line" ] &&
  [ "$readiness_line" -lt "$site_validation_line" ] &&
  [ "$site_validation_line" -lt "$canary_freshness_line" ] &&
  [ "$canary_freshness_line" -lt "$canary_hold_upload_line" ] &&
  [ "$canary_hold_upload_line" -lt "$canary_ready_upload_line" ] ||
  fail "canary must produce, select ready or hold, freshness-check, then retain one result"

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
    <<<"$playwright_install_block" &&
  ! grep -Fq -- '--with-deps' <<<"$playwright_install_block" ||
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
  grep -Fq -- '--build-policy-sha256 "$policy_sha"' <<<"$runtime_block" &&
  grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    <<<"$runtime_block" &&
  grep -Fq -- '--binary-cache-root "$WASM_POSIX_BINARY_CACHE_ROOT"' \
    <<<"$runtime_block" ||
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
if grep -Fq 'prepare-homebrew-browser-bootstrap.sh' <<<"$inputs_block" ||
   grep -Fq -- '--require-sealed-homebrew-selection' <<<"$inputs_block"; then
  fail "canary must not depend on the retired sealed shell selection"
fi
if grep -Fq -- '--force-source-build' <<<"$inputs_block" ||
   grep -Fq -- '--source-rootfs-shell' <<<"$inputs_block"; then
  fail "canary input materialization must use resolver-owned package roots"
fi

grep -Fq 'fetch_args=(--fetch-only)' <<<"$inputs_block" &&
  ! grep -Fq -- '--allow-stale' <<<"$inputs_block" ||
  fail "canary must fail immediately when a selected package root is missing"
grep -Fq 'fetch_args+=(--package "$package")' <<<"$inputs_block" &&
  grep -Fq 'bash scripts/fetch-binaries.sh "${fetch_args[@]}"' \
    <<<"$inputs_block" &&
  grep -Fq 'if [ "$package" != homebrew-bootstrap ]; then' \
    <<<"$inputs_block" &&
  grep -Fq 'bash scripts/fetch-binaries.sh --package homebrew-bootstrap' \
    <<<"$inputs_block" &&
  [ "$(grep -Fc 'bash scripts/fetch-binaries.sh' <<<"$inputs_block")" -eq 2 ] &&
  grep -Fq '"$xtask" build-deps --arch wasm32 path "$package"' \
    <<<"$inputs_block" &&
  grep -Fq '[ -d "$package_root" ] && [ ! -L "$package_root" ]' \
    <<<"$inputs_block" ||
  fail "canary must materialize homebrew-bootstrap from current protected source"
if grep -Fq 'browser-binary-package-roots.mjs' <<<"$inputs_block" ||
   grep -Fq 'browser_fetch_args' <<<"$inputs_block" ||
   grep -Fq 'bash scripts/build-musl.sh' <<<"$inputs_block" ||
   grep -Fq './run.sh' <<<"$inputs_block"; then
  fail "canonical Pages must not source-build legacy browser programs"
fi
grep -Fq 'bootstrap_path=$(bash scripts/resolve-binary.sh \' \
  <<<"$inputs_block" &&
  grep -Fq 'programs/homebrew-bootstrap/homebrew-bootstrap.zip)' \
    <<<"$inputs_block" &&
  grep -Fq 'bash scripts/stage-homebrew-bootstrap-browser-asset.sh \' \
    <<<"$inputs_block" ||
  fail "canary must stage the exact current Homebrew bootstrap directly"
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
[ "$candidate_rejection_count" -eq 3 ] ||
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

readiness_block="$(
  step_block "$CANARY_WORKFLOW" \
    "Validate Pages readiness and select ready or hold"
)"
check_filtered_host_target "$readiness_block" "canary readiness"
if grep -Eq 'site-manifest\.json|source-tree' <<<"$readiness_block"; then
  fail "canary hold must never inspect a site manifest or source tree"
fi
grep -Fq 'id: readiness' <<<"$readiness_block" &&
  grep -Fq 'abi-staging pages-readiness validate-readiness "$readiness"' \
    <<<"$readiness_block" &&
  grep -Fq 'if .ready == true then "true"' <<<"$readiness_block" &&
  grep -Fq 'elif .ready == false then "false"' <<<"$readiness_block" &&
  grep -Fq 'echo "ready=$ready" >>"$GITHUB_OUTPUT"' \
    <<<"$readiness_block" ||
  fail "canary must validate readiness before selecting ready or hold"
readiness_lstat_line="$(
  grep -nF 'metadata = os.lstat(sys.argv[1])' <<<"$readiness_block" |
    head -n 1 | cut -d: -f1 || true
)"
readiness_regular_line="$(
  grep -nF 'if not stat.S_ISREG(metadata.st_mode):' <<<"$readiness_block" |
    head -n 1 | cut -d: -f1 || true
)"
readiness_size_line="$(
  grep -nF 'if metadata.st_size <= 0 or metadata.st_size > 16777216:' \
    <<<"$readiness_block" | head -n 1 | cut -d: -f1 || true
)"
readiness_validator_line="$(
  grep -nF 'abi-staging pages-readiness validate-readiness "$readiness"' \
    <<<"$readiness_block" | head -n 1 | cut -d: -f1 || true
)"
[ -n "$readiness_lstat_line" ] && [ -n "$readiness_regular_line" ] &&
  [ -n "$readiness_size_line" ] && [ -n "$readiness_validator_line" ] &&
  [ "$readiness_lstat_line" -lt "$readiness_regular_line" ] &&
  [ "$readiness_regular_line" -lt "$readiness_size_line" ] &&
  [ "$readiness_size_line" -lt "$readiness_validator_line" ] ||
  fail "canary must preflight one bounded regular readiness file before semantic validation"
grep -Fq "registry=\"$exact_pages_registry\"" <<<"$readiness_block" &&
  grep -Fq '.ready == $ready' <<<"$readiness_block" &&
  grep -Fq '($registry[0].products | map(.id))' <<<"$readiness_block" &&
  grep -Fq '(tostring | contains("-candidates/") | not)' \
    <<<"$readiness_block" ||
  fail "canary readiness must bind the exact current source and registry"
hold_validation_block="$(
  awk '
    /          if \[ "\$ready" = false \]; then/ { inside = 1 }
    inside && /          fi/ { print; exit }
    inside { print }
  ' <<<"$readiness_block"
)"
grep -Fq "[ \"\$hold_inventory\" = '[\"readiness.json\"]' ]" \
  <<<"$hold_validation_block" ||
  fail "canary hold must validate exactly one readiness file"
grep -Fq 'root.rglob("*")' <<<"$hold_validation_block" &&
  grep -Fq 'path.relative_to(root).as_posix()' \
    <<<"$hold_validation_block" ||
  fail "canary hold must exhaustively inventory its actual output"
hold_inventory_program="$(
  awk '
    /hold_inventory=.*python3 .*<<'"'"'PY'"'"'/ { program = 1; next }
    program && $0 == "          PY" { exit }
    program {
      sub(/^          /, "")
      print
    }
  ' <<<"$hold_validation_block"
)"
[ -n "$hold_inventory_program" ] ||
  fail "canary hold must exhaustively inventory its actual output"
hold_fixture="$CHECK_ROOT/hold-output"
mkdir "$hold_fixture"
printf '{}\n' >"$hold_fixture/readiness.json"
hold_inventory="$(python3 -c "$hold_inventory_program" "$hold_fixture")" ||
  fail "canary hold inventory traversal failed"
[ "$hold_inventory" = '["readiness.json"]' ] ||
  fail "canary hold must exhaustively inventory its actual output"
printf '{}\n' >"$hold_fixture/unexpected.json"
hold_inventory="$(python3 -c "$hold_inventory_program" "$hold_fixture")" ||
  fail "canary hold inventory traversal failed"
[ "$hold_inventory" = '["readiness.json","unexpected.json"]' ] ||
  fail "canary hold must exhaustively inventory its actual output"
grep -Fq 'readiness_sha=$(sha256sum "$readiness"' \
  <<<"$hold_validation_block" &&
  grep -Fq "blockers=\$(jq -cS '.blockers' \"\$readiness\")" \
    <<<"$hold_validation_block" &&
  grep -Fq '### Pages canary hold' <<<"$hold_validation_block" &&
  grep -Fq '>>"$GITHUB_STEP_SUMMARY"' <<<"$hold_validation_block" ||
  fail "canary hold must summarize its exact digest and blockers"

validation_block="$(
  step_block "$CANARY_WORKFLOW" \
    "Validate the complete canonical Pages tree"
)"
check_filtered_host_target "$validation_block" "canary site validation"
grep -Fq "registry=\"$exact_pages_registry\"" <<<"$validation_block" ||
  fail "canary must bind the exact protected Pages registry"
grep -Fxq "        if: steps.readiness.outputs.ready == 'true'" \
  <<<"$validation_block" ||
  fail "canary ready validation must require validated readiness"
grep -Fq \
    'tap_commit=$(git -C "$KANDELO_PAGES_TAP_ROOT" rev-parse HEAD)' \
    <<<"$validation_block" &&
  grep -Fq \
    'tap_tree=$(git -C "$KANDELO_PAGES_TAP_ROOT" rev-parse '\''HEAD^{tree}'\'')' \
    <<<"$validation_block" &&
  grep -Fq -- '--argjson tap_source "$tap_source"' \
    <<<"$validation_block" ||
  fail "canary ready validation must bind the exact protected tap source"
grep -Fq 'abi-staging pages-readiness validate-site "$site_manifest"' \
    <<<"$validation_block" &&
  grep -Fq '.ready == true' <<<"$validation_block" &&
  grep -Fq '.blockers == []' <<<"$validation_block" &&
  grep -Fq '($registry[0].products | map(.id))' <<<"$validation_block" &&
  grep -Fq '(.node_receipts | length > 0)' <<<"$validation_block" &&
  grep -Fq '(.browser_receipts | length > 0)' <<<"$validation_block" ||
  fail "canary must require every product Node and browser receipt"
ready_filter="$(awk '
  /--slurpfile registry "\$registry"/ { filter = 1; next }
  filter && /"\$readiness" >\/dev\/null$/ { exit }
  filter {
    sub(/^              /, "")
    print
  }
' <<<"$validation_block")"
[ -n "$ready_filter" ] ||
  fail "canary ready validation filter is missing"
ready_fixture="$CHECK_ROOT/ready-filter"
mkdir "$ready_fixture"
cat >"$ready_fixture/registry.json" <<'JSON'
{"products":[{"id":"mini","load":"eager"}]}
JSON
cat >"$ready_fixture/readiness.json" <<'JSON'
{"blockers":[],"products":[{"admissions":[{"projection":{"admission_record_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","tap_source":{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repository":"kandelo-dev/homebrew-tap-core","tree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}},"record_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"browser_receipts":[{"receipt":"browser"}],"id":"mini","node_receipts":[{"receipt":"node"}]}],"ready":true}
JSON
ready_tap_source='{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repository":"kandelo-dev/homebrew-tap-core","tree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
if ! jq -e \
    --argjson tap_source "$ready_tap_source" \
    --slurpfile registry "$ready_fixture/registry.json" \
    "$ready_filter" "$ready_fixture/readiness.json" >/dev/null; then
  fail "canary ready validation filter must execute against a valid ready fixture"
fi
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
grep -Fq 'id: retention_freshness' <<<"$canary_freshness_block" &&
  grep -Fq 'GH_TOKEN: ${{ github.token }}' <<<"$canary_freshness_block" ||
  fail "canary newest-run guard must retain read-only Actions authority"
grep -Fq 'PAGES_WORKFLOW_FILE: abi-staging-pages-canary.yml' \
  <<<"$canary_freshness_block" ||
  fail "canary newest-run guard must query only the canary workflow"
grep -Fq 'run: bash scripts/check-pages-run-freshness.sh' \
  <<<"$canary_freshness_block" ||
  fail "canary retention authority must come from the tested newest-run checker"

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

canary_hold_artifact_count="$(
  awk '/^[[:space:]]+uses: actions\/upload-artifact@/ { count += 1 }
       END { print count + 0 }' "$CANARY_WORKFLOW"
)"
[ "$canary_hold_artifact_count" -eq 1 ] ||
  fail "canary hold must use one ordinary bounded artifact"
canary_hold_upload_block="$(
  step_block "$CANARY_WORKFLOW" "Upload the incomplete Pages hold"
)"
grep -Fxq \
  '        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1' \
  <<<"$canary_hold_upload_block" &&
  grep -Fxq \
    "        if: steps.readiness.outputs.ready == 'false' && steps.retention_freshness.outputs.retain == 'true'" \
    <<<"$canary_hold_upload_block" &&
  grep -Fxq \
    '          path: ${{ runner.temp }}/abi-staging-pages-output/readiness.json' \
    <<<"$canary_hold_upload_block" &&
  grep -Fxq '          retention-days: 7' <<<"$canary_hold_upload_block" &&
  grep -Fxq '          if-no-files-found: error' \
    <<<"$canary_hold_upload_block" &&
  grep -Fq 'name: abi-staging-pages-hold-${{ github.run_id }}' \
    <<<"$canary_hold_upload_block" ||
  fail "canary hold must use one ordinary bounded artifact"
if grep -Eq 'site-manifest\.json|source-tree|upload-pages-artifact@' \
    <<<"$canary_hold_upload_block"; then
  fail "canary hold must never inspect a site manifest or source tree"
fi

canary_pages_artifact_count="$(
  awk '/^[[:space:]]+uses: actions\/upload-pages-artifact@/ { count += 1 }
       END { print count + 0 }' "$CANARY_WORKFLOW"
)"
[ "$canary_pages_artifact_count" -eq 1 ] ||
  fail "canary must upload exactly one inert Pages artifact"
canary_upload_block="$(
  step_block "$CANARY_WORKFLOW" "Upload the complete inert Pages canary"
)"
grep -Fxq \
  '        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0' \
  <<<"$canary_upload_block" ||
  fail "canary must upload exactly one inert Pages artifact"
grep -Fxq \
  "        if: steps.readiness.outputs.ready == 'true' && steps.retention_freshness.outputs.retain == 'true'" \
  <<<"$canary_upload_block" ||
  fail "canary ready upload must require validated readiness and newest-run authority"
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
  sed -n "${canary_freshness_line},${canary_ready_upload_line}p" \
    "$CANARY_WORKFLOW" |
    awk '/^      - name:/ { count += 1 } END { print count + 0 }'
)"
[ "$between_canary_freshness_and_upload" -eq 3 ] ||
  fail "canary newest-run guard must be immediately before its two result uploads"
canary_if_count="$(
  awk '/^[[:space:]]+if:/ { count += 1 } END { print count + 0 }' \
    "$CANARY_WORKFLOW"
)"
[ "$canary_if_count" -eq 3 ] ||
  fail "canary pre-upload work must remain success-gated"

[ -f "$PAGES_PLAN" ] && [ -f "$BROWSER_SUPPORT" ] ||
  fail "Pages sequencing documentation is missing"
perl -0777 -e '
  $text = <>;
  $text =~ s/\s+/ /g;
  exit(index(
    $text,
    "Before successor admissions exist, the canary produces a hosted hold for inactive Task 10 preparation.",
  ) >= 0 ? 0 : 1);
' "$PAGES_PLAN" &&
  perl -0777 -e '
    $text = <>;
    $text =~ s/\s+/ /g;
    exit(index(
      $text,
      "The expected pre-admission run is a hosted hold for inactive Task 10 preparation",
    ) >= 0 ? 0 : 1);
  ' "$BROWSER_SUPPORT" ||
  fail "Pages sequencing must keep the first hosted hold separate from readiness"
for document in "$PAGES_PLAN" "$BROWSER_SUPPORT"; do
  perl -0777 -e '
    $text = <>;
    $text =~ s/\s+/ /g;
    $position = 0;
    for $phrase (
      "hosted hold for inactive Task 10 preparation",
      "successor promotion and admissions",
      "rerun the canary",
      "ready result",
      "activation and deployment",
    ) {
      $position = index($text, $phrase, $position);
      exit 1 if $position < 0;
      $position += length($phrase);
    }
  ' "$document" ||
    fail "Pages sequencing must keep the first hosted hold separate from readiness"
done

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
grep -Fq 'packages/registry/mariadb/package.toml' <<<"$production_inputs_block" &&
  grep -Fq '.kandelo-vfs-source-roles/system-tables' <<<"$production_inputs_block" &&
  grep -Fq 'mysql_system_tables.sql' <<<"$production_inputs_block" &&
  grep -Fq 'mysql_system_tables_data.sql' <<<"$production_inputs_block" &&
  grep -Fq 'echo "$mariadb_sha  $mariadb_archive" | sha256sum --check --status' \
    <<<"$production_inputs_block" ||
  fail "production Pages must supply the pinned MariaDB system-table role"

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
