#!/usr/bin/env bash
#
# Cross-compile Redis 7.2 for wasm32-posix.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
VERSION="$WASM_POSIX_DEP_VERSION"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32

SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/redis-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# Check SDK
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "Error: wasm32posix-cc not found. Install the SDK first." >&2
    exit 1
fi

# Download and extract if needed
kandelo_package_stage_primary_source redis "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"

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

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary redis "$BIN_DIR/redis-server.wasm" redis-server.wasm
install_local_binary redis "$BIN_DIR/redis-cli.wasm" redis-cli.wasm
