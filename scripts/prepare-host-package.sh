#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_WASM_DIR="$REPO_ROOT/host/wasm"
mkdir -p "$HOST_WASM_DIR"

# Keep the standalone npm package on the same Rust-generated program closure
# and artifact policy as source checkouts. The package has no registry TOML to
# inspect at runtime. Refuse to copy stale policy into a publishable package.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
    build-deps program-index-check \
    "$REPO_ROOT/packages/registry" \
    "$REPO_ROOT/packages/registry/program-packages.json"
cp \
    "$REPO_ROOT/packages/registry/program-packages.json" \
    "$HOST_WASM_DIR/program-packages.json"

copy_first_existing() {
    local dest="$1"
    shift
    local src
    for src in "$@"; do
        if [ -f "$src" ]; then
            if [ "$(cd "$(dirname "$src")" && pwd)/$(basename "$src")" != "$(cd "$(dirname "$dest")" && pwd)/$(basename "$dest")" ]; then
                cp "$src" "$dest"
                echo "prepare-host-package: copied $src -> $dest"
            else
                echo "prepare-host-package: using existing $dest"
            fi
            return 0
        fi
    done
    echo "prepare-host-package: missing input for $dest" >&2
    echo "  checked:" >&2
    for src in "$@"; do
        echo "    $src" >&2
    done
    return 1
}

copy_first_existing \
    "$HOST_WASM_DIR/kandelo-kernel.wasm" \
    "$REPO_ROOT/local-binaries/kernel.wasm" \
    "$REPO_ROOT/binaries/kernel.wasm" \
    "$REPO_ROOT/target/wasm32-unknown-unknown/release/kandelo_kernel.wasm" \
    "$HOST_WASM_DIR/kandelo-kernel.wasm"

cp "$HOST_WASM_DIR/kandelo-kernel.wasm" "$HOST_WASM_DIR/kernel.wasm"

copy_first_existing \
    "$HOST_WASM_DIR/rootfs.vfs" \
    "$HOST_WASM_DIR/rootfs.vfs" \
    "$REPO_ROOT/local-binaries/rootfs.vfs" \
    "$REPO_ROOT/binaries/rootfs.vfs"

if copy_first_existing \
    "$HOST_WASM_DIR/wasm_posix_userspace.wasm" \
    "$REPO_ROOT/local-binaries/userspace.wasm" \
    "$REPO_ROOT/binaries/userspace.wasm" \
    "$REPO_ROOT/target/wasm32-unknown-unknown/release/wasm_posix_userspace.wasm" \
    "$HOST_WASM_DIR/wasm_posix_userspace.wasm"; then
    cp "$HOST_WASM_DIR/wasm_posix_userspace.wasm" "$HOST_WASM_DIR/userspace.wasm"
else
    echo "prepare-host-package: userspace wasm not present; continuing without it" >&2
fi
