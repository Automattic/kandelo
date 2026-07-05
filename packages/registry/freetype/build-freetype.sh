#!/usr/bin/env bash
#
# Build FreeType for wasm32-posix-kernel.
#
# LÖVE uses FreeType for TrueType font rasterization. Optional FreeType
# integrations are disabled here so the package stays a focused static library
# dependency with no transitive compression/image stack.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/freetype-src"
BUILD_DIR="$SCRIPT_DIR/freetype-build"

FREETYPE_VERSION="${WASM_POSIX_DEP_VERSION:-${FREETYPE_VERSION:-2.13.3}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/freetype-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc >/dev/null 2>&1; then
    echo "ERROR: wasm32posix-cc not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading FreeType $FREETYPE_VERSION..."
    TARBALL="/tmp/freetype-${FREETYPE_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring FreeType for wasm32..."
(
    cd "$BUILD_DIR"
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --without-zlib \
        --without-bzip2 \
        --without-png \
        --without-harfbuzz \
        --without-brotli \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        CFLAGS="-O2"

    echo "==> Building FreeType..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/share/aclocal"

if [ -f "$INSTALL_DIR/lib/libfreetype.a" ]; then
    echo "==> FreeType build complete!"
    ls -lh "$INSTALL_DIR/lib/libfreetype.a"
else
    echo "ERROR: Build failed: missing $INSTALL_DIR/lib/libfreetype.a" >&2
    exit 1
fi
