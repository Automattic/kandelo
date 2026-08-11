#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$REPO_ROOT/scripts/ci-check-pages-deployment.sh"
PAGES_WORKFLOW_REL=".github/workflows/browser-demos-pages.yml"
PAGES_WORKFLOW="$REPO_ROOT/$PAGES_WORKFLOW_REL"
CANARY_WORKFLOW_REL=".github/workflows/abi-staging-pages-canary.yml"
CANARY_WORKFLOW="$REPO_ROOT/$CANARY_WORKFLOW_REL"
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
  printf '%s\n' "$fixture"
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

bash "$CHECKER" "$REPO_ROOT"
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
  "bypassed package projection check" \
  "must verify the generated package projection" \
  's/build-deps program-index-check/build-deps parse/'

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
  "canonical Pages product must not activate the source bridge" \
  's#(            \./run\.sh --fetch-only \\\n)#$1              --allow-stale \\\n#'

expect_mutation_rejected \
  "swallowed canonical preparation failure" \
  "must be the final failure-propagating command" \
  's#(--require-sealed-homebrew-selection prepare-browser)#$1 || true#'

expect_mutation_rejected \
  "work after canonical preparation command" \
  "must be the final failure-propagating command" \
  's#(--require-sealed-homebrew-selection prepare-browser\n)#$1          echo continued\n#'

expect_mutation_rejected \
  "missing sealed shell artifact check" \
  "must bind the canonical shell, bootstrap, and embedded mirror plan" \
  's/scripts\/verify-homebrew-main-shell-artifact-lock\.sh/scripts\/skipped-artifact-lock.sh/'

expect_mutation_rejected \
  "shell-only Pages build" \
  "must build the complete browser entry set" \
  's/(      - name: Build browser demos for GitHub Pages\n        working-directory: apps\/browser-demos\n)/$1        env:\n          KANDELO_BROWSER_DEMO_INPUTS: main\n/'

expect_mutation_rejected \
  "missing public product inspector" \
  "must bind the canonical shell, bootstrap, and embedded mirror plan" \
  's/scripts\/inspect-homebrew-main-shell-public-product\.ts/scripts\/skipped-public-product.ts/'

expect_mutation_rejected \
  "missing public product inspector rejection tests" \
  "must run the public-product inspector rejection tests" \
  's/scripts\/inspect-homebrew-main-shell-public-product\.test\.ts/scripts\/skipped-public-product.test.ts/'

expect_mutation_rejected \
  "eager mirror recovery during inspection" \
  "must not eagerly download the complete bottle mirror" \
  's#(          test ! -e "\$report"\n)#$1          npx tsx scripts/recover-homebrew-bottle-mirror.ts\n#'

expect_mutation_rejected \
  "missing hashed shell asset verifier" \
  "must verify its exact hashed shell asset" \
  's/scripts\/verify-browser-shell-vfs-asset\.sh/scripts\/skipped-browser-shell-vfs-asset.sh/'

expect_mutation_rejected \
  "hashed shell verifier bound to another image" \
  "must verify its exact hashed shell asset" \
  's/dist "\$\{\{ steps\.shell_product\.outputs\.image \}\}"/dist "unbound.vfs.zst"/'

expect_mutation_rejected \
  "unhashed public shell comparison" \
  "must not trust Vite's optional unhashed public shell copy" \
  's/(          npm run build\n)/$1          cmp dist\/shell.vfs.zst expected.vfs.zst\n/'

expect_mutation_rejected \
  "unhashed source-tree shell comparison" \
  "must not trust Vite's optional unhashed public shell copy" \
  's/(          done\n)/$1          cmp "\$image" apps\/browser-demos\/public\/shell.vfs.zst\n/'

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
  "closed bottle transport in Pages" \
  "must prove the public bottled shell at the published base" \
  's/KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE: public/KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE: closed/'

expect_mutation_rejected \
  "bottled preview broadens its demo inputs" \
  "must prove the public bottled shell at the published base" \
  's/KANDELO_BROWSER_DEMO_INPUTS: main/KANDELO_BROWSER_DEMO_INPUTS: all/'

expect_mutation_rejected \
  "bottled preview without Pages base" \
  "must prove the public bottled shell at the published base" \
  's/(      - name: Boot the canonical bottled Pages shell in Chromium\n        working-directory: apps\/browser-demos\n        env:\n)          VITE_BASE: \/kandelo\/\n/$1/'

expect_mutation_rejected \
  "bottled preview loses package cache root" \
  "must prove the public bottled shell at the published base" \
  's/(      - name: Boot the canonical bottled Pages shell in Chromium[\s\S]*?)^            "WASM_POSIX_BINARY_CACHE_ROOT=\$WASM_POSIX_BINARY_CACHE_ROOT" \\\n/$1/m'

expect_mutation_rejected \
  "bottled preview uses the retired source test" \
  "must prove the public bottled shell at the published base" \
  's/test\/kandelo-homebrew-main-shell\.spec\.ts/test\/kandelo-source-rootfs-shell.spec.ts/'

expect_mutation_rejected \
  "checkout of a different ref" \
  "checkout must use the workflow event source SHA" \
  's/(        uses: actions\/checkout@[^\n]+\n)/$1        with:\n          ref: main\n/'

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
  's/GH_TOKEN: \$\{\{ github\.token \}\}/GH_TOKEN: ""/'

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
  "wrong freshness workflow" \
  "canary newest-run guard must query only the canary workflow" \
  's/PAGES_WORKFLOW_FILE: abi-staging-pages-canary\.yml/PAGES_WORKFLOW_FILE: browser-demos-pages.yml/'

expect_canary_mutation_rejected \
  "bypassed newest-run guard" \
  "canary upload authority must come from the tested newest-run checker" \
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
  's/          retention-days: 7/          retention-days: 1/'

expect_canary_mutation_rejected \
  "work after newest-run guard" \
  "canary newest-run guard must be immediately before upload" \
  's/(      - name: Upload the complete inert Pages canary)/      - name: Delay the inert upload\n        run: sleep 1\n\n$1/'

expect_canary_mutation_rejected \
  "deployment action" \
  "canary must never deploy Pages" \
  's#actions/upload-pages-artifact\@fc324d3547104276b827a68afc52ff2a11cc49c9#actions/deploy-pages\@f29b9056696d8d80070d321737a6805413dbdea1#'

expect_canary_mutation_rejected \
  "branch mutation" \
  "canary must not mutate a publication branch" \
  's/(      - name: Upload the complete inert Pages canary)/      - name: Mutate publication branch\n        run: git push origin HEAD:gh-pages\n\n$1/'

echo "test-pages-deployment-contract: ok"
