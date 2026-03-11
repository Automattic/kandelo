#!/bin/bash
set -euo pipefail

# Build and run libc-test functional tests against the wasm-posix-kernel.
#
# Usage:
#   scripts/run-libc-tests.sh              # run all supported tests
#   scripts/run-libc-tests.sh string qsort # run specific tests

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
LIBC_TEST="$REPO_ROOT/libc-test"
BUILD_DIR="$REPO_ROOT/libc-test/build"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"

LLVM_BIN="/opt/homebrew/opt/llvm/bin"
CC="$LLVM_BIN/clang"

# Tests that can run without fork/exec/threads/IPC/dynamic-linking
ALL_TESTS=(
    argv
    basename
    clocale_mbfuncs
    clock_gettime
    crypt
    dirname
    env
    fcntl
    fdopen
    fnmatch
    fscanf
    fwscanf
    inet_pton
    mbc
    memstream
    qsort
    random
    search_hsearch
    search_insque
    search_lsearch
    search_tsearch
    setjmp
    snprintf
    sscanf
    sscanf_long
    stat
    string
    string_memcpy
    string_memmem
    string_memset
    string_strchr
    string_strcspn
    string_strstr
    strtod
    strtod_long
    strtod_simple
    strtof
    strtol
    strtold
    swprintf
    tgmath
    time
    udiv
    ungetc
    wcstol
    wcsstr
)

# Select tests
if [ $# -gt 0 ]; then
    TESTS=("$@")
else
    TESTS=("${ALL_TESTS[@]}")
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

mkdir -p "$BUILD_DIR"

PASS=0
FAIL=0
SKIP=0
BUILD_FAIL=0
RESULTS=()

for test_name in "${TESTS[@]}"; do
    src="$LIBC_TEST/src/functional/${test_name}.c"
    wasm="$BUILD_DIR/${test_name}.wasm"

    if [ ! -f "$src" ]; then
        echo "SKIP  $test_name (source not found)"
        SKIP=$((SKIP + 1))
        RESULTS+=("SKIP  $test_name")
        continue
    fi

    # Build
    if ! "$CC" \
        --target=wasm32-unknown-unknown \
        --sysroot="$SYSROOT" \
        -nostdlib \
        -O2 \
        -matomics -mbulk-memory \
        -fno-trapping-math \
        -mllvm -wasm-enable-sjlj \
        -mllvm -wasm-use-legacy-eh=false \
        -D_GNU_SOURCE \
        -I"$LIBC_TEST/src/common" \
        "$src" \
        "$LIBC_TEST/src/common/print.c" \
        "$LIBC_TEST/src/common/rand.c" \
        "$LIBC_TEST/src/common/path.c" \
        "$LIBC_TEST/src/common/setrlim.c" \
        "$LIBC_TEST/src/common/fdfill.c" \
        "$LIBC_TEST/src/common/memfill.c" \
        "$LIBC_TEST/src/common/vmfill.c" \
        "$GLUE_DIR/syscall_glue.c" \
        "$GLUE_DIR/compiler_rt.c" \
        "$SYSROOT/lib/crt1.o" \
        "$SYSROOT/lib/libc.a" \
        -o "$wasm" \
        -Wl,--entry=_start \
        -Wl,--export=_start \
        -Wl,--import-memory \
        -Wl,--shared-memory \
        -Wl,--max-memory=1073741824 \
        -Wl,--allow-undefined \
        2>/tmp/libc-test-build-err.txt; then
        echo "BUILD $test_name (compile failed)"
        cat /tmp/libc-test-build-err.txt | head -5
        BUILD_FAIL=$((BUILD_FAIL + 1))
        RESULTS+=("BUILD $test_name")
        continue
    fi

    # Run — use exit code (t_status) from the program
    set +e
    output=$(cd "$REPO_ROOT" && npx tsx examples/run-example.ts "${wasm}" 2>&1)
    rc=$?
    set -e

    if [ $rc -eq 0 ]; then
        echo "PASS  $test_name"
        PASS=$((PASS + 1))
        RESULTS+=("PASS  $test_name")
    else
        echo "FAIL  $test_name (exit $rc)"
        echo "$output" | head -10 | sed 's/^/  /'
        FAIL=$((FAIL + 1))
        RESULTS+=("FAIL  $test_name")
    fi
done

echo ""
echo "===== Results ====="
echo "PASS:  $PASS"
echo "FAIL:  $FAIL"
echo "BUILD: $BUILD_FAIL"
echo "SKIP:  $SKIP"
echo "TOTAL: ${#TESTS[@]}"
echo ""
for r in "${RESULTS[@]}"; do
    echo "  $r"
done
