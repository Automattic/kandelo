#!/usr/bin/env bash
# package-system build wrapper. Browser-side builder writes
# examples/browser/public/erlang.vfs; staged under the manifest's
# program name so install_local_binary + install_release's mirror
# both produce erlang-vfs.vfs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
bash "$REPO_ROOT/examples/browser/scripts/build-erlang-vfs-image.sh"
VFS="$REPO_ROOT/examples/browser/public/erlang.vfs"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }
STAGE="$SCRIPT_DIR/erlang-vfs.vfs"
cp "$VFS" "$STAGE"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary erlang-vfs "$STAGE"
