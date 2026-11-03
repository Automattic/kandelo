#!/usr/bin/env bash
# Run upstream dEQP-GLES2 or dEQP-EGL, chunked, on one host, with complete
# per-case accounting. One command per suite and host:
#
#   scripts/run-graphics-cts.sh <gles2|egl> <node|chromium|firefox|webkit> [selector] [--strict]
#
# selector: all (default), a top-level group (functional, info, ...), a
# family (functional.fbo or dEQP-GLES2.functional.fbo), a legacy GLES2
# name (negative-state, negative-api, color-clear), or a comma-separated
# union. Environment:
#   KANDELO_CTS_OUT          result directory (default .context/graphics-cts-runs/<suite>-<host>-<time>)
#   KANDELO_CTS_CHUNK_SIZE   cases per chunk (default 100 GLES2, 50 EGL)
#   KANDELO_CTS_CHUNKS       comma-separated chunk IDs to rerun only those
#   KANDELO_CTS_ATTEMPT_BASE_MS  time for the guest to reach its first case (default 60000)
#   KANDELO_CTS_CASE_MS      time from one dEQP "Test case" line to the next (default 600000)
#   KANDELO_CTS_MAX_ATTEMPTS resumes per chunk after attributed crashes (default 8)
#   KANDELO_CTS_STRICT=1     same as --strict
#   KANDELO_GL_AUDIT         record|fatal: run with the test-only GL native-divergence audit
#                            (docs/graphics/conformance-testing.md); records go to <host>/gl-audit/
# Writes plan.json, <host>/<chunk>.json, <host>/qpa/*.qpa, summary.json and
# cases.tsv. Without --strict the exit status reports only runner failures;
# with --strict any Fail/Crash/Timeout/Missing (or other non-passing upstream
# status) also fails. NotSupported and Missing are never counted as Pass.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
usage() { echo "usage: $0 <gles2|egl> <node|chromium|firefox|webkit> [selector] [--strict]" >&2; exit 2; }
strict="${KANDELO_CTS_STRICT:-0}"
positional=()
for argument in "$@"; do
    case "$argument" in
        --strict) strict=1 ;;
        -*) usage ;;
        *) positional+=("$argument") ;;
    esac
done
[[ ${#positional[@]} -ge 2 && ${#positional[@]} -le 3 ]] || usage
suite="${positional[0]}" host="${positional[1]}" selector="${positional[2]:-all}"
case "$suite" in gles2|egl) ;; *) usage ;; esac
case "$host" in node|chromium|firefox|webkit) ;; *) usage ;; esac
if [[ -n "${PWDEBUG:-}" && "${PWDEBUG}" != 0 ]]; then
    echo "Graphics CTS requires PWDEBUG unset or 0 to keep browser checks headless." >&2
    exit 2
fi
out="${KANDELO_CTS_OUT:-$repo_root/.context/graphics-cts-runs/$suite-$host-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

node --test "$repo_root/tests/graphics/cts-plan.test.mjs" "$repo_root/tests/graphics/cts-accounting.test.mjs" \
    "$repo_root/tests/graphics/cts-qpa.test.mjs" "$repo_root/tests/graphics/cts-progress.test.mjs"
plan_arguments=(plan --suite "$suite" --selector "$selector" --out "$out")
[[ -n "${KANDELO_CTS_CHUNK_SIZE:-}" ]] && plan_arguments+=(--chunk-size "$KANDELO_CTS_CHUNK_SIZE")
[[ -n "${KANDELO_CTS_CHUNKS:-}" ]] && plan_arguments+=(--chunks "$KANDELO_CTS_CHUNKS")
node "$repo_root/tests/graphics/cts-run.mjs" "${plan_arguments[@]}"

export KANDELO_CTS_PLAN="$out/plan.json" KANDELO_CTS_OUT="$out"
runner_status=0
if [[ "$host" == node ]]; then
    (cd "$repo_root/host" && npx vitest run -c vitest.graphics-cts.config.ts) || runner_status=$?
else
    (cd "$repo_root/apps/browser-demos" && node node_modules/@playwright/test/cli.js test \
        --config playwright.graphics-cts-suite.config.ts --project "$host" --workers 1 --retries 0) || runner_status=$?
fi

summary_arguments=(summarize --out "$out" --engines "$host")
[[ "$strict" == 1 ]] && summary_arguments+=(--strict)
summary_status=0
node "$repo_root/tests/graphics/cts-run.mjs" "${summary_arguments[@]}" || summary_status=$?
echo "results: $out/summary.json $out/cases.tsv"
if [[ $runner_status -ne 0 ]]; then
    echo "runner exited $runner_status: chunks without results are counted as Missing" >&2
    exit "$runner_status"
fi
exit "$summary_status"
