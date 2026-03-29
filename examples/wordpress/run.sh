#!/usr/bin/env bash
#
# Build (if needed) and run WordPress on wasm-posix-kernel.
# Uses PHP's built-in web server + SQLite for storage.
#
# Usage:
#   bash examples/wordpress/run.sh [port]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== WordPress on wasm-posix-kernel ==="

# Step 1: Kernel wasm + musl sysroot
if [ ! -f "$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm" ] || \
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

# Step 3: PHP CLI binary (builds sqlite, zlib as needed)
PHP_BINARY="$REPO_ROOT/examples/libs/php/php-src/sapi/cli/php"
if [ ! -f "$PHP_BINARY" ]; then
    echo "--- Building PHP CLI + dependencies ---"
    bash "$REPO_ROOT/examples/libs/php/build-php.sh"
else
    echo "--- PHP CLI: OK ---"
fi

# Step 4: WordPress + SQLite plugin
if [ ! -f "$SCRIPT_DIR/wordpress/wp-settings.php" ]; then
    echo "--- Downloading WordPress ---"
    bash "$SCRIPT_DIR/setup.sh"
else
    echo "--- WordPress: OK ---"
fi

# Step 5: Host dependencies
if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "--- Installing host dependencies ---"
    cd "$REPO_ROOT" && npm install && cd "$REPO_ROOT"
fi

echo ""
echo "--- Starting WordPress ---"
exec npx tsx "$SCRIPT_DIR/serve.ts" "$@"
