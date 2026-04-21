#!/bin/bash
set -euo pipefail

# Build and run Open POSIX Test Suite tests against the wasm-posix-kernel.
#
# Tests are sourced from LTP's open_posix_testsuite (conformance/interfaces).
# Each test is a standalone C program that returns:
#   0 = PTS_PASS, 1 = PTS_FAIL, 2 = PTS_UNRESOLVED, 4 = PTS_UNSUPPORTED, 5 = PTS_UNTESTED
#
# Usage:
#   scripts/run-posix-tests.sh                     # run all interfaces
#   scripts/run-posix-tests.sh signal raise kill    # run specific interfaces
#   scripts/run-posix-tests.sh --report             # run all + write report
#   scripts/run-posix-tests.sh --list               # list available interfaces

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
POSIX_TEST="$REPO_ROOT/open-posix-testsuite"
IFACE_DIR="$POSIX_TEST/conformance/interfaces"
BUILD_DIR="$POSIX_TEST/build"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"

# ── Expected failures ──────────────────────────────────────
# Tests that fail due to Wasm limitations or unimplemented features.

EXPECTED_FAIL=(
    munmap/1-1                  # requires real page unmapping
    munmap/1-2                  # requires real page unmapping
    mlock/12-1                  # needs pwd.h (getpwnam)
    kill/2-2                    # EPERM: no multi-user permission model
    kill/3-1                    # EPERM: no multi-user permission model
    sched_getparam/6-1          # EPERM: no multi-user permission model
    sched_getscheduler/7-1      # EPERM: no multi-user permission model
    sigqueue/3-1                # needs pwd.h (getpwnam)
    sigqueue/12-1               # needs pwd.h (getpwnam)
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
    echo "Error: LLVM/clang not found. Set LLVM_BIN or install LLVM." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"

# ── Compile flags ─────────────────────────────────────────

CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
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

# Asyncify for fork()
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

# Timeout per test (seconds)
TEST_TIMEOUT=30

# ── Helper functions ──────────────────────────────────────

is_expected_fail() {
    local test_id="$1"  # e.g. "signal/1-1"
    for xf in "${EXPECTED_FAIL[@]}"; do
        [ "$xf" = "$test_id" ] && return 0
    done
    return 1
}

# ── Test discovery ────────────────────────────────────────

discover_tests() {
    local iface="$1"
    local dir="$IFACE_DIR/$iface"
    if [ ! -d "$dir" ]; then
        echo "Error: interface '$iface' not found in $IFACE_DIR" >&2
        return 1
    fi
    # Find all .c files (skip speculative/ subdirs and assertion XML)
    find "$dir" -maxdepth 1 -name "*.c" -type f 2>/dev/null | while read -r f; do
        basename "$f" .c
    done | sort
}

discover_interfaces() {
    ls "$IFACE_DIR" | while read -r d; do
        [ -d "$IFACE_DIR/$d" ] || continue
        # Only include dirs with .c files
        local count
        count=$(find "$IFACE_DIR/$d" -maxdepth 1 -name "*.c" -type f 2>/dev/null | wc -l | tr -d ' ')
        [ "$count" -gt 0 ] && echo "$d"
    done | sort
}

# ── Build and run ─────────────────────────────────────────

build_test() {
    local iface="$1"
    local test_name="$2"
    local src="$IFACE_DIR/$iface/${test_name}.c"
    local wasm="$BUILD_DIR/$iface/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/$iface"

    "$CC" "${CFLAGS[@]}" \
        "$src" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/posix-test-build-err.txt
    asyncify_wasm "$wasm"
}

run_test() {
    local iface="$1"
    local test_name="$2"
    local test_id="$iface/$test_name"
    local wasm="$BUILD_DIR/$iface/${test_name}.wasm"

    local is_xfail=false
    if is_expected_fail "$test_id"; then
        is_xfail=true
    fi

    # Build
    if ! build_test "$iface" "$test_name" 2>/dev/null; then
        if $is_xfail; then
            echo "XFAIL $test_id (expected — build failure)"
            RESULTS+=("XFAIL $test_id")
            XFAIL=$((XFAIL + 1))
        else
            local err
            err=$(head -5 /tmp/posix-test-build-err.txt 2>/dev/null || echo "(no error output)")
            echo "BUILD $test_id"
            echo "$err" | head -3 | sed 's/^/  /'
            RESULTS+=("BUILD $test_id")
            BUILD_FAIL=$((BUILD_FAIL + 1))
        fi
        return
    fi

    # Run with timeout.
    # stdin is redirected to /dev/null so node/run-example.ts (which reads
    # process.stdin when not a TTY) does not drain the outer while-loop's
    # process-substitution pipe and cause it to exit after the first test.
    set +e
    output=$(cd "$REPO_ROOT" && timeout "$TEST_TIMEOUT" node --experimental-wasm-exnref --import tsx/esm examples/run-example.ts "${wasm}" </dev/null 2>&1)
    rc=$?
    set -e

    case $rc in
        0)  # PTS_PASS
            if $is_xfail; then
                echo "XPASS $test_id (expected fail, but passed!)"
                RESULTS+=("XPASS $test_id")
                XPASS=$((XPASS + 1))
            else
                echo "PASS  $test_id"
                RESULTS+=("PASS  $test_id")
                PASS=$((PASS + 1))
            fi
            ;;
        4)  # PTS_UNSUPPORTED
            echo "SKIP  $test_id (unsupported)"
            RESULTS+=("SKIP  $test_id")
            SKIP=$((SKIP + 1))
            ;;
        5)  # PTS_UNTESTED
            echo "SKIP  $test_id (untested)"
            RESULTS+=("SKIP  $test_id")
            SKIP=$((SKIP + 1))
            ;;
        2)  # PTS_UNRESOLVED
            if $is_xfail; then
                echo "XFAIL $test_id (expected — unresolved)"
                RESULTS+=("XFAIL $test_id")
                XFAIL=$((XFAIL + 1))
            else
                echo "UNRES $test_id (unresolved)"
                echo "$output" | tail -5 | head -3 | sed 's/^/  /'
                RESULTS+=("UNRES $test_id")
                UNRESOLVED=$((UNRESOLVED + 1))
            fi
            ;;
        124) # timeout
            if $is_xfail; then
                echo "XFAIL $test_id (expected — timeout)"
                RESULTS+=("XFAIL $test_id")
                XFAIL=$((XFAIL + 1))
            else
                echo "TIME  $test_id (timeout ${TEST_TIMEOUT}s)"
                RESULTS+=("TIME  $test_id")
                TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
            fi
            ;;
        1)  # PTS_FAIL
            if $is_xfail; then
                echo "XFAIL $test_id (expected)"
                RESULTS+=("XFAIL $test_id")
                XFAIL=$((XFAIL + 1))
            else
                echo "FAIL  $test_id (exit $rc)"
                echo "$output" | tail -10 | head -5 | sed 's/^/  /'
                RESULTS+=("FAIL  $test_id")
                FAIL=$((FAIL + 1))
            fi
            ;;
        *)  # Other exit codes (crash, signal, etc.)
            if $is_xfail; then
                echo "XFAIL $test_id (expected — exit $rc)"
                RESULTS+=("XFAIL $test_id")
                XFAIL=$((XFAIL + 1))
            else
                echo "FAIL  $test_id (exit $rc)"
                echo "$output" | tail -10 | head -5 | sed 's/^/  /'
                RESULTS+=("FAIL  $test_id")
                FAIL=$((FAIL + 1))
            fi
            ;;
    esac
}

# ── Main ──────────────────────────────────────────────────

REPORT_MODE=false
LIST_MODE=false
INTERFACES=()

while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT_MODE=true; shift ;;
        --list) LIST_MODE=true; shift ;;
        *) INTERFACES+=("$1"); shift ;;
    esac
done

if $LIST_MODE; then
    echo "Available interfaces:"
    discover_interfaces | while read -r iface; do
        count=$(discover_tests "$iface" | wc -l | tr -d ' ')
        echo "  $iface ($count tests)"
    done
    exit 0
fi

# Default: all interfaces
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
RESULTS=()
TOTAL=0

for iface in "${INTERFACES[@]}"; do
    echo ""
    echo "===== $iface ====="
    echo ""

    while IFS= read -r test_name; do
        TOTAL=$((TOTAL + 1))
        run_test "$iface" "$test_name"
    done < <(discover_tests "$iface")
done

# ── Summary ───────────────────────────────────────────────

echo ""
echo "===== Open POSIX Test Suite Results ====="
echo "PASS:       $PASS"
echo "FAIL:       $FAIL"
echo "XFAIL:      $XFAIL"
echo "XPASS:      $XPASS"
echo "SKIP:       $SKIP"
echo "BUILD:      $BUILD_FAIL"
echo "UNRESOLVED: $UNRESOLVED"
echo "TIMEOUT:    $TIMEOUT_COUNT"
echo "TOTAL:      $TOTAL"
echo ""

# Group results by status
for status in PASS XPASS FAIL XFAIL BUILD UNRES TIME SKIP; do
    count=0
    for r in "${RESULTS[@]}"; do
        [[ "$r" == "$status "* ]] && count=$((count + 1))
    done
    if [ $count -gt 0 ]; then
        echo "-- ${status} ($count) --"
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "$status "* ]] && echo "  $r"
        done
        echo ""
    fi
done

# ── Report mode ───────────────────────────────────────────

if $REPORT_MODE; then
    REPORT="$REPO_ROOT/docs/posix-test-report.md"
    {
        echo "# Open POSIX Test Suite Report"
        echo ""
        echo "Generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
        echo ""
        echo "Source: LTP open_posix_testsuite (conformance/interfaces)"
        echo ""
        echo "| Status | Count |"
        echo "|--------|-------|"
        echo "| PASS | $PASS |"
        echo "| FAIL | $FAIL |"
        echo "| XFAIL | $XFAIL |"
        echo "| XPASS | $XPASS |"
        echo "| SKIP | $SKIP |"
        echo "| BUILD | $BUILD_FAIL |"
        echo "| UNRESOLVED | $UNRESOLVED |"
        echo "| TIMEOUT | $TIMEOUT_COUNT |"
        echo "| **TOTAL** | **$TOTAL** |"
        echo ""

        for status in FAIL BUILD UNRES TIME; do
            count=0
            for r in "${RESULTS[@]}"; do
                [[ "$r" == "$status "* ]] && count=$((count + 1))
            done
            if [ $count -gt 0 ]; then
                case "$status" in
                    FAIL) echo "## Unexpected Failures ($count)" ;;
                    BUILD) echo "## Build Failures ($count)" ;;
                    UNRES) echo "## Unresolved ($count)" ;;
                    TIME) echo "## Timeouts ($count)" ;;
                esac
                echo ""
                echo "| Test | Interface |"
                echo "|------|-----------|"
                for r in "${RESULTS[@]}"; do
                    if [[ "$r" == "$status "* ]]; then
                        local_test="${r#* }"
                        local_iface="${local_test%%/*}"
                        local_name="${local_test#*/}"
                        echo "| \`$local_name\` | $local_iface |"
                    fi
                done
                echo ""
            fi
        done

        # XFAIL section
        xfail_count=0
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "XFAIL "* ]] && xfail_count=$((xfail_count + 1))
        done
        if [ $xfail_count -gt 0 ]; then
            echo "## Expected Failures -- XFAIL ($xfail_count)"
            echo ""
            echo "| Test | Interface |"
            echo "|------|-----------|"
            for r in "${RESULTS[@]}"; do
                if [[ "$r" == "XFAIL "* ]]; then
                    local_test="${r#* }"
                    local_iface="${local_test%%/*}"
                    local_name="${local_test#*/}"
                    echo "| \`$local_name\` | $local_iface |"
                fi
            done
            echo ""
        fi

        echo "## Passing Tests ($PASS)"
        echo ""
        echo "<details>"
        echo "<summary>Click to expand</summary>"
        echo ""
        echo "| Test | Interface |"
        echo "|------|-----------|"
        for r in "${RESULTS[@]}"; do
            if [[ "$r" == "PASS "* ]]; then
                local_test="${r#* }"
                local_iface="${local_test%%/*}"
                local_name="${local_test#*/}"
                echo "| \`$local_name\` | $local_iface |"
            fi
        done
        echo ""
        echo "</details>"
    } > "$REPORT"
    echo "Report written to: $REPORT"
fi

# Exit with failure if there are unexpected failures
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ] || [ $BUILD_FAIL -gt 0 ] || [ $UNRESOLVED -gt 0 ] || [ $TIMEOUT_COUNT -gt 0 ]; then
    exit 1
fi
exit 0
