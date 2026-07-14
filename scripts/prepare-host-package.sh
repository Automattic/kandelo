#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_WASM_DIR="$REPO_ROOT/host/wasm"
mkdir -p "$HOST_WASM_DIR"

# `npm run build` copies the self-contained browser PCM worklet through the
# tsup onSuccess hook. Keep prepack strict so a publish can never contain a
# BrowserKernel bundle whose relative worklet URL resolves to a missing asset.
test -f "$REPO_ROOT/host/dist/audio/pcm-audio-worklet.js" || {
    echo "prepare-host-package: missing dist/audio/pcm-audio-worklet.js; run npm run build in host/" >&2
    exit 1
}

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
