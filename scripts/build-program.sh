#!/bin/bash
set -euo pipefail

# Compile a C program against the musl sysroot for wasm32posix.
#
# Usage:
#   scripts/build-program.sh <input.c> [output.wasm]
#
# The output defaults to <input>.wasm in the same directory.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"

# Use Homebrew LLVM 21 toolchain
LLVM_BIN="/opt/homebrew/opt/llvm/bin"
CC="$LLVM_BIN/clang"

# Validate arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <input.c> [output.wasm]" >&2
    exit 1
fi

INPUT="$1"
if [ ! -f "$INPUT" ]; then
    echo "Error: input file '$INPUT' not found" >&2
    exit 1
fi

# Default output: replace .c with .wasm
if [ $# -ge 2 ]; then
    OUTPUT="$2"
else
    OUTPUT="${INPUT%.c}.wasm"
fi

# Verify sysroot exists
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found at $SYSROOT" >&2
    echo "       Run scripts/build-musl.sh first." >&2
    exit 1
fi

echo "==> Compiling: $INPUT -> $OUTPUT"

"$CC" \
    --target=wasm32-unknown-unknown \
    --sysroot="$SYSROOT" \
    -nostdlib \
    -O2 \
    -matomics -mbulk-memory \
    -fno-exceptions -fno-trapping-math \
    "$INPUT" \
    "$GLUE_DIR/syscall_glue.c" \
    "$SYSROOT/lib/crt1.o" \
    "$SYSROOT/lib/libc.a" \
    -o "$OUTPUT" \
    -Wl,--entry=_start \
    -Wl,--export=_start \
    -Wl,--import-memory \
    -Wl,--shared-memory \
    -Wl,--max-memory=1073741824 \
    -Wl,--allow-undefined

echo "==> Built: $OUTPUT ($(wc -c < "$OUTPUT" | tr -d ' ') bytes)"
