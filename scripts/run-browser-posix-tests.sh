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
# WHY: the SDK driver finds its sysroot and glue dir by walking up from the
# current directory (findProjectRoot in sdk/src/lib/toolchain.ts), not from
# this script's location. Run from inside another Kandelo checkout, it would
# compile against THAT checkout's sysroot while the prerequisite check below
# validated this one. Pin the cwd so both agree. (The browser runner below
# also needs this cwd; it used to set it just before the npx call.)
cd "$REPO_ROOT"
SYSROOT="$REPO_ROOT/sysroot"
POSIX_TEST="$REPO_ROOT/tests/posix/open-posix-testsuite"
IFACE_DIR="$POSIX_TEST/conformance/interfaces"
BUILD_DIR="$POSIX_TEST/build"

# ── Expected failures (same as Node.js version) ──────────────────

EXPECTED_FAIL=(
    # Wasm limitations: sigaltstack
    sigaltstack/1-1
    sigaltstack/2-1
    sigaltstack/3-1
    sigaltstack/6-1
    sigaltstack/7-1
    sigaltstack/8-1
    # munmap: wasm can't revoke page access — see docs/wasm-limitations.md §6
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
# Identical to scripts/run-posix-tests.sh, the Node.js runner for this same
# suite. Conformance binaries must be built the way user software is built.
# `sdk/src/lib/flags.ts` is the single authority for the wasm32posix target
# triple, the guest syscall glue, crt1/libc ordering, the pinned wasm-ld, the
# host-imports allowance file that bounds what may stay undefined, and the
# process memory layout (8 MiB main-thread shadow stack, `--global-base`,
# `__heap_base` export). This runner used to hand-maintain a
# copy of that contract which had drifted (no `__heap_base` export, no
# `--global-base`), so the browser suite measured a memory layout no real
# Kandelo program runs under. See docs/sdk-guide.md.
#
# Deliberately NOT named CC. That name is already exported in the dev shell,
# and bash keeps the export attribute when you assign to an exported name, so
# `CC=.../wasm32posix-cc` would reach every child process this script starts,
# including any `cargo build -p xtask`, whose cc-rs build scripts would then
# compile host objects with a wasm cross-compiler.
WASM32_CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"

# ── Compile flags ─────────────────────────────────────────

#
# Only test-specific flags belong here; the SDK supplies the target,
# sysroot, `-nostdlib`, and the codegen/lowering flags. The SDK driver also
# contributes the whole executable link line: syscall glue, compiler-rt
# shims, crt1.o, libc.a, and every `-Wl,` flag.

CFLAGS=(
    -O2
    -D_GNU_SOURCE
    -D_POSIX_C_SOURCE=200112L
    -I"$POSIX_TEST/include"
    -Wno-format
)

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

# Stamp each compiled test program with this checkout's ABI-contract digest.
source "$REPO_ROOT/scripts/abi-contract-stamp.sh"

instrument_wasm() {
    local wasm="$1"
    "$FORK_INSTRUMENT" "$wasm" -o "$wasm.instr"
    mv "$wasm.instr" "$wasm"
    abi_contract_stamp "$wasm"
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

verify_test_tree() {
    if [ ! -d "$IFACE_DIR" ]; then
        echo "Error: Open POSIX Test Suite interfaces not found at $IFACE_DIR" >&2
        exit 1
    fi
}

# ── Main ───────────────────────────────────────────────────────────

INTERFACES=()
while [ $# -gt 0 ]; do
    INTERFACES+=("$1"); shift
done

verify_test_tree

if [ ${#INTERFACES[@]} -eq 0 ]; then
    while IFS= read -r iface; do
        INTERFACES+=("$iface")
    done < <(discover_interfaces)
fi

if [ ${#INTERFACES[@]} -eq 0 ]; then
    echo "Error: no Open POSIX Test Suite interfaces discovered under $IFACE_DIR" >&2
    exit 1
fi

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi
KERNEL_WASM="$("$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm)"
if [ ! -f "$KERNEL_WASM" ]; then
    echo "Error: kernel wasm not found. Run build.sh first." >&2
    exit 1
fi
abi_contract_stamp_prepare || exit 1

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

        if ! "$WASM32_CC" "${CFLAGS[@]}" "$src" -o "$wasm" 2>/tmp/posix-test-build-err.txt; then
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
        instrument_wasm "$wasm"

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
