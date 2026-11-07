#!/usr/bin/env bash
# Optional report capture for one test process; preserve its exit status.
set -euo pipefail
format="$1"
shift
if [ -z "${KANDELO_TEST_REPORT_DIR:-}" ]; then
    exec "$@"
fi
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
case "$KANDELO_TEST_REPORT_DIR" in
    /*) report_root="$KANDELO_TEST_REPORT_DIR" ;;
    *) report_root="$repo_root/$KANDELO_TEST_REPORT_DIR" ;;
esac
mkdir -p "$report_root"
report_root="$(cd "$report_root" && pwd)"
run_dir="$(mktemp -d "$report_root/$format.XXXXXX")"
case "$format" in
    vitest)
        options=(--reporter=default
            "--reporter=$repo_root/host/test/support/suite-health-reporter.ts"
            --reporter=json "--outputFile.json=$run_dir/report.json") ;;
    playwright)
        export PLAYWRIGHT_JSON_OUTPUT_FILE="$run_dir/report.json"
        options=(--reporter=list,json) ;;
    *) echo "unsupported report format: $format" >&2; exit 2 ;;
esac
echo "Test report: $run_dir"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
commit="$(git -C "$repo_root" rev-parse HEAD)"
if "$@" "${options[@]}" 2>&1 | tee "$run_dir/console.log"; then
    status=0
else
    statuses=("${PIPESTATUS[@]}")
    status="${statuses[0]}"
    # A failed log writer must not look like a successful recording.
    if [ "$status" -eq 0 ]; then exit "${statuses[1]}"; fi
fi
jq -n --arg suite "$format" --arg repo_root "$repo_root" --arg cwd "$PWD" \
    --arg runtime "${KANDELO_VITEST_RUNTIME:-node}" --arg console_log "$run_dir/console.log" \
    --arg commit "$commit" --arg started_at "$started_at" \
    --argjson exit_code "$status" --args \
    '{suite:$suite, repo_root:$repo_root, cwd:$cwd, runtime:$runtime,
      console_log:$console_log, commit:$commit,
      started_at:$started_at, exit_code:$exit_code, command:$ARGS.positional}' \
    -- "$@" "${options[@]}" > "$run_dir/context.json"
exit "$status"
