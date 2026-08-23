#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
export CARGO_TARGET_DIR
OUT="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/wasm_posix_userspace.wasm"

cd "$REPO_ROOT"
cargo build --release -p wasm-posix-userspace -Z build-std=core,alloc

if [ ! -f "$OUT" ]; then
    echo "build-userspace: expected output not found: $OUT" >&2
    exit 1
fi

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    # WHY: a resolver build owns only its sealed output directory. Writing a
    # checkout-wide resolver mirror here would leak an untracked side effect
    # across package transactions.
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$OUT" "$WASM_POSIX_DEP_OUT_DIR/wasm_posix_userspace.wasm"
    echo "build-userspace: installed $WASM_POSIX_DEP_OUT_DIR/wasm_posix_userspace.wasm"
    exit 0
fi

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary userspace "$OUT" wasm_posix_userspace.wasm
