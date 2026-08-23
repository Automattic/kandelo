#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# The Node VFS embeds its always-used Node executable and layers npm on top of
# the resolved, self-contained flat Homebrew shell image. The shell package
# owns that complete filesystem and its authenticated composition metadata.
VFS="$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
    if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = source-only-v1 ]; then
        : "${WASM_POSIX_DEP_SOURCE_DIR:?SourceOnly Node VFS builds require verified npm source}"
    fi
    VFS="$WASM_POSIX_DEP_WORK_DIR/node-vfs.vfs.zst"
fi
bash "$REPO_ROOT/images/vfs/scripts/build-node-vfs-image.sh" "$VFS"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary node-vfs "$VFS"
