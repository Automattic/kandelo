#!/usr/bin/env bash
#
# Build (if needed) and run the full LAMP stack on kandelo.
# MariaDB + PHP-FPM + nginx + WordPress, supervised by dinit in a VFS image.
#
# Usage:
#   bash packages/registry/lamp/demo/run.sh [port]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

echo "=== LAMP stack on kandelo ==="

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

# Step 3: LAMP service VFS image
if ! "$REPO_ROOT/scripts/resolve-binary.sh" programs/lamp.vfs.zst >/dev/null 2>&1; then
    echo "--- Building LAMP VFS image ---"
    bash "$REPO_ROOT/run.sh" build lamp-vfs
else
    echo "--- LAMP VFS image: OK ---"
fi

# Step 4: Host dependencies
if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "--- Installing host dependencies ---"
    cd "$REPO_ROOT" && npm install && cd "$REPO_ROOT"
fi

echo ""
echo "--- Starting LAMP stack (MariaDB + PHP-FPM + nginx + WordPress) ---"
exec npx tsx "$SCRIPT_DIR/serve.ts" "$@"
