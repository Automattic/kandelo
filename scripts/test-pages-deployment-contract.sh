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
  's/(          set -euo pipefail\n)/$1          echo ghcr.io\/kandelo-dev\/sample-tap-core-abi-43-candidates\/bash\n/'

expect_mutation_rejected \
  "restored Kandelo package materialization" \
  "production Pages must not materialize Kandelo package roots" \
  's/(          archive_authority=)/          bash scripts\/fetch-binaries.sh --fetch-only --package mariadb\n$1/'

expect_mutation_rejected \
  "package materialization moved outside its old step" \
  "production Pages must not materialize Kandelo package roots" \
  's/(      - name: Prepare exact uncredentialed runtime)/      - name: Restore package preparation elsewhere\n        run: bash scripts\/fetch-binaries.sh --fetch-only --package nginx\n\n$1/'

expect_mutation_rejected \
  "missing canonical bottle preflight" \
  "production Pages bottle preflight must bind the tap, Formula closure, and ABI" \
  's/scripts\/abi-staging-pages-producer\.ts preflight/scripts\/abi-staging-pages-producer.ts inspect/'

expect_mutation_rejected \
  "package root restored to production handoff" \
  "production Pages must not materialize Kandelo package roots" \
  's/(                    program_index: \$program_index)/                    package_roots: "\/tmp\/legacy-package-roots.json",\n$1/'

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

expect_canary_mutation_rejected \
  "manual canary trigger" \
  "canary must be authorized only by protected main pushes" \
  's/(  push:\n)/  workflow_dispatch:\n$1/'

expect_canary_mutation_rejected \
  "canary write permission" \
  "canary job permissions must be exactly Actions and contents read" \
  's/      contents: read/      contents: write/'

expect_canary_mutation_rejected \
  "persisted canary checkout credentials" \
  "canary checkout must use the exact event source without credentials" \
  's/^          persist-credentials: false\n//m'

expect_canary_mutation_rejected \
  "restored canary package materialization" \
  "canary must not retain legacy package or admission preparation" \
  's/(          archive_authority=)/          bash scripts\/fetch-binaries.sh --fetch-only --package nginx\n$1/'

expect_canary_mutation_rejected \
  "missing canary bottle preflight" \
  "canary must preflight the complete package-free canonical bottle closure" \
  's/scripts\/abi-staging-pages-producer\.ts preflight/scripts\/abi-staging-pages-producer.ts inspect/'

expect_canary_mutation_rejected \
  "restored canary package-root handoff" \
  "canary must not retain legacy package or admission preparation" \
  's/(                    program_index: \$program_index)/                    package_roots: "\/tmp\/legacy-package-roots.json",\n$1/'

expect_canary_mutation_rejected \
  "admitted canary producer" \
  "canary must not retain legacy package or admission preparation" \
  's/scripts\/abi-staging-pages-producer\.ts ship/scripts\/abi-staging-pages-producer.ts produce/'

expect_canary_mutation_rejected \
  "missing canary direct shipping marker" \
  "canary must validate the exact direct shipping tree" \
  's/direct-canonical-bottles/direct-unbound-inputs/'

expect_canary_mutation_rejected \
  "missing canary Chromium smoke" \
  "canary must smoke-test the exact assembled tree in Chromium" \
  's/abi-staging-pages-assembled-site\.spec\.ts/not-the-assembled-site.spec.ts/'

expect_canary_mutation_rejected \
  "foreign canary freshness selector" \
  "canary must retain only the newest exact run" \
  's/PAGES_WORKFLOW_FILE: abi-staging-pages-canary\.yml/PAGES_WORKFLOW_FILE: browser-demos-pages.yml/'

expect_canary_mutation_rejected \
  "partial canary upload" \
  "canary must upload one complete inert direct tree" \
  's#(          path: \$\{\{ runner\.temp \}\}/abi-staging-pages-output/source-tree)#$1/kandelo#'

expect_canary_mutation_rejected \
  "hidden canary manifest omitted" \
  "canary must upload one complete inert direct tree" \
  's/          include-hidden-files: true/          include-hidden-files: false/'

expect_canary_mutation_rejected \
  "canary deployment mutation" \
  "canary must never deploy or publish package state" \
  's/(      - name: Upload the complete inert Pages canary)/      - name: Mutate publication branch\n        run: git push origin HEAD:gh-pages\n\n$1/'

echo "test-pages-deployment-contract: ok"
