#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-lamp "$@"
fi
echo "==> Building LAMP VFS image..."
VFS_OUTPUT="${1:-$REPO_ROOT/apps/browser-demos/public/lamp.vfs.zst}"
npx tsx "$SCRIPT_DIR/build-lamp-vfs-image.ts" "$VFS_OUTPUT"
echo "==> Done."
ls -lh "$VFS_OUTPUT"
