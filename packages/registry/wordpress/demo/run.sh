#!/usr/bin/env bash
#
# Build (if needed) and run WordPress on kandelo.
# Uses the WordPress service VFS (dinit + nginx + PHP-FPM + SQLite).
#
# Usage:
#   bash packages/registry/wordpress/demo/run.sh [port]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

echo "=== WordPress on kandelo ==="

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

# Step 3: WordPress service VFS image
if ! "$REPO_ROOT/scripts/resolve-binary.sh" programs/wordpress.vfs.zst >/dev/null 2>&1; then
    echo "--- Building WordPress VFS image ---"
    bash "$REPO_ROOT/run.sh" build wp-vfs
else
    echo "--- WordPress VFS image: OK ---"
fi

# Step 4: Host dependencies
if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "--- Installing host dependencies ---"
    cd "$REPO_ROOT" && npm install && cd "$REPO_ROOT"
fi

echo ""
echo "--- Starting WordPress ---"
exec npx tsx "$SCRIPT_DIR/serve.ts" "$@"
