#!/usr/bin/env bash
# package-system build wrapper. The browser-side builder writes
# examples/browser/public/mariadb{,-64}.vfs (legacy filenames); we
# install under the manifest's program name (mariadb-vfs.vfs) so the
# resolver scratch + local-binaries layout match install_release's
# output (programs/<arch>/mariadb-vfs.vfs). The browser-side legacy
# file stays untouched for code that still references it directly.
#
# WASM_POSIX_DEP_TARGET_ARCH is set by the resolver to the parent
# manifest's arch (wasm32 or wasm64). For wasm64 we pass --wasm64
# through so the produced VFS bakes the wasm64 mariadbd binary
# rather than the wasm32 one.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
case "$ARCH" in
    wasm32)
        bash "$REPO_ROOT/examples/browser/scripts/build-mariadb-vfs-image.sh"
        VFS="$REPO_ROOT/examples/browser/public/mariadb.vfs"
        ;;
    wasm64)
        bash "$REPO_ROOT/examples/browser/scripts/build-mariadb-vfs-image.sh" --wasm64
        VFS="$REPO_ROOT/examples/browser/public/mariadb-64.vfs"
        ;;
    *)
        echo "ERROR: unsupported WASM_POSIX_DEP_TARGET_ARCH=$ARCH" >&2
        exit 2
        ;;
esac
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }

# Stage a copy under the manifest-program name so install_local_binary
# produces mariadb-vfs.vfs (matching install_release's mirror layout).
STAGE="$SCRIPT_DIR/mariadb-vfs.vfs"
cp "$VFS" "$STAGE"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary mariadb-vfs "$STAGE"
