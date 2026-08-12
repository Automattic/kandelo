#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-mariadb "$@"
fi
echo "==> Building MariaDB VFS image..."
npx tsx "$SCRIPT_DIR/build-mariadb-vfs-image.ts" "$@"
echo "==> Done."
if [[ "$*" == *--wasm64* ]]; then
    ls -lh apps/browser-demos/public/mariadb-64.vfs.zst
else
    ls -lh apps/browser-demos/public/mariadb.vfs.zst
fi
