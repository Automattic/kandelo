#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT="$REPO_ROOT/target/wasm32-unknown-unknown/release/wasm_posix_userspace.wasm"

cd "$REPO_ROOT"
cargo build --release -p wasm-posix-userspace -Z build-std=core,alloc

if [ ! -f "$OUT" ]; then
    echo "build-userspace: expected output not found: $OUT" >&2
    exit 1
fi

mkdir -p "$REPO_ROOT/local-binaries"
cp "$OUT" "$REPO_ROOT/local-binaries/userspace.wasm"
echo "build-userspace: installed local-binaries/userspace.wasm"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$OUT" "$WASM_POSIX_DEP_OUT_DIR/wasm_posix_userspace.wasm"
    echo "build-userspace: installed $WASM_POSIX_DEP_OUT_DIR/wasm_posix_userspace.wasm"
fi
