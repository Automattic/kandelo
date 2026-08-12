#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-perl "$@"
fi
echo "==> Building Perl VFS image..."
npx tsx "$SCRIPT_DIR/build-perl-vfs-image.ts"
echo "==> Done."
ls -lh apps/browser-demos/public/perl.vfs.zst
