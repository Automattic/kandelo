#!/usr/bin/env bash
#
# Build (if needed) and run the full LAMP stack on wasm-posix-kernel.
# MariaDB + PHP-FPM + nginx + WordPress, all as Wasm processes.
#
# Usage:
#   bash packages/registry/lamp/demo/run.sh [port]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

echo "=== LAMP stack on wasm-posix-kernel ==="

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

# Step 3: MariaDB
if ! "$REPO_ROOT/scripts/resolve-binary.sh" programs/mariadb/mariadbd.wasm >/dev/null 2>&1 \
   && [ ! -f "$REPO_ROOT/packages/registry/mariadb/mariadb-install/bin/mariadbd.wasm" ]; then
    echo "--- Building MariaDB ---"
    bash "$REPO_ROOT/packages/registry/mariadb/build-mariadb.sh"
else
    echo "--- MariaDB: OK ---"
fi

# Step 4: nginx
if ! "$REPO_ROOT/scripts/resolve-binary.sh" programs/nginx.wasm >/dev/null 2>&1; then
    echo "--- Building nginx ---"
    bash "$REPO_ROOT/packages/registry/nginx/build-nginx-local.sh"
else
    echo "--- nginx.wasm: OK ---"
fi

# Step 5: PHP-FPM (builds sqlite, zlib, openssl, libxml2 as needed)
if ! "$REPO_ROOT/scripts/resolve-binary.sh" programs/php/php-fpm.wasm >/dev/null 2>&1; then
    echo "--- Building PHP-FPM + dependencies ---"
    bash "$REPO_ROOT/packages/registry/php/build-php.sh"
else
    echo "--- php-fpm.wasm: OK ---"
fi

# Step 6: WordPress + wp-config.php for MySQL
if [ ! -f "$SCRIPT_DIR/wordpress/wp-settings.php" ]; then
    echo "--- Setting up WordPress ---"
    bash "$SCRIPT_DIR/setup.sh"
else
    echo "--- WordPress: OK ---"
fi

# Step 7: Host dependencies
if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "--- Installing host dependencies ---"
    cd "$REPO_ROOT" && npm install && cd "$REPO_ROOT"
fi

echo ""
echo "--- Starting LAMP stack (MariaDB + PHP-FPM + nginx + WordPress) ---"
exec npx tsx "$SCRIPT_DIR/serve.ts" "$@"
