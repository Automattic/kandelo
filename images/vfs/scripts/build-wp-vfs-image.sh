#!/usr/bin/env bash
#
# Build a WordPress VFS image for the browser demo.
# Produces: apps/browser-demos/public/wordpress.vfs.zst
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-wordpress "$@"
fi

echo "==> Building WordPress VFS image..."
npx tsx "$SCRIPT_DIR/build-wp-vfs-image.ts"

echo "==> Done."
ls -lh apps/browser-demos/public/wordpress.vfs.zst
