#!/usr/bin/env bash
#
# Cross-compile Redis 7.2 for wasm32-posix.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
if [ "$ARCH" != "wasm32" ]; then
    echo "ERROR: Redis package currently supports wasm32 only, got '$ARCH'." >&2
    exit 1
fi

VERSION="${WASM_POSIX_DEP_VERSION:-7.2.5}"
TARBALL="redis-${VERSION}.tar.gz"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/redis/redis/archive/refs/tags/${VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-98a8502a2e902d2a9785ef46a69a5f8d5e24cbf9ea3ae4d845afcfc6778aa783}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
DOWNLOAD_DIR="$WORK_DIR/downloads"
SRC_DIR="$WORK_DIR/redis-src"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    BIN_DIR="$WORK_DIR/bin"
else
    BIN_DIR="$SCRIPT_DIR/bin"
fi
SOURCE_MARKER="$SRC_DIR/.kandelo-source"

sha256_file() {
    python3 - "$1" <<'PY'
import hashlib
import sys

h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest())
PY
}

# Check SDK
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "Error: wasm32posix-cc not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

mkdir -p "$DOWNLOAD_DIR"

# Download if needed
ARCHIVE="$DOWNLOAD_DIR/$TARBALL"
if [ ! -f "$ARCHIVE" ]; then
    echo "==> Downloading Redis $VERSION..."
    # `-f` (--fail) is load-bearing here: without it, curl returns 0
    # and writes the error HTML payload to TARBALL on a 5xx response,
    # which then poisons the tar-extract step downstream. Combined
    # with --retry to ride out transient mirror outages (#406).
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL \
        -o "$ARCHIVE" \
        "$SOURCE_URL"
fi

if [ -n "$SOURCE_SHA256" ]; then
    actual_sha="$(sha256_file "$ARCHIVE")"
    if [ "$actual_sha" != "$SOURCE_SHA256" ]; then
        echo "ERROR: source SHA256 mismatch for $ARCHIVE" >&2
        echo "  expected: $SOURCE_SHA256" >&2
        echo "  actual:   $actual_sha" >&2
        exit 1
    fi
fi

# Extract if needed
if [ ! -d "$SRC_DIR/src" ] || [ ! -f "$SOURCE_MARKER" ] || [ "$(cat "$SOURCE_MARKER")" != "$VERSION $SOURCE_SHA256" ]; then
    echo "==> Extracting..."
    rm -rf "$SRC_DIR"
    tar xf "$ARCHIVE" -C "$WORK_DIR"
    mv "$WORK_DIR/redis-${VERSION}" "$SRC_DIR"
    printf '%s %s\n' "$VERSION" "$SOURCE_SHA256" > "$SOURCE_MARKER"
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

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    if wasm_imports_kernel_fork "$BIN_DIR/redis-server.wasm" &&
        ! wasm_has_complete_fork_instrumentation "$BIN_DIR/redis-server.wasm"; then
        echo "  applying wasm-fork-instrument to redis-server.wasm"
        "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
            "$BIN_DIR/redis-server.wasm" \
            -o "$BIN_DIR/redis-server.wasm.instr"
        mv "$BIN_DIR/redis-server.wasm.instr" "$BIN_DIR/redis-server.wasm"
    fi
    wasm_require_no_legacy_asyncify "$BIN_DIR/redis-server.wasm"
    wasm_require_fork_instrumentation_if_needed "$BIN_DIR/redis-server.wasm"
    wasm_require_no_legacy_asyncify "$BIN_DIR/redis-cli.wasm"
    wasm_require_fork_instrumentation_if_needed "$BIN_DIR/redis-cli.wasm"
    rm -rf "$WASM_POSIX_DEP_OUT_DIR"
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$BIN_DIR/redis-server.wasm" "$WASM_POSIX_DEP_OUT_DIR/redis-server.wasm"
    cp "$BIN_DIR/redis-cli.wasm" "$WASM_POSIX_DEP_OUT_DIR/redis-cli.wasm"
    echo "==> Installed Redis outputs to $WASM_POSIX_DEP_OUT_DIR"
else
    # Install into local-binaries/ so the resolver picks the freshly-built
    # binary over the fetched release.
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary redis "$BIN_DIR/redis-server.wasm" redis-server.wasm
    install_local_binary redis "$BIN_DIR/redis-cli.wasm" redis-cli.wasm
fi
