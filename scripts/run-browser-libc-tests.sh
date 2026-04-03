#!/bin/bash
set -euo pipefail

# Build and run libc-test tests in a headless browser.
#
# Builds the same wasm binaries as run-libc-tests.sh, then executes them
# via Playwright + BrowserKernel instead of Node.js.
#
# Usage:
#   scripts/run-browser-libc-tests.sh                    # run all categories
#   scripts/run-browser-libc-tests.sh functional          # run one category
#   scripts/run-browser-libc-tests.sh functional string   # run specific test(s)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
LIBC_TEST="$REPO_ROOT/libc-test"
BUILD_DIR="$REPO_ROOT/libc-test/build"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"

# ── Expected failures (same as Node.js version) ──────────────────

MATH_EXPECTED_FAIL=(acosh asinh erfc j0 jn jnf lgamma lgammaf lgammaf_r sinh tgamma y0 y0f ynf)

FUNCTIONAL_EXPECTED_FAIL=(
    pthread_cancel
    # fcntl: passes in browser (SIGABRT handling differs)
    fcntl_debug
    tls_init
    popen
    spawn
    vfork
    # (ipc_msg/ipc_sem/ipc_shm pass — SYS_ipc removed from sysroot, uses direct syscalls)
)
REGRESSION_EXPECTED_FAIL=(
    malloc-brk-fail
    malloc-oom
    pthread_cond_wait-cancel_ignored
    pthread_create-oom
    raise-race
    setenv-oom
    tls_get_new-dtv
    fflush-exit
    daemon-failure
    execle-env
    sigaltstack
)

# ── Browser-specific expected failures ──────────────────────────
# Tests that pass on Node.js but fail in the browser due to platform differences.
BROWSER_FUNCTIONAL_EXPECTED_FAIL=(
    # (sem_open now passes — shm_open works in browser VFS)
    setjmp_legacy       # timeout — unknown browser-specific hang
    # (pthread_cancel-points now passes — shm_open works in browser VFS)
)
BROWSER_REGRESSION_EXPECTED_FAIL=(
    # (regex-backref-0 now passes — fresh browser context prevents OOM)
    # (regex-bracket-icase now passes — fresh browser context prevents OOM)
    syscall-sign-extend # clock_gettime monotonicity — browser timer resolution
)
BROWSER_MATH_EXPECTED_FAIL=()

USE_LEGACY_EH=(setjmp)

# ── Helpers ──────────────────────────────────────────────────────

is_expected_fail() {
    local test_name="$1"
    shift
    local list=("$@")
    for xf in "${list[@]}"; do
        [ "$xf" = "$test_name" ] && return 0
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
    -mllvm -wasm-use-legacy-eh=false
    -D_GNU_SOURCE
)
CFLAGS=("${CFLAGS_BASE[@]}" -I"$LIBC_TEST/src/common")

COMMON_SRCS=(
    "$LIBC_TEST/src/common/print.c"
    "$LIBC_TEST/src/common/rand.c"
    "$LIBC_TEST/src/common/path.c"
    "$LIBC_TEST/src/common/setrlim.c"
    "$LIBC_TEST/src/common/fdfill.c"
    "$LIBC_TEST/src/common/memfill.c"
    "$LIBC_TEST/src/common/vmfill.c"
)

LINK_FLAGS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
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

# ── Test discovery (same as Node.js version) ──────────────────────

discover_functional() {
    ls "$LIBC_TEST/src/functional/"*.c 2>/dev/null | while read -r f; do
        local name; name=$(basename "$f" .c)
        [ -f "$LIBC_TEST/src/functional/${name}.mk" ] && continue
        [[ "$name" == *_dso ]] && continue
        echo "$name"
    done
}

discover_regression() {
    ls "$LIBC_TEST/src/regression/"*.c 2>/dev/null | while read -r f; do
        local name; name=$(basename "$f" .c)
        [[ "$name" == *_dso ]] && continue
        echo "$name"
    done
}

discover_math() {
    ls "$LIBC_TEST/src/math/"*.c 2>/dev/null | while read -r f; do
        basename "$f" .c
    done
}

# ── Build helpers ──────────────────────────────────────────────────

build_functional() {
    local test_name="$1"
    local src="$LIBC_TEST/src/functional/${test_name}.c"
    local wasm="$BUILD_DIR/functional/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/functional"

    local -a cflags=("${CFLAGS[@]}")
    if is_expected_fail "$test_name" "${USE_LEGACY_EH[@]}"; then
        cflags=("${cflags[@]/-wasm-use-legacy-eh=false/-wasm-use-legacy-eh=true}")
    fi

    "$CC" "${cflags[@]}" \
        "$src" "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
    asyncify_wasm "$wasm"
}

build_regression() {
    local test_name="$1"
    local src="$LIBC_TEST/src/regression/${test_name}.c"
    local wasm="$BUILD_DIR/regression/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/regression"

    "$CC" "${CFLAGS[@]}" \
        "$src" "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
    asyncify_wasm "$wasm"
}

build_math() {
    local test_name="$1"
    local src="$LIBC_TEST/src/math/${test_name}.c"
    local wasm="$BUILD_DIR/math/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/math"

    "$CC" "${CFLAGS[@]}" \
        -I"$LIBC_TEST/src/math" \
        "$src" \
        "$LIBC_TEST/src/common/mtest.c" \
        "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
    asyncify_wasm "$wasm"
}

# ── Main ───────────────────────────────────────────────────────────

CATEGORIES=()
SPECIFIC_TESTS=()

while [ $# -gt 0 ]; do
    case "$1" in
        functional|regression|math)
            CATEGORIES+=("$1"); shift
            while [ $# -gt 0 ] && [[ "$1" != functional ]] && [[ "$1" != regression ]] && [[ "$1" != math ]]; do
                SPECIFIC_TESTS+=("$1"); shift
            done
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

if [ ${#CATEGORIES[@]} -eq 0 ]; then
    CATEGORIES=(functional regression math)
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

PASS=0
FAIL=0
BUILD_FAIL=0
TIMEOUT_COUNT=0
XFAIL=0
XPASS=0
ERROR_COUNT=0
RESULTS=()
TOTAL=0

# Build all tests first, then run them all in the browser in one session
WASM_FILES=()
TEST_META=()  # parallel array: "category/test_name"

for category in "${CATEGORIES[@]}"; do
    echo ""
    echo "===== Building ${category} tests ====="
    echo ""

    if [ ${#SPECIFIC_TESTS[@]} -gt 0 ]; then
        tests=("${SPECIFIC_TESTS[@]}")
    else
        tests=()
        while IFS= read -r t; do
            tests+=("$t")
        done < <("discover_${category}")
    fi

    for test_name in "${tests[@]}"; do
        TOTAL=$((TOTAL + 1))

        # Build
        if ! "build_${category}" "$test_name" 2>/dev/null; then
            echo "BUILD ${category}/${test_name}"
            RESULTS+=("BUILD ${category}/${test_name}")
            BUILD_FAIL=$((BUILD_FAIL + 1))
            continue
        fi

        WASM_FILES+=("$BUILD_DIR/$category/${test_name}.wasm")
        TEST_META+=("${category}/${test_name}")
    done
done

echo ""
echo "===== Running ${#WASM_FILES[@]} tests in browser ====="
echo ""

# Run all built tests through the browser runner
if [ ${#WASM_FILES[@]} -gt 0 ]; then
    # Create a temp file to collect results
    RESULT_FILE=$(mktemp)
    trap "rm -f '$RESULT_FILE'" EXIT

    # Run the browser test runner with JSON output
    # Separate stdout (JSON) from stderr (status messages)
    cd "$REPO_ROOT"
    STDERR_FILE=$(mktemp)
    npx tsx scripts/browser-test-runner.ts --json --timeout "$TEST_TIMEOUT" \
        "${WASM_FILES[@]}" > "$RESULT_FILE" 2>"$STDERR_FILE" || true
    # Show browser runner status on stderr
    cat "$STDERR_FILE" >&2
    rm -f "$STDERR_FILE"

    # Parse JSON results and match with test metadata
    idx=0
    while IFS= read -r line; do
        # Skip non-JSON lines (stderr from browser runner)
        if [[ "$line" != "{"* ]]; then
            continue
        fi

        # Extract fields from JSON
        exitCode=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('exitCode',-1))" 2>/dev/null || echo "-1")
        error=$(echo "$line" | python3 -c "import sys,json; e=json.load(sys.stdin).get('error',''); print(e if e else '')" 2>/dev/null || echo "")
        duration=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('durationMs',0))" 2>/dev/null || echo "0")

        if [ $idx -ge ${#TEST_META[@]} ]; then
            break
        fi

        test_id="${TEST_META[$idx]}"
        category="${test_id%%/*}"
        test_name="${test_id#*/}"
        idx=$((idx + 1))

        # Determine xfail lists
        local_xfail_list=()
        case "$category" in
            functional) local_xfail_list=("${FUNCTIONAL_EXPECTED_FAIL[@]}" ${BROWSER_FUNCTIONAL_EXPECTED_FAIL[@]+"${BROWSER_FUNCTIONAL_EXPECTED_FAIL[@]}"}) ;;
            regression) local_xfail_list=("${REGRESSION_EXPECTED_FAIL[@]}" ${BROWSER_REGRESSION_EXPECTED_FAIL[@]+"${BROWSER_REGRESSION_EXPECTED_FAIL[@]}"}) ;;
            math)       local_xfail_list=("${MATH_EXPECTED_FAIL[@]}" ${BROWSER_MATH_EXPECTED_FAIL[@]+"${BROWSER_MATH_EXPECTED_FAIL[@]}"}) ;;
        esac

        is_xfail=false
        if [ ${#local_xfail_list[@]} -gt 0 ] && is_expected_fail "$test_name" "${local_xfail_list[@]}"; then
            is_xfail=true
        fi

        if [ -n "$error" ]; then
            if [ "$error" = "TIMEOUT" ]; then
                if $is_xfail; then
                    echo "XFAIL ${test_id} (expected — timeout)"
                    RESULTS+=("XFAIL ${test_id}")
                    XFAIL=$((XFAIL + 1))
                else
                    echo "TIME  ${test_id} (timeout)"
                    RESULTS+=("TIME  ${test_id}")
                    TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
                fi
            else
                if $is_xfail; then
                    echo "XFAIL ${test_id} (expected — error)"
                    RESULTS+=("XFAIL ${test_id}")
                    XFAIL=$((XFAIL + 1))
                else
                    echo "ERROR ${test_id}: $error"
                    RESULTS+=("ERROR ${test_id}")
                    ERROR_COUNT=$((ERROR_COUNT + 1))
                fi
            fi
        elif [ "$exitCode" = "0" ]; then
            if $is_xfail; then
                echo "XPASS ${test_id} (expected fail, but passed!)"
                RESULTS+=("XPASS ${test_id}")
                XPASS=$((XPASS + 1))
            else
                echo "PASS  ${test_id} (${duration}ms)"
                RESULTS+=("PASS  ${test_id}")
                PASS=$((PASS + 1))
            fi
        else
            if $is_xfail; then
                echo "XFAIL ${test_id} (expected — exit $exitCode)"
                RESULTS+=("XFAIL ${test_id}")
                XFAIL=$((XFAIL + 1))
            else
                echo "FAIL  ${test_id} (exit $exitCode)"
                RESULTS+=("FAIL  ${test_id}")
                FAIL=$((FAIL + 1))
            fi
        fi
    done < "$RESULT_FILE"
fi

# ── Summary ────────────────────────────────────────────────────────

echo ""
echo "===== Browser libc-test Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "BUILD:   $BUILD_FAIL"
echo "ERROR:   $ERROR_COUNT"
echo "TIMEOUT: $TIMEOUT_COUNT"
echo "TOTAL:   $TOTAL"
echo ""

# Group results by status
if [ ${#RESULTS[@]} -gt 0 ]; then
    for status in PASS XPASS FAIL XFAIL BUILD ERROR TIME; do
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

if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ] || [ $ERROR_COUNT -gt 0 ] || [ $TIMEOUT_COUNT -gt 0 ]; then
    exit 1
fi
exit 0
