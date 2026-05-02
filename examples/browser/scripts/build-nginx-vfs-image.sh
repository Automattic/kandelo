#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building nginx VFS image..."
npx tsx "$SCRIPT_DIR/build-nginx-vfs-image.ts"
echo "==> Done."
ls -lh examples/browser/public/nginx.vfs

# Mirror into local-binaries/ so the @binaries/ Vite alias resolves for
# pages/nginx/main.ts. The page imports the file by its program name
# (nginx-vfs.vfs); a missing file then becomes a Vite resolve error
# instead of a 0.0 MB SPA-fallback at runtime.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nginx-vfs "$REPO_ROOT/examples/browser/public/nginx.vfs"
