#!/usr/bin/env bash
#
# Build a WordPress VFS image for the browser demo.
# Produces: apps/browser-demos/public/wordpress.vfs.zst
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

echo "==> Building WordPress VFS image..."
npx tsx "$SCRIPT_DIR/build-wp-vfs-image.ts"

echo "==> Done."
ls -lh apps/browser-demos/public/wordpress.vfs.zst
