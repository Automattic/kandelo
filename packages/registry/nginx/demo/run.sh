#!/usr/bin/env bash
#
# Build (if needed) and run nginx on kandelo.
#
# Usage:
#   bash packages/registry/nginx/demo/run.sh [port]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

echo "=== nginx on kandelo ==="

# Step 1: Kernel wasm + musl sysroot
if [ ! -f "$REPO_ROOT/host/wasm/kandelo.wasm" ] || \
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

# Step 3: nginx binary
if ! "$REPO_ROOT/scripts/resolve-binary.sh" programs/nginx.wasm >/dev/null 2>&1; then
    echo "--- Building nginx ---"
    bash "$REPO_ROOT/packages/registry/nginx/build-nginx-local.sh"
else
    echo "--- nginx.wasm: OK ---"
fi

# Step 4: Host dependencies
if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "--- Installing host dependencies ---"
    cd "$REPO_ROOT" && npm install && cd "$REPO_ROOT"
fi

echo ""
echo "--- Starting nginx ---"
exec npx tsx "$SCRIPT_DIR/serve.ts" "$@"
