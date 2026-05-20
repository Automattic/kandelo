#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/libxfont2-src"
BUILD_DIR="$SCRIPT_DIR/libxfont2-build"

LIBXFONT2_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBXFONT2_VERSION:-2.0.7}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libxfont2-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.x.org/releases/individual/lib/libXfont2-${LIBXFONT2_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

for tool in wasm32posix-cc wasm32posix-ar wasm32posix-ranlib wasm32posix-pkg-config; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Run 'npm link' in sdk/ first." >&2
        exit 1
    fi
done

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    echo "ERROR: zlib dependency path not provided" >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libXfont2 $LIBXFONT2_VERSION..."
    TARBALL="/tmp/libXfont2-${LIBXFONT2_VERSION}.tar.xz"
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

echo "==> Configuring libXfont2 for wasm32..."
(
    cd "$BUILD_DIR"
    PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}" \
    CFLAGS="-O2" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-dependency-tracking \
        --disable-freetype \
        --disable-fc \
        --without-bzip2 \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        PKG_CONFIG=wasm32posix-pkg-config \
        ZLIB_CFLAGS="-I$ZLIB_PREFIX/include" \
        ZLIB_LIBS="-L$ZLIB_PREFIX/lib -lz"

    echo "==> Building libXfont2..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    echo "==> Installing to $INSTALL_DIR..."
    make install
)

rm -f "$INSTALL_DIR/lib/"*.la

if [ -f "$INSTALL_DIR/lib/libXfont2.a" ] && [ -f "$INSTALL_DIR/lib/pkgconfig/xfont2.pc" ]; then
    echo "==> libXfont2 build complete!"
else
    echo "ERROR: libXfont2 build did not produce expected outputs" >&2
    exit 1
fi
