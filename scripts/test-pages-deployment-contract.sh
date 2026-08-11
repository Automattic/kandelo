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
grep -Fq 'exactly one workflow may mention or publish gh-pages' <<<"$output" ||
  fail "checker rejected the second writer for an unexpected reason: $output"
echo "test-pages-deployment-contract: rejected a second workflow writer"

expect_mutation_rejected \
  "non-canceling concurrency" \
  "new Pages runs must cancel in-progress work" \
  's/cancel-in-progress: true/cancel-in-progress: false/'

expect_mutation_rejected \
  "self-hosted Pages runner" \
  "must use the reviewed GitHub-hosted Ubuntu runner" \
  's/runs-on: ubuntu-latest/runs-on: self-hosted/'

expect_mutation_rejected \
  "decoy hosted runner with self-hosted deploy job" \
  "must use the reviewed GitHub-hosted Ubuntu runner" \
  's/jobs:\n  deploy:\n    runs-on: ubuntu-latest/jobs:\n  decoy:\n    runs-on: ubuntu-latest\n  deploy:\n    runs-on: self-hosted/'

expect_mutation_rejected \
  "failure-tolerant browser preparation" \
  "must remain failure-intolerant" \
  's/(      - name: Prepare browser demo assets\n)/$1        continue-on-error: true\n/'

expect_mutation_rejected \
  "failure override after browser preparation" \
  "pre-deployment Pages work must remain success-gated" \
  's/(      - name: Build browser demos for GitHub Pages\n)/$1        if: always()\n/'

expect_mutation_rejected \
  "partial main-push path allowlist" \
  "must not filter main pushes by path" \
  's/(    branches: \[main\]\n)/$1    paths:\n      - "packages\/registry\/**"\n/'

expect_mutation_rejected \
  "main-push path exclusion" \
  "must not filter main pushes by path" \
  's/(    branches: \[main\]\n)/$1    paths-ignore:\n      - "scripts\/**"\n/'

expect_mutation_rejected \
  "non-main Pages push branch" \
  "must run for every main push" \
  's/branches: \[main\]/branches: [release]/'

expect_mutation_rejected \
  "pull-request Pages deployment" \
  "must not deploy pull-request revisions" \
  's/(  workflow_dispatch:\n)/  pull_request:\n$1/'

expect_mutation_rejected \
  "missing exact dispatch source" \
  "workflow dispatch must bind the exact source, candidate, and canonical index" \
  's/      source_sha:/      source_ref:/'

expect_mutation_rejected \
  "unchecked dispatch generation inputs" \
  "must validate every exact generation input before checkout" \
  's/REQUESTED_CANONICAL_INDEX_SHA256: \$\{\{ inputs\.canonical_index_sha256 \}\}/REQUESTED_CANONICAL_INDEX_SHA256: unchecked/'

expect_mutation_rejected \
  "bypassed package projection check" \
  "must verify the generated package projection" \
  's/build-deps program-index-check/build-deps parse/'

expect_mutation_rejected \
  "bypassed canonical generation snapshot" \
  "must authenticate the requested canonical package generation" \
  's/scripts\/release-index-state\.sh snapshot/scripts\/release-index-state.sh read/'

expect_mutation_rejected \
  "missing musl input for repository-owned support programs" \
  "must fetch musl for its repository-owned support programs" \
  's/submodules: libc\/musl/submodules: libc\/missing/'

expect_mutation_rejected \
  "missing canonical package cache root" \
  "must establish one fresh canonical package cache" \
  's/^          echo "WASM_POSIX_BINARY_CACHE_ROOT=\$product_cache" >> "\$GITHUB_ENV"\n//m'

expect_mutation_rejected \
  "cache root lost inside dev-shell" \
  "browser preparation must retain the canonical cache inside dev-shell" \
  's/^            "WASM_POSIX_BINARY_CACHE_ROOT=\$WASM_POSIX_BINARY_CACHE_ROOT" \\\n//m'

expect_mutation_rejected \
  "source-fallback browser preparation" \
  "must consume canonical packages without fallback" \
  's#\./run\.sh --fetch-only prepare-browser#./run.sh prepare-browser#'

expect_mutation_rejected \
  "retired lazy-shell preparation" \
  "must consume canonical packages without fallback" \
  's#\./run\.sh --fetch-only prepare-browser#./run.sh --fetch-only --require-sealed-homebrew-selection prepare-browser#'

expect_mutation_rejected \
  "swallowed canonical preparation failure" \
  "must consume canonical packages without fallback" \
  's#(\./run\.sh --fetch-only prepare-browser)#$1 || true#'

expect_mutation_rejected \
  "work after canonical preparation command" \
  "must be the final failure-propagating command" \
  's#(\./run\.sh --fetch-only prepare-browser\n)#$1          echo continued\n#'

expect_mutation_rejected \
  "missing canonical shell resolution" \
  "must bind the resolver-selected canonical shell and Node images" \
  's/programs\/shell\.vfs\.zst/programs\/missing-shell.vfs.zst/'

expect_mutation_rejected \
  "missing canonical Node resolution" \
  "must bind the resolver-selected canonical shell and Node images" \
  's/programs\/node-vfs\.vfs\.zst/programs\/missing-node.vfs.zst/'

expect_mutation_rejected \
  "shell-only Pages build" \
  "must build the complete browser entry set" \
  's/(      - name: Build browser demos for GitHub Pages\n        working-directory: apps\/browser-demos\n)/$1        env:\n          KANDELO_BROWSER_DEMO_INPUTS: main\n/'

expect_mutation_rejected \
  "missing canonical flat-shell inspector" \
  "must run the canonical flat-shell inspector and its rejection tests" \
  's/scripts\/inspect-canonical-flat-shell\.ts/scripts\/skipped-canonical-flat-shell.ts/'

expect_mutation_rejected \
  "missing canonical flat-shell inspector rejection tests" \
  "must run the canonical flat-shell inspector and its rejection tests" \
  's/scripts\/inspect-canonical-flat-shell\.test\.ts/scripts\/skipped-canonical-flat-shell.test.ts/'

expect_mutation_rejected \
  "inspector bound to another selection" \
  "must run the canonical flat-shell inspector and its rejection tests" \
  's/homebrew\/main-shell-flat-selection\.json/homebrew\/other-selection.json/'

expect_mutation_rejected \
  "unbound canonical Node digest" \
  "must record the exact canonical shell and Node digests" \
  's/node_sha256=\$\(sha256sum/node_sha256=\$(printf/'

expect_mutation_rejected \
  "retired browser bootstrap input" \
  "retired lazy-shell input: homebrew-bootstrap" \
  's#(          test ! -e "\$report"\n)#$1          test -f apps/browser-demos/public/homebrew-bootstrap.zip\n#'

expect_mutation_rejected \
  "retired shell artifact lock" \
  "retired lazy-shell input: main-shell-lazy-artifact-lock" \
  's#(          test ! -e "\$report"\n)#$1          test -f homebrew/main-shell-lazy-artifact-lock.json\n#'

expect_mutation_rejected \
  "retired bottle mirror recovery" \
  "retired lazy-shell input: recover-homebrew-bottle-mirror" \
  's#(          test ! -e "\$report"\n)#$1          npx tsx scripts/recover-homebrew-bottle-mirror.ts\n#'

expect_mutation_rejected \
  "missing hashed shell asset verifier" \
  "must verify its exact hashed shell and Node assets" \
  's/scripts\/verify-browser-shell-vfs-asset\.sh/scripts\/skipped-browser-shell-vfs-asset.sh/'

expect_mutation_rejected \
  "hashed shell verifier bound to another image" \
  "must verify its exact hashed shell and Node assets" \
  's/steps\.package_products\.outputs\.shell_image/steps.package_products.outputs.node_image/'

expect_mutation_rejected \
  "hashed Node verifier omits its exact stem" \
  "must verify its exact hashed shell and Node assets" \
  's/(steps\.package_products\.outputs\.node_image \}\}") node-vfs\.vfs/$1/'

expect_mutation_rejected \
  "unhashed public shell comparison" \
  "must not trust optional unhashed public package images" \
  's/(          npm run build\n)/$1          cmp dist\/shell.vfs.zst expected.vfs.zst\n/'

expect_mutation_rejected \
  "unhashed public Node comparison" \
  "must not trust optional unhashed public package images" \
  's/(          npm run build\n)/$1          cmp dist\/node-vfs.vfs.zst expected.vfs.zst\n/'

expect_mutation_rejected \
  "guide build without strict failure handling" \
  "must run strict source checks, build, then output checks" \
  's/(      - name: Build user guide for the complete Pages tree[\s\S]*?        run: \|\n)          set -euo pipefail\n/$1/m'

expect_mutation_rejected \
  "missing Homebrew guide source-link check" \
  "must run strict source checks, build, then output checks" \
  's/^          node --test docs-site\/\.vitepress\/homebrew-doc-links\.test\.mjs\n//m'

expect_mutation_rejected \
  "ignored Homebrew guide source-link failure" \
  "must run strict source checks, build, then output checks" \
  's#(node --test docs-site/\.vitepress/homebrew-doc-links\.test\.mjs)#$1 || true#'

expect_mutation_rejected \
  "late Homebrew guide source-link check" \
  "must run strict source checks, build, then output checks" \
  's#(          node --test docs-site/\.vitepress/homebrew-doc-links\.test\.mjs\n)(          npm run docs:build\n)#$2$1#'

expect_mutation_rejected \
  "missing generated Homebrew guide check" \
  "must run strict source checks, build, then output checks" \
  's/^          node --test docs-site\/\.vitepress\/homebrew-doc-output\.test\.mjs\n//m'

expect_mutation_rejected \
  "ignored generated Homebrew guide failure" \
  "must run strict source checks, build, then output checks" \
  's#(node --test docs-site/\.vitepress/homebrew-doc-output\.test\.mjs)#$1 || true#'

expect_mutation_rejected \
  "early generated Homebrew guide check" \
  "must run strict source checks, build, then output checks" \
  's#(          npm run docs:build\n)(          node --test docs-site/\.vitepress/homebrew-doc-output\.test\.mjs\n)#$2$1#'

expect_mutation_rejected \
  "flat preview broadens its demo inputs" \
  "must prove the canonical flat shell at the published base" \
  's/KANDELO_BROWSER_DEMO_INPUTS: main/KANDELO_BROWSER_DEMO_INPUTS: all/'

expect_mutation_rejected \
  "flat preview without Pages base" \
  "must prove the canonical flat shell at the published base" \
  's/(      - name: Boot the canonical flat Pages shell in Chromium\n        working-directory: apps\/browser-demos\n        env:\n)          VITE_BASE: \/kandelo\/\n/$1/'

expect_mutation_rejected \
  "flat preview loses strict image identity" \
  "must prove the canonical flat shell at the published base" \
  's/^          KANDELO_CANONICAL_FLAT_SHELL_SHA256:.*\n//m'

expect_mutation_rejected \
  "flat preview drops strict identity at the dev-shell boundary" \
  "flat-shell preview must carry its exact inputs through dev-shell" \
  's/(      - name: Boot the canonical flat Pages shell in Chromium[\s\S]*?)^            "KANDELO_CANONICAL_FLAT_SHELL_SHA256=\$KANDELO_CANONICAL_FLAT_SHELL_SHA256" \\\n/$1/m'

expect_mutation_rejected \
  "flat preview uses the retired lazy-shell test" \
  "must prove the canonical flat shell at the published base" \
  's/test\/kandelo-canonical-flat-shell\.spec\.ts/test\/kandelo-homebrew-main-shell.spec.ts/'

expect_mutation_rejected \
  "Pages omits exact npm acceptance" \
  "must install and execute cowsay from the canonical Node image" \
  's/test\/kandelo-node\.spec\.ts/test\/kandelo-merge-gate.spec.ts/'

expect_mutation_rejected \
  "Pages broadens npm acceptance" \
  "must install and execute cowsay from the canonical Node image" \
  "s/--grep 'Kandelo Node demo installs cowsay with npm'/--grep 'Node'/"

expect_mutation_rejected \
  "Node preview selects a nonexistent page input" \
  "must install and execute cowsay from the canonical Node image" \
  's/(      - name: Run exact Pages Node npm acceptance[\s\S]*?)KANDELO_BROWSER_DEMO_INPUTS: main/$1KANDELO_BROWSER_DEMO_INPUTS: node/'

expect_mutation_rejected \
  "Node preview drops production mode at the dev-shell boundary" \
  "Node preview must carry its exact inputs through dev-shell" \
  's/(      - name: Run exact Pages Node npm acceptance[\s\S]*?)^            "KANDELO_PLAYWRIGHT_SERVE_DIST=\$KANDELO_PLAYWRIGHT_SERVE_DIST" \\\n/$1/m'

expect_mutation_rejected \
  "Node preview drops exact VFS digest" \
  "must install and execute cowsay from the canonical Node image" \
  's/^          KANDELO_NODE_VFS_SHA256:.*\n//m'

expect_mutation_rejected \
  "checkout of a different ref" \
  "checkout must use one exact source selector" \
  's/(        uses: actions\/checkout@[^\n]+\n)/$1        with:\n          ref: main\n/'

expect_mutation_rejected \
  "unverified checked-out source" \
  "must verify the exact requested source is the current default tip" \
  's/actual_source_sha=\$\(git rev-parse HEAD\)/actual_source_sha=unchecked/'

expect_mutation_rejected \
  "checkout with persisted write credentials" \
  "product-building Pages checkout must not persist write credentials" \
  's/^          persist-credentials: false\n//m'

expect_mutation_rejected \
  "second source checkout" \
  "all Pages outputs must be built from one checkout" \
  's/(      - name: Build user guide for the complete Pages tree)/      - name: Replace the source tree\n        uses: actions\/checkout\@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0\n\n$1/'

expect_mutation_rejected \
  "missing Actions read permission" \
  "needs read access to verify workflow run order" \
  's/^  actions: read\n//m'

expect_mutation_rejected \
  "unauthenticated newest-run check" \
  "must authenticate with the workflow token" \
  's/(      - name: Confirm this is the newest Pages run[\s\S]*?)GH_TOKEN: \$\{\{ github\.token \}\}/$1GH_TOKEN: ""/'

expect_mutation_rejected \
  "bypassed newest-run checker" \
  "authority must come from the tested newest-run checker" \
  's#run: bash scripts/check-pages-run-freshness\.sh#run: echo "publish=true" >> "$GITHUB_OUTPUT"#'

expect_mutation_rejected \
  "foreign production freshness workflow" \
  "production newest-run guard must query only the production workflow" \
  's/(env:\n)/$1  PAGES_WORKFLOW_FILE: unrelated-pages.yml\n/'

expect_mutation_rejected \
  "unconditional deployment" \
  "deployment must be conditional" \
  "s/if: steps\\.publish_freshness\\.outputs\\.publish == 'true'/if: always()/"

expect_mutation_rejected \
  "work inserted after freshness check" \
  "newest-run freshness check must be immediately before deployment" \
  's/(      - name: Deploy to gh-pages)/      - name: Delay publication\n        run: sleep 1\n\n$1/'

expect_mutation_rejected \
  "retained root files" \
  "must not retain obsolete Pages files" \
  's/(          force_orphan: true)/$1\n          keep_files: true/'

expect_mutation_rejected \
  "non-orphan root publication" \
  "must replace gh-pages with a fresh orphan commit" \
  's/^          force_orphan: true\n//m'

expect_mutation_rejected \
  "missing guide assembly" \
  "complete Pages tree does not include the user guide" \
  's/^          cp -R docs-site\/\.vitepress\/dist apps\/browser-demos\/dist\/guide\n//m'

expect_mutation_rejected \
  "missing API assembly" \
  "complete Pages tree does not include the API docs" \
  's/^          cp -R host\/docs apps\/browser-demos\/dist\/api\n//m'

expect_mutation_rejected \
  "missing deployed generation evidence" \
  "must publish its exact source and package generation evidence" \
  's/apps\/browser-demos\/dist\/kandelo-deployment\.json/apps\/browser-demos\/dist\/missing-generation.json/'

expect_mutation_rejected \
  "missing assembled-tree size gate" \
  "must assemble and size-check the complete tree" \
  's/      - name: Enforce the GitHub Pages published-site size limit/      - name: Report the assembled tree size/'

expect_mutation_rejected \
  "raised Pages size limit" \
  "must enforce GitHub's 1,000,000,000-byte site limit" \
  's/apps\/browser-demos\/dist 1000000000/apps\/browser-demos\/dist 2000000000/'

[ -f "$CANARY_WORKFLOW" ] ||
  fail "native Pages canary is absent: $CANARY_WORKFLOW_REL"
grep -Fq 'PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers" npx playwright install' \
  "$CANARY_WORKFLOW" &&
  grep -Fq '"PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" \' \
    "$CANARY_WORKFLOW" ||
  fail "canary must install and run Chromium from one explicit browser root"
grep -Fq '"WASM_POSIX_BINARY_CACHE_ROOT=$WASM_POSIX_BINARY_CACHE_ROOT" \' \
  "$CANARY_WORKFLOW" ||
  fail "canary must retain the isolated package cache inside dev-shell"
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
  "canary input materialization must forbid source fallback" \
  's/--fetch-only/--allow-stale/'

expect_canary_mutation_rejected \
  "implicit Playwright install root" \
  "canary must install and run Chromium from one explicit browser root" \
  's/PLAYWRIGHT_BROWSERS_PATH="\$playwright_browsers" npx playwright install/npx playwright install/'

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
