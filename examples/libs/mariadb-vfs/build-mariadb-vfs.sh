#!/usr/bin/env bash
# package-system build wrapper. The browser-side builder writes
# examples/browser/public/mariadb.vfs (legacy filename); we install
# it under the manifest's program name (mariadb-vfs.vfs) so the
# resolver scratch + local-binaries layout match install_release's
# output (programs/mariadb-vfs.vfs). The browser-side legacy file
# stays untouched for code that still references it directly.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
bash "$REPO_ROOT/examples/browser/scripts/build-mariadb-vfs-image.sh"
VFS="$REPO_ROOT/examples/browser/public/mariadb.vfs"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }

# Stage a copy under the manifest-program name so install_local_binary
# produces mariadb-vfs.vfs (matching install_release's mirror layout).
STAGE="$SCRIPT_DIR/mariadb-vfs.vfs"
cp "$VFS" "$STAGE"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary mariadb-vfs "$STAGE"
