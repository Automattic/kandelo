#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" test-mariadb "$@"
fi
echo "==> Building MariaDB test VFS image..."
npx tsx "$SCRIPT_DIR/build-mariadb-test-vfs-image.ts" "$@"
echo "==> Done."
ls -lh apps/browser-demos/public/mariadb-test.vfs.zst
