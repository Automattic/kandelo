#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building Redis VFS image..."
npx tsx "$SCRIPT_DIR/build-redis-vfs-image.ts"
echo "==> Done."
ls -lh examples/browser/public/redis.vfs
