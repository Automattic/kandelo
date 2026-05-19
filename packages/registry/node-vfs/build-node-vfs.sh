#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ ! -f "$REPO_ROOT/packages/registry/npm/dist/bin/npm-cli.js" ]; then
    bash "$REPO_ROOT/packages/registry/npm/fetch-npm.sh"
fi

# The Node VFS is layered on the shell VFS populator, which registers the
# shell lazy archives for vim and nethack. Build those archive inputs before
# invoking the image builder so clean source builds do not depend on a prior
# shell package build.
bash "$REPO_ROOT/images/vfs/scripts/build-vim-zip.sh"
bash "$REPO_ROOT/images/vfs/scripts/build-nethack-zip.sh"

bash "$REPO_ROOT/images/vfs/scripts/build-node-vfs-image.sh"

VFS="$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary node-vfs "$VFS"
