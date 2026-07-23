#!/usr/bin/env bash
# package-system build wrapper for the WordPress VFS image.
# Delegates to images/vfs/scripts/build-wp-vfs-image.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# The VFS builder resolves and verifies the WordPress and SQLite plugin source
# archives itself. `setup.sh` remains the local unpacked-demo entrypoint; it
# creates a checkout-specific plugin symlink that is not a product-image input.

# Build-time opcache prewarming boots NodeKernelHost against the half-built VFS,
# so package builds need a host kernel even though wordpress itself is a
# wasm32 package. Build the local kernel artifact on demand; do not let the
# nested kernel build install into wordpress's package output directory.
if ! "$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm >/dev/null 2>&1; then
    echo "==> Building kernel.wasm for WordPress opcache prewarm..."
    env -u WASM_POSIX_DEP_OUT_DIR bash "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"
fi

bash "$REPO_ROOT/images/vfs/scripts/build-wp-vfs-image.sh"

VFS="$REPO_ROOT/apps/browser-demos/public/wordpress.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary wordpress "$VFS"
