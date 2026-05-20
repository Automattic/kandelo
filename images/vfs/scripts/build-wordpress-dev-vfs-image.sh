#!/usr/bin/env bash
#
# Build a WordPress development VFS image for the Kandelo gallery.
# Produces: apps/browser-demos/public/wordpress-dev.vfs.zst
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

echo "==> Building WordPress development VFS image..."
npx tsx "$SCRIPT_DIR/build-wordpress-dev-vfs-image.ts"

echo "==> Done."
ls -lh apps/browser-demos/public/wordpress-dev.vfs.zst
