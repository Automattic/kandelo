#!/usr/bin/env bash
# Package-system build wrapper for the canonical base rootfs image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    ROOTFS_SKIP_PACKAGE_RESOLVE=1 bash "$REPO_ROOT/scripts/build-rootfs.sh"
else
    bash "$REPO_ROOT/scripts/build-rootfs.sh"
fi

VFS="$REPO_ROOT/host/wasm/rootfs.vfs"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary rootfs "$VFS"

mkdir -p "$REPO_ROOT/local-binaries"
cp "$VFS" "$REPO_ROOT/local-binaries/rootfs.vfs"
echo "  installed $REPO_ROOT/local-binaries/rootfs.vfs"
