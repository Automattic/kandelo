#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building MariaDB VFS image..."
npx tsx "$SCRIPT_DIR/build-mariadb-vfs-image.ts" "$@"
echo "==> Done."
if [[ "$*" == *--wasm64* ]]; then
    ls -lh examples/browser/public/mariadb-64.vfs
else
    ls -lh examples/browser/public/mariadb.vfs
fi
