#!/usr/bin/env bash
#
# Cross-compile Redis 7.2 for wasm32-posix.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VERSION="7.2.7"
TARBALL="redis-${VERSION}.tar.gz"
SRC_DIR="$SCRIPT_DIR/redis-src"
BIN_DIR="$SCRIPT_DIR/bin"

# Check SDK
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "Error: wasm32posix-cc not found. Install the SDK first." >&2
    exit 1
fi

# Download if needed
if [ ! -f "$SCRIPT_DIR/$TARBALL" ]; then
    echo "==> Downloading Redis $VERSION..."
    curl -L -o "$SCRIPT_DIR/$TARBALL" \
        "https://github.com/redis/redis/archive/refs/tags/${VERSION}.tar.gz"
fi

# Extract if needed
if [ ! -d "$SRC_DIR/src" ]; then
    echo "==> Extracting..."
    rm -rf "$SRC_DIR"
    tar xf "$SCRIPT_DIR/$TARBALL" -C "$SCRIPT_DIR"
    mv "$SCRIPT_DIR/redis-${VERSION}" "$SRC_DIR"
fi

cd "$SRC_DIR"

# Build deps first (lua, hiredis, linenoise, hdr_histogram, fpconv)
echo "==> Building Redis dependencies..."
cd deps

# Build Lua
echo "  -> lua"
cd lua/src
make clean 2>/dev/null || true
make \
    CC="wasm32posix-cc" \
    AR="wasm32posix-ar rcu" \
    RANLIB="wasm32posix-ranlib" \
    MYCFLAGS="-DLUA_USE_POSIX -DLUA_USE_DLOPEN" \
    MYLDFLAGS="" \
    MYLIBS="" \
    a 2>&1 | tail -3
cd ../..

# Build hiredis
echo "  -> hiredis"
cd hiredis
make clean 2>/dev/null || true
make \
    CC="wasm32posix-cc" \
    AR="wasm32posix-ar" \
    RANLIB="wasm32posix-ranlib" \
    OPTIMIZATION="-O2" \
    static 2>&1 | tail -3
cd ..

# Build linenoise
echo "  -> linenoise"
cd linenoise
wasm32posix-cc -c -O2 -Wall -W linenoise.c -o linenoise.o
cd ..

# Build hdr_histogram
echo "  -> hdr_histogram"
cd hdr_histogram
make clean 2>/dev/null || true
make \
    CC="wasm32posix-cc" \
    AR="wasm32posix-ar" \
    RANLIB="wasm32posix-ranlib" 2>&1 | tail -3
cd ..

# Build fpconv
echo "  -> fpconv"
cd fpconv
wasm32posix-cc -c -O2 -std=c99 fpconv_dtoa.c -o fpconv_dtoa.o
wasm32posix-ar rcs libfpconv.a fpconv_dtoa.o
cd ..

cd "$SRC_DIR"

# Generate release header
cd src
sh mkreleasehdr.sh
cd ..

# Patch tls.c — the full file triggers an LLVM backend crash on wasm32
# (AsmPrinter::emitGlobalVariable). Since we build with BUILD_TLS=no,
# we only need the non-OpenSSL stub.
if [ ! -f "$SRC_DIR/src/tls.c.orig" ]; then
    cp "$SRC_DIR/src/tls.c" "$SRC_DIR/src/tls.c.orig"
    cat > "$SRC_DIR/src/tls.c" << 'STUBEOF'
/* Minimal tls.c stub for non-TLS builds (avoids LLVM wasm32 crash) */
#include "server.h"
#include "connection.h"

int RedisRegisterConnectionTypeTLS(void) {
    serverLog(LL_VERBOSE, "Connection type %s not builtin", CONN_TYPE_TLS);
    return C_ERR;
}
STUBEOF
fi

# Build redis-server
echo "==> Building redis-server..."
cd src

# Compile with:
# - MALLOC=libc (no jemalloc)
# - No TLS
# - select() event loop (no epoll/kqueue on wasm32)
# - Disable USE_SYSTEMD
# - Disable atomic operations that might not work on wasm32
make clean 2>/dev/null || true

make \
    CC="wasm32posix-cc" \
    AR="wasm32posix-ar" \
    RANLIB="wasm32posix-ranlib" \
    MALLOC=libc \
    USE_SYSTEMD=no \
    BUILD_TLS=no \
    REDIS_CFLAGS="-DREDIS_STATIC='' -DNO_ATOMICS_INTRINSICS" \
    OPTIMIZATION="-O2" \
    redis-server redis-cli 2>&1

echo "==> Build complete!"

# Copy binaries
mkdir -p "$BIN_DIR"
cp redis-server "$BIN_DIR/redis-server.wasm"
cp redis-cli "$BIN_DIR/redis-cli.wasm"

echo "==> Redis binaries:"
ls -lh "$BIN_DIR/"
