# shellcheck shell=bash
# Sortix os-test expectations shared by the Node.js runner
# (scripts/run-sortix-tests.sh) and the browser runner
# (scripts/run-browser-sortix-tests.sh): which tests are expected to fail and
# how, where a test's expected output lives, and how a run's output is
# composed before it is compared.
#
# Why one file: each runner used to keep its own copy, and the copies drifted.
# The browser runner never read tests/sortix/os-test-overrides/, so 15 tests
# whose Kandelo outcome is documented there failed only in the browser; it
# lacked five Node XFAILs and every recorded failure reason, so a browser
# XFAIL could fail for any reason at all. Both runners boot the same kernel
# with the same libc, so a test's expected outcome is a property of Kandelo,
# not of the host. Host-specific entries stay in the runner that needs them,
# each with its reason.
#
# Callers set REPO_ROOT, OS_TEST and OS_TEST_LOCAL before sourcing this file,
# and source scripts/xfail-reasons.sh for xfail_check.

# ── Expected failures ──────────────────────────────────────
# Include tests for headers/features our musl sysroot doesn't provide.
# Format: "header/symbol" matching the test path under tests/sortix/os-test/include/
INCLUDE_EXPECTED_FAIL=(
    "devctl/posix_devctl" "devctl/size_t"      # device control (Sortix/2024, not in musl)
)

BASIC_EXPECTED_FAIL=(
    "devctl/posix_devctl"                                 # device control (Sortix/2024, not in musl)
    "pthread/pthread_attr_setinheritsched"                # priority scheduling not supported. Observed
                                                          # 2026-09-30: the test HANGS (no output, killed at
                                                          # XFAIL_TIMEOUT) instead of failing with an error;
                                                          # unexplained, a candidate defect in pthread_create
                                                          # with PTHREAD_EXPLICIT_SCHED
    "pthread/pthread_getcpuclockid"                       # encoded per-thread CPU clocks are not yet
                                                          # recognized by clock_gettime (EINVAL)
    "syslog/closelog" "syslog/syslog"                    # no /dev/log receiver; keep that boundary visible
    "unistd/fpathconf" "unistd/pathconf"                  # _PC_FILESIZEBITS is truthfully indeterminate until
                                                          # the selected VFS backend can prove a bit width
    "strings/ffsll"                                       # wasm32 test bug (long vs long long)
    # aio/aio_cancel was flaky (FAIL once, XPASS next run) — left
    # off this list; if it starts failing reliably, add it back.
    # The previous Linux-CI-only XFAILs for environ propagation
    # through exec/spawn (spawn/posix_spawn{,p}, unistd/{execle,
    # execve,fexecve}, wordexp/wordexp) now pass on the GHA runner
    # under scripts/dev-shell.sh's `--ignore-environment` build env.
    # They were verified XPASS across multiple PR builds before
    # being removed from this list.
)

LIMITS_EXPECTED_FAIL=()
MALLOC_EXPECTED_FAIL=()
STDIO_EXPECTED_FAIL=()
IO_EXPECTED_FAIL=()
SIGNAL_EXPECTED_FAIL=()
PROCESS_EXPECTED_FAIL=()
PATHS_EXPECTED_FAIL=()

# Both runners boot a machine with the internet egress link
# (host/src/networking/egress-link.ts): eth0 is 10.0.2.15/24 behind a NAT
# gateway that carries TCP only. The browser's carries it through fetch; the
# Node runner's forwards nothing, so a conformance run never reaches the
# host's network. Each entry below is either that boundary or a recorded
# defect, with its reason in xfail_expected_reason.
UDP_EXPECTED_FAIL=(
    # Boundary: no UDP datagram leaves the machine; the gateway answers
    # EHOSTUNREACH. Browsers expose no raw UDP.
    "connect-wan-send-reconnect-loopback-send"
    "shutdown-r-send"
    # Defect: a socket bound to 127.0.0.1 connects to an off-machine address
    # and keeps its loopback source. Linux refuses that route with EINVAL.
    "connect-loopback-reconnect-wan-getsockname"
    # Defect: a datagram sent to the machine's own eth0 address is handed to
    # the gateway (EHOSTUNREACH) instead of being delivered locally.
    "cross-netif-loopback-send-lan-recv"
    # Defect: the egress link refuses a bind to its own subnet broadcast
    # address, 10.0.2.255, which Linux allows.
    "bind-lan-subnet-broadcast"
)

# How each XFAIL above is expected to fail, checked by xfail_check (see
# scripts/xfail-reasons.sh). Why: an XFAIL entry used to turn ANY failure of
# its test green, so a test that started failing for a new reason (a broken
# helper, a runner that never started the guest) stayed hidden behind its old
# rationale, and the run was cited as clean until someone re-investigated.
# Keys are "<suite>/<test>". Kinds both runners observe: outcome (include
# suite: the compile probe's outcome word), build (no wasm was produced),
# timeout, output (the run's output matched no expect file; output starts
# with "exit <code>"). The Node runner gives only XFAILs recorded as
# "timeout" its shorter XFAIL_TIMEOUT. An XFAIL that fails any other way is
# an XFAIL-MISMATCH.
xfail_expected_reason() {
    case "$1" in
        include/devctl/*) echo "outcome:missing_header" ;;
        basic/devctl/posix_devctl) echo "build:wasm not found" ;;
        basic/pthread/pthread_attr_setinheritsched) echo "timeout" ;;
        basic/pthread/pthread_getcpuclockid) echo "output:clock_gettime self cpu clock: EINVAL" ;;
        basic/syslog/closelog) echo "output:openlog: ENOENT" ;;
        basic/syslog/syslog) echo "output:syslog: EDESTADDRREQ" ;;
        basic/unistd/fpathconf|basic/unistd/pathconf) echo "output:_PC_FILESIZEBITS" ;;
        basic/strings/ffsll) echo "output:ffsll\(.*\) gave" ;;
        udp/connect-wan-send-reconnect-loopback-send) echo "output:first send: EHOSTUNREACH" ;;
        udp/shutdown-r-send) echo "output:sendto: EHOSTUNREACH" ;;
        udp/connect-loopback-reconnect-wan-getsockname) echo "output:^127\.0\.0\.1:same port" ;;
        udp/cross-netif-loopback-send-lan-recv) echo "output:sendto: EHOSTUNREACH" ;;
        udp/bind-lan-subnet-broadcast) echo "output:bind: EADDRNOTAVAIL" ;;
        *) echo "" ;;
    esac
}

# sortix_expect_dirs <suite> <test-name>
# Sets SORTIX_EXPECT_DIRS to the directories whose candidates the test's
# output is compared against, in order. A repository override directory
# (tests/sortix/os-test-overrides/<suite>.expect) replaces the other
# candidates when it has one for the test; otherwise os-test-local's replace
# upstream's. An <suite>.expect-additional directory adds documented Kandelo
# outcomes without shadowing the upstream ones (see that directory's README).
sortix_expect_dirs() {
    local suite="$1" expect_base="${2##*/}"
    local override="$REPO_ROOT/tests/sortix/os-test-overrides/${suite}.expect"
    local additional="$REPO_ROOT/tests/sortix/os-test-overrides/${suite}.expect-additional"
    local local_dir="$OS_TEST_LOCAL/${suite}.expect"
    local upstream="$OS_TEST/${suite}.expect"
    SORTIX_EXPECT_DIRS=()
    if sortix_has_expect "$override" "$expect_base"; then
        SORTIX_EXPECT_DIRS=("$override")
    elif sortix_has_expect "$local_dir" "$expect_base"; then
        SORTIX_EXPECT_DIRS=("$local_dir")
    elif [ -d "$upstream" ]; then
        SORTIX_EXPECT_DIRS=("$upstream")
    fi
    if sortix_has_expect "$additional" "$expect_base"; then
        SORTIX_EXPECT_DIRS+=("$additional")
    fi
}

# sortix_has_expect <dir> <expect-base>: whether <dir> holds a candidate.
sortix_has_expect() {
    local expect_file
    [ -d "$1" ] || return 1
    for expect_file in "$1/$2.posix" "$1/$2.posix."* "$1/$2."[0-9]* "$1/$2.unknown."*; do
        [ -f "$expect_file" ] && return 0
    done
    return 1
}

# sortix_compose_output <output-file> <exit-code>
# Prints a run's output as upstream misc/run.sh records it: "exit: N" is
# appended when the program printed nothing at all (the FILE is empty) or
# exited with 2 or more. A program that printed only a newline did print
# something, and its expected output is that empty line.
sortix_compose_output() {
    local file="$1" rc="$2" output=""
    [ -f "$file" ] && output=$(cat "$file")
    if [ ! -s "$file" ] || [ "$rc" -ge 2 ] 2>/dev/null; then
        if [ -s "$file" ]; then
            output="$output
exit: $rc"
        else
            output="exit: $rc"
        fi
    fi
    printf '%s' "$output"
}

# sortix_output_matches <suite> <test-name> <output>
# Returns 0 when <output> equals one of the test's expected candidates, or,
# for a test without expectation files, never (callers decide by exit code).
sortix_output_matches() {
    local suite="$1" expect_base="${2##*/}" output="$3" expect_dir expect_file
    sortix_expect_dirs "$suite" "$2"
    for expect_dir in "${SORTIX_EXPECT_DIRS[@]+"${SORTIX_EXPECT_DIRS[@]}"}"; do
        for expect_file in "$expect_dir/${expect_base}.posix" "$expect_dir/${expect_base}.posix."* "$expect_dir/${expect_base}."[0-9]* "$expect_dir/${expect_base}.unknown."*; do
            [ -f "$expect_file" ] || continue
            [ "$output" = "$(cat "$expect_file")" ] && return 0
        done
    done
    return 1
}
