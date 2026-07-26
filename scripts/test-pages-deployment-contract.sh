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
  "missing source-shell config trigger" \
  "does not watch homebrew/source-rootfs-shell-default.json" \
  's/^      - "homebrew\/source-rootfs-shell-default\.json"\n//m'

expect_mutation_rejected \
  "missing source-shell recipe trigger" \
  "does not watch homebrew/source-rootfs-shell-package/**" \
  's/^      - "homebrew\/source-rootfs-shell-package\/\*\*"\n//m'

expect_mutation_rejected \
  "bypassed package projection check" \
  "must verify the generated package projection" \
  's/build-deps program-index-check/build-deps parse/'

expect_mutation_rejected \
  "bypassed source-fallback sysroot build" \
  "must build and verify the current source-fallback sysroot" \
  's/bash scripts\/dev-shell\.sh bash scripts\/build-musl\.sh/echo skipped-source-sysroot/'

expect_mutation_rejected \
  "missing exact-main cache root" \
  "must establish one exact-main package-cache root" \
  's/^          echo "WASM_POSIX_BINARY_CACHE_ROOT=\$source_cache" >> "\$GITHUB_ENV"\n//m'

expect_mutation_rejected \
  "cache root lost inside dev-shell" \
  "browser preparation must retain the exact-main cache root inside dev-shell" \
  's/^            "WASM_POSIX_BINARY_CACHE_ROOT=\$WASM_POSIX_BINARY_CACHE_ROOT" \\\n//m'

expect_mutation_rejected \
  "canonical shell preparation fallback" \
  "must select the source-rootfs recipe with exact event provenance" \
  's/prepare-browser --source-rootfs-shell --allow-stale/prepare-browser --allow-stale/'

expect_mutation_rejected \
  "missing source-shell isolation attestation" \
  "must select the source-rootfs recipe with exact event provenance" \
  's/^            "WASM_POSIX_SOURCE_ROOTFS_SHELL_ISOLATION=pages-exact-main-v1" \\\n//m'

expect_mutation_rejected \
  "missing hosted-runner attestation" \
  "must select the source-rootfs recipe with exact event provenance" \
  's/^            "WASM_POSIX_SOURCE_ROOTFS_SHELL_RUNNER_ENVIRONMENT=\$\{\{ runner\.environment \}\}" \\\n//m'

expect_mutation_rejected \
  "swallowed source-shell preparation failure" \
  "must select the source-rootfs recipe with exact event provenance" \
  's#(\./run\.sh prepare-browser --source-rootfs-shell --allow-stale)#$1 || true#'

expect_mutation_rejected \
  "work after source-shell preparation command" \
  "must be the final failure-propagating command" \
  's#(\./run\.sh prepare-browser --source-rootfs-shell --allow-stale\n)#$1          echo continued\n#'

expect_mutation_rejected \
  "source-shell repository not bound to event repository" \
  "must select the source-rootfs recipe with exact event provenance" \
  's#https://github\.com/\$GITHUB_REPOSITORY#https://github.com/stale/repository#'

expect_mutation_rejected \
  "source-shell commit not bound to event SHA" \
  "must select the source-rootfs recipe with exact event provenance" \
  's/WASM_POSIX_SOURCE_ROOTFS_SHELL_COMMIT=\$GITHUB_SHA/WASM_POSIX_SOURCE_ROOTFS_SHELL_COMMIT=0000000000000000000000000000000000000000/'

expect_mutation_rejected \
  "sealed preview without Pages base" \
  "sealed Pages preview must boot with the same /kandelo/ base" \
  's/(      - name: Boot the sealed Pages shell product in Chromium\n        working-directory: apps\/browser-demos\n        env:\n)          VITE_BASE: \/kandelo\/\n/$1/'

expect_mutation_rejected \
  "sealed preview loses package cache root" \
  "sealed Pages preview must boot with the same /kandelo/ base" \
  's/(      - name: Boot the sealed Pages shell product in Chromium[\s\S]*?)^              "WASM_POSIX_BINARY_CACHE_ROOT=\$WASM_POSIX_BINARY_CACHE_ROOT" \\\n/$1/m'

expect_mutation_rejected \
  "checkout of a different ref" \
  "checkout must use the workflow event source SHA" \
  's/(        uses: actions\/checkout@[^\n]+\n)/$1        with:\n          ref: main\n/'

expect_mutation_rejected \
  "checkout with persisted write credentials" \
  "source-building Pages checkout must not persist write credentials" \
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
