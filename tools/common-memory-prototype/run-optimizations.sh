#!/usr/bin/env bash
set -euo pipefail
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
out="${1:?usage: run-optimizations.sh fresh-output-directory [checks|bench]}"
action="${2:-bench}"
case "$action" in checks|bench) ;; *) echo 'expected checks|bench' >&2; exit 2 ;; esac
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
if [ -e "$out/provenance.json" ]; then
  echo "refusing to overwrite recorded inputs: $out" >&2
  exit 2
fi
python3 tools/common-memory-prototype/generate.py "$out"
python3 tools/common-memory-prototype/build-optimizations.py "$out"
python3 tools/common-memory-prototype/provenance.py "$out"
node tools/common-memory-prototype/run-node.mjs "$out" --checks-only
export KANDELO_COMMON_MEMORY_ARTIFACTS="$out" KANDELO_COMMON_MEMORY_CHECKS_ONLY=1
npx playwright test --config tools/common-memory-prototype/playwright.config.ts
if [ "$action" = checks ]; then
  node tools/common-memory-prototype/optimization-node.mjs "$out"
  npx playwright test --config tools/common-memory-prototype/optimization.config.ts
else
  unset KANDELO_COMMON_MEMORY_CHECKS_ONLY
  node tools/common-memory-prototype/optimization-node.mjs "$out" --bench --cohort 1
  node tools/common-memory-prototype/optimization-node.mjs "$out" --bench --cohort 2
  npx playwright test --config tools/common-memory-prototype/optimization.config.ts --repeat-each 2
fi
python3 tools/common-memory-prototype/provenance.py "$out" --check
python3 tools/common-memory-prototype/summarize-optimizations.py "$out"
