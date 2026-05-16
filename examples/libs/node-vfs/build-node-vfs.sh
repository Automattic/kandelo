#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ ! -f "$REPO_ROOT/examples/libs/npm/dist/bin/npm-cli.js" ]; then
    bash "$REPO_ROOT/examples/libs/npm/fetch-npm.sh"
fi

bash "$REPO_ROOT/examples/browser/scripts/build-node-vfs-image.sh"

VFS="$REPO_ROOT/examples/browser/public/node-vfs.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary node-vfs "$VFS"
