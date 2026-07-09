#!/usr/bin/env bash
#
# Build zlib for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/dependency-management.md). When invoked via
# `cargo xtask build-deps resolve zlib`, these env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to `make install`
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#
# For ad-hoc / legacy invocation (`bash build-zlib.sh` with no resolver),
# the script falls back to the in-tree `zlib-install/` layout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="$WORK_DIR/zlib-src"

# --- Inputs from resolver, with legacy fallbacks ---
ZLIB_VERSION="${WASM_POSIX_DEP_VERSION:-${ZLIB_VERSION:-1.3.1}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$WORK_DIR/zlib-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
case "$TARGET_ARCH" in
    wasm32) TOOL_PREFIX="wasm32posix" ;;
    wasm64) TOOL_PREFIX="wasm64posix" ;;
    *) echo "ERROR: unsupported WASM_POSIX_DEP_TARGET_ARCH=$TARGET_ARCH" >&2; exit 1 ;;
esac

if ! command -v "${TOOL_PREFIX}-cc" &>/dev/null; then
    echo "ERROR: ${TOOL_PREFIX}-cc not found. Run sdk/activate.sh first." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading zlib $ZLIB_VERSION..."
    TARBALL="zlib-${ZLIB_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "/tmp/$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  /tmp/$TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
fi

cd "$SRC_DIR"

# `make install` writes into $INSTALL_DIR. Clean first so a cache-miss
# rebuild doesn't mix old + new artifacts inside the resolver's temp dir.
rm -rf "$INSTALL_DIR"

echo "==> Configuring zlib for Wasm..."
CC="${TOOL_PREFIX}-cc" AR="${TOOL_PREFIX}-ar" RANLIB="${TOOL_PREFIX}-ranlib" \
    LDSHARED="${TOOL_PREFIX}-cc -shared" \
    ./configure --static --prefix="$INSTALL_DIR"

# On macOS, zlib's configure uses 'libtool' which is the Xcode one — not wasm-aware.
# Patch the Makefile to use wasm32posix-ar instead.
echo "==> Patching Makefile for Wasm ar..."
sed -i.bak \
    -e "s|^AR=.*|AR=${TOOL_PREFIX}-ar|" \
    -e 's|^ARFLAGS=.*|ARFLAGS=rcs|' \
    -e "s|^RANLIB=.*|RANLIB=${TOOL_PREFIX}-ranlib|" \
    -e "s|libtool -o|${TOOL_PREFIX}-ar rcs|g" \
    Makefile && rm -f Makefile.bak

echo "==> Building zlib..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" libz.a

echo "==> Installing to $INSTALL_DIR..."
make install

if [ -f "$INSTALL_DIR/lib/libz.a" ]; then
    echo "==> zlib build complete!"
    ls -lh "$INSTALL_DIR/lib/libz.a"
else
    echo "ERROR: Build failed — library not found" >&2
    exit 1
fi
