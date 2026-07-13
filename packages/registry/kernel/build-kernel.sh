#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT="$REPO_ROOT/target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"
USERS_OUT="$REPO_ROOT/target/wasm32-unknown-unknown/release/wasm_posix_userspace.wasm"
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"

cd "$REPO_ROOT"

if ! cargo -V | grep -q 'nightly'; then
    if command -v nix >/dev/null 2>&1; then
        echo "build-kernel: active cargo is not nightly; re-entering scripts/dev-shell.sh" >&2
        exec bash "$REPO_ROOT/scripts/dev-shell.sh" bash "$SCRIPT_DIR/build-kernel.sh"
    fi
    echo "build-kernel: active cargo does not support -Z build-std and nix is unavailable" >&2
    exit 1
fi

cargo build --release -p kandelo -Z build-std=core,alloc

if [ ! -f "$OUT" ]; then
    echo "build-kernel: expected output not found: $OUT" >&2
    exit 1
fi

wasm_require_exports "$OUT" \
    __abi_version \
    kernel_alloc_scratch \
    kernel_create_process \
    kernel_create_process_with_stdio \
    kernel_get_parent_pid \
    kernel_get_process_state \
    kernel_handle_channel \
    kernel_has_sa_nocldstop \
    kernel_host_adapter_manifest_len \
    kernel_host_adapter_manifest_ptr \
    kernel_mark_process_signaled \
    kernel_reap_exited_child \
    kernel_remove_process \
    kernel_wait_child_poll

mkdir -p "$REPO_ROOT/local-binaries"
cp "$OUT" "$REPO_ROOT/local-binaries/kernel.wasm"
echo "build-kernel: installed local-binaries/kernel.wasm"

mkdir -p "$REPO_ROOT/host/wasm"
cp "$OUT" "$REPO_ROOT/host/wasm/kandelo-kernel.wasm"
echo "build-kernel: installed host/wasm/kandelo-kernel.wasm"

if [ -f "$USERS_OUT" ]; then
    cp "$USERS_OUT" "$REPO_ROOT/local-binaries/userspace.wasm"
    echo "build-kernel: installed local-binaries/userspace.wasm"
fi

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$OUT" "$WASM_POSIX_DEP_OUT_DIR/kandelo-kernel.wasm"
    echo "build-kernel: installed $WASM_POSIX_DEP_OUT_DIR/kandelo-kernel.wasm"
fi
