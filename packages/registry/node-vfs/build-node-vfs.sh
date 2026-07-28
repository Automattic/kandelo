#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ ! -f "$REPO_ROOT/packages/registry/npm/dist/bin/npm-cli.js" ]; then
    bash "$REPO_ROOT/packages/registry/npm/fetch-npm.sh"
fi

# The Node VFS embeds its always-used Node executable and layers npm on top of
# the resolved shell VFS image. The shell package still owns its lazy archives.
bash "$REPO_ROOT/images/vfs/scripts/build-node-vfs-image.sh"

VFS="$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary node-vfs "$VFS"
