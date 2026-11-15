#!/usr/bin/env bash
set -euo pipefail
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
out="${1:?usage: run.sh unique-output-directory checks|bench [none|O2|O3|Oz]}"
action="${2:-checks}"
opt_level="${3:-none}"
case "$action" in checks|bench) ;; *) echo 'expected checks|bench' >&2; exit 2 ;; esac
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
if [ -e "$out/provenance.json" ]; then
  echo "refusing to overwrite a recorded run: $out" >&2
  exit 2
fi
python3 tools/common-memory-prototype/generate.py "$out" --opt-level "$opt_level"
python3 tools/common-memory-prototype/provenance.py "$out"
node_args=()
if [ "$action" = checks ]; then
  node_args+=(--checks-only)
  export KANDELO_COMMON_MEMORY_CHECKS_ONLY=1
else
  unset KANDELO_COMMON_MEMORY_CHECKS_ONLY
fi
node tools/common-memory-prototype/run-node.mjs "$out" "${node_args[@]}"
export KANDELO_COMMON_MEMORY_ARTIFACTS="$out"
npx playwright test --config tools/common-memory-prototype/playwright.config.ts
python3 tools/common-memory-prototype/provenance.py "$out" --check
python3 tools/common-memory-prototype/summarize.py "$out"
