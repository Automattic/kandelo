#!/usr/bin/env bash
# package-system build wrapper for the LAMP-stack VFS image (WordPress + MariaDB).
# Delegates to images/vfs/scripts/build-lamp-vfs-image.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# The VFS builder resolves and verifies the WordPress source archive itself.
# `packages/registry/wordpress/setup.sh` is only for the local unpacked demo;
# its checkout-specific SQLite plugin symlink is not a LAMP image input.

# Build-time opcache prewarming boots NodeKernelHost against the half-built VFS,
# so package builds need a host kernel even though lamp itself is a wasm32
# package. Build the local kernel artifact on demand; do not let the nested
# kernel build install into lamp's package output directory.
if ! "$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm >/dev/null 2>&1; then
    echo "==> Building kernel.wasm for LAMP opcache prewarm..."
    env -u WASM_POSIX_DEP_OUT_DIR bash "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"
fi

bash "$REPO_ROOT/images/vfs/scripts/build-lamp-vfs-image.sh"

VFS="$REPO_ROOT/apps/browser-demos/public/lamp.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lamp "$VFS"
