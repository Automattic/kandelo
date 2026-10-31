#!/usr/bin/env bash
# Run through ./run.sh test browser-memory (which enters the declared dev shell).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

for directory in . host apps/browser-demos; do
    if [ ! -d "$directory/node_modules" ] || \
       [ "$directory/package-lock.json" -nt "$directory/node_modules/.package-lock.json" ]; then
        (cd "$directory" && npm ci --no-audit --no-fund)
    fi
done

echo "=== Browser memory ownership: source-only contracts ==="
(
    cd apps/browser-demos
    node --import tsx/esm --test test/browser-memory-boundary.test.ts
)

# A missing/stale product is provisioning work, never permission to skip a
# reclamation check. The normal graph reuses verified inputs from its cache.
echo "=== Prepare current browser products ==="
./run.sh prepare-browser
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$REPO_ROOT/local-binaries/source-only-v1"

echo "=== Browser memory ownership and teardown: host regressions ==="
(
    cd host
    npm run build
    npx vitest run --config vitest.browser-memory.config.ts
    npm run test:teardown:engines
)

echo "=== Repeated machine switching: Chromium, Firefox, WebKit ==="
report="$(mktemp "${TMPDIR:-/tmp}/kandelo-browser-memory-report.XXXXXX")"
trap 'rm -f -- "$report"' EXIT
(
    cd apps/browser-demos
    npx playwright install chromium firefox webkit
    # Own the server: reusing a server from a different worktree would test
    # different code/artifacts. The port may be overridden through dev-shell.
    export CI=1 KANDELO_MEMORY_SWITCH_REQUIRED=1
    export PLAYWRIGHT_JSON_OUTPUT_FILE="$report"
    npx playwright test \
        test/machine-audio-activation.spec.ts \
        test/kandelo-memory-switch.spec.ts \
        test/worker-exit-trap.spec.ts \
        --project=chromium --project=firefox --project=webkit --workers=1 \
        --reporter=list,json
)
node --input-type=module - "$report" <<'NODE'
import { readFileSync } from "node:fs";
const { stats } = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (stats.expected < 15 || stats.skipped !== 0 || stats.flaky !== 0 || stats.unexpected !== 0) {
    throw new Error(`Incomplete browser memory evidence: ${JSON.stringify(stats)}`);
}
NODE
echo "=== Browser memory regression gate passed ==="
