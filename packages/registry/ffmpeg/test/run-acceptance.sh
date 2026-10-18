#!/usr/bin/env bash
# The FFmpeg acceptance run (design §2, §8): every tier, on both hosts, with
# skips counted as failures. Run under scripts/dev-shell.sh after
# `./run.sh setup` and `./run.sh prepare-browser`.
#
#   bash packages/registry/ffmpeg/test/run-acceptance.sh [out-dir]
#
# Reports land in out-dir (default: a fresh temporary directory): the Vitest
# and Playwright JSON reports and FATE's fate-report.json.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/ffmpeg-acceptance.XXXXXX")}"
mkdir -p "$OUT"
export KANDELO_FFMPEG_ACCEPTANCE=1

# Fail on a skipped or todo test as well as a failed one. The counts come
# from the reporters' JSON, not from matching their human-readable output.
check_report() {
    local label="$1" report="$2" counts="$3"
    node -e '
        const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const counts = (new Function("r", "return " + process.argv[2]))(report);
        const bad = Object.entries(counts).filter(([k, v]) => k !== "passed" && v !== 0);
        console.log(process.argv[3] + ": " + JSON.stringify(counts));
        if (counts.passed === 0 || bad.length) process.exit(1);
    ' "$report" "$counts" "$label" || {
        echo "acceptance: $label had failed, skipped, or no tests ($report)" >&2
        exit 1
    }
}

echo "==> Node tiers (Vitest)"
(
    cd "$REPO_ROOT/host"
    npx vitest run --reporter=verbose --reporter=json --outputFile="$OUT/vitest.json" \
        ../packages/registry/ffmpeg/test/fixtures-manifest.test.ts \
        ../packages/registry/ffmpeg/test/ffmpeg-tier1.test.ts \
        ../packages/registry/ffmpeg/test/ffmpeg-process-runtime.test.ts \
        ../packages/registry/ffmpeg/test/ffmpeg-tier2-bbb.test.ts \
        ../packages/registry/ffmpeg/test/ffmpeg-devices.test.ts \
        </dev/null
) || { echo "acceptance: a Node tier failed" >&2; exit 1; }
check_report "node tiers" "$OUT/vitest.json" \
    '({passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests, todo: r.numTodoTests})'

echo "==> FATE through Kandelo"
FATE_OUT="$OUT/fate" bash "$REPO_ROOT/packages/registry/ffmpeg/test/fate/run-fate.sh"
check_report "fate" "$OUT/fate/fate-report.json" \
    '({passed: r.run - r.failed.length, failed: r.failed.length})'

echo "==> Browser (Playwright, Chromium)"
(
    cd "$REPO_ROOT/apps/browser-demos"
    PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/playwright.json" \
        npx playwright test test/kandelo-ffmpeg.spec.ts --project=chromium \
        --reporter=list,json
) || { echo "acceptance: a browser test failed" >&2; exit 1; }
check_report "browser" "$OUT/playwright.json" \
    '({passed: r.stats.expected, failed: r.stats.unexpected, flaky: r.stats.flaky, skipped: r.stats.skipped})'

echo "acceptance: all tiers ran and passed (reports in $OUT)"
