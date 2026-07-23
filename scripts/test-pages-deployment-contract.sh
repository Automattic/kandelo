#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$REPO_ROOT/scripts/ci-check-pages-deployment.sh"
PAGES_WORKFLOW_REL=".github/workflows/browser-demos-pages.yml"
PAGES_WORKFLOW="$REPO_ROOT/$PAGES_WORKFLOW_REL"
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

bash "$CHECKER" "$REPO_ROOT"

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
  "missing docs-only trigger" \
  "does not watch docs-site/**" \
  's/^      - "docs-site\/\*\*"\n//m'

expect_mutation_rejected \
  "missing browser package scanner trigger" \
  "does not watch scripts/browser-binary-package-roots.mjs" \
  's/^      - "scripts\/browser-binary-package-roots\.mjs"\n//m'

expect_mutation_rejected \
  "missing package-registry trigger" \
  "does not watch packages/registry/**" \
  's/^      - "packages\/registry\/\*\*"\n//m'

expect_mutation_rejected \
  "bypassed package projection check" \
  "must verify the generated package projection" \
  's/build-deps program-index-check/build-deps parse/'

expect_mutation_rejected \
  "checkout of a different ref" \
  "checkout must use the workflow event source SHA" \
  's/(        uses: actions\/checkout@[^\n]+\n)/$1        with:\n          ref: main\n/'

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

echo "test-pages-deployment-contract: ok"
