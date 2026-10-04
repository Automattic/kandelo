#!/usr/bin/env bash
# package-system build wrapper. A standalone run has the browser-side
# builder write apps/browser-demos/public/mariadb.vfs.zst (wasm32) or
# apps/browser-demos/public/mariadb-64.vfs.zst (wasm64) — legacy filenames.
# A resolver run writes those names under WASM_POSIX_DEP_WORK_DIR instead,
# so the checkout stays untouched. We install under the manifest's program
# name (mariadb-vfs.vfs.zst) so the resolver scratch + local-binaries
# layout match the resolver's mirror output
# (programs/<arch>/mariadb-vfs.vfs.zst).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Honor WASM_POSIX_DEP_TARGET_ARCH (set by the resolver). Outside the
# resolver, fall back to wasm32 — matches `install_local_binary`'s
# default and run.sh's build_mariadb_vfs target.
arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
VFS_DIR="$REPO_ROOT/apps/browser-demos/public"
STAGE_DIR="$SCRIPT_DIR"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
    VFS_DIR="$WASM_POSIX_DEP_WORK_DIR"
    STAGE_DIR="$WASM_POSIX_DEP_WORK_DIR"
fi
case "$arch" in
    wasm32)
        VFS="$VFS_DIR/mariadb.vfs.zst"
        bash "$REPO_ROOT/images/vfs/scripts/build-mariadb-vfs-image.sh" "$VFS"
        ;;
    wasm64)
        VFS="$VFS_DIR/mariadb-64.vfs.zst"
        bash "$REPO_ROOT/images/vfs/scripts/build-mariadb-vfs-image.sh" --wasm64 "$VFS"
        ;;
    *)
        echo "ERROR: unsupported WASM_POSIX_DEP_TARGET_ARCH=$arch" >&2
        exit 2
        ;;
esac
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }

# Stage a copy under the manifest-program name so install_local_binary
# produces mariadb-vfs.vfs.zst (matching the resolver's mirror layout).
STAGE="$STAGE_DIR/mariadb-vfs.vfs.zst"
cp "$VFS" "$STAGE"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary mariadb-vfs "$STAGE"
