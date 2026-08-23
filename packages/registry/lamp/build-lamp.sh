#!/usr/bin/env bash
# package-system build wrapper for the LAMP-stack VFS image (WordPress + MariaDB).
# Delegates to images/vfs/scripts/build-lamp-vfs-image.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = source-only-v1 ]; then
        : "${WASM_POSIX_DEP_SOURCE_DIR:?SourceOnly LAMP builds require verified WordPress source}"
    fi
    : "${WASM_POSIX_DEP_MARIADB_DIR:?resolver LAMP builds require declared MariaDB runtime files}"
fi

# Resolver builds receive the verified WordPress source and MariaDB runtime
# files; direct builds resolve their package-backed fallbacks. The WordPress
# setup script is only for the local unpacked demo, and its checkout-specific
# SQLite plugin symlink is not a LAMP image input.

# Build-time opcache prewarming boots NodeKernelHost against the half-built VFS,
# so package builds need a host kernel even though lamp itself is a wasm32
# package. Build the local kernel artifact on demand; do not let the nested
# kernel build install into lamp's package output directory.
if [ -n "${WASM_POSIX_DEP_KERNEL_DIR:-}" ] && \
   [ -f "$WASM_POSIX_DEP_KERNEL_DIR/kandelo-kernel.wasm" ]; then
    :
elif ! "$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm >/dev/null 2>&1; then
    echo "==> Building kernel.wasm for LAMP opcache prewarm..."
    env -u WASM_POSIX_DEP_OUT_DIR bash "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"
fi

LAMP_VFS_TSX_TMP="$(mktemp -d /tmp/kandelo-lamp-vfs.XXXXXX)"
trap 'rm -rf -- "$LAMP_VFS_TSX_TMP"' EXIT
VFS="$REPO_ROOT/apps/browser-demos/public/lamp.vfs.zst"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
    VFS="$WASM_POSIX_DEP_WORK_DIR/lamp.vfs.zst"
fi
TMPDIR="$LAMP_VFS_TSX_TMP" \
    bash "$REPO_ROOT/images/vfs/scripts/build-lamp-vfs-image.sh" "$VFS"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lamp "$VFS"
