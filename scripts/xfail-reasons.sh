# shellcheck shell=bash
# Expected-failure (XFAIL) reason checks shared by the conformance runners
# (run-libc-tests.sh, run-posix-tests.sh, run-sortix-tests.sh).
#
# Why: an XFAIL entry turns any failure of its test green. Its rationale was
# only a comment, so nothing noticed when a test began failing for a
# different reason. On 2026-09-25, three libc XFAILs documented as "OOM
# differs in Wasm" turned out to be a miscompiled test helper failing in
# setup, and every suite was failing before any guest started while
# pthread_cancel still read as its documented XFAIL. Each runner now records,
# next to each XFAIL, how that test is expected to fail, and a failure that
# does not match is reported as XFAIL-MISMATCH and counted as a failure.
#
# A recorded reason is "<kind>" or "<kind>:<extended regex>":
#   kind   timeout | exit | build | unresolved | output | outcome | any
#          (each runner documents which kinds it produces)
#   regex  must match somewhere in the failing test's output
# An XFAIL with no recorded reason is a mismatch too: the reason is the
# point of the entry.
#
# Judged by evals/build-waiting/README.md (tool 5).

# xfail_check <recorded-reason> <observed-kind> <output>
# Returns 0 when the failure matches its recorded reason. Otherwise returns 1
# and sets XFAIL_MISMATCH to a one-line explanation.
xfail_check() {
    local spec="$1" kind="$2" output="$3"
    local want_kind="${spec%%:*}" regex=""
    case "$spec" in *:*) regex="${spec#*:}" ;; esac
    XFAIL_MISMATCH=""
    if [ -z "$spec" ]; then
        XFAIL_MISMATCH="no recorded failure reason (observed: $kind: $(xfail_last_line "$output"))"
        return 1
    fi
    if [ "$want_kind" != "any" ] && [ "$want_kind" != "$kind" ]; then
        XFAIL_MISMATCH="expected to fail by $want_kind, failed by $kind: $(xfail_last_line "$output")"
        return 1
    fi
    if [ -n "$regex" ] && ! printf '%s\n' "$output" | grep -Eq -- "$regex"; then
        XFAIL_MISMATCH="output does not match /$regex/: $(xfail_last_line "$output")"
        return 1
    fi
    return 0
}

# The last non-blank output line, trimmed, for one-line diagnostics.
xfail_last_line() {
    local line
    line="$(printf '%s\n' "$1" | sed -e 's/\x1b\[[0-9;]*m//g' | grep -v '^[[:space:]]*$' | tail -1 | cut -c1-200)"
    printf '%s' "${line:-(no output)}"
}
