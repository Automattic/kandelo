#!/usr/bin/env bash
#
# Build everything needed to run WordPress on wasm-posix-kernel.
# Idempotent — skips steps whose outputs already exist.
#
# Usage:
#   bash packages/examples/wordpress/build.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== Building WordPress for wasm-posix-kernel ==="

# Step 1: Kernel wasm + musl sysroot + TypeScript host
echo ""
echo "--- Step 1/4: Kernel + musl sysroot + host ---"
if [ ! -f "$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm" ] || \
   [ ! -f "$REPO_ROOT/sysroot/lib/libc.a" ]; then
    bash "$REPO_ROOT/build.sh"
else
    echo "==> Kernel wasm and sysroot already built"
fi

# Step 2: SDK tools (wasm32posix-cc, etc.)
echo ""
echo "--- Step 2/4: SDK tools ---"
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "==> Installing SDK tools..."
    cd "$REPO_ROOT/sdk"
    npm link
    cd "$REPO_ROOT"
else
    echo "==> SDK tools already installed"
fi

# Step 3: PHP binary (builds sqlite, zlib, openssl, libxml2 as needed)
echo ""
echo "--- Step 3/4: PHP + dependencies ---"
PHP_BINARY="$REPO_ROOT/packages/registry/php/php-src/sapi/cli/php"
if [ ! -f "$PHP_BINARY" ]; then
    bash "$REPO_ROOT/packages/registry/php/build-php.sh"
else
    echo "==> PHP binary already built"
fi

# Step 4: WordPress + SQLite plugin
echo ""
echo "--- Step 4/4: WordPress + SQLite plugin ---"
bash "$SCRIPT_DIR/setup.sh"

echo ""
echo "=== Build complete! ==="
echo ""
echo "Run WordPress with:"
echo "  npx tsx packages/examples/wordpress/serve.ts"
echo ""
echo "Then open http://localhost:3000"
