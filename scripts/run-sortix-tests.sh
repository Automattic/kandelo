#!/bin/bash
set -euo pipefail

# Build and run Sortix os-test conformance tests against the kandelo.
#
# Suites:
#   include  — Header declaration existence + type correctness (~3741 tests)
#   limits   — POSIX limits.h constant validation (~46 tests)
#   basic    — Function invocation smoke tests (~933 tests)
#   malloc   — Memory allocation edge cases (3 tests)
#   stdio    — printf formatting tests (7 tests)
#   io       — I/O syscall behavior (~55 tests)
#   signal   — Signal behavior (~32 tests)
#   process  — Process management (~24 tests)
#   paths    — Filesystem path existence (~48 tests)
#
# Usage:
#   scripts/run-sortix-tests.sh                       # run default suites (include limits basic malloc stdio)
#   scripts/run-sortix-tests.sh include               # run one suite
#   scripts/run-sortix-tests.sh basic stdio/printf     # run suite or specific test
#   scripts/run-sortix-tests.sh --all                 # run all suites
#   scripts/run-sortix-tests.sh --report              # run all + write report

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# WHY: the SDK driver finds its sysroot and glue dir by walking up from the
# current directory (find_project_root in crates/kandelo-cc/src/toolchain.rs), not from
# this script's location. Run from inside another Kandelo checkout, it would
# compile against THAT checkout's sysroot while the prerequisite check below
# validated this one. Pin the cwd so both agree.
cd "$REPO_ROOT"
SYSROOT="$REPO_ROOT/sysroot"
# Upstream has case-distinct test filenames. A caller on a case-insensitive
# filesystem can supply a pristine checkout on a case-sensitive volume.
OS_TEST="${KANDELO_SORTIX_SOURCE_ROOT:-$REPO_ROOT/tests/sortix/os-test}"
OS_TEST_LOCAL="$REPO_ROOT/tests/sortix/os-test-local"
BUILD_DIR="$OS_TEST/build"
KERNEL_WASM="$("$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm)"

# Expected failures, their recorded reasons, and how expected output is
# found and compared are shared with the browser runner.
# shellcheck source=scripts/sortix-expectations.sh
source "$REPO_ROOT/scripts/sortix-expectations.sh"

# Upstream tests that do not test a POSIX requirement on Kandelo are
# reported as SKIP; see scripts/sortix-not-applicable.sh.
source "$REPO_ROOT/scripts/sortix-not-applicable.sh"

# shellcheck source=scripts/xfail-reasons.sh
source "$REPO_ROOT/scripts/xfail-reasons.sh"

# A mismatched XFAIL counts as a FAIL: the test is failing for a reason
# nobody has accepted, and the run must not read as clean.
record_xfail_mismatch() {
    local id="$1" output="$2"
    echo "XFAIL-MISMATCH ${id} (${XFAIL_MISMATCH})"
    printf '%s\n' "$output" | tail -10 | head -5 | sed 's/^/  /'
    RESULTS+=("FAIL  ${id}")
    FAIL=$((FAIL + 1))
}

# ── Helper: check if a test matches an expected-failure pattern ──

is_expected_fail() {
    local test_name="$1"
    shift
    local list=("$@")
    for pattern in "${list[@]}"; do
        # Exact match
        [ "$pattern" = "$test_name" ] && return 0
        # Wildcard match
        if [[ "$pattern" == *"*"* ]]; then
            # shellcheck disable=SC2254
            case "$test_name" in
                $pattern) return 0 ;;
            esac
        fi
    done
    return 1
}

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ] && [ -x "$LLVM_BIN/clang" ]; then
        echo "$LLVM_BIN"
        return
    fi
    if [ -n "${LLVM_PREFIX:-}" ] && [ -x "$LLVM_PREFIX/bin/clang" ]; then
        echo "$LLVM_PREFIX/bin"
        return
    fi
    if command -v clang >/dev/null 2>&1; then
        dirname "$(command -v clang)"
        return
    fi
    echo "Error: LLVM/clang not found. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"

# ── Toolchain: the SDK owns the target/link contract ──
#
# Conformance binaries must be built the way user software is built.
# `crates/kandelo-cc/src/flags.rs` is the single authority for the wasm32posix
# target triple, the guest syscall glue, crt1/libc ordering, the pinned
# wasm-ld, the host-imports allowance file that bounds what may stay
# undefined, and the process memory layout (8 MiB main-thread shadow
# stack, `--global-base`, `__heap_base` export).
#
# This runner used to hand-maintain its own copy of that contract. The
# copy drifted: its binaries exported no `__heap_base` and had no
# `--global-base`, and it omitted the SDK's `cxxrt.c` glue, its pinned
# `-fuse-ld`, and its thread-slot declaration. The suite therefore
# measured a memory layout no real Kandelo program runs under. Driving
# `wasm32posix-cc` keeps one authority. See docs/sdk-guide.md.
#
# Deliberately NOT named CC. That name is already exported in the dev
# shell, and bash keeps the export attribute when you assign to an
# exported name, so `CC=.../wasm32posix-cc` would reach every child this
# script starts -- including the `cargo build -p xtask` that
# abi_contract_stamp_prepare runs, whose cc-rs build scripts would then
# compile host objects with a wasm cross-compiler. The parallel build
# workers below need the compiler across a `bash -c` boundary, so it is
# exported under this safe name instead.
WASM32_CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"

# ── Compile flags ──
#
# Only test-specific flags belong here. The SDK supplies the target,
# sysroot, `-nostdlib`, atomics/bulk-memory/exception-handling, the SjLj
# and wasm-EH lowering choices, and `-fno-trapping-math`.

CFLAGS_BASE=(
    -O2
    # Tell Sortix tests this platform lacks SIGSTOP/SIGCONT and getifaddrs,
    # so they use race-based timing or skip those features instead.
    -D__sortix__
)

# The SDK driver contributes the whole executable link line: syscall
# glue, compiler-rt shims, crt1.o, libc.a, and every `-Wl,` flag. `-ldl`
# is how the SDK spells the `libc/glue/dlopen.c` input this list used to
# name directly (parse_args/link_dl in crates/kandelo-cc/src/driver.rs); the suite's
# dlfcn tests need it.
LINK_FLAGS=(
    -ldl
)

# Flags for building shared libraries (.so) for dlopen tests. `-shared`
# selects the SDK's shared-library link contract (shared_link_flags() in
# crates/kandelo-cc/src/flags.rs): no CRT, no libc, no syscall glue, plus
# --experimental-pic/--shared/--shared-memory/--export-all.
SO_CFLAGS=(
    -fPIC
    -O2
    -DSHARED
)
SO_LINK_FLAGS=(
    -shared
)

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

# Stamp each compiled test program with this checkout's ABI-contract digest.
source "$REPO_ROOT/scripts/abi-contract-stamp.sh"

instrument_wasm() {
    local wasm="$1"
    "$FORK_INSTRUMENT" "$wasm" -o "$wasm" && abi_contract_stamp "$wasm"
}

# The per-test budget in seconds. It is forwarded to examples/run-example.ts
# as TIMEOUT (its own guest watchdog, 30 s by default, which exits 124 like
# timeout(1)), so raising TEST_TIMEOUT really lets a slow guest run longer;
# the outer kill gets a few seconds of grace behind it.
TEST_TIMEOUT=${TEST_TIMEOUT:-30}
XFAIL_TIMEOUT=${XFAIL_TIMEOUT:-10}  # Shorter timeout for known-failing tests
PARALLEL=${PARALLEL:-$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)}
RESULT_DIR=$(mktemp -d)
trap 'rm -rf "$RESULT_DIR"' EXIT

run_with_timeout() {
    local seconds="$1"
    shift

    if command -v timeout >/dev/null 2>&1; then
        command timeout "$seconds" "$@"
        return
    fi

    if command -v gtimeout >/dev/null 2>&1; then
        command gtimeout "$seconds" "$@"
        return
    fi

    perl -e '
        use strict;
        use warnings;
        my $seconds = shift @ARGV;
        my $pid = fork();
        die "fork failed: $!" unless defined $pid;
        if ($pid == 0) {
            setpgrp(0, 0);
            exec @ARGV;
            die "exec failed: $!";
        }

        my $timed_out = 0;
        local $SIG{ALRM} = sub {
            $timed_out = 1;
            kill "TERM", -$pid;
        };

        alarm($seconds);
        waitpid($pid, 0);
        my $status = $?;
        alarm(0);

        if ($timed_out) {
            sleep 1;
            kill "KILL", -$pid;
            waitpid($pid, 0);
            exit 124;
        }

        exit($status >> 8) if (($status & 127) == 0);
        exit(128 + ($status & 127));
    ' "$seconds" "$@"
}

# ── Test discovery ──────────────────────────────────────────

# Discover include tests: tests/sortix/os-test/include/<header>/<symbol>.c
discover_include() {
    find "$OS_TEST/include" -name "*.c" -type f | sort | while read -r f; do
        # Path relative to tests/sortix/os-test/include, e.g. "unistd/read"
        local rel="${f#$OS_TEST/include/}"
        echo "${rel%.c}"
    done
}

discover_runtime_suite() {
    local suite="$1"
    for root in "$OS_TEST" "$OS_TEST_LOCAL"; do
        [ -d "$root/$suite" ] || continue
        find "$root/$suite" -name "*.c" -type f | while read -r f; do
            local rel="${f#$root/$suite/}"
            echo "${rel%.c}"
        done
    done | sort -u
}

runtime_test_src() {
    local suite="$1"
    local test_name="$2"
    local local_src="$OS_TEST_LOCAL/$suite/${test_name}.c"
    if [ -f "$local_src" ]; then
        echo "$local_src"
        return
    fi
    echo "$OS_TEST/$suite/${test_name}.c"
}

# Discover basic tests: tests/sortix/os-test/basic/<header>/<func>.c
discover_basic() {
    discover_runtime_suite basic | while read -r name; do
        # On CI, skip flaky tests whose result oscillates between
        # FAIL and XPASS (which the runner flags as a regression
        # marker). Override with ALLOW_FLAKY_SORTIX=1 for local
        # diagnosis.
        if [ "${CI:-}" = "true" ] && [ "${ALLOW_FLAKY_SORTIX:-0}" != "1" ]; then
            [[ "$name" == "aio/aio_cancel" ]] && continue
        fi
        echo "$name"
    done
}

# Discover limits tests: tests/sortix/os-test/limits/<constant>.c
discover_limits() {
    discover_runtime_suite limits
}

# Generic discovery for flat suites (malloc, stdio, io, signal, process, paths)
discover_suite() {
    local suite="$1"
    discover_runtime_suite "$suite"
}

discover_malloc()  { discover_suite malloc; }
discover_stdio()   { discover_suite stdio; }
discover_io()      { discover_suite io; }
discover_signal()  { discover_suite signal; }
discover_process() { discover_suite process; }
discover_paths()   { discover_suite paths; }
discover_udp()     { discover_suite udp; }

# ── Build helpers ───────────────────────────────────────────

# Include tests: compile-only (successful compilation = PASS)
# Uses progressive feature macro fallback like Sortix's try-compile.sh.
# For parallel execution, this writes result to $BUILD_DIR/include/<test>.result
build_include_one() {
    local test_name="$1"   # e.g. "unistd/read"
    local src="$OS_TEST/include/${test_name}.c"
    local wasm="$BUILD_DIR/include/${test_name}.wasm"
    local result_file="$BUILD_DIR/include/${test_name}.result"
    mkdir -p "$(dirname "$wasm")"

    local -a cflags=("${CFLAGS_BASE[@]}" -Wall -Wextra -Werror
        -Wno-error=deprecated -Wno-error=deprecated-declarations
        -I"$OS_TEST")

    # Try _POSIX_C_SOURCE=202405L first (POSIX.1-2024)
    if "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "good" > "$result_file"
        rm -f "$wasm"
        return 0
    fi
    # Try _POSIX_C_SOURCE=200809L (POSIX.1-2008)
    if "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "previous_posix" > "$result_file"
        rm -f "$wasm"
        return 0
    fi
    # Try GNU/BSD extensions
    if "$WASM32_CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "extension" > "$result_file"
        rm -f "$wasm"
        return 0
    fi

    # Classify the failure
    local err_file="$BUILD_DIR/include/${test_name}.err"
    "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>"$err_file" || true

    if grep -q '/\*optional\*/' "$src" 2>/dev/null; then
        echo "missing_optional" > "$result_file"
    elif grep -Eq 'fatal error' "$err_file"; then
        echo "missing_header" > "$result_file"
    elif grep -Eq 'incompatible|pointer-sign' "$err_file"; then
        echo "incompatible" > "$result_file"
    elif grep -Eq 'undeclared|no member named|is not defined' "$err_file"; then
        echo "undeclared" > "$result_file"
    elif grep -Eq 'unknown type name|storage size of|expected declaration specifiers' "$err_file"; then
        echo "unknown_type" > "$result_file"
    elif grep -Eq 'undefined symbol' "$err_file"; then
        echo "undefined" > "$result_file"
    else
        echo "compile_error" > "$result_file"
    fi
    rm -f "$wasm"
    return 0
}
export -f build_include_one

# Basic/limits/malloc/stdio tests: compile and run
build_runtime_test() {
    local suite="$1"
    local test_name="$2"
    local src
    src="$(runtime_test_src "$suite" "$test_name")"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"
    mkdir -p "$(dirname "$wasm")"
    rm -f "$wasm"

    local -a cflags=("${CFLAGS_BASE[@]}" -D_GNU_SOURCE -I"$OS_TEST")
    case "$suite/$test_name" in
        process/waitpid-pgid-empty-on-setpgid|\
        process/waitpid-pgid-empty-on-setpgid-rejoin|\
        process/waitpid-pgid-empty-on-setsid)
            cflags+=(-include "$REPO_ROOT/tests/sortix/os-test-overrides/min-waitpid-alarm.h")
            ;;
    esac

    "$WASM32_CC" "${cflags[@]}" \
        "$src" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/sortix-build-err-$$.txt
    instrument_wasm "$wasm"

    # If source has #ifdef SHARED, also build as a shared library (.so)
    if grep -q '#ifdef SHARED' "$src" 2>/dev/null; then
        local so="$BUILD_DIR/$suite/${test_name}.so"
        "$WASM32_CC" "${SO_CFLAGS[@]}" \
            "$src" "${SO_LINK_FLAGS[@]}" \
            -o "$so" 2>/dev/null || true
    fi
}

build_basic()   { build_runtime_test basic "$1"; }
build_limits()  { build_runtime_test limits "$1"; }
build_malloc()  { build_runtime_test malloc "$1"; }
build_stdio()   { build_runtime_test stdio "$1"; }
build_io()      { build_runtime_test io "$1"; }
build_signal()  { build_runtime_test signal "$1"; }
build_process() { build_runtime_test process "$1"; }
build_paths()   { build_runtime_test paths "$1"; }
build_udp()     { build_runtime_test udp "$1"; }

# ── Run tests ──────────────────────────────────────────────

# Get the XFAIL list for a suite
get_xfail_list() {
    local suite="$1"
    case "$suite" in
        include)  echo "${INCLUDE_EXPECTED_FAIL[@]:-}" ;;
        basic)    echo "${BASIC_EXPECTED_FAIL[@]:-}" ;;
        limits)   echo "${LIMITS_EXPECTED_FAIL[@]:-}" ;;
        malloc)   echo "${MALLOC_EXPECTED_FAIL[@]:-}" ;;
        stdio)    echo "${STDIO_EXPECTED_FAIL[@]:-}" ;;
        io)       echo "${IO_EXPECTED_FAIL[@]:-}" ;;
        signal)   echo "${SIGNAL_EXPECTED_FAIL[@]:-}" ;;
        process)  echo "${PROCESS_EXPECTED_FAIL[@]:-}" ;;
        paths)    echo "${PATHS_EXPECTED_FAIL[@]:-}" ;;
        udp)      echo "${UDP_EXPECTED_FAIL[@]:-}" ;;
        *)        echo "" ;;
    esac
}

check_xfail() {
    local suite="$1"
    local test_name="$2"
    local -a xfail_list
    case "$suite" in
        include)  xfail_list=("${INCLUDE_EXPECTED_FAIL[@]:-}") ;;
        basic)    xfail_list=("${BASIC_EXPECTED_FAIL[@]:-}") ;;
        limits)   xfail_list=("${LIMITS_EXPECTED_FAIL[@]:-}") ;;
        malloc)   xfail_list=("${MALLOC_EXPECTED_FAIL[@]:-}") ;;
        stdio)    xfail_list=("${STDIO_EXPECTED_FAIL[@]:-}") ;;
        io)       xfail_list=("${IO_EXPECTED_FAIL[@]:-}") ;;
        signal)   xfail_list=("${SIGNAL_EXPECTED_FAIL[@]:-}") ;;
        process)  xfail_list=("${PROCESS_EXPECTED_FAIL[@]:-}") ;;
        paths)    xfail_list=("${PATHS_EXPECTED_FAIL[@]:-}") ;;
        udp)      xfail_list=("${UDP_EXPECTED_FAIL[@]:-}") ;;
        *)        return 1 ;;
    esac
    [ ${#xfail_list[@]} -gt 0 ] && is_expected_fail "$test_name" "${xfail_list[@]}"
}

# Export XFAIL list for a suite as a serialized env var for parallel workers.
# Workers use _XFAIL_LIST env var (newline-separated patterns).
_export_xfail_for_suite() {
    local suite="$1"
    local -a xfail_list
    case "$suite" in
        basic)    xfail_list=("${BASIC_EXPECTED_FAIL[@]:-}") ;;
        io)       xfail_list=("${IO_EXPECTED_FAIL[@]:-}") ;;
        signal)   xfail_list=("${SIGNAL_EXPECTED_FAIL[@]:-}") ;;
        process)  xfail_list=("${PROCESS_EXPECTED_FAIL[@]:-}") ;;
        limits)   xfail_list=("${LIMITS_EXPECTED_FAIL[@]:-}") ;;
        malloc)   xfail_list=("${MALLOC_EXPECTED_FAIL[@]:-}") ;;
        stdio)    xfail_list=("${STDIO_EXPECTED_FAIL[@]:-}") ;;
        paths)    xfail_list=("${PATHS_EXPECTED_FAIL[@]:-}") ;;
        udp)      xfail_list=("${UDP_EXPECTED_FAIL[@]:-}") ;;
        *)        xfail_list=() ;;
    esac
    # Serialize as newline-separated string for export
    local serialized=""
    for pattern in "${xfail_list[@]}"; do
        serialized="${serialized}${pattern}"$'\n'
    done
    export _XFAIL_LIST="$serialized"
}

# Check if a test is XFAIL using the serialized _XFAIL_LIST env var.
# Used by parallel workers where bash arrays can't be exported.
_check_xfail_serialized() {
    local test_name="$1"
    [ -z "${_XFAIL_LIST:-}" ] && return 1
    while IFS= read -r pattern; do
        [ -z "$pattern" ] && continue
        # Exact match
        [ "$pattern" = "$test_name" ] && return 0
        # Wildcard match
        if [[ "$pattern" == *"*"* ]]; then
            case "$test_name" in
                $pattern) return 0 ;;
            esac
        fi
    done <<< "$_XFAIL_LIST"
    return 1
}

# Run include suite in parallel: compile all tests, then analyze results
run_include_suite() {
    local -a tests=()
    while IFS= read -r t; do
        [ -n "$t" ] && tests+=("$t")
    done < <(discover_include)

    local count=${#tests[@]}
    echo "  Discovered $count tests"
    if [ "$count" -eq 0 ]; then
        note_empty_suite include
        return
    fi
    echo "  Compiling in parallel ($(nproc 2>/dev/null || sysctl -n hw.logicalcpu) jobs)..."

    # Export variables needed by build_include_one
    export OS_TEST WASM32_CC BUILD_DIR SYSROOT
    export CFLAGS_BASE_STR="${CFLAGS_BASE[*]}"
    export LINK_FLAGS_STR="${LINK_FLAGS[*]}"

    # Create a wrapper that reconstructs arrays from exported strings
    _build_include_wrapper() {
        local test_name="$1"
        local src="$OS_TEST/include/${test_name}.c"
        local wasm="$BUILD_DIR/include/${test_name}.wasm"
        local result_file="$BUILD_DIR/include/${test_name}.result"
        mkdir -p "$(dirname "$wasm")"

        # shellcheck disable=SC2086
        local -a cflags=($CFLAGS_BASE_STR -Wall -Wextra -Werror
            -Wno-error=deprecated -Wno-error=deprecated-declarations
            -I"$OS_TEST")
        # shellcheck disable=SC2086
        local -a link_flags=($LINK_FLAGS_STR)

        if "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "good" > "$result_file"; rm -f "$wasm"; return
        fi
        if "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "previous_posix" > "$result_file"; rm -f "$wasm"; return
        fi
        if "$WASM32_CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "extension" > "$result_file"; rm -f "$wasm"; return
        fi

        local err_file="$BUILD_DIR/include/${test_name}.err"
        "$WASM32_CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>"$err_file" || true

        if grep -q '/\*optional\*/' "$src" 2>/dev/null; then
            echo "missing_optional" > "$result_file"
        elif grep -Eq 'fatal error' "$err_file"; then
            echo "missing_header" > "$result_file"
        elif grep -Eq 'incompatible|pointer-sign' "$err_file"; then
            echo "incompatible" > "$result_file"
        elif grep -Eq 'undeclared|no member named|is not defined' "$err_file"; then
            echo "undeclared" > "$result_file"
        elif grep -Eq 'unknown type name|storage size of|expected declaration specifiers' "$err_file"; then
            echo "unknown_type" > "$result_file"
        elif grep -Eq 'undefined symbol' "$err_file"; then
            echo "undefined" > "$result_file"
        else
            echo "compile_error" > "$result_file"
        fi
        rm -f "$wasm"
    }
    export -f _build_include_wrapper

    # Run compilations in parallel
    local JOBS
    JOBS=$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)
    printf '%s\n' "${tests[@]}" | xargs -P "$JOBS" -I{} bash -c '_build_include_wrapper "$@"' _ {}

    # Analyze results
    for test_name in "${tests[@]}"; do
        TOTAL=$((TOTAL + 1))
        local result_file="$BUILD_DIR/include/${test_name}.result"
        local outcome
        outcome=$(cat "$result_file" 2>/dev/null || echo "compile_error")

        local is_xfail=false
        if check_xfail include "$test_name" 2>/dev/null; then
            is_xfail=true
        fi

        case "$outcome" in
        good|previous_posix|extension)
            if $is_xfail; then
                echo "XPASS include/${test_name} ($outcome)"
                RESULTS+=("XPASS include/${test_name}")
                XPASS=$((XPASS + 1))
            else
                RESULTS+=("PASS  include/${test_name}")
                PASS=$((PASS + 1))
            fi
            ;;
        *)
            if $is_xfail && ! xfail_check "$(xfail_expected_reason "include/${test_name}")" outcome "$outcome"; then
                record_xfail_mismatch "include/${test_name}" "$outcome"
            elif $is_xfail; then
                RESULTS+=("XFAIL include/${test_name}")
                XFAIL=$((XFAIL + 1))
            elif [ "$outcome" = "missing_optional" ]; then
                RESULTS+=("SKIP  include/${test_name}")
                SKIP=$((SKIP + 1))
            else
                echo "FAIL  include/${test_name} ($outcome)"
                RESULTS+=("FAIL  include/${test_name}")
                FAIL=$((FAIL + 1))
            fi
            ;;
        esac
    done
}

# Run a single runtime test and write result to RESULT_DIR.
# Designed to be called from xargs for parallel execution.
# Writes: <result_dir>/<suite>/<test_name>.result with format:
#   Line 1: STATUS (PASS, FAIL, XFAIL, XPASS, BUILD, TIME)
#   Line 2+: output (for FAIL/BUILD diagnostics)
_run_runtime_test_worker() {
    local suite="$1"
    local test_name="$2"
    local result_dir="$3"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"

    local skip_reason
    skip_reason="$(not_applicable_reason "$suite" "$test_name")"
    if [ -n "$skip_reason" ]; then
        { echo "SKIP"; echo "$skip_reason"; } > "$result_dir/${test_name//\//__}.result"
        return
    fi

    local is_xfail=false
    if _check_xfail_serialized "$test_name" 2>/dev/null; then
        is_xfail=true
    fi

    # Check that the wasm file exists (pre-built)
    if [ ! -f "$wasm" ]; then
        if $is_xfail; then
            # XFAIL results record HOW the test failed (line 2) and its output
            # (line 3 on), because the reason check runs in the parent, where
            # the xfail_expected_reason table lives. A bare "XFAIL" would hide
            # a test now failing for a different reason.
            { echo "XFAIL"; echo "build"; echo "wasm not found: $wasm"; } > "$result_dir/${test_name//\//__}.result"
        else
            { echo "BUILD"; echo "wasm not found: $wasm"; } > "$result_dir/${test_name//\//__}.result"
        fi
        return
    fi

    # Only XFAILs recorded as hanging get the shorter timeout. An XFAIL that
    # normally fails fast keeps the full budget: under a loaded parallel run
    # it can exceed XFAIL_TIMEOUT, and that timeout would hide which way it
    # really failed (seen 2026-09-30 with udp/bind-lan-subnet-first).
    local this_timeout="$TEST_TIMEOUT"
    if $is_xfail; then
        case "$(xfail_expected_reason "${suite}/${test_name}")" in
            timeout*) this_timeout="$XFAIL_TIMEOUT" ;;
        esac
    fi

    # Run with timeout against the complete private fixture prepared by
    # _run_runtime_test_with_private_fixture. The worker snapshots that
    # quiescent tree into lifecycle-owned /tmp storage before publishing ready.
    local output rc
    local result_base="${test_name//\//__}"
    local guest_output_file="$result_dir/${result_base}.guest-output"
    local host_diagnostic_file="$result_dir/${result_base}.host-diagnostics"
    rm -f "$guest_output_file" "$host_diagnostic_file"
    # stdin redirected to /dev/null: run-example.ts reads process.stdin
    # when not a TTY, which would drain any pipe the caller supplies.
    set +e
    (cd "$REPO_ROOT" && \
        KERNEL_CWD= \
        KANDELO_RUNNER_NETWORK=offline-egress \
        KANDELO_GUEST_OUTPUT_FILE="$guest_output_file" \
        KANDELO_RUNNER_FIXTURE_ROOT="${SORTIX_FIXTURE_ROOT:?}" \
        KANDELO_RUNNER_FIXTURE_CWD="$suite" \
        KANDELO_RUNNER_GUEST_PROGRAM="$suite/$test_name" \
        KANDELO_RUNNER_VFS=isolated \
        TIMEOUT="$((this_timeout * 1000))" \
        run_with_timeout "$((this_timeout + 5))" node --experimental-wasm-exnref \
            --import tsx/esm examples/run-example.ts "${wasm}" \
            </dev/null >"$host_diagnostic_file" 2>&1)
    rc=$?
    set -e
    output=$(sortix_compose_output "$guest_output_file" "$rc")

    # For suites with .expect files, compare output against the candidates
    # sortix_expect_dirs selects (repository overrides, os-test-local,
    # upstream, then documented additional outcomes).
    sortix_expect_dirs "$suite" "$test_name"

    local test_passed=false
    if [ $rc -eq 124 ]; then
        # Timeout
        if $is_xfail; then
            { echo "XFAIL"; echo "timeout"; echo "$output"; } > "$result_dir/${test_name//\//__}.result"
        else
            { echo "TIME"; echo "$output"; } > "$result_dir/${test_name//\//__}.result"
        fi
        return
    fi

    # Check output against expect files
    if [ ${#SORTIX_EXPECT_DIRS[@]} -gt 0 ]; then
        if sortix_output_matches "$suite" "$test_name" "$output"; then
            test_passed=true
        fi
    elif [ $rc -eq 0 ]; then
        test_passed=true
    fi

    if $test_passed; then
        if $is_xfail; then
            echo "XPASS" > "$result_dir/${test_name//\//__}.result"
        else
            echo "PASS" > "$result_dir/${test_name//\//__}.result"
        fi
    else
        if $is_xfail; then
            { echo "XFAIL"; echo "output"; echo "exit $rc"; echo "$output"; } > "$result_dir/${test_name//\//__}.result"
        else
            { echo "FAIL"; echo "$output"; } > "$result_dir/${test_name//\//__}.result"
        fi
    fi
}

# Stage exactly one test's guest-visible files before Node starts. A subshell
# owns the temporary tree and removes it on every ordinary/error return.
# Regular copies (including .so) keep the source tree free of symlink/hardlink
# aliases; the worker still takes its own private snapshot before granting
# exact-append authority.
_run_runtime_test_with_private_fixture() (
    local suite="$1"
    local test_name="$2"
    local result_dir="$3"
    local result_file="$result_dir/${test_name//\//__}.result"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"

    if [ ! -f "$wasm" ]; then
        _run_runtime_test_worker "$suite" "$test_name" "$result_dir"
        return
    fi

    local fixture_root
    fixture_root=$(mktemp -d)
    trap 'rm -rf "$fixture_root"' EXIT
    local fixture_cwd="$fixture_root/$suite"
    local fixture_program="$fixture_cwd/$test_name"
    mkdir -p "$(dirname "$fixture_program")"
    if ! cp "$wasm" "$fixture_program"; then
        { echo "BUILD"; echo "failed to stage: $wasm"; } > "$result_file"
        return
    fi

    local src="$OS_TEST/$suite/${test_name}.c"
    if [ -f "$OS_TEST_LOCAL/$suite/${test_name}.c" ]; then
        src="$OS_TEST_LOCAL/$suite/${test_name}.c"
    fi
    if [ -f "$src" ]; then
        if ! cp "$src" "${fixture_program}.c"; then
            { echo "BUILD"; echo "failed to stage: $src"; } > "$result_file"
            return
        fi
    fi

    local so="$BUILD_DIR/$suite/${test_name}.so"
    if [ -f "$so" ]; then
        if ! cp "$so" "${fixture_program}.so"; then
            { echo "BUILD"; echo "failed to stage: $so"; } > "$result_file"
            return
        fi
    fi

    SORTIX_FIXTURE_ROOT="$fixture_root" \
        _run_runtime_test_worker "$suite" "$test_name" "$result_dir"
)

# Run a runtime test (compile + execute) — sequential wrapper
run_runtime_test() {
    local suite="$1"
    local test_name="$2"
    local result_dir="$RESULT_DIR/$suite"
    mkdir -p "$result_dir"

    # Build the test first (sequential path)
    build_runtime_test "$suite" "$test_name" 2>/dev/null || true

    _run_runtime_test_with_private_fixture "$suite" "$test_name" "$result_dir"

    _collect_result "$suite" "$test_name" "$result_dir"
}

_print_result_output() {
    local result_file="$1"
    local max_lines="${SORTIX_DIAGNOSTIC_LINES:-40}"
    local output_lines
    output_lines=$(tail -n +2 "$result_file" | wc -l | tr -d ' ')

    if [ "$output_lines" -le "$max_lines" ]; then
        tail -n +2 "$result_file" | sed 's/^/  /'
        return
    fi

    echo "  --- output: first ${max_lines} lines ---"
    tail -n +2 "$result_file" | head -n "$max_lines" | sed 's/^/  /'
    echo "  --- output: last ${max_lines} lines ---"
    tail -n "$max_lines" "$result_file" | sed 's/^/  /'
}

_print_host_diagnostics() {
    local suite="$1"
    local test_name="$2"
    local result_dir="$3"
    local diagnostic_file="$result_dir/${test_name//\//__}.host-diagnostics"
    local max_lines="${SORTIX_HOST_DIAGNOSTIC_LINES:-40}"

    [ -s "$diagnostic_file" ] || return 0
    echo "HOST  ${suite}/${test_name}"
    local diagnostic_lines
    diagnostic_lines=$(wc -l < "$diagnostic_file" | tr -d ' ')
    if [ "$diagnostic_lines" -le "$max_lines" ]; then
        sed 's/^/  /' "$diagnostic_file"
        return
    fi

    local first_lines=$((max_lines / 2))
    local last_lines=$((max_lines - first_lines))
    echo "  --- host diagnostics: first ${first_lines} of ${diagnostic_lines} lines ---"
    head -n "$first_lines" "$diagnostic_file" | sed 's/^/  /'
    echo "  --- host diagnostics: last ${last_lines} of ${diagnostic_lines} lines ---"
    tail -n "$last_lines" "$diagnostic_file" | sed 's/^/  /'
}

# Collect one test result from result file into RESULTS array and counters
_collect_result() {
    local suite="$1"
    local test_name="$2"
    local result_dir="$3"
    local result_file="$result_dir/${test_name//\//__}.result"

    if [ ! -f "$result_file" ]; then
        echo "FAIL  ${suite}/${test_name} (no result file)"
        RESULTS+=("FAIL  ${suite}/${test_name}")
        FAIL=$((FAIL + 1))
        _print_host_diagnostics "$suite" "$test_name" "$result_dir"
        return
    fi

    local status
    status=$(head -1 "$result_file")
    case "$status" in
        PASS)
            echo "PASS  ${suite}/${test_name}"
            RESULTS+=("PASS  ${suite}/${test_name}")
            PASS=$((PASS + 1))
            ;;
        FAIL)
            echo "FAIL  ${suite}/${test_name}"
            _print_result_output "$result_file"
            RESULTS+=("FAIL  ${suite}/${test_name}")
            FAIL=$((FAIL + 1))
            ;;
        XFAIL)
            local xfail_kind xfail_output
            xfail_kind=$(sed -n 2p "$result_file")
            xfail_output=$(sed -n '3,$p' "$result_file")
            if xfail_check "$(xfail_expected_reason "${suite}/${test_name}")" "$xfail_kind" "$xfail_output"; then
                RESULTS+=("XFAIL ${suite}/${test_name}")
                XFAIL=$((XFAIL + 1))
            else
                record_xfail_mismatch "${suite}/${test_name}" "$xfail_output"
            fi
            ;;
        SKIP)
            echo "SKIP  ${suite}/${test_name} ($(sed -n 2p "$result_file"))"
            RESULTS+=("SKIP  ${suite}/${test_name}")
            SKIP=$((SKIP + 1))
            ;;
        XPASS)
            echo "XPASS ${suite}/${test_name}"
            RESULTS+=("XPASS ${suite}/${test_name}")
            XPASS=$((XPASS + 1))
            ;;
        BUILD)
            echo "BUILD ${suite}/${test_name}"
            _print_result_output "$result_file"
            RESULTS+=("BUILD ${suite}/${test_name}")
            BUILD_FAIL=$((BUILD_FAIL + 1))
            ;;
        TIME)
            echo "TIME  ${suite}/${test_name} (timeout)"
            _print_result_output "$result_file"
            RESULTS+=("TIME  ${suite}/${test_name}")
            TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
            ;;
        *)
            echo "FAIL  ${suite}/${test_name} (unknown status: $status)"
            RESULTS+=("FAIL  ${suite}/${test_name}")
            FAIL=$((FAIL + 1))
            ;;
    esac
    _print_host_diagnostics "$suite" "$test_name" "$result_dir"
}

# ── Run a suite ────────────────────────────────────────────

run_suite() {
    local suite="$1"
    shift
    local -a specific_tests=("$@")

    echo ""
    echo "===== ${suite} tests ====="
    echo ""

    if [ "$suite" = "include" ]; then
        # Include suite uses parallel compilation
        run_include_suite
        # Print suite summary
        local suite_pass=0 suite_fail=0 suite_xfail=0 suite_skip=0
        for r in "${RESULTS[@]}"; do
            case "$r" in
                "PASS  include/"*)  suite_pass=$((suite_pass + 1)) ;;
                "FAIL  include/"*)  suite_fail=$((suite_fail + 1)) ;;
                "XFAIL include/"*)  suite_xfail=$((suite_xfail + 1)) ;;
                "SKIP  include/"*)  suite_skip=$((suite_skip + 1)) ;;
                "XPASS include/"*)  suite_pass=$((suite_pass + 1)) ;;
            esac
        done
        echo "  include: $suite_pass pass, $suite_fail fail, $suite_xfail xfail, $suite_skip skip"
        return
    fi

    local tests=()
    if [ ${#specific_tests[@]} -gt 0 ]; then
        tests=("${specific_tests[@]}")
    else
        while IFS= read -r t; do
            [ -n "$t" ] && tests+=("$t")
        done < <("discover_${suite}")
    fi

    local count=${#tests[@]}
    echo "  Discovered $count tests"
    if [ "$count" -eq 0 ]; then
        note_empty_suite "$suite"
        return
    fi

    if [ ${#specific_tests[@]} -gt 0 ] || [ "$PARALLEL" -le 1 ]; then
        # Sequential execution for specific tests or when parallelism disabled
        _export_xfail_for_suite "$suite"
        for test_name in "${tests[@]}"; do
            TOTAL=$((TOTAL + 1))
            run_runtime_test "$suite" "$test_name"
        done
    else
        # Parallel execution: build all tests first, then run in parallel
        local result_dir="$RESULT_DIR/$suite"
        mkdir -p "$result_dir"

        echo "  Building $count tests ($PARALLEL parallel)..."
        # Build in parallel using a wrapper that reconstructs arrays
        export REPO_ROOT BUILD_DIR OS_TEST OS_TEST_LOCAL SYSROOT
        export WASM32_CC FORK_INSTRUMENT
        export CFLAGS_BASE_STR="${CFLAGS_BASE[*]}"
        export LINK_FLAGS_STR="${LINK_FLAGS[*]}"
        export SO_CFLAGS_STR="${SO_CFLAGS[*]}"
        export SO_LINK_FLAGS_STR="${SO_LINK_FLAGS[*]}"

        _build_runtime_wrapper() {
            local suite="$1"
            local test_name="$2"
            local src="$OS_TEST/$suite/${test_name}.c"
            local local_src="$OS_TEST_LOCAL/$suite/${test_name}.c"
            if [ -f "$local_src" ]; then
                src="$local_src"
            fi
            local wasm="$BUILD_DIR/$suite/${test_name}.wasm"
            mkdir -p "$(dirname "$wasm")"
            rm -f "$wasm"
            # shellcheck disable=SC2206
            local -a cflags=($CFLAGS_BASE_STR -D_GNU_SOURCE -I"$OS_TEST")
            case "$suite/$test_name" in
                process/waitpid-pgid-empty-on-setpgid|\
                process/waitpid-pgid-empty-on-setpgid-rejoin|\
                process/waitpid-pgid-empty-on-setsid)
                    cflags+=(-include "$REPO_ROOT/tests/sortix/os-test-overrides/min-waitpid-alarm.h")
                    ;;
            esac
            # shellcheck disable=SC2086
            "$WASM32_CC" "${cflags[@]}" \
                "$src" $LINK_FLAGS_STR \
                -o "$wasm" 2>/dev/null || return 1
            "$FORK_INSTRUMENT" "$wasm" -o "$wasm" || return 1
            abi_contract_stamp "$wasm" || return 1
            # Build shared library (.so) if source has #ifdef SHARED
            if grep -q '#ifdef SHARED' "$src" 2>/dev/null; then
                local so="$BUILD_DIR/$suite/${test_name}.so"
                # shellcheck disable=SC2086
                "$WASM32_CC" $SO_CFLAGS_STR \
                    "$src" $SO_LINK_FLAGS_STR \
                    -o "$so" 2>/dev/null || true
            fi
        }
        export -f _build_runtime_wrapper

        printf '%s\n' "${tests[@]}" | xargs -P "$PARALLEL" -I{} \
            bash -c '_build_runtime_wrapper "$1" "$2" 2>/dev/null || true' _ "$suite" {}

        echo "  Running $count tests ($PARALLEL parallel)..."

        # Export everything needed by the worker function
        export REPO_ROOT BUILD_DIR OS_TEST OS_TEST_LOCAL SYSROOT TEST_TIMEOUT XFAIL_TIMEOUT
        export -f _run_runtime_test_worker _run_runtime_test_with_private_fixture
        export -f _check_xfail_serialized run_with_timeout not_applicable_reason xfail_expected_reason
        export -f sortix_expect_dirs sortix_has_expect sortix_compose_output sortix_output_matches

        # Export serialized XFAIL list for this suite
        _export_xfail_for_suite "$suite"

        # Run tests in parallel using xargs
        printf '%s\n' "${tests[@]}" | xargs -P "$PARALLEL" -I{} \
            bash -c '_run_runtime_test_with_private_fixture "$1" "$2" "$3"' _ "$suite" {} "$result_dir"

        # Collect results
        for test_name in "${tests[@]}"; do
            TOTAL=$((TOTAL + 1))
            _collect_result "$suite" "$test_name" "$result_dir"
        done
    fi
}

# ── Main ────────────────────────────────────────────────────

REPORT_MODE=false
ALL_MODE=false
SUITES=()
SPECIFIC_TESTS=()

DEFAULT_SUITES=(include limits basic malloc stdio)
ALL_SUITES=(include limits basic malloc stdio io signal process paths udp)

while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT_MODE=true; ALL_MODE=true; shift ;;
        --all)    ALL_MODE=true; shift ;;
        --sequential) PARALLEL=1; shift ;;
        --parallel)
            if [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]]; then
                PARALLEL="$2"; shift 2
            else
                PARALLEL=$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4); shift
            fi
            ;;
        --parallel=*) PARALLEL="${1#*=}"; shift ;;
        include|limits|basic|malloc|stdio|io|signal|process|paths|udp)
            SUITES+=("$1"); shift
            # Collect specific tests for this suite
            while [ $# -gt 0 ] && [[ "$1" != --* ]] && ! [[ "$1" =~ ^(include|limits|basic|malloc|stdio|io|signal|process|paths|udp)$ ]]; do
                SPECIFIC_TESTS+=("$1"); shift
            done
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

if [ ${#SUITES[@]} -eq 0 ]; then
    if $ALL_MODE; then
        SUITES=("${ALL_SUITES[@]}")
    else
        SUITES=("${DEFAULT_SUITES[@]}")
    fi
fi

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi
if [ ! -f "$KERNEL_WASM" ]; then
    echo "Error: kernel wasm not found. Run build.sh first." >&2
    exit 1
fi
if [ ! -d "$OS_TEST" ]; then
    echo "Error: os-test not found. Run: git submodule update --init tests/sortix/os-test" >&2
    exit 1
fi
abi_contract_stamp_prepare || exit 1
# shellcheck source=scripts/conformance-program-index.sh
source "$REPO_ROOT/scripts/conformance-program-index.sh"
conformance_program_index_prepare || exit 1

PASS=0
FAIL=0
SKIP=0
BUILD_FAIL=0
TIMEOUT_COUNT=0
XFAIL=0
XPASS=0
RESULTS=()
TOTAL=0
# A suite that discovers no tests (for example, an uninitialized os-test
# submodule) used to report "passed" vacuously and exit 0. It fails now,
# because that vacuous pass was cited as validation on 2026-09-16 and had to
# be re-done once noticed.
EMPTY_SUITES=()
note_empty_suite() {
    echo "  ERROR: suite '$1' discovered 0 tests; this run cannot vouch for it. Is tests/sortix/os-test checked out?"
    EMPTY_SUITES+=("$1")
}

for suite in "${SUITES[@]}"; do
    run_suite "$suite" "${SPECIFIC_TESTS[@]+${SPECIFIC_TESTS[@]}}"
    SPECIFIC_TESTS=()  # Only apply to first suite
done

# ── Summary ─────────────────────────────────────────────────

echo ""
echo "===== Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "BUILD:   $BUILD_FAIL"
echo "SKIP:    $SKIP"
echo "TIMEOUT: $TIMEOUT_COUNT"
echo "TOTAL:   $TOTAL"
echo ""

# Group non-PASS results
for status in FAIL XPASS BUILD TIME; do
    count=0
    for r in "${RESULTS[@]}"; do
        [[ "$r" == "$status "* ]] && count=$((count + 1))
    done
    if [ $count -gt 0 ]; then
        echo "── ${status} ($count) ──"
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "$status "* ]] && echo "  $r"
        done
        echo ""
    fi
done

# ── Report mode ─────────────────────────────────────────────

if $REPORT_MODE; then
    REPORT="$REPO_ROOT/docs/sortix-test-report.md"
    {
        echo "# Sortix os-test Conformance Report"
        echo ""
        echo "Generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
        echo ""
        echo "| Status | Count |"
        echo "|--------|-------|"
        echo "| PASS | $PASS |"
        echo "| FAIL | $FAIL |"
        echo "| XFAIL | $XFAIL |"
        echo "| XPASS | $XPASS |"
        echo "| BUILD | $BUILD_FAIL |"
        echo "| SKIP | $SKIP |"
        echo "| TIMEOUT | $TIMEOUT_COUNT |"
        echo "| **TOTAL** | **$TOTAL** |"
        echo ""

        for status in FAIL BUILD TIME; do
            count=0
            for r in "${RESULTS[@]}"; do
                [[ "$r" == "$status "* ]] && count=$((count + 1))
            done
            if [ $count -gt 0 ]; then
                case "$status" in
                    FAIL) echo "## Unexpected Failures ($count)" ;;
                    BUILD) echo "## Build Failures ($count)" ;;
                    TIME) echo "## Timeouts ($count)" ;;
                esac
                echo ""
                echo "| Test | Suite |"
                echo "|------|-------|"
                for r in "${RESULTS[@]}"; do
                    if [[ "$r" == "$status "* ]]; then
                        local_test="${r#* }"
                        local_suite="${local_test%%/*}"
                        local_name="${local_test#*/}"
                        echo "| \`$local_name\` | $local_suite |"
                    fi
                done
                echo ""
            fi
        done
    } > "$REPORT"
    echo "Report written to: $REPORT"
fi

# Exit with error if any unexpected failures, or if a suite ran nothing
if [ ${#EMPTY_SUITES[@]} -gt 0 ]; then
    echo "Error: suites with no tests: ${EMPTY_SUITES[*]}" >&2
    exit 1
fi
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ] || [ $BUILD_FAIL -gt 0 ]; then
    exit 1
fi
