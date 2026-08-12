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
grep -Fxq '  push:' <<<"$trigger_block" &&
  grep -Fxq '    branches: [main]' <<<"$trigger_block" ||
  fail "the complete Pages publisher must run for every main push"
if grep -Eq '^  (pull_request|pull_request_target):' <<<"$trigger_block"; then
  fail "the Pages publisher must not deploy pull-request revisions"
fi
if grep -Eq '^[[:space:]]+(paths|paths-ignore):' <<<"$trigger_block"; then
  fail "the complete Pages publisher must not filter main pushes by path"
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
  [ "$isolation_line" -lt "$runtime_line" ] &&
  [ "$runtime_line" -lt "$inputs_line" ] &&
  [ "$inputs_line" -lt "$handoff_line" ] &&
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
grep -Fq 'ref: ${{ inputs.source_sha || github.sha }}' <<<"$checkout_block" ||
  fail "the Pages checkout must use the exact requested or event source SHA"
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
browser_build_line="$(step_line "Build browser demos for GitHub Pages")"
guide_build_line="$(step_line "Build user guide for the complete Pages tree")"
api_build_line="$(step_line "Build API docs for the complete Pages tree")"
assembly_line="$(step_line "Add documentation to the complete Pages tree")"
manifest_line="$(step_line "Record the deployed generation")"
flat_boot_line="$(step_line "Boot the canonical flat Pages shell in Chromium")"
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
  [ -n "$browser_build_line" ] &&
  [ "$package_products_line" -lt "$browser_build_line" ] &&
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
    <<<"$package_products_block" ||
  fail "Pages must bind the resolver-selected canonical shell and Node images"
grep -Fq 'scripts/inspect-canonical-flat-shell.test.ts' \
  <<<"$package_products_block" &&
  grep -Fq 'scripts/inspect-canonical-flat-shell.ts' \
    <<<"$package_products_block" &&
  grep -Fq -- '--selection homebrew/main-shell-flat-selection.json' \
    <<<"$package_products_block" &&
  grep -Fq -- '--shell-config homebrew/main-shell-default.json' \
    <<<"$package_products_block" &&
  grep -Fq -- '--demo-config homebrew/main-shell-flat-demo.json' \
    <<<"$package_products_block" ||
  fail "Pages must run the canonical flat-shell inspector and its rejection tests"
grep -Fq 'echo "shell_sha256=$(jq -er' \
  <<<"$package_products_block" &&
  grep -Fq \
    'echo "node_sha256=$(sha256sum "$node_image"' \
    <<<"$package_products_block" ||
  fail "Pages must record the exact canonical shell and Node digests"
for retired_input in \
  homebrew-bootstrap \
  main-shell-lazy-artifact-lock \
  verify-homebrew-main-shell-artifact-lock \
  inspect-homebrew-main-shell-public-product \
  recover-homebrew-bottle-mirror \
  mirror_plan_url \
  KANDELO_HOMEBREW_MAIN_SHELL_
do
  if grep -Fq "$retired_input" "$PAGES_WORKFLOW"; then
    fail "Pages retains retired lazy-shell input: $retired_input"
  fi
done

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
    <<<"$browser_build_block" ||
  fail "the Pages build must verify its exact hashed shell and Node assets"
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
  step_block "$PAGES_WORKFLOW" "Boot the canonical flat Pages shell in Chromium"
)"
grep -Fq 'VITE_BASE: /kandelo/' <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_BROWSER_DEMO_INPUTS: main' \
    <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_CANONICAL_FLAT_SHELL_STRICT: "1"' \
    <<<"$flat_boot_block" &&
  grep -Fq \
    'KANDELO_CANONICAL_FLAT_SHELL_SHA256: ${{ steps.package_products.outputs.shell_sha256 }}' \
    <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_PLAYWRIGHT_SERVE_DIST: "1"' <<<"$flat_boot_block" &&
  grep -Fq 'KANDELO_TEST_BASE_URL: http://127.0.0.1:5401/kandelo/' \
    <<<"$flat_boot_block" &&
  grep -Fq 'bash ../../scripts/dev-shell.sh env \' <<<"$flat_boot_block" &&
  grep -Fq 'test/kandelo-canonical-flat-shell.spec.ts' \
    <<<"$flat_boot_block" &&
  grep -Fq -- '--project=chromium' <<<"$flat_boot_block" ||
  fail "the Pages preview must prove the canonical flat shell at the published base"
for binding in \
  '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
  '"VITE_BASE=$VITE_BASE" \' \
  '"KANDELO_BROWSER_DEMO_INPUTS=$KANDELO_BROWSER_DEMO_INPUTS" \' \
  '"KANDELO_CANONICAL_FLAT_SHELL_STRICT=$KANDELO_CANONICAL_FLAT_SHELL_STRICT" \' \
  '"KANDELO_CANONICAL_FLAT_SHELL_SHA256=$KANDELO_CANONICAL_FLAT_SHELL_SHA256" \' \
  '"KANDELO_PLAYWRIGHT_SERVE_DIST=$KANDELO_PLAYWRIGHT_SERVE_DIST" \' \
  '"KANDELO_TEST_BASE_URL=$KANDELO_TEST_BASE_URL" \'
do
  grep -Fq "$binding" <<<"$flat_boot_block" ||
    fail "the flat-shell preview must carry its exact inputs through dev-shell"
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
  grep -Fq -- "--grep 'Kandelo Node demo installs cowsay with npm'" \
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
if grep -Fq 'PAGES_WORKFLOW_FILE' "$PAGES_WORKFLOW"; then
  fail "production newest-run guard must query only the production workflow"
fi

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
