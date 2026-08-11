#!/usr/bin/env bash
#
# Build freetype (libfreetype.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). Autotools cross-build like libpng.
# zlib comes from the resolver; every other optional dep (png,
# harfbuzz, brotli, bzip2) is disabled — fcft needs none of them, and
# each would drag another port into the stack.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/freetype-src"

FREETYPE_VERSION="${WASM_POSIX_DEP_VERSION:-2.13.3}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/freetype-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/freetype-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set (must be invoked via cargo xtask build-deps resolve freetype)}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading freetype $FREETYPE_VERSION..."
    TARBALL="/tmp/freetype-${FREETYPE_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring freetype for wasm32 (zlib at $ZLIB_PREFIX)..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --with-zlib=yes \
        --with-png=no \
        --with-harfbuzz=no \
        --with-brotli=no \
        --with-bzip2=no \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        ZLIB_CFLAGS="-I$ZLIB_PREFIX/include" \
        ZLIB_LIBS="-L$ZLIB_PREFIX/lib -lz"

    echo "==> Building freetype..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/share"

if [ -f "$INSTALL_DIR/lib/libfreetype.a" ]; then
    echo "==> freetype build complete!"
    ls -lh "$INSTALL_DIR/lib/libfreetype.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libfreetype.a" >&2
    exit 1
fi
