#!/usr/bin/env bash
# package-system build wrapper. The browser-side builder writes
# examples/browser/public/mariadb.vfs.zst (wasm32) or examples/browser/public/mariadb-64.vfs.zst
# (wasm64) — legacy filenames. We install under the manifest's program
# name (mariadb-vfs.vfs.zst) so the resolver scratch + local-binaries
# layout match the resolver's mirror output
# (programs/<arch>/mariadb-vfs.vfs.zst). The browser-side legacy
# filenames stay untouched for code that still references them
# directly.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Honor WASM_POSIX_DEP_TARGET_ARCH (set by the resolver). Outside the
# resolver, fall back to wasm32 — matches `install_local_binary`'s
# default and run.sh's build_mariadb_vfs target.
arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
case "$arch" in
    wasm32)
        bash "$REPO_ROOT/examples/browser/scripts/build-mariadb-vfs-image.sh"
        VFS="$REPO_ROOT/examples/browser/public/mariadb.vfs.zst"
        ;;
    wasm64)
        bash "$REPO_ROOT/examples/browser/scripts/build-mariadb-vfs-image.sh" --wasm64
        VFS="$REPO_ROOT/examples/browser/public/mariadb-64.vfs.zst"
        ;;
    *)
        echo "ERROR: unsupported WASM_POSIX_DEP_TARGET_ARCH=$arch" >&2
        exit 2
        ;;
esac
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }

# Stage a copy under the manifest-program name so install_local_binary
# produces mariadb-vfs.vfs.zst (matching the resolver's mirror layout).
STAGE="$SCRIPT_DIR/mariadb-vfs.vfs.zst"
cp "$VFS" "$STAGE"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary mariadb-vfs "$STAGE"
