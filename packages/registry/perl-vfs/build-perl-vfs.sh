#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# A standalone run writes the browser demo's public/ copy and stages beside
# this script. A resolver run keeps both under its work root so the
# checkout stays untouched.
VFS_DIR="$REPO_ROOT/apps/browser-demos/public"
STAGE_DIR="$SCRIPT_DIR"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
    VFS_DIR="$WASM_POSIX_DEP_WORK_DIR"
    STAGE_DIR="$WASM_POSIX_DEP_WORK_DIR"
fi
VFS="$VFS_DIR/perl.vfs.zst"
bash "$REPO_ROOT/images/vfs/scripts/build-perl-vfs-image.sh" "$VFS"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }
STAGE="$STAGE_DIR/perl-vfs.vfs.zst"
cp "$VFS" "$STAGE"
# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary perl-vfs "$STAGE"
