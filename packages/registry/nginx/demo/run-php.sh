#!/usr/bin/env bash
#
# Build (if needed) and run nginx + PHP-FPM on kandelo.
#
# Usage:
#   bash packages/registry/nginx/demo/run-php.sh [port]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

echo "=== nginx + PHP-FPM on kandelo ==="

# Step 1: Kernel wasm + musl sysroot
if [ ! -f "$REPO_ROOT/host/wasm/kandelo-kernel.wasm" ] || \
   [ ! -f "$REPO_ROOT/sysroot/lib/libc.a" ]; then
    echo "--- Building kernel + sysroot ---"
    bash "$REPO_ROOT/build.sh"
else
    echo "--- Kernel + sysroot: OK ---"
fi

# Step 2: SDK tools
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "--- Installing SDK tools ---"
    cd "$REPO_ROOT/sdk" && npm link && cd "$REPO_ROOT"
else
    echo "--- SDK tools: OK ---"
fi

# Step 3: nginx + PHP-FPM service VFS image
if ! "$REPO_ROOT/scripts/resolve-binary.sh" programs/nginx-php-vfs.vfs.zst >/dev/null 2>&1; then
    echo "--- Building nginx + PHP-FPM VFS image ---"
    bash "$REPO_ROOT/run.sh" build nginx-php-vfs
else
    echo "--- nginx + PHP-FPM VFS image: OK ---"
fi

# Step 4: Host dependencies
if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "--- Installing host dependencies ---"
    cd "$REPO_ROOT" && npm install && cd "$REPO_ROOT"
fi

echo ""
echo "--- Starting nginx + PHP-FPM ---"
exec npx tsx "$SCRIPT_DIR/serve-php.ts" "$@"
