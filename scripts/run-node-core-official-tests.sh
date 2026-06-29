#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/run-node-core-official-tests.sh [OPTIONS]

Run the complete official Node.js test/parallel JavaScript suite on
Kandelo's Node-compatible runtime. Use --smoke or --manifest-only for the
small curated manifest.

Upstream source:
  nodejs/node tag v22.0.0
  tag object ec49bec48284ab642db1d109d917c6ae3b695c13
  peeled commit 12fb157f79da8c094a54bc99370994941c28c235

Options:
  --host node|browser       Host to run on (default: node)
  --source-dir DIR          Existing nodejs/node checkout
  --cache-dir DIR           Source cache root (default: .cache/node-core-official)
  --fetch-source            Sparse-clone the pinned upstream source if missing
  --manifest FILE           Status manifest (default: tests/node-core-official/manifest.json)
  --results-dir DIR         Artifact directory (default: test-runs/node-core-official-...)
  --runtime FILE            Kandelo Node-compatible wasm binary
  --timeout-ms N            Per-test timeout override
  --jobs N                  Concurrency for the Node host (default from manifest: 1)
  --area NAME               Run only selected entries in this area; repeatable
  --test PATH               Run only this official test path; repeatable
  --full-suite              Discover and run all test/parallel/test-*.js files (default)
  --manifest-only           Run only tests listed in --manifest
  --smoke                   Run only manifest entries marked smoke=true
  --list                    Print selected official test files and exit
  --explain                 Print source, selection, controls, and artifact plan without running
  --help                    Show this help

Artifacts:
  summary.txt, summary.json, results.ndjson, manifest.used.json,
  stdout/<safe-test-name>.log, stderr/<safe-test-name>.log, and for browser
  runs browser-console.log. Results are preserved even for expected failures.

Examples:
  scripts/run-node-core-official-tests.sh --fetch-source --explain
  scripts/run-node-core-official-tests.sh --fetch-source --host node --jobs 4
  scripts/run-node-core-official-tests.sh --list --smoke
  scripts/run-node-core-official-tests.sh --fetch-source --smoke --host node
  scripts/run-node-core-official-tests.sh --fetch-source --smoke --host browser
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

exec npx tsx "$REPO_ROOT/scripts/node-core-official-runner.ts" "$@"
