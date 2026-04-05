#!/bin/bash
set -euo pipefail

# Build and run Open POSIX Test Suite tests in a headless browser.
#
# Uses the same wasm binaries as run-posix-tests.sh, then executes them
# via Playwright + BrowserKernel instead of Node.js.
#
# Usage:
#   scripts/run-browser-posix-tests.sh                     # run all interfaces
#   scripts/run-browser-posix-tests.sh signal raise kill    # run specific interfaces

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
POSIX_TEST="$REPO_ROOT/open-posix-testsuite"
IFACE_DIR="$POSIX_TEST/conformance/interfaces"
BUILD_DIR="$POSIX_TEST/build"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"

# ── Expected failures (same as Node.js version) ──────────────────

EXPECTED_FAIL=(
    # Wasm limitations: sigaltstack
    sigaltstack/1-1
    sigaltstack/2-1
    sigaltstack/3-1
    sigaltstack/6-1
    sigaltstack/7-1
    sigaltstack/8-1
    # munmap: requires real page unmapping
    munmap/1-1
    munmap/1-2
    # Not implemented / stubs
    mlock/12-1
    # Process/permission model
    kill/2-2
    kill/3-1
    sigqueue/3-1
    sigqueue/12-1
)

# ── Browser-specific expected failures ──────────────────────────
BROWSER_EXPECTED_FAIL=(
    # (none discovered yet — POSIX tests pass identically in browser)
)

# ── Auto-detect LLVM ──────────────────────────────────────

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

# ── Compile flags ─────────────────────────────────────────

CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=true
    -D_GNU_SOURCE
    -D_POSIX_C_SOURCE=200112L
    -I"$POSIX_TEST/include"
    -Wno-format
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

# ── Helpers ──────────────────────────────────────────────────────

is_expected_fail() {
    local test_id="$1"
    local xf
    for xf in "${EXPECTED_FAIL[@]}"; do
        [ "$xf" = "$test_id" ] && return 0
    done
    if [ ${#BROWSER_EXPECTED_FAIL[@]} -gt 0 ]; then
        for xf in "${BROWSER_EXPECTED_FAIL[@]}"; do
            [ "$xf" = "$test_id" ] && return 0
        done
    fi
    return 1
}

# ── Test discovery ────────────────────────────────────────

discover_tests() {
    local iface="$1"
    local dir="$IFACE_DIR/$iface"
    [ -d "$dir" ] || return 1
    find "$dir" -maxdepth 1 -name "*.c" -type f 2>/dev/null | while read -r f; do
        basename "$f" .c
    done | sort
}

discover_interfaces() {
    ls "$IFACE_DIR" | while read -r d; do
        [ -d "$IFACE_DIR/$d" ] || continue
        local count
        count=$(find "$IFACE_DIR/$d" -maxdepth 1 -name "*.c" -type f 2>/dev/null | wc -l | tr -d ' ')
        [ "$count" -gt 0 ] && echo "$d"
    done | sort
}

# ── Main ───────────────────────────────────────────────────────────

INTERFACES=()
while [ $# -gt 0 ]; do
    INTERFACES+=("$1"); shift
done

if [ ${#INTERFACES[@]} -eq 0 ]; then
    while IFS= read -r iface; do
        INTERFACES+=("$iface")
    done < <(discover_interfaces)
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
SKIP=0
BUILD_FAIL=0
TIMEOUT_COUNT=0
XFAIL=0
XPASS=0
UNRESOLVED=0
ERROR_COUNT=0
RESULTS=()
TOTAL=0

# Build all tests first, then run them all in the browser in one session
WASM_FILES=()
TEST_META=()  # parallel array: "iface/test_name"

for iface in "${INTERFACES[@]}"; do
    echo ""
    echo "===== Building $iface ====="

    while IFS= read -r test_name; do
        TOTAL=$((TOTAL + 1))
        local_test_id="$iface/$test_name"
        src="$IFACE_DIR/$iface/${test_name}.c"
        wasm="$BUILD_DIR/$iface/${test_name}.wasm"
        mkdir -p "$BUILD_DIR/$iface"

        if ! "$CC" "${CFLAGS[@]}" "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/tmp/posix-test-build-err.txt; then
            if is_expected_fail "$local_test_id"; then
                echo "XFAIL $local_test_id (expected — build failure)"
                RESULTS+=("XFAIL $local_test_id")
                XFAIL=$((XFAIL + 1))
            else
                echo "BUILD $local_test_id"
                RESULTS+=("BUILD $local_test_id")
                BUILD_FAIL=$((BUILD_FAIL + 1))
            fi
            continue
        fi
        asyncify_wasm "$wasm"

        WASM_FILES+=("$wasm")
        TEST_META+=("$local_test_id")
    done < <(discover_tests "$iface")
done

echo ""
echo "===== Running ${#WASM_FILES[@]} tests in browser ====="
echo ""

# Run all built tests through the browser runner
if [ ${#WASM_FILES[@]} -gt 0 ]; then
    RESULT_FILE=$(mktemp)
    trap "rm -f '$RESULT_FILE'" EXIT

    cd "$REPO_ROOT"
    npx tsx scripts/browser-test-runner.ts --json --timeout "$TEST_TIMEOUT" \
        "${WASM_FILES[@]}" > "$RESULT_FILE" 2>/dev/null || true

    idx=0
    while IFS= read -r line; do
        # Skip non-JSON lines
        [[ "$line" != "{"* ]] && continue

        exitCode=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('exitCode',-1))" 2>/dev/null || echo "-1")
        error=$(echo "$line" | python3 -c "import sys,json; e=json.load(sys.stdin).get('error',''); print(e if e else '')" 2>/dev/null || echo "")
        duration=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('durationMs',0))" 2>/dev/null || echo "0")

        [ $idx -ge ${#TEST_META[@]} ] && break

        test_id="${TEST_META[$idx]}"
        idx=$((idx + 1))

        is_xfail=false
        if is_expected_fail "$test_id"; then
            is_xfail=true
        fi

        if [ -n "$error" ]; then
            if [ "$error" = "TIMEOUT" ]; then
                if $is_xfail; then
                    echo "XFAIL $test_id (expected — timeout)"
                    RESULTS+=("XFAIL $test_id")
                    XFAIL=$((XFAIL + 1))
                else
                    echo "TIME  $test_id (timeout)"
                    RESULTS+=("TIME  $test_id")
                    TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
                fi
            else
                if $is_xfail; then
                    echo "XFAIL $test_id (expected — error)"
                    RESULTS+=("XFAIL $test_id")
                    XFAIL=$((XFAIL + 1))
                else
                    echo "ERROR $test_id: $error"
                    RESULTS+=("ERROR $test_id")
                    ERROR_COUNT=$((ERROR_COUNT + 1))
                fi
            fi
        elif [ "$exitCode" = "0" ]; then
            if $is_xfail; then
                echo "XPASS $test_id (expected fail, but passed!)"
                RESULTS+=("XPASS $test_id")
                XPASS=$((XPASS + 1))
            else
                echo "PASS  $test_id (${duration}ms)"
                RESULTS+=("PASS  $test_id")
                PASS=$((PASS + 1))
            fi
        elif [ "$exitCode" = "4" ] || [ "$exitCode" = "5" ]; then
            echo "SKIP  $test_id"
            RESULTS+=("SKIP  $test_id")
            SKIP=$((SKIP + 1))
        elif [ "$exitCode" = "2" ]; then
            if $is_xfail; then
                echo "XFAIL $test_id (expected — unresolved)"
                RESULTS+=("XFAIL $test_id")
                XFAIL=$((XFAIL + 1))
            else
                echo "UNRES $test_id"
                RESULTS+=("UNRES $test_id")
                UNRESOLVED=$((UNRESOLVED + 1))
            fi
        else
            if $is_xfail; then
                echo "XFAIL $test_id (expected — exit $exitCode)"
                RESULTS+=("XFAIL $test_id")
                XFAIL=$((XFAIL + 1))
            else
                echo "FAIL  $test_id (exit $exitCode)"
                RESULTS+=("FAIL  $test_id")
                FAIL=$((FAIL + 1))
            fi
        fi
    done < "$RESULT_FILE"
fi

# ── Summary ────────────────────────────────────────────────────────

echo ""
echo "===== Browser POSIX Test Results ====="
echo "PASS:       $PASS"
echo "FAIL:       $FAIL"
echo "XFAIL:      $XFAIL"
echo "XPASS:      $XPASS"
echo "SKIP:       $SKIP"
echo "BUILD:      $BUILD_FAIL"
echo "UNRESOLVED: $UNRESOLVED"
echo "ERROR:      $ERROR_COUNT"
echo "TIMEOUT:    $TIMEOUT_COUNT"
echo "TOTAL:      $TOTAL"
echo ""

if [ ${#RESULTS[@]} -gt 0 ]; then
    for status in PASS XPASS FAIL XFAIL BUILD UNRES ERROR TIME SKIP; do
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
