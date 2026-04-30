#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building Erlang VFS image..."
npx tsx "$SCRIPT_DIR/build-erlang-vfs-image.ts"
echo "==> Done."
ls -lh examples/browser/public/erlang.vfs.zst
