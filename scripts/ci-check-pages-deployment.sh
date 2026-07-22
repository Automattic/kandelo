#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSER_WORKFLOW="$REPO_ROOT/.github/workflows/browser-demos-pages.yml"
DOCS_WORKFLOW="$REPO_ROOT/.github/workflows/docs.yml"

fail() {
  echo "ci-check-pages-deployment: $*" >&2
  exit 1
}

step_block() {
  local workflow="$1"
  local step="$2"
  awk -v step="$step" '
    $0 == "      - name: " step { inside = 1 }
    inside && $0 ~ /^      - name:/ && $0 != "      - name: " step { exit }
    inside { print }
  ' "$workflow"
}

browser_deploy="$(step_block "$BROWSER_WORKFLOW" "Deploy to gh-pages")"
guide_deploy="$(step_block "$DOCS_WORKFLOW" "Deploy user guide to gh-pages")"
api_deploy="$(step_block "$DOCS_WORKFLOW" "Deploy API docs to gh-pages")"

for workflow in "$BROWSER_WORKFLOW" "$DOCS_WORKFLOW"; do
  grep -Fxq '  group: kandelo-gh-pages' "$workflow" ||
    fail "every gh-pages publisher must share the deployment concurrency group"
  grep -Fxq '  cancel-in-progress: false' "$workflow" ||
    fail "gh-pages publishers must finish rather than cancel an in-flight deployment"
done

grep -Fq 'force_orphan: true' <<<"$browser_deploy" ||
  fail "the root publisher must replace gh-pages without cloning retained assets"
if grep -Fq 'keep_files:' <<<"$browser_deploy"; then
  fail "the root publisher must not configure retention of obsolete browser assets"
fi

for required_path in 'docs-site/**' 'host/typedoc.json' 'host/tsconfig.docs.json'; do
  grep -Fq -- "- \"$required_path\"" "$BROWSER_WORKFLOW" ||
    fail "the complete Pages publisher does not watch $required_path"
done

guide_build_line="$(grep -nF -- '- name: Build user guide for the complete Pages tree' "$BROWSER_WORKFLOW" | cut -d: -f1)"
api_build_line="$(grep -nF -- '- name: Build API docs for the complete Pages tree' "$BROWSER_WORKFLOW" | cut -d: -f1)"
assembly_line="$(grep -nF -- '- name: Add documentation to the complete Pages tree' "$BROWSER_WORKFLOW" | cut -d: -f1)"
deploy_line="$(grep -nF -- '- name: Deploy to gh-pages' "$BROWSER_WORKFLOW" | cut -d: -f1)"

[ -n "$guide_build_line" ] && [ -n "$api_build_line" ] &&
  [ -n "$assembly_line" ] && [ -n "$deploy_line" ] &&
  [ "$guide_build_line" -lt "$assembly_line" ] &&
  [ "$api_build_line" -lt "$assembly_line" ] &&
  [ "$assembly_line" -lt "$deploy_line" ] ||
  fail "the root publisher must assemble current guide and API docs before deployment"

grep -Fq 'cp -R docs-site/.vitepress/dist apps/browser-demos/dist/guide' "$BROWSER_WORKFLOW" ||
  fail "the complete Pages tree does not include the user guide"
grep -Fq 'cp -R host/docs apps/browser-demos/dist/api' "$BROWSER_WORKFLOW" ||
  fail "the complete Pages tree does not include the API docs"

for spec in "guide:$guide_deploy" "api:$api_deploy"; do
  destination="${spec%%:*}"
  block="${spec#*:}"
  grep -Fq "destination_dir: $destination" <<<"$block" ||
    fail "the $destination publisher must remain confined to its owned subtree"
  if grep -Fq 'keep_files:' <<<"$block"; then
    fail "the $destination publisher must not configure retention in its owned subtree"
  fi
  if grep -Fq 'force_orphan:' <<<"$block"; then
    fail "the $destination publisher must update the existing complete branch, not replace it"
  fi
done

echo "ci-check-pages-deployment: ok"
