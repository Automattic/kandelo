#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT="$REPO_ROOT/target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm"

cd "$REPO_ROOT"
cargo build --release -p wasm-posix-kernel -Z build-std=core,alloc

if [ ! -f "$OUT" ]; then
    echo "build-kernel: expected output not found: $OUT" >&2
    exit 1
fi

mkdir -p "$REPO_ROOT/local-binaries"
cp "$OUT" "$REPO_ROOT/local-binaries/kernel.wasm"
echo "build-kernel: installed local-binaries/kernel.wasm"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$OUT" "$WASM_POSIX_DEP_OUT_DIR/wasm_posix_kernel.wasm"
    echo "build-kernel: installed $WASM_POSIX_DEP_OUT_DIR/wasm_posix_kernel.wasm"
fi
