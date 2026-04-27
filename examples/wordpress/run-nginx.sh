#!/usr/bin/env bash
#
# Build (if needed) and run WordPress behind nginx + PHP-FPM on wasm-posix-kernel.
# Uses SQLite for storage (no MariaDB needed).
#
# Usage:
#   bash examples/wordpress/run-nginx.sh [port]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== WordPress + nginx + PHP-FPM on wasm-posix-kernel ==="

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

# Step 3: nginx
NGINX_DIR="$REPO_ROOT/examples/nginx"
if [ ! -f "$NGINX_DIR/nginx.wasm" ]; then
    echo "--- Building nginx ---"
    bash "$NGINX_DIR/build.sh"
else
    echo "--- nginx.wasm: OK ---"
fi

# Step 4: PHP-FPM (builds sqlite, zlib, openssl, libxml2 as needed)
if [ ! -f "$NGINX_DIR/php-fpm.wasm" ]; then
    echo "--- Building PHP-FPM + dependencies ---"
    bash "$REPO_ROOT/examples/libs/php/build-php.sh"
else
    echo "--- php-fpm.wasm: OK ---"
fi

# Step 5: WordPress + SQLite plugin
if [ ! -f "$SCRIPT_DIR/wordpress/wp-settings.php" ]; then
    echo "--- Downloading WordPress ---"
    bash "$SCRIPT_DIR/setup.sh"
else
    echo "--- WordPress: OK ---"
fi

# Step 6: Host dependencies
if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "--- Installing host dependencies ---"
    cd "$REPO_ROOT" && npm install && cd "$REPO_ROOT"
fi

echo ""
echo "--- Starting WordPress behind nginx + PHP-FPM ---"
exec npx tsx "$SCRIPT_DIR/serve-nginx.ts" "$@"
