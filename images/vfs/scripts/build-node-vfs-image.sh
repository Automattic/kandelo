#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-node "$@"
fi
echo "==> Building Node VFS image..."
VFS_OUTPUT="${1:-$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst}"
node_vfs_tmpdir="$(mktemp -d /tmp/kandelo-node-vfs.XXXXXX)"
trap 'rm -rf "$node_vfs_tmpdir"' EXIT
TMPDIR="$node_vfs_tmpdir" npx tsx "$SCRIPT_DIR/build-node-vfs-image.ts" \
  "$VFS_OUTPUT"
echo "==> Done."
ls -lh "$VFS_OUTPUT"
