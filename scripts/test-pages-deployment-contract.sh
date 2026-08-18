#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$REPO_ROOT/scripts/ci-check-pages-deployment.sh"
PAGES_WORKFLOW_REL=".github/workflows/browser-demos-pages.yml"
PAGES_WORKFLOW="$REPO_ROOT/$PAGES_WORKFLOW_REL"
CANARY_WORKFLOW_REL=".github/workflows/abi-staging-pages-canary.yml"
CANARY_WORKFLOW="$REPO_ROOT/$CANARY_WORKFLOW_REL"
ATOMIC_GATE_REL="scripts/test-abi-staging-pages-atomic.sh"
ATOMIC_GATE="$REPO_ROOT/$ATOMIC_GATE_REL"
PAGES_PLAN_REL="docs/superpowers/plans/2026-08-08-abi-staging-promotion-pages-and-retirement.md"
PAGES_PLAN="$REPO_ROOT/$PAGES_PLAN_REL"
SUITE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-pages-contract.XXXXXX")"

cleanup() {
  case "$SUITE_ROOT" in
    "${TMPDIR:-/tmp}"/kandelo-pages-contract.*)
      rm -rf -- "$SUITE_ROOT"
      ;;
  esac
}
trap cleanup EXIT

fail() {
  echo "test-pages-deployment-contract: $*" >&2
  exit 1
}

new_fixture() {
  local fixture
  fixture="$(mktemp -d "$SUITE_ROOT/case.XXXXXX")"
  mkdir -p "$fixture/.github"
  cp -R "$REPO_ROOT/.github/workflows" "$fixture/.github/workflows"
  mkdir -p "$fixture/abi/staging"
  cp "$REPO_ROOT/abi/staging/pages-activation.toml" \
    "$fixture/abi/staging/pages-activation.toml"
  mkdir -p "$fixture/docs/superpowers/plans"
  mkdir -p "$fixture/scripts"
  cp "$ATOMIC_GATE" "$fixture/$ATOMIC_GATE_REL"
  cp "$PAGES_PLAN" "$fixture/$PAGES_PLAN_REL"
  cp "$REPO_ROOT/docs/browser-support.md" "$fixture/docs/browser-support.md"
  printf '%s\n' "$fixture"
}

expect_atomic_gate_mutation_rejected() {
  local label="$1"
  local expected_error="$2"
  local expression="$3"
  local fixture
  local target
  local output

  fixture="$(new_fixture)"
  target="$fixture/$ATOMIC_GATE_REL"
  perl -0pi -e "$expression" "$target"
  cmp -s "$ATOMIC_GATE" "$target" &&
    fail "fixture mutation did not change the atomic gate: $label"

  if output="$(bash "$CHECKER" "$fixture" 2>&1)"; then
    fail "checker accepted invalid atomic gate: $label"
  fi
  grep -Fq "$expected_error" <<<"$output" ||
    fail "checker rejected atomic gate '$label' unexpectedly: $output"
  echo "test-pages-deployment-contract: rejected atomic gate $label"
}

expect_atomic_chromium_gate_required() {
  expect_atomic_gate_mutation_rejected \
    "wrong assembled-site Chromium spec" \
    "atomic gate must run the exact assembled-site Chromium proof" \
    's#apps/browser-demos/test/abi-staging-pages-assembled-site\.spec\.ts#apps/browser-demos/test/not-the-assembled-site.spec.ts#'
  expect_atomic_gate_mutation_rejected \
    "dead assembled-site Chromium commands" \
    "atomic gate must run the exact assembled-site Chromium proof" \
    's#\nrun_assembled_chromium_gate\nif \[#\nif false; then\n  run_assembled_chromium_gate\nfi\nif [#'
  expect_atomic_gate_mutation_rejected \
    "wrong assembled-site producer selection" \
    "atomic gate must run the exact assembled-site Chromium proof" \
    "s#produces one exact seven-product assembled-site fixture for Chromium#not the exact assembled-site producer#"
  expect_atomic_gate_mutation_rejected \
    "listed but unexecuted assembled-site Chromium tests" \
    "atomic gate must run the exact assembled-site Chromium proof" \
    's#    --project=chromium#    --project=chromium --list#'
}

expect_mutation_rejected() {
  local label="$1"
  local expected_error="$2"
  local expression="$3"
  local fixture
  local target
  local output

  fixture="$(new_fixture)"
  target="$fixture/$PAGES_WORKFLOW_REL"
  perl -0pi -e "$expression" "$target"
  cmp -s "$PAGES_WORKFLOW" "$target" &&
    fail "fixture mutation did not change the workflow: $label"

  if output="$(bash "$CHECKER" "$fixture" 2>&1)"; then
    fail "checker accepted invalid workflow: $label"
  fi
  grep -Fq "$expected_error" <<<"$output" ||
    fail "checker rejected '$label' for an unexpected reason: $output"
  echo "test-pages-deployment-contract: rejected $label"
}

expect_canary_mutation_rejected() {
  local label="$1"
  local expected_error="$2"
  local expression="$3"
  local fixture
  local target
  local output

  fixture="$(new_fixture)"
  target="$fixture/$CANARY_WORKFLOW_REL"
  [ -f "$target" ] ||
    fail "native Pages canary fixture is absent: $CANARY_WORKFLOW_REL"
  perl -0pi -e "$expression" "$target"
  cmp -s "$CANARY_WORKFLOW" "$target" &&
    fail "fixture mutation did not change the canary workflow: $label"

  if output="$(bash "$CHECKER" "$fixture" 2>&1)"; then
    fail "checker accepted invalid canary workflow: $label"
  fi
  grep -Fq "$expected_error" <<<"$output" ||
    fail "checker rejected canary '$label' for an unexpected reason: $output"
  echo "test-pages-deployment-contract: rejected canary $label"
}

expect_activation_mutation_rejected() {
  local label="$1"
  local expected_error="$2"
  local expression="$3"
  local fixture
  local target
  local output

  fixture="$(new_fixture)"
  target="$fixture/abi/staging/pages-activation.toml"
  perl -0pi -e "$expression" "$target"
  cmp -s "$REPO_ROOT/abi/staging/pages-activation.toml" "$target" &&
    fail "fixture mutation did not change Pages activation: $label"

  if output="$(bash "$CHECKER" "$fixture" 2>&1)"; then
    fail "checker accepted invalid Pages activation: $label"
  fi
  grep -Fq "$expected_error" <<<"$output" ||
    fail "checker rejected Pages activation '$label' unexpectedly: $output"
  echo "test-pages-deployment-contract: rejected Pages activation $label"
}

expect_plan_mutation_rejected() {
  local label="$1"
  local expected_error="$2"
  local expression="$3"
  local fixture
  local target
  local output

  fixture="$(new_fixture)"
  target="$fixture/$PAGES_PLAN_REL"
  perl -0pi -e "$expression" "$target"
  cmp -s "$PAGES_PLAN" "$target" &&
    fail "fixture mutation did not change the Pages plan: $label"

  if output="$(bash "$CHECKER" "$fixture" 2>&1)"; then
    fail "checker accepted invalid Pages plan: $label"
  fi
  grep -Fq "$expected_error" <<<"$output" ||
    fail "checker rejected Pages plan '$label' unexpectedly: $output"
  echo "test-pages-deployment-contract: rejected Pages plan $label"
}

workflow_step_block() {
  local workflow="$1"
  local step="$2"
  awk -v step="$step" '
    $0 == "      - name: " step { inside = 1 }
    inside && $0 ~ /^      - name:/ &&
      $0 != "      - name: " step { exit }
    inside { print }
  ' "$workflow"
}

workflow_step_script() {
  local workflow="$1"
  local step="$2"
  workflow_step_block "$workflow" "$step" |
    awk '
      $0 == "        run: |" { script = 1; next }
      script {
        sub(/^          /, "")
        print
      }
    '
}

expect_ready_filter_executes() {
  local validation_block
  local ready_filter
  local fixture="$SUITE_ROOT/ready-filter"
  local tap_source
  local -a jq_args
  local output

  mkdir -p "$fixture"
  validation_block="$(workflow_step_block \
    "$CANARY_WORKFLOW" "Validate the complete canonical Pages tree")"
  ready_filter="$(awk '
    /--slurpfile registry "\$registry"/ { filter = 1; next }
    filter && /"\$readiness" >\/dev\/null$/ { exit }
    filter {
      sub(/^              /, "")
      print
    }
  ' <<<"$validation_block")"
  [ -n "$ready_filter" ] ||
    fail "could not extract the canary ready jq filter"
  tap_source='{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repository":"kandelo-dev/homebrew-tap-core","tree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
  cat >"$fixture/registry.json" <<'JSON'
{"products":[{"id":"mini","load":"eager"}]}
JSON
  cat >"$fixture/readiness.json" <<'JSON'
{"blockers":[],"products":[{"admissions":[{"projection":{"admission_record_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","tap_source":{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repository":"kandelo-dev/homebrew-tap-core","tree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}},"record_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],"browser_receipts":[{"receipt":"browser"}],"id":"mini","node_receipts":[{"receipt":"node"}]}],"ready":true}
JSON
  jq_args=(--slurpfile registry "$fixture/registry.json")
  if grep -Fq -- '--argjson tap_source "$tap_source"' \
      <<<"$validation_block"; then
    jq_args+=(--argjson tap_source "$tap_source")
  fi
  if ! output="$(jq -e "${jq_args[@]}" "$ready_filter" \
      "$fixture/readiness.json" 2>&1)"; then
    fail "the extracted canary ready jq filter rejected a valid ready fixture: $output"
  fi
}

expect_invalid_readiness_rejected_before_semantics() {
  local kind="$1"
  local fixture
  local fake_bin
  local marker
  local readiness
  local step_script

  fixture="$(mktemp -d "$SUITE_ROOT/preflight-${kind}.XXXXXX")"
  fake_bin="$fixture/bin"
  marker="$fixture/semantic-validator-reached"
  readiness="$fixture/abi-staging-pages-output/readiness.json"
  mkdir -p "$fake_bin" "$(dirname "$readiness")"
  case "$kind" in
    symlink)
      printf '{}\n' >"$fixture/readiness-target.json"
      ln -s "$fixture/readiness-target.json" "$readiness"
      ;;
    fifo)
      mkfifo "$readiness"
      ;;
    oversize)
      truncate -s 16777217 "$readiness"
      ;;
    *)
      fail "unknown readiness preflight case: $kind"
      ;;
  esac
  cat >"$fake_bin/git" <<'SH'
#!/bin/bash
set -euo pipefail
case "$*" in
  "rev-parse HEAD^{tree}")
    printf '%040d\n' 1
    ;;
  *"rev-parse HEAD")
    printf '%040d\n' 2
    ;;
  *"rev-parse HEAD^{tree}")
    printf '%040d\n' 3
    ;;
  *)
    echo "fake git: unexpected arguments: $*" >&2
    exit 64
    ;;
esac
SH
  cat >"$fake_bin/bash" <<'SH'
#!/bin/bash
set -euo pipefail
if [[ "$*" == *"rustc -vV"* ]]; then
  echo fake-host
  exit 0
fi
if [[ "$*" == *"pages-readiness validate-readiness"* ]]; then
  : >"$READINESS_VALIDATOR_MARKER"
  exit 97
fi
echo "fake bash: unexpected arguments: $*" >&2
exit 64
SH
  chmod +x "$fake_bin/git" "$fake_bin/bash"
  step_script="$(workflow_step_script \
    "$CANARY_WORKFLOW" "Validate Pages readiness and select ready or hold")"
  [ -n "$step_script" ] || fail "could not extract the readiness step"
  set +e
  env \
      PATH="$fake_bin:$PATH" \
      RUNNER_TEMP="$fixture" \
      KANDELO_PAGES_TAP_ROOT="$fixture/tap" \
      GITHUB_REPOSITORY=Automattic/kandelo \
      GITHUB_SHA=4444444444444444444444444444444444444444 \
      GITHUB_OUTPUT="$fixture/github-output" \
      GITHUB_STEP_SUMMARY="$fixture/summary" \
      READINESS_VALIDATOR_MARKER="$marker" \
      /bin/bash -s <<<"$step_script" >"$fixture/run.log" 2>&1
  local status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    fail "the canary readiness step accepted a $kind readiness path"
  fi
  if [ -e "$marker" ]; then
    fail "the semantic readiness validator was reached before $kind preflight (size $(python3 -c 'import os,sys; print(os.lstat(sys.argv[1]).st_size)' "$readiness")): $(tr '\n' ' ' <"$fixture/run.log")"
  fi
}

expect_prebranch_site_read_rejected() {
  expect_canary_mutation_rejected \
    "unconditional pre-branch site read" \
    "canary hold must never inspect a site manifest or source tree" \
    's/(          if \[ "\$ready" = false \]; then\n)/            jq -e . "\$pages_output\/site-manifest.json"\n$1/'
}

expect_hardcoded_hold_inventory_rejected() {
  expect_canary_mutation_rejected \
    "hard-coded hold inventory" \
    "canary hold must exhaustively inventory its actual output" \
    's/            hold_inventory=\$\(python3 - "\$pages_output" <<'\''PY'\''.*?            \)\n/            hold_inventory='\''["readiness.json"]'\''\n/s'
}

expect_current_bootstrap_input_required() {
  expect_canary_mutation_rejected \
    "missing transitional bootstrap build" \
    "canary must materialize homebrew-bootstrap from current protected source" \
    's#bash scripts/fetch-binaries\.sh --package homebrew-bootstrap#bash scripts/fetch-binaries.sh --fetch-only --package homebrew-bootstrap#'
  expect_canary_mutation_rejected \
    "restored legacy sealed selection" \
    "canary must not depend on the retired sealed shell selection" \
    's#(          bash scripts/stage-homebrew-bootstrap-browser-asset\.sh \\\n)#$1          ./run.sh --already-materialized --require-sealed-homebrew-selection prepare-browser\n#'
}

expect_direct_package_selection_required() {
  grep -Fq 'fetch_args=(--fetch-only)' "$CANARY_WORKFLOW" ||
    fail "canary must fail immediately when a selected package root is missing"
  expect_canary_mutation_rejected \
    "stale selected package fetch" \
    "canary must fail immediately when a selected package root is missing" \
    's/fetch_args=\(--fetch-only\)/fetch_args=(--fetch-only --allow-stale)/'
  expect_canary_mutation_rejected \
    "repeated broad package fetch" \
    "canary must materialize only the required main-page package roots" \
    's#bash scripts/fetch-binaries\.sh "\$\{browser_fetch_args\[@\]\}"#bash scripts/fetch-binaries.sh#'
}

expect_required_main_package_selection() {
  expect_canary_mutation_rejected \
    "missing browser source sysroot build" \
    "canary must build one current-source sysroot before browser support packages" \
    's#bash scripts/build-musl\.sh#test -d sysroot#'
  expect_canary_mutation_rejected \
    "dirty musl source after browser builds" \
    "canary must restore the exact musl source after browser support builds" \
    's#git -C libc/musl clean -fdx#true#'
  expect_canary_mutation_rejected \
    "retained browser build sysroot" \
    "canary must remove the build sysroot before exact runtime preparation" \
    's#rm -rf -- "\$source_root/sysroot"#true#'
  expect_canary_mutation_rejected \
    "missing required browser input graph" \
    "canary must materialize only the required main-page package roots" \
    's#node scripts/browser-binary-package-roots\.mjs \\#node scripts/missing-browser-package-roots.mjs \\#'
  expect_canary_mutation_rejected \
    "broad browser package fallback" \
    "canary must materialize only the required main-page package roots" \
    's#bash scripts/fetch-binaries\.sh "\$\{browser_fetch_args\[@\]\}"#bash scripts/fetch-binaries.sh#'
  expect_canary_mutation_rejected \
    "restored legacy browser preparation" \
    "canary must not rebuild the legacy browser package matrix" \
    's#bash scripts/stage-homebrew-bootstrap-browser-asset\.sh#./run.sh --already-materialized prepare-browser\n          bash scripts/stage-homebrew-bootstrap-browser-asset.sh#'
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

expect_native_production_shape() {
  local activation="$REPO_ROOT/abi/staging/pages-activation.toml"
  local workflow_header
  local job_names
  local build_block
  local deploy_block

  [ "$(cat "$activation")" = $'schema = 1\nkind = "kandelo-pages-activation"\nmode = "observe"' ] ||
    fail "inactive native Pages preparation must use observe mode"
  workflow_header="$(sed -n '1,/^jobs:$/p' "$PAGES_WORKFLOW")"
  grep -Fxq 'permissions: {}' <<<"$workflow_header" ||
    fail "native Pages workflow permissions must be empty"
  job_names="$(
    awk '
      /^jobs:$/ { inside = 1; next }
      inside && /^  [A-Za-z0-9_.-]+:$/ {
        job = $1
        sub(/:$/, "", job)
        print job
      }
    ' "$PAGES_WORKFLOW"
  )"
  [ "$job_names" = $'build-complete-site\ndeploy-complete-site' ] ||
    fail "native Pages workflow must have exactly build and deploy jobs"

  build_block="$(job_block "$PAGES_WORKFLOW" "build-complete-site")"
  deploy_block="$(job_block "$PAGES_WORKFLOW" "deploy-complete-site")"
  grep -Fxq '      actions: read' <<<"$build_block" &&
    grep -Fxq '      contents: read' <<<"$build_block" ||
    fail "native Pages build permissions must be Actions and contents read"
  grep -Fxq '      pages: write' <<<"$deploy_block" &&
    grep -Fxq '      id-token: write' <<<"$deploy_block" ||
    fail "native Pages deploy permissions must be Pages and identity-token write"
  grep -Fxq '    needs: build-complete-site' <<<"$deploy_block" ||
    fail "native Pages deploy must depend on the complete build"
  grep -Fq 'needs.build-complete-site.outputs.deploy == '\''true'\''' \
    <<<"$deploy_block" ||
    fail "native Pages deploy must require active complete output"
  grep -Fq 'scripts/abi-staging-pages-producer.ts ship' <<<"$build_block" &&
    grep -Fq '.shipping_mode == "direct-canonical-bottles"' <<<"$build_block" &&
    grep -Fq 'abi-staging-pages-assembled-site.spec.ts' <<<"$build_block" ||
    fail "native Pages build must produce and smoke-test the direct seven-product site"
  grep -Fq 'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0' \
    <<<"$build_block" ||
    fail "native Pages build must upload one pinned complete artifact"
  grep -Fq 'actions/deploy-pages@f29b9056696d8d80070d321737a6805413dbdea1 # v4.0.5' \
    <<<"$deploy_block" ||
    fail "native Pages deploy must use the pinned native deploy action"
  if grep -Eq 'actions/checkout@|^[[:space:]]+run:' <<<"$deploy_block"; then
    fail "native Pages deploy must consume only the inert Pages artifact"
  fi
  if grep -Eq 'peaceiris/actions-gh-pages@|contents: write' "$PAGES_WORKFLOW"; then
    fail "native Pages workflow must not retain the legacy branch writer"
  fi
}

case "${PAGES_CONTRACT_FOCUS:-all}" in
  atomic-chromium)
    expect_atomic_chromium_gate_required
    exit 0
    ;;
  ready-filter)
    expect_ready_filter_executes
    exit 0
    ;;
  readiness-preflight)
    if [ -n "${PAGES_READINESS_PREFLIGHT_KIND:-}" ]; then
      expect_invalid_readiness_rejected_before_semantics \
        "$PAGES_READINESS_PREFLIGHT_KIND"
    else
      expect_invalid_readiness_rejected_before_semantics symlink
      expect_invalid_readiness_rejected_before_semantics fifo
      expect_invalid_readiness_rejected_before_semantics oversize
    fi
    exit 0
    ;;
  prebranch-site-read)
    expect_prebranch_site_read_rejected
    exit 0
    ;;
  hardcoded-hold-inventory)
    expect_hardcoded_hold_inventory_rejected
    exit 0
    ;;
  bootstrap-input)
    expect_current_bootstrap_input_required
    exit 0
    ;;
  direct-package-inputs)
    expect_direct_package_selection_required
    exit 0
    ;;
  required-main-inputs)
    expect_required_main_package_selection
    exit 0
    ;;
  task10-native)
    expect_native_production_shape
    exit 0
    ;;
  all)
    ;;
  *)
    fail "unknown PAGES_CONTRACT_FOCUS: $PAGES_CONTRACT_FOCUS"
    ;;
esac

expect_ready_filter_executes
expect_invalid_readiness_rejected_before_semantics symlink
expect_invalid_readiness_rejected_before_semantics fifo
expect_invalid_readiness_rejected_before_semantics oversize
expect_required_main_package_selection
expect_native_production_shape

bash "$CHECKER" "$REPO_ROOT"
expect_atomic_chromium_gate_required
bash "$REPO_ROOT/scripts/test-verify-browser-shell-vfs-asset.sh"

fixture="$(new_fixture)"
cat >"$fixture/.github/workflows/rogue-pages.yml" <<'YAML'
name: Rogue Pages writer
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: git push origin HEAD:gh-pages
YAML
if output="$(bash "$CHECKER" "$fixture" 2>&1)"; then
  fail "checker accepted a second gh-pages writer"
fi
grep -Fq 'exactly one workflow may publish GitHub Pages' <<<"$output" ||
  fail "checker rejected the second writer for an unexpected reason: $output"
echo "test-pages-deployment-contract: rejected a second workflow writer"

expect_activation_mutation_rejected \
  "premature active deployment" \
  "inactive production Pages preparation must remain in observe mode" \
  's/mode = "observe"/mode = "active"/'

expect_mutation_rejected \
  "non-canceling production" \
  "production Pages must supersede older incomplete deployments" \
  's/group: kandelo-pages-production\n  cancel-in-progress: true/group: kandelo-pages-production\n  cancel-in-progress: false/'

expect_mutation_rejected \
  "workflow-wide write permission" \
  "production Pages workflow permissions must be empty" \
  's/permissions: \{\}/permissions:\n  contents: write/'

expect_mutation_rejected \
  "build job write permission" \
  "production Pages build permissions must be read-only" \
  's/(  build-complete-site:[\s\S]*?      contents:) read/$1 write/'

expect_mutation_rejected \
  "deploy job contents permission" \
  "native Pages deployment permissions must contain only pages and id-token writes" \
  's/(  deploy-complete-site:[\s\S]*?    permissions:\n)/$1      contents: write\n/'

expect_mutation_rejected \
  "extra candidate dispatch selector" \
  "workflow dispatch must bind only the exact protected source" \
  's/(      source_sha:[\s\S]*?        type: string)/$1\n      candidate_tag:\n        required: true\n        type: string/'

expect_mutation_rejected \
  "checkout with persisted credentials" \
  "production Pages must check out one exact uncredentialed source" \
  's/^          persist-credentials: false\n//m'

expect_mutation_rejected \
  "second source checkout" \
  "production Pages must build every output from one checkout" \
  's/(      - name: Build the seven ABI products directly for shipping)/      - name: Replace protected source\n        uses: actions\/checkout\@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0\n\n$1/'

expect_mutation_rejected \
  "candidate namespace injection" \
  "production Pages must not consume candidate artifact authority" \
  's/(          set -euo pipefail\n)/$1          echo ghcr.io\/kandelo-dev\/homebrew-tap-core-abi-43-candidates\/bash\n/'

expect_mutation_rejected \
  "missing direct shipping producer" \
  "production Pages must run the direct seven-product shipping producer" \
  's/scripts\/abi-staging-pages-producer\.ts ship/scripts\/abi-staging-pages-producer.ts inspect/'

expect_mutation_rejected \
  "missing direct shipping marker" \
  "production Pages must validate the direct exact tree before upload" \
  's/direct-canonical-bottles/direct-unbound-inputs/'

expect_mutation_rejected \
  "missing assembled Chromium smoke" \
  "production Pages must smoke-test the exact returned tree in Chromium" \
  's/abi-staging-pages-assembled-site\.spec\.ts/not-the-assembled-site.spec.ts/'

expect_mutation_rejected \
  "missing complete-tree validation" \
  "production Pages must validate the direct exact tree before upload" \
  's/Pages artifact differs from its exact site inventory/Pages artifact was not checked/'

expect_mutation_rejected \
  "foreign production freshness selector" \
  "production Pages must use the tested production freshness guard" \
  's/PAGES_WORKFLOW_FILE: browser-demos-pages\.yml/PAGES_WORKFLOW_FILE: abi-staging-pages-canary.yml/'

expect_mutation_rejected \
  "generic artifact replaces native Pages artifact" \
  "production Pages must upload exactly one complete native Pages artifact" \
  's/actions\/upload-pages-artifact\@fc324d3547104276b827a68afc52ff2a11cc49c9/actions\/upload-artifact\@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/'

expect_mutation_rejected \
  "partial Pages artifact path" \
  "production Pages must upload exactly one complete native Pages artifact" \
  's#(          path: \$\{\{ runner\.temp \}\}/abi-staging-pages-output/source-tree)#$1/kandelo#'

expect_mutation_rejected \
  "deploy without direct shipping" \
  "production Pages deploy output must bind direct shipping and freshness" \
  's/steps\.shipping\.outputs\.ready == '\''true'\'' && //'

expect_mutation_rejected \
  "unconditional deploy job" \
  "native Pages deployment must consume only the successful build output" \
  "s/if: needs\\.build-complete-site\\.outputs\\.deploy == 'true'/if: always()/"

expect_mutation_rejected \
  "deploy job rebuild" \
  "native Pages deploy job must not rebuild or replace the proven artifact" \
  's/(  deploy-complete-site:[\s\S]*?    steps:\n)/$1      - run: npm run build\n/'

expect_mutation_rejected \
  "legacy branch publisher" \
  "native Pages deployment must use the pinned GitHub deployment action" \
  's#actions/deploy-pages\@f29b9056696d8d80070d321737a6805413dbdea1#peaceiris/actions-gh-pages\@c473a7a5e2f63b7b48ad4439c0b58ebdc2c2f57a#'

[ -f "$CANARY_WORKFLOW" ] ||
  fail "native Pages canary is absent: $CANARY_WORKFLOW_REL"
canary_inputs_line="$(
  grep -nF '      - name: Materialize exact current product inputs' \
    "$CANARY_WORKFLOW" | cut -d: -f1
)"
canary_runtime_line="$(
  grep -nF '      - name: Prepare exact uncredentialed runtime' \
    "$CANARY_WORKFLOW" | cut -d: -f1
)"
[ -n "$canary_inputs_line" ] && [ -n "$canary_runtime_line" ] &&
  [ "$canary_inputs_line" -lt "$canary_runtime_line" ] ||
  fail "canary must materialize exact current inputs before runtime preparation"
grep -Fq 'PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers" npx playwright install' \
  "$CANARY_WORKFLOW" &&
  grep -Fq '"PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" \' \
    "$CANARY_WORKFLOW" ||
  fail "canary must install and run Chromium from one explicit browser root"
grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
    "$CANARY_WORKFLOW" ||
  fail "canary must retain the isolated package cache inside dev-shell"
workflow_step_block "$CANARY_WORKFLOW" \
    "Prepare exact uncredentialed runtime" |
  grep -Fq -- '--binary-cache-root "$WASM_POSIX_BINARY_CACHE_ROOT"' ||
  fail "canary runtime must receive the exact isolated package cache root"
grep -Fq '          package-manager-cache: false' "$CANARY_WORKFLOW" ||
  fail "canary dependency setup must not write durable caches"

expect_canary_mutation_rejected \
  "pull-request trigger" \
  "canary must not run for pull requests" \
  's/(  push:\n)/  pull_request:\n$1/'

expect_canary_mutation_rejected \
  "partial main-push path filter" \
  "canary must run for every protected main push" \
  's/(    branches: \[main\]\n)/$1    paths:\n      - "abi\/**"\n/'

expect_canary_mutation_rejected \
  "manual trigger" \
  "canary must be authorized only by protected main pushes" \
  's/(concurrency:\n)/  workflow_dispatch:\n\n$1/'

expect_canary_mutation_rejected \
  "workflow-level contents permission" \
  "canary workflow permissions must be empty" \
  's/permissions: \{\}/permissions:\n  contents: read/'

expect_canary_mutation_rejected \
  "job Actions write permission" \
  "canary job permissions must be exactly Actions and contents read" \
  's/      actions: read/      actions: write/'

expect_canary_mutation_rejected \
  "job contents write permission" \
  "canary job permissions must be exactly Actions and contents read" \
  's/      contents: read/      contents: write/'

expect_canary_mutation_rejected \
  "Pages write permission" \
  "canary job permissions must be exactly Actions and contents read" \
  's/(      contents: read\n)/$1      pages: write\n/'

expect_canary_mutation_rejected \
  "identity-token write permission" \
  "canary job permissions must be exactly Actions and contents read" \
  's/(      contents: read\n)/$1      id-token: write\n/'

expect_canary_mutation_rejected \
  "persisted checkout credentials" \
  "canary checkout must not persist credentials" \
  's/^          persist-credentials: false\n//m'

expect_canary_mutation_rejected \
  "second source checkout" \
  "canary must build from exactly one checkout" \
  's/(      - name: Set up Node)/      - name: Replace current source\n        uses: actions\/checkout\@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0\n\n$1/'

expect_canary_mutation_rejected \
  "source-ref fallback" \
  "canary checkout must use the event source SHA" \
  's/(          persist-credentials: false\n)/$1          ref: main\n/'

expect_canary_mutation_rejected \
  "runtime before sealed product inputs" \
  "canary must produce, select ready or hold, freshness-check, then retain one result" \
  's#(      - name: Materialize exact current product inputs[\s\S]*?)(      - name: Prepare exact uncredentialed runtime[\s\S]*?)(      - name: Write the bounded production handoff)#$2$1$3#'

expect_canary_mutation_rejected \
  "runtime package cache argument omitted" \
  "canary runtime must be an uncredentialed exact-current-source artifact" \
  's/^                --binary-cache-root "\$WASM_POSIX_BINARY_CACHE_ROOT" \\\n//m'

expect_canary_mutation_rejected \
  "runtime package cache environment omitted" \
  "canary runtime must be an uncredentialed exact-current-source artifact" \
  's/(      - name: Prepare exact uncredentialed runtime[\s\S]*?)^              "WASM_POSIX_BINARY_CACHE_ROOT=\$WASM_POSIX_BINARY_CACHE_ROOT" \\\n/$1/m'

expect_canary_mutation_rejected \
  "candidate VFS reuse" \
  "canary must never consume candidate VFS or lazy bodies" \
  's/(scripts\/abi-staging-pages-producer\.ts produce)/$1 --candidate-vfs "\$RUNNER_TEMP\/candidate.vfs.zst"/'

expect_canary_mutation_rejected \
  "candidate canonical reference" \
  "canary output must not contain a candidate reference" \
  's/(      - name: Validate the complete canonical Pages tree\n)/      - run: echo ghcr.io\/kandelo-dev\/homebrew-tap-core-abi-43-candidates\/products\/browser-node\n\n$1/'

expect_canary_mutation_rejected \
  "missing exact Pages registry" \
  "canary must bind the exact protected Pages registry" \
  's/pages-vfs-products\.generated\.json/pages-vfs-products-missing.json/g'

expect_canary_mutation_rejected \
  "target validation after first use" \
  "canary readiness does not filter then immediately validate noisy dev-shell target output" \
  's/(          \[\[ "\$host_target" =~ \^\[A-Za-z0-9_.-\]\+\$ \]\]\n)(          bash scripts\/dev-shell\.sh cargo run -p xtask \\\n+            --target "\$host_target" --quiet -- \\\n+)/$2$1/'

expect_canary_mutation_rejected \
  "missing target validation" \
  "canary readiness does not filter then immediately validate noisy dev-shell target output" \
  's/^          \[\[ "\$host_target" =~ \^\[A-Za-z0-9_.-\]\+\$ \]\]\n//m'

expect_canary_mutation_rejected \
  "target filtering restored inside dev-shell" \
  "canary readiness does not filter then immediately validate noisy dev-shell target output" \
  's#host_target=\$\(bash scripts/dev-shell\.sh rustc -vV \|\n            awk '\''/\^host: / \{ print \$2 \}'\''\)#host_target=\$(bash scripts/dev-shell.sh bash -c "rustc -vV | sed -n '\''s/^host: //p'\''")#'

expect_canary_mutation_rejected \
  "partial Pages registry" \
  "canary must bind the complete protected Pages registry" \
  's/\.products \| map\(\.id\)/.products[:1] | map(.id)/'

expect_canary_mutation_rejected \
  "skipped Node evidence" \
  "canary must require every product Node and browser receipt" \
  's/\(\.node_receipts \| length > 0\)/(true)/'

expect_canary_mutation_rejected \
  "skipped browser evidence" \
  "canary must require every product Node and browser receipt" \
  's/\(\.browser_receipts \| length > 0\)/(true)/'

expect_canary_mutation_rejected \
  "unbound ready tap source" \
  "canary ready validation must bind the exact protected tap source" \
  's/(      - name: Validate the complete canonical Pages tree.*?)(^            --argjson tap_source "\$tap_source" \\\n)/$1/ms'

expect_canary_mutation_rejected \
  "source-build fallback" \
  "canary must fail immediately when a selected package root is missing" \
  's/--fetch-only/--allow-stale/'

expect_current_bootstrap_input_required
expect_direct_package_selection_required

expect_canary_mutation_rejected \
  "implicit Playwright install root" \
  "canary must install and run Chromium from one explicit browser root" \
  's/PLAYWRIGHT_BROWSERS_PATH="\$playwright_browsers" npx playwright install/npx playwright install/'

expect_canary_mutation_rejected \
  "hosted Playwright apt mutation" \
  "canary must install and run Chromium from one explicit browser root" \
  's/            chromium\n/            chromium --with-deps\n/'

expect_canary_mutation_rejected \
  "Playwright root lost inside dev-shell" \
  "canary must install and run Chromium from one explicit browser root" \
  's/"PLAYWRIGHT_BROWSERS_PATH=\$PLAYWRIGHT_BROWSERS_PATH"/"PLAYWRIGHT_BROWSERS_PATH_IGNORED=\$PLAYWRIGHT_BROWSERS_PATH"/'

expect_canary_mutation_rejected \
  "package cache lost inside dev-shell" \
  "canary must retain the isolated package cache inside dev-shell" \
  's/"WASM_POSIX_BINARY_CACHE_ROOT=\$WASM_POSIX_BINARY_CACHE_ROOT"/"WASM_POSIX_BINARY_CACHE_ROOT_IGNORED=\$WASM_POSIX_BINARY_CACHE_ROOT"/'

expect_canary_mutation_rejected \
  "default package cache export" \
  "canary must create one fresh runner-temporary package cache" \
  's/echo "WASM_POSIX_BINARY_CACHE_ROOT=\$package_cache"/echo "WASM_POSIX_BINARY_CACHE_ROOT=\/tmp\/default-package-cache"/'

expect_canary_mutation_rejected \
  "dependency cache write" \
  "canary dependency setup must not write durable caches" \
  's/          package-manager-cache: false/          package-manager-cache: true/'

expect_canary_mutation_rejected \
  "explicit npm cache write" \
  "canary dependency setup must not write durable caches" \
  's/(          package-manager-cache: false\n)/$1          cache: npm\n/'

expect_canary_mutation_rejected \
  "standalone Actions cache write" \
  "canary dependency setup must not write durable caches" \
  's/(      - name: Install root dependencies)/      - name: Persist a dependency cache\n        uses: actions\/cache\@caa296126883cff596d87d8935842f9db880ef25 # v5.1.0\n        with:\n          path: ~\/.npm\n          key: canary-write\n\n$1/'

expect_canary_mutation_rejected \
  "swallowed producer failure" \
  "canary producer must be the final failure-propagating command" \
  's/(--output-root "\$pages_output")/$1 || true/'

expect_canary_mutation_rejected \
  "test-only producer fixture" \
  "canary must invoke only the production Pages producer CLI" \
  's/abi-staging-pages-producer\.ts/abi-staging-pages-producer-fixture.ts/'

expect_canary_mutation_rejected \
  "mutable latest record selection" \
  "canary must not select mutable product records" \
  's/(      - name: Produce admitted canonical Pages products\n)/$1        env:\n          KANDELO_PAGES_RECORD_TAG: latest\n/'

expect_canary_mutation_rejected \
  "failure-tolerant validation" \
  "canary preparation and upload must remain failure-intolerant" \
  's/(      - name: Validate the complete canonical Pages tree\n)/$1        continue-on-error: true\n/'

expect_canary_mutation_rejected \
  "validation on prior failure" \
  "canary pre-upload work must remain success-gated" \
  's/(      - name: Validate the complete canonical Pages tree\n)/$1        if: always()\n/'

expect_canary_mutation_rejected \
  "skipped readiness validation" \
  "canary must validate readiness before selecting ready or hold" \
  's/abi-staging pages-readiness validate-readiness "\$readiness"/abi-staging pages-readiness show "\$readiness"/'

expect_canary_mutation_rejected \
  "hold reads a site manifest" \
  "canary hold must never inspect a site manifest or source tree" \
  's/(          if \[ "\$ready" = false \]; then\n)/$1            jq -e . "\$pages_output\/site-manifest.json"\n/'

expect_canary_mutation_rejected \
  "extra hold output" \
  "canary hold must validate exactly one readiness file" \
  's/\["readiness\.json"\]/["readiness.json", "unexpected.json"]/'

expect_prebranch_site_read_rejected

expect_hardcoded_hold_inventory_rejected

expect_canary_mutation_rejected \
  "wrong freshness workflow" \
  "canary newest-run guard must query only the canary workflow" \
  's/PAGES_WORKFLOW_FILE: abi-staging-pages-canary\.yml/PAGES_WORKFLOW_FILE: browser-demos-pages.yml/'

expect_canary_mutation_rejected \
  "bypassed newest-run guard" \
  "canary retention authority must come from the tested newest-run checker" \
  's#run: bash scripts/check-pages-run-freshness\.sh#run: echo "upload=true" >> "\$GITHUB_OUTPUT"#'

expect_canary_mutation_rejected \
  "early Pages artifact" \
  "canary must upload exactly one inert Pages artifact" \
  's/(      - name: Validate the complete canonical Pages tree)/      - name: Upload an unchecked tree\n        uses: actions\/upload-pages-artifact\@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0\n        with:\n          path: "\$RUNNER_TEMP\/unchecked"\n          retention-days: 7\n          include-hidden-files: true\n\n$1/'

expect_canary_mutation_rejected \
  "second Pages artifact" \
  "canary must upload exactly one inert Pages artifact" \
  's/(      - name: Upload the complete inert Pages canary)/      - name: Upload a second partial tree\n        uses: actions\/upload-pages-artifact\@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0\n        with:\n          path: "\$RUNNER_TEMP\/partial"\n          retention-days: 7\n          include-hidden-files: true\n\n$1/'

expect_canary_mutation_rejected \
  "second site tree" \
  "canary must upload the complete canonical Pages source tree" \
  's#path: \$\{\{ runner\.temp \}\}/abi-staging-pages-output/source-tree#path: \$\{\{ runner.temp \}\}/abi-staging-pages-site-source#'

expect_canary_mutation_rejected \
  "hidden deployment manifest omitted" \
  "canary must retain the exact hidden deployment manifest" \
  's/          include-hidden-files: true/          include-hidden-files: false/'

expect_canary_mutation_rejected \
  "short artifact retention" \
  "canary must retain its inert artifact for seven days" \
  's/(      - name: Upload the complete inert Pages canary.*?          retention-days:) 7/$1 1/s'

expect_canary_mutation_rejected \
  "hold uploaded as a Pages artifact" \
  "canary hold must use one ordinary bounded artifact" \
  's#actions/upload-artifact\@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a#actions/upload-pages-artifact\@fc324d3547104276b827a68afc52ff2a11cc49c9#'

expect_canary_mutation_rejected \
  "hold without retention" \
  "canary hold must use one ordinary bounded artifact" \
  's/(      - name: Upload the incomplete Pages hold.*?          path: \$\{\{ runner\.temp \}\}\/abi-staging-pages-output\/readiness\.json\n)          retention-days: 7\n/$1/s'

expect_canary_mutation_rejected \
  "work after newest-run guard" \
  "canary newest-run guard must be immediately before its two result uploads" \
  's/(      - name: Upload the complete inert Pages canary)/      - name: Delay the inert upload\n        run: sleep 1\n\n$1/'

expect_canary_mutation_rejected \
  "deployment action" \
  "canary must never deploy Pages" \
  's#actions/upload-pages-artifact\@fc324d3547104276b827a68afc52ff2a11cc49c9#actions/deploy-pages\@f29b9056696d8d80070d321737a6805413dbdea1#'

expect_canary_mutation_rejected \
  "branch mutation" \
  "canary must not mutate a publication branch" \
  's/(      - name: Upload the complete inert Pages canary)/      - name: Mutate publication branch\n        run: git push origin HEAD:gh-pages\n\n$1/'

expect_plan_mutation_rejected \
  "pre-admission hold described as a ready gate" \
  "Pages sequencing must keep the first hosted hold separate from readiness" \
  's/Before successor admissions exist, the canary produces a hosted hold\s+for\s+inactive Task 10 preparation/Before successor admissions exist, the canary produces a hosted ready result for Task 10 activation/'

echo "test-pages-deployment-contract: ok"
