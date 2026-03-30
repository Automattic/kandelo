#!/bin/bash
set -euo pipefail

# Build dlopen example: shared library (.so) + main program
#
# Usage: bash examples/dlopen/build.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"

# Auto-detect LLVM
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
WASM_LD="$(command -v wasm-ld 2>/dev/null || echo "$LLVM_BIN/wasm-ld")"
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi

echo "=== Building dlopen example ==="

# 1. Build shared library (hello-lib.so)
echo "  Compiling hello-lib.so..."
"$CC" --target=wasm32-unknown-unknown -fPIC -O2 -matomics -mbulk-memory \
    -c "$SCRIPT_DIR/hello-lib.c" -o "$SCRIPT_DIR/hello-lib.o"
"$WASM_LD" --experimental-pic --shared --shared-memory \
    --export-all --allow-undefined \
    -o "$SCRIPT_DIR/hello-lib.so" "$SCRIPT_DIR/hello-lib.o"
rm -f "$SCRIPT_DIR/hello-lib.o"

# 2. Build main program (main.wasm) with dlopen support
echo "  Compiling main.wasm..."
CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib -O2
    -matomics -mbulk-memory
    -fno-trapping-math
)
LINK_FLAGS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$GLUE_DIR/dlopen.c"
    "$SYSROOT/lib/crt1.o"
    "$SYSROOT/lib/libc.a"
    -Wl,--entry=_start
    -Wl,--export=_start
    -Wl,--export=__heap_base
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--global-base=1114112
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

"$CC" "${CFLAGS[@]}" "$SCRIPT_DIR/main.c" "${LINK_FLAGS[@]}" -o "$SCRIPT_DIR/main.wasm"

echo "=== Build complete ==="
echo "  Library: $SCRIPT_DIR/hello-lib.so"
echo "  Program: $SCRIPT_DIR/main.wasm"
echo ""
echo "Run with:"
echo "  npx tsx examples/dlopen/serve.ts"
