#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building nginx + PHP-FPM VFS image..."
npx tsx "$SCRIPT_DIR/build-nginx-php-vfs-image.ts"
echo "==> Done."
ls -lh examples/browser/public/nginx-php.vfs

# Mirror into local-binaries/ so the @binaries/ Vite alias resolves for
# pages/nginx-php/main.ts. See sibling build-nginx-vfs-image.sh for rationale.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nginx-php-vfs "$REPO_ROOT/examples/browser/public/nginx-php.vfs"
