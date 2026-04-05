#!/bin/bash
set -euo pipefail

# Build and run Sortix os-test conformance tests in a headless browser.
#
# Include tests are compile-only (same as Node.js version).
# Runtime tests are built to wasm and executed via Playwright + BrowserKernel.
#
# Usage:
#   scripts/run-browser-sortix-tests.sh                       # run default suites
#   scripts/run-browser-sortix-tests.sh include               # run one suite
#   scripts/run-browser-sortix-tests.sh basic stdio            # run specific suites
#   scripts/run-browser-sortix-tests.sh --all                 # run all suites

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
OS_TEST="$REPO_ROOT/os-test"
BUILD_DIR="$REPO_ROOT/os-test/build"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"

# ── Expected failures (same as Node.js version) ──────────────────────
INCLUDE_EXPECTED_FAIL=(
    # (pthread clock-aware waits now pass — pthread.h/semaphore.h overlays + stubs)
    # (REG_MINIMAL now passes — regex.h overlay)
    "devctl/posix_devctl" "devctl/size_t"
    # (libintl _l variants now pass — libintl.h overlay + stubs)
    # (ndbm now passes — ndbm.h overlay + stubs)
    # (SCHED_SPORADIC + sched_param fields now pass — sched.h overlay)
    # (typed memory objects now pass — sys/mman.h overlay + stubs)
)

BASIC_EXPECTED_FAIL=(
    "devctl/posix_devctl"
    # (exec/spawn/popen/system/wordexp now pass — browser exec support with tool binaries)
    "aio/aio_fsync"
    "pthread/pthread_barrierattr_setpshared" "pthread/pthread_cancel"
    "pthread/pthread_cleanup_pop" "pthread/pthread_cleanup_push"
    "pthread/pthread_condattr_setpshared"
    "pthread/pthread_create"
    "signal/pthread_kill"
    "threads/thrd_create"
    "pthread/pthread_attr_setinheritsched"
    "pthread/pthread_mutexattr_setpshared"
    "pthread/pthread_setcancelstate"
    "strings/ffsll"
    # (spawn addchdir/addfchdir now pass — exec path normalization fix)
)

LIMITS_EXPECTED_FAIL=()
MALLOC_EXPECTED_FAIL=()
STDIO_EXPECTED_FAIL=()

IO_EXPECTED_FAIL=(
)

SIGNAL_EXPECTED_FAIL=(
    # (exec-based signal tests now pass — browser exec support)
    # (sigaction-exec-flags now passes — .unknown.* glob pattern added)
)
PROCESS_EXPECTED_FAIL=(
    # (fork-exec tests now pass — browser exec support)
)
PATHS_EXPECTED_FAIL=()

# ── Browser-specific expected failures ──────────────────────────────
# Tests that pass on Node.js but fail in the browser due to platform differences.
# Primarily: tests needing data directory (KERNEL_CWD), /etc/passwd, /etc/hosts.

BROWSER_BASIC_EXPECTED_FAIL=(
    # dlfcn: dynamic linking not supported in browser
    "dlfcn/dlclose" "dlfcn/dlopen" "dlfcn/dlsym"
    # (pthread_atfork now passes — fork() calls __fork_handler in channel_syscall.c)
    # (terminal/PTY tests now pass — grantpt, posix_openpt, ptsname, unlockpt in PR #181)
    # aio_read: timeout (needs pthread_create for aio worker thread)
    "aio/aio_read"
)

BROWSER_INCLUDE_EXPECTED_FAIL=()
BROWSER_LIMITS_EXPECTED_FAIL=()
BROWSER_MALLOC_EXPECTED_FAIL=()
BROWSER_STDIO_EXPECTED_FAIL=()

BROWSER_IO_EXPECTED_FAIL=(
)

BROWSER_SIGNAL_EXPECTED_FAIL=(
    # Intermittent timing failure in browser polling mode
    "ppoll-block-sleep-write-raise"
)

BROWSER_PROCESS_EXPECTED_FAIL=(
    # All previously-failing process tests now pass with stderr+stdout merging
)

# paths: most non-existent paths now match .2 expect files (ENOENT on stderr)
# Remaining failures: device nodes and /bin/sh not present in browser VFS
BROWSER_PATHS_EXPECTED_FAIL=(
    # (bin-sh now passes — exec stubs populate /bin/sh)
)

# ── Helpers ──────────────────────────────────────────────────────

is_expected_fail() {
    local test_name="$1"
    shift
    local list=("$@")
    for pattern in "${list[@]}"; do
        [ "$pattern" = "$test_name" ] && return 0
        if [[ "$pattern" == *"*"* ]]; then
            case "$test_name" in
                $pattern) return 0 ;;
            esac
        fi
    done
    return 1
}

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

CFLAGS_BASE=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=true
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

TEST_TIMEOUT=30000  # ms (for browser runner)

# ── Test discovery ─────────────────────────────────────────────

discover_include() {
    find "$OS_TEST/include" -name "*.c" -type f | sort | while read -r f; do
        local rel="${f#$OS_TEST/include/}"
        echo "${rel%.c}"
    done
}

discover_basic() {
    find "$OS_TEST/basic" -name "*.c" -type f ! -name "basic.h" | sort | while read -r f; do
        local rel="${f#$OS_TEST/basic/}"
        echo "${rel%.c}"
    done
}

discover_limits() {
    find "$OS_TEST/limits" -name "*.c" -type f ! -name "suite.h" | sort | while read -r f; do
        local rel="${f#$OS_TEST/limits/}"
        echo "${rel%.c}"
    done
}

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

# ── Build helpers ──────────────────────────────────────────────

build_include_one() {
    local test_name="$1"
    local src="$OS_TEST/include/${test_name}.c"
    local wasm="$BUILD_DIR/include/${test_name}.wasm"
    local result_file="$BUILD_DIR/include/${test_name}.result"
    mkdir -p "$(dirname "$wasm")"

    local -a cflags=("${CFLAGS_BASE[@]}" -Wall -Wextra -Werror
        -Wno-error=deprecated -Wno-error=deprecated-declarations
        -I"$OS_TEST")

    if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "good" > "$result_file"; rm -f "$wasm"; return
    fi
    if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "previous_posix" > "$result_file"; rm -f "$wasm"; return
    fi
    if "$CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "extension" > "$result_file"; rm -f "$wasm"; return
    fi

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
}

build_runtime_test() {
    local suite="$1"
    local test_name="$2"
    local src="$OS_TEST/$suite/${test_name}.c"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"
    mkdir -p "$(dirname "$wasm")"

    local -a cflags=("${CFLAGS_BASE[@]}" -D_GNU_SOURCE -I"$OS_TEST")

    "$CC" "${cflags[@]}" \
        "$src" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/dev/null || return 1
    asyncify_wasm "$wasm"
}

# ── Include suite (compile-only, no browser needed) ──────────────

run_include_suite() {
    local -a tests=()
    while IFS= read -r t; do
        [ -n "$t" ] && tests+=("$t")
    done < <(discover_include)

    local count=${#tests[@]}
    echo "  Discovered $count tests"

    local JOBS
    JOBS=$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)

    # Export for parallel compilation
    export OS_TEST CC BUILD_DIR SYSROOT GLUE_DIR
    export CFLAGS_BASE_STR="${CFLAGS_BASE[*]}"
    export LINK_FLAGS_STR="${LINK_FLAGS[*]}"

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

    echo "  Compiling in parallel ($JOBS jobs)..."
    printf '%s\n' "${tests[@]}" | xargs -P "$JOBS" -I{} bash -c '_build_include_wrapper "$@"' _ {}

    # Combine both shared and browser-specific XFAIL lists
    local -a xfail_list=("${INCLUDE_EXPECTED_FAIL[@]}")
    if [ ${#BROWSER_INCLUDE_EXPECTED_FAIL[@]} -gt 0 ]; then
        xfail_list+=("${BROWSER_INCLUDE_EXPECTED_FAIL[@]}")
    fi

    # Analyze results
    for test_name in "${tests[@]}"; do
        TOTAL=$((TOTAL + 1))
        local result_file="$BUILD_DIR/include/${test_name}.result"
        local outcome
        outcome=$(cat "$result_file" 2>/dev/null || echo "compile_error")

        local is_xfail=false
        if [ ${#xfail_list[@]} -gt 0 ] && is_expected_fail "$test_name" "${xfail_list[@]}"; then
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
}

# ── Runtime suite (build + run in browser) ────────────────────────

run_runtime_suite() {
    local suite="$1"

    local -a tests=()
    while IFS= read -r t; do
        [ -n "$t" ] && tests+=("$t")
    done < <("discover_${suite}")

    local count=${#tests[@]}
    echo "  Discovered $count tests"

    # Build all tests
    echo "  Building $count tests..."
    local -a wasm_files=()
    local -a test_names=()
    local build_fail_count=0

    for test_name in "${tests[@]}"; do
        if build_runtime_test "$suite" "$test_name" 2>/dev/null; then
            wasm_files+=("$BUILD_DIR/$suite/${test_name}.wasm")
            test_names+=("$test_name")
        else
            TOTAL=$((TOTAL + 1))
            # Check if build failure is expected
            local is_xfail=false
            _get_xfail_list "$suite"
            if [ ${#_XFAIL_LIST[@]} -gt 0 ] && is_expected_fail "$test_name" "${_XFAIL_LIST[@]}"; then
                is_xfail=true
            fi
            if $is_xfail; then
                RESULTS+=("XFAIL ${suite}/${test_name}")
                XFAIL=$((XFAIL + 1))
            else
                echo "BUILD ${suite}/${test_name}"
                RESULTS+=("BUILD ${suite}/${test_name}")
                BUILD_FAIL=$((BUILD_FAIL + 1))
            fi
            build_fail_count=$((build_fail_count + 1))
        fi
    done

    if [ ${#wasm_files[@]} -eq 0 ]; then
        echo "  No tests to run"
        return
    fi

    echo "  Running ${#wasm_files[@]} tests in browser..."

    # Run through browser test runner with JSON output
    local RESULT_FILE STDERR_FILE
    RESULT_FILE=$(mktemp)
    STDERR_FILE=$(mktemp)

    cd "$REPO_ROOT"
    npx tsx scripts/browser-test-runner.ts --json --timeout "$TEST_TIMEOUT" \
        --reload-interval 10 \
        --data-prefix "$BUILD_DIR/$suite" \
        --source-dir "$OS_TEST/$suite" \
        --suite "$suite" \
        "${wasm_files[@]}" > "$RESULT_FILE" 2>"$STDERR_FILE" || true
    cat "$STDERR_FILE" >&2
    rm -f "$STDERR_FILE"

    # Parse results
    local idx=0
    while IFS= read -r line; do
        [[ "$line" != "{"* ]] && continue

        local exitCode error duration stdout stderr
        exitCode=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('exitCode',-1))" 2>/dev/null || echo "-1")
        error=$(echo "$line" | python3 -c "import sys,json; e=json.load(sys.stdin).get('error',''); print(e if e else '')" 2>/dev/null || echo "")
        duration=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('durationMs',0))" 2>/dev/null || echo "0")
        stdout=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout',''))" 2>/dev/null || echo "")
        stderr=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stderr',''))" 2>/dev/null || echo "")

        if [ $idx -ge ${#test_names[@]} ]; then
            break
        fi

        local test_name="${test_names[$idx]}"
        idx=$((idx + 1))
        TOTAL=$((TOTAL + 1))

        # Combined XFAIL list (shared + browser-specific)
        _get_xfail_list "$suite"

        local is_xfail=false
        if [ ${#_XFAIL_LIST[@]} -gt 0 ] && is_expected_fail "$test_name" "${_XFAIL_LIST[@]}"; then
            is_xfail=true
        fi

        # Check expect files for output comparison
        local test_passed=false
        local has_expect=false
        local expect_dir="$OS_TEST/${suite}.expect"
        if [ -d "$expect_dir" ]; then
            has_expect=true
        fi

        if [ -n "$error" ]; then
            if [ "$error" = "TIMEOUT" ]; then
                if $is_xfail; then
                    RESULTS+=("XFAIL ${suite}/${test_name}")
                    XFAIL=$((XFAIL + 1))
                else
                    echo "TIME  ${suite}/${test_name} (timeout)"
                    RESULTS+=("TIME  ${suite}/${test_name}")
                    TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
                fi
            else
                if $is_xfail; then
                    RESULTS+=("XFAIL ${suite}/${test_name}")
                    XFAIL=$((XFAIL + 1))
                else
                    echo "ERROR ${suite}/${test_name}: $error"
                    RESULTS+=("ERROR ${suite}/${test_name}")
                    ERROR_COUNT=$((ERROR_COUNT + 1))
                fi
            fi
        else
            # Check output against expect files if available
            if $has_expect; then
                local expect_base="${test_name##*/}"
                for expect_file in "$expect_dir/${expect_base}.posix" "$expect_dir/${expect_base}.posix."* "$expect_dir/${expect_base}."[0-9]* "$expect_dir/${expect_base}.unknown."*; do
                    [ -f "$expect_file" ] || continue
                    local expected
                    expected=$(cat "$expect_file")
                    # Build output like Node.js runner (2>&1): combine stdout+stderr
                    local full_output="$stdout"
                    if [ -n "$stderr" ]; then
                        if [ -n "$full_output" ]; then
                            full_output="${full_output}
${stderr}"
                        else
                            full_output="$stderr"
                        fi
                    fi
                    if [ -z "$full_output" ] || [ "$exitCode" -ge 2 ] 2>/dev/null; then
                        if [ -n "$full_output" ]; then
                            full_output="${full_output}
exit: ${exitCode}"
                        else
                            full_output="exit: ${exitCode}"
                        fi
                    fi
                    if [ "$full_output" = "$expected" ]; then
                        test_passed=true
                        break
                    fi
                done
            elif [ "$exitCode" = "0" ]; then
                test_passed=true
            fi

            if $test_passed; then
                if $is_xfail; then
                    echo "XPASS ${suite}/${test_name}"
                    RESULTS+=("XPASS ${suite}/${test_name}")
                    XPASS=$((XPASS + 1))
                else
                    echo "PASS  ${suite}/${test_name} (${duration}ms)"
                    RESULTS+=("PASS  ${suite}/${test_name}")
                    PASS=$((PASS + 1))
                fi
            else
                if $is_xfail; then
                    RESULTS+=("XFAIL ${suite}/${test_name}")
                    XFAIL=$((XFAIL + 1))
                else
                    echo "FAIL  ${suite}/${test_name} (exit $exitCode)"
                    RESULTS+=("FAIL  ${suite}/${test_name}")
                    FAIL=$((FAIL + 1))
                fi
            fi
        fi
    done < "$RESULT_FILE"
    rm -f "$RESULT_FILE"
}

# Get combined XFAIL list (shared + browser-specific) for a suite.
# Sets _XFAIL_LIST global array (bash 3.2 doesn't support nameref).
_get_xfail_list() {
    local suite="$1"
    _XFAIL_LIST=()
    case "$suite" in
        include)  _XFAIL_LIST=(${INCLUDE_EXPECTED_FAIL[@]+"${INCLUDE_EXPECTED_FAIL[@]}"} ${BROWSER_INCLUDE_EXPECTED_FAIL[@]+"${BROWSER_INCLUDE_EXPECTED_FAIL[@]}"}) ;;
        basic)    _XFAIL_LIST=(${BASIC_EXPECTED_FAIL[@]+"${BASIC_EXPECTED_FAIL[@]}"} ${BROWSER_BASIC_EXPECTED_FAIL[@]+"${BROWSER_BASIC_EXPECTED_FAIL[@]}"}) ;;
        limits)   _XFAIL_LIST=(${LIMITS_EXPECTED_FAIL[@]+"${LIMITS_EXPECTED_FAIL[@]}"} ${BROWSER_LIMITS_EXPECTED_FAIL[@]+"${BROWSER_LIMITS_EXPECTED_FAIL[@]}"}) ;;
        malloc)   _XFAIL_LIST=(${MALLOC_EXPECTED_FAIL[@]+"${MALLOC_EXPECTED_FAIL[@]}"} ${BROWSER_MALLOC_EXPECTED_FAIL[@]+"${BROWSER_MALLOC_EXPECTED_FAIL[@]}"}) ;;
        stdio)    _XFAIL_LIST=(${STDIO_EXPECTED_FAIL[@]+"${STDIO_EXPECTED_FAIL[@]}"} ${BROWSER_STDIO_EXPECTED_FAIL[@]+"${BROWSER_STDIO_EXPECTED_FAIL[@]}"}) ;;
        io)       _XFAIL_LIST=(${IO_EXPECTED_FAIL[@]+"${IO_EXPECTED_FAIL[@]}"} ${BROWSER_IO_EXPECTED_FAIL[@]+"${BROWSER_IO_EXPECTED_FAIL[@]}"}) ;;
        signal)   _XFAIL_LIST=(${SIGNAL_EXPECTED_FAIL[@]+"${SIGNAL_EXPECTED_FAIL[@]}"} ${BROWSER_SIGNAL_EXPECTED_FAIL[@]+"${BROWSER_SIGNAL_EXPECTED_FAIL[@]}"}) ;;
        process)  _XFAIL_LIST=(${PROCESS_EXPECTED_FAIL[@]+"${PROCESS_EXPECTED_FAIL[@]}"} ${BROWSER_PROCESS_EXPECTED_FAIL[@]+"${BROWSER_PROCESS_EXPECTED_FAIL[@]}"}) ;;
        paths)    _XFAIL_LIST=(${PATHS_EXPECTED_FAIL[@]+"${PATHS_EXPECTED_FAIL[@]}"} ${BROWSER_PATHS_EXPECTED_FAIL[@]+"${BROWSER_PATHS_EXPECTED_FAIL[@]}"}) ;;
    esac
}

# ── Main ───────────────────────────────────────────────────────────

ALL_MODE=false
SUITES=()
DEFAULT_SUITES=(include limits basic malloc stdio)
ALL_SUITES=(include limits basic malloc stdio io signal process paths)

while [ $# -gt 0 ]; do
    case "$1" in
        --all)    ALL_MODE=true; shift ;;
        include|limits|basic|malloc|stdio|io|signal|process|paths)
            SUITES+=("$1"); shift ;;
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
ERROR_COUNT=0
XFAIL=0
XPASS=0
RESULTS=()
TOTAL=0

for suite in "${SUITES[@]}"; do
    echo ""
    echo "===== ${suite} tests ====="
    echo ""

    if [ "$suite" = "include" ]; then
        run_include_suite
    else
        run_runtime_suite "$suite"
    fi
done

# ── Summary ────────────────────────────────────────────────────────

echo ""
echo "===== Browser Sortix os-test Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "BUILD:   $BUILD_FAIL"
echo "SKIP:    $SKIP"
echo "ERROR:   $ERROR_COUNT"
echo "TIMEOUT: $TIMEOUT_COUNT"
echo "TOTAL:   $TOTAL"
echo ""

# Group non-PASS results
if [ ${#RESULTS[@]} -gt 0 ]; then
    for status in FAIL XPASS BUILD ERROR TIME; do
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
fi

# XPASS is not treated as failure for browser tests — some tests expected to
# fail on Node.js pass in the browser due to different timing/VFS behavior.
if [ $FAIL -gt 0 ] || [ $BUILD_FAIL -gt 0 ]; then
    exit 1
fi
if [ $XPASS -gt 0 ]; then
    echo "Note: $XPASS XPASS tests (expected fail but passed) — consider updating XFAIL lists"
fi
exit 0
