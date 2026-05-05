#!/bin/bash
set -euo pipefail

# Build and run Sortix os-test conformance tests against the wasm-posix-kernel.
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
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
OS_TEST="$REPO_ROOT/os-test"
BUILD_DIR="$REPO_ROOT/os-test/build"
KERNEL_WASM="$("$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm)"

# ── Expected failures ──────────────────────────────────────
# Include tests for headers/features our musl sysroot doesn't provide.
# Format: "header/symbol" matching the test path under os-test/include/
INCLUDE_EXPECTED_FAIL=(
    "devctl/posix_devctl" "devctl/size_t"      # device control (Sortix/2024, not in musl)
)

BASIC_EXPECTED_FAIL=(
    "devctl/posix_devctl"                                 # device control (Sortix/2024, not in musl)
    "pthread/pthread_condattr_setpshared"                 # cross-process MAP_SHARED|MAP_ANONYMOUS memory
                                                          # not supported on wasm (pthread primitives ARE
                                                          # supported — see crates/kernel/src/pshared.rs)
    "pthread/pthread_attr_setinheritsched"                # priority scheduling not supported
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

IO_EXPECTED_FAIL=(
)

SIGNAL_EXPECTED_FAIL=()
PROCESS_EXPECTED_FAIL=()
PATHS_EXPECTED_FAIL=()

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

# ── LLVM detection (same as other scripts) ──

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    local brew_prefix
    if brew_prefix=$(brew --prefix llvm 2>/dev/null) && [ -d "$brew_prefix/bin" ]; then
        echo "$brew_prefix/bin"; return
    fi
    for v in 21 20 19 18 17 16 15; do
        if [ -x "/usr/bin/clang-$v" ]; then echo "/usr/bin"; return; fi
    done
    if command -v clang >/dev/null 2>&1; then echo "$(dirname "$(command -v clang)")"; return; fi
    echo "Error: LLVM/clang not found." >&2; exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"

# ── Compile flags ──

CFLAGS_BASE=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=true
    # Tell Sortix tests this platform lacks SIGSTOP/SIGCONT and getifaddrs,
    # so they use race-based timing or skip those features instead.
    -D__sortix__
)

LINK_FLAGS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$GLUE_DIR/dlopen.c"
    "$SYSROOT/lib/crt1.o"
    "$SYSROOT/lib/libc.a"
    -Wl,--entry=_start
    -Wl,--export=_start
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--table-base=3
    -Wl,--export-table
    -Wl,--growable-table
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__tls_base
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__stack_pointer
    -Wl,--export=__wasm_thread_init
)

# Flags for building shared libraries (.so) for dlopen tests
SO_CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -fPIC
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -DSHARED
)
SO_LINK_FLAGS=(
    -nostdlib
    -Wl,--experimental-pic
    -Wl,--shared
    -Wl,--shared-memory
    -Wl,--export-all
    -Wl,--allow-undefined
)

WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
ASYNCIFY_IMPORTS="kernel.kernel_fork"

asyncify_wasm() {
    local wasm="$1"
    if [ -n "$WASM_OPT" ]; then
        "$WASM_OPT" --asyncify \
            --pass-arg="asyncify-imports@${ASYNCIFY_IMPORTS}" \
            "$wasm" -o "$wasm" 2>/dev/null || true
    fi
}

TEST_TIMEOUT=${TEST_TIMEOUT:-30}
XFAIL_TIMEOUT=${XFAIL_TIMEOUT:-10}  # Shorter timeout for known-failing tests
PARALLEL=${PARALLEL:-$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)}
RESULT_DIR=$(mktemp -d)
trap 'rm -rf "$RESULT_DIR"' EXIT

# ── Test discovery ──────────────────────────────────────────

# Discover include tests: os-test/include/<header>/<symbol>.c
discover_include() {
    find "$OS_TEST/include" -name "*.c" -type f | sort | while read -r f; do
        # Path relative to os-test/include, e.g. "unistd/read"
        local rel="${f#$OS_TEST/include/}"
        echo "${rel%.c}"
    done
}

# Discover basic tests: os-test/basic/<header>/<func>.c
discover_basic() {
    find "$OS_TEST/basic" -name "*.c" -type f ! -name "basic.h" | sort | while read -r f; do
        local rel="${f#$OS_TEST/basic/}"
        local name="${rel%.c}"
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

# Discover limits tests: os-test/limits/<constant>.c
discover_limits() {
    find "$OS_TEST/limits" -name "*.c" -type f ! -name "suite.h" | sort | while read -r f; do
        local rel="${f#$OS_TEST/limits/}"
        echo "${rel%.c}"
    done
}

# Generic discovery for flat suites (malloc, stdio, io, signal, process, paths)
discover_suite() {
    local suite="$1"
    find "$OS_TEST/$suite" -name "*.c" -type f | sort | while read -r f; do
        local rel="${f#$OS_TEST/$suite/}"
        echo "${rel%.c}"
    done
}

discover_malloc()  { discover_suite malloc; }
discover_stdio()   { discover_suite stdio; }
discover_io()      { discover_suite io; }
discover_signal()  { discover_suite signal; }
discover_process() { discover_suite process; }
discover_paths()   { discover_suite paths; }

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
    if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "good" > "$result_file"
        rm -f "$wasm"
        return 0
    fi
    # Try _POSIX_C_SOURCE=200809L (POSIX.1-2008)
    if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "previous_posix" > "$result_file"
        rm -f "$wasm"
        return 0
    fi
    # Try GNU/BSD extensions
    if "$CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "extension" > "$result_file"
        rm -f "$wasm"
        return 0
    fi

    # Classify the failure
    local err_file="$BUILD_DIR/include/${test_name}.err"
    "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
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
    local src="$OS_TEST/$suite/${test_name}.c"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"
    mkdir -p "$(dirname "$wasm")"

    local -a cflags=("${CFLAGS_BASE[@]}" -D_GNU_SOURCE -I"$OS_TEST")

    "$CC" "${cflags[@]}" \
        "$src" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/sortix-build-err-$$.txt
    asyncify_wasm "$wasm"

    # If source has #ifdef SHARED, also build as a shared library (.so)
    if grep -q '#ifdef SHARED' "$src" 2>/dev/null; then
        local so="$BUILD_DIR/$suite/${test_name}.so"
        "$CC" "${SO_CFLAGS[@]}" \
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
    echo "  Compiling in parallel ($(nproc 2>/dev/null || sysctl -n hw.logicalcpu) jobs)..."

    # Export variables needed by build_include_one
    export OS_TEST CC BUILD_DIR SYSROOT GLUE_DIR
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

        if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "good" > "$result_file"; rm -f "$wasm"; return
        fi
        if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "previous_posix" > "$result_file"; rm -f "$wasm"; return
        fi
        if "$CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "extension" > "$result_file"; rm -f "$wasm"; return
        fi

        local err_file="$BUILD_DIR/include/${test_name}.err"
        "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
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
            if $is_xfail; then
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

    local is_xfail=false
    if _check_xfail_serialized "$test_name" 2>/dev/null; then
        is_xfail=true
    fi

    # Check that the wasm file exists (pre-built)
    if [ ! -f "$wasm" ]; then
        if $is_xfail; then
            echo "XFAIL" > "$result_dir/${test_name//\//__}.result"
        else
            { echo "BUILD"; echo "wasm not found: $wasm"; } > "$result_dir/${test_name//\//__}.result"
        fi
        return
    fi

    # Use shorter timeout for XFAIL tests (they often hang)
    local this_timeout="$TEST_TIMEOUT"
    if $is_xfail; then
        this_timeout="$XFAIL_TIMEOUT"
    fi

    # If a matching .so file was built, symlink it where the test expects it
    local so="$BUILD_DIR/$suite/${test_name}.so"
    local so_link=""
    if [ -f "$so" ]; then
        local so_dir="${SORTIX_DATA_DIR:-$REPO_ROOT}"
        so_link="$so_dir/${test_name}.so"
        mkdir -p "$(dirname "$so_link")"
        ln -sf "$so" "$so_link" 2>/dev/null || true
    fi

    # Run with timeout. KERNEL_CWD is the data directory containing symlinks
    # to test binaries at their expected relative paths (e.g., fcntl/open).
    local output rc
    # stdin redirected to /dev/null: run-example.ts reads process.stdin
    # when not a TTY, which would drain any pipe the caller supplies.
    set +e
    output=$(cd "$REPO_ROOT" && KERNEL_CWD="${SORTIX_DATA_DIR:-$REPO_ROOT}" timeout "$this_timeout" node --experimental-wasm-exnref --import tsx/esm examples/run-example.ts "${wasm}" </dev/null 2>&1)
    rc=$?
    set -e

    # Clean up .so symlink
    [ -n "$so_link" ] && rm -f "$so_link" 2>/dev/null || true

    # Sortix convention: if output is empty or exit code >= 2,
    # append "exit: N" to the output (matches os-test/misc/run.sh)
    if [ -z "$output" ] || [ "$rc" -ge 2 ]; then
        if [ -n "$output" ]; then
            output="$output
exit: $rc"
        else
            output="exit: $rc"
        fi
    fi

    # For suites with .expect files, compare output
    local has_expect=false
    local expect_dir="$OS_TEST/${suite}.expect"
    if [ -d "$expect_dir" ]; then
        has_expect=true
    fi

    local test_passed=false
    if [ $rc -eq 124 ]; then
        # Timeout
        if $is_xfail; then
            echo "XFAIL" > "$result_dir/${test_name//\//__}.result"
        else
            { echo "TIME"; echo "$output"; } > "$result_dir/${test_name//\//__}.result"
        fi
        return
    fi

    # Check output against expect files
    if $has_expect; then
        local expect_base="${test_name##*/}"
        for expect_file in "$expect_dir/${expect_base}.posix" "$expect_dir/${expect_base}.posix."* "$expect_dir/${expect_base}."[0-9]* "$expect_dir/${expect_base}.unknown."*; do
            [ -f "$expect_file" ] || continue
            local expected
            expected=$(cat "$expect_file")
            if [ "$output" = "$expected" ]; then
                test_passed=true
                break
            fi
        done
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
            echo "XFAIL" > "$result_dir/${test_name//\//__}.result"
        else
            { echo "FAIL"; echo "$output"; } > "$result_dir/${test_name//\//__}.result"
        fi
    fi
}

# Run a runtime test (compile + execute) — sequential wrapper
run_runtime_test() {
    local suite="$1"
    local test_name="$2"
    local result_dir="$RESULT_DIR/$suite"
    mkdir -p "$result_dir"

    # Build the test first (sequential path)
    build_runtime_test "$suite" "$test_name" 2>/dev/null || true

    # Create data directory nested under suite name so tests that open ".."
    # and access "$suite/<path>" (e.g. fstatat opens ".." + "basic/sys_stat/fstatat")
    # find their files correctly.
    local data_parent
    data_parent=$(mktemp -d)
    local data_dir="$data_parent/$suite"
    mkdir -p "$data_dir"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"
    if [ -f "$wasm" ]; then
        mkdir -p "$data_dir/$(dirname "$test_name")"
        ln -f "$wasm" "$data_dir/$test_name" 2>/dev/null || \
            cp "$wasm" "$data_dir/$test_name"
    fi
    # Link source file for tests like faccessat that check for .c files
    local src="$OS_TEST/$suite/${test_name}.c"
    if [ -f "$src" ]; then
        ln -f "$src" "$data_dir/${test_name}.c" 2>/dev/null || \
            cp "$src" "$data_dir/${test_name}.c" 2>/dev/null || true
    fi
    SORTIX_DATA_DIR="$data_dir" _run_runtime_test_worker "$suite" "$test_name" "$result_dir"
    rm -rf "$data_parent"

    _collect_result "$suite" "$test_name" "$result_dir"
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
            tail -n +2 "$result_file" | tail -5 | head -3 | sed 's/^/  /'
            RESULTS+=("FAIL  ${suite}/${test_name}")
            FAIL=$((FAIL + 1))
            ;;
        XFAIL)
            RESULTS+=("XFAIL ${suite}/${test_name}")
            XFAIL=$((XFAIL + 1))
            ;;
        XPASS)
            echo "XPASS ${suite}/${test_name}"
            RESULTS+=("XPASS ${suite}/${test_name}")
            XPASS=$((XPASS + 1))
            ;;
        BUILD)
            echo "BUILD ${suite}/${test_name}"
            tail -n +2 "$result_file" | head -3 | sed 's/^/  /'
            RESULTS+=("BUILD ${suite}/${test_name}")
            BUILD_FAIL=$((BUILD_FAIL + 1))
            ;;
        TIME)
            echo "TIME  ${suite}/${test_name} (timeout)"
            RESULTS+=("TIME  ${suite}/${test_name}")
            TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
            ;;
        *)
            echo "FAIL  ${suite}/${test_name} (unknown status: $status)"
            RESULTS+=("FAIL  ${suite}/${test_name}")
            FAIL=$((FAIL + 1))
            ;;
    esac
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

    if [ ${#specific_tests[@]} -gt 0 ] || [ "$PARALLEL" -le 1 ]; then
        # Sequential execution for specific tests or when parallelism disabled
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
        export REPO_ROOT BUILD_DIR OS_TEST SYSROOT GLUE_DIR
        export CC WASM_OPT ASYNCIFY_IMPORTS
        export CFLAGS_BASE_STR="${CFLAGS_BASE[*]}"
        export LINK_FLAGS_STR="${LINK_FLAGS[*]}"
        export SO_CFLAGS_STR="${SO_CFLAGS[*]}"
        export SO_LINK_FLAGS_STR="${SO_LINK_FLAGS[*]}"

        _build_runtime_wrapper() {
            local suite="$1"
            local test_name="$2"
            local src="$OS_TEST/$suite/${test_name}.c"
            local wasm="$BUILD_DIR/$suite/${test_name}.wasm"
            mkdir -p "$(dirname "$wasm")"
            # shellcheck disable=SC2086
            "$CC" $CFLAGS_BASE_STR -D_GNU_SOURCE -I"$OS_TEST" \
                "$src" $LINK_FLAGS_STR \
                -o "$wasm" 2>/dev/null || return 1
            if [ -n "$WASM_OPT" ]; then
                "$WASM_OPT" --asyncify \
                    --pass-arg="asyncify-imports@${ASYNCIFY_IMPORTS}" \
                    "$wasm" -o "$wasm" 2>/dev/null || true
            fi
            # Build shared library (.so) if source has #ifdef SHARED
            if grep -q '#ifdef SHARED' "$src" 2>/dev/null; then
                local so="$BUILD_DIR/$suite/${test_name}.so"
                # shellcheck disable=SC2086
                "$CC" $SO_CFLAGS_STR \
                    "$src" $SO_LINK_FLAGS_STR \
                    -o "$so" 2>/dev/null || true
            fi
        }
        export -f _build_runtime_wrapper

        printf '%s\n' "${tests[@]}" | xargs -P "$PARALLEL" -I{} \
            bash -c '_build_runtime_wrapper "$1" "$2" 2>/dev/null || true' _ "$suite" {}

        echo "  Running $count tests ($PARALLEL parallel)..."

        # Create a temp directory with hardlinks to test binaries at their
        # expected relative paths. Many sortix tests open their own binary
        # via paths like "fcntl/open" from CWD — this makes them accessible.
        # Hardlinks (not symlinks) so lstat/fstatat see S_ISREG, not S_ISLNK.
        # Nest under $suite/ so tests that open ".." find "$suite/<path>"
        # (e.g. fstatat opens ".." + "basic/sys_stat/fstatat").
        SORTIX_DATA_PARENT=$(mktemp -d)
        SORTIX_DATA_DIR="$SORTIX_DATA_PARENT/$suite"
        mkdir -p "$SORTIX_DATA_DIR"
        for wasm_file in "$BUILD_DIR/$suite"/**/*.wasm; do
            [ -f "$wasm_file" ] || continue
            local relpath="${wasm_file#"$BUILD_DIR/$suite/"}"
            local name="${relpath%.wasm}"
            mkdir -p "$SORTIX_DATA_DIR/$(dirname "$name")"
            ln -f "$wasm_file" "$SORTIX_DATA_DIR/$name" 2>/dev/null || \
                cp "$wasm_file" "$SORTIX_DATA_DIR/$name"
        done
        # Link source files for tests like faccessat that check for .c files
        for src_file in "$OS_TEST/$suite"/**/*.c; do
            [ -f "$src_file" ] || continue
            local relpath="${src_file#"$OS_TEST/$suite/"}"
            local dest="$SORTIX_DATA_DIR/$relpath"
            [ -f "$dest" ] && continue
            mkdir -p "$(dirname "$dest")" 2>/dev/null || true
            ln -f "$src_file" "$dest" 2>/dev/null || true
        done
        export SORTIX_DATA_DIR

        # Export everything needed by the worker function
        export REPO_ROOT BUILD_DIR OS_TEST SYSROOT GLUE_DIR TEST_TIMEOUT XFAIL_TIMEOUT
        export -f _run_runtime_test_worker _check_xfail_serialized

        # Export serialized XFAIL list for this suite
        _export_xfail_for_suite "$suite"

        # Run tests in parallel using xargs
        printf '%s\n' "${tests[@]}" | xargs -P "$PARALLEL" -I{} \
            bash -c '_run_runtime_test_worker "$1" "$2" "$3"' _ "$suite" {} "$result_dir"

        # Clean up data directory
        rm -rf "$SORTIX_DATA_PARENT"
        unset SORTIX_DATA_DIR SORTIX_DATA_PARENT

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
ALL_SUITES=(include limits basic malloc stdio io signal process paths)

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
        include|limits|basic|malloc|stdio|io|signal|process|paths)
            SUITES+=("$1"); shift
            # Collect specific tests for this suite
            while [ $# -gt 0 ] && [[ "$1" != --* ]] && ! [[ "$1" =~ ^(include|limits|basic|malloc|stdio|io|signal|process|paths)$ ]]; do
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
    echo "Error: os-test not found. Run: git submodule update --init os-test" >&2
    exit 1
fi

PASS=0
FAIL=0
SKIP=0
BUILD_FAIL=0
TIMEOUT_COUNT=0
XFAIL=0
XPASS=0
RESULTS=()
TOTAL=0

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

# Exit with error if any unexpected failures
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ] || [ $BUILD_FAIL -gt 0 ]; then
    exit 1
fi
