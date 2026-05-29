#!/usr/bin/env bash
# package-system build wrapper for the Kandelo WordPress development VFS image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# build-wordpress-dev-vfs-image.ts bakes the eager shell environment, whose
# Vim and NetHack entries are lazy archives derived from resolver outputs.
bash "$REPO_ROOT/images/vfs/scripts/build-vim-zip.sh"
bash "$REPO_ROOT/images/vfs/scripts/build-nethack-zip.sh"

if [ ! -f "$REPO_ROOT/packages/registry/npm/dist/bin/npm-cli.js" ]; then
    bash "$REPO_ROOT/packages/registry/npm/fetch-npm.sh"
fi

bash "$REPO_ROOT/images/vfs/scripts/build-wordpress-dev-vfs-image.sh"

VFS="$REPO_ROOT/apps/browser-demos/public/wordpress-dev.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary wordpress-dev "$VFS"
