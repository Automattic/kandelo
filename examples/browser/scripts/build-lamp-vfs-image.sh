#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building LAMP VFS image..."
npx tsx "$SCRIPT_DIR/build-lamp-vfs-image.ts"
echo "==> Done."
ls -lh examples/browser/public/lamp.vfs
