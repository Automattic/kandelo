# shellcheck shell=bash
# Result accounting shared by the browser conformance wrappers
# (scripts/run-browser-{libc,posix,sortix}-tests.sh).
#
# Every test handed to scripts/browser-test-runner.ts must end in exactly one
# classified result. The runner prints one JSON line per test it ran; when it
# cannot start (its Vite server's port is taken, Chromium fails to launch,
# the test-runner page never becomes ready) or dies mid-run, it exits
# non-zero having printed fewer lines than tests. A wrapper that counts only
# the printed lines lets the missing tests vanish from its totals: PR #1596's
# run lost the whole 55-test Sortix io section that way, with no failure.

# record_missing_browser_results <start-idx> <runner-rc> <id>...
# Records every test from <start-idx> on. The browser runner reserves status
# 2 for missing fixture inputs and reports their details in stderr. Other
# unfinished tests count as ERROR. <id>... is the input order.
record_missing_browser_results() {
    local start_idx="$1" runner_rc="$2"
    shift 2
    local -a ids=("$@")
    local reason
    if [ "$runner_rc" -ne 0 ]; then
        reason="browser runner exited with status $runner_rc before reporting result"
    else
        reason="browser runner did not report a result"
    fi
    while [ "$start_idx" -lt "${#ids[@]}" ]; do
        if [ "$runner_rc" -eq 2 ]; then
            conformance_record_setup_error "${ids[$start_idx]}" "browser fixtures unavailable; see runner diagnostics above"
        else
            echo "ERROR ${ids[$start_idx]}: $reason"
            RESULTS+=("ERROR ${ids[$start_idx]}")
            ERROR_COUNT=$((ERROR_COUNT + 1))
        fi
        start_idx=$((start_idx + 1))
    done
}

# record_runner_exit_after_results <runner-rc> <label>
# A runner that reported every test but still exited non-zero (for example,
# it crashed during teardown) failed; record that as one ERROR.
record_runner_exit_after_results() {
    local runner_rc="$1" label="$2"
    if [ "$runner_rc" -ne 0 ]; then
        echo "ERROR ${label}: browser runner exited with status $runner_rc after reporting all results"
        RESULTS+=("ERROR ${label}")
        ERROR_COUNT=$((ERROR_COUNT + 1))
    fi
}
