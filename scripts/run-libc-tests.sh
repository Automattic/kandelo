#!/bin/bash
set -euo pipefail

# Build and run libc-test tests against the wasm-posix-kernel.
#
# Categories: functional, regression, math
#
# Usage:
#   scripts/run-libc-tests.sh                    # run all categories
#   scripts/run-libc-tests.sh functional          # run one category
#   scripts/run-libc-tests.sh functional string   # run specific test(s)
#   scripts/run-libc-tests.sh --report            # run all + write failures to docs/libc-test-failures.md

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
LIBC_TEST="$REPO_ROOT/libc-test"
BUILD_DIR="$REPO_ROOT/libc-test/build"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"

# Auto-detect LLVM (same logic as SDK)
find_llvm_bin() {
    # Env var override
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    # Homebrew (macOS)
    local brew_prefix
    if brew_prefix=$(brew --prefix llvm 2>/dev/null) && [ -d "$brew_prefix/bin" ]; then
        echo "$brew_prefix/bin"; return
    fi
    # Linux system
    for v in 21 20 19 18 17 16 15; do
        if [ -x "/usr/bin/clang-$v" ]; then echo "/usr/bin"; return; fi
    done
    # PATH fallback
    if command -v clang >/dev/null 2>&1; then echo "$(dirname "$(command -v clang)")"; return; fi
    echo "Error: LLVM/clang not found. Set LLVM_BIN or install LLVM." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"

# Common compile flags
CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=false
    -D_GNU_SOURCE
    -I"$LIBC_TEST/src/common"
)

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
    "$GLUE_DIR/syscall_glue.c"
    "$GLUE_DIR/compiler_rt.c"
    "$SYSROOT/lib/crt1.o"
    "$SYSROOT/lib/libc.a"
    -Wl,--entry=_start
    -Wl,--export=_start
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--table-base=2
    -Wl,--export-table
)

# Timeout per test (seconds)
TEST_TIMEOUT=30

# ── Test discovery ──────────────────────────────────────────

discover_functional() {
    ls "$LIBC_TEST/src/functional/"*.c 2>/dev/null | while read -r f; do
        local name
        name=$(basename "$f" .c)
        # Skip tests that need a companion .mk (DSOs, dlopen)
        [ -f "$LIBC_TEST/src/functional/${name}.mk" ] && continue
        # Skip _dso helper files (they're not standalone tests)
        [[ "$name" == *_dso ]] && continue
        echo "$name"
    done
}

discover_regression() {
    ls "$LIBC_TEST/src/regression/"*.c 2>/dev/null | while read -r f; do
        local name
        name=$(basename "$f" .c)
        # Skip _dso helper files (they're not standalone tests)
        [[ "$name" == *_dso ]] && continue
        echo "$name"
    done
}

discover_math() {
    ls "$LIBC_TEST/src/math/"*.c 2>/dev/null | while read -r f; do
        basename "$f" .c
    done
}

# ── Build helpers ───────────────────────────────────────────

build_functional() {
    local test_name="$1"
    local src="$LIBC_TEST/src/functional/${test_name}.c"
    local wasm="$BUILD_DIR/functional/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/functional"

    "$CC" "${CFLAGS[@]}" \
        "$src" "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
}

build_regression() {
    local test_name="$1"
    local src="$LIBC_TEST/src/regression/${test_name}.c"
    local wasm="$BUILD_DIR/regression/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/regression"

    "$CC" "${CFLAGS[@]}" \
        "$src" "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
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
}

# ── Run a single test ───────────────────────────────────────

run_test() {
    local category="$1"
    local test_name="$2"
    local wasm="$BUILD_DIR/$category/${test_name}.wasm"

    # Build
    if ! "build_${category}" "$test_name" 2>/dev/null; then
        local err
        err=$(head -5 /tmp/libc-test-build-err.txt 2>/dev/null || echo "(no error output)")
        echo "BUILD ${category}/${test_name}"
        echo "$err" | head -3 | sed 's/^/  /'
        RESULTS+=("BUILD ${category}/${test_name}")
        BUILD_FAIL=$((BUILD_FAIL + 1))
        return
    fi

    # Run with timeout
    set +e
    output=$(cd "$REPO_ROOT" && timeout "$TEST_TIMEOUT" npx tsx examples/run-example.ts "${wasm}" 2>&1)
    rc=$?
    set -e

    if [ $rc -eq 0 ]; then
        echo "PASS  ${category}/${test_name}"
        RESULTS+=("PASS  ${category}/${test_name}")
        PASS=$((PASS + 1))
    elif [ $rc -eq 124 ]; then
        echo "TIME  ${category}/${test_name} (timeout ${TEST_TIMEOUT}s)"
        RESULTS+=("TIME  ${category}/${test_name}")
        TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
    else
        echo "FAIL  ${category}/${test_name} (exit $rc)"
        echo "$output" | tail -10 | head -5 | sed 's/^/  /'
        RESULTS+=("FAIL  ${category}/${test_name}")
        FAIL=$((FAIL + 1))
    fi
}

# ── Main ────────────────────────────────────────────────────

REPORT_MODE=false
CATEGORIES=()
SPECIFIC_TESTS=()

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT_MODE=true; shift ;;
        functional|regression|math)
            CATEGORIES+=("$1"); shift
            # Remaining args are specific tests within that category
            while [ $# -gt 0 ] && [[ "$1" != --* ]] && [[ "$1" != functional ]] && [[ "$1" != regression ]] && [[ "$1" != math ]]; do
                SPECIFIC_TESTS+=("$1"); shift
            done
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

# Default: all categories
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
SKIP=0
BUILD_FAIL=0
TIMEOUT_COUNT=0
RESULTS=()
TOTAL=0

for category in "${CATEGORIES[@]}"; do
    echo ""
    echo "===== ${category} tests ====="
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
        run_test "$category" "$test_name"
    done
done

# ── Summary ─────────────────────────────────────────────────

echo ""
echo "===== Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "BUILD:   $BUILD_FAIL"
echo "TIMEOUT: $TIMEOUT_COUNT"
echo "TOTAL:   $TOTAL"
echo ""

# Group results by status
for status in PASS FAIL BUILD TIME; do
    count=0
    for r in "${RESULTS[@]}"; do
        [[ "$r" == "$status"* ]] && count=$((count + 1))
    done
    if [ $count -gt 0 ]; then
        echo "── ${status} ($count) ──"
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "$status"* ]] && echo "  $r"
        done
        echo ""
    fi
done

# ── Report mode: write failures to markdown ─────────────────

if $REPORT_MODE; then
    REPORT="$REPO_ROOT/docs/libc-test-failures.md"
    {
        echo "# libc-test Failure Report"
        echo ""
        echo "Generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
        echo ""
        echo "| Status | Count |"
        echo "|--------|-------|"
        echo "| PASS | $PASS |"
        echo "| FAIL | $FAIL |"
        echo "| BUILD | $BUILD_FAIL |"
        echo "| TIMEOUT | $TIMEOUT_COUNT |"
        echo "| **TOTAL** | **$TOTAL** |"
        echo ""

        for status in FAIL BUILD TIME; do
            count=0
            for r in "${RESULTS[@]}"; do
                [[ "$r" == "$status"* ]] && count=$((count + 1))
            done
            if [ $count -gt 0 ]; then
                case "$status" in
                    FAIL) echo "## Runtime Failures ($count)" ;;
                    BUILD) echo "## Build Failures ($count)" ;;
                    TIME) echo "## Timeouts ($count)" ;;
                esac
                echo ""
                echo "| Test | Category |"
                echo "|------|----------|"
                for r in "${RESULTS[@]}"; do
                    if [[ "$r" == "$status"* ]]; then
                        local_test="${r#* }"
                        local_cat="${local_test%%/*}"
                        local_name="${local_test#*/}"
                        echo "| \`$local_name\` | $local_cat |"
                    fi
                done
                echo ""
            fi
        done

        echo "## Passing Tests ($PASS)"
        echo ""
        echo "<details>"
        echo "<summary>Click to expand</summary>"
        echo ""
        echo "| Test | Category |"
        echo "|------|----------|"
        for r in "${RESULTS[@]}"; do
            if [[ "$r" == "PASS"* ]]; then
                local_test="${r#* }"
                local_cat="${local_test%%/*}"
                local_name="${local_test#*/}"
                echo "| \`$local_name\` | $local_cat |"
            fi
        done
        echo ""
        echo "</details>"
    } > "$REPORT"
    echo "Report written to: $REPORT"
fi
