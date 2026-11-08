#!/usr/bin/env bash
# Synthetic wrapper contract checks, not baseline evidence or runtime tests.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
wrapper="$repo_root/scripts/record-test-report.sh"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-report-test.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Disabled capture adds no arguments and preserves the command's status.
unset KANDELO_TEST_REPORT_DIR
status=0
bash "$wrapper" vitest bash -c 'test "$#" -eq 0 || exit 99; exit 7' stub || status=$?
test "$status" -eq 7

export KANDELO_TEST_REPORT_DIR="$scratch/reports with spaces"
for attempt in 1 2; do
    status=0
    bash "$wrapper" vitest bash -c '
        for arg do
            case "$arg" in
                --outputFile.json=*) printf "{}\n" > "${arg#*=}" ;;
            esac
        done
        echo synthetic-console-line
        exit 3
    ' stub > "$scratch/run-$attempt.log" || status=$?
    test "$status" -eq 3
done
count=0
for run in "$KANDELO_TEST_REPORT_DIR"/vitest.*; do
    count=$((count + 1))
    test -f "$run/report.json"
    rg -q '^synthetic-console-line$' "$run/console.log"
    jq -e --arg root "$repo_root" \
        '.exit_code == 3 and .repo_root == $root and .suite == "vitest"
         and (.command[-1] | startswith("--outputFile.json="))' \
        "$run/context.json" > /dev/null
done
test "$count" -eq 2

bash "$wrapper" playwright bash -c 'printf "{}\n" > "$PLAYWRIGHT_JSON_OUTPUT_FILE"' stub > "$scratch/playwright.log"
for run in "$KANDELO_TEST_REPORT_DIR"/playwright.*; do
    test -f "$run/report.json"
    jq -e '.exit_code == 0 and .suite == "playwright"' "$run/context.json" > /dev/null
done
echo 'Report wrapper checks passed: opt-in capture, distinct runs, console logs and exit status.'
